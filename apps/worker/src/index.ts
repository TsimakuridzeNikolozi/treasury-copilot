import { bot } from './bot';
import { env } from './env';
import { startActionPoller } from './poller';

console.log(`[worker] booting in ${env.NODE_ENV} mode`);

const stopPoller = startActionPoller();

const shutdown = async (signal: string) => {
  console.log(`[worker] received ${signal}, shutting down`);
  stopPoller();
  await bot.stop();
  process.exit(0);
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
