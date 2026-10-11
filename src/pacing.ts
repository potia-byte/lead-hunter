/**
 * Live Telegram actions are paced deliberately: a userbot that behaves like a
 * script gets the account limited, and honouring FLOOD_WAIT is the difference
 * between a slow run and a banned account.
 */

export class RateCeilingError extends Error {
  constructor(limit: number) {
    super(
      `Hourly ceiling of ${limit} live actions reached; stopping rather than pushing on`,
    );
    this.name = "RateCeilingError";
  }
}

export class FloodWaitError extends Error {
  constructor(readonly seconds: number) {
    super(`Telegram asked for a ${seconds}s pause`);
    this.name = "FloodWaitError";
  }
}

export interface PacingConfig {
  minDelayMs: number;
  maxActionsPerHour: number;
  /**
   * "throw" (default) stops an interactive QA run at the ceiling; "wait"
   * suits long unattended jobs, which just slow down to the hourly rate.
   */
  onCeiling?: "throw" | "wait";
}

export interface Clock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const HOUR_MS = 3_600_000;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface Pacer {
  take(): Promise<void>;
}

export function createPacer(config: PacingConfig, clock: Clock = {}): Pacer {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? realSleep;
  const recent: number[] = [];
  let lastAction: number | undefined;

  return {
    async take(): Promise<void> {
      while (true) {
        while (recent.length > 0 && (recent[0] ?? 0) <= now() - HOUR_MS)
          recent.shift();
        if (recent.length < config.maxActionsPerHour) break;
        if (config.onCeiling !== "wait")
          throw new RateCeilingError(config.maxActionsPerHour);
        await sleep((recent[0] ?? 0) + HOUR_MS - now());
      }

      if (lastAction !== undefined) {
        const elapsed = now() - lastAction;
        if (elapsed < config.minDelayMs)
          await sleep(config.minDelayMs - elapsed);
      }

      lastAction = now();
      recent.push(lastAction);
    },
  };
}

export interface FloodWaitOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** A wait longer than this is a signal to stop, not to sleep through it. */
  maxWaitSeconds?: number;
}

export async function withFloodWait<T>(
  action: () => Promise<T>,
  options: FloodWaitOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  const maxRetries = options.maxRetries ?? 2;
  const maxWaitSeconds = options.maxWaitSeconds ?? 600;
  let attempt = 0;

  while (true) {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof FloodWaitError)) throw error;
      if (attempt >= maxRetries) throw error;
      if (error.seconds > maxWaitSeconds) throw error;

      // Honour Telegram's interval, then add a growing margin on repeats.
      await sleep(error.seconds * 1_000 * 2 ** attempt);
      attempt += 1;
    }
  }
}
