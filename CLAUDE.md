# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

Treasury Copilot is a chat-first AI agent that manages a startup or DAO's USDC across Solana yield venues (Kamino, Save, Drift Earn, Marginfi) under hard policy guardrails, with human-in-the-loop approval for moves above a threshold.

Venue coverage today: deposit + withdraw are wired end-to-end on **Kamino** (Main Market, USDC reserve) and **Save** (Main Pool, USDC reserve). Drift / Marginfi / rebalance still fall through to the smoke self-transfer.

Phase-1 markers: look for `// TODO(2E–2F):` and similar pointers for work that's intentionally deferred.

## Common commands

```bash
pnpm dev                # turbo run dev — boots web (Next.js :3000) + worker concurrently
pnpm build              # builds all packages; web → .next, worker → dist via tsup
pnpm typecheck          # tsc --noEmit across every workspace
pnpm lint               # biome check across every workspace
pnpm format             # biome format --write
pnpm test               # vitest run across every workspace
pnpm db:up              # docker compose up -d postgres (local Postgres on :5432)
pnpm db:down            # stop local Postgres
pnpm db:generate        # drizzle-kit generate (run from anywhere)
pnpm db:migrate         # drizzle-kit migrate

# Single-package operations
pnpm --filter @tc/web dev
pnpm --filter @tc/db generate
pnpm --filter @tc/policy test path/to/file.test.ts
```

## Pre-flight required before `pnpm build` or `pnpm dev`

The web app uses `@t3-oss/env-nextjs` with strict Zod validation; builds **fail at static collection** without a populated `.env.local`. New clones must run:

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env
docker compose up -d postgres
```

`SKIP_ENV_VALIDATION=1` is the documented escape hatch in `apps/web/src/env.ts` if you need to build without env (CI image bake, etc.).

## Architecture

### The trust boundary (security-critical)

The product's security model is enforced at the **type level** through a one-way dependency chain:

```
agent-tools  →  policy  →  signer
   (proposes)    (decides)   (executes)
```

- `@tc/agent-tools` builds a `ProposedAction` (from `@tc/types`) and hands it to `@tc/policy`.
- `@tc/policy` returns a `PolicyDecision` discriminated union: `allow | deny | requires_approval`.
- `@tc/signer.executeApproved()` accepts **only** `Extract<PolicyDecision, { kind: 'allow' }>`. The agent cannot construct an `allow` decision — only the policy engine can. TypeScript enforces this at compile time.

When adding a new tool or signer method, **never bypass this chain**. Don't add an export from `@tc/agent-tools` to `@tc/signer` directly — it would defeat the boundary.

### AI provider abstraction

Two pluggable backends — Anthropic Claude and OpenAI. Picked at runtime via `MODEL_PROVIDER`. Both plug in through a single switch in `apps/web/src/lib/ai/model.ts`. **Don't import `@ai-sdk/anthropic` or `@ai-sdk/openai` from anywhere else** — that breaks the swap. The trust boundary is unchanged: whichever model proposes, `policy.evaluate()` decides.

The orchestration helper `proposeAction(db, action, ctx)` lives in `@tc/agent-tools/src/propose.ts` and wires `sumAutoApprovedSince → evaluate → insertProposedAction` in one call. Vercel AI SDK tool definitions in the same package wrap it. The chat route (`apps/web/src/app/api/chat/route.ts`) is a thin shim around `streamText({ tools, messages })`.

### Workspace dependency direction (no cycles by construction)

```
apps/web      → env, types, db, policy, agent-tools, protocols
apps/worker   → env, types, db, policy, signer
agent-tools   → types, policy, signer, protocols, db
signer        → types, policy, protocols
policy        → types
protocols     → types
db            → types
env, types    → (leaves)
```

Apps are sinks. `types` and `env` are leaves. All arrows flow "down". When adding a new package, place it where this property holds.

### Two long-running processes, different concerns

- **`apps/web`** — Next.js 15 App Router. Hosts the chat UI, audit dashboard, approval flow, and (eventually) chat API route handlers that drive the AI agent. Deployed to Vercel.
- **`apps/worker`** — Long-running Node process for the Telegram approval bot. Cannot run on Vercel (needs persistent connection). Deployed to Railway via the Dockerfile + `railway.toml` in `apps/worker/`.

The web app does not own the Telegram bot. The worker does not serve HTTP. They communicate through the database (Postgres).

### Database story

- **Local dev:** Postgres 16 in Docker (`docker-compose.yml` at repo root). Hardcoded creds `copilot:copilot@localhost:5432/treasury` — these are fine for local; never put them in any deployed env.
- **Staging/prod:** Neon. Connection string lives in each app's `.env`.
- **ORM:** Drizzle. The schema lives in `packages/db/src/schema/index.ts` and is the single source of truth — `drizzle.config.ts` reads from there. Migrations are generated with `pnpm db:generate` and live in `packages/db/drizzle/`.

## Tooling notes worth knowing

### Turborepo pipeline

`turbo.json` uses a **transit task** pattern (`dependsOn: ["^transit"]`) for `lint`, `typecheck`, and `test`. This means those tasks run in parallel across packages but still invalidate cache when a dependency's source changes. Don't replace this with `^lint`/`^typecheck` — that would force sequential execution.

`build` outputs are `dist/**` and `.next/**` (excluding `.next/cache/**`). `typecheck` outputs `**/*.tsbuildinfo` because `tsc --noEmit` with `incremental: true` still writes those files.

### TypeScript config (gotcha to remember)

`packages/tsconfig/base.json` and `node.json` deliberately **do not** set `rootDir` or `outDir`. Those keys resolve relative to the config file that defines them, not relative to each consumer that extends them — so setting them in the shared config breaks every package. Each app/package that needs emit (only the worker via tsup) sets its own.

### Worker bundling

The worker is bundled with `tsup` using `noExternal: [/^@tc\//]`, which inlines all `@tc/*` workspace packages into a single `dist/index.js`. This is why the Dockerfile can use `pnpm deploy --filter=@tc/worker --prod /prod/worker` and copy a tiny `node_modules` — the workspace deps are already in the bundle.

### Web app and workspace packages

`apps/web/next.config.ts` declares all `@tc/*` packages in `transpilePackages`. Without that, Next.js's bundler skips ESM transforms for them and the build fails at first import.

### Lint + format

Biome only. **Do not add ESLint or Prettier.** Run `pnpm exec biome check --write .` to fix formatting issues; CI calls `pnpm lint` (which is `biome check`).

## What's intentionally not in this scaffold

These are first-feature work, not setup. When asked to "add X", check this list — if it's here, the answer is "yes, that's phase-1 work, not a config tweak":

- Auth (Privy / Turnkey)
- Solana RPC client and protocol SDKs (Kamino, Drift, Marginfi) — `packages/protocols` is stubs only
- Telegram bot client (grammy) in `apps/worker/src/bot.ts`
- Signer implementation (the `@tc/signer.executeApproved` interface exists; no provider yet)
- A `policies` table — phase-1 rules live in `packages/policy/src/index.ts` (`DEFAULT_POLICY`)
- CI workflows (`.github/workflows/`)
- Vercel project and Railway service configuration

## Deployment (when you're ready)

- **Web → Vercel.** This is a monorepo with a non-root project, so always link with `vercel link --repo` from the repo root, then deploy from `apps/web` or set the project root in the Vercel dashboard.
- **Worker → Railway.** `apps/worker/railway.toml` points Railway at the Dockerfile. Connect the repo and Railway will auto-detect.
