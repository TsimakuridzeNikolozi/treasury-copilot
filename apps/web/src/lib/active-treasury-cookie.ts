// Edge-safe constant: middleware (which can't import the postgres-js DB
// helpers) and lib/active-treasury.ts (server runtime) both consume the
// same literal from here. Mirrors the M1 PRIVY_COOKIE split — keeping
// this file SDK-free is what lets middleware reference it without
// dragging non-edge-compatible code into the Edge runtime bundle.
export const ACTIVE_TREASURY_COOKIE = 'tc_active_treasury';
