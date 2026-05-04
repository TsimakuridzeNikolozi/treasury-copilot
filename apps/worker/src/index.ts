import { env } from './env';

console.log(`[worker] booting in ${env.NODE_ENV} mode`);

// TODO(phase-1): wire up Telegram bot (grammy), DB client, approval handlers.

const shutdown = (signal: string) => {
  console.log(`[worker] received ${signal}, shutting down gracefully`);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[worker] up — idle until phase-1 handlers land');

// Keep the process alive without busy-looping.
setInterval(() => {}, 1 << 30);
