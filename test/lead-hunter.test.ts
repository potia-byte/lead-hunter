import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adSightingsIn } from "../src/ads.js";
import {
  classifyBatch,
  referencesOf,
  verifyClassification,
} from "../src/classify.js";
import { fetchedByEarlierRuns } from "../src/run.js";
import { groupBusinesses } from "../src/dedupe.js";
import { enrichWebsite, parseHtml } from "../src/enrich.js";
import {
  completeJson,
  type LlmClient,
  type LlmCompletion,
  type LlmOptions,
  LlmUnavailableError,
  parseJsonLoose,
  UsageLedger,
} from "../src/llm.js";
import {
  DEFAULT_LIMITS,
  emptyState,
  prefilter,
  type RunState,
  runPipeline,
} from "../src/pipeline.js";
import { scoreLead } from "../src/score.js";
import {
  postOf,
  postSearchRefusal,
  stubOf,
} from "../src/adapters/telegram-mappers.js";
import {
  DiscoveryStoppedError,
  type EntityStub,
  type TelegramDiscovery,
} from "../src/source.js";
import {
  adMarkerOf,
  businessDomainOf,
  containsQuote,
  extractEmails,
  extractHandles,
  extractUrls,
} from "../src/text.js";
import type { Classification, RawEntity } from "../src/types.js";
import type { WebPreview, WebProfile } from "../src/webpreview.js";

const NOW = new Date("2026-09-24T12:00:00Z");
const DAY = 86_400;
const now = Math.floor(NOW.getTime() / 1000);

function entity(overrides: Partial<RawEntity> = {}): RawEntity {
  return {
    id: "1",
    kind: "channel",
    username: "coolapp",
    title: "Cool App",
    about:
      "Cool App — Mini App for budgeting. Реклама: @coolads. https://coolapp.io",
    participants: 5000,
    botActiveUsers: null,
    hasMainApp: false,
    verified: false,
    scamOrFake: false,
    aboutLinks: ["https://coolapp.io"],
    posts: [
      {
        id: 10,
        date: now - DAY,
        text: "Запустили реферальную программу: пригласи друга и получи Premium за 299 ₽",
        views: 1000,
        forwards: 3,
        links: [],
      },
    ],
    discoveries: [
      {
        sourceType: "entity_search",
        source: "mini app",
        at: NOW.toISOString(),
      },
    ],
    fetchedAt: NOW.toISOString(),
    ...overrides,
  };
}

function classification(
  overrides: Partial<Classification> = {},
): Classification {
  return {
    entityId: "1",
    isBusiness: true,
    rejectReason: null,
    businessName: "Cool App",
    projectType: "mini_app",
    niche: "personal finance",
    whatItDoes: "Budgeting Mini App",
    language: "ru",
    sellableActions: ["mini_app_launch", "registration"],
    website: "https://coolapp.io",
    contacts: [
      {
        kind: "telegram",
        value: "@coolads",
        role: "advertising",
        sourceUrl: "https://t.me/coolapp",
      },
    ],
    adSpendEvidence: [],
    acquisitionEvidence: [
      {
        claim: "referral program",
        quote: "пригласи друга",
        sourceUrl: "https://t.me/coolapp/10",
      },
    ],
    monetizationEvidence: [
      {
        claim: "paid plan",
        quote: "Premium за 299 ₽",
        sourceUrl: "https://t.me/coolapp/10",
      },
    ],
    droppedClaims: 0,
    model: "fake/cheap",
    ...overrides,
  };
}

type LlmRequest = LlmOptions & { prompt: string };

/** Replies in order; a function reply sees the request; null = exhausted. */
function scriptedLlm(
  replies: Array<string | ((request: LlmRequest) => string) | null>,
): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let index = 0;
  return {
    requests,
    async completion(prompt, options): Promise<string | LlmCompletion> {
      const request = { ...options, prompt };
      requests.push(request);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply === null || reply === undefined)
        throw new LlmUnavailableError("no free quota", true);
      const text = typeof reply === "function" ? reply(request) : reply;
      return {
        text,
        route: `fake/model-${index}`,
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };
}

describe("text extraction", () => {
  it("pulls urls, bare t.me links, handles and emails", () => {
    const text =
      "Сайт https://coolapp.io/ru, канал t.me/coolapp, пишите @CoolAds или ads@coolapp.io. logo@2x.png";
    expect(extractUrls(text)).toEqual([
      "https://coolapp.io/ru",
      "https://t.me/coolapp",
    ]);
    expect(extractHandles(text)).toEqual(["coolads"]);
    expect(extractEmails(text)).toEqual(["ads@coolapp.io"]);
  });

  it("detects ad markers and ignores generic domains", () => {
    expect(adMarkerOf("Реклама. ООО Ромашка. erid: 2VtzqwXyZ12")).toBe("erid");
    expect(adMarkerOf("#реклама Лучший VPN")).toBe("#реклама");
    expect(adMarkerOf("Обычный пост")).toBeNull();
    expect(businessDomainOf("https://linktr.ee/cool")).toBeNull();
    expect(businessDomainOf("https://www.coolapp.io/x")).toBe("coolapp.io");
  });

  it("matches quotes regardless of case, spacing and ё", () => {
    expect(
      containsQuote(
        "Пригласи  ДРУГА и получи ёлку",
        "пригласи друга и получи елку",
      ),
    ).toBe(true);
    expect(containsQuote("some text", "invented claim")).toBe(false);
  });

  it("treats a Premium-only post search refusal as a stop, not a crash", () => {
    expect(
      postSearchRefusal({
        code: 400,
        errorMessage: "PREMIUM_ACCOUNT_REQUIRED",
      }),
    ).toMatch(/Premium/);
    expect(postSearchRefusal({ errorMessage: "CHANNEL_INVALID" })).toBeNull();
    expect(postSearchRefusal(new Error("socket closed"))).toBeNull();
  });

  it("maps Telegram peers without collecting people", () => {
    expect(
      stubOf({
        className: "Channel",
        id: 5,
        username: "news",
        broadcast: true,
        title: "News",
        participantsCount: 10,
      }),
    ).toMatchObject({ kind: "channel", participants: 10 });
    expect(
      stubOf({
        className: "User",
        id: 6,
        username: "somebot",
        bot: true,
        firstName: "Some",
      }),
    ).toMatchObject({ kind: "bot" });
    expect(
      stubOf({ className: "User", id: 7, username: "ivan", firstName: "Ivan" }),
    ).toBeNull();
    // Kept so a resumed run can load the peer without contacts.ResolveUsername,
    // which Telegram caps at roughly 200 calls a day.
    expect(
      stubOf({
        className: "Channel",
        id: 8,
        accessHash: -4611686018427387904n,
        username: "shop",
        broadcast: true,
      }),
    ).toMatchObject({ accessHash: "-4611686018427387904" });
    expect(
      stubOf({ className: "Channel", id: 9, username: "old", broadcast: true }),
    ).not.toHaveProperty("accessHash");
    const post = postOf({
      className: "Message",
      id: 3,
      date: now,
      message: "Жми",
      entities: [
        {
          className: "MessageEntityTextUrl",
          url: "https://t.me/hidden_bot?start=ad",
        },
      ],
      replyMarkup: {
        rows: [{ buttons: [{ url: "https://shop.example.com" }] }],
      },
    });
    expect(post?.links).toEqual([
      "https://t.me/hidden_bot?start=ad",
      "https://shop.example.com",
    ]);
  });
});

describe("ad sightings", () => {
  it("finds what a paid post promotes, excluding the host", () => {
    const host = entity({
      username: "bignews",
      posts: [
        {
          id: 77,
          date: now - DAY,
          text: "Реклама. erid: 2VtzqwXyZ12\nИграй в @tapgame_bot",
          views: 1,
          forwards: 0,
          links: [
            "https://t.me/tapgame_bot?startapp=x",
            "https://t.me/bignews",
          ],
        },
        {
          id: 78,
          date: now,
          text: "Новости дня",
          views: 1,
          forwards: 0,
          links: ["https://t.me/other"],
        },
      ],
    });
    const sightings = adSightingsIn(host);
    expect(sightings.map((item) => item.target)).toEqual(["tapgame_bot"]);
    expect(sightings[0]?.postUrl).toBe("https://t.me/bignews/77");
  });
});

describe("classification verification", () => {
  it("keeps quoted facts and drops invented quotes, links and contacts", () => {
    const raw = entity();
    const refs = referencesOf(raw);
    expect([...refs.handles.values()]).toEqual(["coolads"]);
    const result = verifyClassification(
      raw,
      {
        id: "1",
        is_business: true,
        reject_reason: null,
        business_name: "Cool App",
        project_type: "mini_app",
        niche: "finance",
        what_it_does: "budgeting",
        language: "ru",
        sellable_actions: ["mini_app_launch"],
        website_link: "L1",
        contacts: [
          { ref: "H1", role: "advertising" },
          { ref: "H9", role: "owner" },
        ],
        ad_spend: [
          { claim: "buys ads", source: "P10", quote: "we spent $5000 on ads" },
        ],
        acquisition: [
          { claim: "referral", source: "P10", quote: "пригласи друга" },
        ],
        monetization: [
          { claim: "price", source: "about", quote: "Premium за 299" },
        ],
      },
      "fake/cheap",
    );
    expect(result.website).toBe("https://coolapp.io");
    expect(result.contacts).toEqual([
      {
        kind: "telegram",
        value: "@coolads",
        role: "advertising",
        sourceUrl: "https://t.me/coolapp",
      },
    ]);
    expect(result.adSpendEvidence).toEqual([]);
    expect(result.acquisitionEvidence[0]?.sourceUrl).toBe(
      "https://t.me/coolapp/10",
    );
    // "Premium за 299" is in P10, not in the profile the model cited.
    expect(result.monetizationEvidence).toEqual([]);
    expect(result.droppedClaims).toBe(3);
  });

  it("survives malformed and partial model replies", async () => {
    const ledger = new UsageLedger();
    const llm = scriptedLlm([
      "Sorry, I cannot help with that.",
      '```json\n{"results":[{"id":"1","is_business":true,"project_type":"spaceship","sellable_actions":["mini_app_launch","teleport"]}]}\n```',
    ]);
    const result = await classifyBatch(llm, ledger, [entity()]);
    expect(result.error).toBeNull();
    const [item] = result.classified;
    expect(item?.projectType).toBe("other");
    expect(item?.sellableActions).toEqual(["mini_app_launch"]);
    expect(item?.website).toBeNull();
    // The first route returned junk and is avoided on the retry.
    expect(llm.requests[1]?.avoid).toEqual(["fake/model-1"]);
    expect(
      ledger.summary().find((line) => line.route === "fake/model-1")?.failures,
    ).toBe(1);
  });

  it("reports provider failure without inventing results", async () => {
    const result = await classifyBatch(scriptedLlm([null]), new UsageLedger(), [
      entity(),
    ]);
    expect(result.classified).toEqual([]);
    expect(result.missing).toHaveLength(1);
    expect(result.error).toMatch(/^exhausted/);
  });

  it("returns entities the model skipped as missing", async () => {
    const result = await classifyBatch(
      scriptedLlm([
        '{"results":[{"id":"1","is_business":false,"reject_reason":"news"}]}',
      ]),
      new UsageLedger(),
      [entity(), entity({ id: "2", username: "second" })],
    );
    expect(result.classified.map((item) => item.entityId)).toEqual(["1"]);
    expect(result.missing.map((item) => item.id)).toEqual(["2"]);
  });
});

describe("json helpers", () => {
  it("parses JSON wrapped in prose and think blocks", () => {
    expect(parseJsonLoose('<think>hmm</think>Here: {"a":1} done')).toEqual({
      a: 1,
    });
    expect(() => parseJsonLoose("no json")).toThrow();
  });

  it("gives up after the attempt limit", async () => {
    const result = await completeJson(
      scriptedLlm(["x", "y", "z"]),
      new UsageLedger(),
      { tier: "cheap", prompt: "p", maxTokens: 10 },
      z.object({ a: z.number() }),
      3,
    );
    expect(result.ok).toBe(false);
  });
});

describe("dedupe", () => {
  const input = (raw: RawEntity, website: string | null = null) => ({
    entity: raw,
    classification: classification({ entityId: raw.id, website }),
  });

  it("merges a channel and its bot that link to each other", () => {
    const channel = entity({
      id: "1",
      username: "coolapp",
      about: "Наш бот: @coolapp_bot",
      aboutLinks: [],
    });
    const bot = entity({
      id: "2",
      kind: "bot",
      username: "coolapp_bot",
      about: "News: t.me/coolapp",
      aboutLinks: ["https://t.me/coolapp"],
      hasMainApp: true,
      posts: [],
    });
    const groups = groupBusinesses([input(channel), input(bot)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.primary).toBe("2");
  });

  it("merges on a shared product website but not on a shared ad manager", () => {
    const a = entity({
      id: "1",
      username: "alpha",
      about: "Реклама: @admanager",
      aboutLinks: [],
    });
    const b = entity({
      id: "2",
      username: "beta",
      about: "Реклама: @admanager",
      aboutLinks: [],
    });
    expect(groupBusinesses([input(a), input(b)])).toHaveLength(2);
    expect(
      groupBusinesses([
        input(a, "https://shop.io"),
        input(b, "https://www.shop.io/ru"),
      ]),
    ).toHaveLength(1);
  });

  it("does not merge a one-way link between unrelated names", () => {
    const a = entity({
      id: "1",
      username: "cryptonews",
      title: "Crypto News",
      about: "Партнёр: @tapgame_bot",
      aboutLinks: [],
    });
    const b = entity({
      id: "2",
      kind: "bot",
      username: "tapgame_bot",
      title: "Tap Game",
      about: "",
      aboutLinks: [],
      posts: [],
    });
    expect(groupBusinesses([input(a), input(b)])).toHaveLength(2);
  });
});

describe("scoring", () => {
  it("is explainable and rewards evidence of paid acquisition over size", () => {
    const small = scoreLead({
      members: [entity({ participants: 800, hasMainApp: true })],
      classification: classification(),
      sightings: [
        {
          postUrl: "https://t.me/a/1",
          hostUsername: "a",
          marker: "erid",
          date: now - DAY,
          target: "coolapp",
          excerpt: "",
        },
        {
          postUrl: "https://t.me/b/1",
          hostUsername: "b",
          marker: "erid",
          date: now - DAY,
          target: "coolapp",
          excerpt: "",
        },
      ],
      enrichment: null,
      now: NOW,
    });
    const huge = scoreLead({
      members: [entity({ participants: 900_000 })],
      classification: classification({
        projectType: "media_channel",
        sellableActions: [],
        contacts: [],
        acquisitionEvidence: [],
        monetizationEvidence: [],
        website: null,
      }),
      sightings: [],
      enrichment: null,
      now: NOW,
    });
    expect(small.total).toBeGreaterThan(huge.total);
    expect(small.factors.map((item) => item.key)).toEqual([
      "product_fit",
      "acquisition_need",
      "ad_spend",
      "activity",
      "reachability",
      "monetization",
      "telegram_relevance",
    ]);
    expect(small.factors.find((item) => item.key === "ad_spend")?.points).toBe(
      16,
    );
    expect(small.total).toBeLessThanOrEqual(100);
  });

  it("prefilters dead and tiny channels before any model call", () => {
    expect(
      prefilter(entity({ participants: 20 }), DEFAULT_LIMITS, NOW),
    ).toMatch(/subscribers/);
    expect(
      prefilter(
        entity({
          posts: [
            {
              id: 1,
              date: now - 400 * DAY,
              text: "old",
              views: null,
              forwards: null,
              links: [],
            },
          ],
        }),
        DEFAULT_LIMITS,
        NOW,
      ),
    ).toMatch(/120 days/);
    expect(prefilter(entity(), DEFAULT_LIMITS, NOW)).toBeNull();
  });
});

describe("enrichment", () => {
  it("parses contacts from a site and follows only same-site contact pages", async () => {
    const pages: Record<string, string> = {
      "https://coolapp.io":
        '<title>Cool</title><a href="/advertising">Реклама</a><a href="https://other.com/contact">x</a><a href="https://t.me/coolapp">tg</a>',
      "https://coolapp.io/advertising":
        '<p>Пишите <a href="mailto:ads@coolapp.io">нам</a> или в <a href="https://t.me/cool_sales">Telegram</a></p>',
    };
    const fetched: string[] = [];
    const ledger = new UsageLedger();
    const result = await enrichWebsite("https://coolapp.io", {
      ledger,
      maxPages: 3,
      fetchPage: async (url) => {
        fetched.push(url);
        const html = pages[url.replace(/\/$/, "")];
        if (!html) throw new Error("404");
        return { html, finalUrl: url };
      },
    });
    expect(fetched).toEqual([
      "https://coolapp.io",
      "https://coolapp.io/advertising",
    ]);
    expect(result.adPageUrl).toBe("https://coolapp.io/advertising");
    expect(result.contacts).toContainEqual({
      kind: "email",
      value: "ads@coolapp.io",
      role: "advertising",
      sourceUrl: "https://coolapp.io/advertising",
    });
    expect(result.contacts).toContainEqual({
      kind: "telegram",
      value: "@cool_sales",
      role: "advertising",
      sourceUrl: "https://coolapp.io/advertising",
    });
    expect(ledger.webRequests).toBe(2);
    expect(
      parseHtml("<script>var a='x@y.com'</script><p>hi</p>", "https://a.io")
        .emails,
    ).toEqual([]);
  });
});

describe("pipeline", () => {
  function fakeDiscovery(
    options: { floodOnFetch?: boolean } = {},
  ): TelegramDiscovery & { calls: string[] } {
    const calls: string[] = [];
    const stub: EntityStub = {
      id: "1",
      kind: "channel",
      username: "coolapp",
      title: "Cool App",
      participants: 5000,
    };
    return {
      calls,
      async searchEntities(query) {
        calls.push(`search:${query}`);
        return query === "mini app" ? [stub] : [];
      },
      async searchPosts() {
        calls.push("posts");
        return {
          ok: false,
          reason: "free public-post search quota for today is used up",
        };
      },
      async fetchEntity(target) {
        calls.push(`fetch:${target.username}`);
        if (options.floodOnFetch)
          throw new DiscoveryStoppedError(
            "Telegram asked for a 3600s pause on channels.GetFullChannel; stopping this stage",
          );
        return entity();
      },
      async resolve() {
        return null;
      },
      async disconnect() {},
    };
  }

  const classifyReply = (request: LlmRequest) =>
    request.prompt.includes('Reply with JSON only:\n{"results"')
      ? JSON.stringify({
          results: [
            {
              id: "1",
              is_business: true,
              business_name: "Cool App",
              project_type: "mini_app",
              niche: "finance",
              what_it_does: "Budgeting Mini App",
              language: "ru",
              sellable_actions: ["mini_app_launch"],
              website_link: "L1",
              contacts: [{ ref: "H1", role: "advertising" }],
              ad_spend: [],
              acquisition: [
                { claim: "referral", source: "P10", quote: "пригласи друга" },
              ],
              monetization: [
                { claim: "paid", source: "P10", quote: "Premium за 299 ₽" },
              ],
            },
          ],
        })
      : request.prompt.includes("final reviewer")
        ? '{"verdict":"confirm","adjustment":0,"reason":"real product"}'
        : '{"entity_queries":["budget app"],"post_queries":[]}';

  async function run(
    state: RunState,
    discovery: TelegramDiscovery,
    alreadyFetched?: ReadonlySet<string>,
  ) {
    const saves: RunState[] = [];
    const result = await runPipeline({
      state,
      ...(alreadyFetched ? { alreadyFetched } : {}),
      save: async (next) => {
        saves.push(structuredClone(next));
      },
      discovery,
      llm: scriptedLlm([classifyReply]),
      ledger: new UsageLedger(),
      fetchPage: async () => {
        throw new Error("offline");
      },
      limits: {
        ...DEFAULT_LIMITS,
        maxEntityQueries: 3,
        maxPostQueries: 1,
        llmEntityQueries: 1,
        llmPostQueries: 0,
      },
      now: () => NOW,
      log: () => {},
    });
    return { result, saves };
  }

  it("runs end to end, records the post-search stop and resumes without repeating work", async () => {
    const state = emptyState("t", NOW);
    const discovery = fakeDiscovery();
    const { result } = await run(state, discovery);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.project).toBe("Cool App");
    expect(state.stops).toContain(
      "post search: free public-post search quota for today is used up",
    );
    expect(state.reviews.coolapp?.verdict).toBe("confirm");

    const again = fakeDiscovery();
    await run(state, again);
    // Queries, fetches, classification and review are all checkpointed.
    expect(
      again.calls.filter(
        (call) => call.startsWith("search:") || call.startsWith("fetch:"),
      ),
    ).toEqual([]);
  });

  it("skips entities an earlier run already fetched", async () => {
    const discovery = fakeDiscovery();
    const { result } = await run(
      emptyState("t2", NOW),
      discovery,
      new Set(["1"]),
    );
    expect(discovery.calls.filter((call) => call.startsWith("fetch:"))).toEqual(
      [],
    );
    expect(result.leads).toEqual([]);
  });

  it("collects entities fetched by other runs, not the current one", () => {
    const runs = mkdtempSync(join(tmpdir(), "lead-runs-"));
    for (const [run, ids] of [
      ["day1", ["1", "2"]],
      ["today", ["3"]],
    ] as const) {
      mkdirSync(join(runs, run));
      writeFileSync(
        join(runs, run, "state.json"),
        JSON.stringify({
          entities: Object.fromEntries(ids.map((id) => [id, {}])),
        }),
      );
    }
    mkdirSync(join(runs, "broken"));
    writeFileSync(join(runs, "broken", "state.json"), "{");
    expect([...fetchedByEarlierRuns(runs, "today")].sort()).toEqual(["1", "2"]);
  });

  it("classifies several batches at once", async () => {
    const state = emptyState("t3", NOW);
    for (let index = 1; index <= 8; index += 1) {
      const id = String(index);
      state.entities[id] = entity({ id, username: `app${id}` });
    }
    let inFlight = 0;
    let peak = 0;
    const llm: LlmClient = {
      async completion() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        throw new LlmUnavailableError("provider_error: offline");
      },
    };
    await runPipeline({
      state,
      save: async () => {},
      discovery: null,
      llm,
      ledger: new UsageLedger(),
      fetchPage: async () => {
        throw new Error("offline");
      },
      limits: {
        ...DEFAULT_LIMITS,
        classifyBatchSize: 2,
        classifyConcurrency: 3,
      },
      now: () => NOW,
      log: () => {},
    });
    expect(peak).toBe(3);
    expect(Object.keys(state.classifyFailed)).toHaveLength(8);
  });

  it("finds advertisers through the web preview without the account", async () => {
    const state = emptyState("web", NOW);
    state.stubs["10"] = {
      id: "10",
      kind: "channel",
      username: "hostchan",
      title: "Host",
      participants: 50_000,
      discoveries: [],
    };
    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    const webPreview: WebPreview = {
      async channelPosts(username) {
        return username === "hostchan"
          ? [
              {
                id: 7,
                date: nowSeconds,
                text: "Лучший бот\nРеклама. Рекламодатель: ООО «Бот». ИНН 7700000000. erid: 2Vtzqvp6JMa",
                views: 1000,
                forwards: null,
                links: ["https://t.me/advbot?start=promo"],
              },
            ]
          : [];
      },
      async profile(username) {
        return username === "advbot"
          ? {
              username: "advbot",
              kind: "bot",
              title: "Adv Bot",
              about: "Бот для покупок",
              participants: null,
            }
          : null;
      },
    };
    await runPipeline({
      state,
      save: async () => {},
      discovery: null,
      llm: scriptedLlm([null]),
      ledger: new UsageLedger(),
      fetchPage: async () => {
        throw new Error("offline");
      },
      limits: { ...DEFAULT_LIMITS, llmEntityQueries: 0, llmPostQueries: 0 },
      now: () => NOW,
      log: () => {},
      webPreview,
    });
    expect(state.webScanned.hostchan).toBe(1);
    expect(state.sightings).toContainEqual(
      expect.objectContaining({
        target: "advbot",
        advertiser: "ООО «Бот»",
        inn: "7700000000",
      }),
    );
    expect(state.stubs["web:advbot"]?.discoveries[0]?.sourceType).toBe(
      "ad_post_target",
    );
    expect(state.entities["web:advbot"]).toMatchObject({
      kind: "bot",
      title: "Adv Bot",
    });
  });

  it("snowballs from mentioned channels to their advertisers", async () => {
    const state = emptyState("snow", NOW);
    state.stubs["10"] = {
      id: "10",
      kind: "channel",
      username: "hostchan",
      title: "Host",
      participants: 50_000,
      discoveries: [],
    };
    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    const post = (id: number, text: string, links: string[]) => ({
      id,
      date: nowSeconds,
      text,
      views: 100,
      forwards: null,
      links,
    });
    const posts: Record<string, ReturnType<typeof post>[]> = {
      hostchan: [post(1, "Читайте соседей", ["https://t.me/otherchan"])],
      otherchan: [
        post(2, "Реклама. Рекламодатель: ООО «Два». erid: 2Vtzqvp6JMa", [
          "https://t.me/advbot2?start=x",
        ]),
      ],
    };
    const profiles: Record<string, WebProfile> = {
      otherchan: {
        username: "otherchan",
        kind: "channel",
        title: "Other",
        about: "",
        participants: 20_000,
      },
      advbot2: {
        username: "advbot2",
        kind: "bot",
        title: "Adv Bot 2",
        about: "",
        participants: null,
      },
    };
    await runPipeline({
      state,
      save: async () => {},
      discovery: null,
      llm: scriptedLlm([null]),
      ledger: new UsageLedger(),
      fetchPage: async () => {
        throw new Error("offline");
      },
      limits: { ...DEFAULT_LIMITS, llmEntityQueries: 0, llmPostQueries: 0 },
      now: () => NOW,
      log: () => {},
      webPreview: {
        async channelPosts(username) {
          return posts[username] ?? [];
        },
        async profile(username) {
          return profiles[username] ?? null;
        },
      },
    });
    expect(state.stubs["web:otherchan"]?.discoveries[0]?.sourceType).toBe(
      "snowball",
    );
    expect(state.webScanned.otherchan).toBe(1);
    expect(state.entities["web:advbot2"]).toMatchObject({ kind: "bot" });
  });

  it("stops Telegram discovery on a long FLOOD_WAIT but still analyses what it has", async () => {
    const state = emptyState("t", NOW);
    const { result, saves } = await run(
      state,
      fakeDiscovery({ floodOnFetch: true }),
    );
    expect(state.stops.some((stop) => stop.includes("3600s pause"))).toBe(true);
    expect(result.leads).toEqual([]);
    expect(saves.length).toBeGreaterThan(0);
  });
});
