import {
  type RandomSource,
  type PercentileSeries,
  createRandomSource,
  percentile,
  summarize
} from './calculations';

export type { RandomSource, PercentileSeries };

export type SpendingPeriod = {
  id: string;
  label: string;
  fromAge: number;
  toAge: number;
  yearlyAmount: number;
  inflationAdjusted?: boolean;
};

export type IncomeSource = {
  id: string;
  label: string;
  fromAge: number;
  toAge: number;
  yearlyAmount: number;
  inflationAdjusted?: boolean;
};

export type LumpSumEvent = {
  id: string;
  label: string;
  age: number;
  amount: number;
};

export type WithdrawalStrategyKind = 'fixed' | 'guardrails' | 'percentOfPortfolio';

export type WithdrawalStrategy = {
  kind: WithdrawalStrategyKind;
  guardrailBand?: number;
  adjustment?: number;
  withdrawalPercent?: number;
  spendingFloor?: number;
  spendingCeiling?: number;
};

export const DEFAULT_WITHDRAWAL_STRATEGY: Required<WithdrawalStrategy> = {
  kind: 'fixed',
  guardrailBand: 0.2,
  adjustment: 0.1,
  withdrawalPercent: 0.04,
  spendingFloor: 0.6,
  spendingCeiling: 1.4
};

// Stateful evaluator mirroring the Rust WithdrawalRunner. See that struct for the
// per-strategy semantics; the two must stay in sync.
class WithdrawalRunner {
  private readonly kind: number; // 0 fixed, 1 guardrails, 2 percent
  private readonly guardrailBand: number;
  private readonly adjustment: number;
  private readonly withdrawalPercent: number;
  private readonly spendingFloor: number;
  private readonly spendingCeiling: number;
  private initialized = false;
  private multiplier = 1;
  private initialRate = 0;
  private initialAnnualSpending = 0;
  private heldMonthlySpending = 0;

  constructor(
    strategy: WithdrawalStrategy,
    private readonly baseSpending: Float64Array,
    private readonly retireMonth: number
  ) {
    this.kind = strategy.kind === 'guardrails' ? 1 : strategy.kind === 'percentOfPortfolio' ? 2 : 0;
    this.guardrailBand = Math.max(0.01, strategy.guardrailBand ?? 0.2);
    this.adjustment = Math.min(0.9, Math.max(0, strategy.adjustment ?? 0.1));
    this.withdrawalPercent = Math.max(0, strategy.withdrawalPercent ?? 0.04);
    this.spendingFloor = Math.max(0, strategy.spendingFloor ?? 0.6);
    this.spendingCeiling = Math.max(0, strategy.spendingCeiling ?? 1.4);
  }

  monthlySpending(m: number, balance: number): number {
    const base = this.baseSpending[m];
    if (this.kind === 0 || m < this.retireMonth) return base;

    const isYearStart = (m - this.retireMonth) % 12 === 0;
    if (!this.initialized) {
      this.initialAnnualSpending = base * 12;
      this.initialRate = balance > 0 ? this.initialAnnualSpending / balance : 0;
      this.multiplier = 1;
      this.heldMonthlySpending = base;
      this.initialized = true;
    }

    const floorAnnual = this.spendingFloor * this.initialAnnualSpending;
    const ceilingAnnual = this.spendingCeiling * this.initialAnnualSpending;

    if (this.kind === 1) {
      if (isYearStart && balance > 0 && this.initialRate > 0) {
        const currentAnnual = base * 12 * this.multiplier;
        const currentRate = currentAnnual / balance;
        if (currentRate > this.initialRate * (1 + this.guardrailBand)) {
          this.multiplier *= 1 - this.adjustment;
        } else if (currentRate < this.initialRate * (1 - this.guardrailBand)) {
          this.multiplier *= 1 + this.adjustment;
        }
        this.multiplier = Math.min(this.spendingCeiling, Math.max(this.spendingFloor, this.multiplier));
      }
      return base * this.multiplier;
    }

    if (isYearStart) {
      const targetAnnual = this.withdrawalPercent * Math.max(0, balance);
      const clamped = Math.min(ceilingAnnual, Math.max(floorAnnual, targetAnnual));
      this.heldMonthlySpending = clamped / 12;
    }
    return this.heldMonthlySpending;
  }
}

export type RetirementInput = {
  simulationMode?: 'historical' | 'parametric';
  historicalMomentTargeting?: boolean;
  currentAge: number;
  retirementAge: number;
  simulateUntilAge: number;
  currentSavings: number;
  meanReturn: number;
  returnVariability: number;
  returnSkewness: number;
  returnKurtosis: number;
  equityBondCorrelation: number;
  inflationMean: number;
  inflationVariability: number;
  inflationSkewness: number;
  inflationKurtosis: number;
  inflationCrisisSpread?: number;
  blockLength?: number;
  annualFeePercent: number;
  taxOnGainsPercent: number;
  annualDrag?: number;
  seed?: number;
  safeWithdrawalRate: number;
  withdrawalStrategy?: WithdrawalStrategy;
  simulations: number;
  regimeModel: {
    stayGrowth: number;
    stayCrisis: number;
    growthMean: number;
    growthStd: number;
    crisisMean: number;
    crisisStd: number;
  };
  historicalAnnualReturns?: number[];
  historicalMonthlyReturns?: number[];
  /** Realized monthly inflation aligned index-for-index with `historicalMonthlyReturns`. */
  historicalMonthlyInflation?: number[];
};

export type SimulationResult = {
  months: number;
  ages: number[];
  retireMonth: number;
  percentiles: PercentileSeries<number[]>;
  finalPercentiles: PercentileSeries<number>;
  retirePercentiles: PercentileSeries<number>;
};

export type SummaryStats = {
  fiTarget: number;
  fiTargetSWR: number;
  fiTargetP95: number;
  successProbability: number;
  fiProbabilitySWR: number;
  fiProbabilityP95: number;
  returnMoments: {
    arithmeticMean: number;
    geometricMean: number;
    stdDev: number;
    skewness: number;
    kurtosis: number;
  };
  sequenceRisk: Array<{
    bucketLabel: string;
    earlyYearsMeanReturn: number;
    ruinProbability: number;
    endingMedian: number;
  }>;
  ruinSurface: {
    retirementAges: number[];
    spendingMultipliers: number[];
    ruinProbabilities: number[][];
    /** Paths replayed per cell — capped independently of `simulations`. */
    sampleCount: number;
  };
  shortfallLow: number;
  shortfallMedian: number;
  shortfallHigh: number;
  depletedYearsLow: number;
  depletedYearsMedian: number;
  depletedYearsHigh: number;
  retireLow: number;
  finalMedian: number;
  finalLow: number;
  finalHigh: number;
  retireMedian: number;
  retireHigh: number;
};

const FI_TARGET_SUCCESS_PROBABILITY = 0.95;

const MIN_STATE_PROBABILITY = 0.001;

function clampTransitionProbability(value: number): number {
  return Math.min(1 - MIN_STATE_PROBABILITY, Math.max(MIN_STATE_PROBABILITY, value));
}

function getGrowthStationaryProbability(stayGrowth: number, stayCrisis: number): number {
  const denominator = 2 - stayGrowth - stayCrisis;
  if (denominator <= 1e-9) return 0.5;
  return (1 - stayCrisis) / denominator;
}

function initialRegimeState(stayGrowth: number, stayCrisis: number, rng: RandomSource): 0 | 1 {
  const growthProbability = clampTransitionProbability(getGrowthStationaryProbability(stayGrowth, stayCrisis));
  return rng.random() < growthProbability ? 0 : 1;
}

function transitionRegimeState(currentState: 0 | 1, stayGrowth: number, stayCrisis: number, rng: RandomSource): 0 | 1 {
  if (currentState === 0) {
    return rng.random() < stayGrowth ? 0 : 1;
  }
  return rng.random() < stayCrisis ? 1 : 0;
}

export function drawCornishFisherScore(skewness: number, kurtosis: number, rng: RandomSource): number {
  const z = rng.normal(0, 1);
  const excessKurtosis = Math.max(0, Math.min(8, kurtosis - 3));
  const boundedSkew = Math.max(-1.5, Math.min(1.5, skewness));

  const z2 = z * z;
  const z3 = z2 * z;

  const skewTerm = (boundedSkew / 6) * (z2 - 1);
  const kurtTerm = (excessKurtosis / 24) * (z3 - 3 * z);
  const skewSqTerm = -(boundedSkew * boundedSkew / 36) * (2 * z3 - 5 * z);

  return z + skewTerm + kurtTerm + skewSqTerm;
}

function drawMonthlyReturnShaped(annualMean: number, annualStd: number, skewness: number, kurtosis: number, rng: RandomSource): number {
  const monthlyMean = annualMean / 12;
  const monthlyStd = annualStd / Math.sqrt(12);
  return monthlyMean + monthlyStd * drawCornishFisherScore(skewness, kurtosis, rng);
}

function drawStudentT(df: number, rng: RandomSource): number {
  const safeDf = Math.max(3, Math.round(df));
  const z = rng.normal(0, 1);
  let chiSquare = 0;
  for (let index = 0; index < safeDf; index++) {
    const n = rng.normal(0, 1);
    chiSquare += n * n;
  }
  return z / Math.sqrt(chiSquare / safeDf);
}

function studentTDegreesFromKurtosis(kurtosis: number): number {
  const excess = Math.max(0, kurtosis - 3);
  if (excess < 0.05) return 40;
  const impliedDf = 4 + 6 / excess;
  return Math.max(5, Math.min(60, impliedDf));
}

function clampAnnualReturn(value: number): number {
  return Math.min(1.2, Math.max(-0.95, value));
}

function clampMonthlyReturn(value: number): number {
  return Math.min(0.6, Math.max(-0.6, value));
}

function annualToMonthlyReturn(annualReturn: number): number {
  const capped = clampAnnualReturn(annualReturn);
  return Math.pow(1 + capped, 1 / 12) - 1;
}

/**
 * Spreads one bootstrapped annual return across 12 months with realistic intra-year
 * variation, while preserving the sampled annual return exactly. Mirrors the Rust
 * `spread_annual_return_across_months`; the two must draw from the RNG identically.
 *
 * Annual-mode bootstrapping previously held a constant monthly rate for the whole year,
 * which understated monthly-granularity ruin: a path that dips below zero mid-year and
 * recovers by December was invisible. Each month gets a multiplicative shock, and the 12
 * shocks are renormalised to unit geometric mean so their product is 1 — the year still
 * compounds to exactly the return that was drawn, leaving annual moments untouched.
 */
function spreadAnnualReturnAcrossMonths(
  annualReturn: number,
  monthlyStd: number,
  skewness: number,
  kurtosis: number,
  rng: RandomSource
): number[] {
  const baseFactor = 1 + annualToMonthlyReturn(annualReturn);
  if (!(monthlyStd > 0) || !Number.isFinite(monthlyStd)) {
    return new Array(12).fill(baseFactor - 1);
  }

  const factors: number[] = new Array(12);
  let logSum = 0;
  for (let index = 0; index < 12; index++) {
    const shock = drawCornishFisherScore(skewness, kurtosis, rng);
    // Floor keeps the factor strictly positive so the log below is defined.
    const factor = Math.max(0.05, 1 + monthlyStd * shock);
    factors[index] = factor;
    logSum += Math.log(factor);
  }
  const geometricMean = Math.exp(logSum / 12);

  return factors.map((factor) => clampMonthlyReturn((baseFactor * factor) / geometricMean - 1));
}

function summarizeMeanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(Math.max(0, variance)) };
}

function applyMomentTargeting(
  value: number,
  sourceMean: number,
  sourceStd: number,
  targetMean: number,
  targetStd: number
): number {
  const safeTargetStd = Math.max(0, targetStd);
  if (!Number.isFinite(value) || !Number.isFinite(sourceMean) || !Number.isFinite(sourceStd) || sourceStd <= 1e-12) {
    return targetMean;
  }
  const normalized = (value - sourceMean) / sourceStd;
  return targetMean + normalized * safeTargetStd;
}

export function detectRegimes(annualReturns: number[]): Array<0 | 1> {
  const mean = annualReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, annualReturns.length);
  const variance = annualReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, annualReturns.length);
  const stdDev = Math.sqrt(Math.max(0, variance));
  const crisisThreshold = mean - 0.65 * stdDev;

  const labels: Array<0 | 1> = annualReturns.map((value, index) => {
    const start = Math.max(0, index - 2);
    const window = annualReturns.slice(start, index + 1);
    const windowMean = window.reduce((sum, item) => sum + item, 0) / Math.max(1, window.length);
    const windowVariance = window.reduce((sum, item) => sum + (item - windowMean) ** 2, 0) / Math.max(1, window.length);
    const rollingStd = Math.sqrt(Math.max(0, windowVariance));
    const crisisByReturn = value <= crisisThreshold;
    const crisisByVolatility = rollingStd >= stdDev * 1.15;
    return crisisByReturn || crisisByVolatility ? 1 : 0;
  });

  for (let index = 1; index < labels.length - 1; index++) {
    if (labels[index] === 0 && labels[index - 1] === 1 && labels[index + 1] === 1) {
      labels[index] = 1;
    }
  }

  return labels;
}

function detectRegimesMonthly(monthlyReturns: number[]): Array<0 | 1> {
  const mean = monthlyReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, monthlyReturns.length);
  const variance = monthlyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, monthlyReturns.length);
  const stdDev = Math.sqrt(Math.max(0, variance));
  const crisisThreshold = mean - 0.75 * stdDev;

  const labels: Array<0 | 1> = monthlyReturns.map((value, index) => {
    const start = Math.max(0, index - 5);
    const window = monthlyReturns.slice(start, index + 1);
    const windowMean = window.reduce((sum, item) => sum + item, 0) / Math.max(1, window.length);
    const windowVariance = window.reduce((sum, item) => sum + (item - windowMean) ** 2, 0) / Math.max(1, window.length);
    const rollingStd = Math.sqrt(Math.max(0, windowVariance));
    const crisisByReturn = value <= crisisThreshold;
    const crisisByVolatility = rollingStd >= stdDev * 1.2;
    return crisisByReturn || crisisByVolatility ? 1 : 0;
  });

  for (let index = 1; index < labels.length - 1; index++) {
    if (labels[index] === 0 && labels[index - 1] === 1 && labels[index + 1] === 1) {
      labels[index] = 1;
    }
  }

  return labels;
}

function bootstrapPoolByRegime(annualReturns: number[], labels: Array<0 | 1>): { growth: number[]; crisis: number[] } {
  const growth: number[] = [];
  const crisis: number[] = [];

  for (let index = 0; index < annualReturns.length; index++) {
    if (labels[index] === 1) {
      crisis.push(annualReturns[index]);
    } else {
      growth.push(annualReturns[index]);
    }
  }

  const fallbackGrowth = growth.length > 0 ? growth : [...annualReturns];
  const fallbackCrisis = crisis.length > 0 ? crisis : [...annualReturns].sort((a, b) => a - b).slice(0, Math.max(4, Math.floor(annualReturns.length * 0.35)));
  return { growth: fallbackGrowth, crisis: fallbackCrisis };
}

function bootstrapIndicesByRegimeMonthly(monthlyReturns: number[], labels: Array<0 | 1>): { growth: number[]; crisis: number[] } {
  const growth: number[] = [];
  const crisis: number[] = [];

  for (let index = 0; index < monthlyReturns.length; index++) {
    if (labels[index] === 1) {
      crisis.push(index);
    } else {
      growth.push(index);
    }
  }

  const fallbackGrowth = growth.length > 0 ? growth : Array.from({ length: monthlyReturns.length }, (_, i) => i);
  const fallbackCrisis = crisis.length > 0
    ? crisis
    : [...Array(monthlyReturns.length).keys()].sort((a, b) => monthlyReturns[a] - monthlyReturns[b]).slice(0, Math.max(12, Math.floor(monthlyReturns.length * 0.3)));
  return { growth: fallbackGrowth, crisis: fallbackCrisis };
}

function estimateMarkovStayProbabilities(labels: Array<0 | 1>): { stayGrowth: number; stayCrisis: number } {
  let growthStay = 0;
  let growthTotal = 0;
  let crisisStay = 0;
  let crisisTotal = 0;

  for (let index = 1; index < labels.length; index++) {
    const prev = labels[index - 1];
    const curr = labels[index];
    if (prev === 0) {
      growthTotal++;
      if (curr === 0) growthStay++;
    } else {
      crisisTotal++;
      if (curr === 1) crisisStay++;
    }
  }

  const stayGrowth = clampTransitionProbability(growthTotal > 0 ? growthStay / growthTotal : 0.88);
  const stayCrisis = clampTransitionProbability(crisisTotal > 0 ? crisisStay / crisisTotal : 0.72);
  return { stayGrowth, stayCrisis };
}

function monthlyReturnsToAnnualSeries(monthlyReturns: number[]): number[] {
  const annual: number[] = [];
  let acc = 1;
  let monthCount = 0;
  for (const monthlyReturn of monthlyReturns) {
    acc *= 1 + monthlyReturn;
    monthCount++;
    if (monthCount === 12) {
      annual.push(acc - 1);
      acc = 1;
      monthCount = 0;
    }
  }
  return annual;
}

function buildBootstrapHistory(input: RetirementInput, rng: RandomSource, years = 120): number[] {
  const stayGrowth = clampTransitionProbability(input.regimeModel.stayGrowth);
  const stayCrisis = clampTransitionProbability(input.regimeModel.stayCrisis);
  const growthMean = input.regimeModel.growthMean;
  const growthStd = Math.max(0.01, input.regimeModel.growthStd);
  const crisisMean = input.regimeModel.crisisMean;
  const crisisStd = Math.max(growthStd + 0.01, input.regimeModel.crisisStd);
  const returnDf = studentTDegreesFromKurtosis(input.returnKurtosis);
  const skewShift = Math.max(-2, Math.min(2, input.returnSkewness)) * 0.12;

  const series: number[] = [];
  let state: 0 | 1 = initialRegimeState(stayGrowth, stayCrisis, rng);

  for (let year = 0; year < years; year++) {
    if (year > 0) {
      state = transitionRegimeState(state, stayGrowth, stayCrisis, rng);
    }
    const mean = state === 0 ? growthMean : crisisMean;
    const std = state === 0 ? growthStd : crisisStd;
    const annualReturn = clampAnnualReturn(mean + std * (drawStudentT(returnDf, rng) + skewShift));
    series.push(annualReturn);
  }

  return series;
}

function summarizeReturnMoments(values: number[]): SummaryStats['returnMoments'] {
  if (values.length === 0) {
    return { arithmeticMean: 0, geometricMean: 0, stdDev: 0, skewness: 0, kurtosis: 3 };
  }

  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(Math.max(0, variance));

  const geometricMean = Math.pow(
    values.reduce((product, value) => product * Math.max(0.0001, 1 + value), 1),
    1 / n
  ) - 1;

  if (stdDev <= 1e-9) {
    return { arithmeticMean: mean, geometricMean, stdDev: 0, skewness: 0, kurtosis: 3 };
  }

  const m3 = values.reduce((sum, value) => sum + (value - mean) ** 3, 0) / n;
  const m4 = values.reduce((sum, value) => sum + (value - mean) ** 4, 0) / n;

  return {
    arithmeticMean: mean,
    geometricMean,
    stdDev,
    skewness: m3 / stdDev ** 3,
    kurtosis: m4 / stdDev ** 4
  };
}

function buildSequenceRiskSummary(
  annualRealReturnsBySim: number[][],
  finalBalances: number[],
  depletedFlags: boolean[]
): SummaryStats['sequenceRisk'] {
  const simCount = annualRealReturnsBySim.length;
  if (simCount === 0) return [];

  const earlyYears = Math.max(1, Math.min(10, Math.min(...annualRealReturnsBySim.map((series) => Math.max(1, series.length)))));
  const enriched = annualRealReturnsBySim.map((series, index) => ({
    index,
    earlyMean: series.slice(0, earlyYears).reduce((sum, value) => sum + value, 0) / earlyYears
  })).sort((a, b) => a.earlyMean - b.earlyMean);

  const bucketCount = 5;
  const buckets: SummaryStats['sequenceRisk'] = [];
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const from = Math.floor((bucket * simCount) / bucketCount);
    const to = Math.floor(((bucket + 1) * simCount) / bucketCount);
    const members = enriched.slice(from, to);
    if (members.length === 0) continue;

    const memberIndexes = members.map((member) => member.index);
    const earlyMean = members.reduce((sum, member) => sum + member.earlyMean, 0) / members.length;
    const ruinCount = memberIndexes.reduce((count, index) => count + ((depletedFlags[index] || finalBalances[index] <= 0) ? 1 : 0), 0);
    const memberFinalBalances = memberIndexes.map((index) => finalBalances[index]);
    const endingMedian = summarize(memberFinalBalances).p50;

    const label = bucket === 0
      ? `Q${bucket + 1} (worst early sequence)`
      : bucket === bucketCount - 1
        ? `Q${bucket + 1} (best early sequence)`
        : `Q${bucket + 1}`;

    buckets.push({
      bucketLabel: label,
      earlyYearsMeanReturn: earlyMean,
      ruinProbability: ruinCount / members.length,
      endingMedian
    });
  }

  return buckets;
}

function replayRuinProbability(
  growthFactors: number[][],
  monthlyIncomeFlow: Float64Array,
  monthlySpendingFlow: Float64Array,
  lumpSumByMonth: Float64Array,
  currentSavings: number,
  sampleCount: number,
  months: number,
  strategy: WithdrawalStrategy,
  retireMonth: number
): number {
  let ruinCount = 0;

  for (let sim = 0; sim < sampleCount; sim++) {
    let balance = currentSavings;
    let ruined = false;
    const runner = new WithdrawalRunner(strategy, monthlySpendingFlow, retireMonth);

    for (let month = 0; month < months; month++) {
      const effectiveSpending = runner.monthlySpending(month, balance);
      balance += monthlyIncomeFlow[month] - effectiveSpending + lumpSumByMonth[month];
      balance *= growthFactors[sim][month];
      if (balance <= 0) {
        balance = 0;
        ruined = true;
      }
    }

    if (ruined || balance <= 0) ruinCount++;
  }

  return ruinCount / Math.max(1, sampleCount);
}

function buildRuinSurface(
  input: RetirementInput,
  spendingPeriods: SpendingPeriod[],
  incomeSources: IncomeSource[],
  lumpSumEvents: LumpSumEvent[],
  growthFactors: number[][],
  months: number,
  simCount: number,
  strategy: WithdrawalStrategy
): SummaryStats['ruinSurface'] {
  const spendingMultipliers = [0.8, 0.9, 1.0, 1.1, 1.2];
  const candidateAges = [input.retirementAge - 6, input.retirementAge - 3, input.retirementAge, input.retirementAge + 3, input.retirementAge + 6]
    .map((age) => Math.round(Math.min(input.simulateUntilAge - 1, Math.max(input.currentAge + 1, age))));
  const retirementAges = Array.from(new Set(candidateAges)).sort((a, b) => a - b);
  const sampledScenarios = Math.min(simCount, 2000);

  const ruinProbabilities = spendingMultipliers.map((multiplier) => {
    const scaledSpending = spendingPeriods.map((period) => ({
      ...period,
      yearlyAmount: period.yearlyAmount * multiplier
    }));

    return retirementAges.map((retAge) => {
      const adjustedInput: RetirementInput = { ...input, retirementAge: retAge };
      const adjustedIncome = incomeSources.map((source) => {
        if (source.id === 'is-default') {
          return { ...source, toAge: retAge };
        }
        return { ...source };
      });

      const { monthlyIncomeFlow, monthlySpendingFlow, lumpSumByMonth } = buildCashflowArrays(
        adjustedInput,
        scaledSpending,
        adjustedIncome,
        lumpSumEvents,
        months
      );

      const cellRetireMonth = Math.min(
        months,
        Math.max(0, Math.round((retAge - input.currentAge) * 12))
      );

      return replayRuinProbability(
        growthFactors,
        monthlyIncomeFlow,
        monthlySpendingFlow,
        lumpSumByMonth,
        input.currentSavings,
        sampledScenarios,
        months,
        strategy,
        cellRetireMonth
      );
    });
  });

  return { retirementAges, spendingMultipliers, ruinProbabilities, sampleCount: sampledScenarios };
}

function expectedInflationIndexAtAge(input: RetirementInput, age: number): number {
  const yearsFromNow = Math.max(0, age - input.currentAge);
  return Math.max(1e-9, (1 + input.inflationMean) ** yearsFromNow);
}

export function spendingAtAge(age: number, spendingPeriods: SpendingPeriod[], inflationIndex = 1): number {
  return spendingPeriods
    .filter((period) => period.fromAge <= age && period.toAge > age)
    .reduce((sum, period) => {
      const isInflationAdjusted = period.inflationAdjusted ?? true;
      return sum + (isInflationAdjusted ? period.yearlyAmount : period.yearlyAmount / inflationIndex);
    }, 0);
}

export function incomeAtAge(age: number, incomeSources: IncomeSource[], inflationIndex = 1): number {
  return incomeSources
    .filter((source) => source.fromAge <= age && source.toAge > age)
    .reduce((sum, source) => {
      const isInflationAdjusted = source.inflationAdjusted ?? true;
      return sum + (isInflationAdjusted ? source.yearlyAmount : source.yearlyAmount / inflationIndex);
    }, 0);
}

export function validateSimulationInputs(
  input: RetirementInput,
  spendingPeriods: SpendingPeriod[]
): { months: number; retireMonth: number; error?: string } {
  const months = Math.max(0, Math.round((input.simulateUntilAge - input.currentAge) * 12));
  if (months <= 12) {
    return { months: 0, retireMonth: 0, error: 'Simulation horizon must be at least 1 year beyond current age.' };
  }
  if (input.retirementAge <= input.currentAge) {
    return { months: 0, retireMonth: 0, error: 'Target year to achieve FI must be higher than current age.' };
  }
  if (spendingPeriods.length === 0) {
    return { months: 0, retireMonth: 0, error: 'Add at least one spending period.' };
  }

  const retireMonth = Math.min(months, Math.max(0, Math.round((input.retirementAge - input.currentAge) * 12)));
  return { months, retireMonth };
}

export function buildCashflowArrays(
  input: RetirementInput,
  spendingPeriods: SpendingPeriod[],
  incomeSources: IncomeSource[],
  lumpSumEvents: LumpSumEvent[],
  months: number
): {
  monthlyNetFlow: Float64Array;
  monthlyIncomeFlow: Float64Array;
  monthlySpendingFlow: Float64Array;
  lumpSumByMonth: Float64Array;
} {
  const monthlyNetFlow = new Float64Array(months);
  const monthlyIncomeFlow = new Float64Array(months);
  const monthlySpendingFlow = new Float64Array(months);
  const lumpSumByMonth = new Float64Array(months);

  for (let m = 0; m < months; m++) {
    const age = input.currentAge + m / 12;
    const inflationIndex = expectedInflationIndexAtAge(input, age);
    const income = incomeAtAge(age, incomeSources, inflationIndex) / 12;
    const spending = spendingAtAge(age, spendingPeriods, inflationIndex) / 12;
    monthlyIncomeFlow[m] = income;
    monthlySpendingFlow[m] = spending;
    monthlyNetFlow[m] = income - spending;
  }

  for (const event of lumpSumEvents) {
    const monthIndex = Math.round((event.age - input.currentAge) * 12);
    if (monthIndex >= 0 && monthIndex < months) {
      lumpSumByMonth[monthIndex] += event.amount;
    }
  }

  return { monthlyNetFlow, monthlyIncomeFlow, monthlySpendingFlow, lumpSumByMonth };
}

// `successFlags` must use the same definition as the headline success probability
// (never depleted AND ending balance > 0), so the P95 FI target and the success rate
// agree on what counts as a surviving path.
export function findRetirementBalanceTarget(
  retirementBalances: number[],
  successFlags: boolean[],
  targetSuccessProbability: number
): number {
  const outcomeCount = Math.min(retirementBalances.length, successFlags.length);
  if (outcomeCount === 0) return 0;

  const outcomes = Array.from({ length: outcomeCount }, (_, index) => ({
    retirementBalance: retirementBalances[index],
    endingPositive: successFlags[index]
  })).sort((a, b) => a.retirementBalance - b.retirementBalance);

  const suffixSuccess = new Array(outcomeCount + 1).fill(0);
  for (let index = outcomeCount - 1; index >= 0; index--) {
    suffixSuccess[index] = suffixSuccess[index + 1] + (outcomes[index].endingPositive ? 1 : 0);
  }

  let requiredTarget = outcomes[outcomeCount - 1].retirementBalance;
  for (let index = 0; index < outcomeCount; index++) {
    const sampleSize = outcomeCount - index;
    const successProbability = suffixSuccess[index] / sampleSize;
    if (successProbability >= targetSuccessProbability) {
      requiredTarget = outcomes[index].retirementBalance;
      break;
    }
  }

  return Math.max(0, requiredTarget);
}

export function runMonteCarloSimulation(
  input: RetirementInput,
  spendingPeriods: SpendingPeriod[],
  incomeSources: IncomeSource[],
  lumpSumEvents: LumpSumEvent[],
  months: number,
  retireMonth: number,
  onProgress?: (progress: number) => void
): { simulation: SimulationResult; stats: SummaryStats; simCount: number } {
  const rng = createRandomSource(input.seed);
  const simulationMode = input.simulationMode ?? 'historical';
  const useHistoricalBootstrap = simulationMode === 'historical';
  const targetAnnualMean = input.meanReturn;
  const targetAnnualStd = Math.max(0, input.returnVariability);
  const targetMonthlyMean = targetAnnualMean / 12;
  const targetMonthlyStd = targetAnnualStd / Math.sqrt(12);
  const { monthlyIncomeFlow, monthlySpendingFlow, lumpSumByMonth } = buildCashflowArrays(input, spendingPeriods, incomeSources, lumpSumEvents, months);
  const withdrawalStrategy: WithdrawalStrategy = input.withdrawalStrategy ?? DEFAULT_WITHDRAWAL_STRATEGY;
  const retireMonthClamped = Math.min(months, Math.max(0, retireMonth));
  const stayGrowth = clampTransitionProbability(input.regimeModel.stayGrowth);
  const stayCrisis = clampTransitionProbability(input.regimeModel.stayCrisis);
  const growthMean = input.regimeModel.growthMean;
  const growthStd = Math.max(0, input.regimeModel.growthStd);
  const crisisMean = input.regimeModel.crisisMean;
  const crisisStd = Math.max(0, input.regimeModel.crisisStd);

  const bootstrapHistory =
    useHistoricalBootstrap && input.historicalAnnualReturns && input.historicalAnnualReturns.length >= 25
      ? input.historicalAnnualReturns
      : buildBootstrapHistory(input, rng, 120);
  const annualHistoryMoments = summarizeMeanStd(bootstrapHistory);
  const effectiveAnnualHistory = useHistoricalBootstrap
    ? (input.historicalMomentTargeting
      ? bootstrapHistory.map((value) => applyMomentTargeting(value, annualHistoryMoments.mean, annualHistoryMoments.std, targetAnnualMean, targetAnnualStd))
      : bootstrapHistory).map((value) => clampAnnualReturn(value))
    : bootstrapHistory;

  const monthlyHistory = (useHistoricalBootstrap ? (input.historicalMonthlyReturns ?? []) : [])
    .filter((value) => Number.isFinite(value))
    .map((value) => clampMonthlyReturn(value));
  const monthlyHistoryMoments = summarizeMeanStd(monthlyHistory);
  const effectiveMonthlyHistory = useHistoricalBootstrap
    ? (input.historicalMomentTargeting
      ? monthlyHistory.map((value) => applyMomentTargeting(value, monthlyHistoryMoments.mean, monthlyHistoryMoments.std, targetMonthlyMean, targetMonthlyStd))
      : monthlyHistory).map((value) => clampMonthlyReturn(value))
    : monthlyHistory;
  const useMonthlyCalibration = effectiveMonthlyHistory.length >= 120;

  // Joint (return, inflation) bootstrap — mirrors the Rust engine. Only active when the
  // caller supplies a realized inflation series aligned with the monthly return history.
  const historicalMonthlyInflation =
    useMonthlyCalibration &&
    input.historicalMonthlyInflation &&
    input.historicalMonthlyInflation.length === effectiveMonthlyHistory.length
      ? input.historicalMonthlyInflation
      : null;

  const annualDetectedRegimes = detectRegimes(effectiveAnnualHistory);
  const annualRegimeBootstrapPool = bootstrapPoolByRegime(effectiveAnnualHistory, annualDetectedRegimes);
  const monthlyDetectedRegimes = useMonthlyCalibration ? detectRegimesMonthly(effectiveMonthlyHistory) : [];
  const monthlyRegimeBootstrapIndices = useMonthlyCalibration
    ? bootstrapIndicesByRegimeMonthly(effectiveMonthlyHistory, monthlyDetectedRegimes)
    : { growth: [] as number[], crisis: [] as number[] };

  const monthlyMarkov = useMonthlyCalibration
    ? estimateMarkovStayProbabilities(monthlyDetectedRegimes)
    : {
      stayGrowth: clampTransitionProbability(Math.pow(stayGrowth, 1 / 12)),
      stayCrisis: clampTransitionProbability(Math.pow(stayCrisis, 1 / 12))
    };

  const returnMoments = summarizeReturnMoments(
    useMonthlyCalibration
      ? monthlyReturnsToAnnualSeries(effectiveMonthlyHistory)
      : effectiveAnnualHistory
  );

  const simCount = Math.max(400, Math.round(input.simulations));
  const allBalances: number[][] = Array.from({ length: simCount }, () => new Array(months).fill(0));
  const finalBalances: number[] = [];
  const retireBalances: number[] = [];
  const shortfallTotals: number[] = [];
  const depletedYearsSeries: number[] = [];
  const depletedFlags: boolean[] = [];
  const successFlags: boolean[] = [];
  const annualRealReturnsBySim: number[][] = [];
  const growthFactors: number[][] = Array.from({ length: simCount }, () => new Array(months).fill(1));
  let successCount = 0;

  const spendingAtRetirement = spendingAtAge(input.retirementAge, spendingPeriods);

  const growthProb = getGrowthStationaryProbability(stayGrowth, stayCrisis);
  const crisisProb = 1 - growthProb;
  const requestedInflationSpread = input.inflationCrisisSpread ?? 0.015;
  const maxInflationSpread = Math.sqrt((input.inflationVariability ** 2) / (growthProb * crisisProb));
  const effectiveInflationSpread = Math.min(requestedInflationSpread, maxInflationSpread * 0.8);
  const growthInflationMean = input.inflationMean - crisisProb * effectiveInflationSpread;
  const crisisInflationMean = input.inflationMean + growthProb * effectiveInflationSpread;

  const blockLength = input.blockLength ?? 6;
  const progressUpdateInterval = Math.max(10, Math.floor(simCount / 100));

  for (let sim = 0; sim < simCount; sim++) {
    if (onProgress && sim > 0 && sim % progressUpdateInterval === 0) {
      onProgress(sim / simCount);
    }
    let balance = input.currentSavings;
    let depleted = false;
    let cumulativeShortfall = 0;
    let depletedMonths = 0;
    const annualFeeRate = Math.min(1, Math.max(0, input.annualFeePercent));
    const taxOnGainsRate = Math.min(1, Math.max(0, input.taxOnGainsPercent ?? input.annualDrag ?? 0));
    const monthlyFeeFactor = Math.max(0, 1 - annualFeeRate / 12);
    let regimeState: 0 | 1 = initialRegimeState(monthlyMarkov.stayGrowth, monthlyMarkov.stayCrisis, rng);
    const annualRealReturns: number[] = [];

    let blockRemaining = 0;
    let currentHistoryIndex = 0;
    let activeMonthlyAssetReturn = 0;

    // Annual mode: the 12 monthly returns for the current year, compounding to the
    // sampled annual return (see spreadAnnualReturnAcrossMonths).
    let annualModeMonths: number[] = new Array(12).fill(0);
    if (!useMonthlyCalibration) {
      const startPool = regimeState === 0 ? annualRegimeBootstrapPool.growth : annualRegimeBootstrapPool.crisis;
      annualModeMonths = spreadAnnualReturnAcrossMonths(
        startPool[Math.floor(rng.random() * startPool.length)],
        targetMonthlyStd,
        input.returnSkewness,
        input.returnKurtosis,
        rng
      );
    }

    let annualAssetReturn = 0;
    let annualInflation = 0;
    let yearlyPnl = 0;
    const withdrawalRunner = new WithdrawalRunner(withdrawalStrategy, monthlySpendingFlow, retireMonthClamped);

    for (let m = 0; m < months; m++) {
      let regimeChanged = false;

      if (m > 0) {
        const nextRegimeState = transitionRegimeState(regimeState, monthlyMarkov.stayGrowth, monthlyMarkov.stayCrisis, rng);
        if (nextRegimeState !== regimeState) {
          regimeChanged = true;
          regimeState = nextRegimeState;
        }
      } else {
        regimeChanged = true;
      }

      if (useMonthlyCalibration) {
        if (blockRemaining <= 0 || regimeChanged) {
          const indexPool = regimeState === 0 ? monthlyRegimeBootstrapIndices.growth : monthlyRegimeBootstrapIndices.crisis;
          currentHistoryIndex = indexPool[Math.floor(rng.random() * indexPool.length)];
          blockRemaining = blockLength;
        } else {
          currentHistoryIndex = (currentHistoryIndex + 1) % effectiveMonthlyHistory.length;
        }
        activeMonthlyAssetReturn = effectiveMonthlyHistory[currentHistoryIndex];
        blockRemaining--;
      } else {
        if (m > 0 && m % 12 === 0) {
          const regimePool = regimeState === 0 ? annualRegimeBootstrapPool.growth : annualRegimeBootstrapPool.crisis;
          annualModeMonths = spreadAnnualReturnAcrossMonths(
            regimePool[Math.floor(rng.random() * regimePool.length)],
            targetMonthlyStd,
            input.returnSkewness,
            input.returnKurtosis,
            rng
          );
        }
        // Walk through the current year's months instead of repeating one rate.
        activeMonthlyAssetReturn = annualModeMonths[m % 12];
      }

      // Year-boundary reset must run in every mode (including monthly calibration),
      // otherwise annualRealReturns accumulates since simulation start instead of per year.
      if (m > 0 && m % 12 === 0) {
        annualAssetReturn = 0;
        annualInflation = 0;
      }

      const stressDrift = regimeState === 0 ? 0 : (crisisMean - growthMean) * 0.1;
      const stressNoise = regimeState === 0 ? growthStd * 0.04 : crisisStd * 0.08;
      const monthlyAssetReturn = useMonthlyCalibration
        ? activeMonthlyAssetReturn
        : useHistoricalBootstrap
          ? activeMonthlyAssetReturn
          : activeMonthlyAssetReturn + drawMonthlyReturnShaped(
            stressDrift,
            stressNoise,
            input.returnSkewness,
            input.returnKurtosis,
            rng
          );
      const monthlyPortfolioGrowthFactor = (1 + monthlyAssetReturn) * monthlyFeeFactor;
      const monthlyPortfolioReturnAfterCosts = monthlyPortfolioGrowthFactor - 1;

      // Joint bootstrap: take inflation from the same historical month as the return so
      // the pair keeps its real-world correlation; the regime spread is not applied on
      // top, since the historical series already embeds that co-movement.
      const effectiveInflationMean = regimeState === 0 ? growthInflationMean : crisisInflationMean;
      const monthlyInflation = historicalMonthlyInflation
        ? historicalMonthlyInflation[currentHistoryIndex]
        : drawMonthlyReturnShaped(
            effectiveInflationMean,
            input.inflationVariability,
            input.inflationSkewness,
            input.inflationKurtosis,
            rng
          );
      annualAssetReturn = (1 + annualAssetReturn) * (1 + monthlyPortfolioReturnAfterCosts) - 1;
      annualInflation = (1 + annualInflation) * (1 + monthlyInflation) - 1;

      const effectiveSpending = withdrawalRunner.monthlySpending(m, balance);
      balance += monthlyIncomeFlow[m] - effectiveSpending + lumpSumByMonth[m];
      const pnlMonth = Math.max(0, balance) * (monthlyPortfolioGrowthFactor - 1);
      balance *= monthlyPortfolioGrowthFactor;
      balance /= 1 + monthlyInflation;
      // Track the year's investment P&L (net of fees, gross of inflation) in the same
      // deflated units as the balance, so nominal gains are taxed in today's-money terms.
      yearlyPnl = (yearlyPnl + pnlMonth) / (1 + monthlyInflation);
      growthFactors[sim][m] = monthlyPortfolioGrowthFactor / (1 + monthlyInflation);

      // Annual net-gain taxation: tax positive net annual P&L at each year boundary
      // (and the final partial year). Losses are untaxed and not carried forward.
      // Applied as a multiplicative factor so ruin-surface replay carries the tax.
      if (m % 12 === 11 || m === months - 1) {
        if (balance > 0 && yearlyPnl > 0 && taxOnGainsRate > 0) {
          const tax = Math.min(yearlyPnl * taxOnGainsRate, balance);
          const taxFactor = (balance - tax) / balance;
          balance -= tax;
          growthFactors[sim][m] *= taxFactor;
          annualAssetReturn = (1 + annualAssetReturn) * taxFactor - 1;
        }
        yearlyPnl = 0;
      }

      if (balance <= 0) {
        cumulativeShortfall += Math.max(0, -balance);
        depleted = true;
        balance = 0;
      }

      if (m % 12 === 11 || m === months - 1) {
        annualRealReturns.push((1 + annualAssetReturn) / Math.max(0.0001, 1 + annualInflation) - 1);
      }

      if (balance === 0) depletedMonths++;
      allBalances[sim][m] = balance;
    }

    const retireIndex = Math.max(0, Math.min(retireMonth - 1, months - 1));
    retireBalances.push(allBalances[sim][retireIndex]);
    finalBalances.push(balance);
    shortfallTotals.push(cumulativeShortfall);
    depletedYearsSeries.push(depletedMonths / 12);
    depletedFlags.push(depleted);
    annualRealReturnsBySim.push(annualRealReturns);

    const success = !depleted && balance > 0;
    successFlags.push(success);
    if (success) successCount++;
  }

  const targetFIP95 = findRetirementBalanceTarget(retireBalances, successFlags, FI_TARGET_SUCCESS_PROBABILITY);
  const targetFISWR = spendingAtRetirement / Math.max(0.01, input.safeWithdrawalRate);
  const fiCountP95 = retireBalances.filter((balance) => balance >= targetFIP95).length;
  const fiCountSWR = retireBalances.filter((balance) => balance >= targetFISWR).length;

  const percentileSeries: PercentileSeries<number[]> = { p10: [], p25: [], p50: [], p75: [], p90: [] };
  const column = new Array(simCount);
  for (let m = 0; m < months; m++) {
    for (let s = 0; s < simCount; s++) column[s] = allBalances[s][m];
    column.sort((a, b) => a - b);
    percentileSeries.p10.push(percentile(column, 0.1));
    percentileSeries.p25.push(percentile(column, 0.25));
    percentileSeries.p50.push(percentile(column, 0.5));
    percentileSeries.p75.push(percentile(column, 0.75));
    percentileSeries.p90.push(percentile(column, 0.9));
  }

  const simulation: SimulationResult = {
    months,
    ages: Array.from({ length: months }, (_, i) => Number((input.currentAge + i / 12).toFixed(2))),
    retireMonth,
    percentiles: percentileSeries,
    finalPercentiles: summarize(finalBalances),
    retirePercentiles: summarize(retireBalances)
  };

  const shortfallPercentiles = summarize(shortfallTotals);
  const depletedYearsPercentiles = summarize(depletedYearsSeries);
  const sequenceRisk = buildSequenceRiskSummary(annualRealReturnsBySim, finalBalances, depletedFlags);
  const ruinSurface = buildRuinSurface(
    input,
    spendingPeriods,
    incomeSources,
    lumpSumEvents,
    growthFactors,
    months,
    simCount,
    withdrawalStrategy
  );

  const stats: SummaryStats = {
    fiTarget: targetFIP95,
    fiTargetSWR: targetFISWR,
    fiTargetP95: targetFIP95,
    successProbability: successCount / simCount,
    fiProbabilitySWR: fiCountSWR / simCount,
    fiProbabilityP95: fiCountP95 / simCount,
    returnMoments,
    sequenceRisk,
    ruinSurface,
    shortfallLow: shortfallPercentiles.p10,
    shortfallMedian: shortfallPercentiles.p50,
    shortfallHigh: shortfallPercentiles.p90,
    depletedYearsLow: depletedYearsPercentiles.p10,
    depletedYearsMedian: depletedYearsPercentiles.p50,
    depletedYearsHigh: depletedYearsPercentiles.p90,
    retireLow: simulation.retirePercentiles.p10,
    finalMedian: simulation.finalPercentiles.p50,
    finalLow: simulation.finalPercentiles.p10,
    finalHigh: simulation.finalPercentiles.p90,
    retireMedian: simulation.retirePercentiles.p50,
    retireHigh: simulation.retirePercentiles.p90
  };

  return { simulation, stats, simCount };
}
