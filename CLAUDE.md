# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

Treasury Copilot is a chat-first AI agent that manages a startup or DAO's USDC across Solana yield venues (Kamino, Save, Drift Earn, Marginfi) under hard policy guardrails, with human-in-the-loop approval for moves above a threshold.

Venue coverage today: deposit + withdraw are wired end-to-end on **Kamino** (Main Market, USDC reserve) and **Save** (Main Pool, USDC reserve). **Rebalance** is wired as a two-tx flow (withdraw fromVenue → deposit toVenue) over those two venues, with crash recovery between legs. Drift / Marginfi remain deferred to step 2E and are explicitly excluded from `DEFAULT_POLICY.allowedVenues` until their builders land.

Read tools: the chat agent has a `getTreasurySnapshot` tool returning wallet USDC balance + per-venue position + supply APY for kamino and save. The chat route reads the default treasury from `TREASURY_PUBKEY_BASE58`.

Phase-1 markers: look for `// TODO(2E):` and similar pointers for work that's intentionally deferred.

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

### M2 PR 1 upgrade flow (one-time)

After pulling PR 1, every existing checkout needs:

```bash
pnpm db:migrate         # applies 0006 — adds users/treasuries/treasury_memberships + nullable treasury_id columns
pnpm db:seed-m2         # inserts seed treasury, backfills, applies the M2 structural flips
# copy the printed SEED_TREASURY_ID=<uuid> into BOTH apps/web/.env.local AND apps/worker/.env
```

The seed script auto-loads `apps/web/.env.local` and `apps/worker/.env` (already-set shell vars take precedence), so no `set -a; source …` is needed. It is idempotent — safe to re-run. Why no Migration B SQL in the journal: drizzle-orm's migrator wraps all pending migrations in a single transaction, so a NOT NULL flip on `proposed_actions.treasury_id` would roll Migration A back atomically when M1 rows still exist. Inlining the flips into the seed script (after backfill) sidesteps that.

### M2 PR 2 env additions

PR 2 adds `SIGNER_BACKEND` (mirrors the worker) and three optional `TURNKEY_PARENT_*` vars to web env, plus `SEED_TREASURY_ID` to worker env:

```bash
# apps/web/.env.local — required when SIGNER_BACKEND=turnkey
SIGNER_BACKEND=local            # or turnkey
TURNKEY_PARENT_ORG_ID=…         # parent org UUID (only for turnkey mode)
TURNKEY_PARENT_API_PUBLIC_KEY=… # P-256 hex (66 chars; leading 0x tolerated)
TURNKEY_PARENT_API_PRIVATE_KEY=… # P-256 hex (64 chars)

# apps/worker/.env — required for the PR 2 transition guard
SEED_TREASURY_ID=…              # same UUID as web; printed by db:seed-m2
```

The web env enforces the cross-field rule "all three TURNKEY_PARENT_* are required when SIGNER_BACKEND=turnkey" via a Zod refinement at module load. PR 3 removes `SEED_TREASURY_ID` from worker env; PR 4 removes it from web env.

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

### Signer backends

Two pluggable backends inside `@tc/signer`, picked at runtime via `SIGNER_BACKEND`:

- `local` — reads a Solana CLI keypair off disk (`packages/signer/src/wallet.ts`). Dev/tests only.
- `turnkey` — delegates signing to Turnkey's HSM-backed API (`packages/signer/src/turnkey.ts`). Staging and prod.

Both implement an internal `TreasurySigner` interface (`packages/signer/src/types.ts`): `publicKey` + `signSerializedMessage(bytes)`. The exported `Signer.executeApproved` (the trust boundary) is unchanged — only the in-process keypair gets swapped for an HSM call. Don't import `@turnkey/sdk-server` from anywhere else; that would bypass the abstraction.

### Auth + settings

The web app gates `/chat`, `/settings`, and `/api/me/bootstrap` / `/api/treasury/*` / `/api/auth/logout` behind Privy login. `apps/web/src/middleware.ts` does a soft cookie-presence check; strict JWT verification (`PrivyClient.verifyAuthToken`) lives in route handlers and the chat / settings server pages via `verifyBearer` / `privy.verifyAuthToken` from `apps/web/src/lib/privy.ts`. The chat client sends the access token as `Authorization: Bearer <jwt>` via the function-form `headers` on `DefaultChatTransport`, which the SDK calls per-request so token rotation is transparent. The user's stable Privy DID is recorded as `proposed_by` on each action.

### Multi-tenancy + bootstrap

`policies` is now keyed per `treasury_id` (the M1 singleton CHECK was dropped in M2 PR 1). Each Privy user gets their own `users` row + their own treasury at first sign-in:

- **Active treasury cookie.** `tc_active_treasury` (HttpOnly, Secure, SameSite=Lax, Path=/) carries the user's selection across requests. Every gated route re-validates membership via `resolveActiveTreasury` (`apps/web/src/lib/active-treasury.ts`) — present-but-invalid cookies fall back to the user's first remaining membership and re-set the cookie; users with zero memberships get redirected to `/` for onboarding. The constant lives in `apps/web/src/lib/active-treasury-cookie.ts` so middleware (Edge runtime) can reference it without dragging in DB code.
- **Bootstrap** (`POST /api/me/bootstrap`). Three-stage flow under a session-scoped `pg_advisory_lock(hashtext(privyDid))` on a reserved postgres-js connection. Stage 1 (own tx) — `bootstrapUserCore` upsert + post-lock membership count; if memberships > 0, short-circuit with `created: false`. Stage 2 (no tx, lock still held) — `provisionTreasury` from `@tc/turnkey-admin` mints a per-user Turnkey sub-org + Solana wallet (skipped in `local` mode, where users attach to the seed treasury). Stage 3 (own tx) — `createTreasury` + `addMembership('owner')` + `audit_logs` row (`treasury_created` in turnkey mode, `membership_added` in local mode). The session lock survives the Turnkey API call so two concurrent bootstraps from the same DID serialize cleanly — exactly one Turnkey call, exactly one treasury row. **Don't take the lock with `pg_advisory_xact_lock`**; the existing tx-scoped lock inside `bootstrapUser` only serializes the upsert and would let stages 2+3 race. That's why the route calls `bootstrapUserCore` directly.
- **Owner-only RBAC.** `treasury_memberships.role` CHECK is `'owner'` only in M2; M3 lifts the constraint when invitations land. Every gated route still enforces `role === 'owner'` to keep PR-3+ role expansion from having to revisit each route.
- **Body-vs-cookie 409 multi-tab safety.** Chat and policy PATCH requests carry `treasuryId` in the body; mismatch with the resolved active treasury returns 409 `active_treasury_changed`, and the client force-reloads to re-render against the new id. `no_active_treasury` 409 (mid-bootstrap or revoked-membership) sends the client to `/`.
- **Logout cookie clear.** `POST /api/auth/logout` clears `tc_active_treasury` so user A's selection doesn't leak to user B on the same browser. Safe to call unauthenticated because the cookie is `SameSite=Lax`. Bearer-auth on every other new route is CSRF-immune by virtue of using a header rather than a cookie.

#### M2 PR 2 transition state

The web app is fully multi-tenant; the worker still routes all execution through the seed signer. A temporary guard in `apps/worker/src/executor.ts` (search `TODO(2-PR3)`) fail-fasts any action whose `treasury_id` isn't `SEED_TREASURY_ID` with reason `'signer not yet wired for treasury'`. PR 3 deletes this guard the same hour the per-treasury signer factory ships.

**Stage-3 bootstrap failure (operator reconcile).** If stage 3's tx throws after Turnkey already returned a sub-org (turnkey mode), the route 500s and logs `orphaned subOrgId=…`. Operator drops the sub-org via the Turnkey console, user retries bootstrap. With the session lock in place this is the *only* orphan path; M3 adds an automatic reconciler.

Policy lookup remains `getPolicy(db, treasuryId)` (`packages/db/src/queries/policies.ts`); falls back to `DEFAULT_POLICY` (still in `@tc/policy`) when the row is missing. Edits land via `PATCH /api/policy` and are atomically logged in `audit_logs` with kind `'policy_updated'` (`audit_logs.kind` is plain text, not an enum — new kinds are string literals at the call site).

### AI provider abstraction

Two pluggable backends — Anthropic Claude and OpenAI. Picked at runtime via `MODEL_PROVIDER`. Both plug in through a single switch in `apps/web/src/lib/ai/model.ts`. **Don't import `@ai-sdk/anthropic` or `@ai-sdk/openai` from anywhere else** — that breaks the swap. The trust boundary is unchanged: whichever model proposes, `policy.evaluate()` decides.

The orchestration helper `proposeAction(db, action, ctx)` lives in `@tc/agent-tools/src/propose.ts` and wires `sumAutoApprovedSince → evaluate → insertProposedAction` in one call. Vercel AI SDK tool definitions in the same package wrap it. The chat route (`apps/web/src/app/api/chat/route.ts`) is a thin shim around `streamText({ tools, messages })`.

### Workspace dependency direction (no cycles by construction)

```
apps/web      → env, types, db, policy, agent-tools, protocols, turnkey-admin
apps/worker   → env, types, db, policy, signer
agent-tools   → types, policy, signer, protocols, db
signer        → types, policy, protocols
turnkey-admin → (leaf)            ← web-only; never imported from apps/worker
policy        → types
protocols     → types
db            → types, policy
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

- Per-treasury signer factory in the worker. PR 2 ships per-user Turnkey sub-orgs but the worker still signs through the seed wallet (with the `TODO(2-PR3)` guard in `executor.ts` fail-fasting non-seed actions). PR 3 wires an LRU per-treasury signer and removes the guard; PR 3 also drops the chat-id allowlist in `bot.ts` and adds per-treasury Telegram routing + `/api/treasury/telegram-config`.
- Drop `TREASURY_PUBKEY_BASE58` from web env, `SEED_TREASURY_ID` from web env, legacy `TELEGRAM_*` from worker — **PR 4**, after PR 3 lands.
- Multi-user-per-treasury, invitations, role expansion beyond `owner`, treasury rename / delete UX, Privy webhook for user-deleted lifecycle, automatic reconciler for stage-3 bootstrap failure, bootstrap rate limiting (Upstash/Redis-backed) — **M3**.
- Protocol SDK coverage in `packages/protocols`: Kamino and Save are wired end-to-end (deposit + withdraw); Drift and Marginfi builders are still stubs
- Telegram bot client (grammy) in `apps/worker/src/bot.ts`
- CI workflows (`.github/workflows/`)
- Vercel project and Railway service configuration

## Deployment (when you're ready)

- **Web → Vercel.** This is a monorepo with a non-root project, so always link with `vercel link --repo` from the repo root, then deploy from `apps/web` or set the project root in the Vercel dashboard.
- **Worker → Railway.** `apps/worker/railway.toml` points Railway at the Dockerfile. Connect the repo and Railway will auto-detect.
