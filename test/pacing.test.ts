import { describe, expect, it, vi } from "vitest";
import {
  createPacer,
  FloodWaitError,
  RateCeilingError,
  withFloodWait,
} from "../src/pacing.js";

function controllable() {
  let current = 0;
  const slept: number[] = [];
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    sleep: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
    slept,
  };
}

describe("pacer", () => {
  it("spaces live actions apart", async () => {
    const clock = controllable();
    const pacer = createPacer(
      { minDelayMs: 1_000, maxActionsPerHour: 100 },
      { now: clock.now, sleep: clock.sleep },
    );

    await pacer.take();
    await pacer.take();

    expect(clock.slept).toEqual([1_000]);
  });

  it("does not wait when enough time already passed", async () => {
    const clock = controllable();
    const pacer = createPacer(
      { minDelayMs: 1_000, maxActionsPerHour: 100 },
      { now: clock.now, sleep: clock.sleep },
    );

    await pacer.take();
    clock.advance(5_000);
    await pacer.take();

    expect(clock.slept).toEqual([]);
  });

  it("refuses to exceed the hourly ceiling", async () => {
    const clock = controllable();
    const pacer = createPacer(
      { minDelayMs: 0, maxActionsPerHour: 3 },
      { now: clock.now, sleep: clock.sleep },
    );

    await pacer.take();
    await pacer.take();
    await pacer.take();

    await expect(pacer.take()).rejects.toThrow(RateCeilingError);
  });

  it("lets the ceiling recover as the hour rolls forward", async () => {
    const clock = controllable();
    const pacer = createPacer(
      { minDelayMs: 0, maxActionsPerHour: 1 },
      { now: clock.now, sleep: clock.sleep },
    );

    await pacer.take();
    clock.advance(3_600_001);

    await expect(pacer.take()).resolves.toBeUndefined();
  });

  it("can wait for the hourly window instead of refusing", async () => {
    const clock = controllable();
    const pacer = createPacer(
      { minDelayMs: 0, maxActionsPerHour: 2, onCeiling: "wait" },
      { now: clock.now, sleep: clock.sleep },
    );

    await pacer.take();
    clock.advance(1_000);
    await pacer.take();
    await pacer.take();

    // Sleeps until the first action leaves the one-hour window.
    expect(clock.slept).toEqual([3_600_000 - 1_000]);
    expect(clock.now()).toBe(3_600_000);
  });
});

describe("flood wait", () => {
  it("waits the interval Telegram asked for, then retries", async () => {
    const clock = controllable();
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new FloodWaitError(42))
      .mockResolvedValueOnce("done");

    const result = await withFloodWait(action, {
      sleep: clock.sleep,
      maxRetries: 2,
    });

    expect(result).toBe("done");
    expect(clock.slept).toEqual([42_000]);
  });

  it("backs off further on a repeated flood wait", async () => {
    const clock = controllable();
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new FloodWaitError(5))
      .mockRejectedValueOnce(new FloodWaitError(5))
      .mockResolvedValueOnce("done");

    await withFloodWait(action, { sleep: clock.sleep, maxRetries: 3 });

    expect(clock.slept[1]).toBeGreaterThan(clock.slept[0] ?? 0);
  });

  it("gives up rather than hammering the API forever", async () => {
    const clock = controllable();
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new FloodWaitError(3));

    await expect(
      withFloodWait(action, { sleep: clock.sleep, maxRetries: 2 }),
    ).rejects.toThrow(FloodWaitError);
    expect(action).toHaveBeenCalledTimes(3);
  });

  it("refuses an implausibly long wait instead of sleeping through it", async () => {
    const clock = controllable();
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new FloodWaitError(86_400));

    await expect(
      withFloodWait(action, {
        sleep: clock.sleep,
        maxRetries: 2,
        maxWaitSeconds: 300,
      }),
    ).rejects.toThrow(FloodWaitError);
    expect(clock.slept).toEqual([]);
  });

  it("passes other errors straight through", async () => {
    const clock = controllable();
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("boom"));

    await expect(withFloodWait(action, { sleep: clock.sleep })).rejects.toThrow(
      "boom",
    );
    expect(action).toHaveBeenCalledTimes(1);
  });
});
