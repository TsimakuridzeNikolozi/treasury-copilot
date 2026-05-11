import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import { supplyRateBnToApyDecimal } from './jupiter';

// Guards the two non-obvious things in getJupiterUsdcSupplyApy: the
// SUPPLY_RATE_PRECISION scale (1e4 = 100% APR) and the APR → APY
// continuous-compounding conversion. Both would silently drift wrong if
// the SDK changed shape underneath us — these tests are the tripwire.
describe('supplyRateBnToApyDecimal', () => {
  it('returns 0 APY for a 0 supplyRate', () => {
    expect(supplyRateBnToApyDecimal(new BN(0))).toBe(0);
  });

  it('converts 8% APR (supplyRate=800 @ 1e4 scale) to ~8.33% APY via continuous compounding', () => {
    // 8% APR → e^0.08 - 1 ≈ 0.0832871...
    const apy = supplyRateBnToApyDecimal(new BN(800));
    expect(apy).toBeCloseTo(Math.expm1(0.08), 12);
    expect(apy).toBeGreaterThan(0.083);
    expect(apy).toBeLessThan(0.084);
  });

  it('keeps APY > APR for any positive rate (compounding only adds)', () => {
    // 5% APR
    const supplyRate = new BN(500);
    const apr = supplyRate.toNumber() / 1e4;
    const apy = supplyRateBnToApyDecimal(supplyRate);
    expect(apy).toBeGreaterThan(apr);
  });

  it('throws when the derived APR exceeds 100% (likely SDK scale regression)', () => {
    // If the scale silently changed to 1e2 = 100%, a real 5% APR (=500
    // in old scale) would surface as 500/100 = 5.0 = 500% APR. Catch.
    expect(() => supplyRateBnToApyDecimal(new BN(20000))).toThrow(/scale/);
  });

  it('throws on negative input (defense against future API regressions)', () => {
    // BN.fromNumber(-1) — confirm the [0, 1] range check is symmetric.
    expect(() => supplyRateBnToApyDecimal(new BN(-1))).toThrow(/range/);
  });
});
