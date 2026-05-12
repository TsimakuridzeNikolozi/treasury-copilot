import type { ProposedActionRow } from '@tc/db';

// M4 — transaction history wire shape. Server-only producer; client receives
// the DTO over JSON and never touches the row type or the @tc/db package.
// Kept separate from address-book.ts so each surface owns its own DTO file
// (matches the pattern established there).
//
// Counterparty derivation:
// - deposit / withdraw: the venue (kamino, save, jupiter, etc).
// - rebalance: `fromVenue → toVenue` displayed by the client; we send both
//   fields raw so the client can format consistently with the snapshot tool.
// - transfer: the recipient address; `recipientLabel` is resolved via the
//   address book at DTO time, so a rename in /settings is reflected on the
//   next page load. Null when the recipient is not in the book.
//
// `failureReason` is populated for `failed` rows by reading the most recent
// status_transition audit row's payload (where the executor stamps `error`
// and `errorCode`); rather than JOIN every row, the route layer fetches
// failures in a second batch query keyed by id. Keep this field on the DTO
// so the client always sees the same shape regardless of status.
export type HistoryActionKind = 'deposit' | 'withdraw' | 'rebalance' | 'transfer';

export type HistoryActionStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'denied'
  | 'executed'
  | 'failed';

export interface HistoryEntryDto {
  id: string;
  kind: HistoryActionKind;
  status: HistoryActionStatus;
  amountUsdc: string;
  // Populated for deposit, withdraw, rebalance(from).
  venue: string | null;
  // Rebalance only — the destination venue. Null for other kinds.
  toVenue: string | null;
  // Transfer only — the raw recipient address.
  recipientAddress: string | null;
  // Transfer only — address book label, looked up by address at DTO time
  // (not snapshotted onto the action). Null when no matching book entry.
  recipientLabel: string | null;
  // Transfer only — optional on-chain memo from the action payload.
  memo: string | null;
  txSignature: string | null;
  createdAt: string;
  executedAt: string | null;
  failureReason: string | null;
}

export interface ProposedActionRowToHistoryDtoCtx {
  // Map from `recipientAddress` (base58) → label, sourced from the
  // treasury's current address book. Built once per page in the route
  // layer so we don't issue an N+1 lookup per row.
  recipientLabels?: ReadonlyMap<string, string>;
  // Map from action id → human-readable failure reason. Populated only
  // for rows whose status is 'failed' (other statuses skip the lookup).
  // Built once per page from a single batched audit-log query.
  failureReasons?: ReadonlyMap<string, string>;
}

export function proposedActionRowToHistoryDto(
  row: ProposedActionRow,
  ctx: ProposedActionRowToHistoryDtoCtx = {},
): HistoryEntryDto {
  const payload = row.payload;
  // Discriminated-union narrowing without a switch — the schema's row type
  // already encodes which optional fields each kind carries; we project
  // them flat onto the DTO so the client can render with a single shape.
  let venue: string | null = null;
  let toVenue: string | null = null;
  let recipientAddress: string | null = null;
  let recipientLabel: string | null = null;
  let memo: string | null = null;
  switch (payload.kind) {
    case 'deposit':
    case 'withdraw':
      venue = payload.venue;
      break;
    case 'rebalance':
      venue = payload.fromVenue;
      toVenue = payload.toVenue;
      break;
    case 'transfer':
      recipientAddress = payload.recipientAddress;
      recipientLabel = ctx.recipientLabels?.get(payload.recipientAddress) ?? null;
      memo = payload.memo ?? null;
      break;
  }

  return {
    id: row.id,
    kind: payload.kind,
    status: row.status,
    amountUsdc: row.amountUsdc,
    venue,
    toVenue,
    recipientAddress,
    recipientLabel,
    memo,
    txSignature: row.txSignature,
    createdAt: row.createdAt.toISOString(),
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    failureReason: row.status === 'failed' ? (ctx.failureReasons?.get(row.id) ?? null) : null,
  };
}
