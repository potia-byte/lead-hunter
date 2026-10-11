import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RESEARCH_SOURCE } from "./batch.js";
import { DEFAULT_PROFILE, type ProductProfile } from "./config.js";
import type { FetchPage } from "./enrich.js";
import { type LlmClient, UsageLedger } from "./llm.js";
import {
  DEFAULT_LIMITS,
  emptyState,
  type Limits,
  type RunResult,
  type RunState,
  runPipeline,
} from "./pipeline.js";
import { funnelOf, markdownReport, topEntry } from "./report.js";
import type { TelegramDiscovery } from "./source.js";
import type { WebPreview } from "./webpreview.js";

/**
 * One checkpointed run written to disk:
 *   <outDir>/<runId>/{state.json, batch.json, report.json, report.md}
 * The pipeline is resumable: state.json is rewritten atomically after each
 * unit of work and a rerun with the same runId skips what is done.
 */

export interface ExecuteRunOptions {
  outDir: string;
  runId: string;
  llm: LlmClient;
  fetchPage: FetchPage;
  discovery?: TelegramDiscovery | null;
  /** A preview, or a factory that receives the run ledger to count requests. */
  webPreview?: WebPreview | ((ledger: UsageLedger) => WebPreview);
  renderPage?: FetchPage;
  limits?: Limits;
  profile?: ProductProfile;
  now?: () => Date;
  log?: (line: string) => void;
  /** Called with the ledger so adapters can count their own requests. */
  onLedger?: (ledger: UsageLedger) => void;
}

export interface ExecuteRunResult {
  directory: string;
  state: RunState;
  result: RunResult;
}

/** Ids other runs already fetched, so a new run spends limits only on new entities. */
export function fetchedByEarlierRuns(
  runsDirectory: string,
  currentRun: string,
): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(runsDirectory)) return ids;
  for (const run of readdirSync(runsDirectory)) {
    if (run === currentRun) continue;
    const path = join(runsDirectory, run, "state.json");
    if (!existsSync(path)) continue;
    try {
      const earlier = JSON.parse(
        readFileSync(path, "utf8"),
      ) as Partial<RunState>;
      for (const id of Object.keys(earlier.entities ?? {})) ids.add(id);
    } catch {
      // A half-written state from a crashed run: its entities get refetched.
    }
  }
  return ids;
}

function writeAtomic(path: string, content: string): void {
  writeFileSync(`${path}.tmp`, content, "utf8");
  renameSync(`${path}.tmp`, path);
}

export async function executeRun(
  options: ExecuteRunOptions,
): Promise<ExecuteRunResult> {
  const now = options.now ?? (() => new Date());
  const profile = options.profile ?? DEFAULT_PROFILE;
  const directory = join(options.outDir, options.runId);
  mkdirSync(directory, { recursive: true });
  const statePath = join(directory, "state.json");
  const state: RunState = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as RunState)
    : emptyState(options.runId, now());
  const ledger = UsageLedger.from(state.ledger);
  options.onLedger?.(ledger);

  const result = await runPipeline({
    state,
    save: async (next) => {
      Object.assign(state, next);
      writeAtomic(statePath, JSON.stringify(state));
    },
    discovery: options.discovery ?? null,
    llm: options.llm,
    ledger,
    fetchPage: options.fetchPage,
    ...(options.renderPage ? { renderPage: options.renderPage } : {}),
    ...(options.webPreview
      ? {
          webPreview:
            typeof options.webPreview === "function"
              ? options.webPreview(ledger)
              : options.webPreview,
        }
      : {}),
    limits: options.limits ?? DEFAULT_LIMITS,
    profile,
    now,
    log: options.log ?? (() => {}),
    alreadyFetched: fetchedByEarlierRuns(options.outDir, options.runId),
  });

  if (result.leads.length > 0)
    writeAtomic(
      join(directory, "batch.json"),
      JSON.stringify(
        {
          version: 1,
          batchId: `${RESEARCH_SOURCE}-${options.runId}`,
          researchedAt: now().toISOString(),
          leads: result.leads,
        },
        null,
        2,
      ),
    );
  writeAtomic(
    join(directory, "report.json"),
    JSON.stringify(
      {
        runId: options.runId,
        funnel: funnelOf(state, result),
        usage: result.ledger.toJSON(),
        stops: state.stops,
        leadErrors: result.leadErrors,
        top: result.qualified.slice(0, 20).map((view) => topEntry(view, profile)),
        rejectedSample: result.businesses
          .filter((view) => !result.qualified.includes(view))
          .slice(0, 40)
          .map((view) => ({
            ...topEntry(view, profile),
            rejectReason: view.classification.rejectReason,
          })),
      },
      null,
      2,
    ),
  );
  writeAtomic(
    join(directory, "report.md"),
    markdownReport(state, result, 20, profile),
  );
  return { directory, state, result };
}
