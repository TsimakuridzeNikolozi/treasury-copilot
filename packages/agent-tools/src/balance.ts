import type { Connection, PublicKey } from '@solana/web3.js';
import { getKaminoUsdcPosition } from '@tc/protocols/kamino';
import { getSaveUsdcPosition } from '@tc/protocols/save';
import { getWalletUsdcBalance } from '@tc/protocols/usdc';
import type { Venue } from '@tc/types';

// Minimum surface needed to validate a proposal against on-chain reality:
// the treasury wallet's free USDC and the supplied position in a given
// venue. Both return decimal-USDC strings so callers compare via Decimal,
// matching how amountUsdc is stored on action rows.
//
// Kept as an interface (not a concrete class) so the proposal layer can
// take a stub in tests without spinning up an RPC client. The production
// implementation is `createRpcBalanceReader`; tests use anything with the
// same shape.
export interface BalanceReader {
  walletUsdc(): Promise<string>;
  positionUsdc(venue: Venue): Promise<string>;
}

// Default production reader — reads live state via Solana RPC for the
// configured treasury. Constructed once per chat request inside buildTools
// so both the propose-tools and the read-tools share one Connection.
export function createRpcBalanceReader(connection: Connection, owner: PublicKey): BalanceReader {
  return {
    async walletUsdc() {
      const r = await getWalletUsdcBalance(connection, owner);
      return r.amountUsdc;
    },
    async positionUsdc(venue: Venue) {
      switch (venue) {
        case 'kamino': {
          const r = await getKaminoUsdcPosition(connection, owner);
          return r.amountUsdc;
        }
        case 'save': {
          const r = await getSaveUsdcPosition(connection, owner);
          return r.amountUsdc;
        }
        case 'drift':
        case 'marginfi':
          // M1 doesn't ship builders for these — the policy engine already
          // denies them via the allowlist before we ever reach the balance
          // check. If a future caller bypasses that gate, surface the gap
          // loudly rather than returning a fake "0".
          throw new Error(`balance reader: ${venue} positions not implemented (deferred)`);
      }
    },
  };
}
