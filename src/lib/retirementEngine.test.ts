import { describe, expect, it } from 'vitest';
import { createRandomSource } from './calculations';
import {
  buildCashflowArrays,
  detectRegimes,
  drawCornishFisherScore,
  findRetirementBalanceTarget,
  incomeAtAge,
  runMonteCarloSimulation,
  spendingAtAge,
  type IncomeSource,
  type RetirementInput,
  type SpendingPeriod
} from './retirementEngine';
import init, { run_monte_carlo } from 'rust-engine';
import { readFileSync } from 'fs';
import { join } from 'path';

let wasmReady = false;
async function ensureWasm() {
  if (!wasmReady) {
    const wasmBuffer = readFileSync(join(process.cwd(), 'rust-engine', 'pkg', 'rust_engine_bg.wasm'));
    await init(wasmBuffer);
    wasmReady = true;
  }
}

function sampleMoments(values: number[]): { mean: number; std: number; skewness: number; kurtosis: number } {
  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const std = Math.sqrt(Math.max(variance, 0));

  if (std <= 1e-12) {
    return { mean, std: 0, skewness: 0, kurtosis: 3 };
  }

  const m3 = values.reduce((sum, value) => sum + (value - mean) ** 3, 0) / n;
  const m4 = values.reduce((sum, value) => sum + (value - mean) ** 4, 0) / n;
  return {
    mean,
    std,
    skewness: m3 / std ** 3,
    kurtosis: m4 / std ** 4
  };
}

describe('retirementEngine cashflow boundaries', () => {
  const spendingPeriods: SpendingPeriod[] = [
    { id: 's1', label: 'Living', fromAge: 35, toAge: 40, yearlyAmount: 12000, inflationAdjusted: true },
    { id: 's2', label: 'Nominal', fromAge: 36, toAge: 37, yearlyAmount: 12000, inflationAdjusted: false }
  ];
  const incomeSources: IncomeSource[] = [
    { id: 'i1', label: 'Salary', fromAge: 35, toAge: 36, yearlyAmount: 24000, inflationAdjusted: true },
    { id: 'i2', label: 'Nominal income', fromAge: 36, toAge: 37, yearlyAmount: 12000, inflationAdjusted: false }
  ];

  it('treats fromAge as inclusive and toAge as exclusive for spendingAtAge', () => {
    expect(spendingAtAge(34.99, spendingPeriods)).toBe(0);
    expect(spendingAtAge(35, spendingPeriods)).toBe(12000);
    expect(spendingAtAge(39.999, spendingPeriods)).toBe(12000);
    expect(spendingAtAge(40, spendingPeriods)).toBe(0);
  });

  it('applies inflation index only to non-inflation-adjusted income', () => {
    expect(incomeAtAge(35.5, incomeSources, 1.5)).toBeCloseTo(24000, 8);
    expect(incomeAtAge(36.1, incomeSources, 2)).toBeCloseTo(6000, 8);
  });

  it('builds deterministic monthly flows and lump sums', () => {
    const input: RetirementInput = {
      currentAge: 35,
      retirementAge: 40,
      simulateUntilAge: 37,
      currentSavings: 100000,
      meanReturn: 0.06,
      returnVariability: 0.15,
      returnSkewness: 0,
      returnKurtosis: 3,
      equityBondCorrelation: -0.1,
      inflationMean: 0.02,
      inflationVariability: 0.01,
      inflationSkewness: 0,
      inflationKurtosis: 3,
      annualFeePercent: 0,
      taxOnGainsPercent: 0,
      safeWithdrawalRate: 0.04,
      simulations: 500,
      regimeModel: {
        stayGrowth: 0.9,
        stayCrisis: 0.7,
        growthMean: 0.08,
        growthStd: 0.14,
        crisisMean: -0.12,
        crisisStd: 0.22
      }
    };

    const { monthlyNetFlow, lumpSumByMonth } = buildCashflowArrays(
      input,
      [{ id: 's', label: 'Living', fromAge: 35, toAge: 37, yearlyAmount: 12000, inflationAdjusted: true }],
      [{ id: 'i', label: 'Salary', fromAge: 35, toAge: 36, yearlyAmount: 24000, inflationAdjusted: true }],
      [{ id: 'l1', label: 'Bonus', age: 35.5, amount: 1200 }],
      24
    );

    expect(monthlyNetFlow[0]).toBeCloseTo(1000, 8);
    expect(monthlyNetFlow[13]).toBeCloseTo(-1000, 8);
    expect(lumpSumByMonth[6]).toBeCloseTo(1200, 8);
    expect(lumpSumByMonth[5]).toBeCloseTo(0, 8);
  });
});

describe('retirementEngine stochastic helpers', () => {
  it('detects crisis periods in a synthetic annual series', () => {
    const annualReturns = [0.12, 0.1, 0.09, -0.28, -0.2, 0.03, 0.08, -0.25, -0.18, 0.07, 0.09];
    const labels = detectRegimes(annualReturns);
    expect(labels.length).toBe(annualReturns.length);
    expect(labels[3]).toBe(1);
    expect(labels[4]).toBe(1);
    expect(labels[7]).toBe(1);
  });

  describe('drawCornishFisherScore', () => {
    it('should generate arrays with approximate target moments', () => {
      const rng = createRandomSource(10101);
      const skewness = -1.2;
      const kurtosis = 6;
      const samples = 100000;
      const results: number[] = new Array(samples);
      for (let i = 0; i < samples; i++) {
        results[i] = drawCornishFisherScore(skewness, kurtosis, rng);
      }

      const moments = sampleMoments(results);

      // Cornish Fisher provides an approximation, so exact moments won't be perfectly identical 
      // but should be in the proper direction and magnitude
      expect(moments.mean).toBeCloseTo(0, 1);
      expect(moments.std).toBeCloseTo(1, 1);

      // Skewness should be distinctly negative
      expect(moments.skewness).toBeLessThan(-0.5);

      // Kurtosis should be distinctly fat-tailed (> 3)
      expect(moments.kurtosis).toBeGreaterThan(4);
    });
  });

  it('finds P95 retirement balance target from handcrafted outcomes', () => {
    const retirementBalances = [100, 120, 140, 160, 180, 200];
    const successFlags = [false, false, true, true, true, true];
    const target = findRetirementBalanceTarget(retirementBalances, successFlags, 0.95);
    expect(target).toBe(140);
  });
});

describe('annual net-gain taxation', () => {
  // Regression guard for TODO 0.2: tax must apply annually to net gains, not to every
  // positive month. With a volatile monthly history (+4%/−2% alternating, ~12%/yr
  // pre-tax), upside-only monthly taxation at 15% produced ~3.5–4%/yr of drag; annual
  // net-gain taxation should produce ~1.5–2%/yr. Same seed ⇒ identical return paths,
  // so the drag measurement is exact per-path (the tax code consumes no RNG draws).
  it('produces ~rate×gain drag per year, not the old monthly-upside drag', () => {
    const monthlyPattern: number[] = [];
    for (let i = 0; i < 120; i++) monthlyPattern.push(i % 2 === 0 ? 0.04 : -0.02);

    const baseInput: RetirementInput = {
      currentAge: 35,
      retirementAge: 64,
      simulateUntilAge: 65,
      currentSavings: 1_000_000,
      meanReturn: 0.12,
      returnVariability: 0.1,
      returnSkewness: 0,
      returnKurtosis: 3,
      equityBondCorrelation: 0,
      inflationMean: 0,
      inflationVariability: 0,
      inflationSkewness: 0,
      inflationKurtosis: 3,
      annualFeePercent: 0,
      taxOnGainsPercent: 0,
      safeWithdrawalRate: 0.04,
      simulations: 500,
      seed: 4242,
      regimeModel: {
        stayGrowth: 0.92,
        stayCrisis: 0.68,
        growthMean: 0.12,
        growthStd: 0.1,
        crisisMean: -0.1,
        crisisStd: 0.2
      },
      historicalAnnualReturns: undefined,
      historicalMonthlyReturns: monthlyPattern
    };

    const months = (baseInput.simulateUntilAge - baseInput.currentAge) * 12;
    const retireMonth = (baseInput.retirementAge - baseInput.currentAge) * 12;
    const years = months / 12;

    const noTax = runMonteCarloSimulation({ ...baseInput }, [], [], [], months, retireMonth);
    const withTax = runMonteCarloSimulation(
      { ...baseInput, taxOnGainsPercent: 0.15 },
      [],
      [],
      [],
      months,
      retireMonth
    );

    const medianNoTax = noTax.stats.finalMedian;
    const medianWithTax = withTax.stats.finalMedian;
    expect(medianWithTax).toBeLessThan(medianNoTax);

    const effectiveAnnualDrag = 1 - Math.pow(medianWithTax / medianNoTax, 1 / years);
    expect(effectiveAnnualDrag).toBeGreaterThan(0.008);
    expect(effectiveAnnualDrag).toBeLessThan(0.025);
  });
});

describe('withdrawal strategies', () => {
  // Guardrails and percent-of-portfolio adapt spending downward in bad markets, so both
  // should yield a higher success probability than fixed real spending on an otherwise
  // identical, stressed scenario (same seed ⇒ identical return paths).
  function stressedInput(strategy?: RetirementInput['withdrawalStrategy']): RetirementInput {
    // ~5.4%/yr nominal with a periodic -9% crash month for volatility; at 900k savings
    // and 40k spend the fixed strategy succeeds ~50% of the time, leaving headroom for
    // the adaptive strategies to demonstrably improve on it.
    const monthlyPattern: number[] = [];
    for (let i = 0; i < 240; i++) monthlyPattern.push(i % 12 === 0 ? -0.09 : 0.013);
    return {
      currentAge: 60,
      retirementAge: 60,
      simulateUntilAge: 90,
      currentSavings: 900_000,
      meanReturn: 0.054,
      returnVariability: 0.14,
      returnSkewness: 0,
      returnKurtosis: 3,
      equityBondCorrelation: 0,
      inflationMean: 0.02,
      inflationVariability: 0.01,
      inflationSkewness: 0,
      inflationKurtosis: 3,
      annualFeePercent: 0,
      taxOnGainsPercent: 0,
      safeWithdrawalRate: 0.04,
      simulations: 2000,
      seed: 777,
      withdrawalStrategy: strategy,
      regimeModel: {
        stayGrowth: 0.92,
        stayCrisis: 0.68,
        growthMean: 0.054,
        growthStd: 0.12,
        crisisMean: -0.1,
        crisisStd: 0.22
      },
      historicalMonthlyReturns: monthlyPattern
    };
  }

  const spending: SpendingPeriod[] = [
    { id: 'sp-default', label: 'Living', fromAge: 60, toAge: 90, yearlyAmount: 40000, inflationAdjusted: true }
  ];
  const months = 360;
  const retireMonth = 0;

  it('guardrails and percent-of-portfolio reduce ruin vs fixed spending', () => {
    const fixed = runMonteCarloSimulation(stressedInput({ kind: 'fixed' }), spending, [], [], months, retireMonth);
    const guardrails = runMonteCarloSimulation(
      stressedInput({ kind: 'guardrails', guardrailBand: 0.2, adjustment: 0.1, spendingFloor: 0.6, spendingCeiling: 1.4 }),
      spending, [], [], months, retireMonth
    );
    const percent = runMonteCarloSimulation(
      stressedInput({ kind: 'percentOfPortfolio', withdrawalPercent: 0.045, spendingFloor: 0.5, spendingCeiling: 1.5 }),
      spending, [], [], months, retireMonth
    );

    expect(guardrails.stats.successProbability).toBeGreaterThan(fixed.stats.successProbability);
    expect(percent.stats.successProbability).toBeGreaterThanOrEqual(fixed.stats.successProbability);
  });

  it('omitting the strategy behaves like fixed spending', () => {
    const noStrategy = runMonteCarloSimulation(stressedInput(undefined), spending, [], [], months, retireMonth);
    const fixed = runMonteCarloSimulation(stressedInput({ kind: 'fixed' }), spending, [], [], months, retireMonth);
    expect(noStrategy.stats.finalMedian).toBeCloseTo(fixed.stats.finalMedian, 6);
  });
});

describe('runMonteCarloSimulation smoke', () => {
  it('returns stable output shape and sane median with seed', async () => {
    const input: RetirementInput = {
      currentAge: 35,
      retirementAge: 50,
      simulateUntilAge: 65,
      currentSavings: 250000,
      meanReturn: 0.07,
      returnVariability: 0.16,
      returnSkewness: 0,
      returnKurtosis: 3,
      equityBondCorrelation: -0.1,
      inflationMean: 0.02,
      inflationVariability: 0.02,
      inflationSkewness: 0,
      inflationKurtosis: 3,
      annualFeePercent: 0.005,
      taxOnGainsPercent: 0.15,
      safeWithdrawalRate: 0.04,
      simulations: 500,
      seed: 20260227,
      regimeModel: {
        stayGrowth: 0.92,
        stayCrisis: 0.68,
        growthMean: 0.09,
        growthStd: 0.14,
        crisisMean: -0.12,
        crisisStd: 0.24
      },
      historicalAnnualReturns: [0.14, 0.1, 0.08, 0.18, -0.22, 0.07, 0.03, -0.15, 0.12, 0.11, 0.06, 0.09, -0.2, 0.16, 0.05, 0.04, 0.13, -0.12, 0.1, 0.08, 0.09, 0.07, -0.18, 0.15, 0.1],
      historicalMonthlyReturns: undefined
    };

    const spendingPeriods: SpendingPeriod[] = [
      { id: 'sp-default', label: 'Living expenses', fromAge: 35, toAge: 65, yearlyAmount: 28000, inflationAdjusted: true }
    ];
    const incomeSources: IncomeSource[] = [
      { id: 'is-default', label: 'Salary', fromAge: 35, toAge: 50, yearlyAmount: 55000, inflationAdjusted: true },
      { id: 'is-pension', label: 'Pension', fromAge: 60, toAge: 65, yearlyAmount: 12000, inflationAdjusted: true }
    ];

    const months = (input.simulateUntilAge - input.currentAge) * 12;
    const retireMonth = (input.retirementAge - input.currentAge) * 12;

    await ensureWasm();
    const result = run_monte_carlo(input, spendingPeriods, incomeSources, [], months, retireMonth);

    expect(result.simCount).toBeGreaterThanOrEqual(400);
    expect(result.simulation.months).toBe(months);
    expect(result.simulation.percentiles.p50.length).toBe(months);
    expect(result.stats.successProbability).toBeGreaterThanOrEqual(0);
    expect(result.stats.successProbability).toBeLessThanOrEqual(1);
    expect(result.stats.finalMedian).toBeGreaterThan(0);
  });
});
