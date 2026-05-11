import type { AddressBookEntryRow } from '@tc/db';

// Wire shape returned by GET/POST/PATCH /api/treasury/address-book. Defined
// outside the route handlers so the type has a single source of truth: the
// route exports `toDto` (which depends on @tc/db's row type), but a client
// component can import the type without dragging the server-only DB package
// into its bundle. Before this module existed the shape was duplicated
// between the route and the AddressBookTable component, with no
// compile-time binding to keep them in sync.
//
// ISO-string timestamps so the component formats predictably without
// timezone surprises on rehydration. `createdBy` is the raw Privy DID —
// safe for the owner to see (they already have audit_logs visibility).
export interface AddressBookEntryDto {
  id: string;
  label: string;
  recipientAddress: string;
  tokenMint: string;
  notes: string | null;
  preApproved: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// Pure row → DTO conversion. Server-only because it imports the row
// type from @tc/db; clients receive the DTO over JSON and never need to
// run this. Kept here next to the type so a field add/remove edits one
// file, not two.
export function addressBookEntryRowToDto(row: AddressBookEntryRow): AddressBookEntryDto {
  return {
    id: row.id,
    label: row.label,
    recipientAddress: row.recipientAddress,
    tokenMint: row.tokenMint,
    notes: row.notes,
    preApproved: row.preApproved,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
