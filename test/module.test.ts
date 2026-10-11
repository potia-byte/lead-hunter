import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoProfile, demoReplies, demoWorld, DEMO_NOW } from "../demo/world.js";
import {
  createFixtureDiscovery,
  createFixtureFetchPage,
  createFixtureWebPreview,
  createReplayLlm,
} from "../src/adapters/fixture.js";
import { createOpenAiCompatibleClient } from "../src/adapters/openai-compatible.js";
import { READ_ONLY_METHODS } from "../src/adapters/teleproto.js";
import { classificationPrompt, verifyClassification } from "../src/classify.js";
import {
  DEFAULT_PROFILE,
  parseProductProfile,
  SELLABLE_ACTIONS,
} from "../src/config.js";
import { leadBatchSchema } from "../src/lead-record.js";
import { callLlm, LlmUnavailableError } from "../src/llm.js";
import { DEFAULT_LIMITS } from "../src/pipeline.js";
import { planQueries } from "../src/queries.js";
import { reviewPrompt } from "../src/review.js";
import { UsageLedger } from "../src/llm.js";
import { executeRun } from "../src/run.js";
import { extractUrls } from "../src/text.js";

const root = join(import.meta.dirname, "..");

function walk(directory: string, out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "dist", "output", ".git"].includes(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe("demo end to end (fixtures, no network)", () => {
  async function run() {
    const outDir = mkdtempSync(join(tmpdir(), "lead-hunter-demo-"));
    const discovery = createFixtureDiscovery(demoWorld);
    const done = await executeRun({
      outDir,
      runId: "t",
      llm: createReplayLlm(demoReplies),
      fetchPage: createFixtureFetchPage(demoWorld),
      discovery,
      profile: demoProfile,
      webPreview: createFixtureWebPreview(demoWorld),
      limits: {
        ...DEFAULT_LIMITS,
        llmEntityQueries: 0,
        llmPostQueries: 0,
        maxEntityQueries: 10,
        maxPostQueries: 3,
      },
      now: () => DEMO_NOW,
    });
    return { ...done, outDir, discovery };
  }

  it("qualifies the synthetic advertisers and rejects the rest, with reasons", async () => {
    const { result, state } = await run();
    expect(result.qualified.map((view) => view.classification.businessName)).toEqual([
      "Nova Budget",
      "FitPulse Studio",
      "LearnHub Online School",
      "Tapzilla",
    ]);
    // Channel and its Mini App bot are one business.
    const nova = result.businesses.find((view) => view.key.startsWith("novabudget"));
    expect(nova?.members).toHaveLength(2);
    expect(nova?.sightings).toHaveLength(1);
    // Prefilter rejects before any model call.
    expect(Object.values(state.prefilterRejected).sort()).toEqual([
      "marked scam/fake by Telegram",
      "no posts in 120 days",
    ]);
    expect(state.fetchFailed).toEqual({});
  });

  it("drops the one invented quote and emits only valid records", async () => {
    const { result, directory } = await run();
    const fit = result.businesses.find(
      (view) => view.classification.businessName === "FitPulse Studio",
    );
    expect(fit?.classification.droppedClaims).toBe(1);
    expect(fit?.classification.monetizationEvidence).toEqual([]);
    expect(result.leadErrors).toEqual([]);
    const batch = leadBatchSchema.parse(
      JSON.parse(readFileSync(join(directory, "batch.json"), "utf8")),
    );
    expect(batch.leads).toHaveLength(4);
    for (const lead of batch.leads)
      expect(lead.sources.length).toBeGreaterThan(0);
  });

  it("is resumable: a second run makes no discovery calls", async () => {
    const first = await run();
    const again = createFixtureDiscovery(demoWorld);
    await executeRun({
      outDir: first.outDir,
      runId: "t",
      llm: createReplayLlm(demoReplies),
      fetchPage: createFixtureFetchPage(demoWorld),
      discovery: again,
      profile: demoProfile,
      webPreview: createFixtureWebPreview(demoWorld),
      limits: {
        ...DEFAULT_LIMITS,
        llmEntityQueries: 0,
        llmPostQueries: 0,
        maxEntityQueries: 10,
        maxPostQueries: 3,
      },
      now: () => DEMO_NOW,
    });
    expect(
      again.calls.filter((call) => /^(search|posts|fetch):/.test(call)),
    ).toEqual([]);
  });

  it("every canned quote is literally present in its fixture text", () => {
    const all = [
      ...demoWorld.entities,
      ...Object.entries(demoWorld.webProfiles).map(([name, profile]) => ({
        id: `web:${name}`,
        kind: profile.kind,
        username: profile.username,
        title: profile.title,
        about: profile.about,
        participants: profile.participants,
        botActiveUsers: null,
        hasMainApp: false,
        verified: false,
        scamOrFake: false,
        aboutLinks: extractUrls(profile.about),
        posts: demoWorld.webPosts[name] ?? [],
        discoveries: [],
        fetchedAt: DEMO_NOW.toISOString(),
      })),
    ];
    let dropped = 0;
    for (const entity of all) {
      const reply = demoReplies.classification[entity.id];
      if (!reply) continue;
      const checked = verifyClassification(
        entity as never,
        {
          id: entity.id,
          is_business: true,
          reject_reason: null,
          business_name: "",
          project_type: "other",
          niche: "",
          what_it_does: "",
          language: "en",
          sellable_actions: [],
          website_link: null,
          contacts: [],
          ad_spend: [],
          acquisition: [],
          monetization: [],
          ...(reply as object),
        } as never,
        "t",
      );
      dropped += checked.droppedClaims;
    }
    // Exactly the one deliberately invented claim.
    expect(dropped).toBe(1);
  });
});

describe("product profile (no product baked into prompts)", () => {
  it("puts the configured product into every prompt", async () => {
    const profile = {
      ...DEFAULT_PROFILE,
      name: "Zeta Widgets",
      description: "Zeta Widgets sells widget installs.",
    };
    expect(classificationPrompt([], profile)).toContain("Zeta Widgets sells widget installs.");
    expect(
      reviewPrompt(
        {
          entityId: "1",
          isBusiness: true,
          rejectReason: null,
          businessName: "X",
          projectType: "bot",
          niche: "n",
          whatItDoes: "",
          language: "en",
          sellableActions: [],
          website: null,
          contacts: [],
          adSpendEvidence: [],
          acquisitionEvidence: [],
          monetizationEvidence: [],
          droppedClaims: 0,
          model: "m",
        },
        { total: 10, factors: [] },
        [],
        ["x"],
        profile,
      ),
    ).toContain("Zeta Widgets");
    const seen: string[] = [];
    await planQueries(
      {
        async completion(prompt) {
          seen.push(prompt);
          return '{"entity_queries":["widget shop"],"post_queries":[]}';
        },
      },
      new UsageLedger(),
      { entity: 1, post: 0 },
      [],
      { ...profile, queryPlanningContext: "widget buyers" },
    );
    expect(seen[0]).toContain("widget buyers");
  });

  it("validates a JSON profile and rejects an incomplete one", () => {
    const example = JSON.parse(
      readFileSync(join(root, "config", "product.example.json"), "utf8"),
    );
    const parsed = parseProductProfile(example);
    expect(Object.keys(parsed.actions).sort()).toEqual([...SELLABLE_ACTIONS].sort());
    expect(() => parseProductProfile({ name: "x" })).toThrow();
  });
});

describe("LlmClient boundary", () => {
  it("accepts a plain string, a metadata object, and maps throws to a reason", async () => {
    const options = { tier: "cheap" as const, maxTokens: 10 };
    const plain = await callLlm(
      { completion: async () => "hello" },
      { ...options, prompt: "p" },
    );
    expect(plain).toMatchObject({ ok: true, text: "hello", route: "llm" });
    const rich = await callLlm(
      {
        completion: async () => ({
          text: "x",
          route: "a/b",
          usage: { inputTokens: 1, outputTokens: 2 },
        }),
      },
      { ...options, prompt: "p" },
    );
    expect(rich).toMatchObject({ ok: true, route: "a/b" });
    const exhausted = await callLlm(
      {
        completion: async () => {
          throw new LlmUnavailableError("quota", true);
        },
      },
      { ...options, prompt: "p" },
    );
    expect(exhausted).toEqual({ ok: false, reason: "exhausted: quota" });
    const failed = await callLlm(
      {
        completion: async () => {
          throw new Error("socket");
        },
      },
      { ...options, prompt: "p" },
    );
    expect(failed).toEqual({ ok: false, reason: "unavailable: socket" });
  });

  it("OpenAI-compatible adapter builds the request and maps errors (stubbed fetch)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const respond = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          auth: (init?.headers as Record<string, string>).authorization ?? "",
        });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const ok = createOpenAiCompatibleClient({
      baseUrl: "https://llm.invalid/v1/",
      apiKey: "test-key-placeholder",
      cheapModel: "small",
      strongModel: "big",
      fetchImpl: respond(200, {
        choices: [{ message: { content: "answer" } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    });
    const reply = await ok.completion("hi", { tier: "strong", maxTokens: 50 });
    expect(reply).toEqual({
      text: "answer",
      route: "openai-compatible/big",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(calls[0]?.url).toBe("https://llm.invalid/v1/chat/completions");
    expect(calls[0]?.body).toMatchObject({ model: "big", max_tokens: 50 });

    const limited = createOpenAiCompatibleClient({
      baseUrl: "https://llm.invalid/v1",
      apiKey: "test-key-placeholder",
      cheapModel: "small",
      fetchImpl: respond(429, {}),
    });
    await expect(
      limited.completion("hi", { tier: "cheap", maxTokens: 5 }),
    ).rejects.toMatchObject({ exhausted: true });
  });
});

describe("safety properties confirmed in code", () => {
  it("the live adapter builds only the listed read-only MTProto requests", () => {
    const source = readFileSync(
      join(root, "src", "adapters", "teleproto.ts"),
      "utf8",
    );
    const used = [...source.matchAll(/new Api\.([A-Za-z]+)\.([A-Za-z]+)\(/g)].map(
      (match) => `${match[1]}.${match[2]}`,
    );
    expect(new Set(used)).toEqual(new Set(READ_ONLY_METHODS));
    // Paid post search is never enabled.
    expect(source).not.toMatch(/allowPaidStars\s*:/);
    // No write-style calls of any kind.
    expect(source).not.toMatch(/Api\.messages\.(Send|Forward|Delete)/);
    expect(source).not.toMatch(/JoinChannel|AddContact|SendMessage/);
  });

  it("no product or company name is hard-coded in source, prompts or fixtures", () => {
    const banned = new RegExp(["gift", "quest"].join("\\s*"), "i");
    const offenders = walk(root)
      .filter((path) => /\.(ts|json|md|example)$/.test(path))
      .filter((path) => !path.endsWith("module.test.ts"))
      .filter((path) => !/package-lock\.json$/.test(path))
      .filter((path) => !/README/.test(path))
      .filter((path) => banned.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the repository ships no .env or session files", () => {
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(walk(root).filter((path) => /\.session$/.test(path))).toEqual([]);
  });
});
