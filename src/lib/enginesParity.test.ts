/**
 * Cross-engine parity: TypeScript reference engine vs the Rust/WASM production engine.
 *
 * The production simulation runs in Rust; `retirementEngine.ts` is kept as the readable
 * reference implementation. Both must stay behaviourally identical, and historically
 * they did drift (the `taxOnGainsPercent ?? annualDrag` fallback once existed only in
 * the TS engine).
 *
 * Two design notes:
 *
 * 1. **Intermediate series, not just headline stats.** A summary-level comparison is a
 *    weak test — a bug can move a whole distribution while leaving a median intact. These
 *    assertions walk the full per-month percentile bands, the sequence-risk buckets and
 *    the entire ruin surface.
 *
 * 2. **Parity is not correctness.** Both engines shared the year-boundary reset bug fixed
 *    in 2026-07; a parity test cannot catch a bug that was faithfully mirrored. Its job is
 *    to stop the two implementations diverging as features land, which is why every
 *    feature added to the engines gets a scenario here.
 *
 * The seeded PRNG streams are bit-identical across the two engines, so results agree to
 * within a few ULP; the tolerances below are correspondingly tight, and a real drift will
 * blow through them by orders of magnitude.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createRandomSource } from './calculations';
import {
  runMonteCarloSimulation,
  type IncomeSource,
  type LumpSumEvent,
  type RetirementInput,
  type SpendingPeriod
} from './retirementEngine';
import init, {
  debug_normal_sequence,
  debug_random_sequence,
  run_monte_carlo
} from 'rust-engine';
import { readFileSync } from 'fs';
import { join } from 'path';

const RELATIVE_TOLERANCE = 1e-9;

beforeAll(async () => {
  await init(readFileSync(join(process.cwd(), 'rust-engine', 'pkg', 'rust_engine_bg.wasm')));
});

/** Scale-aware comparison: relative for large magnitudes, absolute near zero. */
function expectClose(actual: number, expected: number, label: string): void {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  const relative = Math.abs(actual - expected) / scale;
  if (relative > RELATIVE_TOLERANCE) {
    throw new Error(
      `${label}: engines diverged — TS ${expected}, Rust ${actual} (relative ${relative.toExponential(3)})`
    );
  }
  expect(relative).toBeLessThanOrEqual(RELATIVE_TOLERANCE);
}

function expectSeriesClose(actual: number[], expected: number[], label: string): void {
  expect(actual.length, `${label}: length`).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) {
    expectClose(actual[index], expected[index], `${label}[${index}]`);
  }
}

// A history with a periodic drawdown so regime detection, block bootstrapping and the
// crisis pool all get exercised rather than sampling a flat series.
function monthlyHistory(): number[] {
  const series: number[] = [];
  for (let index = 0; index < 300; index++) {
    series.push(index % 7 === 0 ? -0.03 : 0.012);
  }
  return series;
}

function monthlyInflationHistory(): number[] {
  const series: number[] = [];
  for (let index = 0; index < 300; index++) {
    // Anti-correlated with the drawdown months above, and persistent within each year.
    series.push(index % 7 === 0 ? 0.009 : 0.0015);
  }
  return series;
}

function annualHistory(): number[] {
  return [
    0.14, 0.1, 0.08, 0.18, -0.22, 0.07, 0.03, -0.15, 0.12, 0.11, 0.06, 0.09, -0.2, 0.16,
    0.05, 0.04, 0.13, -0.12, 0.1, 0.08, 0.09, 0.07, -0.18, 0.15, 0.1, 0.02, -0.05, 0.19
  ];
}

const CURRENT_AGE = 40;
const RETIREMENT_AGE = 62;
const UNTIL_AGE = 78;
const MONTHS = (UNTIL_AGE - CURRENT_AGE) * 12;
const RETIRE_MONTH = (RETIREMENT_AGE - CURRENT_AGE) * 12;

function baseInput(overrides: Partial<RetirementInput> = {}): RetirementInput {
  return {
    simulationMode: 'historical',
    historicalMomentTargeting: false,
    currentAge: CURRENT_AGE,
    retirementAge: RETIREMENT_AGE,
    simulateUntilAge: UNTIL_AGE,
    currentSavings: 320_000,
    meanReturn: 0.072,
    returnVariability: 0.153,
    returnSkewness: -0.2,
    returnKurtosis: 3.6,
    equityBondCorrelation: -0.1,
    inflationMean: 0.021,
    inflationVariability: 0.012,
    inflationSkewness: 0.1,
    inflationKurtosis: 3.2,
    inflationCrisisSpread: 0.015,
    blockLength: 6,
    annualFeePercent: 0.005,
    taxOnGainsPercent: 0.15,
    safeWithdrawalRate: 0.04,
    simulations: 400,
    seed: 987654,
    regimeModel: {
      stayGrowth: 0.92,
      stayCrisis: 0.68,
      growthMean: 0.09,
      growthStd: 0.14,
      crisisMean: -0.12,
      crisisStd: 0.24
    },
    historicalAnnualReturns: annualHistory(),
    historicalMonthlyReturns: monthlyHistory(),
    ...overrides
  };
}

const spendingPeriods: SpendingPeriod[] = [
  { id: 'sp-default', label: 'Living', fromAge: CURRENT_AGE, toAge: UNTIL_AGE, yearlyAmount: 34_000, inflationAdjusted: true },
  { id: 'sp-travel', label: 'Travel', fromAge: 63, toAge: 70, yearlyAmount: 9_000, inflationAdjusted: true },
  { id: 'sp-nominal', label: 'Fixed mortgage', fromAge: CURRENT_AGE, toAge: 55, yearlyAmount: 7_200, inflationAdjusted: false }
];

const incomeSources: IncomeSource[] = [
  { id: 'is-default', label: 'Salary', fromAge: CURRENT_AGE, toAge: RETIREMENT_AGE, yearlyAmount: 68_000, inflationAdjusted: true },
  { id: 'is-pension', label: 'Pension', fromAge: 67, toAge: UNTIL_AGE, yearlyAmount: 16_000, inflationAdjusted: true },
  { id: 'is-nominal', label: 'Fixed annuity', fromAge: 65, toAge: UNTIL_AGE, yearlyAmount: 4_000, inflationAdjusted: false }
];

const lumpSumEvents: LumpSumEvent[] = [
  { id: 'ls-1', label: 'Inheritance', age: 58, amount: 45_000 },
  { id: 'ls-2', label: 'Roof', age: 66, amount: -22_000 }
];

/**
 * Already-retired mode drops the salary the same way the UI does, so the payload here
 * matches what `RetirementPlanner.svelte` actually sends.
 */
const retiredIncomeSources: IncomeSource[] = incomeSources.filter((src) => src.id !== 'is-default');

/** Every engine feature gets a scenario so drift in any of them fails this suite. */
const scenarios: Array<{
  name: string;
  input: RetirementInput;
  retireMonth?: number;
  incomeSources?: IncomeSource[];
}> = [
  {
    name: 'historical monthly bootstrap, fixed spending',
    input: baseInput()
  },
  {
    name: 'joint (return, inflation) bootstrap',
    input: baseInput({ historicalMonthlyInflation: monthlyInflationHistory() })
  },
  {
    name: 'Guyton-Klinger guardrails',
    input: baseInput({
      withdrawalStrategy: {
        kind: 'guardrails',
        guardrailBand: 0.2,
        adjustment: 0.1,
        spendingFloor: 0.6,
        spendingCeiling: 1.4
      }
    })
  },
  {
    name: 'percent-of-portfolio withdrawals',
    input: baseInput({
      withdrawalStrategy: {
        kind: 'percentOfPortfolio',
        withdrawalPercent: 0.045,
        spendingFloor: 0.5,
        spendingCeiling: 1.5
      }
    })
  },
  {
    name: 'moment targeting (current-conditions style)',
    input: baseInput({ historicalMomentTargeting: true, meanReturn: 0.047, returnVariability: 0.14 })
  },
  {
    name: 'annual bootstrap fallback (no monthly history)',
    input: baseInput({ historicalMonthlyReturns: undefined })
  },
  {
    name: 'parametric mode',
    input: baseInput({ simulationMode: 'parametric', historicalMonthlyReturns: undefined })
  },
  {
    name: 'zero fees and zero tax',
    input: baseInput({ annualFeePercent: 0, taxOnGainsPercent: 0 })
  },
  {
    // Exercises all three already-retired branches at once: the collapsed ruin-surface
    // axis, the required-starting-capital P95 target (a bisection, so any divergence in
    // the replay compounds across ~20 iterations), and the yes/no FI probabilities.
    name: 'already retired (retireMonth 0)',
    input: baseInput({ retirementAge: CURRENT_AGE }),
    retireMonth: 0,
    incomeSources: retiredIncomeSources
  },
  {
    name: 'already retired, guardrails from month zero',
    input: baseInput({
      retirementAge: CURRENT_AGE,
      withdrawalStrategy: {
        kind: 'guardrails',
        guardrailBand: 0.2,
        adjustment: 0.1,
        spendingFloor: 0.6,
        spendingCeiling: 1.4
      }
    }),
    retireMonth: 0,
    incomeSources: retiredIncomeSources
  }
];

describe('seeded PRNG parity', () => {
  it('produces an identical uniform stream in both engines', () => {
    const seed = 123456;
    const rust = Array.from(debug_random_sequence(seed, 64));
    const rng = createRandomSource(seed);
    const ts = Array.from({ length: 64 }, () => rng.random());
    expect(rust).toEqual(ts);
  });

  it('produces an identical standard-normal stream in both engines', () => {
    const seed = 24680;
    const rust = Array.from(debug_normal_sequence(seed, 64));
    const rng = createRandomSource(seed);
    const ts = Array.from({ length: 64 }, () => rng.normal(0, 1));
    for (let index = 0; index < ts.length; index++) {
      expectClose(rust[index], ts[index], `normal[${index}]`);
    }
  });
});

describe('cross-engine simulation parity', () => {
  for (const scenario of scenarios) {
    it(`matches for: ${scenario.name}`, () => {
      const scenarioIncome = scenario.incomeSources ?? incomeSources;
      const scenarioRetireMonth = scenario.retireMonth ?? RETIRE_MONTH;

      const ts = runMonteCarloSimulation(
        scenario.input,
        spendingPeriods,
        scenarioIncome,
        lumpSumEvents,
        MONTHS,
        scenarioRetireMonth
      );
      const rust = run_monte_carlo(
        scenario.input,
        spendingPeriods,
        scenarioIncome,
        lumpSumEvents,
        MONTHS,
        scenarioRetireMonth
      ) as unknown as typeof ts;

      expect(rust.simCount).toBe(ts.simCount);
      expect(rust.simulation.months).toBe(ts.simulation.months);
      expect(rust.simulation.retireMonth).toBe(ts.simulation.retireMonth);

      // Full per-month percentile bands, not just the endpoints.
      for (const band of ['p10', 'p25', 'p50', 'p75', 'p90'] as const) {
        expectSeriesClose(
          rust.simulation.percentiles[band],
          ts.simulation.percentiles[band],
          `percentiles.${band}`
        );
        expectClose(
          rust.simulation.finalPercentiles[band],
          ts.simulation.finalPercentiles[band],
          `finalPercentiles.${band}`
        );
        expectClose(
          rust.simulation.retirePercentiles[band],
          ts.simulation.retirePercentiles[band],
          `retirePercentiles.${band}`
        );
      }

      // Coast age is nullable, so compare the null-ness first, then the value.
      expect(rust.stats.coastAge === null).toBe(ts.stats.coastAge === null);
      if (ts.stats.coastAge !== null && rust.stats.coastAge !== null) {
        expectClose(rust.stats.coastAge, ts.stats.coastAge, 'stats.coastAge');
      }

      const scalarStats = [
        'fiTargetSWR',
        'fiTargetP95',
        'successProbability',
        'fiProbabilitySWR',
        'fiProbabilityP95',
        'shortfallLow',
        'shortfallMedian',
        'shortfallHigh',
        'depletedYearsLow',
        'depletedYearsMedian',
        'depletedYearsHigh',
        'retireLow',
        'retireMedian',
        'retireHigh',
        'finalLow',
        'finalMedian',
        'finalHigh'
      ] as const;
      for (const key of scalarStats) {
        expectClose(rust.stats[key] as number, ts.stats[key] as number, `stats.${key}`);
      }

      for (const key of ['arithmeticMean', 'geometricMean', 'stdDev', 'skewness', 'kurtosis'] as const) {
        expectClose(
          rust.stats.returnMoments[key],
          ts.stats.returnMoments[key],
          `returnMoments.${key}`
        );
      }

      // Sequence-risk buckets are derived from the per-year real-return series, so they
      // catch drift in the annual accumulators that the headline stats would hide.
      expect(rust.stats.sequenceRisk.length).toBe(ts.stats.sequenceRisk.length);
      ts.stats.sequenceRisk.forEach((bucket, index) => {
        const other = rust.stats.sequenceRisk[index];
        expect(other.bucketLabel).toBe(bucket.bucketLabel);
        expectClose(other.earlyYearsMeanReturn, bucket.earlyYearsMeanReturn, `sequenceRisk[${index}].earlyYearsMeanReturn`);
        expectClose(other.ruinProbability, bucket.ruinProbability, `sequenceRisk[${index}].ruinProbability`);
        expectClose(other.endingMedian, bucket.endingMedian, `sequenceRisk[${index}].endingMedian`);
      });

      // The whole ruin surface, including its axes and replay sample size.
      expect(rust.stats.ruinSurface.retirementAges).toEqual(ts.stats.ruinSurface.retirementAges);
      expect(rust.stats.ruinSurface.sampleCount).toBe(ts.stats.ruinSurface.sampleCount);
      expectSeriesClose(
        rust.stats.ruinSurface.spendingMultipliers,
        ts.stats.ruinSurface.spendingMultipliers,
        'ruinSurface.spendingMultipliers'
      );
      expect(rust.stats.ruinSurface.ruinProbabilities.length).toBe(
        ts.stats.ruinSurface.ruinProbabilities.length
      );
      ts.stats.ruinSurface.ruinProbabilities.forEach((row, rowIndex) => {
        expectSeriesClose(
          rust.stats.ruinSurface.ruinProbabilities[rowIndex],
          row,
          `ruinSurface.ruinProbabilities[${rowIndex}]`
        );
      });
    });
  }
});
