// Generic periodic-job runner for the worker. Each job is a named tuple of
// `{ intervalMs, jitterMs, run }`; we manage the timer, the in-flight guard,
// and the jitter randomization centrally so individual jobs stay focused on
// their business logic.
//
// Why not setInterval directly? Three reasons:
//   1. Re-entrancy: a slow tick must not overlap with the next interval
//      firing. Each job tracks its own `inFlight` flag.
//   2. Jitter: multiple jobs starting at boot would otherwise hit the RPC /
//      Telegram / DB synchronously every tick. A bounded random delay
//      smears them out.
//   3. Crash isolation: a thrown job MUST NOT take the worker down. The
//      poller and executor patterns log + continue; we mirror that here.

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  // Maximum jitter added (uniformly at random) to the next-tick delay.
  // 0 disables jitter. Typical values: 5–30 minutes for hourly jobs.
  jitterMs: number;
  // Whether to run once immediately on start (after a small initial jitter)
  // or wait for the first interval. Most jobs want true so the first tick
  // doesn't wait an hour; the dispatcher applies a small random initial
  // offset regardless.
  runImmediately?: boolean;
  run: () => Promise<void>;
}

interface JobRuntime {
  job: ScheduledJob;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  stopped: boolean;
}

function nextDelay(job: ScheduledJob): number {
  const jitter = job.jitterMs > 0 ? Math.floor(Math.random() * job.jitterMs) : 0;
  return job.intervalMs + jitter;
}

async function runOnce(rt: JobRuntime): Promise<void> {
  if (rt.stopped) return;
  if (rt.inFlight) return;
  rt.inFlight = true;
  try {
    await rt.job.run();
  } catch (err) {
    // A job's own try/catch should catch its expected failures; this is the
    // last-resort net for an unhandled exception. Log + continue — never
    // let one bad tick kill the worker.
    console.error(`[scheduled-job:${rt.job.name}] tick failed:`, err);
  } finally {
    rt.inFlight = false;
  }
}

function schedule(rt: JobRuntime): void {
  if (rt.stopped) return;
  rt.timer = setTimeout(async () => {
    await runOnce(rt);
    schedule(rt);
  }, nextDelay(rt.job));
}

// Max time the stop function will wait for in-flight jobs to drain before
// returning. Process supervisors (Railway sends SIGKILL ~30s after SIGTERM)
// will eventually force-kill regardless; this just bounds how long shutdown
// blocks waiting for a slow RPC tick to finish persisting its rows. Tuned
// shorter than typical platform timeouts so we don't get force-killed mid-
// write — better to log "tick abandoned" and let the next boot pick up.
const STOP_DRAIN_TIMEOUT_MS = 10_000;
const STOP_DRAIN_POLL_MS = 50;

// Start all jobs. Returns an async stop function that:
//   1. Cancels every job's pending timer (no new ticks will start).
//   2. Waits for in-flight ticks to finish (up to STOP_DRAIN_TIMEOUT_MS).
//
// The drain matters because an APY-collector tick is ~3 serial RPC reads +
// 3 inserts: killing it mid-sequence silently drops that hour's snapshot
// and (worse) leaves the protocol SDKs with half-closed sockets. Worker
// shutdown awaits this before calling bot.stop() so jobs settle first.
export function startScheduledJobs(jobs: ScheduledJob[]): () => Promise<void> {
  const runtimes: JobRuntime[] = jobs.map((job) => ({
    job,
    timer: null,
    inFlight: false,
    stopped: false,
  }));

  for (const rt of runtimes) {
    console.log(
      `[scheduled-job:${rt.job.name}] starting (interval=${rt.job.intervalMs}ms jitter=${rt.job.jitterMs}ms immediate=${rt.job.runImmediately !== false})`,
    );
    if (rt.job.runImmediately !== false) {
      // Tiny initial offset so multiple jobs marked immediate don't fire
      // on the exact same event-loop tick — keeps the boot footprint sane
      // when N jobs all want to read RPC.
      const initialDelay = Math.floor(Math.random() * Math.min(5000, rt.job.intervalMs));
      rt.timer = setTimeout(async () => {
        await runOnce(rt);
        schedule(rt);
      }, initialDelay);
    } else {
      schedule(rt);
    }
  }

  return async () => {
    for (const rt of runtimes) {
      rt.stopped = true;
      if (rt.timer) {
        clearTimeout(rt.timer);
        rt.timer = null;
      }
    }
    // Drain: poll inFlight flags until every job settles or we hit the
    // deadline. Polling (rather than awaiting a per-job promise) keeps
    // runOnce branchless on a happy path — the cost is one extra
    // setTimeout cycle in shutdown, which is negligible.
    const deadline = Date.now() + STOP_DRAIN_TIMEOUT_MS;
    while (runtimes.some((rt) => rt.inFlight)) {
      if (Date.now() >= deadline) {
        const stuck = runtimes.filter((rt) => rt.inFlight).map((rt) => rt.job.name);
        console.warn(
          `[scheduled-jobs] drain timeout after ${STOP_DRAIN_TIMEOUT_MS}ms; abandoning in-flight: ${stuck.join(', ')}`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, STOP_DRAIN_POLL_MS));
    }
  };
}
