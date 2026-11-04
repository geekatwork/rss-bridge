import cron, { type TaskContext } from "node-cron";

export function scheduleWithRecovery(
  expression: string,
  scheduled: (context: TaskContext) => void,
  missed: () => void
) {
  let expected: Date;
  let recoveredThrough = -Infinity;
  const task = cron.schedule(expression, (context) => {
    if (context.date.getTime() <= recoveredThrough) {
      console.warn(JSON.stringify({
        event: "schedule_late_callback_coalesced", schedule: expression,
        scheduledAt: context.date.toISOString(),
      }));
      return;
    }
    expected = nextRun();
    scheduled(context);
  });
  function nextRun(): Date {
    const next = task.getNextRun();
    if (!next) throw new Error(`No next run for active schedule: ${expression}`);
    return next;
  }
  const recover = (source: "node-cron" | "watchdog") => {
    const now = Date.now();
    if (now < expected.getTime()) return;
    const missedAt = expected.toISOString();
    recoveredThrough = now;
    expected = nextRun();
    console.warn(JSON.stringify({
      event: "schedule_missed", schedule: expression, source,
      scheduledAt: missedAt, observedAt: new Date(now).toISOString(),
    }));
    missed();
  };
  task.on("execution:missed", () => recover("node-cron"));
  let timer: ReturnType<typeof setInterval>;
  const startWatchdog = () => {
    expected = nextRun();
    // node-cron's first delayed heartbeat may skip a match without emitting a missed event.
    timer = setInterval(() => {
      if (Date.now() > expected.getTime() + 30_000) recover("watchdog");
    }, 30_000);
    timer.unref();
  };
  startWatchdog();
  task.on("task:started", startWatchdog);
  task.on("task:stopped", () => clearInterval(timer));
  task.on("task:destroyed", () => clearInterval(timer));
  return task;
}
