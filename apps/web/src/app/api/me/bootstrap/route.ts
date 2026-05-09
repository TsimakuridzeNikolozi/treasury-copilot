import { env } from '@/env';
import type { BootstrapResponse } from '@/lib/api-types';
import { setActiveTreasuryCookie } from '@/lib/cookie-headers';
import { db } from '@/lib/db';
import { privy, verifyBearer } from '@/lib/privy';
import {
  addMembership,
  bootstrapUserCore,
  createTreasury,
  getTreasuryById,
  listTreasuriesForUser,
  schema,
} from '@tc/db';
import { provisionTreasury } from '@tc/turnkey-admin';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Bootstrap creates rows for arbitrary new DIDs — never cache the response.
export const dynamic = 'force-dynamic';

// POST /api/me/bootstrap
//
// Three-stage flow under a session-scoped advisory lock that bridges the
// Turnkey API call. See `apps/web/src/lib/active-treasury.ts` for the
// post-bootstrap session resolver, and `~/.claude/plans/sleepy-yawning-key.md`
// for the design rationale (why a session lock instead of the existing
// tx-scoped lock; what races it prevents; M3 reconciler scope).
//
// Implementation note: the session lock is acquired on a reserved
// postgres-js connection, but the queries themselves run through the
// pool-bound Drizzle `db`. Postgres advisory locks serialize callers
// across the database — a peer bootstrap's `pg_advisory_lock` on its own
// reserved connection blocks until the holder releases. We don't need
// the queries to share the same connection as the lock.
export async function POST(req: Request) {
  // Strict verify (JWT signature/expiry/issuer) — this is the one endpoint
  // that creates rows for arbitrary new DIDs, so a soft cookie check is
  // not enough.
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });
  const privyDid = auth.userId;

  // Pull the user's email authoritatively from Privy. `verifyAuthToken`
  // returns only the DID; `getUser({idToken})` is the rate-limit-safe form
  // (per the SDK's deprecation note on the bare `getUser(userId)` call).
  // Email may be null for SIWE/passkey-only logins; we tolerate that and
  // store null.
  let email: string | null = null;
  try {
    const header = req.headers.get('authorization') ?? '';
    const idToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (idToken) {
      const user = await privy.getUser({ idToken });
      email = user.email?.address ?? null;
    }
  } catch {
    // Email is metadata, not auth. The bearer already proved the DID.
    // Failing to fetch email shouldn't block bootstrap.
  }

  // Reserve a Postgres connection just for the session-scoped advisory
  // lock. The lock is held until pg_advisory_unlock in `finally`,
  // surviving the Turnkey HTTP call between stages. Queries run on the
  // pool-bound `db` — the lock serializes peers regardless of which
  // connection their queries land on.
  const reserved = await db.$client.reserve();
  try {
    // Acquire the session-scoped lock. Same hashtext key bootstrapUser
    // takes its tx-scoped lock on, so two concurrent bootstraps for the
    // same DID serialize here.
    await reserved`SELECT pg_advisory_lock(hashtext(${privyDid}))`;

    // Stage 1 — upsert user row + post-lock membership count under the
    // outer session lock. We call `bootstrapUserCore` instead of
    // `bootstrapUser` because the latter wraps in a tx + takes its own
    // tx-scoped advisory lock on hashtext(privyDid). With the SAME key
    // already held by our reserved connection's session lock, that
    // tx-scoped acquire on a different pool connection would block
    // forever — classic same-key, different-session deadlock. The Core
    // helper just upserts; correctness comes from our outer session lock.
    const user = await bootstrapUserCore(db, { privyDid, email });
    const memberships = await listTreasuriesForUser(db, user.id);
    if (memberships.length > 0) {
      // Idempotent re-bootstrap. Pick the most-recent treasury (the list
      // is ordered by createdAt desc) and short-circuit. `created: false`
      // tells the client to skip the spinner copy.
      const first = memberships[0];
      if (!first) {
        return jsonError(500, 'persistence_failed', 'membership row vanished mid-call');
      }
      const body: BootstrapResponse = {
        userId: user.id,
        activeTreasury: {
          id: first.treasury.id,
          name: first.treasury.name,
          walletAddress: first.treasury.walletAddress,
        },
        created: false,
      };
      return jsonWithCookie(body, setActiveTreasuryCookie(first.treasury.id));
    }

    // Stage 2 — Turnkey provisioning (no tx, lock still held). Skipped in
    // local mode because the wallet-mismatch check at
    // packages/signer/src/index.ts:227-232 would reject any non-seed
    // treasury anyway when SIGNER_BACKEND=local.
    const provision = await stage2Provision(privyDid, email);
    if (provision.kind === 'failed') {
      // 502 leaves the user row in place so a retry on next sign-in
      // restarts cleanly. The lock releases in `finally`.
      return jsonError(502, 'turnkey_unavailable', provision.error);
    }

    // Stage 3 — persistence (own tx). Single transaction so the treasury
    // row, membership row, and audit row land atomically. If anything
    // throws here in turnkey mode, the just-provisioned sub-org is
    // orphaned in Turnkey — operator must drop it via the console (M3
    // adds an automatic reconciler).
    try {
      const result = await db.transaction(async (tx) => {
        let treasuryId: string;
        let treasuryName: string;
        let walletAddress: string;
        if (provision.kind === 'turnkey') {
          const t = await createTreasury(tx, {
            name: 'Personal',
            walletAddress: provision.result.walletAddress,
            turnkeySubOrgId: provision.result.subOrgId,
            turnkeyWalletId: provision.result.walletId,
            signerBackend: 'turnkey',
            createdBy: user.id,
          });
          treasuryId = t.id;
          treasuryName = t.name;
          walletAddress = t.walletAddress;
          await tx.insert(schema.auditLogs).values({
            kind: 'treasury_created',
            treasuryId,
            actor: privyDid,
            payload: {
              name: t.name,
              walletAddress: t.walletAddress,
              turnkeySubOrgId: provision.result.subOrgId,
            },
          });
        } else {
          // Local mode — attach to the seed treasury. The seed row was
          // written by `pnpm db:seed-m2`; missing it is an operator
          // setup error.
          const seed = await getTreasuryById(tx, env.SEED_TREASURY_ID);
          if (!seed) {
            throw new Error(`SEED_TREASURY_ID ${env.SEED_TREASURY_ID} does not exist`);
          }
          treasuryId = seed.id;
          treasuryName = seed.name;
          walletAddress = seed.walletAddress;
          // Distinct kind from `'treasury_created'` so the dev/prod
          // divergence is grep-able later (M3 history page can filter
          // these out of the org timeline).
          await tx.insert(schema.auditLogs).values({
            kind: 'membership_added',
            treasuryId,
            actor: privyDid,
            payload: { treasuryId, userId: user.id, role: 'owner', mode: 'local' },
          });
        }
        await addMembership(tx, { treasuryId, userId: user.id, role: 'owner' });
        return { treasuryId, treasuryName, walletAddress };
      });

      const body: BootstrapResponse = {
        userId: user.id,
        activeTreasury: {
          id: result.treasuryId,
          name: result.treasuryName,
          walletAddress: result.walletAddress,
        },
        created: true,
      };
      return jsonWithCookie(body, setActiveTreasuryCookie(result.treasuryId));
    } catch (err) {
      // Stage 3 failed AFTER Turnkey returned a sub-org (turnkey mode) or
      // the seed lookup succeeded (local mode). Log enough for an
      // operator to reconcile and 500 — the user can retry.
      if (provision.kind === 'turnkey') {
        console.error(
          `[bootstrap] stage 3 failed for ${privyDid}; orphaned subOrgId=${provision.result.subOrgId} walletAddress=${provision.result.walletAddress}`,
          err,
        );
      } else {
        console.error(`[bootstrap] stage 3 failed for ${privyDid} (local mode)`, err);
      }
      return jsonError(500, 'persistence_failed', err instanceof Error ? err.message : String(err));
    }
  } finally {
    // Release the session lock and return the connection to the pool.
    // `.catch` on the unlock so a connection-already-broken state can't
    // mask the real route error.
    await reserved`SELECT pg_advisory_unlock(hashtext(${privyDid}))`.catch(() => {});
    reserved.release();
  }
}

type Stage2Result =
  | { kind: 'turnkey'; result: { subOrgId: string; walletId: string; walletAddress: string } }
  | { kind: 'local' }
  | { kind: 'failed'; error: string };

async function stage2Provision(privyDid: string, email: string | null): Promise<Stage2Result> {
  if (env.SIGNER_BACKEND !== 'turnkey') {
    return { kind: 'local' };
  }
  // The web env's cross-field refinement enforces that all three are
  // present when SIGNER_BACKEND=turnkey, so these falsy fallbacks are
  // unreachable at runtime. Kept defensive because TS sees them as
  // optional.
  if (
    !env.TURNKEY_PARENT_ORG_ID ||
    !env.TURNKEY_PARENT_API_PUBLIC_KEY ||
    !env.TURNKEY_PARENT_API_PRIVATE_KEY
  ) {
    return { kind: 'failed', error: 'TURNKEY_PARENT_* env vars are missing' };
  }
  try {
    const result = await provisionTreasury(
      {
        organizationId: env.TURNKEY_PARENT_ORG_ID,
        apiPublicKey: env.TURNKEY_PARENT_API_PUBLIC_KEY,
        apiPrivateKey: env.TURNKEY_PARENT_API_PRIVATE_KEY,
        baseUrl: env.TURNKEY_PARENT_BASE_URL ?? 'https://api.turnkey.com',
      },
      { ownerEmail: email, displayName: 'Personal' },
    );
    return { kind: 'turnkey', result };
  } catch (err) {
    console.error(`[bootstrap] Turnkey provisioning failed for ${privyDid}`, err);
    return {
      kind: 'failed',
      error: err instanceof Error ? err.message : 'Turnkey provisioning failed',
    };
  }
}

function jsonWithCookie(body: BootstrapResponse, setCookie: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': setCookie,
    },
  });
}

function jsonError(status: number, error: string, detail?: string): Response {
  return new Response(JSON.stringify({ error, ...(detail ? { detail } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
