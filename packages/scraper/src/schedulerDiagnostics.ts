import { monitorEventLoopDelay, performance } from "node:perf_hooks";

interface JobState {
  jobId: string;
  schedule: string;
  lastScheduledAt: string | null;
  lastStartedAt: string | null;
  lastStartedScheduledAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  skippedRuns: number;
  missedRuns: number;
  expectedCompletionBy: string;
}

interface TrackedJob {
  state: JobState;
  nextRun: () => Date;
  allowanceMs: number;
}

export class SchedulerDiagnostics {
  private readonly jobs = new Map<string, TrackedJob>();

  register(jobId: string, schedule: string, nextRun: () => Date, allowanceMs: number, initial = false): void {
    this.jobs.set(jobId, {
      nextRun,
      allowanceMs,
      state: {
        jobId, schedule,
        lastScheduledAt: null, lastStartedAt: null, lastStartedScheduledAt: null, lastCompletedAt: null,
        lastSuccessAt: null, lastError: null, skippedRuns: 0, missedRuns: 0,
        expectedCompletionBy: new Date((initial ? Date.now() : nextRun().getTime()) + allowanceMs).toISOString(),
      },
    });
  }

  private job(jobId: string): TrackedJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown diagnostic job: ${jobId}`);
    return job;
  }

  scheduled(jobId: string, scheduledAt: Date, jitterMs = 0): void {
    const { state } = this.job(jobId);
    state.lastScheduledAt = scheduledAt.toISOString();
    console.log(JSON.stringify({
      event: "job_scheduled", jobId, scheduledAt: state.lastScheduledAt,
      observedAt: new Date().toISOString(), jitterMs,
    }));
  }

  skipped(jobId: string): void {
    this.job(jobId).state.skippedRuns++;
    console.warn(JSON.stringify({ event: "job_skipped_locked", jobId, observedAt: new Date().toISOString() }));
  }

  missed(jobId: string): void {
    this.job(jobId).state.missedRuns++;
    // node-cron 4.2.1 passes the next match, not the missed date, to this event.
    console.warn(JSON.stringify({ event: "job_missed", jobId, observedAt: new Date().toISOString() }));
  }

  started(jobId: string, scheduledAt: Date | null = null): void {
    const { state } = this.job(jobId);
    state.lastStartedAt = new Date().toISOString();
    state.lastStartedScheduledAt = scheduledAt?.toISOString() ?? null;
    console.log(JSON.stringify({
      event: "job_started", jobId, scheduledAt: state.lastStartedScheduledAt, startedAt: state.lastStartedAt,
      startDelayMs: scheduledAt ? Date.now() - scheduledAt.getTime() : null,
    }));
  }

  completed(jobId: string, success: boolean, durationMs: number, error: string | null = null): void {
    const job = this.job(jobId);
    job.state.lastCompletedAt = new Date().toISOString();
    job.state.lastError = success ? null : error || "Scrape reported errors";
    if (success) {
      job.state.lastSuccessAt = job.state.lastCompletedAt;
      job.state.expectedCompletionBy = new Date(job.nextRun().getTime() + job.allowanceMs).toISOString();
    }
    console[success ? "log" : "error"](JSON.stringify({
      event: success ? "job_finished" : "job_failed", ...job.state, durationMs,
    }));
  }

  snapshot() {
    return Array.from(this.jobs.values(), ({ state }) => ({
      ...state,
      stale: Date.now() > Date.parse(state.expectedCompletionBy),
    }));
  }
}

export function startRuntimeDiagnostics(): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let previousWall = Date.now();
  let previousMonotonic = performance.now();
  const timer = setInterval(() => {
    const wall = Date.now();
    const monotonic = performance.now();
    const elapsedMs = monotonic - previousMonotonic;
    const clockDriftMs = wall - previousWall - elapsedMs;
    const eventLoopMaxMs = histogram.max / 1e6;
    const sample = {
      event: "scheduler_runtime", observedAt: new Date(wall).toISOString(),
      elapsedMs, clockDriftMs, timerDelayMs: Math.max(0, elapsedMs - 30_000),
      eventLoopMaxMs, eventLoopP99Ms: histogram.percentile(99) / 1e6,
    };
    console[eventLoopMaxMs > 2000 || Math.abs(clockDriftMs) > 2000 || sample.timerDelayMs > 2000 ? "warn" : "log"](
      JSON.stringify(sample)
    );
    previousWall = wall;
    previousMonotonic = monotonic;
    histogram.reset();
  }, 30_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
