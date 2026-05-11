import { bot } from './bot';
import { env } from './env';
import { startExecutor } from './executor';
import { checkIdleCapital } from './jobs/check-idle-capital';
import { checkYieldDrift } from './jobs/check-yield-drift';
import { collectApySnapshots } from './jobs/collect-apy-snapshots';
import { startActionPoller } from './poller';
import { startScheduledJobs } from './scheduled-jobs';

console.log(`[worker] booting in ${env.NODE_ENV} mode`);

const stopPoller = startActionPoller();
const stopExecutor = startExecutor();
const stopScheduledJobs = startScheduledJobs([
  {
    name: 'collect-apy-snapshots',
    intervalMs: env.APY_SNAPSHOT_INTERVAL_MS,
    jitterMs: env.APY_SNAPSHOT_JITTER_MS,
    runImmediately: true,
    run: collectApySnapshots,
  },
  {
    name: 'check-yield-drift',
    intervalMs: env.YIELD_DRIFT_CHECK_INTERVAL_MS,
    jitterMs: env.YIELD_DRIFT_CHECK_JITTER_MS,
    // No immediate run: the APY collector needs at least a sustainHours
    // window of snapshots before drift can be meaningfully evaluated. The
    // first scheduled tick (6h later) lands well after the collector has
    // populated history. Running immediately would just no-op (avg returns
    // null until the window fills) but would spend RPC budget reading
    // positions for nothing.
    runImmediately: false,
    run: checkYieldDrift,
  },
  {
    name: 'check-idle-capital',
    intervalMs: env.IDLE_CAPITAL_CHECK_INTERVAL_MS,
    jitterMs: env.IDLE_CAPITAL_CHECK_JITTER_MS,
    // No immediate run: same rationale as yield-drift — the latest-APY
    // read needs the collector to have populated at least one tick per
    // wired venue. The daily cadence means the first natural run lands
    // ~24h after boot, well after the hourly collector has filled in.
    runImmediately: false,
    run: checkIdleCapital,
  },
]);

let isShuttingDown = false;
const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[worker] received ${signal}, shutting down`);
  try {
    stopPoller();
    stopExecutor();
    // Drain in-flight scheduled jobs (e.g. APY collector mid-RPC) before
    // stopping the bot — otherwise a partial tick can leave inserts
    // unfinished. Bounded by STOP_DRAIN_TIMEOUT_MS inside the stop fn.
    await stopScheduledJobs();
    await bot.stop();
  } catch (err) {
    console.error('[worker] shutdown error', err);
  }
  process.exitCode = 0;
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// `drop_pending_updates: true` in dev so a restart doesn't replay every queued
// click; `false` in prod so a deploy doesn't lose approvals that arrived while
// the worker was restarting. bot.start() blocks until bot.stop() is called.
await bot.start({
  drop_pending_updates: env.NODE_ENV === 'development',
  onStart: (info) => console.log(`[worker] @${info.username} started`),
});
