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
	private initialAnnualPortfolioSpending = 0;
	private heldMonthlyPortfolioSpending = 0;

	constructor(
		strategy: WithdrawalStrategy,
		private readonly retireMonth: number
	) {
		this.kind = strategy.kind === 'guardrails' ? 1 : strategy.kind === 'percentOfPortfolio' ? 2 : 0;
		this.guardrailBand = Math.max(0.01, strategy.guardrailBand ?? 0.2);
		this.adjustment = Math.min(0.9, Math.max(0, strategy.adjustment ?? 0.1));
		this.withdrawalPercent = Math.max(0, strategy.withdrawalPercent ?? 0.04);
		this.spendingFloor = Math.max(0, strategy.spendingFloor ?? 0.6);
		this.spendingCeiling = Math.max(this.spendingFloor, strategy.spendingCeiling ?? 1.4);
	}

	/**
	 * `base` and `income` are the month's planned cash flows expressed in real terms. With nominal
	 * items deflated by that path's realized inflation it is path-dependent, so it can no
	 * longer be read from a precomputed array.
	 */
	monthlySpending(m: number, balance: number, base: number, income = 0): number {
		if (this.kind === 0 || m < this.retireMonth) return base;

		const isYearStart = (m - this.retireMonth) % 12 === 0;
		const portfolioBase = Math.max(0, base - income);
		if (!this.initialized) {
			this.initialAnnualSpending = base * 12;
			this.initialAnnualPortfolioSpending = portfolioBase * 12;
			this.initialRate = balance > 0 ? this.initialAnnualPortfolioSpending / balance : 0;
			this.multiplier = 1;
			this.heldMonthlyPortfolioSpending = portfolioBase;
			this.initialized = true;
		}

		const floorAnnual = this.spendingFloor * this.initialAnnualSpending;
		const ceilingAnnual = this.spendingCeiling * this.initialAnnualSpending;
		const monthlyFloor = floorAnnual / 12;
		const monthlyCeiling = ceilingAnnual / 12;

		if (this.kind === 1) {
			if (isYearStart && balance > 0 && this.initialRate > 0) {
				const currentAnnual = portfolioBase * 12 * this.multiplier;
				const currentRate = currentAnnual / balance;
				if (currentRate > this.initialRate * (1 + this.guardrailBand)) {
					this.multiplier *= 1 - this.adjustment;
				} else if (currentRate < this.initialRate * (1 - this.guardrailBand)) {
					this.multiplier *= 1 + this.adjustment;
				}
				this.multiplier = Math.min(
					this.spendingCeiling,
					Math.max(this.spendingFloor, this.multiplier)
				);
			}
			const totalSpending = income + portfolioBase * this.multiplier;
			return Math.max(income, Math.min(monthlyCeiling, Math.max(monthlyFloor, totalSpending)));
		}

		if (isYearStart) {
			const annualIncome = income * 12;
			const targetAnnualSpending = annualIncome + this.withdrawalPercent * Math.max(0, balance);
			const clampedTotal = Math.min(ceilingAnnual, Math.max(floorAnnual, targetAnnualSpending));
			this.heldMonthlyPortfolioSpending = Math.max(0, clampedTotal - annualIncome) / 12;
		}
		return income + this.heldMonthlyPortfolioSpending;
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
	/** 101 evenly spaced quantiles of ending wealth for the outcome CDF. */
	finalWealthCdf: {
		balances: number[];
		probabilities: number[];
	};
};

export type SummaryStats = {
	/**
	 * Coast FIRE: earliest age at which contributions could stop while still clearing the FI
	 * success target. `null` when there are no positive pre-retirement contributions to
	 * stop, or when the target is unreachable even by contributing until retirement.
	 */
	coastAge: number | null;
	fiTarget: number;
	fiTargetSWR: number;
	fiTargetP95: number;
	successProbability: number;
	fiProbabilitySWR: number;
	fiProbabilityP95: number;
	requestedReturnMoments: {
		arithmeticMean: number;
		stdDev: number;
		skewness: number;
		kurtosis: number;
	};
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
	/**
	 * Age by which the money had first run out, at the 10th and 50th percentile of the
	 * first-shortfall distribution. `depletionAgeP10` reads as "in the worst 10% of
	 * futures, funds were gone by this age".
	 *
	 * `null` when that percentile lands on a path that never ran short — e.g. a plan
	 * succeeding in 96% of futures has no median depletion age. Paths that never deplete
	 * are ranked as "never", so they push the percentile later rather than being dropped;
	 * dropping them would report the depletion age *among failures only*, which looks
	 * alarming on a plan that rarely fails at all.
	 */
	depletionAgeP10: number | null;
	depletionAgeP50: number | null;
	/** Typical severity among failed paths only; null when no simulated path failed. */
	failureMedianDepletionAge: number | null;
	failureMedianShortfall: number | null;
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
	const growthProbability = clampTransitionProbability(
		getGrowthStationaryProbability(stayGrowth, stayCrisis)
	);
	return rng.random() < growthProbability ? 0 : 1;
}

function transitionRegimeState(
	currentState: 0 | 1,
	stayGrowth: number,
	stayCrisis: number,
	rng: RandomSource
): 0 | 1 {
	if (currentState === 0) {
		return rng.random() < stayGrowth ? 0 : 1;
	}
	return rng.random() < stayCrisis ? 1 : 0;
}

export function drawCornishFisherScore(
	skewness: number,
	kurtosis: number,
	rng: RandomSource
): number {
	const z = rng.normal(0, 1);
	const excessKurtosis = Math.max(0, Math.min(8, kurtosis - 3));
	const boundedSkew = Math.max(-1.5, Math.min(1.5, skewness));

	const z2 = z * z;
	const z3 = z2 * z;

	const skewTerm = (boundedSkew / 6) * (z2 - 1);
	const kurtTerm = (excessKurtosis / 24) * (z3 - 3 * z);
	const skewSqTerm = -((boundedSkew * boundedSkew) / 36) * (2 * z3 - 5 * z);

	return z + skewTerm + kurtTerm + skewSqTerm;
}

function drawMonthlyReturnShaped(
	annualMean: number,
	annualStd: number,
	skewness: number,
	kurtosis: number,
	rng: RandomSource
): number {
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

/**
 * Inverts 12-fold compounding: given the requested *annual* arithmetic mean and standard
 * deviation, returns the monthly mean/std whose compounding over 12 independent months
 * reproduces them.
 *
 *   E[(1+r_a)]   = E[(1+r_m)]^12       =>  m = (1+M)^(1/12) - 1
 *   E[(1+r_a)^2] = E[(1+r_m)^2]^12     =>  s = sqrt( ((1+M)^2 + S^2)^(1/12) - (1+M)^(2/12) )
 *
 * Both identities need only independence, not normality, since the expectation of a
 * product of independent factors is the product of expectations — so higher moments of
 * the retargeted history do not enter.
 *
 * The naive `M/12` and `S/sqrt(12)` are the *log*-scale intuition applied to arithmetic
 * returns; used here they overshoot, because compounding adds the cross-product terms this
 * inversion removes. At a 5%/15% target they yield 5.12%/15.79% instead of 5.00%/15.00%.
 *
 * This corrects the compounding artifact only. The block bootstrap deliberately preserves
 * serial dependence, which inflates realized annual variance further and is not an error —
 * see README §4.4 for the measured residual.
 */
export function monthlyTargetsForAnnualMoments(
	annualMean: number,
	annualStd: number
): { mean: number; std: number } {
	const growth = 1 + annualMean;
	// A non-positive gross return (total loss or worse) has no real 12th root; fall back to
	// the naive scaling rather than produce NaN. Not reachable from the UI, which bounds the
	// mean well above -100%.
	if (!Number.isFinite(growth) || growth <= 0 || !Number.isFinite(annualStd)) {
		// `Math.max(0, NaN)` is NaN, unlike Rust's `f64::max`, which returns the non-NaN
		// operand. Sanitize explicitly so both engines agree on degenerate input.
		const safeStd = Number.isFinite(annualStd) ? Math.max(0, annualStd) : 0;
		return { mean: annualMean / 12, std: safeStd / Math.sqrt(12) };
	}

	const monthlyMean = growth ** (1 / 12) - 1;
	const monthlySecondMoment = (growth * growth + annualStd * annualStd) ** (1 / 12);
	const monthlyVariance = monthlySecondMoment - growth ** (2 / 12);
	return { mean: monthlyMean, std: Math.sqrt(Math.max(0, monthlyVariance)) };
}

function applyMomentTargeting(
	value: number,
	sourceMean: number,
	sourceStd: number,
	targetMean: number,
	targetStd: number
): number {
	const safeTargetStd = Math.max(0, targetStd);
	if (
		!Number.isFinite(value) ||
		!Number.isFinite(sourceMean) ||
		!Number.isFinite(sourceStd) ||
		sourceStd <= 1e-12
	) {
		return targetMean;
	}
	const normalized = (value - sourceMean) / sourceStd;
	return targetMean + normalized * safeTargetStd;
}

export function detectRegimes(annualReturns: number[]): Array<0 | 1> {
	const mean =
		annualReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, annualReturns.length);
	const variance =
		annualReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		Math.max(1, annualReturns.length);
	const stdDev = Math.sqrt(Math.max(0, variance));
	const crisisThreshold = mean - 0.65 * stdDev;

	const labels: Array<0 | 1> = annualReturns.map((value, index) => {
		const start = Math.max(0, index - 2);
		const window = annualReturns.slice(start, index + 1);
		const windowMean = window.reduce((sum, item) => sum + item, 0) / Math.max(1, window.length);
		const windowVariance =
			window.reduce((sum, item) => sum + (item - windowMean) ** 2, 0) / Math.max(1, window.length);
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
	const mean =
		monthlyReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, monthlyReturns.length);
	const variance =
		monthlyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		Math.max(1, monthlyReturns.length);
	const stdDev = Math.sqrt(Math.max(0, variance));
	const crisisThreshold = mean - 0.75 * stdDev;

	const labels: Array<0 | 1> = monthlyReturns.map((value, index) => {
		const start = Math.max(0, index - 5);
		const window = monthlyReturns.slice(start, index + 1);
		const windowMean = window.reduce((sum, item) => sum + item, 0) / Math.max(1, window.length);
		const windowVariance =
			window.reduce((sum, item) => sum + (item - windowMean) ** 2, 0) / Math.max(1, window.length);
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

function bootstrapPoolByRegime(
	annualReturns: number[],
	labels: Array<0 | 1>
): { growth: number[]; crisis: number[] } {
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
	const fallbackCrisis =
		crisis.length > 0
			? crisis
			: [...annualReturns]
					.sort((a, b) => a - b)
					.slice(0, Math.max(4, Math.floor(annualReturns.length * 0.35)));
	return { growth: fallbackGrowth, crisis: fallbackCrisis };
}

function bootstrapIndicesByRegimeMonthly(
	monthlyReturns: number[],
	labels: Array<0 | 1>
): { growth: number[]; crisis: number[] } {
	const growth: number[] = [];
	const crisis: number[] = [];

	for (let index = 0; index < monthlyReturns.length; index++) {
		if (labels[index] === 1) {
			crisis.push(index);
		} else {
			growth.push(index);
		}
	}

	const fallbackGrowth =
		growth.length > 0 ? growth : Array.from({ length: monthlyReturns.length }, (_, i) => i);
	const fallbackCrisis =
		crisis.length > 0
			? crisis
			: [...Array(monthlyReturns.length).keys()]
					.sort((a, b) => monthlyReturns[a] - monthlyReturns[b])
					.slice(0, Math.max(12, Math.floor(monthlyReturns.length * 0.3)));
	return { growth: fallbackGrowth, crisis: fallbackCrisis };
}

function estimateMarkovStayProbabilities(labels: Array<0 | 1>): {
	stayGrowth: number;
	stayCrisis: number;
} {
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

	const geometricMean =
		Math.pow(
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

/**
 * Groups simulations into quintiles by their mean real return over the first ten
 * *post-retirement* years — the Kitces/Pfau danger window, when withdrawals turn a
 * drawdown into permanently sold-off capital. The caller supplies retirement-relative
 * annual buckets, so a fractional retirement age never mixes accumulation months into
 * the first bucket.
 */
export function buildSequenceRiskSummary(
	annualRealReturnsBySim: number[][],
	finalBalances: number[],
	depletedFlags: boolean[]
): SummaryStats['sequenceRisk'] {
	const simCount = annualRealReturnsBySim.length;
	if (simCount === 0 || annualRealReturnsBySim.some((series) => series.length === 0)) return [];

	const earlyYears = Math.min(
		10,
		Math.min(...annualRealReturnsBySim.map((series) => series.length))
	);
	const enriched = annualRealReturnsBySim
		.map((series, index) => ({
			index,
			earlyMean: series.slice(0, earlyYears).reduce((sum, value) => sum + value, 0) / earlyYears
		}))
		.sort((a, b) => a.earlyMean - b.earlyMean);

	const bucketCount = 5;
	const buckets: SummaryStats['sequenceRisk'] = [];
	for (let bucket = 0; bucket < bucketCount; bucket++) {
		const from = Math.floor((bucket * simCount) / bucketCount);
		const to = Math.floor(((bucket + 1) * simCount) / bucketCount);
		const members = enriched.slice(from, to);
		if (members.length === 0) continue;

		const memberIndexes = members.map((member) => member.index);
		const earlyMean = members.reduce((sum, member) => sum + member.earlyMean, 0) / members.length;
		const ruinCount = memberIndexes.reduce(
			(count, index) => count + (depletedFlags[index] ? 1 : 0),
			0
		);
		const memberFinalBalances = memberIndexes.map((index) => finalBalances[index]);
		const endingMedian = summarize(memberFinalBalances).p50;

		const label =
			bucket === 0
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

/** Compound monthly real growth factors into retirement-relative 12-month buckets. */
export function annualizePostRetirementGrowthFactors(
	monthlyGrowthFactors: number[],
	retireMonth: number
): number[] {
	const start = Math.min(monthlyGrowthFactors.length, Math.max(0, retireMonth));
	const annualReturns: number[] = [];
	let yearGrowth = 1;
	for (let month = start; month < monthlyGrowthFactors.length; month++) {
		yearGrowth *= monthlyGrowthFactors[month];
		if ((month - start) % 12 === 11 || month === monthlyGrowthFactors.length - 1) {
			annualReturns.push(yearGrowth - 1);
			yearGrowth = 1;
		}
	}
	return annualReturns;
}

export type PathTape = {
	assetReturns: Float64Array;
	inflationRates: Float64Array;
};

type ExactCashflowArrays = Pick<
	ReturnType<typeof buildCashflowArrays>,
	| 'monthlyRealIncomeFlow'
	| 'monthlyNominalIncomeFlow'
	| 'monthlyRealSpendingFlow'
	| 'monthlyNominalSpendingFlow'
	| 'lumpSumByMonth'
>;

export type PathEvaluation = {
	balances: Float64Array;
	finalBalance: number;
	cumulativeShortfall: number;
	depletedMonths: number;
	/**
	 * Month index of the first shortfall, or `null` if the path never ran short. This is
	 * the *onset*, which `depletedMonths` cannot supply: a balance may return above zero
	 * when a pension starts or a lump sum lands, so the zero months are not necessarily
	 * contiguous and `months - depletedMonths` is not the age the money first ran out.
	 */
	firstDepletionMonth: number | null;
	depleted: boolean;
	annualRealReturns: number[];
};

/**
 * Runs all balance-dependent accounting against an exogenous return/inflation tape.
 * Main simulations and scenario replays use this same function, so changing capital or
 * cash flows also recomputes nominal deflation, withdrawals and annual gains tax.
 *
 * When `stopContributionsAt` is set, only positive pre-retirement net cash flow is removed:
 * income is capped at spending for those months. Deficits and lump sums remain scheduled.
 */
export function evaluatePath(
	tape: PathTape,
	cashflows: ExactCashflowArrays,
	currentSavings: number,
	months: number,
	strategy: WithdrawalStrategy,
	retireMonth: number,
	annualFeePercent: number,
	taxOnGainsPercent: number,
	stopContributionsAt?: number,
	recordSeries = true
): PathEvaluation {
	return evaluatePathFromMonth(
		tape,
		cashflows,
		currentSavings,
		months,
		strategy,
		retireMonth,
		annualFeePercent,
		taxOnGainsPercent,
		0,
		stopContributionsAt,
		recordSeries
	);
}

/**
 * Replays a path from an existing point on its original timeline. The prefix is used only
 * to reconstruct the realized inflation index; portfolio accounting begins at `startMonth`
 * with `currentSavings`. This is what lets the FI target vary retirement-date capital
 * without retaining the accumulation balance or losing pre-retirement inflation on nominal
 * pensions and expenses.
 */
export function evaluatePathFromMonth(
	tape: PathTape,
	cashflows: ExactCashflowArrays,
	currentSavings: number,
	months: number,
	strategy: WithdrawalStrategy,
	retireMonth: number,
	annualFeePercent: number,
	taxOnGainsPercent: number,
	startMonth: number,
	stopContributionsAt?: number,
	recordSeries = true
): PathEvaluation {
	const monthCount = Math.min(months, tape.assetReturns.length, tape.inflationRates.length);
	const replayStartMonth = Math.min(monthCount, Math.max(0, Math.floor(startMonth)));
	const balances = recordSeries ? new Float64Array(months) : new Float64Array(0);
	let balance = currentSavings;
	let depleted = false;
	let cumulativeShortfall = 0;
	let depletedMonths = 0;
	let firstDepletionMonth: number | null = null;
	let yearlyPnl = 0;
	let realizedInflationIndex = 1;
	for (let month = 0; month < replayStartMonth; month++) {
		realizedInflationIndex *= 1 + tape.inflationRates[month];
	}
	let sequenceYearGrowth = 1;
	const annualRealReturns: number[] = [];
	const monthlyFeeFactor = Math.max(0, 1 - Math.min(1, Math.max(0, annualFeePercent)) / 12);
	const taxRate = Math.min(1, Math.max(0, taxOnGainsPercent));
	const runner = new WithdrawalRunner(strategy, retireMonth);

	for (let month = replayStartMonth; month < monthCount; month++) {
		const monthlyInflation = tape.inflationRates[month];
		const inflationFactor = 1 + monthlyInflation;
		let income =
			cashflows.monthlyRealIncomeFlow[month] +
			cashflows.monthlyNominalIncomeFlow[month] / realizedInflationIndex;
		const baseSpending =
			cashflows.monthlyRealSpendingFlow[month] +
			cashflows.monthlyNominalSpendingFlow[month] / realizedInflationIndex;

		if (
			stopContributionsAt !== undefined &&
			month >= stopContributionsAt &&
			month < retireMonth &&
			income > baseSpending
		) {
			income = baseSpending;
		}

		const effectiveSpending = runner.monthlySpending(month, balance, baseSpending, income);
		balance += income - effectiveSpending + cashflows.lumpSumByMonth[month];
		if (balance < 0) {
			cumulativeShortfall += -balance;
			if (!depleted) firstDepletionMonth = month;
			depleted = true;
			balance = 0;
		}

		const portfolioGrowthFactor = (1 + tape.assetReturns[month]) * monthlyFeeFactor;
		const pnlMonth = balance * (portfolioGrowthFactor - 1);
		balance *= portfolioGrowthFactor;
		balance /= inflationFactor;
		realizedInflationIndex *= inflationFactor;
		yearlyPnl = (yearlyPnl + pnlMonth) / inflationFactor;

		let realGrowthFactor = portfolioGrowthFactor / inflationFactor;
		if (month % 12 === 11 || month === monthCount - 1) {
			if (balance > 0 && yearlyPnl > 0 && taxRate > 0) {
				const tax = Math.min(yearlyPnl * taxRate, balance);
				const taxFactor = (balance - tax) / balance;
				balance -= tax;
				realGrowthFactor *= taxFactor;
			}
			yearlyPnl = 0;
		}

		if (balance < 0) {
			balance = 0;
		}

		if (recordSeries && month >= retireMonth) {
			sequenceYearGrowth *= realGrowthFactor;
			const retirementMonthIndex = month - retireMonth;
			if (retirementMonthIndex % 12 === 11 || month === monthCount - 1) {
				annualRealReturns.push(sequenceYearGrowth - 1);
				sequenceYearGrowth = 1;
			}
		}

		if (depleted && balance === 0) depletedMonths++;
		if (recordSeries) balances[month] = balance;
	}

	return {
		balances,
		finalBalance: balance,
		cumulativeShortfall,
		depletedMonths,
		firstDepletionMonth,
		depleted,
		annualRealReturns
	};
}

function replayRuinProbability(
	pathTapes: PathTape[],
	cashflows: ExactCashflowArrays,
	currentSavings: number,
	sampleCount: number,
	months: number,
	strategy: WithdrawalStrategy,
	retireMonth: number,
	annualFeePercent: number,
	taxOnGainsPercent: number,
	stopContributionsAt?: number
): number {
	let ruinCount = 0;
	const replayCount = Math.min(sampleCount, pathTapes.length);

	for (let sim = 0; sim < replayCount; sim++) {
		const result = evaluatePath(
			pathTapes[sim],
			cashflows,
			currentSavings,
			months,
			strategy,
			retireMonth,
			annualFeePercent,
			taxOnGainsPercent,
			stopContributionsAt,
			false
		);
		if (result.depleted) ruinCount++;
	}

	return ruinCount / Math.max(1, replayCount);
}

/**
 * Smallest starting capital that still clears `targetSuccessProbability`, found by
 * bisection over exact replays of stored exogenous return/inflation paths.
 *
 * The public wrapper starts at month zero for already-retired plans. Future-retirement
 * targets use `findRequiredCapitalAtMonth` directly at the retirement boundary, holding
 * return/inflation tapes fixed while varying capital.
 *
 * Success is monotone non-decreasing in starting capital along fixed paths, so bisection is
 * exact up to the tolerance. Returns 0 when income alone survives every path. Throws if
 * invalid inputs or floating-point limits prevent a valid upper bracket; it never returns
 * an unverified capital amount as though it met the target.
 *
 * Mirrored in Rust as `find_required_starting_capital`.
 */
export function findRequiredStartingCapital(
	pathTapes: PathTape[],
	cashflows: ExactCashflowArrays,
	sampleCount: number,
	months: number,
	strategy: WithdrawalStrategy,
	retireMonth: number,
	targetSuccessProbability: number,
	initialGuess: number,
	annualFeePercent: number,
	taxOnGainsPercent: number
): number {
	return findRequiredCapitalAtMonth(
		pathTapes,
		cashflows,
		sampleCount,
		months,
		strategy,
		retireMonth,
		0,
		targetSuccessProbability,
		initialGuess,
		annualFeePercent,
		taxOnGainsPercent
	);
}

export function findRequiredCapitalAtMonth(
	pathTapes: PathTape[],
	cashflows: ExactCashflowArrays,
	sampleCount: number,
	months: number,
	strategy: WithdrawalStrategy,
	retireMonth: number,
	startMonth: number,
	targetSuccessProbability: number,
	initialGuess: number,
	annualFeePercent: number,
	taxOnGainsPercent: number
): number {
	if (sampleCount === 0 || pathTapes.length === 0) return 0;
	if (!(targetSuccessProbability >= 0 && targetSuccessProbability <= 1)) {
		throw new RangeError('Target success probability must be between 0 and 1.');
	}

	const successAt = (capital: number) => {
		let ruinCount = 0;
		const replayCount = Math.min(sampleCount, pathTapes.length);
		for (let sim = 0; sim < replayCount; sim++) {
			const result = evaluatePathFromMonth(
				pathTapes[sim],
				cashflows,
				capital,
				months,
				strategy,
				retireMonth,
				annualFeePercent,
				taxOnGainsPercent,
				startMonth,
				undefined,
				false
			);
			if (result.depleted) ruinCount++;
		}
		return 1 - ruinCount / Math.max(1, replayCount);
	};

	if (successAt(0) >= targetSuccessProbability) return 0;

	// Bracket upward from the SWR target, which is the right order of magnitude whenever
	// spending dominates. Keep expanding while finite instead of imposing an arbitrary
	// number of doublings: a small initial guess must not silently become a false answer.
	let low = 0;
	let high = Number.isFinite(initialGuess) ? Math.max(1, initialGuess) : 1;
	while (successAt(high) < targetSuccessProbability) {
		low = high;
		high *= 2;
		if (!Number.isFinite(high)) {
			throw new Error(
				'Could not bracket the required starting capital within finite numeric limits.'
			);
		}
	}

	// Relative tolerance rather than absolute: the answer spans a few thousand to tens of
	// millions depending on the plan's currency and scale.
	for (let step = 0; step < 60 && high - low > Math.max(1, high * 1e-4); step++) {
		const mid = (low + high) / 2;
		if (successAt(mid) >= targetSuccessProbability) {
			high = mid;
		} else {
			low = mid;
		}
	}

	return high;
}

/**
 * Coast FIRE: the earliest age at which contributions could stop while still clearing
 * `targetSuccessProbability`. Mirrors the Rust `find_coast_age` — see that function for
 * the modelling choices and caveats.
 */
function findCoastAge(
	input: RetirementInput,
	spendingPeriods: SpendingPeriod[],
	incomeSources: IncomeSource[],
	lumpSumEvents: LumpSumEvent[],
	pathTapes: PathTape[],
	months: number,
	sampleCount: number,
	strategy: WithdrawalStrategy,
	retireMonth: number,
	targetSuccessProbability: number
): number | null {
	if (retireMonth === 0 || sampleCount === 0 || pathTapes.length === 0) return null;

	const base = buildCashflowArrays(input, spendingPeriods, incomeSources, lumpSumEvents, months);

	// Coast FIRE removes only positive contributions. Deficit months and lump sums remain
	// on their original schedule.
	const hasContribution = pathTapes.some((tape) => {
		let inflationIndex = 1;
		for (let month = 0; month < retireMonth; month++) {
			const income =
				base.monthlyRealIncomeFlow[month] + base.monthlyNominalIncomeFlow[month] / inflationIndex;
			const spending =
				base.monthlyRealSpendingFlow[month] +
				base.monthlyNominalSpendingFlow[month] / inflationIndex;
			if (income > spending) return true;
			inflationIndex *= 1 + tape.inflationRates[month];
		}
		return false;
	});
	if (!hasContribution) return null;

	const successAt = (coastMonth: number): number => {
		return (
			1 -
			replayRuinProbability(
				pathTapes,
				base,
				input.currentSavings,
				sampleCount,
				months,
				strategy,
				retireMonth,
				input.annualFeePercent,
				input.taxOnGainsPercent ?? input.annualDrag ?? 0,
				coastMonth
			)
		);
	};

	if (successAt(retireMonth) < targetSuccessProbability) return null;

	// Adaptive withdrawal policies can spend more after a higher retirement balance and
	// introduce discontinuities. Scan every candidate for those strategies rather than
	// assuming monotonicity. Fixed spending is pathwise monotone, so use binary search.
	if (strategy.kind !== 'fixed') {
		for (let month = 0; month <= retireMonth; month++) {
			if (successAt(month) >= targetSuccessProbability) {
				return input.currentAge + month / 12;
			}
		}
		return null;
	}

	let low = 0;
	let high = retireMonth;
	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		if (successAt(mid) >= targetSuccessProbability) high = mid;
		else low = mid + 1;
	}

	return input.currentAge + low / 12;
}

function buildRuinSurface(
	input: RetirementInput,
	spendingPeriods: SpendingPeriod[],
	incomeSources: IncomeSource[],
	lumpSumEvents: LumpSumEvent[],
	pathTapes: PathTape[],
	months: number,
	simCount: number,
	strategy: WithdrawalStrategy
): SummaryStats['ruinSurface'] {
	// Nine points per axis give the contour UI real local resolution instead of asking it
	// to visually invent most of the surface between a 5×5 grid. Replays remain capped at
	// 2,000 common paths, so this increases accounting work without increasing memory.
	const spendingMultipliers = Array.from({ length: 9 }, (_, index) => (80 + index * 5) / 100);
	// Already retired: the retirement-age axis is gone, not merely shifted. Sweeping it
	// would clamp every candidate to `currentAge + 1..+6` and label the result "retire
	// later", but with the salary already ended a later retirement age changes nothing
	// except when the withdrawal strategy starts — a difference with no real-world
	// counterpart. The surface collapses to the one axis that still means something:
	// sensitivity to spending. See README §7.6.
	const alreadyRetired = isAlreadyRetired(input);
	const candidateAges = Array.from(
		{ length: 9 },
		(_, index) => input.retirementAge - 6 + index * 1.5
	)
		.map((age) => Math.min(input.simulateUntilAge - 1, Math.max(input.currentAge + 1, age)))
		.map((age) => Math.round(age * 2) / 2);
	const retirementAges = alreadyRetired
		? [Math.round(input.currentAge)]
		: Array.from(new Set(candidateAges)).sort((a, b) => a - b);
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

			const arrays = buildCashflowArrays(
				adjustedInput,
				scaledSpending,
				adjustedIncome,
				lumpSumEvents,
				months
			);

			// `retAge` is rounded for the axis label, so derive the month from the flag rather
			// than from the rounded age — a fractional `currentAge` would otherwise reintroduce
			// up to six months of phantom accumulation.
			const cellRetireMonth = alreadyRetired
				? 0
				: Math.min(months, Math.max(0, Math.round((retAge - input.currentAge) * 12)));

			return replayRuinProbability(
				pathTapes,
				{
					monthlyRealIncomeFlow: arrays.monthlyRealIncomeFlow,
					monthlyNominalIncomeFlow: arrays.monthlyNominalIncomeFlow,
					monthlyRealSpendingFlow: arrays.monthlyRealSpendingFlow,
					monthlyNominalSpendingFlow: arrays.monthlyNominalSpendingFlow,
					lumpSumByMonth: arrays.lumpSumByMonth
				},
				input.currentSavings,
				sampledScenarios,
				months,
				strategy,
				cellRetireMonth,
				input.annualFeePercent,
				input.taxOnGainsPercent ?? input.annualDrag ?? 0
			);
		});
	});

	return { retirementAges, spendingMultipliers, ruinProbabilities, sampleCount: sampledScenarios };
}

function expectedInflationIndexAtAge(input: RetirementInput, age: number): number {
	const yearsFromNow = Math.max(0, age - input.currentAge);
	return Math.max(1e-9, (1 + input.inflationMean) ** yearsFromNow);
}

/**
 * Splits spending at `age` into the part constant in real terms and the face value of the
 * part fixed in nominal terms. The nominal part must be deflated by the *realized*
 * inflation index of the path being simulated, which is only known inside the loop.
 */
function splitSpendingAtAge(age: number, spendingPeriods: SpendingPeriod[]): [number, number] {
	let real = 0;
	let nominalFace = 0;
	for (const period of spendingPeriods) {
		if (!(period.fromAge <= age && period.toAge > age)) continue;
		if (period.inflationAdjusted ?? true) real += period.yearlyAmount;
		else nominalFace += period.yearlyAmount;
	}
	return [real, nominalFace];
}

/** Income counterpart of {@link splitSpendingAtAge}. */
function splitIncomeAtAge(age: number, incomeSources: IncomeSource[]): [number, number] {
	let real = 0;
	let nominalFace = 0;
	for (const source of incomeSources) {
		if (!(source.fromAge <= age && source.toAge > age)) continue;
		if (source.inflationAdjusted ?? true) real += source.yearlyAmount;
		else nominalFace += source.yearlyAmount;
	}
	return [real, nominalFace];
}

export function spendingAtAge(
	age: number,
	spendingPeriods: SpendingPeriod[],
	inflationIndex = 1
): number {
	return spendingPeriods
		.filter((period) => period.fromAge <= age && period.toAge > age)
		.reduce((sum, period) => {
			const isInflationAdjusted = period.inflationAdjusted ?? true;
			return (
				sum + (isInflationAdjusted ? period.yearlyAmount : period.yearlyAmount / inflationIndex)
			);
		}, 0);
}

export function incomeAtAge(
	age: number,
	incomeSources: IncomeSource[],
	inflationIndex = 1
): number {
	return incomeSources
		.filter((source) => source.fromAge <= age && source.toAge > age)
		.reduce((sum, source) => {
			const isInflationAdjusted = source.inflationAdjusted ?? true;
			return (
				sum + (isInflationAdjusted ? source.yearlyAmount : source.yearlyAmount / inflationIndex)
			);
		}, 0);
}

/**
 * Capital implied by the future portfolio-funded spending schedule at the selected SWR.
 * The final simulated month's gap is treated as the continuing terminal pattern. This
 * preserves the familiar `annual gap / SWR` result for a level schedule while valuing
 * temporary bridge spending and delayed/ending income at their actual dates.
 */
export function scheduleAwareSWRTarget(
	monthlySpending: ArrayLike<number>,
	monthlyIncome: ArrayLike<number>,
	retireMonth: number,
	safeWithdrawalRate: number
): number {
	const end = Math.min(monthlySpending.length, monthlyIncome.length);
	const start = Math.max(0, Math.min(Math.round(retireMonth), end));
	if (start >= end) return 0;

	const annualRate = Math.max(0.01, safeWithdrawalRate);
	const monthlyRate = annualRate / 12;
	const gapAt = (month: number) => Math.max(0, monthlySpending[month] - monthlyIncome[month]);
	let required = (gapAt(end - 1) * 12) / annualRate;
	for (let month = end - 2; month >= start; month--) {
		required = (gapAt(month) + required) / (1 + monthlyRate);
	}
	return required;
}

/**
 * Already-retired mode. There is no separate flag: `retirementAge === currentAge` *is* the
 * encoding, so it survives share links and the wasm boundary without a new field, and both
 * engines derive it from the same two numbers. `retireMonth` then comes out as 0 and the
 * whole accumulation phase collapses to nothing.
 *
 * Three outputs are only meaningful with an accumulation phase ahead, and each is handled
 * explicitly rather than left to degenerate: Coast FIRE returns `null` (already the case
 * for `retireMonth === 0`), the ruin surface drops its retirement-age axis
 * (`buildRuinSurface`), and the P95 FI target switches to a required-starting-capital
 * search (`findRequiredStartingCapital`). See README §7.6.
 *
 * Mirrored in Rust as `is_already_retired`.
 */
export function isAlreadyRetired(
	input: Pick<RetirementInput, 'currentAge' | 'retirementAge'>
): boolean {
	return input.retirementAge <= input.currentAge;
}

export function validateSimulationInputs(
	input: RetirementInput,
	spendingPeriods: SpendingPeriod[]
): { months: number; retireMonth: number; error?: string } {
	const months = Math.max(0, Math.round((input.simulateUntilAge - input.currentAge) * 12));
	if (months <= 12) {
		return {
			months: 0,
			retireMonth: 0,
			error: 'Simulation horizon must be at least 1 year beyond current age.'
		};
	}
	if (input.retirementAge < input.currentAge) {
		return {
			months: 0,
			retireMonth: 0,
			error: 'Target year to achieve FI cannot be before your current age.'
		};
	}
	if (spendingPeriods.length === 0) {
		return { months: 0, retireMonth: 0, error: 'Add at least one spending period.' };
	}

	const retireMonth = Math.min(
		months,
		Math.max(0, Math.round((input.retirementAge - input.currentAge) * 12))
	);
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
	monthlyRealIncomeFlow: Float64Array;
	monthlyNominalIncomeFlow: Float64Array;
	monthlyRealSpendingFlow: Float64Array;
	monthlyNominalSpendingFlow: Float64Array;
	lumpSumByMonth: Float64Array;
} {
	const monthlyNetFlow = new Float64Array(months);
	const monthlyIncomeFlow = new Float64Array(months);
	const monthlySpendingFlow = new Float64Array(months);
	const monthlyRealIncomeFlow = new Float64Array(months);
	const monthlyNominalIncomeFlow = new Float64Array(months);
	const monthlyRealSpendingFlow = new Float64Array(months);
	const monthlyNominalSpendingFlow = new Float64Array(months);
	const lumpSumByMonth = new Float64Array(months);

	for (let m = 0; m < months; m++) {
		const age = input.currentAge + m / 12;
		const inflationIndex = expectedInflationIndexAtAge(input, age);

		const [realIncome, nominalIncome] = splitIncomeAtAge(age, incomeSources);
		const [realSpending, nominalSpending] = splitSpendingAtAge(age, spendingPeriods);
		monthlyRealIncomeFlow[m] = realIncome / 12;
		monthlyNominalIncomeFlow[m] = nominalIncome / 12;
		monthlyRealSpendingFlow[m] = realSpending / 12;
		monthlyNominalSpendingFlow[m] = nominalSpending / 12;

		// Expected-index versions retained for public diagnostics and compatibility. Exact
		// simulations/replays use the split real/nominal arrays above.
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

	return {
		monthlyNetFlow,
		monthlyIncomeFlow,
		monthlySpendingFlow,
		monthlyRealIncomeFlow,
		monthlyNominalIncomeFlow,
		monthlyRealSpendingFlow,
		monthlyNominalSpendingFlow,
		lumpSumByMonth
	};
}

// `successFlags` must use the same definition as the headline success probability
// (spending was always fully funded), so the P95 FI target and the success rate
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
	// Intra-year dispersion for annual-mode spreading. The naive sqrt(12) scaling is the
	// right convention here and does not bias anything: spreadAnnualReturnAcrossMonths
	// renormalizes each year by its own geometric mean, so the year still compounds to the
	// sampled annual return exactly and this parameter only sets intra-year texture.
	const targetMonthlyStd = targetAnnualStd / Math.sqrt(12);

	// Moment targeting is different: it rewrites *monthly* observations that are then
	// compounded into years, so the monthly targets must be the ones whose 12-fold
	// compounding reproduces the requested annual moments. Using sqrt(12) here overshot both.
	const { mean: retargetMonthlyMean, std: retargetMonthlyStd } = monthlyTargetsForAnnualMoments(
		targetAnnualMean,
		targetAnnualStd
	);
	const cashflowArrays = buildCashflowArrays(
		input,
		spendingPeriods,
		incomeSources,
		lumpSumEvents,
		months
	);
	const withdrawalStrategy: WithdrawalStrategy =
		input.withdrawalStrategy ?? DEFAULT_WITHDRAWAL_STRATEGY;
	const retireMonthClamped = Math.min(months, Math.max(0, retireMonth));
	const stayGrowth = clampTransitionProbability(input.regimeModel.stayGrowth);
	const stayCrisis = clampTransitionProbability(input.regimeModel.stayCrisis);
	const bootstrapHistory =
		useHistoricalBootstrap &&
		input.historicalAnnualReturns &&
		input.historicalAnnualReturns.length >= 25
			? input.historicalAnnualReturns
			: buildBootstrapHistory(input, rng, 120);
	const annualHistoryMoments = summarizeMeanStd(bootstrapHistory);
	const effectiveAnnualHistory = useHistoricalBootstrap
		? (input.historicalMomentTargeting
				? bootstrapHistory.map((value) =>
						applyMomentTargeting(
							value,
							annualHistoryMoments.mean,
							annualHistoryMoments.std,
							targetAnnualMean,
							targetAnnualStd
						)
					)
				: bootstrapHistory
			).map((value) => clampAnnualReturn(value))
		: // Parametric mode draws this finite calibration pool only once per run. Target its
			// realized moments before every path bootstraps from it, otherwise sampling error in
			// the pool becomes a seed-dependent return offset shared by every simulation path.
			bootstrapHistory.map((value) =>
				clampAnnualReturn(
					applyMomentTargeting(
						value,
						annualHistoryMoments.mean,
						annualHistoryMoments.std,
						targetAnnualMean,
						targetAnnualStd
					)
				)
			);

	const monthlyHistory = (useHistoricalBootstrap ? (input.historicalMonthlyReturns ?? []) : [])
		.filter((value) => Number.isFinite(value))
		.map((value) => clampMonthlyReturn(value));
	const monthlyHistoryMoments = summarizeMeanStd(monthlyHistory);
	const effectiveMonthlyHistory = useHistoricalBootstrap
		? (input.historicalMomentTargeting
				? monthlyHistory.map((value) =>
						applyMomentTargeting(
							value,
							monthlyHistoryMoments.mean,
							monthlyHistoryMoments.std,
							retargetMonthlyMean,
							retargetMonthlyStd
						)
					)
				: monthlyHistory
			).map((value) => clampMonthlyReturn(value))
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
	const annualRegimeBootstrapPool = bootstrapPoolByRegime(
		effectiveAnnualHistory,
		annualDetectedRegimes
	);
	// Annual-mode returns must use transitions estimated from the same labels that split
	// the annual pools. Using the input template here can give the chain a different
	// stationary crisis share from the pools and therefore change their combined mean.
	const annualMarkov = estimateMarkovStayProbabilities(annualDetectedRegimes);
	const monthlyDetectedRegimes = useMonthlyCalibration
		? detectRegimesMonthly(effectiveMonthlyHistory)
		: [];
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
	const allBalances: Float64Array[] = new Array(simCount);
	const finalBalances: number[] = [];
	const retireBalances: number[] = [];
	const shortfallTotals: number[] = [];
	const depletedYearsSeries: number[] = [];
	const firstDepletionMonths: number[] = [];
	const depletedFlags: boolean[] = [];
	const successFlags: boolean[] = [];
	const annualRealReturnsBySim: number[][] = [];
	const replaySampleCount = Math.min(simCount, 2000);
	const pathTapes: PathTape[] = [];
	let successCount = 0;

	const growthProb = getGrowthStationaryProbability(stayGrowth, stayCrisis);
	const crisisProb = 1 - growthProb;
	// Floored at 0 (mirrored in the Rust engine): the input handler clamps this, restored
	// share links do not, and a negative spread would put crisis-regime mean inflation below
	// growth-regime mean inflation — inverting the model instead of failing.
	const requestedInflationSpread = Math.max(0, input.inflationCrisisSpread ?? 0.015);
	const maxInflationSpread = Math.sqrt(input.inflationVariability ** 2 / (growthProb * crisisProb));
	const effectiveInflationSpread = Math.min(requestedInflationSpread, maxInflationSpread * 0.8);
	const growthInflationMean = input.inflationMean - crisisProb * effectiveInflationSpread;
	const crisisInflationMean = input.inflationMean + growthProb * effectiveInflationSpread;

	// Normalized to a positive integer for the same reason the Rust engine does it (see
	// simulation.rs): the worker boundary and restored share links accept 0, and an
	// unnormalized 0 or fraction makes the two engines disagree about how often a block is
	// redrawn even though neither crashes here.
	const requestedBlockLength = input.blockLength ?? 6;
	const blockLength = Number.isFinite(requestedBlockLength)
		? Math.max(1, Math.floor(requestedBlockLength))
		: 6;
	const progressUpdateInterval = Math.max(10, Math.floor(simCount / 100));

	for (let sim = 0; sim < simCount; sim++) {
		if (onProgress && sim > 0 && sim % progressUpdateInterval === 0) {
			onProgress(sim / simCount);
		}
		let regimeState: 0 | 1 = initialRegimeState(
			monthlyMarkov.stayGrowth,
			monthlyMarkov.stayCrisis,
			rng
		);
		let annualRegimeState: 0 | 1 = 0;
		const tape: PathTape = {
			assetReturns: new Float64Array(months),
			inflationRates: new Float64Array(months)
		};

		let blockRemaining = 0;
		let currentHistoryIndex = 0;
		let activeMonthlyAssetReturn: number;

		// Annual mode: the 12 monthly returns for the current year, compounding to the
		// sampled annual return (see spreadAnnualReturnAcrossMonths).
		let annualModeMonths: number[] = new Array(12).fill(0);
		if (!useMonthlyCalibration) {
			annualRegimeState = initialRegimeState(annualMarkov.stayGrowth, annualMarkov.stayCrisis, rng);
			const startPool =
				annualRegimeState === 0
					? annualRegimeBootstrapPool.growth
					: annualRegimeBootstrapPool.crisis;
			annualModeMonths = spreadAnnualReturnAcrossMonths(
				startPool[Math.floor(rng.random() * startPool.length)],
				targetMonthlyStd,
				input.returnSkewness,
				input.returnKurtosis,
				rng
			);
		}

		for (let m = 0; m < months; m++) {
			if (m > 0) {
				regimeState = transitionRegimeState(
					regimeState,
					monthlyMarkov.stayGrowth,
					monthlyMarkov.stayCrisis,
					rng
				);
			}

			if (useMonthlyCalibration) {
				// Blocks are only re-drawn when the current one is exhausted; a regime switch
				// mid-block takes effect at the next block boundary. Aborting the block on every
				// switch used to bias the sampler: a fresh block always *starts* on a month
				// matching the new regime, and crisis runs are shorter than growth runs, so
				// crisis months were over-drawn ~1.06-1.09x, costing 0.64-1.29pp/yr of return.
				// Letting blocks finish also preserves more autocorrelation. See TODO 0.11.
				if (blockRemaining <= 0) {
					const indexPool =
						regimeState === 0
							? monthlyRegimeBootstrapIndices.growth
							: monthlyRegimeBootstrapIndices.crisis;
					currentHistoryIndex = indexPool[Math.floor(rng.random() * indexPool.length)];
					blockRemaining = blockLength;
				} else {
					currentHistoryIndex = (currentHistoryIndex + 1) % effectiveMonthlyHistory.length;
				}
				activeMonthlyAssetReturn = effectiveMonthlyHistory[currentHistoryIndex];
				blockRemaining--;
			} else {
				if (m > 0 && m % 12 === 0) {
					annualRegimeState = transitionRegimeState(
						annualRegimeState,
						annualMarkov.stayGrowth,
						annualMarkov.stayCrisis,
						rng
					);
					const regimePool =
						annualRegimeState === 0
							? annualRegimeBootstrapPool.growth
							: annualRegimeBootstrapPool.crisis;
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

			// Annual-mode draws are already regime-conditioned and their pool is calibrated to
			// the requested moments. A second monthly crisis overlay double-counted regimes and
			// moved the generated distribution away from those calibrated moments.
			const monthlyAssetReturn = activeMonthlyAssetReturn;
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
			tape.assetReturns[m] = monthlyAssetReturn;
			tape.inflationRates[m] = monthlyInflation;
		}

		const evaluation = evaluatePath(
			tape,
			cashflowArrays,
			input.currentSavings,
			months,
			withdrawalStrategy,
			retireMonthClamped,
			input.annualFeePercent,
			input.taxOnGainsPercent ?? input.annualDrag ?? 0
		);
		allBalances[sim] = evaluation.balances;
		if (sim < replaySampleCount) pathTapes.push(tape);

		const retireIndex = Math.max(0, Math.min(retireMonth - 1, months - 1));
		retireBalances.push(evaluation.balances[retireIndex]);
		finalBalances.push(evaluation.finalBalance);
		shortfallTotals.push(evaluation.cumulativeShortfall);
		depletedYearsSeries.push(evaluation.depletedMonths / 12);
		firstDepletionMonths.push(evaluation.firstDepletionMonth ?? Number.POSITIVE_INFINITY);
		depletedFlags.push(evaluation.depleted);
		annualRealReturnsBySim.push(evaluation.annualRealReturns);

		const success = !evaluation.depleted;
		successFlags.push(success);
		if (success) successCount++;
	}

	const targetFISWR = scheduleAwareSWRTarget(
		cashflowArrays.monthlySpendingFlow,
		cashflowArrays.monthlyIncomeFlow,
		retireMonthClamped,
		input.safeWithdrawalRate
	);
	const alreadyRetired = isAlreadyRetired(input);

	// The target always varies capital at the retirement boundary against fixed tapes. For an
	// already-retired plan that boundary is today; only the probability comparison changes to
	// a yes/no fact about capital already held. See README §§7.2 and 7.6.
	const targetFIP95 = findRequiredCapitalAtMonth(
		pathTapes,
		cashflowArrays,
		replaySampleCount,
		months,
		withdrawalStrategy,
		retireMonthClamped,
		retireMonthClamped,
		FI_TARGET_SUCCESS_PROBABILITY,
		targetFISWR,
		input.annualFeePercent,
		input.taxOnGainsPercent ?? input.annualDrag ?? 0
	);
	const fiCountP95 = alreadyRetired
		? input.currentSavings >= targetFIP95
			? simCount
			: 0
		: retireBalances.filter((balance) => balance >= targetFIP95).length;
	const fiCountSWR = alreadyRetired
		? input.currentSavings >= targetFISWR
			? simCount
			: 0
		: retireBalances.filter((balance) => balance >= targetFISWR).length;

	const percentileSeries: PercentileSeries<number[]> = {
		p10: [],
		p25: [],
		p50: [],
		p75: [],
		p90: []
	};
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
		retirePercentiles: summarize(retireBalances),
		finalWealthCdf: (() => {
			const sorted = [...finalBalances].sort((a, b) => a - b);
			const probabilities = Array.from({ length: 101 }, (_, index) => index / 100);
			return {
				balances: probabilities.map((probability) => percentile(sorted, probability)),
				probabilities
			};
		})()
	};

	const shortfallPercentiles = summarize(shortfallTotals);
	const depletedYearsPercentiles = summarize(depletedYearsSeries);
	const sortedFirstDepletion = [...firstDepletionMonths].sort((a, b) => a - b);
	const depletionAge = (quantile: number): number | null => {
		if (sortedFirstDepletion.length === 0) return null;
		// Nearest-rank, deliberately not the interpolating `percentile` helper: the series
		// carries +Infinity for paths that never ran short, and interpolating towards it
		// yields Infinity or NaN. Nearest-rank also keeps the Rust port exact.
		const rank = Math.min(
			sortedFirstDepletion.length - 1,
			Math.floor(quantile * sortedFirstDepletion.length)
		);
		const month = sortedFirstDepletion[rank];
		return Number.isFinite(month) ? input.currentAge + month / 12 : null;
	};
	const failedPathIndexes = depletedFlags
		.map((depleted, index) => (depleted ? index : -1))
		.filter((index) => index >= 0);
	const failedDepletionMonths = failedPathIndexes
		.map((index) => firstDepletionMonths[index])
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const failedShortfalls = failedPathIndexes
		.map((index) => shortfallTotals[index])
		.sort((a, b) => a - b);
	const failureMedianDepletionAge =
		failedDepletionMonths.length > 0
			? input.currentAge + percentile(failedDepletionMonths, 0.5) / 12
			: null;
	const failureMedianShortfall =
		failedShortfalls.length > 0 ? percentile(failedShortfalls, 0.5) : null;
	const sequenceRisk = buildSequenceRiskSummary(
		annualRealReturnsBySim,
		finalBalances,
		depletedFlags
	);
	const ruinSurface = buildRuinSurface(
		input,
		spendingPeriods,
		incomeSources,
		lumpSumEvents,
		pathTapes,
		months,
		simCount,
		withdrawalStrategy
	);

	const coastAge = findCoastAge(
		input,
		spendingPeriods,
		incomeSources,
		lumpSumEvents,
		pathTapes,
		months,
		simCount,
		withdrawalStrategy,
		retireMonthClamped,
		0.95
	);

	const stats: SummaryStats = {
		coastAge,
		fiTarget: targetFIP95,
		fiTargetSWR: targetFISWR,
		fiTargetP95: targetFIP95,
		successProbability: successCount / simCount,
		fiProbabilitySWR: fiCountSWR / simCount,
		fiProbabilityP95: fiCountP95 / simCount,
		requestedReturnMoments: {
			arithmeticMean: targetAnnualMean,
			stdDev: targetAnnualStd,
			skewness: input.returnSkewness,
			kurtosis: input.returnKurtosis
		},
		returnMoments,
		sequenceRisk,
		ruinSurface,
		shortfallLow: shortfallPercentiles.p10,
		shortfallMedian: shortfallPercentiles.p50,
		shortfallHigh: shortfallPercentiles.p90,
		depletedYearsLow: depletedYearsPercentiles.p10,
		depletedYearsMedian: depletedYearsPercentiles.p50,
		depletedYearsHigh: depletedYearsPercentiles.p90,
		depletionAgeP10: depletionAge(0.1),
		depletionAgeP50: depletionAge(0.5),
		failureMedianDepletionAge,
		failureMedianShortfall,
		retireLow: simulation.retirePercentiles.p10,
		finalMedian: simulation.finalPercentiles.p50,
		finalLow: simulation.finalPercentiles.p10,
		finalHigh: simulation.finalPercentiles.p90,
		retireMedian: simulation.retirePercentiles.p50,
		retireHigh: simulation.retirePercentiles.p90
	};

	return { simulation, stats, simCount };
}
