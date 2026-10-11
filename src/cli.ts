import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createOpenAiCompatibleClient } from "./adapters/openai-compatible.js";
import { DEFAULT_PROFILE, parseProductProfile } from "./config.js";
import { createBrowserRenderer, createHttpFetcher } from "./enrich.js";
import type { UsageLedger } from "./llm.js";
import { DEFAULT_LIMITS, type Limits } from "./pipeline.js";
import { executeRun } from "./run.js";
import type { TelegramDiscovery } from "./source.js";
import { createWebPreview } from "./webpreview.js";

/**
 *   npm run hunt -- [--run <id>] [--out <dir>] [--profile <file.json>]
 *                   [--live] [--no-web] [--browser] [--limit key=value ...]
 *
 * Read-only: searches public Telegram (only with --live), reads public web
 * pages, asks a model, and writes <out>/<run>/{state.json,batch.json,report.*}.
 * It never writes to anyone and has no CRM integration.
 */

const USAGE =
  "Usage: npm run hunt -- [--run <id>] [--out <dir>] [--profile <file.json>] [--live] [--no-web] [--browser] [--limit maxFetch=300 ...]\nLLM: set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_CHEAP (see .env.example).\nTelegram (--live): set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION.";

function parseLimits(values: string[]): Limits {
  const limits = { ...DEFAULT_LIMITS };
  for (const value of values) {
    const [key, raw] = value.split("=");
    if (
      !key ||
      !(key in limits) ||
      raw === undefined ||
      !Number.isFinite(Number(raw))
    )
      throw new Error(`Unknown or invalid --limit ${value}`);
    (limits as Record<string, number>)[key] = Number(raw);
  }
  return limits;
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      run: { type: "string" },
      out: { type: "string", default: join("output", "lead-hunter") },
      profile: { type: "string" },
      live: { type: "boolean", default: false },
      browser: { type: "boolean", default: false },
      web: { type: "boolean", default: true },
      limit: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.info(USAGE);
    return 0;
  }

  const baseUrl = env.LLM_BASE_URL?.trim();
  const apiKey = env.LLM_API_KEY?.trim();
  const cheapModel = env.LLM_MODEL_CHEAP?.trim();
  if (!baseUrl || !apiKey || !cheapModel) {
    console.error(
      "LLM_BASE_URL, LLM_API_KEY and LLM_MODEL_CHEAP must be set (see .env.example). For a run without keys use: npm run demo",
    );
    return 1;
  }
  const strongModel = env.LLM_MODEL_STRONG?.trim();
  const llm = createOpenAiCompatibleClient({
    baseUrl,
    apiKey,
    cheapModel,
    ...(strongModel ? { strongModel } : {}),
  });

  const profile = values.profile
    ? parseProductProfile(
        JSON.parse(readFileSync(resolve(values.profile), "utf8")),
      )
    : DEFAULT_PROFILE;
  const limits = parseLimits(values.limit ?? []);
  const runId = values.run ?? new Date().toISOString().slice(0, 10);
  const outDir = resolve(values.out ?? join("output", "lead-hunter"));

  let discovery: TelegramDiscovery | null = null;
  let ledgerRef: UsageLedger | undefined;
  if (values.live) {
    const apiId = Number(env.TELEGRAM_API_ID ?? "");
    const apiHash = env.TELEGRAM_API_HASH?.trim();
    const session = env.TELEGRAM_SESSION?.trim();
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash || !session) {
      console.error(
        "TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION must be set for --live (see .env.example).",
      );
      return 1;
    }
    // Loaded lazily so the rest of the package works without teleproto.
    const { createTeleprotoDiscovery } = await import(
      "./adapters/teleproto.js"
    );
    const auditFile = join(outDir, runId, "audit.jsonl");
    mkdirSync(dirname(auditFile), { recursive: true });
    discovery = createTeleprotoDiscovery({
      apiId,
      apiHash,
      session,
      pacing: { minDelayMs: 1_800, maxActionsPerHour: 1_200, onCeiling: "wait" },
      maxFloodWaitSeconds: 300,
      onRequest: (method) => ledgerRef?.telegram(method),
      // Method name and outcome only: no payloads, no identifiers.
      audit: {
        record: (entry) =>
          appendFileSync(
            auditFile,
            `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
          ),
      },
    });
  }

  const renderer = values.browser ? createBrowserRenderer() : undefined;
  const http = createHttpFetcher();
  try {
    const { directory, result } = await executeRun({
      outDir,
      runId,
      llm,
      fetchPage: http,
      discovery,
      ...(renderer ? { renderPage: renderer } : {}),
      limits,
      profile,
      onLedger: (ledger) => {
        ledgerRef = ledger;
      },
      log: (line) =>
        console.info(
          `[lead-hunter ${new Date().toISOString().slice(11, 19)}] ${line}`,
        ),
      ...(values.web
        ? {
            webPreview: (ledger: UsageLedger) =>
              createWebPreview(http, ledger),
          }
        : {}),
    });
    console.info(
      `done: ${result.leads.length} lead(s); report in ${join(directory, "report.md")}`,
    );
    return 0;
  } finally {
    await discovery?.disconnect();
    await renderer?.close();
  }
}
