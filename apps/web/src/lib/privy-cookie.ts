// Edge-safe constant: middleware (which can't import the Privy SDK) and
// lib/privy.ts (which can) both consume the same literal from here. Keeping
// this file SDK-free is what lets middleware reference it without dragging
// non-edge-compatible code into the Edge runtime bundle.
export const PRIVY_COOKIE = 'privy-token';
