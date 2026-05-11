# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

Treasury Copilot is a chat-first AI agent that manages a startup or DAO's USDC across Solana yield venues (Kamino, Save, Drift Earn, Marginfi) under hard policy guardrails, with human-in-the-loop approval for moves above a threshold.

Venue coverage today: deposit + withdraw are wired end-to-end on **Kamino** (Main Market, USDC reserve) and **Save** (Main Pool, USDC reserve). **Rebalance** is wired as a two-tx flow (withdraw fromVenue → deposit toVenue) over those two venues, with crash recovery between legs. Drift / Marginfi remain deferred to step 2E and are explicitly excluded from `DEFAULT_POLICY.allowedVenues` until their builders land.

Read tools: the chat agent has a `getTreasurySnapshot` tool returning wallet USDC balance + per-venue position + supply APY for kamino and save. The chat route uses the active treasury's `wallet_address` (resolved from the `tc_active_treasury` cookie).

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
```

PR 4 (the current state) replaced the previous `SEED_TREASURY_ID` env back-reference with a runtime lookup on `signer_backend = 'local'` in the bootstrap path, so no copy-paste is required after seeding. The script still prints the seed wallet address — fund that.

The seed script auto-loads `apps/web/.env.local` and `apps/worker/.env` (already-set shell vars take precedence), so no `set -a; source …` is needed. It is idempotent — safe to re-run. Why no Migration B SQL in the journal: drizzle-orm's migrator wraps all pending migrations in a single transaction, so a NOT NULL flip on `proposed_actions.treasury_id` would roll Migration A back atomically when M1 rows still exist. Inlining the flips into the seed script (after backfill) sidesteps that.

### M2 PR 2 env additions

PR 2 adds `SIGNER_BACKEND` (mirrors the worker) and three optional `TURNKEY_PARENT_*` vars to web env:

```bash
# apps/web/.env.local — required when SIGNER_BACKEND=turnkey
SIGNER_BACKEND=local            # or turnkey
TURNKEY_PARENT_ORG_ID=…         # parent org UUID (only for turnkey mode)
TURNKEY_PARENT_API_PUBLIC_KEY=… # P-256 hex (66 chars; leading 0x tolerated)
TURNKEY_PARENT_API_PRIVATE_KEY=… # P-256 hex (64 chars)
```

The web env enforces the cross-field rule "all three TURNKEY_PARENT_* are required when SIGNER_BACKEND=turnkey" via a Zod refinement at module load.

### M2 PR 3 upgrade flow (one-time)

PR 3 ships the per-treasury signer factory and per-treasury Telegram routing. After pulling:

```bash
pnpm db:migrate         # applies 0007 — adds proposed_actions.telegram_chat_id snapshot column

# apps/worker/.env — REMOVE these (now unreferenced; the worker won't boot if they're set
# under a strict env schema that flags unknown keys, and they actively misdirect operators):
#   SEED_TREASURY_ID                (PR 2 guard is gone)
#   TELEGRAM_APPROVAL_CHAT_ID       (replaced by per-treasury treasuries.telegram_chat_id)
#   APPROVER_TELEGRAM_IDS           (replaced by treasuries.telegram_approver_ids)
#   TURNKEY_ORGANIZATION_ID         (per-treasury — read from treasuries.turnkey_sub_org_id)
#   TURNKEY_SIGN_WITH               (per-treasury — read from treasuries.wallet_address)

# Set per-treasury chat id + approver ids via /settings → Telegram before
# require-approval actions can post. Until configured, those rows park in
# pending and are filtered out of the poller's queue at the SQL level.
```

Pre-PR-3 in-flight rows (`status=executing` at deploy time) execute correctly under the per-treasury factory but their original Telegram cards won't be edited because `proposed_actions.telegram_chat_id` is null on those rows. DB and on-chain outcomes are unaffected.

### M2 PR 4 — web env cleanup

PR 4 dropped `TREASURY_PUBKEY_BASE58` (already dead — chat reads `resolved.treasury.walletAddress`) and `SEED_TREASURY_ID` (replaced by runtime lookup on `signer_backend = 'local'`) from the web env. After pulling, you can delete both from `apps/web/.env.local` — the seed script still reads `TREASURY_PUBKEY_BASE58` from `process.env` directly to mint the seed row, so keep it set there until you've run `pnpm db:seed-m2` once.

### M2 PR 5 — brand identity + onboarding wizard

PR 5 ships a real brand (palette + typography in `brand.md` at the repo root) and a multi-step onboarding wizard at `/onboarding`. After pulling:

```bash
pnpm install                # qrcode-svg + @types/qrcode-svg added
pnpm db:migrate             # applies 0008 — adds users.onboarded_at + users.onboarding_step
                            # The migration is safe to run inline (UPDATE inside the
                            # migrator's wrapping transaction) because both columns
                            # stay nullable. PR 1's NOT NULL flips needed a separate
                            # seed-script stage; this trap doesn't apply here.
```

The 0008 migration backfills `onboarded_at = NOW()` on every existing user — pre-PR-5 accounts skip the wizard entirely.

**Routing changes.** `/` is now a server component (was client + auto-bootstrap). Auto-bootstrap on sign-in is removed; the wizard's step 1 "Get started" CTA owns the `/api/me/bootstrap` call now. `bootstrapAuthAndTreasury` (`apps/web/src/lib/server-page-auth.ts:25`) redirects `onboardingRequired` to `/onboarding` (was `/`) — fixes a redirect loop the previous wiring would have introduced. `/onboarding` uses a new `requireAuthOnly` helper that returns `userId` without resolving treasury.

**Server-side step derivation.** Single source of truth is `users.onboarding_step` (smallint nullable, 1-5) — no inference from `policies` / `telegram` / RPC balance. `users.onboarded_at` non-null gates the user out of `/onboarding` and into `/chat`. Each "Continue" / "Skip" CTA POSTs `/api/me/onboarding-step` BEFORE advancing locally so refresh / cross-tab resume lands at the right step. POST is best-effort — failure surfaces a toast and the wizard advances anyway. The final "Open chat" CTA awaits `/api/me/onboarded` (sets `onboarded_at = NOW()`, writes `audit_logs.kind = 'user_onboarded'`) — failure shows inline retry, not a silent redirect (a stale `onboarded_at = null` would just bounce the user right back).

**Funding-step balance polling.** `GET /api/treasury/balance?treasuryId=…` returns `{ amountUsdc: string }`. Module-scoped Solana `Connection` (mirrors `apps/web/src/app/api/chat/route.ts:21`) and a per-treasury 3s TTL `Map` cache so concurrent tabs / repeated polls coalesce to one RPC per window. Client poll is 5s base, 30s after a 429/5xx, 60s after 3 consecutive errors. Effect cleanup on unmount + step change.

**`brand.md`** at the repo root documents the **Inference** palette (cyan, minimal · technical) + **Manrope + JetBrains Mono** typography. `apps/web/src/app/globals.css.bak` keeps the pre-PR-5 stock shadcn neutrals if a rollback is needed. Future `frontend-design-guidelines` runs read `brand.md` automatically.

### M3 PR 1 — proactive intelligence foundation

PR 1 of M3 ships the cross-cutting plumbing the rest of M3 (yield-drift alerts, idle-capital nudges, weekly digest, anomaly checks) all depend on. No user-visible feature on its own. After pulling:

```bash
pnpm install                # adds @solana/web3.js + @tc/protocols to apps/worker
pnpm db:migrate             # applies 0009 — adds notifications + apy_snapshots tables.
                            # No backfill needed (both tables start empty).
```

Two optional new worker env vars; defaults are sensible:

```bash
# apps/worker/.env — both optional, defaults shown
APY_SNAPSHOT_INTERVAL_MS=3600000   # 1h
APY_SNAPSHOT_JITTER_MS=300000      # ±5min
```

**New tables (migration 0009).**
- `notifications` — outbound non-approval messages (alerts, digests, anomaly callouts). Status enum `queued | sent | failed | skipped`. Dedupe is enforced at the query layer via `findRecentByDedupeKey` with a time window — the (treasury_id, dedupe_key, created_at) index is intentionally **non-unique** because the cooldown contract is time-bounded (e.g. yield_drift can re-fire after 24h). A strict unique constraint would break re-sends.
- `apy_snapshots` — cross-treasury append-only APY time series. Single shared table keyed by `(venue, captured_at)`. Hourly collector (`apps/worker/src/jobs/collect-apy-snapshots.ts`) populates one row per wired venue (`kamino`, `save`, `jupiter`) per tick. **This is the source of truth for "current APY" across M3.** Downstream jobs MUST read from `apy_snapshots` (via `getLatestApy` / `getAvgApy` / `getApySeries`), not call live SDK readers, to avoid O(N×venues) RPC fan-out per check.

**New worker modules.**
- `apps/worker/src/notifications.ts` — `sendTelegramNotification({ treasuryId, kind, body, dedupeKey?, dedupeWindowMs? })`. End-to-end dispatcher: dedupe check → enqueue row → resolve treasury chat → post via `bot.sendPlainMessage` → mark sent/failed/skipped. Every outcome leaves exactly one `notifications` row behind. Failures are swallowed (no throw) so a periodic job looping over treasuries doesn't abort on one bad row.
- `apps/worker/src/scheduled-jobs.ts` — generic periodic-job runner. Pass `{ name, intervalMs, jitterMs, runImmediately?, run }`; the dispatcher manages timers, in-flight guards (no overlapping ticks), jitter, and crash isolation (thrown jobs log + continue, never take the worker down). Mirrors `poller.ts:60-80` and `executor.ts:194` patterns.
- `apps/worker/src/jobs/` — per-job entry points. PR 1 ships `collect-apy-snapshots.ts`.
- `apps/worker/src/bot.ts` exposes `sendPlainMessage(chatId, htmlBody)` — non-approval Telegram message helper. Reused by the dispatcher and (in later M3 PRs) for digest / alert bodies.

### M3 PR 2 — yield-drift alerts

PR 2 ships the first user-visible M3 feature: per-treasury yield-drift alerts driven by a periodic check job. After pulling:

```bash
pnpm install                # adds decimal.js to apps/worker
pnpm db:migrate             # applies 0010 — adds alert_subscriptions + seeds
                            # one row per existing treasury × each kind, all
                            # disabled, with the yield_drift default config.
```

Two optional new worker env vars; defaults match the plan:

```bash
# apps/worker/.env — both optional, defaults shown
YIELD_DRIFT_CHECK_INTERVAL_MS=21600000  # 6h
YIELD_DRIFT_CHECK_JITTER_MS=1800000     # ±30min
```

**New table (migration 0010).**
- `alert_subscriptions` — one row per `(treasury_id, kind)`. `kind` is CHECK-constrained to `yield_drift | idle_capital | anomaly | concentration | protocol_health`; later PRs widen the check as they wire each kind. `enabled` defaults to false (nothing surprises users). `config` is free-form jsonb so each kind owns its own schema. The 0010 migration backfills 5 rows per existing treasury — adding a new kind later only widens the CHECK + does an `UPDATE` on existing rows' `config`. New treasuries are lazily seeded by `ensureSubscriptionsForTreasury`, called on each `/settings` render.

**New worker job.**
- `apps/worker/src/jobs/check-yield-drift.ts` — every 6h (±30min jitter). For each treasury subscribed to `yield_drift`, reads live positions for the venues in `policy.allowedVenues`, then compares the held-venue 24h-avg APY against every other allowed venue's 24h-avg using `getAvgApy` (`apy_snapshots` is the source of truth — no live SDK fan-out for APY). Two gates fire: **sustained** (`avg(alt) − avg(held)` ≥ `minDriftBps`) AND **currently active** (`latest(alt)` still ≥ `latest(held)` — prevents alerts on reversed drifts). If both pass AND projected monthly opportunity ≥ `minOpportunityUsdcPerMonth`, dispatches a notification with dedupeKey `yield_drift:<heldVenue>:<altVenue>` and a `cooldownHours`-wide window. `runImmediately: false` so the first tick lands after the APY collector has populated history.

**New web routes + UI.**
- `/api/alerts` (GET, PATCH). PATCH body is a Zod-discriminated union on `kind`: yield_drift carries a full thresholds schema; the other kinds accept `{}` config + toggle only until their PRs land. Body-vs-cookie 409 guard, owner-only RBAC, atomic audit_logs row (`kind = 'alert_subscription_updated'`) — same shape as `policy_updated`.
- `/settings → Alerts` section. `AlertSubscriptionsForm` renders all 5 kinds; yield_drift gets an inline threshold editor when enabled; the other 4 carry a "Coming soon" badge and toggle-only surface. Dual-state baseline/dirty pattern mirrors `PolicyForm` and `TelegramConfigForm`. Saving fires one PATCH per dirty kind so a partial failure leaves the rest intact.

**New AI tool.**
- `getAlertConfig()` — read-only listing of the user's subscriptions for chat queries ("are my alerts on?", "what's my drift threshold?"). No write tool by design; the AI cannot toggle alerts. Users edit through `/settings → Alerts`.

**Smoke testing.**
- `pnpm --filter @tc/worker smoke:yield-drift` runs one check pass against the current DB + RPC. Seed `apy_snapshots` with a drift scenario (see the script's header comment for SQL), enable `yield_drift` in `/settings → Alerts`, ensure your treasury has a non-zero position in the held venue, then run. Expect one Telegram message + one `notifications` row of `kind='yield_drift'`. Re-run within the cooldown window → dedupe skip (same kind, status='skipped').

### M3 PR 3 — idle-capital nudges

PR 3 ships the second user-visible M3 alert: notifies the user when a meaningful USDC balance has sat in the treasury wallet (undeployed) past the dwell threshold. After pulling:

```bash
pnpm db:migrate             # applies 0011 — backfills idle_capital row's
                            # empty config with the M3-3 defaults. Idempotent.
```

Two optional new worker env vars; defaults match the plan:

```bash
# apps/worker/.env — both optional, defaults shown
IDLE_CAPITAL_CHECK_INTERVAL_MS=86400000  # 24h
IDLE_CAPITAL_CHECK_JITTER_MS=3600000     # ±1h
```

**New DB query.**
- `getLastWalletOutflowAt(db, treasuryId)` (in `packages/db/src/queries/actions.ts`) — most recent `executed` action where `payload->>'kind' IN ('deposit', 'transfer', 'rebalance')`. Used by the dwell check. Reads the JSON path because `kind` lives in `payload`, not a column. `transfer` is in the IN-list pre-emptively so M4-1 doesn't need to touch this query.

**New worker job.**
- `apps/worker/src/jobs/check-idle-capital.ts` — daily (24h ±1h jitter). Per enabled treasury:
  1. Read wallet USDC via `getWalletUsdcBalance` (same call `proposeAction` uses).
  2. If balance < `minIdleUsdc` → bail.
  3. Compute dwell = `now − MAX(treasury.created_at, lastOutflowAt)`. If < `minDwellHours` → bail. The `treasury.created_at` floor handles brand-new treasuries that have no actions yet (otherwise they'd fire immediately on first funding, which is the opposite of "idle").
  4. Pick the highest-APY venue across `policy.allowedVenues` from `apy_snapshots` (no live SDK fan-out).
  5. Compute monthly opportunity cost = `idle × apy × 30/365`.
  6. Dispatch with dedupeKey `idle_capital:<walletAddress>` and `cooldownHours`-wide window. `runImmediately: false`.

**Telegram body example.**
```text
Idle USDC
~$45,000 has sat in your wallet for 4 days.
At Kamino's current 5.40% APY that's ~$202/mo of yield foregone.

Reply in chat: deposit 45000 to kamino
```

**Web surface.**
- `/settings → Alerts` — `idle_capital` row now shows an inline editor (3 fields: min idle USDC, min dwell hours, cooldown hours) when toggled on. "Coming soon" badge removed.
- `/api/alerts` PATCH — `idle_capital` joins the discriminated union with its own Zod schema (`idleCapitalConfigSchema`). The catch-all for unwired kinds shrinks to 3 (anomaly, concentration, protocol_health).

**Smoke testing.**
- `pnpm --filter @tc/worker smoke:idle-capital` runs one pass. The script's header comment documents the SQL you'd run to backdate `executed_at` on the most recent outflow for fast iteration. For dev, lower `minIdleUsdc` to a value below your actual wallet balance (real dev wallets rarely hold $5k).

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

Both implement an internal `TreasurySigner` interface (`packages/signer/src/types.ts`): `publicKey` + `signSerializedMessage(bytes)`. The exported `Signer.executeApproved` (the trust boundary) is unchanged — only the in-process keypair gets swapped for an HSM call. Don't import `@turnkey/sdk-server` from anywhere else for *signing* — that would bypass the abstraction.

**Documented exception:** `@tc/turnkey-admin` also depends on `@turnkey/sdk-server`, but for *org/wallet provisioning* (CreateSubOrganization), not signing. Provisioning is a distinct concern from `TreasurySigner` and is web-only (never imported by the worker). New code that needs to *sign* must go through `@tc/signer`; new admin-API calls (sub-org lifecycle, wallet creation) belong in `@tc/turnkey-admin`.

### Auth + settings

The web app gates `/chat`, `/settings`, and `/api/me/bootstrap` / `/api/treasury/*` / `/api/auth/logout` behind Privy login. `apps/web/src/middleware.ts` does a soft cookie-presence check; strict JWT verification (`PrivyClient.verifyAuthToken`) lives in route handlers and the chat / settings server pages via `verifyBearer` / `privy.verifyAuthToken` from `apps/web/src/lib/privy.ts`. The chat client sends the access token as `Authorization: Bearer <jwt>` via the function-form `headers` on `DefaultChatTransport`, which the SDK calls per-request so token rotation is transparent. The user's stable Privy DID is recorded as `proposed_by` on each action.

### Multi-tenancy + bootstrap

`policies` is now keyed per `treasury_id` (the M1 singleton CHECK was dropped in M2 PR 1). Each Privy user gets their own `users` row + their own treasury at first sign-in:

- **Active treasury cookie.** `tc_active_treasury` (HttpOnly, Secure, SameSite=Lax, Path=/) carries the user's selection across requests. Every gated route re-validates membership via `resolveActiveTreasury` (`apps/web/src/lib/active-treasury.ts`) — present-but-invalid cookies fall back to the user's first remaining membership and re-set the cookie; users with zero memberships get redirected to `/` for onboarding. The constant lives in `apps/web/src/lib/active-treasury-cookie.ts` so middleware (Edge runtime) can reference it without dragging in DB code.
- **Bootstrap** (`POST /api/me/bootstrap`). Three-stage flow under a session-scoped `pg_advisory_lock(hashtext(privyDid))` on a reserved postgres-js connection. Stage 1 (own tx) — `bootstrapUserCore` upsert + post-lock membership count; if memberships > 0, short-circuit with `created: false`. Stage 2 (no tx, lock still held) — `provisionTreasury` from `@tc/turnkey-admin` mints a per-user Turnkey sub-org + Solana wallet (skipped in `local` mode, where users attach to the seed treasury). Stage 3 (own tx) — `createTreasury` + `addMembership('owner')` + `audit_logs` row (`treasury_created` in turnkey mode, `membership_added` in local mode). The session lock survives the Turnkey API call so two concurrent bootstraps from the same DID serialize cleanly — exactly one Turnkey call, exactly one treasury row. **Don't take the lock with `pg_advisory_xact_lock`**; the existing tx-scoped lock inside `bootstrapUser` only serializes the upsert and would let stages 2+3 race. That's why the route calls `bootstrapUserCore` directly.
- **Owner-only RBAC.** `treasury_memberships.role` CHECK is `'owner'` only in M2; M3 lifts the constraint when invitations land. Every gated route still enforces `role === 'owner'` to keep PR-3+ role expansion from having to revisit each route.
- **Body-vs-cookie 409 multi-tab safety.** Chat and policy PATCH requests carry `treasuryId` in the body; mismatch with the resolved active treasury returns 409 `active_treasury_changed`, and the client force-reloads to re-render against the new id. `no_active_treasury` 409 (mid-bootstrap or revoked-membership) sends the client to `/`.
- **Logout cookie clear.** `POST /api/auth/logout` clears `tc_active_treasury` so user A's selection doesn't leak to user B on the same browser. Safe to call unauthenticated because the cookie is `SameSite=Lax`. Bearer-auth on every other new route is CSRF-immune by virtue of using a header rather than a cookie.

#### M2 PR 3 state — per-treasury signer + Telegram routing

The worker is now fully multi-tenant. `apps/worker/src/signer-factory.ts` exposes `createSignerFactory({ db, baseConfig })` returning an LRU keyed on `treasuryId` (default 100 entries; concurrent calls for the same id dedupe). Each cache miss reads the treasuries row via `getTreasuryForRouting`, validates it (turnkey rows must have `turnkey_sub_org_id`; local rows' keypair public key must equal `wallet_address`), and calls `createSigner(perTreasuryConfig)` to build a fresh high-level `Signer`. The factory throws structured errors — `TreasuryNotFound`, `TurnkeyTreasuryMalformed`, `LocalKeypairMismatch`, `WorkerBackendMismatch` — which the executor catches via `resolveSignerOrFail`, terminally failing the row with a clear reason. Both `tick()` (the main loop) and `recoverInFlight()` (the boot recovery sweep) route through the factory.

**Stage-3 bootstrap failure (operator reconcile).** If stage 3's tx throws after Turnkey already returned a sub-org (turnkey mode), the route 500s and logs `orphaned subOrgId=…`. Operator drops the sub-org via the Turnkey console, user retries bootstrap. With the session lock in place this is the *only* orphan path; M3 adds an automatic reconciler.

Policy lookup remains `getPolicy(db, treasuryId)` (`packages/db/src/queries/policies.ts`); falls back to `DEFAULT_POLICY` (still in `@tc/policy`) when the row is missing. Edits land via `PATCH /api/policy` and are atomically logged in `audit_logs` with kind `'policy_updated'` (`audit_logs.kind` is plain text, not an enum — new kinds are string literals at the call site).

#### Per-treasury Telegram routing

`treasuries.telegram_chat_id` and `treasuries.telegram_approver_ids` carry the per-treasury Telegram config. The bot reads them per-call via `getTreasuryForRouting`:

- `postApprovalCard(row)` returns `{ messageId, chatId } | null`. Null when the treasury has no chat configured — `findPendingForTelegram` filters those rows at the SQL level (LEFT JOIN treasuries excluding null chat_id) so the poller doesn't loop on un-configured treasuries; an in-process `Set` in `bot.ts` warns once-per-boot if a row slips through (defense-in-depth against future race conditions).
- The poller then calls `setTelegramRouting(db, actionId, posted)` which writes BOTH `proposed_actions.telegram_message_id` AND `proposed_actions.telegram_chat_id` (snapshot) under a compare-and-set guard.
- The callback handler reads the action row first (`getActionById`), looks up the treasury config, and rejects clicks from users not in `telegram_approver_ids`. Only then does it call `recordApproval`.
- `editApprovalCardWithExecution` uses the *snapshotted* `row.telegramChatId`, NOT the latest treasury config — so an owner reconfiguring `telegram_chat_id` mid-flight doesn't break post-execution edits.

`PATCH /api/treasury/telegram-config` is the owner-only edit route; it's a thin shim over `updateTelegramConfig` in `packages/db/src/queries/treasuries.ts`, which writes the treasury row + an `audit_logs` row (`{ before, after }` payload) atomically. The route validates with the same Zod regexes the form mirrors client-side: numeric chat ids (group/user) or strict `@channel_username` (5-32 chars, letter-led, alphanumeric + `_`).

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

- Per-step deep links (`/onboarding/welcome`, `/onboarding/fund`, …) — single URL with state derivation chosen instead. Restart-onboarding affordance ("run me through the wizard again") deferred — **M3**.
- Multi-user-per-treasury, invitations, role expansion beyond `owner`, treasury rename / delete UX, Privy webhook for user-deleted lifecycle, automatic reconciler for stage-3 bootstrap failure, bootstrap rate limiting (Upstash/Redis-backed) — **M3**.
- Protocol SDK coverage in `packages/protocols`: Kamino and Save are wired end-to-end (deposit + withdraw); Drift and Marginfi builders are still stubs
- CI workflows (`.github/workflows/`)
- Vercel project and Railway service configuration

## Deployment (when you're ready)

- **Web → Vercel.** This is a monorepo with a non-root project, so always link with `vercel link --repo` from the repo root, then deploy from `apps/web` or set the project root in the Vercel dashboard.
- **Worker → Railway.** `apps/worker/railway.toml` points Railway at the Dockerfile. Connect the repo and Railway will auto-detect.
