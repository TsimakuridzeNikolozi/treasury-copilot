# Treasury Copilot

Chat-first AI agent that manages a startup or DAO's USDC across Solana yield venues (Kamino, Drift Earn, Marginfi) under hard policy guardrails, with human-in-the-loop approval for moves above threshold.

> Status: scaffolding only. No business logic, no real integrations. See `// TODO(phase-1):` markers for what's next.

**For day-to-day usage, deployment, and troubleshooting, read [`docs/handbook.md`](./docs/handbook.md).** This README is just orientation.

## Stack

- **Monorepo:** pnpm workspaces + Turborepo
- **Web:** Next.js 15 (App Router), React 19, Tailwind v4, shadcn/ui
- **Worker:** Node 22, deployed to Railway via Docker
- **DB:** Postgres (local: Docker; prod: Neon) via Drizzle ORM
- **Lint/format:** Biome
- **Testing:** Vitest

## Quick start

```bash
nvm use                                  # uses .nvmrc (Node 22.11)
corepack enable && corepack prepare pnpm@9 --activate
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env
docker compose up -d postgres            # local Postgres on :5432
pnpm install
pnpm build                               # one-time, so packages emit .d.ts
pnpm dev                                 # runs web + worker concurrently
```

## Repo layout

```
apps/
  web/         Next.js 15 chat UI + audit dashboard + approval flow
  worker/      Long-running Telegram approval bot (Railway)
packages/
  agent-tools  AI SDK tool definitions (stub)
  biome-config Shared lint/format config
  db           Drizzle ORM client + schema
  env          Shared Zod env schema fragments
  policy       Policy guardrail engine (stub)
  protocols    Solana protocol adapters: kamino / drift / marginfi (stubs)
  signer       Signer abstraction (stub)
  tsconfig     Shared TS configs
  types        Shared domain types
```

## Workspace dependency direction

```
apps/web      → env, types, db, policy, agent-tools, protocols
apps/worker   → env, types, db, policy, signer
agent-tools   → types, policy, signer, protocols
signer        → types, policy
policy        → types
protocols     → types
db            → types
env, types    → (leaves)
```

No cycles by construction — deps only flow downward toward `types`/`env`.

## Common scripts

```bash
pnpm dev                # turbo run dev (web + worker)
pnpm build              # turbo run build
pnpm lint               # biome check across all packages
pnpm typecheck          # tsc --noEmit across all packages
pnpm test               # vitest run across all packages
pnpm db:up              # start local Postgres
pnpm db:generate        # drizzle-kit generate
pnpm db:migrate         # drizzle-kit migrate
```

## Deployment (not yet wired)

- **Web → Vercel.** When ready: `vercel link --repo` from repo root, then `vercel --prod` from `apps/web`. Use `--repo` because this is a monorepo.
- **Worker → Railway.** `apps/worker/Dockerfile` and `apps/worker/railway.toml` are in place. Connect Railway to this repo and it will detect the Dockerfile.
- **DB → Neon** (staging/prod). Local dev uses Docker Postgres on `:5432`.

## What's deliberately not in the scaffold

These are first-feature work, not setup:

- Auth (Privy / Turnkey)
- Real Drizzle schema (audit logs, proposed actions, policies)
- Vercel AI SDK wiring + chat route handler
- Solana RPC client and protocol SDKs (Kamino, Drift, Marginfi)
- Telegram bot client (grammy)
- Policy rules and signer implementation
- CI workflows
