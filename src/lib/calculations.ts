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
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RandomSource {
  private readonly nextUniform: UniformRandom;
  private spareNormal: number | null = null;

  constructor(seed?: number) {
    this.nextUniform = Number.isFinite(seed) ? createMulberry32(Math.round(seed as number)) : Math.random;
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
  monthlySeries?: Array<{ month: string; equity: number; bond: number; cash: number }>;
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

export function getAllocationSplit(stockBoundaryPercent: number, bondBoundaryPercent: number): AllocationSplit {
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

  const stockThird = (allocation.stocks * metrics.stockStd) ** 3 * metrics.stockSkew;
  const bondThird = (allocation.bonds * metrics.bondStd) ** 3 * metrics.bondSkew;
  const bankThird = (allocation.bank * metrics.bankStd) ** 3 * metrics.bankSkew;
  const skewness = (stockThird + bondThird + bankThird) / std ** 3;

  const stockFourth = (allocation.stocks * metrics.stockStd) ** 4 * metrics.stockKurt;
  const bondFourth = (allocation.bonds * metrics.bondStd) ** 4 * metrics.bondKurt;
  const bankFourth = (allocation.bank * metrics.bankStd) ** 4 * metrics.bankKurt;
  const kurtosis = Math.max(1, (stockFourth + bondFourth + bankFourth) / std ** 4);

  return { mean, std, skewness, kurtosis };
}

export function summarizeSeriesDistribution(values: number[]): { mean: number; std: number; skewness: number; kurtosis: number } {
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
    const validRows = region.monthlySeries.filter((row) => Number.isFinite(row.equity) && Number.isFinite(row.bond));
    const equity = validRows.map((row) => row.equity);
    const bond = validRows.map((row) => row.bond);
    return sampleCorrelation(equity, bond);
  }

  if (Array.isArray(region.annualSeries) && region.annualSeries.length >= 10) {
    const validRows = region.annualSeries.filter((row) => Number.isFinite(row.equity) && Number.isFinite(row.bond));
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

export function buildPortfolioHistoricalReturns(
  historicalMarketData: HistoricalMarketDataset | null,
  currencyCode: CurrencyCode,
  allocation: AllocationSplit
): number[] {
  const region = historicalMarketData?.regions?.[currencyCode];
  if (!region || !Array.isArray(region.annualSeries)) return [];

  return region.annualSeries
    .map((row) => allocation.stocks * row.equity + allocation.bonds * row.bond + allocation.bank * row.cash)
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
    .map((row) => allocation.stocks * row.equity + allocation.bonds * row.bond + allocation.bank * row.cash)
    .filter((value) => Number.isFinite(value));
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
  const growthProbability = clampProbability(getGrowthStationaryProbability(stayGrowth, stayCrisis));
  const crisisProbability = 1 - growthProbability;

  const skewTilt = Math.max(-2, Math.min(2, portfolioSkewness));
  const excessKurtosis = Math.max(0, portfolioKurtosis - 3);

  let spread = template.meanSpread * (1 + excessKurtosis * 0.08) * (1 + Math.max(0, -skewTilt) * 0.25);
  const maxSpread = Math.sqrt((portfolioStd ** 2) / (growthProbability * crisisProbability));
  spread = Math.min(spread, maxSpread * 0.8); // Cap regime spread to at most ~64% of total variance

  const growthMean = portfolioMean + crisisProbability * spread;
  const crisisMean = portfolioMean - growthProbability * spread;

  const growthStdMultiplier = Math.max(0.1, template.growthStdMultiplier * (1 + Math.max(0, skewTilt) * 0.1));
  const crisisStdMultiplier = Math.max(growthStdMultiplier + 0.2, template.crisisStdMultiplier * (1 + excessKurtosis * 0.06));

  const targetVariance = portfolioStd ** 2;
  const regimeMeanVariance =
    growthProbability * (growthMean - portfolioMean) ** 2 +
    crisisProbability * (crisisMean - portfolioMean) ** 2;

  const weightedMultiplierSquare =
    growthProbability * growthStdMultiplier ** 2 +
    crisisProbability * crisisStdMultiplier ** 2;

  const remainingVariance = Math.max(0, targetVariance - regimeMeanVariance);
  const sharedScale = weightedMultiplierSquare > 1e-9
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
  const poly = (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t;
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
