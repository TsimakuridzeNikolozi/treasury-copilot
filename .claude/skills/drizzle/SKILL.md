---
name: drizzle
description: Drizzle ORM patterns for Postgres — schema declaration, migrations (generate/migrate/push), querying (SQL-like and relational), and the postgres-js driver. Use when editing files in `packages/db/`, generating migrations, writing DB queries, or troubleshooting Drizzle errors. Triggers on "drizzle", "schema", "migration", "db:generate", "db:migrate", "drizzle-kit", or any work in packages/db/src/schema/.
---

# Drizzle ORM (Postgres)

> Canonical docs: https://orm.drizzle.team/docs — verify against the latest version when implementing anything load-bearing. This skill captures the patterns we use in Treasury Copilot.

## Project setup (already in place — don't change without a reason)

- **Package**: `packages/db` (`@tc/db`)
- **Driver**: `postgres` (postgres.js), not `pg`
- **Config**: `packages/db/drizzle.config.ts`
- **Schema**: `packages/db/src/schema/index.ts` — single source of truth, do not split across files unless the schema grows past ~500 lines
- **Migrations output**: `packages/db/drizzle/` (committed to git)
- **Client factory**: `packages/db/src/client.ts` exports `createDb(connectionString)` — no top-level singleton, apps own the connection lifecycle.

## The two APIs you will use

Drizzle has two query APIs. Use both.

1. **SQL-like select API** (`db.select().from()...`) — for joins, aggregates, anything that maps cleanly to SQL.
2. **Relational Queries API** (`db.query.tableName.findMany / findFirst`) — for nested loads of related rows, when you'd otherwise write 2-3 queries.

Pick based on the shape of the result. Don't force one onto the other.

## Schema declaration

```ts
// packages/db/src/schema/index.ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  numeric,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// Enums — define once, reuse via the enum's `enumValues`.
export const actionStatus = pgEnum('action_status', ['pending', 'approved', 'denied', 'executed']);

export const proposedActions = pgTable(
  'proposed_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payload: jsonb('payload').$type<ActionPayload>().notNull(),
    status: actionStatus('status').notNull().default('pending'),
    proposedBy: text('proposed_by').notNull(),       // chat session id
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    venue: text('venue', { enum: ['kamino', 'drift', 'marginfi'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('proposed_actions_status_idx').on(t.status),
    createdAtIdx: index('proposed_actions_created_at_idx').on(t.createdAt),
  }),
);

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  actionId: uuid('action_id')
    .references(() => proposedActions.id, { onDelete: 'cascade' })
    .notNull(),
  approverTelegramId: text('approver_telegram_id').notNull(),
  decision: text('decision', { enum: ['approve', 'deny'] }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations — required for the relational queries API.
export const proposedActionsRelations = relations(proposedActions, ({ many }) => ({
  approvals: many(approvals),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  action: one(proposedActions, {
    fields: [approvals.actionId],
    references: [proposedActions.id],
  }),
}));

// Type inference — export both Select and Insert types per table.
export type ProposedAction = typeof proposedActions.$inferSelect;
export type NewProposedAction = typeof proposedActions.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
```

### Column patterns worth knowing

| Need | Pattern |
|---|---|
| UUID primary key | `uuid('id').primaryKey().defaultRandom()` |
| Auto timestamp | `timestamp('created_at', { withTimezone: true }).defaultNow().notNull()` |
| Money (USDC, 6 decimals) | `numeric('amount_usdc', { precision: 20, scale: 6 })` — store as string, never `real`/`double` (lossy) |
| Enum-as-text | `text('venue', { enum: ['a', 'b'] })` — simpler than `pgEnum` for small fixed sets, no migration overhead when adding values |
| Strict enum | `pgEnum('name', [...])` — use when the values must be enforced at the DB level |
| Typed JSON | `jsonb('payload').$type<MyType>().notNull()` |
| Foreign key with cascade | `.references(() => other.id, { onDelete: 'cascade' })` |
| SQL default | `.default(sql\`now()\`)` |

### Indexes

Define inside the second arg of `pgTable`. Add an index whenever a column appears in a `where` or `orderBy`:

```ts
(t) => ({
  statusIdx: index('proposed_actions_status_idx').on(t.status),
  uniqueChat: uniqueIndex('uniq_chat').on(t.chatId),
})
```

## Querying

### SQL-like API

```ts
import { eq, and, desc, gt } from 'drizzle-orm';
import { proposedActions, approvals } from './schema';

// Simple select
const pending = await db
  .select()
  .from(proposedActions)
  .where(eq(proposedActions.status, 'pending'))
  .orderBy(desc(proposedActions.createdAt))
  .limit(50);

// Insert + return
const [created] = await db
  .insert(proposedActions)
  .values({ payload, amountUsdc: '1000.00', venue: 'kamino', proposedBy: sessionId })
  .returning();

// Update + return
const [updated] = await db
  .update(proposedActions)
  .set({ status: 'approved' })
  .where(eq(proposedActions.id, id))
  .returning();

// Join
const rows = await db
  .select({ action: proposedActions, approval: approvals })
  .from(proposedActions)
  .leftJoin(approvals, eq(approvals.actionId, proposedActions.id))
  .where(gt(proposedActions.createdAt, sinceDate));
```

### Relational Queries API

Requires the `relations()` calls in your schema and `drizzle(client, { schema })` at construction.

```ts
const action = await db.query.proposedActions.findFirst({
  where: (t, { eq }) => eq(t.id, id),
  with: {
    approvals: {
      orderBy: (t, { desc }) => [desc(t.decidedAt)],
    },
  },
});

const recent = await db.query.proposedActions.findMany({
  columns: { id: true, status: true, amountUsdc: true },  // partial select
  where: (t, { eq }) => eq(t.status, 'pending'),
  with: { approvals: true },
  limit: 20,
  orderBy: (t, { desc }) => [desc(t.createdAt)],
});
```

### Transactions

```ts
const result = await db.transaction(async (tx) => {
  const [action] = await tx.update(proposedActions)
    .set({ status: 'approved' })
    .where(eq(proposedActions.id, id))
    .returning();
  await tx.insert(approvals).values({ actionId: action.id, ... });
  return action;
});
```

`tx` rolls back if the callback throws. Don't manually `tx.rollback()` — just throw.

## Migrations: generate vs migrate vs push

**ONLY ever use `generate` + `migrate` for this project.** `push` is documented below for completeness but is not for our use case.

### `pnpm db:generate` — make a migration from schema changes

```bash
# After editing packages/db/src/schema/index.ts:
pnpm db:generate
```

Writes a numbered SQL file to `packages/db/drizzle/` (e.g., `0001_add_approvals.sql`) plus a metadata snapshot. **Commit both** to git. The SQL is the single source of truth for what gets applied to any database.

If the generated SQL looks wrong (rename detected as drop+add, an index missing), edit the schema and re-generate — never edit the SQL file directly. If you must (e.g., a data migration), add a hand-written migration file with the next number and a clear comment.

### `pnpm db:migrate` — apply pending migrations

```bash
pnpm db:migrate                                   # uses DATABASE_URL from env
DATABASE_URL=<staging-url> pnpm db:migrate        # apply to staging
DATABASE_URL=<prod-url> pnpm db:migrate           # apply to prod
```

Tracks which migrations have been applied in a `__drizzle_migrations` table. Safe to run repeatedly — already-applied migrations are skipped. Run against staging first, verify, then prod.

### `drizzle-kit push` — DO NOT USE

`push` syncs schema directly without a migration file. Convenient for prototyping, **destructive in any environment with real data**, and skips the audit trail. Don't use it. If a teammate adds it, push back.

### `drizzle-kit studio` — local GUI

```bash
pnpm --filter @tc/db studio
```

Opens a browser GUI against `DATABASE_URL`. Local only — never against prod.

## Common pitfalls

### `numeric` returns strings, not numbers

This is intentional (preserves precision). For arithmetic, use `Decimal.js` or BigInt-based math. Never `parseFloat()` a money column.

### `$inferSelect` vs `$inferInsert`

- `$inferSelect` — what the DB returns (all columns, defaults populated)
- `$inferInsert` — what you pass to `insert()` (defaults optional, generated columns omitted)

Use `$inferInsert` for the constructor arguments of any function that creates a row.

### Adding a column to an existing table

If `not null` and no default: split into two migrations. (1) Add column nullable with default. (2) After backfilling, alter to `not null`. Drizzle won't do this for you — generate, then split the SQL by hand.

### Schema changes not picked up

Drizzle reads from `schema: './src/schema/index.ts'` in `drizzle.config.ts`. If you split the schema across files, re-export everything from `index.ts` or update the config to glob (`./src/schema/*.ts`). Otherwise your new tables are invisible to drizzle-kit.

### Connection pooling on Neon (serverless)

For Vercel serverless functions hitting Neon, switch the driver to `@neondatabase/serverless` and use `drizzle-orm/neon-http`. The `postgres-js` driver works fine for the Railway worker (long-running connection) but burns connection slots on Vercel. We haven't migrated yet — when the chat route handler lands, this becomes load-bearing.

### Where to put query helpers

For one-shot queries: write inline in the route/handler that needs them.
For reusable queries (called from multiple places): put in `packages/db/src/queries/<topic>.ts` and export from there. Don't put them in `schema/` — keeps schema scannable.

## Treasury Copilot–specific patterns

**Audit trail is append-only.** Never `UPDATE` an audit log row. If a fact changes, write a new row. The `policy/signer/agent` chain depends on the audit log being a faithful record.

**Status transitions on `proposed_actions`** should go through a single helper, not ad-hoc updates scattered across the codebase. Define `transitionAction(id, from, to)` in `packages/db/src/queries/actions.ts` when you build it — enforce the legal transition graph there.

**Money columns are `numeric(20, 6)`** — matches USDC's 6 decimals with room for any plausible treasury size. Don't change the precision without a migration plan; existing rows would need backfill.
