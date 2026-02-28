import { describe, expect, it } from 'vitest';
import { createRandomSource } from './calculations';
import {
  buildCashflowArrays,
  detectRegimes,
  drawShapedStandardScore,
  findRetirementBalanceTarget,
  incomeAtAge,
  runMonteCarloSimulation,
  spendingAtAge,
  type IncomeSource,
  type RetirementInput,
  type SpendingPeriod
} from './retirementEngine';

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

  it('produces shaped-score moments in expected direction', () => {
    const rng = createRandomSource(12345);
    const draws = Array.from({ length: 100_000 }, () => drawShapedStandardScore(1.0, 6.0, rng));
    const moments = sampleMoments(draws);

    expect(Math.abs(moments.mean)).toBeLessThan(0.15);
    expect(moments.std).toBeGreaterThan(0.8);
    expect(moments.std).toBeLessThan(1.6);
    expect(moments.skewness).toBeGreaterThan(0.1);
    expect(moments.kurtosis).toBeGreaterThan(3.3);
  });

  it('finds P95 retirement balance target from handcrafted outcomes', () => {
    const retirementBalances = [100, 120, 140, 160, 180, 200];
    const endingBalances = [0, 0, 50, 80, 120, 160];
    const target = findRetirementBalanceTarget(retirementBalances, endingBalances, 0.95);
    expect(target).toBe(140);
  });
});

describe('runMonteCarloSimulation smoke', () => {
  it('returns stable output shape and sane median with seed', () => {
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
    const result = runMonteCarloSimulation(input, spendingPeriods, incomeSources, [], months, retireMonth);

    expect(result.simCount).toBeGreaterThanOrEqual(400);
    expect(result.simulation.months).toBe(months);
    expect(result.simulation.percentiles.p50.length).toBe(months);
    expect(result.stats.successProbability).toBeGreaterThanOrEqual(0);
    expect(result.stats.successProbability).toBeLessThanOrEqual(1);
    expect(result.stats.finalMedian).toBeGreaterThan(0);
  });
});
