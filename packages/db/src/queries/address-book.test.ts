import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_TREASURY_ID, ensureTestTreasury } from '../../test/treasury';
import { TEST_DATABASE_URL } from '../../test/url';
import * as schema from '../schema';
import {
  AddressBookEntryNotFound,
  deleteAddressBookEntry,
  getAddressBookEntryByAddress,
  getAddressBookEntryById,
  getAddressBookEntryByLabel,
  getAddressBookRecipientSet,
  getPreApprovedRecipientSet,
  insertAddressBookEntry,
  isAddressBookAddressConflict,
  isAddressBookLabelConflict,
  listAddressBookEntries,
  updateAddressBookEntry,
} from './address-book';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;

const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

// Two on-curve test addresses. The address-book code never derives an
// ATA or otherwise checks on-curve status (recipients can be PDAs or
// program-derived addresses), but using realistic base58 here keeps
// the test inputs self-documenting.
const ALICE = '9xQeWvG816bUx9EPa1xCkYJyXmcAfg7vRfBxbCw5N3rN';
const BOB = 'GokivDYuQXPZCWRkwMhdH2h91KpDQXBEmKgBjFvKMHJq';

const ACTOR_A = 'did:privy:owner-a';
const ACTOR_B = 'did:privy:owner-b';

describe.skipIf(SKIP)('queries/address-book', () => {
  beforeEach(async () => {
    // Clean every table the address-book tests touch. Order matters
    // (audit_logs has no FK to address_book_entries today, but keeping
    // the children-first sweep keeps future FK additions safe).
    await db.delete(schema.auditLogs);
    await db.delete(schema.addressBookEntries);
    await ensureTestTreasury(db);
  });

  describe('insertAddressBookEntry', () => {
    it('inserts a row and writes an address_book_entry_added audit row', async () => {
      const row = await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme Corp',
        recipientAddress: ALICE,
        notes: 'Q1 vendor',
        preApproved: true,
        createdBy: ACTOR_A,
      });
      expect(row.label).toBe('Acme Corp');
      expect(row.recipientAddress).toBe(ALICE);
      // Default USDC mint applied when caller omits tokenMint.
      expect(row.tokenMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      expect(row.preApproved).toBe(true);
      expect(row.notes).toBe('Q1 vendor');
      expect(row.createdBy).toBe(ACTOR_A);

      const [audit] = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.kind, 'address_book_entry_added'));
      expect(audit).toBeDefined();
      expect(audit?.treasuryId).toBe(TEST_TREASURY_ID);
      expect(audit?.actor).toBe(ACTOR_A);
      const payload = audit?.payload as Record<string, unknown>;
      expect(payload.entryId).toBe(row.id);
      expect(payload.label).toBe('Acme Corp');
      expect(payload.preApproved).toBe(true);
    });

    it('rolls back the insert when the audit insert fails (atomicity guard)', async () => {
      // Force the audit insert to violate a constraint by null-ing
      // `actor` (NOT NULL on audit_logs). Without the transaction
      // wrap, the entry row would persist with an orphan history. With
      // it, both rows roll back.
      await expect(
        insertAddressBookEntry(db, {
          treasuryId: TEST_TREASURY_ID,
          label: 'Should Not Persist',
          recipientAddress: ALICE,
          preApproved: false,
          // Cast around the type to plant a null actor — the API layer
          // would reject this at the boundary, but the DB layer must
          // also be safe under operator misuse.
          createdBy: null as unknown as string,
        }),
      ).rejects.toThrow();

      const rows = await db
        .select()
        .from(schema.addressBookEntries)
        .where(eq(schema.addressBookEntries.treasuryId, TEST_TREASURY_ID));
      expect(rows).toHaveLength(0);
    });

    it('rejects duplicate (treasury_id, label) with the label unique constraint', async () => {
      await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme Corp',
        recipientAddress: ALICE,
        preApproved: false,
        createdBy: ACTOR_A,
      });
      const dup = insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme Corp', // same label
        recipientAddress: BOB, // different address
        preApproved: false,
        createdBy: ACTOR_A,
      });
      await expect(dup).rejects.toMatchObject({ code: '23505' });
      try {
        await dup;
      } catch (e) {
        expect(isAddressBookLabelConflict(e)).toBe(true);
        expect(isAddressBookAddressConflict(e)).toBe(false);
      }
    });

    it('rejects duplicate (treasury_id, recipient_address) with the address unique constraint', async () => {
      await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme',
        recipientAddress: ALICE,
        preApproved: false,
        createdBy: ACTOR_A,
      });
      const dup = insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme Rename', // different label
        recipientAddress: ALICE, // same address
        preApproved: false,
        createdBy: ACTOR_A,
      });
      await expect(dup).rejects.toMatchObject({ code: '23505' });
      try {
        await dup;
      } catch (e) {
        expect(isAddressBookAddressConflict(e)).toBe(true);
        expect(isAddressBookLabelConflict(e)).toBe(false);
      }
    });
  });

  describe('updateAddressBookEntry', () => {
    it('updates label/notes/preApproved + writes an address_book_entry_updated audit', async () => {
      const inserted = await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme',
        recipientAddress: ALICE,
        notes: null,
        preApproved: false,
        createdBy: ACTOR_A,
      });
      const updated = await updateAddressBookEntry(db, {
        id: inserted.id,
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme Corp',
        notes: 'now pre-approved',
        preApproved: true,
        updatedBy: ACTOR_B,
      });
      expect(updated.label).toBe('Acme Corp');
      expect(updated.notes).toBe('now pre-approved');
      expect(updated.preApproved).toBe(true);
      // updated_at advanced past created_at.
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());

      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.kind, 'address_book_entry_updated'))
        .orderBy(asc(schema.auditLogs.createdAt));
      expect(audits).toHaveLength(1);
      const payload = audits[0]?.payload as Record<string, unknown>;
      expect(payload.entryId).toBe(inserted.id);
      const before = payload.before as Record<string, unknown>;
      const after = payload.after as Record<string, unknown>;
      expect(before.label).toBe('Acme');
      expect(before.preApproved).toBe(false);
      expect(after.label).toBe('Acme Corp');
      expect(after.preApproved).toBe(true);
      expect(audits[0]?.actor).toBe(ACTOR_B);
    });

    it('throws AddressBookEntryNotFound when (id, treasuryId) does not match', async () => {
      await expect(
        updateAddressBookEntry(db, {
          id: '00000000-0000-4000-8000-0000000000FF',
          treasuryId: TEST_TREASURY_ID,
          label: 'Nope',
          notes: null,
          preApproved: false,
          updatedBy: ACTOR_A,
        }),
      ).rejects.toBeInstanceOf(AddressBookEntryNotFound);
    });

    it('refuses to update an entry that belongs to a different treasury (cross-treasury guard)', async () => {
      // Provision a second treasury, plant an entry on it, then try to
      // patch that entry via a request scoped to the seed treasury.
      const otherId = '00000000-0000-4000-8000-0000000000A1';
      await db
        .insert(schema.treasuries)
        .values({
          id: otherId,
          name: 'AB Other',
          walletAddress: 'So55555555555555555555555555555555555555555',
          turnkeySubOrgId: 'test-suborg-ab-other',
          turnkeyWalletId: null,
          signerBackend: 'local',
          telegramChatId: null,
          telegramApproverIds: [],
          createdBy: null,
        })
        .onConflictDoNothing();
      const otherEntry = await insertAddressBookEntry(db, {
        treasuryId: otherId,
        label: 'Other Acme',
        recipientAddress: ALICE,
        preApproved: true,
        createdBy: ACTOR_A,
      });

      await expect(
        updateAddressBookEntry(db, {
          id: otherEntry.id,
          // Scoped to the test treasury — must reject.
          treasuryId: TEST_TREASURY_ID,
          label: 'Hijack',
          notes: null,
          preApproved: false,
          updatedBy: ACTOR_B,
        }),
      ).rejects.toBeInstanceOf(AddressBookEntryNotFound);

      // Other treasury's entry was not touched.
      const stillThere = await getAddressBookEntryById(db, otherId, otherEntry.id);
      expect(stillThere?.label).toBe('Other Acme');
      expect(stillThere?.preApproved).toBe(true);
    });
  });

  describe('deleteAddressBookEntry', () => {
    it('deletes the row and writes an address_book_entry_removed audit', async () => {
      const inserted = await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme',
        recipientAddress: ALICE,
        preApproved: true,
        createdBy: ACTOR_A,
      });
      const removed = await deleteAddressBookEntry(db, {
        id: inserted.id,
        treasuryId: TEST_TREASURY_ID,
        deletedBy: ACTOR_B,
      });
      expect(removed.id).toBe(inserted.id);

      const rows = await db
        .select()
        .from(schema.addressBookEntries)
        .where(eq(schema.addressBookEntries.id, inserted.id));
      expect(rows).toHaveLength(0);

      const [audit] = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.kind, 'address_book_entry_removed'));
      expect(audit).toBeDefined();
      expect(audit?.actor).toBe(ACTOR_B);
      const payload = audit?.payload as Record<string, unknown>;
      expect(payload.entryId).toBe(inserted.id);
      expect(payload.label).toBe('Acme');
      expect(payload.recipientAddress).toBe(ALICE);
    });

    it('throws AddressBookEntryNotFound when the entry never existed', async () => {
      await expect(
        deleteAddressBookEntry(db, {
          id: '00000000-0000-4000-8000-0000000000FE',
          treasuryId: TEST_TREASURY_ID,
          deletedBy: ACTOR_A,
        }),
      ).rejects.toBeInstanceOf(AddressBookEntryNotFound);
    });
  });

  describe('read helpers', () => {
    it('listAddressBookEntries returns rows for the treasury in created_at desc order', async () => {
      const first = await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'First',
        recipientAddress: ALICE,
        preApproved: false,
        createdBy: ACTOR_A,
      });
      // Brief wait so the second row's created_at is strictly later.
      await new Promise((r) => setTimeout(r, 10));
      const second = await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Second',
        recipientAddress: BOB,
        preApproved: true,
        createdBy: ACTOR_A,
      });
      const rows = await listAddressBookEntries(db, TEST_TREASURY_ID);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe(second.id);
      expect(rows[1]?.id).toBe(first.id);
    });

    it('getAddressBookEntryByLabel + getAddressBookEntryByAddress find or return null', async () => {
      const row = await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme Corp',
        recipientAddress: ALICE,
        preApproved: false,
        createdBy: ACTOR_A,
      });
      expect((await getAddressBookEntryByLabel(db, TEST_TREASURY_ID, 'Acme Corp'))?.id).toBe(
        row.id,
      );
      // Label lookup is exact — leading/trailing whitespace differs => no match.
      expect(await getAddressBookEntryByLabel(db, TEST_TREASURY_ID, ' Acme Corp')).toBeNull();
      expect((await getAddressBookEntryByAddress(db, TEST_TREASURY_ID, ALICE))?.id).toBe(row.id);
      expect(await getAddressBookEntryByAddress(db, TEST_TREASURY_ID, BOB)).toBeNull();
    });
  });

  describe('getAddressBookRecipientSet', () => {
    it('returns every recipient address regardless of pre_approved flag', async () => {
      await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Approved',
        recipientAddress: ALICE,
        preApproved: true,
        createdBy: ACTOR_A,
      });
      await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'NotApproved',
        recipientAddress: BOB,
        preApproved: false,
        createdBy: ACTOR_A,
      });
      const set = await getAddressBookRecipientSet(db, TEST_TREASURY_ID);
      expect(set.size).toBe(2);
      expect(set.has(ALICE)).toBe(true);
      expect(set.has(BOB)).toBe(true);
    });

    it('returns an empty set when the treasury has no entries (fail-closed contract)', async () => {
      const set = await getAddressBookRecipientSet(db, TEST_TREASURY_ID);
      expect(set.size).toBe(0);
    });
  });

  describe('getPreApprovedRecipientSet', () => {
    it('returns only addresses with pre_approved=true for the treasury', async () => {
      await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Acme',
        recipientAddress: ALICE,
        preApproved: true,
        createdBy: ACTOR_A,
      });
      await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'Beta',
        recipientAddress: BOB,
        preApproved: false,
        createdBy: ACTOR_A,
      });
      const set = await getPreApprovedRecipientSet(db, TEST_TREASURY_ID);
      expect(set.has(ALICE)).toBe(true);
      expect(set.has(BOB)).toBe(false);
      expect(set.size).toBe(1);
    });

    it('does not leak entries across treasuries (per-treasury isolation)', async () => {
      const otherId = '00000000-0000-4000-8000-0000000000A2';
      await db
        .insert(schema.treasuries)
        .values({
          id: otherId,
          name: 'AB Iso Other',
          walletAddress: 'So66666666666666666666666666666666666666666',
          turnkeySubOrgId: 'test-suborg-ab-iso-other',
          turnkeyWalletId: null,
          signerBackend: 'local',
          telegramChatId: null,
          telegramApproverIds: [],
          createdBy: null,
        })
        .onConflictDoNothing();

      // Pre-approved in the other treasury — must not appear in the
      // seed treasury's set.
      await insertAddressBookEntry(db, {
        treasuryId: otherId,
        label: 'Other Acme',
        recipientAddress: ALICE,
        preApproved: true,
        createdBy: ACTOR_A,
      });

      const seedSet = await getPreApprovedRecipientSet(db, TEST_TREASURY_ID);
      expect(seedSet.has(ALICE)).toBe(false);

      const otherSet = await getPreApprovedRecipientSet(db, otherId);
      expect(otherSet.has(ALICE)).toBe(true);
    });

    it('returns an empty set when the treasury has no pre-approved entries', async () => {
      await insertAddressBookEntry(db, {
        treasuryId: TEST_TREASURY_ID,
        label: 'NotApproved',
        recipientAddress: ALICE,
        preApproved: false,
        createdBy: ACTOR_A,
      });
      const set = await getPreApprovedRecipientSet(db, TEST_TREASURY_ID);
      expect(set.size).toBe(0);
    });
  });

  describe('cascade on treasury delete', () => {
    it('removes entries when their parent treasury is deleted', async () => {
      const tmpId = '00000000-0000-4000-8000-0000000000A3';
      await db
        .insert(schema.treasuries)
        .values({
          id: tmpId,
          name: 'AB Cascade Other',
          walletAddress: 'So77777777777777777777777777777777777777777',
          turnkeySubOrgId: 'test-suborg-ab-cascade-other',
          turnkeyWalletId: null,
          signerBackend: 'local',
          telegramChatId: null,
          telegramApproverIds: [],
          createdBy: null,
        })
        .onConflictDoNothing();
      const entry = await insertAddressBookEntry(db, {
        treasuryId: tmpId,
        label: 'Cascade Test',
        recipientAddress: ALICE,
        preApproved: true,
        createdBy: ACTOR_A,
      });

      // Delete dependent audit rows first (audit_logs.treasury_id is
      // NO ACTION by design — operators reconcile history before
      // archiving a treasury). The cascade we're proving here is the
      // address_book_entries → treasuries one.
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.treasuryId, tmpId));
      await db.delete(schema.treasuries).where(eq(schema.treasuries.id, tmpId));

      const survivors = await db
        .select()
        .from(schema.addressBookEntries)
        .where(eq(schema.addressBookEntries.id, entry.id));
      expect(survivors).toHaveLength(0);
    });
  });
});
