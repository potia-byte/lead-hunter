import type { z } from "zod";

/**
 * The only way Lead Hunter talks to a model: one small interface, so any
 * provider, router or model pool can sit behind it. Tests and the demo pass a
 * scripted fake; see README for a model-pool adapter example.
 */

export type LlmTier = "cheap" | "strong";

export interface LlmOptions {
  /** "cheap" for bulk reading, "strong" for the final review of top leads. */
  tier: LlmTier;
  maxTokens: number;
  /** `provider/model` routes to skip, e.g. the one that just returned junk. */
  avoid?: readonly string[];
}

export interface LlmCompletion {
  text: string;
  /** Which model answered; used for usage accounting and `avoid`. */
  route?: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
}

export interface LlmClient {
  /**
   * Returns the model's text, or an object with route/usage metadata. Throws
   * (ideally LlmUnavailableError) when no answer could be obtained.
   */
  completion(prompt: string, options: LlmOptions): Promise<string | LlmCompletion>;
}

/** The model call failed; `exhausted` means retrying today is pointless. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly exhausted = false,
  ) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

/** Internal request shape: a prompt plus its options. */
export interface LlmRequest extends LlmOptions {
  prompt: string;
}

export type LlmResponse =
  | {
      ok: true;
      text: string;
      route: string;
      usage: { inputTokens: number; outputTokens: number } | null;
    }
  | { ok: false; reason: string };

const DEFAULT_ROUTE = "llm";

/** Normalises a client call into a never-throwing response. */
export async function callLlm(
  llm: LlmClient,
  request: LlmRequest,
): Promise<LlmResponse> {
  const { prompt, ...options } = request;
  try {
    const answer = await llm.completion(prompt, options);
    if (typeof answer === "string")
      return { ok: true, text: answer, route: DEFAULT_ROUTE, usage: null };
    return {
      ok: true,
      text: answer.text,
      route: answer.route ?? DEFAULT_ROUTE,
      usage: answer.usage ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = error instanceof LlmUnavailableError && error.exhausted;
    return {
      ok: false,
      reason: `${exhausted ? "exhausted" : "unavailable"}: ${message}`,
    };
  }
}

export interface UsageLine {
  route: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
}

/** Tokens and calls per model route, for the run report. */
export class UsageLedger {
  private readonly lines = new Map<string, UsageLine>();
  telegramRequests: Record<string, number> = {};
  webRequests = 0;
  browserSessions = 0;

  record(
    route: string,
    usage: { inputTokens: number; outputTokens: number } | null,
    ok: boolean,
  ): void {
    const line = this.lines.get(route) ?? {
      route,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      failures: 0,
    };
    line.calls += 1;
    if (!ok) line.failures += 1;
    line.inputTokens += usage?.inputTokens ?? 0;
    line.outputTokens += usage?.outputTokens ?? 0;
    this.lines.set(route, line);
  }

  telegram(method: string): void {
    this.telegramRequests[method] = (this.telegramRequests[method] ?? 0) + 1;
  }

  summary(): UsageLine[] {
    return [...this.lines.values()].sort((a, b) => b.calls - a.calls);
  }

  toJSON() {
    return {
      llm: this.summary(),
      telegramRequests: this.telegramRequests,
      webRequests: this.webRequests,
      browserSessions: this.browserSessions,
    };
  }

  static from(value: unknown): UsageLedger {
    const ledger = new UsageLedger();
    const data = (value ?? {}) as ReturnType<UsageLedger["toJSON"]>;
    for (const line of data.llm ?? []) ledger.lines.set(line.route, line);
    ledger.telegramRequests = data.telegramRequests ?? {};
    ledger.webRequests = data.webRequests ?? 0;
    ledger.browserSessions = data.browserSessions ?? 0;
    return ledger;
  }
}

/**
 * Pulls the first JSON value out of a model reply: tolerates code fences,
 * prose before or after, and `<think>` blocks from reasoning models.
 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .replace(/```(?:json)?/giu, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to bracket scanning
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // try the other bracket kind
      }
    }
  }
  throw new Error("reply contained no parseable JSON");
}

export type JsonResult<T> =
  | { ok: true; value: T; route: string }
  | { ok: false; reason: string };

/**
 * Asks for JSON matching `schema`. A malformed or off-schema reply is retried
 * on a different model (the failing route is avoided), up to `attempts`.
 */
export async function completeJson<T>(
  llm: LlmClient,
  ledger: UsageLedger,
  request: LlmRequest,
  schema: z.ZodType<T>,
  attempts = 3,
): Promise<JsonResult<T>> {
  const avoid = [...(request.avoid ?? [])];
  let lastReason = "no attempt made";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await callLlm(llm, { ...request, avoid });
    if (!response.ok) {
      ledger.record(`${request.tier}:unavailable`, null, false);
      return { ok: false, reason: response.reason };
    }
    let parsed: unknown;
    try {
      parsed = parseJsonLoose(response.text);
    } catch (error) {
      ledger.record(response.route, response.usage, false);
      lastReason = `${response.route}: ${(error as Error).message}`;
      avoid.push(response.route);
      continue;
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      ledger.record(response.route, response.usage, false);
      lastReason = `${response.route}: off-schema reply (${checked.error.issues[0]?.message ?? "invalid"})`;
      avoid.push(response.route);
      continue;
    }
    ledger.record(response.route, response.usage, true);
    return { ok: true, value: checked.data, route: response.route };
  }
  return { ok: false, reason: lastReason };
}
