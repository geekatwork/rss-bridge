import cron, { type ScheduledTask } from "node-cron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleWithRecovery } from "./recoverableSchedule.js";

describe("recoverable cron schedules", () => {
  const tasks: ScheduledTask[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T02:59:50Z"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const task of tasks.splice(0)) task.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reproduces node-cron's silent miss on its first delayed heartbeat", async () => {
    const scheduled = vi.fn();
    const missed = vi.fn();
    const task = cron.schedule("* * * * *", scheduled);
    tasks.push(task);
    task.on("execution:missed", missed);

    vi.setSystemTime(new Date("2026-11-04T03:00:05Z"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(scheduled).not.toHaveBeenCalled();
    expect(missed).not.toHaveBeenCalled();
  });

  it("recovers that silent miss without runtime telemetry and resumes normal scheduling", async () => {
    const scheduled = vi.fn();
    const missed = vi.fn();
    tasks.push(scheduleWithRecovery("* * * * *", scheduled, missed));
    vi.setSystemTime(new Date("2026-11-04T03:00:05Z"));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(scheduled).not.toHaveBeenCalled();
    expect(missed).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"source":"watchdog"'));
    await vi.advanceTimersByTimeAsync(25_001);
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(missed).toHaveBeenCalledTimes(1);
  });

  it("preserves on-time callbacks and does not recover during scheduled work or jitter", async () => {
    const work = vi.fn();
    const scheduled = vi.fn(() => { setTimeout(work, 90_000); });
    const missed = vi.fn();
    tasks.push(scheduleWithRecovery("* * * * *", scheduled, missed));

    await vi.advanceTimersByTimeAsync(50_000);

    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    expect(missed).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("uses node-cron missed events after the first heartbeat without duplicate watchdog recovery", async () => {
    const scheduled = vi.fn();
    const missed = vi.fn();
    tasks.push(scheduleWithRecovery("* * * * *", scheduled, missed));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(scheduled).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-11-04T03:02:05Z"));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(missed).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"source":"node-cron"'));
  });

  it("coalesces multiple silently missed occurrences and suppresses a late callback", async () => {
    const schedule = vi.spyOn(cron, "schedule");
    const scheduled = vi.fn();
    const missed = vi.fn();
    const task = scheduleWithRecovery("* * * * *", scheduled, missed);
    tasks.push(task);
    const callback = schedule.mock.calls[0][1];
    vi.setSystemTime(new Date("2026-11-04T03:04:05Z"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(missed).toHaveBeenCalledTimes(1);

    const date = new Date("2026-11-04T03:04:00Z");
    if (typeof callback !== "function") throw new Error("Expected inline cron callback");
    await callback({ date, dateLocalIso: date.toISOString(), triggeredAt: new Date(), task });
    expect(scheduled).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"event":"schedule_late_callback_coalesced"'));
  });

  it("cleans up the watchdog when the task is stopped or destroyed", () => {
    const task = scheduleWithRecovery("* * * * *", vi.fn(), vi.fn());
    tasks.push(task);
    expect(vi.getTimerCount()).toBe(2);
    task.stop();
    expect(vi.getTimerCount()).toBe(0);
    task.start();
    expect(vi.getTimerCount()).toBe(2);
    task.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
