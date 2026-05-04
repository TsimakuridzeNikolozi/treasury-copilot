# Treasury Copilot — Handbook

End-to-end guide for working in this repo: setup, day-to-day development, deployment, and troubleshooting. Read top-to-bottom on first onboarding; after that, jump via the table of contents.

- [1. Mental model](#1-mental-model)
- [2. First-time setup](#2-first-time-setup)
- [3. Daily development](#3-daily-development)
- [4. Working in the monorepo](#4-working-in-the-monorepo)
- [5. Database workflow](#5-database-workflow)
- [6. Environment variables](#6-environment-variables)
- [7. AI provider setup](#7-ai-provider-setup)
- [8. Testing](#8-testing)
- [9. Linting and formatting](#9-linting-and-formatting)
- [10. Adding features safely (the trust boundary)](#10-adding-features-safely-the-trust-boundary)
- [11. Deploying the web app to Vercel](#11-deploying-the-web-app-to-vercel)
- [12. Deploying the worker to Railway](#12-deploying-the-worker-to-railway)
- [13. Database in production (Neon)](#13-database-in-production-neon)
- [14. Troubleshooting](#14-troubleshooting)
- [15. Phase-1 roadmap](#15-phase-1-roadmap)

---

## 1. Mental model

Three things to keep in your head.

**Two long-running processes, different concerns.** `apps/web` is the Next.js 15 chat UI, audit dashboard, and approval flow — deployed to Vercel. `apps/worker` is a long-running Node process for the Telegram approval bot — deployed to Railway, because Vercel can't host persistent connections. They never call each other directly. They communicate through Postgres.

**The trust chain.** The product's whole security pitch is that the AI agent can never move funds without policy + human approval. This is enforced at the type level:

```
agent-tools  →  policy  →  signer
   propose       decide      execute
```

The agent constructs a `ProposedAction`, hands it to `evaluate()` from `@tc/policy`, gets back a `PolicyDecision` (`allow | deny | requires_approval`). Only `Extract<PolicyDecision, { kind: 'allow' }>` is accepted by `signer.executeApproved()`. The agent has no way to construct an `allow` value — only the policy engine produces them. TypeScript guarantees the chain.

**Workspace dependencies flow downward.**

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

Apps are sinks; `types` and `env` are leaves. No package depends on an app. New packages slot into this graph without creating cycles by construction.

---

## 2. First-time setup

### Prerequisites

- **Node 22.x** — `nvm use` reads `.nvmrc` (`22.11.0`)
- **pnpm 9.x** — install via `corepack enable && corepack prepare pnpm@9 --activate`
- **Docker Desktop** — for local Postgres
- **Git**

Verify:

```bash
node --version    # v22.x
pnpm --version    # 9.x
docker --version  # any recent
```

### Bootstrap

```bash
git clone <repo> && cd treasury-copilot
nvm use
corepack enable && corepack prepare pnpm@9 --activate

cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env

docker compose up -d postgres
pnpm install
pnpm build       # one-time, so packages emit cached typecheck info
```

### Verify it worked

```bash
pnpm typecheck   # 9 packages, all green
pnpm lint        # 9 packages, all green
pnpm dev         # web on :3000, worker idle in same terminal
```

Open `http://localhost:3000` — you should see the "Treasury Copilot" placeholder page.

---

## 3. Daily development

### Start of day

```bash
docker compose up -d postgres   # only if not already running
pnpm dev
```

`pnpm dev` runs `turbo run dev`, which fans out to both apps:

- **`@tc/web`**: `next dev --turbopack` on `:3000`. HMR for components and CSS, fast refresh for client + server components.
- **`@tc/worker`**: `tsx watch src/index.ts`. Restarts on file save. Logs to the same terminal.

Both share one terminal. Logs are prefixed with the package name. Press `Ctrl-C` once to stop both.

### End of day

```bash
# Ctrl-C the dev server, then:
docker compose down              # frees the :5432 port; data persists in the volume
```

### Working on one app at a time

```bash
pnpm --filter @tc/web dev        # web only
pnpm --filter @tc/worker dev     # worker only
```

### Cleaning up

```bash
pnpm clean                       # nukes all dist/.next/.turbo + root node_modules
```

`pnpm clean` is the nuclear option. For a softer reset, just `rm -rf .turbo` and re-run.

---

## 4. Working in the monorepo

### pnpm filter cheat sheet

```bash
pnpm --filter @tc/web <cmd>          # one package
pnpm --filter "@tc/*" <cmd>          # all under a scope
pnpm --filter "...@tc/policy" <cmd>  # @tc/policy + everything that depends on it
pnpm --filter "@tc/policy..." <cmd>  # @tc/policy + everything it depends on
pnpm -r <cmd>                        # every package, parallel
```

Turborepo also has filtering via `--filter`, but day-to-day prefer pnpm because turbo only knows about tasks defined in `turbo.json`.

### Adding a dependency

To a single package:

```bash
pnpm --filter @tc/web add lucide-react
pnpm --filter @tc/db add -D drizzle-kit
```

Workspace dependency (always uses `workspace:*`):

```bash
pnpm --filter @tc/web add @tc/policy@workspace:*
```

To the root (only repo tooling — turbo, biome, typescript):

```bash
pnpm add -D -w some-tool
```

### Adding a new package

1. Create the directory under `packages/<name>/`.
2. Copy the structure from a similar package (e.g., `packages/policy` for a pure-TS lib).
3. Set the package name as `@tc/<name>` and `version: "0.0.0"`, `private: true`, `type: "module"`.
4. Make `main` and `types` point at `./src/index.ts` (we ship source, not built JS, between workspace packages).
5. Add to a consumer's deps: `pnpm --filter @tc/web add @tc/<name>@workspace:*`.
6. **If the web app consumes it**, add the package name to `transpilePackages` in `apps/web/next.config.ts`. Without that, Next.js's bundler will fail at first import.
7. Run `pnpm install` at the root to relink.

### Enforcing the dependency direction

We have no automated enforcement yet. Convention: arrows go down, never up. If you find yourself adding `@tc/web` as a dep of a `packages/*` package, you've made a mistake — the right answer is to extract the shared code into a new lower-level package.

When phase-1 stabilizes, we'll add Turborepo Boundaries (`turbo boundaries`) with tag-based rules to enforce this.

---

## 5. Database workflow

### Local vs production

| Environment | Postgres |
|---|---|
| Local dev | Docker (`docker-compose.yml`), `postgresql://copilot:copilot@localhost:5432/treasury` |
| Staging / preview | Neon branch |
| Production | Neon main |

Local creds are intentionally fake. Never reuse them anywhere with real money.

### Writing schema changes

The schema lives in **one place**: `packages/db/src/schema/index.ts`. `drizzle.config.ts` reads from there. Don't put tables anywhere else.

Example (when phase-1 lands):

```ts
// packages/db/src/schema/index.ts
import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const proposedActions = pgTable('proposed_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  payload: jsonb('payload').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied'] }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type ProposedActionRow = typeof proposedActions.$inferSelect;
```

### Generating and applying migrations

```bash
# After editing schema:
pnpm db:generate          # writes a SQL migration to packages/db/drizzle/
git add packages/db/drizzle && git commit  # commit the migration

pnpm db:migrate           # applies pending migrations to DATABASE_URL
```

`db:generate` is deterministic from the schema and **must** be committed. Never edit a generated migration file — instead, change the schema and re-generate.

### Connecting from app code

```ts
import { createDb } from '@tc/db';

const db = createDb(process.env.DATABASE_URL!);
const rows = await db.query.proposedActions.findMany();
```

`createDb` is a factory by design — apps own the connection lifecycle. Don't add a top-level singleton.

### Drizzle Studio (optional GUI)

```bash
pnpm --filter @tc/db studio    # opens a browser GUI against DATABASE_URL
```

Useful for inspecting local data; do not point it at production.

---

## 6. Environment variables

### Files and precedence

| File | Loaded by | Committed? |
|---|---|---|
| `apps/web/.env.example` | nothing — documentation | yes |
| `apps/web/.env.local` | Next.js | **no** (gitignored) |
| `apps/worker/.env.example` | nothing — documentation | yes |
| `apps/worker/.env` | Node via `--env-file` (or Railway env at deploy) | **no** (gitignored) |

There's intentionally no root `.env`. Each app owns its own.

### How vars are validated

- **Web**: `apps/web/src/env.ts` uses `@t3-oss/env-nextjs` with Zod. Validation runs at module load; an invalid env aborts the build *and* dev server. The schema imports reusable fragments from `@tc/env`.
- **Worker**: `apps/worker/src/env.ts` does a direct `schema.safeParse(process.env)` and `process.exit(1)` on failure.

This is why builds fail with "Invalid environment variables" if `.env.local` is missing — see [§14](#14-troubleshooting).

### Adding a new variable (the three places)

For a server-only var like `HELIUS_API_KEY`:

1. **Schema fragment** — add to `packages/env/src/server.ts`:
   ```ts
   export const heliusApiKeySchema = z.string().min(1);
   ```
2. **App env** — extend the app's `env.ts`:
   ```ts
   // apps/web/src/env.ts
   server: { ..., HELIUS_API_KEY: heliusApiKeySchema }
   ```
3. **Examples** — add to `apps/web/.env.example` and `apps/worker/.env.example` (whichever app uses it), with a placeholder value.

For a client-public var (`NEXT_PUBLIC_*`), add it to `packages/env/src/client.ts` and to the `client` block of `apps/web/src/env.ts`. **Never** put a secret in a `NEXT_PUBLIC_*` var.

### Secrets in production

- Vercel: set in the project's Environment Variables UI, scoped to Production / Preview / Development.
- Railway: set in the service's Variables tab. Reference shared values via `${{ Postgres.DATABASE_URL }}` if you provision Postgres in Railway too (we don't — we use Neon).
- Never commit `.env` or `.env.local`. The `.gitignore` covers them.

---

## 7. AI provider setup

The chat surface routes through one of three providers, picked at runtime via `MODEL_PROVIDER` in `apps/web/.env.local`. The single switch lives in `apps/web/src/lib/ai/model.ts`. Tools and route handlers don't import provider SDKs directly — that keeps swap a one-line change.

### Using Anthropic (default)

```bash
# apps/web/.env.local
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
```

Get a key from https://console.anthropic.com. The default model is `claude-sonnet-4-6`; override if you want a smaller/faster model for dev.

### Using OpenAI

```bash
MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
```

### Using QVAC (local-first, by Tether)

QVAC runs models on-device — useful for privacy-sensitive operators. Its HTTP server is OpenAI-API-compatible, so the OpenAI provider plugs in unchanged with a custom `baseURL`.

One-time install:

```bash
pnpm add -g @qvac/cli
```

QVAC needs a model alias declared in `qvac.config.json` at the repo root before the server exposes `/v1/chat/completions`. The repo already includes one (`QWEN3_600M_INST_Q4` aliased to itself, set as the default and preloaded) — extend it if you want a different model.

In one terminal, start the server from the repo root (binds 127.0.0.1:11434):

```bash
qvac serve openai
```

First boot downloads the model (~2 GB for the 3B); subsequent boots are warm. If you skipped the config, you'll see "No models configured for preload" and the chat-completions endpoint will be missing — start it from the repo root so it picks up `qvac.config.json`.

In `apps/web/.env.local`:

```bash
MODEL_PROVIDER=qvac
QVAC_BASE_URL=http://localhost:11434/v1
QVAC_MODEL=QWEN3_600M_INST_Q4
```

> **Port collision with Ollama:** Ollama also defaults to 11434. Run QVAC on a different port: `qvac serve openai -p 11435`, and update `QVAC_BASE_URL` to match.

> **Model size vs tool-calling fidelity:** smaller models (1B) often hallucinate tool arguments. The trust boundary catches these (`policy.evaluate` rejects malformed amounts/addresses) — funds are safe, but UX suffers. Pick the largest model your hardware sustains.

### Smoke-testing the chat

```bash
pnpm dev                                # web on :3000
# open http://localhost:3000/chat
# type: "deposit 500 USDC into Kamino from So11111111111111111111111111111111111111112"
# expect: streamed response describing the policy decision
# verify in db:
docker exec -it treasury-copilot-postgres psql -U copilot -d treasury \
  -c "SELECT id, status, amount_usdc, venue FROM proposed_actions ORDER BY created_at DESC LIMIT 3;"
```

Audit the model that proposed each action:

```bash
docker exec -it treasury-copilot-postgres psql -U copilot -d treasury \
  -c "SELECT kind, payload->>'modelProvider' AS provider, created_at
      FROM audit_logs ORDER BY created_at DESC LIMIT 10;"
```

---

## 8. Testing

Vitest in every package. No `vitest.config.ts` files — defaults are fine. Tests live next to source as `*.test.ts` / `*.test.tsx`.

```bash
pnpm test                                # all packages
pnpm --filter @tc/policy test            # one package
pnpm --filter @tc/policy test path/to/file.test.ts   # one file
pnpm --filter @tc/policy test:watch      # watch mode
```

For React components in `apps/web`, add `@testing-library/react` and `jsdom` when you write the first test:

```bash
pnpm --filter @tc/web add -D @testing-library/react @testing-library/jest-dom jsdom
```

Then create `apps/web/vitest.config.ts` with `test: { environment: 'jsdom' }`.

End-to-end tests (Playwright, etc.) are **not** set up. Add when there's enough UI to justify it.

---

## 9. Linting and formatting

Biome only — no ESLint, no Prettier. The shared config lives at `packages/biome-config/biome.json` and the root `biome.json` extends it.

```bash
pnpm lint                          # check, fail on issues (CI-style)
pnpm format                        # format all files in place
pnpm exec biome check --write .    # lint + fix what's auto-fixable
```

Common Biome behaviors worth knowing:

- It enforces single quotes, semicolons, trailing commas, 100-char line width.
- It will rewrite multi-line imports to single-line if they fit. Don't fight it.
- `useImportType` is an error — `import type { Foo }` for type-only imports.
- `noNonNullAssertion` is a warning — use it sparingly; prefer narrowing.

No pre-commit hook is installed. If you want one:

```bash
pnpm add -Dw lefthook
# add a lefthook.yml that runs `pnpm exec biome check --staged`
```

Husky is also fine; we picked Biome partly to avoid the ESLint+Prettier+lint-staged stack.

---

## 10. Adding features safely (the trust boundary)

The single most important architectural rule. **Do not bypass `@tc/policy`.**

### Adding a new agent tool

1. Define the tool's input schema in `@tc/agent-tools` (Zod).
2. The tool handler:
   - Builds a `ProposedAction` from the input.
   - Calls `evaluate(action)` from `@tc/policy`.
   - On `allow`: passes the typed-`allow` decision to `signer.executeApproved()`.
   - On `requires_approval`: writes the action to the DB and returns a "pending approval" message; the worker picks it up.
   - On `deny`: returns the reason as a tool-call result so the agent can explain to the user.
3. Tool handlers must **never** import `@tc/signer` directly without going through `@tc/policy` first. The type system catches this — `executeApproved()` won't accept anything other than an `allow` decision.

### Adding a new policy rule

Edit `packages/policy/src/index.ts`. The `evaluate()` function should remain pure (no I/O); load policy state from the DB at the call site and pass it in:

```ts
export function evaluate(action: ProposedAction, policy: Policy): PolicyDecision {
  // ...
}
```

Test thoroughly — these are the rules that decide whether real money moves.

### Adding a new signer method

Add to the `Signer` interface in `packages/signer/src/index.ts`. Every method must take an `Extract<PolicyDecision, { kind: 'allow' }>` (or a more specific allow-shape) as the first argument. The implementation lives in a separate file (e.g., `packages/signer/src/turnkey.ts`) and is selected at app boot.

---

## 11. Deploying the web app to Vercel

### One-time setup

```bash
pnpm i -g vercel
vercel login
vercel link --repo            # IMPORTANT: --repo flag, since this is a monorepo
```

The `--repo` flag creates `.vercel/repo.json` (multi-project), not `.vercel/project.json` (single-project). If you skip `--repo`, Vercel will assume one project at the root and break.

In the Vercel dashboard, after the first link:

1. **Project root:** set to `apps/web`.
2. **Framework preset:** Next.js (auto-detected).
3. **Build command:** leave default (`next build`); Vercel runs this from `apps/web`.
4. **Install command:** `pnpm install` — Vercel will detect pnpm from the lockfile.
5. **Output directory:** leave default.

### Environment variables

Set these in the Vercel project, scoped per environment (Production / Preview / Development):

| Var | Production | Preview |
|---|---|---|
| `DATABASE_URL` | Neon main branch | Neon preview branch |
| `SOLANA_RPC_URL` | Helius mainnet | Helius devnet |
| `LOG_LEVEL` | `info` | `debug` |
| `NEXT_PUBLIC_APP_URL` | `https://app.treasury-copilot.com` | `https://$VERCEL_URL` works as a fallback |

Add new vars in **two** places: Vercel UI **and** `apps/web/.env.example` so future Claude / future you knows the var exists.

### Deploying

```bash
# Preview (any branch)
git push                              # auto-deploys on push to a non-main branch

# Production
git push origin main                  # auto-deploys main → production

# Manual / out-of-band
vercel --prod                         # from repo root, with .vercel/repo.json linked
```

### Build-time env validation

The web app validates env at build time via t3-env. **All required vars must be set in Vercel before the first deploy** or it will fail at "Collecting page data". If you need a one-off build without env, set `SKIP_ENV_VALIDATION=1` — but never do this in production.

---

## 12. Deploying the worker to Railway

The `railway` skill is installed; lean on it for anything not covered here.

### One-time setup

1. Create a new Railway project, connect it to this GitHub repo.
2. Add a service from the repo. Railway will read `apps/worker/railway.toml`:
   ```toml
   [build]
   builder = "DOCKERFILE"
   dockerfilePath = "apps/worker/Dockerfile"
   ```
3. Set the **root directory** to the repo root (not `apps/worker`) — the Dockerfile needs the full monorepo context to install workspace deps.

### Environment variables

In the Railway service's Variables tab:

| Var | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (production branch) |
| `SOLANA_RPC_URL` | Helius mainnet URL |
| `LOG_LEVEL` | `info` |
| `NODE_ENV` | `production` |
| `TELEGRAM_BOT_TOKEN` | (phase-1) |

If you provision Postgres inside Railway later (we don't, we use Neon), reference its URL as `${{ Postgres.DATABASE_URL }}`.

### Deploying

`git push origin main` triggers a Railway build via the Dockerfile. The Dockerfile:

1. Installs all workspace deps with pnpm.
2. Builds `@tc/worker` with tsup (single ESM bundle).
3. Uses `pnpm deploy --filter=@tc/worker --prod` to extract a minimal `node_modules` for the runtime stage.
4. Runs `node dist/index.js` as the unprivileged `node` user.

### Logs and restart behavior

`railway.toml` sets `restartPolicyType = "ON_FAILURE"` with up to 10 retries. Logs stream in the Railway dashboard or via `railway logs`.

The worker is currently a no-op idle loop with a `SIGTERM`/`SIGINT` handler. When phase-1 lands, ensure your bot client (`grammy`) hooks into the same shutdown path so Railway's graceful stop works correctly.

---

## 13. Database in production (Neon)

### One-time setup

1. Create a Neon project.
2. Create two branches: `main` (production) and `preview` (one shared preview, or use Neon's per-PR branching).
3. Copy the connection strings; set them in Vercel and Railway env vars.
4. Run the initial migration:
   ```bash
   DATABASE_URL=postgresql://...neon...  pnpm db:migrate
   ```

### Migration discipline

- Generate locally with `pnpm db:generate`.
- Commit the migration files (`packages/db/drizzle/*.sql`).
- Apply to staging first via `DATABASE_URL=<staging>  pnpm db:migrate`. Verify.
- Apply to production from a CI job or your laptop with `DATABASE_URL=<prod>  pnpm db:migrate`.
- Never run `drizzle-kit push` against production. `push` skips migration history; use `migrate` so we have a forward audit trail.

### Backups

Neon has point-in-time restore on paid plans. For free tier, set up a nightly `pg_dump` to S3/R2 once you store anything beyond test data.

---

## 14. Troubleshooting

### `Invalid environment variables` at build or dev

```
DATABASE_URL: [ 'Required' ]
SOLANA_RPC_URL: [ 'Required' ]
NEXT_PUBLIC_APP_URL: [ 'Required' ]
```

Cause: t3-env can't find required vars. Fix:

```bash
cp apps/web/.env.example apps/web/.env.local
# fill in real values, then re-run
```

For a one-off CI build that genuinely shouldn't validate (e.g., a Docker image bake): `SKIP_ENV_VALIDATION=1 pnpm build`. Never use this in production.

### `tsc` error: `is not under 'rootDir'`

If you ever see:

```
File '...' is not under 'rootDir' '...packages/tsconfig/src'.
```

The `rootDir` / `outDir` keys in a shared tsconfig (e.g., `packages/tsconfig/base.json`) resolve relative to the **shared** config's directory, not the consumer's. Don't add those keys to the shared config. Each consumer that needs emit sets its own.

### Next.js: `Module not found: Can't resolve '@tc/something'`

Add the package name to `transpilePackages` in `apps/web/next.config.ts`. Without that, Next.js's bundler skips ESM transforms for workspace packages and resolution fails on first import.

### Worker Docker build fails at `pnpm deploy`

Two common causes:

1. **Lockfile mismatch** — `pnpm install --frozen-lockfile` in the Dockerfile fails if the lockfile is out of date. Run `pnpm install` locally and commit the updated lockfile.
2. **Build context too small** — Railway must use the **repo root** as the build context, not `apps/worker`. Check the Railway service's "Root Directory" setting.

### Biome formatter complaints in CI

Run `pnpm exec biome check --write .` locally to fix everything Biome can fix automatically, then commit.

### `pnpm dev` doesn't see schema changes from `@tc/db`

Workspace packages export source (not `dist`), so changes are picked up immediately by Vitest, tsc, and Next.js. If you don't see them, the package's `main`/`types` in `package.json` may have been changed to point at `dist/` — revert to `./src/index.ts`.

### Port 5432 already in use

You already have a Postgres running locally (Homebrew, another project's Docker). Either stop it or change the docker-compose port mapping to `"5433:5432"` and update `DATABASE_URL` in both `.env` files to use `:5433`.

---

## 15. Phase-1 roadmap

Suggested build order. Each item has a recommended skill to invoke when you start it.

1. **Real Drizzle schema** — `proposed_actions`, `policies`, `approvals`, `audit_logs`. No skill (use Drizzle docs); follow the migration discipline in [§5](#5-database-workflow).
2. **Auth (Privy)** — gate the web app. Use `frontend-design-guidelines` and `next-best-practices`.
3. **Vercel AI SDK chat route** — `apps/web/src/app/api/chat/route.ts` with `streamText` + tool definitions imported from `@tc/agent-tools`. Invoke `ai-sdk` skill; pair with `ai-elements` for the chat UI components.
4. **Solana protocol adapters** — fill in `packages/protocols/src/{kamino,drift,marginfi}.ts` with real SDK calls. Invoke `solana-dev` skill.
5. **Policy engine v1** — flesh out `packages/policy/src/index.ts` with rules: max single-move size, max daily volume, allowlist of venues, etc.
6. **Signer (Turnkey)** — implement the `Signer` interface in `packages/signer/src/turnkey.ts`. Run `cso` skill before merging.
7. **Telegram approval bot** — wire up grammy in `apps/worker`. The bot reads pending approvals from the DB, posts to a configured chat, accepts approve/deny callbacks. Use grammy docs (no skill).
8. **Audit dashboard** — Next.js page that lists `audit_logs` and `proposed_actions`. Invoke `building-components` for the table UI.
9. **CI** — GitHub Actions workflow that runs `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test`. Add Turborepo remote cache if build times grow.
10. **Mainnet readiness** — invoke `cso` (comprehensive mode) and `deploy-to-mainnet` before flipping the production switch.
