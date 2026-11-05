import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRuntimeDiagnosticsFlag,
  SchedulerDiagnostics,
  startRuntimeDiagnostics,
} from "./schedulerDiagnostics.js";

describe("scheduler diagnostics", () => {
  let diagnostics: SchedulerDiagnostics;
  let originalRuntimeDiagnosticsFlag: string | undefined;
  const nextRun = () => new Date(Date.now() + 60_000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T06:00:00Z"));
    originalRuntimeDiagnosticsFlag = process.env.SCRAPER_RUNTIME_DIAGNOSTICS;
    delete process.env.SCRAPER_RUNTIME_DIAGNOSTICS;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    diagnostics = new SchedulerDiagnostics();
  });

  afterEach(() => {
    if (originalRuntimeDiagnosticsFlag === undefined) {
      delete process.env.SCRAPER_RUNTIME_DIAGNOSTICS;
    } else {
      process.env.SCRAPER_RUNTIME_DIAGNOSTICS = originalRuntimeDiagnosticsFlag;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("tracks scheduled time, actual execution, and successful freshness", () => {
    diagnostics.register("scrape:1", "* * * * *", nextRun, 10_000, true);
    const date = new Date();
    diagnostics.scheduled("scrape:1", date, 5000);
    vi.setSystemTime(new Date(date.getTime() + 5000));
    diagnostics.started("scrape:1", date);
    diagnostics.completed("scrape:1", true, 123);
    expect(diagnostics.snapshot()[0]).toMatchObject({
      lastScheduledAt: date.toISOString(),
      lastStartedAt: "2026-11-02T06:00:05.000Z",
      lastStartedScheduledAt: date.toISOString(),
      lastCompletedAt: "2026-11-02T06:00:05.000Z",
      lastSuccessAt: "2026-11-02T06:00:05.000Z",
      expectedCompletionBy: "2026-11-02T06:01:15.000Z",
      stale: false,
    });

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"durationMs":123'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"startDelayMs":5000'));
  });

  it("correlates each execution without duplicating scheduler lifecycle events", () => {
    diagnostics.register("scrape:1", "* * * * *", nextRun, 10_000);
    diagnostics.started("scrape:1", null, "initial", "run-1");
    diagnostics.completed("scrape:1", true, 10);
    const events = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events.map((event) => [event.event, event.runId])).toEqual([
      ["job_started", "run-1"], ["job_finished", "run-1"],
    ]);
    diagnostics.started("scrape:1", null, "recovery", "run-2");
    expect(diagnostics.snapshot()[0]).toMatchObject({ runId: "run-2", recoveredRuns: 1 });
  });

  it("keeps execution correlation when a later cron occurrence arrives during jitter", () => {
    diagnostics.register("scrape:1", "* * * * *", nextRun, 10_000);
    const first = new Date();
    diagnostics.scheduled("scrape:1", first);
    vi.advanceTimersByTime(60_000);
    diagnostics.scheduled("scrape:1", new Date());
    diagnostics.started("scrape:1", first);
    expect(diagnostics.snapshot()[0]).toMatchObject({
      lastScheduledAt: "2026-11-02T06:01:00.000Z",
      lastStartedScheduledAt: first.toISOString(),
    });
  });

  it("does not refresh success or postpone stale detection on failed, skipped, or missed work", () => {
    diagnostics.register("scrape:1", "* * * * *", nextRun, 10_000, true);
    diagnostics.started("scrape:1");
    diagnostics.completed("scrape:1", true, 10);
    const successful = diagnostics.snapshot()[0];
    vi.setSystemTime(new Date("2026-11-02T06:01:10.000Z"));
    expect(diagnostics.snapshot()[0].stale).toBe(false);
    vi.advanceTimersByTime(1);
    diagnostics.scheduled("scrape:1", new Date());
    diagnostics.skipped("scrape:1");
    diagnostics.missed("scrape:1");
    diagnostics.started("scrape:1");
    diagnostics.completed("scrape:1", false, 20, "DB unavailable");
    expect(diagnostics.snapshot()[0]).toMatchObject({
      stale: true, skippedRuns: 1, missedRuns: 1, lastError: "DB unavailable",
      lastSuccessAt: successful.lastSuccessAt,
      expectedCompletionBy: successful.expectedCompletionBy,
    });
    diagnostics.completed("scrape:1", true, 10);
    expect(diagnostics.snapshot()[0]).toMatchObject({ stale: false, lastError: null });
  });

  it("allows startup work and waits for prune's first scheduled deadline", () => {
    diagnostics.register("scrape:1", "* * * * *", nextRun, 10_000, true);
    diagnostics.register("prune", "* * * * *", nextRun, 10_000);
    vi.advanceTimersByTime(10_001);
    expect(diagnostics.snapshot().map((job) => job.stale)).toEqual([true, false]);
    vi.advanceTimersByTime(60_000);
    expect(diagnostics.snapshot().map((job) => job.stale)).toEqual([true, true]);
  });

  it("rejects unregistered jobs explicitly", () => {
    expect(() => diagnostics.started("unknown")).toThrow("Unknown diagnostic job");
  });

  it("parses the runtime diagnostics flag with a disabled default", () => {
    expect(parseRuntimeDiagnosticsFlag(undefined)).toBe(false);
    expect(parseRuntimeDiagnosticsFlag(" false ")).toBe(false);
    expect(parseRuntimeDiagnosticsFlag("TRUE")).toBe(true);
    expect(parseRuntimeDiagnosticsFlag("true")).toBe(true);
    expect(() => parseRuntimeDiagnosticsFlag("")).toThrow(
      'Invalid SCRAPER_RUNTIME_DIAGNOSTICS value "". Expected "true" or "false".'
    );
    expect(() => parseRuntimeDiagnosticsFlag("yes")).toThrow(
      'Invalid SCRAPER_RUNTIME_DIAGNOSTICS value "yes". Expected "true" or "false".'
    );
  });

  it("does not start periodic runtime samples when disabled by default or explicitly", () => {
    const stopDefault = startRuntimeDiagnostics();
    const stopExplicit = startRuntimeDiagnostics("false");
    vi.advanceTimersByTime(60_000);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('"event":"scheduler_runtime"'));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('"event":"scheduler_runtime"'));
    stopDefault();
    stopExplicit();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs clock drift and delayed timer samples when enabled, and stops cleanly", () => {
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(0);
    const stop = startRuntimeDiagnostics("true");
    monotonic.mockReturnValue(30_000);
    vi.advanceTimersByTime(30_000);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"clockDriftMs":0'));
    vi.setSystemTime(new Date(Date.now() + 5000));
    monotonic.mockReturnValue(65_000);
    vi.advanceTimersByTime(30_000);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"timerDelayMs":5000'));
    monotonic.mockReturnValue(95_000);
    vi.setSystemTime(new Date(Date.now() + 10_000));
    vi.advanceTimersByTime(30_000);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"clockDriftMs":10000'));
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
