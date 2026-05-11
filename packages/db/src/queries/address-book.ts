import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { type AddressBookEntryRow, addressBookEntries, auditLogs } from '../schema';

// M4 PR 2 — per-treasury address book.
//
// Audit kinds emitted by the mutation paths in this file:
//   address_book_entry_added    — POST /api/treasury/address-book
//   address_book_entry_updated  — PATCH /api/treasury/address-book/[id]
//   address_book_entry_removed  — DELETE /api/treasury/address-book/[id]
//
// All three are plain text literals (mirroring policy_updated /
// alert_subscription_updated) — kind is `text` on audit_logs, not an enum,
// so new kinds are call-site additions without a migration.

export interface InsertAddressBookEntryInput {
  treasuryId: string;
  label: string;
  recipientAddress: string;
  tokenMint?: string;
  notes?: string | null;
  preApproved: boolean;
  createdBy: string;
}

// Returns the newly-inserted row. Wrapped in a transaction with the audit
// log write so the row + history land atomically — a constraint failure
// on either rolls the other back.
//
// Uniqueness violations (duplicate label or address within the treasury)
// surface as postgres-js errors carrying the offending index name:
//   address_book_entries_treasury_address_uq
//   address_book_entries_treasury_label_uq
// The API layer maps those to specific 409s; callers below the route
// layer can rely on the structured error to disambiguate.
export async function insertAddressBookEntry(
  db: Db,
  input: InsertAddressBookEntryInput,
): Promise<AddressBookEntryRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(addressBookEntries)
      .values({
        treasuryId: input.treasuryId,
        label: input.label,
        recipientAddress: input.recipientAddress,
        // `undefined` → drizzle omits the column → Postgres applies the
        // column DEFAULT (USDC mint). Explicit USDC is fine too; this
        // path lets callers stay agnostic about the default.
        ...(input.tokenMint !== undefined && { tokenMint: input.tokenMint }),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        preApproved: input.preApproved,
        createdBy: input.createdBy,
      })
      .returning();

    if (!row) {
      // .returning() yields the inserted row on success; missing row
      // implies the insert was silently rejected, which the typed
      // builder should never allow. Surface loud rather than fall
      // through with a half-built shape.
      throw new Error('addressBookEntries insert returned no row');
    }

    await tx.insert(auditLogs).values({
      kind: 'address_book_entry_added',
      treasuryId: input.treasuryId,
      actor: input.createdBy,
      payload: {
        entryId: row.id,
        label: row.label,
        recipientAddress: row.recipientAddress,
        tokenMint: row.tokenMint,
        preApproved: row.preApproved,
        notes: row.notes,
      },
    });

    return row;
  });
}

export interface UpdateAddressBookEntryInput {
  // Caller scopes by (id, treasuryId) — never just id — so a malicious
  // PATCH that knows another treasury's entry id cannot mutate it. The
  // route layer establishes treasuryId from the active-cookie resolve.
  id: string;
  treasuryId: string;
  label: string;
  notes: string | null;
  preApproved: boolean;
  updatedBy: string;
}

// Updates label/notes/preApproved on an existing entry. Returns the row
// after update; throws if no row matched (id+treasuryId mismatch or
// already deleted). The audit row carries `before` and `after` shapes
// for diffability — same pattern as upsertPolicy.
//
// `recipient_address` is intentionally not editable: a new address is a
// new entry, not a rename. This keeps the (treasury_id, recipient_address)
// uniqueness contract simple and avoids dangling "this entry used to be
// address X" history in audit logs.
export async function updateAddressBookEntry(
  db: Db,
  input: UpdateAddressBookEntryInput,
): Promise<AddressBookEntryRow> {
  return db.transaction(async (tx) => {
    const before = await tx.query.addressBookEntries.findFirst({
      where: and(
        eq(addressBookEntries.id, input.id),
        eq(addressBookEntries.treasuryId, input.treasuryId),
      ),
    });
    if (!before) {
      throw new AddressBookEntryNotFound(input.id);
    }

    const now = new Date();
    const [row] = await tx
      .update(addressBookEntries)
      .set({
        label: input.label,
        notes: input.notes,
        preApproved: input.preApproved,
        updatedAt: now,
      })
      .where(
        and(
          eq(addressBookEntries.id, input.id),
          eq(addressBookEntries.treasuryId, input.treasuryId),
        ),
      )
      .returning();

    if (!row) {
      // The .findFirst above just succeeded, so a missing returning()
      // means the row was deleted between read and update inside the
      // same transaction — race with a concurrent DELETE. Surface so
      // the API returns 409/404 instead of silently dropping the edit.
      throw new AddressBookEntryNotFound(input.id);
    }

    await tx.insert(auditLogs).values({
      kind: 'address_book_entry_updated',
      treasuryId: input.treasuryId,
      actor: input.updatedBy,
      payload: {
        entryId: row.id,
        before: {
          label: before.label,
          notes: before.notes,
          preApproved: before.preApproved,
        },
        after: {
          label: row.label,
          notes: row.notes,
          preApproved: row.preApproved,
        },
      },
    });

    return row;
  });
}

export interface DeleteAddressBookEntryInput {
  id: string;
  treasuryId: string;
  deletedBy: string;
}

// Deletes the entry. Returns the deleted row so the route layer can
// 404 if no row matched. The audit row captures the deleted entry's
// shape for after-the-fact reconstruction (no soft-delete column —
// audit history is the soft delete).
export async function deleteAddressBookEntry(
  db: Db,
  input: DeleteAddressBookEntryInput,
): Promise<AddressBookEntryRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(addressBookEntries)
      .where(
        and(
          eq(addressBookEntries.id, input.id),
          eq(addressBookEntries.treasuryId, input.treasuryId),
        ),
      )
      .returning();
    if (!row) {
      throw new AddressBookEntryNotFound(input.id);
    }

    await tx.insert(auditLogs).values({
      kind: 'address_book_entry_removed',
      treasuryId: input.treasuryId,
      actor: input.deletedBy,
      payload: {
        entryId: row.id,
        label: row.label,
        recipientAddress: row.recipientAddress,
        tokenMint: row.tokenMint,
        preApproved: row.preApproved,
        notes: row.notes,
      },
    });

    return row;
  });
}

// Stable ordering: created_at desc so the most recently added entry
// surfaces at the top of the settings table. Empty result on no rows
// (callers don't need to defend against null).
export async function listAddressBookEntries(
  db: Db,
  treasuryId: string,
): Promise<AddressBookEntryRow[]> {
  return db
    .select()
    .from(addressBookEntries)
    .where(eq(addressBookEntries.treasuryId, treasuryId))
    .orderBy(desc(addressBookEntries.createdAt));
}

// Single-entry reads. Scoped by treasuryId so a misuse upstream can't
// cross treasury boundaries. Returns null for missing — callers decide
// the 404 vs default-fallback behavior.

export async function getAddressBookEntryById(
  db: Db,
  treasuryId: string,
  id: string,
): Promise<AddressBookEntryRow | null> {
  const row = await db.query.addressBookEntries.findFirst({
    where: and(eq(addressBookEntries.id, id), eq(addressBookEntries.treasuryId, treasuryId)),
  });
  return row ?? null;
}

export async function getAddressBookEntryByAddress(
  db: Db,
  treasuryId: string,
  recipientAddress: string,
): Promise<AddressBookEntryRow | null> {
  const row = await db.query.addressBookEntries.findFirst({
    where: and(
      eq(addressBookEntries.treasuryId, treasuryId),
      eq(addressBookEntries.recipientAddress, recipientAddress),
    ),
  });
  return row ?? null;
}

export async function getAddressBookEntryByLabel(
  db: Db,
  treasuryId: string,
  label: string,
): Promise<AddressBookEntryRow | null> {
  const row = await db.query.addressBookEntries.findFirst({
    where: and(eq(addressBookEntries.treasuryId, treasuryId), eq(addressBookEntries.label, label)),
  });
  return row ?? null;
}

// Returns the set of every recipient address in the treasury's address
// book (pre-approved or not). Threaded into
// `EvaluateContext.addressBookRecipients` by the chat route so the
// requireAddressBookForTransfers gate can check membership without a
// per-transfer DB round-trip. Mirror of getPreApprovedRecipientSet
// without the pre_approved filter — pre-approved entries are a strict
// subset of book entries.
//
// Empty set on a treasury with no entries. With
// requireAddressBookForTransfers=true (the default), an empty set means
// every transfer denies — that's the fail-closed contract.
export async function getAddressBookRecipientSet(db: Db, treasuryId: string): Promise<Set<string>> {
  const rows = await db
    .select({ recipientAddress: addressBookEntries.recipientAddress })
    .from(addressBookEntries)
    .where(eq(addressBookEntries.treasuryId, treasuryId));
  return new Set(rows.map((r) => r.recipientAddress));
}

// Returns the set of recipient addresses with pre_approved=true for a
// treasury. Threaded into `EvaluateContext.preApprovedRecipients` by the
// chat route + (future) scheduled-outflow worker so transfers above
// `requireApprovalAboveUsdc` to a pre-approved recipient bypass the
// approval gate. The velocity cap still applies — a pre-approved
// recipient cannot exhaust an unbounded daily budget.
//
// Empty set on a treasury with no pre-approved entries. Callers MUST
// pass an empty set (or omit the field) rather than fabricate a "match
// anything" sentinel — the bypass is recipient-scoped by design.
export async function getPreApprovedRecipientSet(db: Db, treasuryId: string): Promise<Set<string>> {
  const rows = await db
    .select({ recipientAddress: addressBookEntries.recipientAddress })
    .from(addressBookEntries)
    .where(
      and(eq(addressBookEntries.treasuryId, treasuryId), eq(addressBookEntries.preApproved, true)),
    );
  return new Set(rows.map((r) => r.recipientAddress));
}

// Typed not-found error so the route layer can map cleanly to 404 / 409
// without parsing message strings. Subclass of Error so accidental
// rethrows still log with a stack.
export class AddressBookEntryNotFound extends Error {
  constructor(public readonly id: string) {
    super(`address book entry ${id} not found`);
    this.name = 'AddressBookEntryNotFound';
  }
}

// Postgres-js surfaces unique-index violations with code '23505' and a
// `constraint_name` carrying the offending index. The route layer reads
// these to disambiguate "duplicate label" vs "duplicate address" without
// re-querying the DB.
//
// Constraint names are stable (defined in migration 0014); kept as
// exported constants so a future rename touches both the migration and
// the consumers in lockstep.
export const ADDRESS_BOOK_LABEL_UNIQUE_CONSTRAINT = 'address_book_entries_treasury_label_uq';
export const ADDRESS_BOOK_ADDRESS_UNIQUE_CONSTRAINT = 'address_book_entries_treasury_address_uq';

// Narrow the postgres-js unique-violation error shape without pulling in
// the postgres-js types — the runtime check on .code is enough to know
// it's a postgres error, and .constraint_name is present on 23505 rows.
interface PostgresUniqueViolation {
  code: '23505';
  constraint_name?: string;
}
function isPostgresUniqueViolation(e: unknown): e is PostgresUniqueViolation {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === '23505'
  );
}

export function isAddressBookLabelConflict(e: unknown): boolean {
  return isPostgresUniqueViolation(e) && e.constraint_name === ADDRESS_BOOK_LABEL_UNIQUE_CONSTRAINT;
}

export function isAddressBookAddressConflict(e: unknown): boolean {
  return (
    isPostgresUniqueViolation(e) && e.constraint_name === ADDRESS_BOOK_ADDRESS_UNIQUE_CONSTRAINT
  );
}
