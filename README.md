# Treasury Copilot

Chat-first AI agent that manages a startup or DAO's USDC across Solana yield venues under hard policy guardrails, with human-in-the-loop approval for moves above a configurable threshold.

---

## What it does

- **Chat interface** — ask in plain English: "deposit 10,000 USDC into Kamino", "rebalance from Save to Kamino", "send 500 USDC to Acme Corp", "what's my runway?"
- **Yield venues** — Kamino (Main Market) and Save (Main Pool) are wired end-to-end. Deposit, withdraw, and rebalance all execute on-chain.
- **Policy engine** — every action runs through a configurable guardrail layer before the signer sees it. Exceeding the auto-approve cap routes the action to Telegram for human approval.
- **Telegram approval bot** — above-threshold actions post an interactive card. Approvers click a button; the worker signs and submits within seconds.
- **Address book + transfer safety** — USDC transfers require the recipient to be in a per-treasury address book (default on). The AI agent cannot add entries — only the `/settings` UI can.
- **Proactive alerts** — yield-drift notifications (6h cadence), idle-capital nudges (24h cadence), coming: anomaly detection and weekly digests.
- **Transaction history** — paginated ledger at `/history` with kind/status filters and Solscan links.
- **Runway estimate** — `getRunway` chat tool computes months of runway from liquid USDC and average daily outflow.
- **Per-user treasuries** — in Turnkey mode, each user gets their own Turnkey sub-org and Solana wallet at first sign-in. Fully multi-tenant.

---

## Stack

| Layer | Technology |
|---|---|
| **Monorepo** | pnpm workspaces + Turborepo |
| **Web** | Next.js 15 (App Router), React 19, Tailwind v4, shadcn/ui |
| **AI** | Vercel AI SDK — Anthropic Claude or OpenAI (swap via `MODEL_PROVIDER`) |
| **Worker** | Node 22, long-running, deployed to Railway via Docker |
| **Auth** | Privy (email + wallet login) |
| **Signing** | `local` (keypair on disk, dev only) or `turnkey` (HSM-backed, production) |
| **DB** | Postgres via Drizzle ORM — local Docker, Neon in production |
| **Solana** | `@solana/web3.js` + Kamino SDK + Save (Solend) SDK |
| **Telegram** | grammy |
| **Lint / format** | Biome only (no ESLint, no Prettier) |
| **Testing** | Vitest |

---

## Repo layout

```
apps/
  web/             Next.js 15 — chat UI, settings, history, onboarding, API routes
  worker/          Long-running Telegram approval bot + on-chain executor (Railway)
packages/
  agent-tools      Vercel AI SDK tool definitions — proposeAction, proposeTransfer,
                   getTreasurySnapshot, getRunway, getAddressBook, getAlertConfig, …
  db               Drizzle schema + queries (proposed_actions, policies, treasuries,
                   users, address_book_entries, notifications, apy_snapshots, …)
  env              Shared Zod env-schema fragments
  policy           Policy guardrail engine — evaluate() returns allow | deny | requires_approval
  protocols        Solana protocol adapters: Kamino (deposit/withdraw), Save (deposit/withdraw),
                   USDC transfer (hand-rolled SPL primitives)
  signer           TreasurySigner interface + local and Turnkey backends
  turnkey-admin    Sub-org + wallet provisioning (web-only; never imported by worker)
  types            Shared domain types and ProposedAction discriminated union
  biome-config     Shared lint/format config
  tsconfig         Shared TypeScript configs
```

---

## Trust boundary

The product's security model is enforced at the type level through a one-way dependency chain:

```
agent-tools  →  policy  →  signer
   (proposes)    (decides)   (executes)
```

`@tc/signer.executeApproved()` accepts **only** `Extract<PolicyDecision, { kind: 'allow' }>`. The agent cannot construct an `allow` decision — only `@tc/policy` can. TypeScript enforces this at compile time. Don't bypass it.

---

## Quick start (local dev)

**Prerequisites:** Node 22, pnpm 9, Docker.

```bash
nvm use                                   # reads .nvmrc → 22.11.0
corepack enable && corepack prepare pnpm@9.15.0 --activate
git clone https://github.com/<your-org>/treasury-copilot.git
cd treasury-copilot
pnpm install
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env
docker compose up -d postgres             # local Postgres on :5432
pnpm db:migrate                           # applies all migrations
pnpm db:seed-m2                           # creates seed treasury (local mode)
pnpm dev                                  # web :3000 + worker concurrently
```

`apps/web` uses `@t3-oss/env-nextjs` with Zod validation — the build fails without a populated `.env.local`. Every required variable is in `.env.example` with a description. Set `SKIP_ENV_VALIDATION=1` only for CI image bakes, never in production.

---

## Common scripts

```bash
pnpm dev                  # turbo run dev — web + worker
pnpm build                # build all packages
pnpm typecheck            # tsc --noEmit across every workspace
pnpm lint                 # biome check across every workspace
pnpm format               # biome format --write
pnpm test                 # vitest run across every workspace
pnpm db:up                # docker compose up -d postgres
pnpm db:down              # stop local Postgres
pnpm db:generate          # drizzle-kit generate (after schema changes)
pnpm db:migrate           # drizzle-kit migrate
pnpm db:seed-m2           # insert seed treasury (local signer mode, idempotent)

# Single-package
pnpm --filter @tc/web dev
pnpm --filter @tc/policy test
pnpm --filter @tc/worker smoke:yield-drift
pnpm --filter @tc/worker smoke:idle-capital
```

---

## Workspace dependency direction

```
apps/web      → env, types, db, policy, agent-tools, protocols, turnkey-admin
apps/worker   → env, types, db, policy, signer
agent-tools   → types, policy, signer, protocols, db
signer        → types, policy, protocols
turnkey-admin → (leaf — web-only, never imported by worker)
policy        → types
protocols     → types
db            → types, policy
env, types    → (leaves)
```

Apps are sinks. `types` and `env` are leaves. All arrows flow downward. No cycles by construction.

---

## Signer modes

| Mode | `SIGNER_BACKEND` | Keys live | Multi-user | Use for |
|---|---|---|---|---|
| local | `local` | Disk (`./keys/treasury.json`) | No — single shared treasury | Dev, demos |
| Turnkey | `turnkey` | Turnkey HSM | Yes — per-user sub-org + wallet | Production |

In `local` mode, `pnpm db:seed-m2` creates a shared seed treasury. Every user who signs in attaches to it.

In `turnkey` mode, `POST /api/me/bootstrap` mints a Turnkey sub-org + Solana wallet for each new user behind a session-scoped advisory lock. Two concurrent sign-ins from the same DID serialize cleanly — exactly one Turnkey call, exactly one treasury row.

---

## Policy engine

Every proposed action runs through `policy.evaluate(action, context)` before touching the signer. The result is a discriminated union:

| Decision | Meaning |
|---|---|
| `allow` | amount ≤ auto-approve cap, within daily velocity, within venue allowlist |
| `deny` | violates a hard rule (unknown venue, exceeds per-action ceiling, recipient not in address book) |
| `requires_approval` | over the approval threshold — row parks as `pending`, Telegram card posted |

Policy is per-treasury. Edit at `/settings → Policy`. Audit log entry written atomically on every change.

---

## Address book + transfer safety gate

USDC transfers are denied by default unless the recipient is in the treasury's address book (`policies.require_address_book_for_transfers = true`). This is a prompt-injection guard: the AI agent has no write tool for the address book, so a coerced prompt cannot add a malicious recipient.

Pre-approved recipients bypass the Telegram approval card for transfers above the threshold. The 24h velocity cap and per-action ceiling still apply.

---

## Alerts

| Kind | Cadence | What triggers it |
|---|---|---|
| `yield_drift` | 6h ± 30min | Alt venue sustained ≥ N bps above held venue, projected opportunity ≥ $X/month |
| `idle_capital` | 24h ± 1h | Wallet USDC ≥ N and no outflow for ≥ H hours |
| `anomaly` | coming M3 | |
| `concentration` | coming M3 | |
| `protocol_health` | coming M3 | |

Configure at `/settings → Alerts`. Toggle per kind; yield_drift and idle_capital have threshold editors. Cooldown windows prevent duplicate fires.

---

## Deployment

**Two processes, separate hosts:**

```
Browser  →  Next.js (Vercel)  →  Postgres (Neon)  ←  Worker (Railway)
                                                         ↓
                                                   Solana mainnet
```

The web app cannot host a Telegram bot (Vercel functions die after seconds). The worker cannot serve HTTP cheaply. They communicate only through Postgres.

For a complete, step-by-step production deployment guide including Neon, Helius, Privy, Turnkey, and Railway setup, see **[`deployment.md`](./deployment.md)**.

For day-to-day usage and operator reference, see **[`docs/handbook.md`](./docs/handbook.md)**.

### Quick deployment summary

| Service | Platform | Notes |
|---|---|---|
| Web app | Vercel | Root directory: `apps/web`. Env vars required at build time. |
| Worker | Railway | Root directory: `/` (full monorepo context for Docker). `apps/worker/railway.toml` detected automatically. |
| Database | Neon | Use the **pooled** connection string for Vercel serverless. |
| Solana RPC | Helius (or Triton) | Public endpoint is rate-limited; unusable in production. |
| Auth | Privy | Allowed origins must include your Vercel prod URL. |
| Signing | Turnkey | HSM-backed, per-user wallets. Required for real funds. |

---

## Environment variables

### Web (`apps/web/.env.local`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string (pooled in production) |
| `SOLANA_RPC_URL` | Yes | Helius or Triton mainnet RPC URL |
| `MODEL_PROVIDER` | Yes | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` | If anthropic | `sk-ant-…` |
| `ANTHROPIC_MODEL` | If anthropic | e.g. `claude-sonnet-4-6` |
| `OPENAI_API_KEY` | If openai | `sk-…` |
| `OPENAI_MODEL` | If openai | e.g. `gpt-5.4-mini` |
| `PRIVY_APP_SECRET` | Yes | Server-only. Never expose to browser. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Yes | Public Privy app UUID |
| `NEXT_PUBLIC_APP_URL` | Yes | Production URL (e.g. `https://app.example.com`) |
| `SIGNER_BACKEND` | Yes | `local` or `turnkey` |
| `SEED_TREASURY_ID` | local only | UUID printed by `pnpm db:seed-m2` |
| `TURNKEY_PARENT_ORG_ID` | turnkey only | Root org UUID |
| `TURNKEY_PARENT_API_PUBLIC_KEY` | turnkey only | P-256 hex (66 chars) |
| `TURNKEY_PARENT_API_PRIVATE_KEY` | turnkey only | P-256 hex (64 chars) |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | Recommended | Bot username without `@` |

### Worker (`apps/worker/.env`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Same Neon connection string |
| `SOLANA_RPC_URL` | Yes | Same Helius URL |
| `TELEGRAM_BOT_TOKEN` | Yes | From `@BotFather` |
| `SIGNER_BACKEND` | Yes | `local` or `turnkey` |
| `SOLANA_KEYPAIR_PATH` | local only | Default: `./keys/treasury.json` |
| `TURNKEY_API_PUBLIC_KEY` | turnkey only | Same as `TURNKEY_PARENT_API_PUBLIC_KEY` |
| `TURNKEY_API_PRIVATE_KEY` | turnkey only | Same as `TURNKEY_PARENT_API_PRIVATE_KEY` |
| `NODE_ENV` | Yes | `production` |

---

## Database

Schema source of truth: `packages/db/src/schema/index.ts`. Migrations live in `packages/db/drizzle/`.

| Table | Purpose |
|---|---|
| `users` | Privy DID, onboarding state |
| `treasuries` | Wallet address, signer config, Telegram routing |
| `treasury_memberships` | User ↔ treasury RBAC (`owner` today) |
| `policies` | Per-treasury guardrails (caps, allowed venues, address-book gate) |
| `proposed_actions` | Every action ever proposed — source of truth for audit and executor |
| `address_book_entries` | Per-treasury recipient allowlist |
| `alert_subscriptions` | Per-treasury alert config and thresholds |
| `notifications` | Outbound non-approval messages (alerts, digests) |
| `apy_snapshots` | Hourly cross-venue APY time series — source of truth for alert math |
| `audit_logs` | Append-only event log for every state-changing operation |

Never run `drizzle-kit push` in production. Always use `pnpm db:migrate`.

---

## What's deferred (not in this release)

- Drift and Marginfi protocol adapters (`// TODO(2E):` markers)
- Multi-user per treasury, invitations, role expansion beyond `owner`
- M3 alert kinds: anomaly, concentration, protocol_health
- Scheduled outflows (M4-4), batched payouts (M4-5)
- Address-book label resolution in transfers without a book lookup
- CI workflows (`.github/workflows/`)
- Date-range picker and CSV export on `/history`

---

## Contributing

```bash
pnpm lint          # must pass
pnpm typecheck     # must pass
pnpm test          # must pass
pnpm format        # run before committing
```

Biome only — do not add ESLint or Prettier configs. Run `pnpm exec biome check --write .` to auto-fix formatting issues.

Follow the workspace dependency direction above. When adding a new package, place it so no cycles are introduced and all arrows still flow toward `types`/`env`.
