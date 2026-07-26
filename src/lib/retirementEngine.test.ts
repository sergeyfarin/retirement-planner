import { describe, expect, it } from 'vitest';
import {
  blendPortfolioMetrics,
  buildCurrentConditionsMetrics,
  createRandomSource,
  type HistoricalMarketDataset
} from './calculations';
import {
  annualizePostRetirementGrowthFactors,
  buildCashflowArrays,
  buildSequenceRiskSummary,
  monthlyTargetsForAnnualMoments,
  detectRegimes,
  drawCornishFisherScore,
  evaluatePath,
  findRequiredStartingCapital,
  findRetirementBalanceTarget,
  incomeAtAge,
  isAlreadyRetired,
  runMonteCarloSimulation,
  spendingAtAge,
  validateSimulationInputs,
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

describe('parametric calibration pool', () => {
  function parametricInput(seed: number): RetirementInput {
    return {
      simulationMode: 'parametric',
      currentAge: 40,
      retirementAge: 65,
      simulateUntilAge: 70,
      currentSavings: 300_000,
      meanReturn: 0.07,
      returnVariability: 0.15,
      returnSkewness: -0.3,
      returnKurtosis: 4,
      equityBondCorrelation: 0.2,
      inflationMean: 0.02,
      inflationVariability: 0.01,
      inflationSkewness: 0,
      inflationKurtosis: 3,
      annualFeePercent: 0,
      taxOnGainsPercent: 0,
      safeWithdrawalRate: 0.04,
      simulations: 400,
      seed,
      regimeModel: {
        stayGrowth: 0.88,
        stayCrisis: 0.72,
        growthMean: 0.09,
        growthStd: 0.12,
        crisisMean: -0.08,
        crisisStd: 0.24
      }
    };
  }

  it('targets the shared finite pool to the requested mean and volatility', () => {
    for (const seed of [12_345, 987_654, 5150]) {
      const input = parametricInput(seed);
      const result = runMonteCarloSimulation(input, [], [], [], 360, 300);
      expect(result.stats.returnMoments.arithmeticMean).toBeCloseTo(input.meanReturn, 12);
      expect(result.stats.returnMoments.stdDev).toBeCloseTo(input.returnVariability, 12);
    }
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

describe('regime bootstrap is mean-preserving', () => {
  // Regression guard for TODO 0.11. The sampler used to abort the current block whenever
  // the regime switched. Because a fresh block always *starts* on a month matching the new
  // regime, and crisis runs are shorter than growth runs, crisis months were over-drawn
  // ~1.06-1.09x — costing 0.64-1.29pp/yr of return on the shipped datasets. Blocks now run
  // to completion and the regime only chooses the pool for the next block.
  //
  // The property to hold onto: over a long horizon with no fees, tax or cash flows, the
  // engine's median real growth must track the geometric mean of the series it was handed.
  // A biased sampler shows up here immediately.
  it('reproduces the source series geometric return over a long horizon', () => {
    // Clustered drawdowns, so regime detection has real structure to find.
    const rng = createRandomSource(24680);
    const series: number[] = [];
    let stressed = false;
    for (let i = 0; i < 720; i++) {
      if (rng.random() < (stressed ? 0.15 : 0.04)) stressed = !stressed;
      series.push(stressed ? rng.normal(-0.012, 0.055) : rng.normal(0.011, 0.026));
    }
    const sourceGeoMonthly =
      Math.pow(series.reduce((p, v) => p * (1 + v), 1), 1 / series.length) - 1;
    const sourceGeoAnnual = Math.pow(1 + sourceGeoMonthly, 12) - 1;

    const months = 600;
    const input: RetirementInput = {
      simulationMode: 'historical',
      currentAge: 30, retirementAge: 80, simulateUntilAge: 80,
      currentSavings: 100_000,
      meanReturn: 0.07, returnVariability: 0.14, returnSkewness: 0, returnKurtosis: 3,
      equityBondCorrelation: 0,
      // Zero inflation so the deflator does not confound the comparison.
      inflationMean: 0, inflationVariability: 0, inflationSkewness: 0, inflationKurtosis: 3,
      inflationCrisisSpread: 0,
      annualFeePercent: 0, taxOnGainsPercent: 0,
      safeWithdrawalRate: 0.04, simulations: 4000, seed: 5150, blockLength: 6,
      regimeModel: {
        stayGrowth: 0.92, stayCrisis: 0.68,
        growthMean: 0.09, growthStd: 0.14, crisisMean: -0.12, crisisStd: 0.24
      },
      historicalMonthlyReturns: series
    };

    const result = runMonteCarloSimulation(input, [], [], [], months, months - 1);
    const median = result.simulation.percentiles.p50[months - 1];
    const engineAnnual = Math.pow(median / 100_000, 12 / months) - 1;

    // The old sampler came in roughly a full percentage point light; 0.35pp leaves room for
    // Monte Carlo noise and the median-vs-geometric-mean gap without admitting that bias.
    expect(Math.abs(engineAnnual - sourceGeoAnnual)).toBeLessThan(0.0035);
    // 4000 paths x 600 months is the heaviest test in the suite and it sits close enough to
    // vitest's 5s default that it times out when the full suite runs its workers in parallel.
    // The generous budget is about scheduling contention, not about the assertion above.
  }, 30_000);
});

describe('degenerate block lengths are normalized', () => {
  // The UI's `min="1"` is not an invariant at the engine boundary: the field can be cleared
  // and a restored share link carries whatever number was in the URL. Zero used to panic the
  // Rust engine on a `usize` underflow while this engine quietly redrew a block every month,
  // so the same input produced two different simulations. Both engines now floor the block at
  // 1, which is what a zero-length block degenerates to anyway.
  const series = Array.from({ length: 600 }, (_, month) => 0.006 + 0.03 * Math.sin(month * 0.37));

  function blockInput(blockLength: number | undefined): RetirementInput {
    return {
      simulationMode: 'historical',
      currentAge: 40, retirementAge: 60, simulateUntilAge: 70,
      currentSavings: 250_000,
      meanReturn: 0.07, returnVariability: 0.14, returnSkewness: 0, returnKurtosis: 3,
      equityBondCorrelation: 0,
      inflationMean: 0.02, inflationVariability: 0.01, inflationSkewness: 0, inflationKurtosis: 3,
      inflationCrisisSpread: 0.015,
      annualFeePercent: 0, taxOnGainsPercent: 0,
      // Small and short on purpose: every assertion here is an exact-equality comparison
      // between two runs, so extra paths buy nothing but suite time.
      safeWithdrawalRate: 0.04, simulations: 120, seed: 8675309,
      blockLength,
      regimeModel: {
        stayGrowth: 0.92, stayCrisis: 0.68,
        growthMean: 0.09, growthStd: 0.14, crisisMean: -0.12, crisisStd: 0.24
      },
      historicalMonthlyReturns: series
    };
  }

  const MONTHS = (70 - 40) * 12;
  const RETIRE_MONTH = (60 - 40) * 12;
  const run = (blockLength: number | undefined) =>
    runMonteCarloSimulation(blockInput(blockLength), [], [], [], MONTHS, RETIRE_MONTH);

  it('treats a zero block length as a one-month block', () => {
    const zero = run(0);
    expect(zero.stats.finalMedian).toBeTypeOf('number');
    expect(Number.isFinite(zero.stats.finalMedian)).toBe(true);
    expect(zero.stats.finalMedian).toBe(run(1).stats.finalMedian);
  });

  it('floors a negative block length at one month', () => {
    expect(run(-6).stats.finalMedian).toBe(run(1).stats.finalMedian);
  });

  it('truncates a fractional block length toward the shorter block', () => {
    expect(run(6.7).stats.finalMedian).toBe(run(6).stats.finalMedian);
  });

  it('falls back to the default when the block length is not a number', () => {
    expect(run(Number.NaN).stats.finalMedian).toBe(run(undefined).stats.finalMedian);
  });
});

describe('nominal cashflows deflated by realized inflation', () => {
  // TODO 0.3. Nominal (non-inflation-adjusted) items used to be divided by a deterministic
  // (1+inflationMean)^years index computed once outside the simulation, while balances were
  // deflated by the per-path stochastic inflation. A fixed annuity therefore never lost
  // purchasing power faster on a high-inflation path — exactly the risk of holding one —
  // and the two sides of the ledger were using different price indices.
  //
  // With inflation volatility set to zero the whole thing is deterministic, so the engine's
  // answer can be checked against an exact hand computation.
  const flatReturns = new Array(240).fill(0); // 0% market return every month
  const ANNUAL_INFLATION = 0.12; // => exactly 1% per month, since monthlyMean = annual/12
  const MONTHLY_INFLATION = ANNUAL_INFLATION / 12;
  const MONTHS = 24;

  function nominalIncomeInput(): RetirementInput {
    return {
      simulationMode: 'historical',
      currentAge: 60, retirementAge: 60, simulateUntilAge: 62,
      currentSavings: 0,
      meanReturn: 0, returnVariability: 0, returnSkewness: 0, returnKurtosis: 3,
      equityBondCorrelation: 0,
      inflationMean: ANNUAL_INFLATION,
      inflationVariability: 0, inflationSkewness: 0, inflationKurtosis: 3,
      inflationCrisisSpread: 0,
      annualFeePercent: 0, taxOnGainsPercent: 0,
      safeWithdrawalRate: 0.04, simulations: 400, seed: 777,
      regimeModel: {
        stayGrowth: 0.92, stayCrisis: 0.68,
        growthMean: 0, growthStd: 0, crisisMean: 0, crisisStd: 0
      },
      historicalMonthlyReturns: flatReturns
    };
  }

  const nominalIncome: IncomeSource[] = [
    { id: 'is-nominal', label: 'Fixed annuity', fromAge: 60, toAge: 62, yearlyAmount: 12000, inflationAdjusted: false }
  ];

  it('deflates a fixed annuity by the same index the balance is deflated by', () => {
    const result = runMonteCarloSimulation(nominalIncomeInput(), [], nominalIncome, [], MONTHS, 0);

    // Reproduce the engine's accounting exactly: the flow enters in pre-month-m money, so
    // the nominal face value is divided by the index accumulated through month m-1, and
    // the balance is then deflated by month m's inflation.
    let expected = 0;
    let index = 1;
    for (let m = 0; m < MONTHS; m++) {
      expected += 1000 / index; // 12000/yr = 1000/month, face value
      expected /= 1 + MONTHLY_INFLATION;
      index *= 1 + MONTHLY_INFLATION;
    }

    expect(result.stats.finalMedian).toBeCloseTo(expected, 6);
  });

  it('erodes a nominal annuity more than an inflation-adjusted one of the same size', () => {
    const nominal = runMonteCarloSimulation(nominalIncomeInput(), [], nominalIncome, [], MONTHS, 0);
    const realTerms = runMonteCarloSimulation(
      nominalIncomeInput(),
      [],
      [{ ...nominalIncome[0], inflationAdjusted: true }],
      [],
      MONTHS,
      0
    );
    expect(nominal.stats.finalMedian).toBeLessThan(realTerms.stats.finalMedian);
  });

  it('makes outcomes path-dependent once inflation is volatile', () => {
    // With the old deterministic index the annuity's real value was identical on every
    // path; now it tracks each path's own realized inflation, so outcomes disperse.
    const volatile = runMonteCarloSimulation(
      { ...nominalIncomeInput(), inflationVariability: 0.05, simulations: 2000 },
      [],
      nominalIncome,
      [],
      MONTHS,
      0
    );
    expect(volatile.stats.finalHigh).toBeGreaterThan(volatile.stats.finalLow);
  });
});

describe('coast FIRE age', () => {
  // Coast removes only positive contributions; deficits and lump sums remain scheduled.
  const monthly: number[] = [];
  for (let i = 0; i < 300; i++) monthly.push(i % 7 === 0 ? -0.03 : 0.014);

  function saver(overrides: Partial<RetirementInput> = {}): RetirementInput {
    return {
      simulationMode: 'historical',
      currentAge: 35, retirementAge: 62, simulateUntilAge: 88,
      currentSavings: 100_000,
      meanReturn: 0.075, returnVariability: 0.15, returnSkewness: 0, returnKurtosis: 3,
      equityBondCorrelation: -0.1,
      inflationMean: 0.02, inflationVariability: 0.01, inflationSkewness: 0, inflationKurtosis: 3,
      inflationCrisisSpread: 0.015, blockLength: 6,
      annualFeePercent: 0.004, taxOnGainsPercent: 0.1,
      safeWithdrawalRate: 0.04, simulations: 400, seed: 9090,
      regimeModel: {
        stayGrowth: 0.92, stayCrisis: 0.68,
        growthMean: 0.09, growthStd: 0.14, crisisMean: -0.12, crisisStd: 0.24
      },
      historicalMonthlyReturns: monthly,
      ...overrides
    };
  }

  const spending: SpendingPeriod[] = [
    { id: 'sp-default', label: 'Living', fromAge: 35, toAge: 88, yearlyAmount: 48000, inflationAdjusted: true }
  ];
  const bigSaver: IncomeSource[] = [
    { id: 'is-default', label: 'Salary', fromAge: 35, toAge: 62, yearlyAmount: 58000, inflationAdjusted: true }
  ];
  const months = (88 - 35) * 12;
  const retireMonth = (62 - 35) * 12;

  it('reports an age between today and retirement for a net saver', () => {
    const result = runMonteCarloSimulation(saver(), spending, bigSaver, [], months, retireMonth);
    expect(result.stats.coastAge).not.toBeNull();
    expect(result.stats.coastAge!).toBeGreaterThanOrEqual(35);
    expect(result.stats.coastAge!).toBeLessThanOrEqual(62);
  });

  it('lands strictly inside the accumulation window rather than at an endpoint', () => {
    // Calibrated so the answer is genuinely interior: the saver can neither stop today nor
    // needs to contribute right up to retirement. A degenerate endpoint would pass the
    // bounds check above while telling us nothing.
    const coastAge = runMonteCarloSimulation(saver(), spending, bigSaver, [], months, retireMonth)
      .stats.coastAge;
    expect(coastAge).not.toBeNull();
    expect(coastAge!).toBeGreaterThan(35);
    expect(coastAge!).toBeLessThan(62);
  });

  it('is no later when the saver starts with more money', () => {
    // Monotone in starting wealth: more capital can only bring the coast age forward.
    const poorer = runMonteCarloSimulation(saver({ currentSavings: 100_000 }), spending, bigSaver, [], months, retireMonth);
    const richer = runMonteCarloSimulation(saver({ currentSavings: 300_000 }), spending, bigSaver, [], months, retireMonth);
    expect(poorer.stats.coastAge).not.toBeNull();
    expect(richer.stats.coastAge).not.toBeNull();
    expect(richer.stats.coastAge!).toBeLessThanOrEqual(poorer.stats.coastAge!);
  });

  it('returns null when the target is unreachable even by contributing to retirement', () => {
    const brokeInput = saver({ currentSavings: 5_000 });
    const tinyIncome: IncomeSource[] = [
      { id: 'is-default', label: 'Salary', fromAge: 35, toAge: 62, yearlyAmount: 31000, inflationAdjusted: true }
    ];
    const result = runMonteCarloSimulation(brokeInput, spending, tinyIncome, [], months, retireMonth);
    expect(result.stats.successProbability).toBeLessThan(0.95);
    expect(result.stats.coastAge).toBeNull();
  });

  it('returns null for a net drawer, who has no contributions to stop', () => {
    const noIncome: IncomeSource[] = [];
    const result = runMonteCarloSimulation(saver(), spending, noIncome, [], months, retireMonth);
    expect(result.stats.coastAge).toBeNull();
  });

  it('remains valid when positive-contribution and deficit months coexist', () => {
    const mixedSpending: SpendingPeriod[] = [
      { id: 'early', label: 'Early living', fromAge: 35, toAge: 40, yearlyAmount: 48000, inflationAdjusted: true },
      { id: 'later', label: 'Later living', fromAge: 40, toAge: 88, yearlyAmount: 76000, inflationAdjusted: true }
    ];
    const result = runMonteCarloSimulation(
      saver({ currentSavings: 2_000_000 }),
      mixedSpending,
      bigSaver,
      [],
      months,
      retireMonth
    );

    // The overall pre-retirement net flow is negative, but early positive contributions
    // still exist and can be stopped without erasing the later deficits.
    expect(result.stats.coastAge).not.toBeNull();
    expect(result.stats.coastAge!).toBeGreaterThanOrEqual(35);
    expect(result.stats.coastAge!).toBeLessThanOrEqual(62);
  });
});

describe('exact path evaluator', () => {
  const fixed = { kind: 'fixed' as const };

  it('does not call an exactly balanced zero-savings path depleted', () => {
    const months = 12;
    const zeroes = new Float64Array(months);
    const result = evaluatePath(
      { assetReturns: zeroes, inflationRates: zeroes },
      {
        monthlyRealIncomeFlow: new Float64Array(months).fill(100),
        monthlyNominalIncomeFlow: zeroes,
        monthlyRealSpendingFlow: new Float64Array(months).fill(100),
        monthlyNominalSpendingFlow: zeroes,
        lumpSumByMonth: zeroes
      },
      0,
      months,
      fixed,
      0,
      0,
      0
    );

    expect(result.finalBalance).toBe(0);
    expect(result.cumulativeShortfall).toBe(0);
    expect(result.depleted).toBe(false);
    expect(result.depletedMonths).toBe(0);
  });

  it('deflates nominal cash flows by the tape\'s realized inflation', () => {
    const result = evaluatePath(
      {
        assetReturns: new Float64Array([0, 0]),
        inflationRates: new Float64Array([0.1, 0])
      },
      {
        monthlyRealIncomeFlow: new Float64Array(2),
        monthlyNominalIncomeFlow: new Float64Array([0, 110]),
        monthlyRealSpendingFlow: new Float64Array(2),
        monthlyNominalSpendingFlow: new Float64Array(2),
        lumpSumByMonth: new Float64Array(2)
      },
      1,
      2,
      fixed,
      0,
      0,
      0
    );

    expect(result.finalBalance).toBeCloseTo(1 / 1.1 + 100, 12);
  });

  it('recomputes balance-dependent annual tax on the replayed capital', () => {
    const assetReturns = new Float64Array(12);
    assetReturns[0] = 0.1;
    const empty = new Float64Array(12);
    const result = evaluatePath(
      { assetReturns, inflationRates: empty },
      {
        monthlyRealIncomeFlow: empty,
        monthlyNominalIncomeFlow: empty,
        monthlyRealSpendingFlow: empty,
        monthlyNominalSpendingFlow: empty,
        lumpSumByMonth: empty
      },
      100,
      12,
      fixed,
      0,
      0,
      0.5
    );

    expect(result.finalBalance).toBeCloseTo(105, 12);
  });

  it('stops only positive contributions while preserving deficits and lump sums', () => {
    const result = evaluatePath(
      {
        assetReturns: new Float64Array(2),
        inflationRates: new Float64Array(2)
      },
      {
        monthlyRealIncomeFlow: new Float64Array([100, 0]),
        monthlyNominalIncomeFlow: new Float64Array(2),
        monthlyRealSpendingFlow: new Float64Array([50, 50]),
        monthlyNominalSpendingFlow: new Float64Array(2),
        lumpSumByMonth: new Float64Array([0, -25])
      },
      100,
      2,
      fixed,
      2,
      0,
      0,
      0
    );

    expect(Array.from(result.balances)).toEqual([100, 25]);
  });
});

describe('annual-mode intra-year variation', () => {
  // TODO 0.7: annual-mode bootstrapping used to hold one constant monthly rate for the
  // whole year, so a path that dipped below zero mid-year and recovered by December was
  // invisible to monthly-granularity ruin. Spreading the year adds that variation while
  // preserving the drawn annual return exactly.
  function annualOnlyInput(overrides: Partial<RetirementInput> = {}): RetirementInput {
    return {
      simulationMode: 'historical',
      currentAge: 60,
      retirementAge: 60,
      simulateUntilAge: 85,
      currentSavings: 700_000,
      meanReturn: 0.07,
      returnVariability: 0.18,
      returnSkewness: 0,
      returnKurtosis: 3,
      equityBondCorrelation: 0,
      inflationMean: 0.02,
      inflationVariability: 0.005,
      inflationSkewness: 0,
      inflationKurtosis: 3,
      inflationCrisisSpread: 0,
      annualFeePercent: 0,
      taxOnGainsPercent: 0,
      safeWithdrawalRate: 0.04,
      simulations: 1500,
      seed: 5150,
      regimeModel: {
        stayGrowth: 0.92, stayCrisis: 0.68,
        growthMean: 0.09, growthStd: 0.14, crisisMean: -0.12, crisisStd: 0.24
      },
      // 30 annual observations, no monthly history => Mode B.
      historicalAnnualReturns: [
        0.14, 0.1, 0.08, 0.18, -0.22, 0.07, 0.03, -0.15, 0.12, 0.11, 0.06, 0.09, -0.2, 0.16,
        0.05, 0.04, 0.13, -0.12, 0.1, 0.08, 0.09, 0.07, -0.18, 0.15, 0.1, 0.02, -0.05, 0.19,
        0.11, -0.09
      ],
      historicalMonthlyReturns: undefined,
      ...overrides
    };
  }

  const spending: SpendingPeriod[] = [
    { id: 'sp', label: 'Living', fromAge: 60, toAge: 85, yearlyAmount: 42000, inflationAdjusted: true }
  ];
  const months = 300;

  it('leaves annual return distribution intact (returnVariability drives only intra-year spread)', () => {
    // The annual series is bootstrapped identically either way, so the summary annual
    // return moments must not shift when intra-year variation is switched on.
    const flat = runMonteCarloSimulation(annualOnlyInput({ returnVariability: 0 }), spending, [], [], months, 0);
    const spread = runMonteCarloSimulation(annualOnlyInput(), spending, [], [], months, 0);
    expect(spread.stats.returnMoments.arithmeticMean).toBeCloseTo(
      flat.stats.returnMoments.arithmeticMean, 10
    );
    expect(spread.stats.returnMoments.stdDev).toBeCloseTo(flat.stats.returnMoments.stdDev, 10);
  });

  it('exposes within-year ruin that a constant monthly rate would hide', () => {
    // Same annual returns, but months now move; a drawdown portfolio can touch zero
    // mid-year, so ruin can only rise.
    const flat = runMonteCarloSimulation(annualOnlyInput({ returnVariability: 0 }), spending, [], [], months, 0);
    const spread = runMonteCarloSimulation(annualOnlyInput(), spending, [], [], months, 0);
    expect(spread.stats.successProbability).toBeLessThanOrEqual(flat.stats.successProbability);
  });
});

describe('portfolio kurtosis blending', () => {
  // The fourth moment of a sum is dominated by its cross terms. Omitting them made a
  // blend of normals report kurtosis 1.5 — thinner than normal — which told the
  // Student-t mapping there was no excess kurtosis to reproduce (TODO 0.5).
  const normal = (std: number) => ({ std, skew: 0, kurt: 3 });

  function blendOf(
    stocks: number,
    bonds: number,
    bank: number,
    rho: number,
    stockKurt = 3
  ) {
    return blendPortfolioMetrics(
      {
        stockMean: 0.08, stockStd: 0.16, stockSkew: 0, stockKurt,
        bondMean: 0.04, bondStd: 0.09, bondSkew: 0, bondKurt: normal(0.09).kurt,
        bankMean: 0.03, bankStd: 0.03, bankSkew: 0, bankKurt: normal(0.03).kurt
      },
      { stocks, bonds, bank },
      rho
    );
  }

  it('gives exactly 3 for any blend of uncorrelated normals', () => {
    for (const [s, b, c] of [[0.5, 0.5, 0], [0.6, 0.3, 0.1], [0.34, 0.33, 0.33], [0.9, 0.05, 0.05]]) {
      expect(blendOf(s, b, c, 0).kurtosis).toBeCloseTo(3, 9);
    }
  });

  it('gives exactly 3 for correlated normals too', () => {
    for (const rho of [-0.5, -0.1, 0, 0.3, 0.9]) {
      expect(blendOf(0.6, 0.3, 0.1, rho).kurtosis).toBeCloseTo(3, 9);
    }
  });

  it('preserves a single asset kurtosis when the portfolio is 100% that asset', () => {
    expect(blendOf(1, 0, 0, 0, 7).kurtosis).toBeCloseTo(7, 9);
  });

  it('reports excess kurtosis when a component is fat-tailed', () => {
    const fat = blendOf(0.6, 0.3, 0.1, -0.1, 9);
    const thin = blendOf(0.6, 0.3, 0.1, -0.1, 3);
    expect(fat.kurtosis).toBeGreaterThan(thin.kurtosis);
    expect(fat.kurtosis).toBeGreaterThan(3);
  });
});

describe('current-conditions expected returns', () => {
  const dataset = {
    generatedAt: '2026-07-21T00:00:00.000Z',
    methodology: { frequency: '', annualization: '', cash: '' },
    regions: {
      USD: {
        code: 'USD' as const,
        label: 'United States',
        years: [2024],
        sampleSize: 1,
        coverage: '1961-2025',
        assetMoments: {
          equity: { arithmeticMean: 0.12, geometricMean: 0.106, stdDev: 0.165, skewness: -0.3, kurtosis: 3.4 },
          bond: { arithmeticMean: 0.063, geometricMean: 0.058, stdDev: 0.092, skewness: 0.2, kurtosis: 3.9 },
          cash: { arithmeticMean: 0.045, geometricMean: 0.045, stdDev: 0.033, skewness: 0.5, kurtosis: 2.8 }
        },
        annualSeries: [],
        currentConditions: { asOf: '2026-01', bondYield: 0.0421, cashRate: 0.0357 }
      }
    }
  } as unknown as HistoricalMarketDataset;

  it('anchors means to current yields while keeping historical shape', () => {
    const result = buildCurrentConditionsMetrics(dataset, 'USD');
    expect(result).not.toBeNull();

    // ERP = historical equity mean − historical bond mean = 12% − 6.3% = 5.7%
    expect(result!.equityRiskPremium).toBeCloseTo(0.057, 6);
    // Bonds and cash take today's yields directly; equity is yield + ERP.
    expect(result!.metrics.bondMean).toBeCloseTo(0.0421, 6);
    expect(result!.metrics.bankMean).toBeCloseTo(0.0357, 6);
    expect(result!.metrics.stockMean).toBeCloseTo(0.0421 + 0.057, 6);
    // Only means move — the distribution's shape stays historical.
    expect(result!.metrics.stockStd).toBeCloseTo(0.165, 6);
    expect(result!.metrics.bondStd).toBeCloseTo(0.092, 6);
    expect(result!.metrics.stockSkew).toBeCloseTo(-0.3, 6);
    expect(result!.metrics.bondKurt).toBeCloseTo(3.9, 6);
    expect(result!.asOf).toBe('2026-01');
  });

  it('returns null when the dataset has no current-conditions block', () => {
    const withoutConditions = {
      ...dataset,
      regions: { USD: { ...dataset.regions.USD, currentConditions: null } }
    } as unknown as HistoricalMarketDataset;
    expect(buildCurrentConditionsMetrics(withoutConditions, 'USD')).toBeNull();
  });
});

describe('joint return/inflation bootstrap', () => {
  // A history with PERSISTENT stagflation: alternating 12-month runs of
  // (bad returns + high inflation) and (good returns + zero inflation) — the 1970s
  // pattern. Persistence is what makes the pairing bite: with block bootstrapping a
  // path can land in a sustained stagflation run, which independent i.i.d. inflation
  // at the same mean can never produce.
  //
  // Mechanism note: with no cash flows, terminal real wealth is Π(1+r)/Π(1+π), so the
  // *pairing* cancels and only the inflation multiset matters. What the joint bootstrap
  // changes is the shape of the real-return path — sustained real drawdowns — which
  // shows up as a materially fatter left tail, exactly the risk TODO 0.4 says
  // independence understates.
  const MONTHLY_INFLATION_MEAN = 0.005;
  const returns: number[] = [];
  const inflation: number[] = [];
  for (let cycle = 0; cycle < 20; cycle++) {
    for (let i = 0; i < 12; i++) {
      returns.push(-0.01);
      inflation.push(0.01);
    }
    for (let i = 0; i < 12; i++) {
      returns.push(0.035);
      inflation.push(0.0);
    }
  }

  function input(withJoint: boolean): RetirementInput {
    return {
      currentAge: 60,
      retirementAge: 60,
      simulateUntilAge: 90,
      currentSavings: 1_000_000,
      meanReturn: 0.15,
      returnVariability: 0.15,
      returnSkewness: 0,
      returnKurtosis: 3,
      equityBondCorrelation: 0,
      // The engine converts with monthlyMean = annualMean / 12, so this makes the
      // independent draw's mean exactly equal the historical series' mean.
      inflationMean: MONTHLY_INFLATION_MEAN * 12,
      inflationVariability: 0.0001, // near-deterministic: isolate pairing from noise
      inflationSkewness: 0,
      inflationKurtosis: 3,
      inflationCrisisSpread: 0,
      annualFeePercent: 0,
      taxOnGainsPercent: 0,
      safeWithdrawalRate: 0.04,
      simulations: 2000,
      seed: 31337,
      blockLength: 6,
      regimeModel: {
        stayGrowth: 0.92,
        stayCrisis: 0.68,
        growthMean: 0.15,
        growthStd: 0.12,
        crisisMean: -0.08,
        crisisStd: 0.2
      },
      historicalMonthlyReturns: returns,
      historicalMonthlyInflation: withJoint ? inflation : undefined
    };
  }

  const spending: SpendingPeriod[] = [
    { id: 'sp-default', label: 'Living', fromAge: 60, toAge: 90, yearlyAmount: 50000, inflationAdjusted: true }
  ];
  const months = 360;

  it('produces a fatter left tail than independent inflation at the same mean', () => {
    const independent = runMonteCarloSimulation(input(false), spending, [], [], months, 0);
    const joint = runMonteCarloSimulation(input(true), spending, [], [], months, 0);

    // Identical nominal returns and identical average inflation — the only difference is
    // that inflation is drawn from the same historical month as the return.
    //
    // Success probability is the tail statistic here rather than P10: in a scenario built
    // around sustained stagflation the bottom decile depletes entirely under both
    // settings, so P10 is pinned at zero and cannot discriminate.
    expect(joint.stats.successProbability).toBeLessThan(independent.stats.successProbability);
  });

  it('ignores a misaligned inflation series rather than mispairing it', () => {
    const misaligned = { ...input(true), historicalMonthlyInflation: inflation.slice(0, 100) };
    const withoutSeries = runMonteCarloSimulation(input(false), spending, [], [], months, 0);
    const result = runMonteCarloSimulation(misaligned, spending, [], [], months, 0);
    expect(result.stats.finalMedian).toBeCloseTo(withoutSeries.stats.finalMedian, 6);
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
    // Three full runs, so this sits close enough to vitest's 5s default that it times out
    // when the browser project runs alongside this one. Same scheduling contention as the
    // long-horizon sampler test above, same remedy.
  }, 30_000);

  it('omitting the strategy behaves like fixed spending', () => {
    const noStrategy = runMonteCarloSimulation(stressedInput(undefined), spending, [], [], months, retireMonth);
    const fixed = runMonteCarloSimulation(stressedInput({ kind: 'fixed' }), spending, [], [], months, retireMonth);
    expect(noStrategy.stats.finalMedian).toBeCloseTo(fixed.stats.finalMedian, 6);
  });

  it('subtracts scheduled retirement income and bounds total percent-strategy spending', () => {
    const input = stressedInput({
      kind: 'percentOfPortfolio',
      withdrawalPercent: 0.04,
      spendingFloor: 0.6,
      spendingCeiling: 1.4
    });
    input.currentSavings = 1_000_000;
    const pension: IncomeSource[] = [
      { id: 'pension', label: 'State pension', fromAge: 60, toAge: 90, yearlyAmount: 30_000, inflationAdjusted: true }
    ];

    const result = runMonteCarloSimulation(input, spending, pension, [], months, retireMonth);
    expect(result.stats.fiTargetSWR).toBeCloseTo(250_000, 6);

    const oneYearCashflows = buildCashflowArrays(input, spending, pension, [], 12);
    const evaluation = evaluatePath(
      { assetReturns: new Float64Array(12), inflationRates: new Float64Array(12) },
      oneYearCashflows,
      1_000_000,
      12,
      input.withdrawalStrategy!,
      0,
      0,
      0
    );
    // Pension plus the 4% portfolio target would be 70k, so the 56k total-spending ceiling
    // limits the portfolio withdrawal to 26k rather than adding income after the clamp.
    expect(evaluation.finalBalance).toBeCloseTo(974_000, 6);
  });

  it.each(['guardrails', 'percentOfPortfolio'] as const)(
    'normalises reversed spending bounds for %s',
    (kind) => {
      const input = stressedInput({
        kind,
        spendingFloor: 1.2,
        spendingCeiling: 0.8
      });
      input.currentSavings = 1_000_000;

      const result = runMonteCarloSimulation(input, spending, [], [], 24, 0);
      expect(Number.isFinite(result.stats.finalMedian)).toBe(true);
    }
  );

  it('values delayed and temporary retirement income on its actual schedule', () => {
    const input = stressedInput({ kind: 'fixed' });
    const delayedPension: IncomeSource[] = [
      { id: 'delayed', label: 'Delayed pension', fromAge: 61, toAge: 90, yearlyAmount: 30_000, inflationAdjusted: true }
    ];
    const temporaryIncome: IncomeSource[] = [
      { id: 'temporary', label: 'Temporary income', fromAge: 60, toAge: 61, yearlyAmount: 40_000, inflationAdjusted: true }
    ];

    const delayed = runMonteCarloSimulation(input, spending, delayedPension, [], months, retireMonth);
    const temporary = runMonteCarloSimulation(input, spending, temporaryIncome, [], months, retireMonth);

    expect(delayed.stats.fiTargetSWR).toBeGreaterThan(250_000);
    expect(delayed.stats.fiTargetSWR).toBeLessThan(1_000_000);
    expect(temporary.stats.fiTargetSWR).toBeGreaterThan(0);
    expect(temporary.stats.fiTargetSWR).toBeLessThan(1_000_000);
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

describe('sequence-risk summary consumes retirement-relative years', () => {
  const postReturns = [0.04, 0.02, 0.0, -0.02, -0.04];
  const series = postReturns.map((post) => Array(10).fill(post));
  // Final balance encodes the sim index so we can tell which path landed in which bucket.
  const finalBalances = [100, 200, 300, 400, 500];
  const depletedFlags = [false, false, false, false, false];

  it('starts its first annual bucket at a fractional retirement month', () => {
    const factors = [...Array(6).fill(2), ...Array(12).fill(1.01), ...Array(3).fill(0.99)];
    const annual = annualizePostRetirementGrowthFactors(factors, 6);

    expect(annual).toHaveLength(2);
    expect(annual[0]).toBeCloseTo(1.01 ** 12 - 1, 12);
    expect(annual[1]).toBeCloseTo(0.99 ** 3 - 1, 12);
  });

  it('buckets on the first post-retirement decade', () => {
    const buckets = buildSequenceRiskSummary(series, finalBalances, depletedFlags);

    expect(buckets).toHaveLength(5);
    expect(buckets[0].earlyYearsMeanReturn).toBeCloseTo(-0.04, 12);
    expect(buckets[0].endingMedian).toBe(500);
    expect(buckets[4].earlyYearsMeanReturn).toBeCloseTo(0.04, 12);
    expect(buckets[4].endingMedian).toBe(100);
  });

  it('returns no buckets when there is no post-retirement period', () => {
    expect(buildSequenceRiskSummary([[], [], [], [], []], finalBalances, depletedFlags)).toEqual([]);
  });
});

describe('already-retired mode', () => {
  function retiredInput(overrides: Partial<RetirementInput> = {}): RetirementInput {
    return {
      simulationMode: 'historical',
      currentAge: 66,
      retirementAge: 66,
      simulateUntilAge: 90,
      currentSavings: 900000,
      meanReturn: 0.06,
      returnVariability: 0.14,
      returnSkewness: 0,
      returnKurtosis: 3,
      equityBondCorrelation: -0.1,
      inflationMean: 0.02,
      inflationVariability: 0.015,
      inflationSkewness: 0,
      inflationKurtosis: 3,
      annualFeePercent: 0.004,
      taxOnGainsPercent: 0.15,
      safeWithdrawalRate: 0.04,
      simulations: 400,
      seed: 5150,
      regimeModel: {
        stayGrowth: 0.92,
        stayCrisis: 0.68,
        growthMean: 0.09,
        growthStd: 0.14,
        crisisMean: -0.12,
        crisisStd: 0.24
      },
      historicalAnnualReturns: [
        0.14, 0.1, 0.08, 0.18, -0.22, 0.07, 0.03, -0.15, 0.12, 0.11, 0.06, 0.09, -0.2, 0.16, 0.05,
        0.04, 0.13, -0.12, 0.1, 0.08, 0.09, 0.07, -0.18, 0.15, 0.1
      ],
      ...overrides
    };
  }

  const retiredSpending: SpendingPeriod[] = [
    { id: 'sp-default', label: 'Living', fromAge: 66, toAge: 90, yearlyAmount: 40000, inflationAdjusted: true }
  ];
  // No 'is-default' salary row: the UI drops it in this mode, and so must anything that
  // claims to reproduce what the engine is actually given.
  const retiredIncome: IncomeSource[] = [
    { id: 'is-pension', label: 'Pension', fromAge: 67, toAge: 90, yearlyAmount: 14000, inflationAdjusted: true }
  ];

  it('treats equal current and retirement ages as already retired', () => {
    expect(isAlreadyRetired({ currentAge: 66, retirementAge: 66 })).toBe(true);
    expect(isAlreadyRetired({ currentAge: 66, retirementAge: 67 })).toBe(false);
  });

  it('validates an equal-age plan and yields retireMonth 0', () => {
    const validated = validateSimulationInputs(retiredInput(), retiredSpending);

    expect(validated.error).toBeUndefined();
    expect(validated.retireMonth).toBe(0);
    expect(validated.months).toBe(24 * 12);
  });

  it('still rejects a retirement age before the current age', () => {
    const validated = validateSimulationInputs(retiredInput({ retirementAge: 60 }), retiredSpending);

    expect(validated.error).toBeTruthy();
    expect(validated.months).toBe(0);
  });

  it('collapses the ruin surface to a single retirement-age column', () => {
    const input = retiredInput();
    const { months, retireMonth } = validateSimulationInputs(input, retiredSpending);
    const { stats } = runMonteCarloSimulation(
      input,
      retiredSpending,
      retiredIncome,
      [],
      months,
      retireMonth
    );

    expect(stats.ruinSurface.retirementAges).toEqual([66]);
    expect(stats.ruinSurface.spendingMultipliers).toHaveLength(5);
    // Still 5 spending rows, now one cell wide — the axis that survived.
    expect(stats.ruinSurface.ruinProbabilities).toHaveLength(5);
    for (const row of stats.ruinSurface.ruinProbabilities) {
      expect(row).toHaveLength(1);
    }
    // Ruin can only get worse as spending scales up.
    const byMultiplier = stats.ruinSurface.ruinProbabilities.map((row) => row[0]);
    for (let index = 1; index < byMultiplier.length; index++) {
      expect(byMultiplier[index]).toBeGreaterThanOrEqual(byMultiplier[index - 1]);
    }
  });

  it('reports a required starting capital instead of a degenerate P95 balance target', () => {
    const input = retiredInput();
    const { months, retireMonth } = validateSimulationInputs(input, retiredSpending);
    const { stats } = runMonteCarloSimulation(
      input,
      retiredSpending,
      retiredIncome,
      [],
      months,
      retireMonth
    );

    // The old construction would have landed within a percent or two of current savings,
    // because that is all the retirement balances contain. This one is an independent
    // number: it must not simply echo the capital held.
    expect(stats.fiTargetP95).toBeGreaterThan(0);
    expect(Math.abs(stats.fiTargetP95 / input.currentSavings - 1)).toBeGreaterThan(0.02);

    // Coast FIRE has nothing left to stop.
    expect(stats.coastAge).toBeNull();

    // The FI probabilities are a settled comparison, not a distribution.
    expect([0, 1]).toContain(stats.fiProbabilityP95);
    expect([0, 1]).toContain(stats.fiProbabilitySWR);
    expect(stats.fiProbabilityP95).toBe(input.currentSavings >= stats.fiTargetP95 ? 1 : 0);
  });

  it('holds an accumulating plan on the original P95 construction', () => {
    const input = retiredInput({ currentAge: 50, retirementAge: 66 });
    const spending: SpendingPeriod[] = [
      { id: 'sp-default', label: 'Living', fromAge: 50, toAge: 90, yearlyAmount: 40000, inflationAdjusted: true }
    ];
    const income: IncomeSource[] = [
      { id: 'is-default', label: 'Salary', fromAge: 50, toAge: 66, yearlyAmount: 70000, inflationAdjusted: true },
      ...retiredIncome
    ];
    const { months, retireMonth } = validateSimulationInputs(input, spending);
    const { stats } = runMonteCarloSimulation(input, spending, income, [], months, retireMonth);

    expect(retireMonth).toBe(16 * 12);
    // Full retirement-age sweep and a live Coast FIRE age: the two outputs the
    // already-retired branches switch off.
    expect(stats.ruinSurface.retirementAges.length).toBeGreaterThan(1);
    expect(stats.coastAge).not.toBeNull();
    // The P95 target is still read off the spread of balances at retirement, so it sits
    // inside that distribution rather than being an independent capital figure.
    expect(stats.fiTargetP95).toBeGreaterThan(0);
    expect(stats.fiTargetP95).toBeLessThanOrEqual(stats.retireHigh);
  });
});

describe('findRequiredStartingCapital', () => {
  // Two paths: one that grows, one that shrinks. Deterministic, so the answer is a fact
  // about the flows rather than a sampling artefact.
  const months = 24;
  const pathTapes = [
    { assetReturns: new Float64Array(months).fill(0.01), inflationRates: new Float64Array(months) },
    { assetReturns: new Float64Array(months).fill(-0.01), inflationRates: new Float64Array(months) }
  ];
  const noIncome = new Float64Array(months);
  const noLumpSums = new Float64Array(months);
  const strategy = { kind: 'fixed' as const };

  function required(spendPerMonth: number, target: number, income = noIncome): number {
    const spending = new Float64Array(months).fill(spendPerMonth);
    return findRequiredStartingCapital(
      pathTapes,
      {
        monthlyRealIncomeFlow: income,
        monthlyNominalIncomeFlow: new Float64Array(months),
        monthlyRealSpendingFlow: spending,
        monthlyNominalSpendingFlow: new Float64Array(months),
        lumpSumByMonth: noLumpSums
      },
      pathTapes.length,
      months,
      strategy,
      0,
      target,
      10000,
      0,
      0
    );
  }

  it('returns zero when income alone outruns spending on every path', () => {
    // Strictly greater, not equal: the replay counts a balance of exactly zero as ruin, so
    // break-even flows starting from nothing do not survive.
    const income = new Float64Array(months).fill(1200);
    expect(required(1000, 1, income)).toBe(0);
  });

  it('needs more capital to survive both paths than to survive the better one', () => {
    // 50% target only has to satisfy the growing path; 100% must also carry the shrinking
    // one, which sells into a falling market the whole way.
    const lenient = required(1000, 0.5);
    const strict = required(1000, 1);

    expect(lenient).toBeGreaterThan(0);
    expect(strict).toBeGreaterThan(lenient);
  });

  it('is monotone in spending', () => {
    expect(required(2000, 1)).toBeGreaterThan(required(1000, 1));
  });

  it('lands close enough that one more euro of capital flips the outcome', () => {
    const capital = required(1000, 1);
    const spending = new Float64Array(months).fill(1000);
    const ruinAt = (start: number) =>
      findRequiredStartingCapital(
        pathTapes,
        {
          monthlyRealIncomeFlow: noIncome,
          monthlyNominalIncomeFlow: new Float64Array(months),
          monthlyRealSpendingFlow: spending,
          monthlyNominalSpendingFlow: new Float64Array(months),
          lumpSumByMonth: noLumpSums
        },
        pathTapes.length,
        months,
        strategy,
        0,
        1,
        start,
        0,
        0
      );

    // Bracketing from either side converges on the same answer to the stated tolerance.
    expect(ruinAt(10)).toBeCloseTo(capital, -1);
    expect(ruinAt(1_000_000)).toBeCloseTo(capital, -1);
  });

  it('does not return an unverified bracket for an impossible target', () => {
    expect(() => required(1000, 1.01)).toThrow(/between 0 and 1/);
  });

  it('continues beyond the old 24-doubling cap until the bound is verified', () => {
    const capital = required(1e12, 1);
    expect(Number.isFinite(capital)).toBe(true);
    expect(capital).toBeGreaterThan(10_000 * 2 ** 24);
  });
});

describe('moment targeting hits the requested annual moments', () => {
  // TODO 0.15: the monthly targets fed to the retargeting transform must be the ones whose
  // 12-fold compounding reproduces the requested *annual* moments. The old M/12 and
  // S/sqrt(12) were log-scale intuition applied to arithmetic returns and overshot both.
  const targets: Array<[number, number]> = [
    [0.05, 0.15],
    [0.07, 0.18],
    [0.03, 0.1],
    [0.0, 0.2],
    [-0.02, 0.05]
  ];

  it('round-trips: compounding the monthly targets reproduces the annual targets', () => {
    for (const [annualMean, annualStd] of targets) {
      const { mean, std } = monthlyTargetsForAnnualMoments(annualMean, annualStd);

      // Independent months: E[prod] = prod(E), so these identities need no normality.
      const compoundedMean = (1 + mean) ** 12 - 1;
      const compoundedVar = (std ** 2 + (1 + mean) ** 2) ** 12 - (1 + annualMean) ** 2;

      expect(compoundedMean).toBeCloseTo(annualMean, 12);
      expect(Math.sqrt(Math.max(0, compoundedVar))).toBeCloseTo(annualStd, 12);
    }
  });

  it('differs from the naive scaling by the documented amount', () => {
    const { mean, std } = monthlyTargetsForAnnualMoments(0.05, 0.15);
    // Naive would be 0.05/12 = 0.41667% and 0.15/sqrt(12) = 4.3301%.
    expect(mean).toBeLessThan(0.05 / 12);
    expect(std).toBeLessThan(0.15 / Math.sqrt(12));
    expect(mean * 100).toBeCloseTo(0.4074, 3);
    expect(std * 100).toBeCloseTo(4.1216, 3);

    // The naive monthly targets compound to the overshoot recorded in README §4.4.
    const naiveMean = 0.05 / 12;
    const naiveStd = 0.15 / Math.sqrt(12);
    expect(((1 + naiveMean) ** 12 - 1) * 100).toBeCloseTo(5.1162, 3);
    expect(
      Math.sqrt((naiveStd ** 2 + (1 + naiveMean) ** 2) ** 12 - (1 + naiveMean) ** 24) * 100
    ).toBeCloseTo(15.7826, 3);
  });

  it('falls back to naive scaling for a degenerate gross return', () => {
    // No real 12th root of a non-positive gross return; must not emit NaN.
    const wiped = monthlyTargetsForAnnualMoments(-1.5, 0.2);
    expect(Number.isFinite(wiped.mean)).toBe(true);
    expect(Number.isFinite(wiped.std)).toBe(true);
    expect(wiped.mean).toBeCloseTo(-1.5 / 12, 12);

    const nan = monthlyTargetsForAnnualMoments(0.05, Number.NaN);
    expect(Number.isFinite(nan.mean)).toBe(true);
    expect(nan.std).toBe(0);
  });
});
