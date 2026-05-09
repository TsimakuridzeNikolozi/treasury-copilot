// Shared request/response shapes for routes whose payloads cross the
// server/client boundary. Keeping them here (instead of duplicating in
// route handlers and consuming pages) ensures the contract drifts
// in lockstep — adding a field updates both ends at once.

export interface BootstrapResponse {
  userId: string;
  activeTreasury: { id: string; name: string; walletAddress: string };
  // True only when stages 2+3 ran (a fresh personal treasury was minted).
  // False on the idempotent re-bootstrap path. The landing page hides the
  // descriptive "creating wallet" copy when this is false so steady-state
  // visits don't flash a misleading spinner.
  created: boolean;
}
