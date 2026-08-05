export type AllocationSplit = {
	stocks: number;
	bonds: number;
	bank: number;
};

export type PercentileSeries<T = number> = {
	p10: T;
	p25: T;
	p50: T;
	p75: T;
	p90: T;
};

type UniformRandom = () => number;

function createMulberry32(seed: number): UniformRandom {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export class RandomSource {
	private readonly nextUniform: UniformRandom;
	private spareNormal: number | null = null;

	constructor(seed?: number) {
		this.nextUniform = Number.isFinite(seed)
			? createMulberry32(Math.round(seed as number))
			: Math.random;
	}

	random(): number {
		return this.nextUniform();
	}

	normal(mean: number, std: number): number {
		if (std <= 0) return mean;
		if (this.spareNormal !== null) {
			const cached = this.spareNormal;
			this.spareNormal = null;
			return mean + std * cached;
		}

		let u = 0;
		let v = 0;
		while (u === 0) u = this.random();
		while (v === 0) v = this.random();

		const mag = Math.sqrt(-2.0 * Math.log(u));
		const z0 = mag * Math.cos(2.0 * Math.PI * v);
		const z1 = mag * Math.sin(2.0 * Math.PI * v);
		this.spareNormal = z1;
		return mean + std * z0;
	}
}

const defaultRandomSource = new RandomSource();

export function createRandomSource(seed?: number): RandomSource {
	return new RandomSource(seed);
}

export function randomNormal(mean: number, std: number): number {
	return defaultRandomSource.normal(mean, std);
}

export type InvestmentMetricInputs = {
	stockMean: number;
	stockStd: number;
	stockSkew: number;
	stockKurt: number;
	bondMean: number;
	bondStd: number;
	bondSkew: number;
	bondKurt: number;
	bankMean: number;
	bankStd: number;
	bankSkew: number;
	bankKurt: number;
};

export type RegimeTemplate = {
	stayGrowth: number;
	stayCrisis: number;
	meanSpread: number;
	growthStdMultiplier: number;
	crisisStdMultiplier: number;
};

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'WORLD';

export type HistoricalRegionDataset = {
	code: CurrencyCode;
	label: string;
	years: number[];
	sampleSize: number;
	coverage: string;
	annualCoverage?: string;
	monthlyCoverage?: string;
	assetMoments: {
		equity: {
			arithmeticMean: number;
			geometricMean: number;
			stdDev: number;
			skewness: number;
			kurtosis: number;
		};
		bond: {
			arithmeticMean: number;
			geometricMean: number;
			stdDev: number;
			skewness: number;
			kurtosis: number;
		};
		cash: {
			arithmeticMean: number;
			geometricMean: number;
			stdDev: number;
			skewness: number;
			kurtosis: number;
		};
	};
	annualSeries: Array<{ year: number; equity: number; bond: number; cash: number }>;
	monthlySeries?: Array<{
		month: string;
		equity: number;
		bond: number;
		cash: number;
		inflation?: number;
	}>;
	/** Latest observed yield levels, used to anchor forward-looking return assumptions. */
	currentConditions?: { asOf: string; bondYield: number; cashRate: number } | null;
};

export type HistoricalMarketDataset = {
	generatedAt: string;
	methodology: {
		frequency: string;
		annualization: string;
		cash: string;
	};
	regions: Record<CurrencyCode, HistoricalRegionDataset>;
};

export function percentile(sortedArray: number[], p: number): number {
	if (sortedArray.length === 0) return 0;
	if (p <= 0) return sortedArray[0];
	if (p >= 1) return sortedArray[sortedArray.length - 1];
	const index = p * (sortedArray.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	const weight = index % 1;
	if (lower === upper) return sortedArray[lower];
	return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function getAllocationSplit(
	stockBoundaryPercent: number,
	bondBoundaryPercent: number
): AllocationSplit {
	const stocks = clamp(stockBoundaryPercent, 0, 100) / 100;
	const bonds = clamp(bondBoundaryPercent - stockBoundaryPercent, 0, 100) / 100;
	const bank = clamp(100 - bondBoundaryPercent, 0, 100) / 100;
	return { stocks, bonds, bank };
}

export function blendPortfolioMetrics(
	metrics: InvestmentMetricInputs,
	allocation: AllocationSplit,
	equityBondCorrelation: number,
	defaultSkewness = 0,
	defaultKurtosis = 3
): { mean: number; std: number; skewness: number; kurtosis: number } {
	const mean =
		allocation.stocks * metrics.stockMean +
		allocation.bonds * metrics.bondMean +
		allocation.bank * metrics.bankMean;

	const rhoEquityBond = clamp(equityBondCorrelation, -1, 1);
	const stockVariance = (allocation.stocks * metrics.stockStd) ** 2;
	const bondVariance = (allocation.bonds * metrics.bondStd) ** 2;
	const bankVariance = (allocation.bank * metrics.bankStd) ** 2;
	const equityBondCovariance =
		2 * allocation.stocks * allocation.bonds * metrics.stockStd * metrics.bondStd * rhoEquityBond;
	const variance = stockVariance + bondVariance + bankVariance + equityBondCovariance;
	const std = Math.sqrt(Math.max(0, variance));

	if (std <= 1e-9) {
		return { mean, std: 0, skewness: defaultSkewness, kurtosis: defaultKurtosis };
	}

	// Contribution standard deviations: aᵢ = wᵢ·σᵢ.
	const aStock = allocation.stocks * metrics.stockStd;
	const aBond = allocation.bonds * metrics.bondStd;
	const aBank = allocation.bank * metrics.bankStd;

	// Third central moment of a sum. For independent components the cross terms vanish
	// (E[A²B] = E[A²]E[B] = 0 for centred variables), so this is exact when uncorrelated
	// and a mild approximation once equity and bonds co-move.
	const skewness =
		(aStock ** 3 * metrics.stockSkew +
			aBond ** 3 * metrics.bondSkew +
			aBank ** 3 * metrics.bankSkew) /
		std ** 3;

	// Fourth central moment of a sum. The Σaᵢ⁴κᵢ terms alone are *not* the fourth moment —
	// the cross terms are the bulk of it, and omitting them made a blend of independent
	// normals come out at kurtosis 1.5 instead of 3, i.e. thinner-than-normal tails, which
	// then told the Student-t mapping there was no excess kurtosis to reproduce.
	//
	//   μ₄(S) = Σ aᵢ⁴κᵢ
	//         + 12ρ(a_s³a_b + a_s a_b³)          equity/bond, normal-theory E[A³B]
	//         + 6a_s²a_b²(1 + 2ρ²)               equity/bond, normal-theory E[A²B²]
	//         + 6a_c²·Var(equity + bond)         cash against the rest (independent)
	//
	// Exact for jointly normal components (verified against Monte Carlo) and exact for
	// independent components whatever their marginal shape, since the cross moments then
	// factor. With both correlation *and* non-normal marginals it is a normal-theory
	// approximation — the joint fourth moments are not determined by ρ alone.
	const equityBondVariance = aStock ** 2 + aBond ** 2 + 2 * rhoEquityBond * aStock * aBond;
	const fourthMoment =
		aStock ** 4 * metrics.stockKurt +
		aBond ** 4 * metrics.bondKurt +
		aBank ** 4 * metrics.bankKurt +
		12 * rhoEquityBond * (aStock ** 3 * aBond + aStock * aBond ** 3) +
		6 * aStock ** 2 * aBond ** 2 * (1 + 2 * rhoEquityBond ** 2) +
		6 * aBank ** 2 * equityBondVariance;
	const kurtosis = Math.max(1, fourthMoment / std ** 4);

	return { mean, std, skewness, kurtosis };
}

export function summarizeSeriesDistribution(values: number[]): {
	mean: number;
	std: number;
	skewness: number;
	kurtosis: number;
} {
	if (values.length === 0) {
		return { mean: 0, std: 0, skewness: 0, kurtosis: 3 };
	}

	const n = values.length;
	const mean = values.reduce((sum, value) => sum + value, 0) / n;
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
	const std = Math.sqrt(Math.max(0, variance));

	if (std <= 1e-9) {
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

export function sampleCorrelation(first: number[], second: number[]): number | null {
	const n = Math.min(first.length, second.length);
	if (n < 2) return null;

	const x = first.slice(0, n);
	const y = second.slice(0, n);
	const meanX = x.reduce((sum, value) => sum + value, 0) / n;
	const meanY = y.reduce((sum, value) => sum + value, 0) / n;
	const varX = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0) / n;
	const varY = y.reduce((sum, value) => sum + (value - meanY) ** 2, 0) / n;
	if (varX <= 1e-12 || varY <= 1e-12) return null;

	const cov = x.reduce((sum, value, index) => sum + (value - meanX) * (y[index] - meanY), 0) / n;
	return cov / Math.sqrt(varX * varY);
}

export function estimateEquityBondCorrelation(
	historicalMarketData: HistoricalMarketDataset | null,
	currencyCode: CurrencyCode
): number | null {
	const region = historicalMarketData?.regions?.[currencyCode];
	if (!region) return null;

	if (Array.isArray(region.monthlySeries) && region.monthlySeries.length >= 24) {
		const validRows = region.monthlySeries.filter(
			(row) => Number.isFinite(row.equity) && Number.isFinite(row.bond)
		);
		const equity = validRows.map((row) => row.equity);
		const bond = validRows.map((row) => row.bond);
		return sampleCorrelation(equity, bond);
	}

	if (Array.isArray(region.annualSeries) && region.annualSeries.length >= 10) {
		const validRows = region.annualSeries.filter(
			(row) => Number.isFinite(row.equity) && Number.isFinite(row.bond)
		);
		const equity = validRows.map((row) => row.equity);
		const bond = validRows.map((row) => row.bond);
		return sampleCorrelation(equity, bond);
	}

	return null;
}

export function getHistoricalInvestmentMetrics(
	historicalMarketData: HistoricalMarketDataset | null,
	currencyCode: CurrencyCode
): InvestmentMetricInputs | null {
	const region = historicalMarketData?.regions?.[currencyCode];
	if (!region) return null;
	return {
		stockMean: region.assetMoments.equity.arithmeticMean,
		stockStd: region.assetMoments.equity.stdDev,
		stockSkew: region.assetMoments.equity.skewness,
		stockKurt: region.assetMoments.equity.kurtosis,
		bondMean: region.assetMoments.bond.arithmeticMean,
		bondStd: region.assetMoments.bond.stdDev,
		bondSkew: region.assetMoments.bond.skewness,
		bondKurt: region.assetMoments.bond.kurtosis,
		bankMean: region.assetMoments.cash.arithmeticMean,
		bankStd: region.assetMoments.cash.stdDev,
		bankSkew: region.assetMoments.cash.skewness,
		bankKurt: region.assetMoments.cash.kurtosis
	};
}

/**
 * Forward-looking return assumptions anchored to the latest yields embedded in the dataset, in the style of
 * institutional capital-market assumptions:
 *
 * - **Cash** → the current short rate.
 * - **Bonds** → the current long yield. Starting yield is by far the best predictor of a
 *   bond portfolio's forward return; a 65-year average return is not, because much of it
 *   came from a one-off decline in yields that cannot repeat from today's level.
 * - **Equity** → current long yield + the *historical* equity risk premium (equity
 *   arithmetic mean − bond arithmetic mean), i.e. a standard build-up.
 *
 * Only the means move. Volatility, skewness and kurtosis stay at their historical values
 * — the shape of the distribution is the part history estimates well.
 */
export function buildCurrentConditionsMetrics(
	historicalMarketData: HistoricalMarketDataset | null,
	currencyCode: CurrencyCode
): { metrics: InvestmentMetricInputs; asOf: string; equityRiskPremium: number } | null {
	const region = historicalMarketData?.regions?.[currencyCode];
	const conditions = region?.currentConditions;
	const historical = getHistoricalInvestmentMetrics(historicalMarketData, currencyCode);
	if (!region || !conditions || !historical) return null;
	if (!Number.isFinite(conditions.bondYield) || !Number.isFinite(conditions.cashRate)) return null;

	const equityRiskPremium =
		region.assetMoments.equity.arithmeticMean - region.assetMoments.bond.arithmeticMean;

	return {
		asOf: conditions.asOf,
		equityRiskPremium,
		metrics: {
			...historical,
			stockMean: conditions.bondYield + equityRiskPremium,
			bondMean: conditions.bondYield,
			bankMean: conditions.cashRate
		}
	};
}

export function buildPortfolioHistoricalReturns(
	historicalMarketData: HistoricalMarketDataset | null,
	currencyCode: CurrencyCode,
	allocation: AllocationSplit
): number[] {
	const region = historicalMarketData?.regions?.[currencyCode];
	if (!region || !Array.isArray(region.annualSeries)) return [];

	return region.annualSeries
		.map(
			(row) =>
				allocation.stocks * row.equity + allocation.bonds * row.bond + allocation.bank * row.cash
		)
		.filter((value) => Number.isFinite(value));
}

export function buildPortfolioHistoricalMonthlyReturns(
	historicalMarketData: HistoricalMarketDataset | null,
	currencyCode: CurrencyCode,
	allocation: AllocationSplit
): number[] {
	const region = historicalMarketData?.regions?.[currencyCode];
	if (!region || !Array.isArray(region.monthlySeries)) return [];

	return region.monthlySeries
		.map(
			(row) =>
				allocation.stocks * row.equity + allocation.bonds * row.bond + allocation.bank * row.cash
		)
		.filter((value) => Number.isFinite(value));
}

/**
 * Builds index-aligned monthly portfolio return and realized-inflation series.
 *
 * Both arrays are filtered with a single predicate so index i always refers to the same
 * historical month in both — the engine samples one index and reads both values, which
 * is what preserves the historical return/inflation correlation and (via contiguous
 * bootstrap blocks) inflation persistence. Returns an empty inflation array when the
 * dataset predates the CPI columns.
 */
export function buildPortfolioHistoricalMonthlySeries(
	historicalMarketData: HistoricalMarketDataset | null,
	currencyCode: CurrencyCode,
	allocation: AllocationSplit
): { returns: number[]; inflation: number[] } {
	const region = historicalMarketData?.regions?.[currencyCode];
	if (!region || !Array.isArray(region.monthlySeries)) return { returns: [], inflation: [] };

	const returns: number[] = [];
	const inflation: number[] = [];
	let everyMonthHasInflation = true;

	for (const row of region.monthlySeries) {
		const portfolioReturn =
			allocation.stocks * row.equity + allocation.bonds * row.bond + allocation.bank * row.cash;
		if (!Number.isFinite(portfolioReturn)) continue;
		returns.push(portfolioReturn);
		if (typeof row.inflation === 'number' && Number.isFinite(row.inflation)) {
			inflation.push(row.inflation);
		} else {
			everyMonthHasInflation = false;
		}
	}

	return { returns, inflation: everyMonthHasInflation ? inflation : [] };
}

export function clampProbability(value: number): number {
	return clamp(value, 0.001, 0.999);
}

export function getGrowthStationaryProbability(stayGrowth: number, stayCrisis: number): number {
	const denominator = 2 - stayGrowth - stayCrisis;
	if (denominator <= 1e-9) return 0.5;
	return (1 - stayCrisis) / denominator;
}

export function buildRegimeModelFromPortfolio(
	portfolioMean: number,
	portfolioStd: number,
	portfolioSkewness: number,
	portfolioKurtosis: number,
	template: RegimeTemplate
): {
	stayGrowth: number;
	stayCrisis: number;
	growthMean: number;
	growthStd: number;
	crisisMean: number;
	crisisStd: number;
} {
	const stayGrowth = clampProbability(template.stayGrowth);
	const stayCrisis = clampProbability(template.stayCrisis);
	const growthProbability = clampProbability(
		getGrowthStationaryProbability(stayGrowth, stayCrisis)
	);
	const crisisProbability = 1 - growthProbability;

	const skewTilt = Math.max(-2, Math.min(2, portfolioSkewness));
	const excessKurtosis = Math.max(0, portfolioKurtosis - 3);

	let spread =
		template.meanSpread * (1 + excessKurtosis * 0.08) * (1 + Math.max(0, -skewTilt) * 0.25);
	const maxSpread = Math.sqrt(portfolioStd ** 2 / (growthProbability * crisisProbability));
	spread = Math.min(spread, maxSpread * 0.8); // Cap regime spread to at most ~64% of total variance

	const growthMean = portfolioMean + crisisProbability * spread;
	const crisisMean = portfolioMean - growthProbability * spread;

	const growthStdMultiplier = Math.max(
		0.1,
		template.growthStdMultiplier * (1 + Math.max(0, skewTilt) * 0.1)
	);
	const crisisStdMultiplier = Math.max(
		growthStdMultiplier + 0.2,
		template.crisisStdMultiplier * (1 + excessKurtosis * 0.06)
	);

	const targetVariance = portfolioStd ** 2;
	const regimeMeanVariance =
		growthProbability * (growthMean - portfolioMean) ** 2 +
		crisisProbability * (crisisMean - portfolioMean) ** 2;

	const weightedMultiplierSquare =
		growthProbability * growthStdMultiplier ** 2 + crisisProbability * crisisStdMultiplier ** 2;

	const remainingVariance = Math.max(0, targetVariance - regimeMeanVariance);
	const sharedScale =
		weightedMultiplierSquare > 1e-9
			? Math.sqrt(remainingVariance / weightedMultiplierSquare)
			: portfolioStd;

	const growthStd = sharedScale * growthStdMultiplier;
	const crisisStd = sharedScale * crisisStdMultiplier;

	return {
		stayGrowth,
		stayCrisis,
		growthMean,
		growthStd,
		crisisMean,
		crisisStd
	};
}

function erfApprox(x: number): number {
	const sign = x < 0 ? -1 : 1;
	const absX = Math.abs(x);
	const t = 1 / (1 + 0.3275911 * absX);
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
	const y = 1 - poly * Math.exp(-absX * absX);
	return sign * y;
}

export function normalCdf(x: number): number {
	return 0.5 * (1 + erfApprox(x / Math.SQRT2));
}

export function summarize(values: number[]): PercentileSeries<number> {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		p10: percentile(sorted, 0.1),
		p25: percentile(sorted, 0.25),
		p50: percentile(sorted, 0.5),
		p75: percentile(sorted, 0.75),
		p90: percentile(sorted, 0.9)
	};
}
