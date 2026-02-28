<script lang="ts">
  import { asset } from '$app/paths';
  import { onDestroy, onMount, tick } from 'svelte';
  import {
    runMonteCarloSimulation,
    spendingAtAge,
    validateSimulationInputs,
    type IncomeSource,
    type LumpSumEvent,
    type RetirementInput,
    type SimulationResult,
    type SpendingPeriod,
    type SummaryStats
  } from './retirementEngine';
  import {
    blendPortfolioMetrics as calcBlendPortfolioMetrics,
    buildPortfolioHistoricalMonthlyReturns as calcBuildPortfolioHistoricalMonthlyReturns,
    buildPortfolioHistoricalReturns as calcBuildPortfolioHistoricalReturns,
    buildRegimeModelFromPortfolio as calcBuildRegimeModelFromPortfolio,
    clamp as calcClamp,
    estimateEquityBondCorrelation as calcEstimateEquityBondCorrelation,
    getAllocationSplit as calcGetAllocationSplit,
    getHistoricalInvestmentMetrics as calcGetHistoricalInvestmentMetrics,
    normalCdf as calcNormalCdf,
    summarizeSeriesDistribution as calcSummarizeSeriesDistribution
  } from './calculations';
  import PlannerInputPanel from './components/PlannerInputPanel.svelte';
  import PlannerOutputCards from './components/PlannerOutputCards.svelte';
  import PlannerSecondaryPlot from './components/PlannerSecondaryPlot.svelte';
  import PlannerTimelinePlot from './components/PlannerTimelinePlot.svelte';
  import './retirement.css';

  // ─── Types ──────────────────────────────────────────────────────────────────

  type CurrencyOption = {
    code: CurrencyCode;
    locale: string;
    symbol: string;
    buttonLabel: string;
    flagAsset?: string;
  };

  type SourceLink = { label: string; url: string };

  type MetricReference = {
    mean: number;
    std: number;
    summaryPeriod: string;
    range25: string;
    range50: string;
    sources: SourceLink[];
  };

  type AllocationSplit = {
    stocks: number;
    bonds: number;
    bank: number;
  };

  type InvestmentMetricInputs = {
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

  type AssumptionReference = {
    region: string;
    stockMetric: MetricReference;
    bondMetric: MetricReference;
    bankMetric: MetricReference;
    inflationMetric: MetricReference;
    regimeTemplate: RegimeTemplate;
  };

  type HistoricalMoments = {
    arithmeticMean: number;
    geometricMean: number;
    stdDev: number;
    skewness: number;
    kurtosis: number;
  };

  type HistoricalAnnualSeriesRow = {
    year: number;
    equity: number;
    bond: number;
    cash: number;
  };

  type HistoricalMonthlySeriesRow = {
    month: string;
    equity: number;
    bond: number;
    cash: number;
  };

  type HistoricalRegionDataset = {
    code: CurrencyCode;
    label: string;
    years: number[];
    sampleSize: number;
    coverage: string;
    assetMoments: {
      equity: HistoricalMoments;
      bond: HistoricalMoments;
      cash: HistoricalMoments;
    };
    annualSeries: HistoricalAnnualSeriesRow[];
    monthlySeries?: HistoricalMonthlySeriesRow[];
  };

  type HistoricalMarketDataset = {
    generatedAt: string;
    methodology: {
      frequency: string;
      annualization: string;
      cash: string;
    };
    regions: Record<CurrencyCode, HistoricalRegionDataset>;
  };

  type RegimeTemplate = {
    stayGrowth: number;
    stayCrisis: number;
    meanSpread: number;
    growthStdMultiplier: number;
    crisisStdMultiplier: number;
  };

  type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'WORLD';

  type PlannerInput = RetirementInput;

  const DEFAULT_ALLOCATION: AllocationSplit = {
    stocks: 0.6,
    bonds: 0.3,
    bank: 0.1
  };
  const DEFAULT_STOCK_BOUNDARY_PERCENT = Math.round(DEFAULT_ALLOCATION.stocks * 100);
  const DEFAULT_BOND_BOUNDARY_PERCENT = Math.round((DEFAULT_ALLOCATION.stocks + DEFAULT_ALLOCATION.bonds) * 100);

  // ─── Currency options ───────────────────────────────────────────────────────

  const CURRENCIES: CurrencyOption[] = [
    { code: 'WORLD', locale: 'en-US', symbol: '$', buttonLabel: 'World ($)', flagAsset: asset('/assets/flags/world.svg') },
    { code: 'USD', locale: 'en-US', symbol: '$', buttonLabel: 'US ($)', flagAsset: asset('/assets/flags/us.svg') },
    { code: 'GBP', locale: 'en-GB', symbol: '£', buttonLabel: 'UK (£)', flagAsset: asset('/assets/flags/uk.svg') },
    { code: 'EUR', locale: 'de-DE', symbol: '€', buttonLabel: 'Europe (€)', flagAsset: asset('/assets/flags/eu.svg') }
  ];

  const ASSUMPTION_REFERENCES: Record<CurrencyCode, AssumptionReference> = {
    WORLD: {
      region: 'Global market blend',
      stockMetric: {
        mean: 0.082,
        std: 0.17,
        summaryPeriod: 'long-run (approx)',
        range25: '-45% to +33% (approx)',
        range50: '-50% to +50% (approx)',
        sources: [
          { label: 'MSCI ACWI index overview (global equities)', url: 'https://www.msci.com/indexes/index/892400' },
          { label: 'FTSE All-World index factsheet (global equities)', url: 'https://research.ftserussell.com/Analytics/FactSheets/Home/DownloadSingleIssue?openfile=open&issueName=AWORLDS' }
        ]
      },
      bondMetric: {
        mean: 0.038,
        std: 0.072,
        summaryPeriod: 'long-run (approx)',
        range25: '-15% to +12% (approx)',
        range50: '-18% to +22% (approx)',
        sources: [
          { label: 'Bloomberg Global Aggregate bond index overview', url: 'https://www.bloomberg.com/professional/product/indices/bloomberg-fixed-income-indices/' },
          { label: 'FTSE World Government Bond Index (WGBI) resources', url: 'https://www.lseg.com/en/ftse-russell/fixed-income/ftse-world-government-bond-index' }
        ]
      },
      bankMetric: {
        mean: 0.022,
        std: 0.012,
        summaryPeriod: 'long-run (assumption blend)',
        range25: '-0.5% to +5.5% (approx)',
        range50: '-1.0% to +8.0% (approx)',
        sources: [
          { label: 'OECD short-term interest rates dataset (cross-country policy/cash proxy)', url: 'https://data.oecd.org/interest/short-term-interest-rates.htm' },
          { label: 'Reasoning note: no single investable “world deposit” benchmark exists, so defaults use a conservative blended cash-rate assumption across major economies.', url: 'https://www.imf.org/en/Data' }
        ]
      },
      inflationMetric: {
        mean: 0.027,
        std: 0.024,
        summaryPeriod: 'long-run (approx)',
        range25: '-1.0% to +10.0% (approx)',
        range50: '-1.5% to +14.0% (approx)',
        sources: [
          { label: 'World Bank inflation, consumer prices (annual %)', url: 'https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG' },
          { label: 'IMF World Economic Outlook inflation data', url: 'https://www.imf.org/en/Publications/WEO' }
        ]
      },
      regimeTemplate: {
        stayGrowth: 0.9,
        stayCrisis: 0.64,
        meanSpread: 0.13,
        growthStdMultiplier: 0.72,
        crisisStdMultiplier: 1.85
      }
    },
    USD: {
      region: 'United States',
      stockMetric: {
        mean: 0.1,
        std: 0.19,
        summaryPeriod: '50y',
        range25: '-43% to +33% (approx)',
        range50: '-43% to +53% (approx)',
        sources: [
          { label: 'S&P 500 historical annual returns (macrotrends)', url: 'https://www.macrotrends.net/2526/sp-500-historical-annual-returns' },
          { label: 'FRED S&P 500 index (SP500)', url: 'https://fred.stlouisfed.org/series/SP500' }
        ]
      },
      bondMetric: {
        mean: 0.05,
        std: 0.08,
        summaryPeriod: '50y',
        range25: '-13% to +19% (approx)',
        range50: '-15% to +32% (approx)',
        sources: [
          { label: 'FRED 10-Year Treasury Constant Maturity (DGS10)', url: 'https://fred.stlouisfed.org/series/DGS10' },
          { label: 'US Treasury historical yield curve data', url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates' }
        ]
      },
      bankMetric: {
        mean: 0.02,
        std: 0.01,
        summaryPeriod: '50y',
        range25: '0.0% to +5.5% (approx)',
        range50: '0.0% to +8.5% (approx)',
        sources: [
          { label: 'FRED 3-Month Treasury Bill Secondary Market Rate (TB3MS)', url: 'https://fred.stlouisfed.org/series/TB3MS' },
          { label: 'Federal Reserve H.15 selected interest rates', url: 'https://www.federalreserve.gov/releases/h15/' }
        ]
      },
      inflationMetric: {
        mean: 0.03,
        std: 0.03,
        summaryPeriod: '50y',
        range25: '-1.4% to +13.5% (approx)',
        range50: '-2.1% to +14.8% (approx)',
        sources: [
          { label: 'US CPI inflation (BLS)', url: 'https://www.bls.gov/cpi/' },
          { label: 'FRED CPIAUCSL', url: 'https://fred.stlouisfed.org/series/CPIAUCSL' }
        ]
      },
      regimeTemplate: {
        stayGrowth: 0.92,
        stayCrisis: 0.68,
        meanSpread: 0.16,
        growthStdMultiplier: 0.72,
        crisisStdMultiplier: 1.95
      }
    },
    EUR: {
      region: 'Euro area',
      stockMetric: {
        mean: 0.085,
        std: 0.18,
        summaryPeriod: '50y',
        range25: '-44% to +35% (approx)',
        range50: '-44% to +53% (approx)',
        sources: [
          { label: 'STOXX Europe 600 index page', url: 'https://www.stoxx.com/index-details?symbol=SXXP' },
          { label: 'MSCI Europe index overview', url: 'https://www.msci.com/indexes/index/990100' }
        ]
      },
      bondMetric: {
        mean: 0.036,
        std: 0.07,
        summaryPeriod: '50y',
        range25: '-10% to +13% (approx)',
        range50: '-13% to +21% (approx)',
        sources: [
          { label: 'ECB euro area yield curves', url: 'https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_area_yield_curves/html/index.en.html' },
          { label: 'ECB long-term interest rate statistics', url: 'https://www.ecb.europa.eu/stats/macroeconomic_and_sectoral/financial_markets_and_interest_rates/long_term_interest_rates/html/index.en.html' }
        ]
      },
      bankMetric: {
        mean: 0.018,
        std: 0.009,
        summaryPeriod: '50y',
        range25: '0.0% to +4.0% (approx)',
        range50: '-0.5% to +6.0% (approx)',
        sources: [
          { label: 'ECB key ECB interest rates', url: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html' },
          { label: 'Euro short-term rate (€STR)', url: 'https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_short-term_rate/html/index.en.html' }
        ]
      },
      inflationMetric: {
        mean: 0.022,
        std: 0.022,
        summaryPeriod: '50y',
        range25: '-0.6% to +10.6% (approx)',
        range50: '-0.9% to +15.0% (approx)',
        sources: [
          { label: 'Eurostat HICP inflation', url: 'https://ec.europa.eu/eurostat/statistics-explained/index.php?title=Inflation_in_the_euro_area' },
          { label: 'ECB inflation dashboard', url: 'https://www.ecb.europa.eu/stats/macroeconomic_and_sectoral/hicp/html/index.en.html' }
        ]
      },
      regimeTemplate: {
        stayGrowth: 0.89,
        stayCrisis: 0.71,
        meanSpread: 0.15,
        growthStdMultiplier: 0.75,
        crisisStdMultiplier: 1.9
      }
    },
    GBP: {
      region: 'United Kingdom',
      stockMetric: {
        mean: 0.078,
        std: 0.16,
        summaryPeriod: '50y',
        range25: '-31% to +30% (approx)',
        range50: '-48% to +47% (approx)',
        sources: [
          { label: 'FTSE 100 overview (LSE)', url: 'https://www.londonstockexchange.com/indices/ftse-100' },
          { label: 'FTSE Russell index resources', url: 'https://www.lseg.com/en/ftse-russell/index-series/uk-index-series' }
        ]
      },
      bondMetric: {
        mean: 0.043,
        std: 0.075,
        summaryPeriod: '50y',
        range25: '-12% to +15% (approx)',
        range50: '-17% to +24% (approx)',
        sources: [
          { label: 'Bank of England yield curves', url: 'https://www.bankofengland.co.uk/statistics/yield-curves' },
          { label: 'UK Debt Management Office gilt yields', url: 'https://www.dmo.gov.uk/data/gilt-market/' }
        ]
      },
      bankMetric: {
        mean: 0.021,
        std: 0.012,
        summaryPeriod: '50y',
        range25: '0.0% to +5.0% (approx)',
        range50: '0.0% to +8.0% (approx)',
        sources: [
          { label: 'Bank of England Bank Rate history', url: 'https://www.bankofengland.co.uk/boeapps/database/Bank-Rate.asp' },
          { label: 'Bank of England policy and rates', url: 'https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate' }
        ]
      },
      inflationMetric: {
        mean: 0.032,
        std: 0.03,
        summaryPeriod: '50y',
        range25: '-0.1% to +11.1% (approx)',
        range50: '-1.2% to +24.2% (approx)',
        sources: [
          { label: 'ONS CPI', url: 'https://www.ons.gov.uk/economy/inflationandpriceindices' },
          { label: 'Bank of England inflation data', url: 'https://www.bankofengland.co.uk/monetary-policy/inflation' }
        ]
      },
      regimeTemplate: {
        stayGrowth: 0.9,
        stayCrisis: 0.67,
        meanSpread: 0.145,
        growthStdMultiplier: 0.74,
        crisisStdMultiplier: 1.88
      }
    }
  };

  // ─── Reactive state ─────────────────────────────────────────────────────────

  let Plotly: any;
  let plotReady = false;
  let realReturnCdfEl: HTMLDivElement | null = null;

  let simulation: SimulationResult | null = null;
  let stats: SummaryStats | null = null;
  let errorMessage = '';
  let running = false;
  let runStatusMessage = '';
  let resultStage: 'idle' | 'preview' | 'final' = 'idle';
  let previewRecalcTimer: ReturnType<typeof setTimeout> | null = null;
  let previewReady = false;

  let selectedCurrencyCode: CurrencyCode = 'EUR';
  const DEFAULT_EQUITY_BOND_CORRELATION = -0.1;
  const DEFAULT_ANNUAL_FEE_PERCENT = 0.005;
  const DEFAULT_TAX_ON_GAINS_PERCENT = 0.15;
  const DEFAULT_SKEWNESS = 0;
  const DEFAULT_KURTOSIS = 3;
  const QUICK_PREVIEW_SIMULATIONS = 200;
  const FULL_MONTE_CARLO_MIN_SIMULATIONS = 1500;
  const DEFAULT_FULL_MONTE_CARLO_SIMULATIONS = 3000;
  let stockBoundaryPercent = DEFAULT_STOCK_BOUNDARY_PERCENT;
  let bondBoundaryPercent = DEFAULT_BOND_BOUNDARY_PERCENT;
  let investmentMetrics: InvestmentMetricInputs = {
    stockMean: ASSUMPTION_REFERENCES.EUR.stockMetric.mean,
    stockStd: ASSUMPTION_REFERENCES.EUR.stockMetric.std,
    stockSkew: DEFAULT_SKEWNESS,
    stockKurt: DEFAULT_KURTOSIS,
    bondMean: ASSUMPTION_REFERENCES.EUR.bondMetric.mean,
    bondStd: ASSUMPTION_REFERENCES.EUR.bondMetric.std,
    bondSkew: DEFAULT_SKEWNESS,
    bondKurt: DEFAULT_KURTOSIS,
    bankMean: ASSUMPTION_REFERENCES.EUR.bankMetric.mean,
    bankStd: ASSUMPTION_REFERENCES.EUR.bankMetric.std,
    bankSkew: DEFAULT_SKEWNESS,
    bankKurt: DEFAULT_KURTOSIS
  };
  let lastAppliedReferenceCurrency = '';
  let historicalMarketData: HistoricalMarketDataset | null = null;
  let historicalDataLoadError = '';
  let showHistoricalMethodologyInfo = false;

  $: selectedCurrency = CURRENCIES.find(c => c.code === selectedCurrencyCode) ?? CURRENCIES[0];
  $: selectedAssumptionReference = ASSUMPTION_REFERENCES[selectedCurrencyCode];
  $: selectedHistoricalRegion = historicalMarketData?.regions?.[selectedCurrencyCode] ?? null;

  function fmtNum(n: number, decimals = 0): string {
    if (n == null || isNaN(n)) return '0';
    const fixed = Math.abs(n).toFixed(decimals);
    const [intPart, decPart] = fixed.split('.');
    const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
    const sign = n < 0 ? '-' : '';
    return decimals > 0 && decPart ? `${sign}${withSep}.${decPart}` : `${sign}${withSep}`;
  }

  $: fmtCurrency = (n: number) => `${selectedCurrency.symbol}\u00A0${fmtNum(n)}`;

  function fmtCompactValue(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) {
      const millions = abs / 1_000_000;
      const shown = millions >= 10 ? Math.round(millions).toString() : millions.toFixed(1).replace(/\.0$/, '');
      return `${value < 0 ? '-' : ''}${shown} mln`;
    }
    if (abs >= 1_000) {
      const thousands = abs / 1_000;
      const shown = thousands >= 10 ? Math.round(thousands).toString() : thousands.toFixed(1).replace(/\.0$/, '');
      return `${value < 0 ? '-' : ''}${shown}k`;
    }
    return Math.round(value).toString();
  }

  $: fmtCompactCurrency = (n: number) => `${selectedCurrency.symbol}\u00A0${fmtCompactValue(n)}`;

  function toSignificant(value: number, digits = 3): number {
    if (!Number.isFinite(value) || value === 0) return 0;
    return Number(value.toPrecision(digits));
  }

  function stripTrailingZeros(value: string): string {
    return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function fmtHoverCompactValue(value: number): string {
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    if (abs >= 1_000_000) {
      const millions = stripTrailingZeros(toSignificant(abs / 1_000_000, 3).toString());
      return `${sign}${millions} mln`;
    }
    if (abs >= 1_000) {
      const thousands = stripTrailingZeros(toSignificant(abs / 1_000, 3).toString());
      return `${sign}${thousands}k`;
    }
    const rounded = toSignificant(abs, 3);
    const shown = rounded.toLocaleString('en-US', { maximumSignificantDigits: 3 }).replace(/,/g, "'");
    return `${sign}${shown}`;
  }

  $: fmtHoverCompactCurrency = (n: number) => `${selectedCurrency.symbol}\u00A0${fmtHoverCompactValue(n)}`;

  function parseNum(s: string): number {
    const cleaned = String(s).replace(/'/g, '').replace(/[^\d.\-]/g, '');
    const n = Number(cleaned);
    return isNaN(n) ? 0 : n;
  }

  function numFromEvent(e: Event): number {
    return parseNum((e.target as HTMLInputElement).value);
  }

  function decimalFromPercentEvent(e: Event): number {
    return numFromEvent(e) / 100;
  }

  function fmtPercentInput(decimal: number, decimals = 2): string {
    const pct = decimal * 100;
    return pct.toFixed(decimals).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function fmtPercentDisplay(decimal: number, decimals = 2): string {
    return `${fmtPercentInput(decimal, decimals)}%`;
  }

  function fmtPercentInputSig3(decimal: number): string {
    const percent = toSignificant(decimal * 100, 3);
    return stripTrailingZeros(percent.toString());
  }

  const percentFormatter = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1
  });

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function getAllocationSplit(): AllocationSplit {
    const stocks = clamp(stockBoundaryPercent, 0, 100) / 100;
    const bonds = clamp(bondBoundaryPercent - stockBoundaryPercent, 0, 100) / 100;
    const bank = clamp(100 - bondBoundaryPercent, 0, 100) / 100;
    return { stocks, bonds, bank };
  }

  function blendPortfolioMetrics(
    metrics: InvestmentMetricInputs,
    allocation: AllocationSplit,
    equityBondCorrelation: number
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
      return { mean, std: 0, skewness: DEFAULT_SKEWNESS, kurtosis: DEFAULT_KURTOSIS };
    }

    const stockThird = (allocation.stocks * metrics.stockStd) ** 3 * metrics.stockSkew;
    const bondThird = (allocation.bonds * metrics.bondStd) ** 3 * metrics.bondSkew;
    const bankThird = (allocation.bank * metrics.bankStd) ** 3 * metrics.bankSkew;
    const skewness = (stockThird + bondThird + bankThird) / (std ** 3);

    const stockFourth = (allocation.stocks * metrics.stockStd) ** 4 * metrics.stockKurt;
    const bondFourth = (allocation.bonds * metrics.bondStd) ** 4 * metrics.bondKurt;
    const bankFourth = (allocation.bank * metrics.bankStd) ** 4 * metrics.bankKurt;
    const kurtosis = Math.max(1, (stockFourth + bondFourth + bankFourth) / (std ** 4));

    return { mean, std, skewness, kurtosis };
  }

  function summarizeSeriesMoments(values: number[]): { mean: number; std: number } {
    if (values.length === 0) return { mean: 0, std: 0 };
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return { mean, std: Math.sqrt(Math.max(0, variance)) };
  }

  function summarizeSeriesDistribution(values: number[]): { mean: number; std: number; skewness: number; kurtosis: number } {
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

  function sampleCorrelation(first: number[], second: number[]): number | null {
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

  function estimateEquityBondCorrelation(currencyCode: CurrencyCode): number | null {
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

  function getHistoricalInvestmentMetrics(currencyCode: CurrencyCode): InvestmentMetricInputs | null {
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

  function buildPortfolioHistoricalReturns(currencyCode: CurrencyCode, allocation: AllocationSplit): number[] {
    const region = historicalMarketData?.regions?.[currencyCode];
    if (!region || !Array.isArray(region.annualSeries)) return [];

    return region.annualSeries
      .map((row) =>
        allocation.stocks * row.equity +
        allocation.bonds * row.bond +
        allocation.bank * row.cash
      )
      .filter((value) => Number.isFinite(value));
  }

  function buildPortfolioHistoricalMonthlyReturns(currencyCode: CurrencyCode, allocation: AllocationSplit): number[] {
    const region = historicalMarketData?.regions?.[currencyCode];
    if (!region || !Array.isArray(region.monthlySeries)) return [];

    return region.monthlySeries
      .map((row) =>
        allocation.stocks * row.equity +
        allocation.bonds * row.bond +
        allocation.bank * row.cash
      )
      .filter((value) => Number.isFinite(value));
  }

  function clampProbability(value: number): number {
    return clamp(value, 0.001, 0.999);
  }

  function getGrowthStationaryProbability(stayGrowth: number, stayCrisis: number): number {
    const denominator = 2 - stayGrowth - stayCrisis;
    if (denominator <= 1e-9) return 0.5;
    return (1 - stayCrisis) / denominator;
  }

  function buildRegimeModelFromPortfolio(
    portfolioMean: number,
    portfolioStd: number,
    portfolioSkewness: number,
    portfolioKurtosis: number,
    template: RegimeTemplate
  ): PlannerInput['regimeModel'] {
    const stayGrowth = clampProbability(template.stayGrowth);
    const stayCrisis = clampProbability(template.stayCrisis);
    const growthProbability = clampProbability(getGrowthStationaryProbability(stayGrowth, stayCrisis));
    const crisisProbability = 1 - growthProbability;

    const skewTilt = Math.max(-2, Math.min(2, portfolioSkewness));
    const excessKurtosis = Math.max(0, portfolioKurtosis - 3);
    const spread = Math.max(0.01, template.meanSpread * (1 + excessKurtosis * 0.08) * (1 + Math.max(0, -skewTilt) * 0.25));
    const growthMean = portfolioMean + crisisProbability * spread;
    const crisisMean = portfolioMean - growthProbability * spread;

    const growthStdMultiplier = Math.max(0.1, template.growthStdMultiplier * (1 + Math.max(0, skewTilt) * 0.1));
    const crisisStdMultiplier = Math.max(growthStdMultiplier + 0.2, template.crisisStdMultiplier * (1 + excessKurtosis * 0.06));

    const targetVariance = Math.max(1e-8, portfolioStd ** 2);
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

    const floorStd = 0.005;
    const growthStd = Math.max(floorStd, sharedScale * growthStdMultiplier);
    const crisisStd = Math.max(growthStd + floorStd, sharedScale * crisisStdMultiplier);

    return {
      stayGrowth,
      stayCrisis,
      growthMean,
      growthStd,
      crisisMean,
      crisisStd
    };
  }

  function applyInvestmentAllocationMetrics() {
    const allocation = calcGetAllocationSplit(stockBoundaryPercent, bondBoundaryPercent);
    const blended = calcBlendPortfolioMetrics(investmentMetrics, allocation, input.equityBondCorrelation, DEFAULT_SKEWNESS, DEFAULT_KURTOSIS);
    const historicalAnnualReturns = calcBuildPortfolioHistoricalReturns(historicalMarketData, selectedCurrencyCode, allocation);
    const historicalMonthlyReturns = calcBuildPortfolioHistoricalMonthlyReturns(historicalMarketData, selectedCurrencyCode, allocation);
    const effectiveMean = blended.mean;
    const effectiveStd = blended.std;
    const effectiveSkew = blended.skewness;
    const effectiveKurt = blended.kurtosis;
    const regimeModel = calcBuildRegimeModelFromPortfolio(effectiveMean, effectiveStd, effectiveSkew, effectiveKurt, selectedAssumptionReference.regimeTemplate);
    input = {
      ...input,
      meanReturn: effectiveMean,
      returnVariability: effectiveStd,
      returnSkewness: effectiveSkew,
      returnKurtosis: effectiveKurt,
      regimeModel,
      equityBondCorrelation: input.equityBondCorrelation,
      historicalAnnualReturns: historicalAnnualReturns.length >= 10 ? historicalAnnualReturns : undefined,
      historicalMonthlyReturns: historicalMonthlyReturns.length >= 120 ? historicalMonthlyReturns : undefined
    };
  }

  function normalizeAllocationBoundaries() {
    const roundedStockBoundary = clamp(Math.round(stockBoundaryPercent), 0, 100);
    const roundedBondBoundary = clamp(Math.round(bondBoundaryPercent), 0, 100);
    const leftBoundary = Math.min(roundedStockBoundary, roundedBondBoundary);
    const rightBoundary = Math.max(roundedStockBoundary, roundedBondBoundary);

    if (stockBoundaryPercent !== leftBoundary) stockBoundaryPercent = leftBoundary;
    if (bondBoundaryPercent !== rightBoundary) bondBoundaryPercent = rightBoundary;
  }

  function onStockBoundaryChange() {
    normalizeAllocationBoundaries();
    applyInvestmentAllocationMetrics();
  }

  function onBondBoundaryChange() {
    normalizeAllocationBoundaries();
    applyInvestmentAllocationMetrics();
  }

  $: {
    normalizeAllocationBoundaries();
  }

  $: stockAllocationPercent = clamp(stockBoundaryPercent, 0, 100);
  $: bondAllocationPercent = clamp(bondBoundaryPercent - stockBoundaryPercent, 0, 100);
  $: bankAllocationPercent = clamp(100 - bondBoundaryPercent, 0, 100);

  $: currentAllocation = getAllocationSplit();
  // $: stockReturnContribution = currentAllocation.stocks * investmentMetrics.stockMean;
  // $: bondReturnContribution = currentAllocation.bonds * investmentMetrics.bondMean;
  // $: bankReturnContribution = currentAllocation.bank * investmentMetrics.bankMean;
  $: stockRiskComponent = currentAllocation.stocks * investmentMetrics.stockStd;
  $: bondRiskComponent = currentAllocation.bonds * investmentMetrics.bondStd;
  $: bankRiskComponent = currentAllocation.bank * investmentMetrics.bankStd;
  $: stockRiskContribution = input.returnVariability > 0 ? (stockRiskComponent ** 2) / input.returnVariability : 0;
  $: bondRiskContribution = input.returnVariability > 0 ? (bondRiskComponent ** 2) / input.returnVariability : 0;
  $: bankRiskContribution = input.returnVariability > 0 ? (bankRiskComponent ** 2) / input.returnVariability : 0;
  // $: stockRiskShare = input.returnVariability > 0 ? stockRiskContribution / input.returnVariability : 0;
  // $: bondRiskShare = input.returnVariability > 0 ? bondRiskContribution / input.returnVariability : 0;
  // $: bankRiskShare = input.returnVariability > 0 ? bankRiskContribution / input.returnVariability : 0;

  // ─── Core inputs ─────────────────────────────────────────────────────────────

  let input: PlannerInput = {
    currentAge: 35,
    retirementAge: 50,
    simulateUntilAge: 90,
    currentSavings: 120000,
    meanReturn: blendPortfolioMetrics(investmentMetrics, DEFAULT_ALLOCATION, DEFAULT_EQUITY_BOND_CORRELATION).mean,
    returnVariability: blendPortfolioMetrics(investmentMetrics, DEFAULT_ALLOCATION, DEFAULT_EQUITY_BOND_CORRELATION).std,
    returnSkewness: blendPortfolioMetrics(investmentMetrics, DEFAULT_ALLOCATION, DEFAULT_EQUITY_BOND_CORRELATION).skewness,
    returnKurtosis: blendPortfolioMetrics(investmentMetrics, DEFAULT_ALLOCATION, DEFAULT_EQUITY_BOND_CORRELATION).kurtosis,
    equityBondCorrelation: DEFAULT_EQUITY_BOND_CORRELATION,
    inflationMean: ASSUMPTION_REFERENCES.EUR.inflationMetric.mean,
    inflationVariability: ASSUMPTION_REFERENCES.EUR.inflationMetric.std,
    inflationSkewness: DEFAULT_SKEWNESS,
    inflationKurtosis: DEFAULT_KURTOSIS,
    annualFeePercent: DEFAULT_ANNUAL_FEE_PERCENT,
    taxOnGainsPercent: DEFAULT_TAX_ON_GAINS_PERCENT,
    safeWithdrawalRate: 0.04,
    simulations: DEFAULT_FULL_MONTE_CARLO_SIMULATIONS,
    regimeModel: buildRegimeModelFromPortfolio(
      blendPortfolioMetrics(investmentMetrics, DEFAULT_ALLOCATION, DEFAULT_EQUITY_BOND_CORRELATION).mean,
      blendPortfolioMetrics(investmentMetrics, DEFAULT_ALLOCATION, DEFAULT_EQUITY_BOND_CORRELATION).std,
      blendPortfolioMetrics(investmentMetrics, DEFAULT_ALLOCATION, DEFAULT_EQUITY_BOND_CORRELATION).skewness,
      blendPortfolioMetrics(investmentMetrics, DEFAULT_ALLOCATION, DEFAULT_EQUITY_BOND_CORRELATION).kurtosis,
      ASSUMPTION_REFERENCES.EUR.regimeTemplate
    ),
    historicalAnnualReturns: undefined
  };

  function onInvestmentMetricChange() {
    investmentMetrics = {
      ...investmentMetrics,
      stockStd: Math.max(0, investmentMetrics.stockStd),
      stockKurt: Math.max(1, investmentMetrics.stockKurt),
      bondStd: Math.max(0, investmentMetrics.bondStd),
      bondKurt: Math.max(1, investmentMetrics.bondKurt),
      bankStd: Math.max(0, investmentMetrics.bankStd),
      bankKurt: Math.max(1, investmentMetrics.bankKurt)
    };
    applyInvestmentAllocationMetrics();
  }

  function applyReferenceDefaults(currencyCode: CurrencyCode) {
    const reference = ASSUMPTION_REFERENCES[currencyCode];
    const historicalMetrics = calcGetHistoricalInvestmentMetrics(historicalMarketData, currencyCode);
    investmentMetrics = historicalMetrics ?? {
      stockMean: reference.stockMetric.mean,
      stockStd: reference.stockMetric.std,
      stockSkew: DEFAULT_SKEWNESS,
      stockKurt: DEFAULT_KURTOSIS,
      bondMean: reference.bondMetric.mean,
      bondStd: reference.bondMetric.std,
      bondSkew: DEFAULT_SKEWNESS,
      bondKurt: DEFAULT_KURTOSIS,
      bankMean: reference.bankMetric.mean,
      bankStd: reference.bankMetric.std,
      bankSkew: DEFAULT_SKEWNESS,
      bankKurt: DEFAULT_KURTOSIS
    };
    const allocation = calcGetAllocationSplit(stockBoundaryPercent, bondBoundaryPercent);
    const estimatedCorrelation = calcEstimateEquityBondCorrelation(historicalMarketData, currencyCode);
    const effectiveCorrelation = calcClamp(estimatedCorrelation ?? DEFAULT_EQUITY_BOND_CORRELATION, -1, 1);
    const blended = calcBlendPortfolioMetrics(investmentMetrics, allocation, effectiveCorrelation, DEFAULT_SKEWNESS, DEFAULT_KURTOSIS);
    const historicalAnnualReturns = calcBuildPortfolioHistoricalReturns(historicalMarketData, currencyCode, allocation);
    const historicalMonthlyReturns = calcBuildPortfolioHistoricalMonthlyReturns(historicalMarketData, currencyCode, allocation);
    const dataMoments = calcSummarizeSeriesDistribution(historicalAnnualReturns);
    const useHistoricalMoments = historicalAnnualReturns.length >= 10;
    const effectiveMean = useHistoricalMoments ? dataMoments.mean : blended.mean;
    const effectiveStd = useHistoricalMoments ? dataMoments.std : blended.std;
    const effectiveSkew = useHistoricalMoments ? dataMoments.skewness : blended.skewness;
    const effectiveKurt = useHistoricalMoments ? dataMoments.kurtosis : blended.kurtosis;
    const regimeModel = buildRegimeModelFromPortfolio(effectiveMean, effectiveStd, effectiveSkew, effectiveKurt, reference.regimeTemplate);
    input = {
      ...input,
      meanReturn: effectiveMean,
      returnVariability: effectiveStd,
      returnSkewness: effectiveSkew,
      returnKurtosis: effectiveKurt,
      equityBondCorrelation: effectiveCorrelation,
      inflationMean: reference.inflationMetric.mean,
      inflationVariability: reference.inflationMetric.std,
      inflationSkewness: DEFAULT_SKEWNESS,
      inflationKurtosis: DEFAULT_KURTOSIS,
      regimeModel,
      historicalAnnualReturns: historicalAnnualReturns.length >= 10 ? historicalAnnualReturns : undefined,
      historicalMonthlyReturns: historicalMonthlyReturns.length >= 120 ? historicalMonthlyReturns : undefined
    };
  }

  function resetAssumptionsToCurrencyDefaults() {
    applyReferenceDefaults(selectedCurrencyCode);
  }

  function resetStockMetricsToDefault() {
    const reference = selectedAssumptionReference.stockMetric;
    const historicalMetric = selectedHistoricalRegion?.assetMoments.equity;
    investmentMetrics = {
      ...investmentMetrics,
      stockMean: reference.mean,
      stockStd: reference.std,
      stockSkew: historicalMetric?.skewness ?? DEFAULT_SKEWNESS,
      stockKurt: historicalMetric?.kurtosis ?? DEFAULT_KURTOSIS
    };
    onInvestmentMetricChange();
  }

  function resetBondMetricsToDefault() {
    const reference = selectedAssumptionReference.bondMetric;
    const historicalMetric = selectedHistoricalRegion?.assetMoments.bond;
    investmentMetrics = {
      ...investmentMetrics,
      bondMean: reference.mean,
      bondStd: reference.std,
      bondSkew: historicalMetric?.skewness ?? DEFAULT_SKEWNESS,
      bondKurt: historicalMetric?.kurtosis ?? DEFAULT_KURTOSIS
    };
    onInvestmentMetricChange();
  }

  function resetBankMetricsToDefault() {
    const reference = selectedAssumptionReference.bankMetric;
    const historicalMetric = selectedHistoricalRegion?.assetMoments.cash;
    investmentMetrics = {
      ...investmentMetrics,
      bankMean: reference.mean,
      bankStd: reference.std,
      bankSkew: historicalMetric?.skewness ?? DEFAULT_SKEWNESS,
      bankKurt: historicalMetric?.kurtosis ?? DEFAULT_KURTOSIS
    };
    onInvestmentMetricChange();
  }

  function resetInflationToDefault() {
    const reference = selectedAssumptionReference.inflationMetric;
    input = {
      ...input,
      inflationMean: reference.mean,
      inflationVariability: reference.std,
      inflationSkewness: DEFAULT_SKEWNESS,
      inflationKurtosis: DEFAULT_KURTOSIS
    };
  }

  function resetDragToDefault() {
    input = {
      ...input,
      annualFeePercent: DEFAULT_ANNUAL_FEE_PERCENT,
      taxOnGainsPercent: DEFAULT_TAX_ON_GAINS_PERCENT
    };
  }

  $: if (selectedCurrencyCode !== lastAppliedReferenceCurrency) {
    applyReferenceDefaults(selectedCurrencyCode);
    lastAppliedReferenceCurrency = selectedCurrencyCode;
  }

  // ─── Variable spending periods ────────────────────────────────────────────────

  let spendingPeriods: SpendingPeriod[] = [
    { id: 'sp-default', label: 'Living expenses', fromAge: 35, toAge: 90, yearlyAmount: 32000, inflationAdjusted: true }
  ];

  function addSpendingPeriod() {
    spendingPeriods = [...spendingPeriods, {
      id: `sp-${Date.now()}`,
      label: 'Extra spending',
      fromAge: input.currentAge,
      toAge: input.currentAge + 5,
      yearlyAmount: 5000,
      inflationAdjusted: true
    }];
  }

  function removeSpendingPeriod(id: string) {
    if (id === 'sp-default') return;
    spendingPeriods = spendingPeriods.filter(p => p.id !== id);
  }

  $: {
    const living = spendingPeriods.find((period) => period.id === 'sp-default');
    let changed = false;

    if (living) {
      if (living.fromAge !== input.currentAge) {
        living.fromAge = input.currentAge;
        changed = true;
      }
      if (living.toAge !== input.simulateUntilAge) {
        living.toAge = input.simulateUntilAge;
        changed = true;
      }
    }

    if (changed) {
      spendingPeriods = [...spendingPeriods];
    }
  }

  // ─── Income sources ───────────────────────────────────────────────────────────

  let incomeSources: IncomeSource[] = [
    { id: 'is-default', label: 'Salary', fromAge: input.currentAge, toAge: input.retirementAge, yearlyAmount: 65000, inflationAdjusted: false },
    { id: 'is-pension', label: 'Pension / Social security', fromAge: 67, toAge: input.simulateUntilAge, yearlyAmount: 15000, inflationAdjusted: true }
  ];

  function addIncomeSource() {
    incomeSources = [...incomeSources, {
      id: `is-${Date.now()}`,
      label: 'Pension / Social security',
      fromAge: 67,
      toAge: input.simulateUntilAge,
      yearlyAmount: 15000,
      inflationAdjusted: true
    }];
  }

  function removeIncomeSource(id: string) {
    if (id === 'is-default' || id === 'is-pension') return;
    incomeSources = incomeSources.filter(s => s.id !== id);
  }

  $: {
    const salary = incomeSources.find((src) => src.id === 'is-default');
    const pension = incomeSources.find((src) => src.id === 'is-pension');
    let changed = false;

    if (salary) {
      if (salary.fromAge !== input.currentAge) {
        salary.fromAge = input.currentAge;
        changed = true;
      }
      if (salary.toAge !== input.retirementAge) {
        salary.toAge = input.retirementAge;
        changed = true;
      }
    }

    if (pension && pension.toAge !== input.simulateUntilAge) {
      pension.toAge = input.simulateUntilAge;
      changed = true;
    }

    if (changed) {
      incomeSources = [...incomeSources];
    }
  }

  // ─── Lump-sum events ──────────────────────────────────────────────────────────

  let lumpSumEvents: LumpSumEvent[] = [];

  function addLumpSumEvent() {
    lumpSumEvents = [...lumpSumEvents, {
      id: `ls-${Date.now()}`,
      label: 'One-time event',
      age: input.retirementAge,
      amount: -10000  // default: expense
    }];
  }

  function removeLumpSumEvent(id: string) {
    lumpSumEvents = lumpSumEvents.filter(e => e.id !== id);
  }

  // ─── Derived ──────────────────────────────────────────────────────────────────

  const FI_TARGET_SUCCESS_PROBABILITY = 0.95;

  $: annualFeeRate = clamp(input.annualFeePercent, 0, 1);
  $: taxOnGainsRate = clamp(input.taxOnGainsPercent, 0, 1);
  $: nominalReturnAfterCostsEstimate = input.meanReturn > 0
    ? input.meanReturn * (1 - taxOnGainsRate) - annualFeeRate
    : input.meanReturn;
  $: nominalStdAfterCostsEstimate = input.returnVariability * (1 - taxOnGainsRate) * (1 - annualFeeRate);
  $: portfolioDisplaySkew = input.returnSkewness;
  $: portfolioDisplayKurt = input.returnKurtosis;
  $: realReturnSkewEstimate = input.returnSkewness - input.inflationSkewness;
  $: realReturnKurtEstimate = Math.max(1, input.returnKurtosis + input.inflationKurtosis - 3);
  $: realReturnEstimate = (1 + nominalReturnAfterCostsEstimate) / (1 + input.inflationMean) - 1;
  $: realReturnStdEstimate = Math.sqrt(nominalStdAfterCostsEstimate ** 2 + input.inflationVariability ** 2);
  $: realReturn68Low = realReturnEstimate - realReturnStdEstimate;
  $: realReturn68High = realReturnEstimate + realReturnStdEstimate;
  $: realReturn95Low = realReturnEstimate - 2 * realReturnStdEstimate;
  $: realReturn95High = realReturnEstimate + 2 * realReturnStdEstimate;
  $: realReturnPercentiles = [
    { label: 'P5', probability: 0.05, z: -1.6448536269514722 },
    { label: 'P10', probability: 0.10, z: -1.2815515655446004 },
    { label: 'P25', probability: 0.25, z: -0.6744897501960817 },
    { label: 'P50', probability: 0.50, z: 0 },
    { label: 'P75', probability: 0.75, z: 0.6744897501960817 },
    { label: 'P90', probability: 0.90, z: 1.2815515655446004 },
    { label: 'P95', probability: 0.95, z: 1.6448536269514722 }
  ].map((entry) => ({
    label: entry.label,
    probability: entry.probability,
    value: realReturnEstimate + entry.z * realReturnStdEstimate
  }));
  $: realReturnCdfMin = Math.min(realReturn95Low, ...realReturnPercentiles.map((point) => point.value));
  $: realReturnCdfMax = Math.max(realReturn95High, ...realReturnPercentiles.map((point) => point.value));
  $: realReturnCdfSpan = Math.max(1e-6, realReturnCdfMax - realReturnCdfMin);
  $: zeroReturnPercentile = (() => {
    if (realReturnStdEstimate <= 1e-9) {
      if (realReturnEstimate < 0) return 1;
      if (realReturnEstimate > 0) return 0;
      return 0.5;
    }
    const z = (0 - realReturnEstimate) / realReturnStdEstimate;
    return clamp(calcNormalCdf(z), 0, 1);
  })();
  $: realReturnCdfXTicks = (() => {
    const sortedPoints = [...realReturnPercentiles].sort((a, b) => a.value - b.value);
    const merged: { value: number; labels: string[] }[] = [];

    for (const point of sortedPoints) {
      const existing = merged.find((entry) => Math.abs(entry.value - point.value) < 0.001);
      if (existing) {
        existing.labels.push(point.label);
      } else {
        merged.push({ value: point.value, labels: [point.label] });
      }
    }

    const zeroTick = merged.find((entry) => Math.abs(entry.value) < 0.001);
    const zeroPercentileLabel = `P${Math.round(zeroReturnPercentile * 100)}`;
    if (zeroTick) {
      if (!zeroTick.labels.includes(zeroPercentileLabel)) {
        zeroTick.labels = [...zeroTick.labels, zeroPercentileLabel];
      }
    } else {
      merged.push({ value: 0, labels: [zeroPercentileLabel] });
    }

    merged.sort((a, b) => a.value - b.value);

    return merged.map((entry) => {
      const bottomLabel = entry.labels.join('/');
      const isZeroTick = Math.abs(entry.value) < 0.001;
      return {
        value: entry.value,
        label: isZeroTick ? `0<br>${bottomLabel}` : `${fmtSignedPercent(entry.value, 1)}<br>${bottomLabel}`,
        color: entry.value > 0 ? '#16a34a' : entry.value < 0 ? '#dc2626' : '#475569'
      };
    });
  })();

  function fmtSignedPercent(decimal: number, digits = 1): string {
    const pct = decimal * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
  }

  $: retirementYearlySpending = spendingAtAge(input.retirementAge, spendingPeriods);
  $: baselineFiTarget = retirementYearlySpending / Math.max(0.01, input.safeWithdrawalRate);
  $: fiTargetSWR = baselineFiTarget;
  $: fiTargetP95 = stats?.fiTargetP95 ?? fiTargetSWR;
  $: fiTarget = fiTargetP95;

  $: previewTriggerKey = [
    selectedCurrencyCode,
    input.currentAge,
    input.retirementAge,
    input.simulateUntilAge,
    input.currentSavings,
    input.meanReturn,
    input.returnVariability,
    input.returnSkewness,
    input.returnKurtosis,
    input.equityBondCorrelation,
    input.regimeModel.stayGrowth,
    input.regimeModel.stayCrisis,
    input.regimeModel.growthMean,
    input.regimeModel.growthStd,
    input.regimeModel.crisisMean,
    input.regimeModel.crisisStd,
    input.historicalAnnualReturns?.length ?? 0,
    input.historicalMonthlyReturns?.length ?? 0,
    (input.historicalAnnualReturns ?? []).slice(0, 5).map((value) => value.toFixed(4)).join(','),
    (input.historicalAnnualReturns ?? []).slice(-5).map((value) => value.toFixed(4)).join(','),
    (input.historicalMonthlyReturns ?? []).slice(0, 5).map((value) => value.toFixed(5)).join(','),
    (input.historicalMonthlyReturns ?? []).slice(-5).map((value) => value.toFixed(5)).join(','),
    input.inflationMean,
    input.inflationVariability,
    input.inflationSkewness,
    input.inflationKurtosis,
    input.annualFeePercent,
    input.taxOnGainsPercent,
    input.safeWithdrawalRate,
    stockBoundaryPercent,
    bondBoundaryPercent,
    investmentMetrics.stockMean,
    investmentMetrics.stockStd,
    investmentMetrics.bondMean,
    investmentMetrics.bondStd,
    investmentMetrics.bankMean,
    investmentMetrics.bankStd,
    spendingPeriods.map((p) => `${p.fromAge}:${p.toAge}:${p.yearlyAmount}:${p.inflationAdjusted ? 1 : 0}`).join('|'),
    incomeSources.map((s) => `${s.fromAge}:${s.toAge}:${s.yearlyAmount}:${s.inflationAdjusted ? 1 : 0}`).join('|'),
    lumpSumEvents.map((e) => `${e.age}:${e.amount}`).join('|')
  ].join('::');

  $: if (previewReady && previewTriggerKey) {
    schedulePreviewRecalculation();
  }

  $: if (plotReady && realReturnCdfEl) {
    realReturnPercentiles;
    realReturnCdfXTicks;
    realReturn68Low;
    realReturn68High;
    realReturn95Low;
    realReturn95High;
    realReturnCdfMin;
    realReturnCdfMax;
    realReturnCdfSpan;
    drawRealReturnCdfChart();
  }

  function schedulePreviewRecalculation() {
    if (previewRecalcTimer) clearTimeout(previewRecalcTimer);
    previewRecalcTimer = setTimeout(() => {
      if (running) {
        schedulePreviewRecalculation();
        return;
      }
      void recomputeApproximatePreview();
    }, 120);
  }

  async function recomputeApproximatePreview() {
    errorMessage = '';
    const validated = validateSimulationInputs(input, spendingPeriods);
    if (validated.error) {
      errorMessage = validated.error;
      return;
    }

    const previewMonteCarlo = runMonteCarloSimulation(
      {
        ...input,
        simulations: QUICK_PREVIEW_SIMULATIONS
      },
      spendingPeriods,
      incomeSources,
      lumpSumEvents,
      validated.months,
      validated.retireMonth
    );
    simulation = previewMonteCarlo.simulation;
    stats = previewMonteCarlo.stats;
    resultStage = 'preview';
    runStatusMessage = `${previewMonteCarlo.simCount} simulation quick preview. Run Monte Carlo for a 1,500+ simulation result.`;

    await tick();
  }


  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  onMount(async () => {
    const module = await import('plotly.js-dist-min');
    Plotly = module.default ?? module;

    try {
      const response = await fetch(asset('/assets/historical-market-data.json'), { cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json();
        historicalMarketData = payload as HistoricalMarketDataset;
        lastAppliedReferenceCurrency = '';
        applyReferenceDefaults(selectedCurrencyCode);
      } else {
        historicalDataLoadError = 'Historical market dataset could not be loaded; using fallback assumptions.';
      }
    } catch {
      historicalDataLoadError = 'Historical market dataset could not be loaded; using fallback assumptions.';
    }

    plotReady = true;
    previewReady = true;
    await recomputeApproximatePreview();
  });

  onDestroy(() => {
    if (previewRecalcTimer) {
      clearTimeout(previewRecalcTimer);
      previewRecalcTimer = null;
    }
    if (Plotly && realReturnCdfEl) {
      Plotly.purge(realReturnCdfEl);
    }
  });

  // ─── Simulation ───────────────────────────────────────────────────────────────

  async function runSimulation() {
    errorMessage = '';
    const validated = validateSimulationInputs(input, spendingPeriods);
    if (validated.error) {
      errorMessage = validated.error;
      return;
    }

    const requestedSimulations = Math.max(FULL_MONTE_CARLO_MIN_SIMULATIONS, Math.round(input.simulations));

    running = true;
    runStatusMessage = `Running Monte Carlo with ${requestedSimulations} simulations…`;

    await tick();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });

    const monteCarlo = runMonteCarloSimulation(
      {
        ...input,
        simulations: requestedSimulations
      },
      spendingPeriods,
      incomeSources,
      lumpSumEvents,
      validated.months,
      validated.retireMonth
    );

    simulation = monteCarlo.simulation;
    stats = monteCarlo.stats;

    running = false;
    resultStage = 'final';
    runStatusMessage = `${monteCarlo.simCount} Monte Carlo simulations completed.`;
    await tick();
  }

  function drawRealReturnCdfChart() {
    if (!Plotly || !realReturnCdfEl) return;

    const percentileValues = realReturnPercentiles.map((point) => point.value);
    const percentileProbabilities = realReturnPercentiles.map((point) => point.probability);

    const traces = [
      {
        x: [realReturn95Low, realReturn95High, realReturn95High, realReturn95Low],
        y: [0.05, 0.05, 0.95, 0.95],
        fill: 'toself',
        fillcolor: 'rgba(148,163,184,0.18)',
        line: { width: 0 },
        type: 'scatter',
        mode: 'lines',
        hoverinfo: 'skip',
        showlegend: false
      },
      {
        x: [realReturn68Low, realReturn68High, realReturn68High, realReturn68Low],
        y: [0.16, 0.16, 0.84, 0.84],
        fill: 'toself',
        fillcolor: 'rgba(34,197,94,0.2)',
        line: { width: 0 },
        type: 'scatter',
        mode: 'lines',
        hoverinfo: 'skip',
        showlegend: false
      },
      {
        x: percentileValues,
        y: percentileProbabilities,
        type: 'scatter',
        mode: 'lines',
        line: { color: '#334155', width: 1.3 },
        hovertemplate: 'Real return %{x:.2%}<br>Probability %{y:.0%}<extra></extra>',
        showlegend: false
      },
      {
        x: percentileValues,
        y: percentileProbabilities,
        type: 'scatter',
        mode: 'markers',
        marker: {
          size: 6,
          color: percentileValues.map((value) => (value >= 0 ? '#16a34a' : '#dc2626')),
          line: { color: '#ffffff', width: 1 }
        },
        hovertemplate: 'Real return %{x:.2%}<br>Probability %{y:.0%}<extra></extra>',
        showlegend: false
      }
    ];

    const layout = {
      height: 128,
      margin: { t: 6, l: 8, r: 8, b: 40 },
      showlegend: false,
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'rgba(248,250,252,0.55)',
      xaxis: {
        showgrid: false,
        ticks: 'outside',
        ticklen: 4,
        tickcolor: '#94a3b8',
        tickmode: 'array',
        tickvals: realReturnCdfXTicks.map((tick) => tick.value),
        ticktext: realReturnCdfXTicks.map((tick) => `<span style="color:${tick.color};font-weight:700">${tick.label}</span>`),
        tickfont: { size: 9, family: "'JetBrains Mono', monospace", color: '#64748b' },
        tickangle: 0,
        range: [realReturnCdfMin - realReturnCdfSpan * 0.04, realReturnCdfMax + realReturnCdfSpan * 0.04],
        fixedrange: true,
        zeroline: false
      },
      yaxis: {
        range: [0, 1],
        showgrid: false,
        showticklabels: false,
        ticks: '',
        zeroline: false,
        fixedrange: true
      },
      shapes: [
        {
          type: 'line',
          xref: 'x',
          yref: 'paper',
          x0: 0,
          x1: 0,
          y0: 0,
          y1: 1,
          line: { color: '#334155', width: 1, dash: '2px,3px' }
        }
      ],
      font: { family: 'Inter, system-ui, sans-serif', size: 10, color: '#475569' },
      hoverlabel: { font: { family: 'Inter, system-ui, sans-serif', size: 10 } }
    };

    const config = {
      responsive: true,
      displayModeBar: false,
      staticPlot: false
    };

    void Plotly.react(realReturnCdfEl, traces, layout, config);
  }

</script>

<div class="page-header">
  <h2>FIRE Retirement Monte Carlo Planner</h2>
  <p class="note">Results are inflation-adjusted and shown in today's purchasing power.</p>
</div>

<div class="workspace">
  <PlannerInputPanel
    {CURRENCIES}
    bind:selectedCurrencyCode
    {selectedCurrency}
    bind:input
    bind:incomeSources
    bind:spendingPeriods
    bind:lumpSumEvents
    bind:stockBoundaryPercent
    bind:bondBoundaryPercent
    {stockAllocationPercent}
    {bondAllocationPercent}
    {bankAllocationPercent}
    bind:investmentMetrics
    {selectedHistoricalRegion}
    {historicalDataLoadError}
    bind:showHistoricalMethodologyInfo
    {portfolioDisplaySkew}
    {portfolioDisplayKurt}
    {realReturnEstimate}
    {realReturnStdEstimate}
    {realReturnSkewEstimate}
    {realReturnKurtEstimate}
    {errorMessage}
    bind:realReturnCdfEl
    {fmtNum}
    {numFromEvent}
    {decimalFromPercentEvent}
    {fmtPercentInputSig3}
    {fmtPercentDisplay}
    {clamp}
    {addIncomeSource}
    {removeIncomeSource}
    {addSpendingPeriod}
    {removeSpendingPeriod}
    {addLumpSumEvent}
    {removeLumpSumEvent}
    {onStockBoundaryChange}
    {onBondBoundaryChange}
    {onInvestmentMetricChange}
    {resetAssumptionsToCurrencyDefaults}
    {resetStockMetricsToDefault}
    {resetBondMetricsToDefault}
    {resetBankMetricsToDefault}
    {resetInflationToDefault}
    {resetDragToDefault}
  />

  <section class="right-panel">
    <div class="card status-banner">
      <div class="status-row">
        <div>
          <strong>
            {#if running}
              Running full Monte Carlo simulation…
            {:else if resultStage === 'final'}
              Monte Carlo result is shown
            {:else}
              Quick Monte Carlo preview is shown
            {/if}
          </strong>
          <p class="note">
            {#if runStatusMessage}
              {runStatusMessage}
            {:else}
              Quick preview (400 simulations) updates automatically whenever inputs change.
            {/if}
          </p>
        </div>
        <div class="status-controls">
          <label>
            Simulations to run
            <input type="text" inputmode="numeric" value={fmtNum(input.simulations)} onchange={(e) => { input.simulations = numFromEvent(e); input = input; }} />
          </label>
          <button class="status-run-btn" onclick={runSimulation} disabled={running}>
            {running ? 'Running Monte Carlo…' : 'Run Monte Carlo'}
          </button>
        </div>
      </div>
    </div>

    <PlannerOutputCards
      {stats}
      {input}
      {fmtCompactCurrency}
      {retirementYearlySpending}
      {FI_TARGET_SUCCESS_PROBABILITY}
      {percentFormatter}
      {fmtNum}
    />

    <div class="chart-row">
      <PlannerTimelinePlot
        {Plotly}
        {plotReady}
        {simulation}
        {stats}
        retirementAge={input.retirementAge}
        {baselineFiTarget}
        {spendingPeriods}
        {lumpSumEvents}
        currencySymbol={selectedCurrency.symbol}
        {fmtCompactValue}
        {fmtHoverCompactCurrency}
      />
      <PlannerSecondaryPlot
        {Plotly}
        {plotReady}
        {stats}
        simulateUntilAge={input.simulateUntilAge}
        currencySymbol={selectedCurrency.symbol}
        {fmtCompactValue}
        {fmtHoverCompactCurrency}
      />
    </div>
  </section>
</div>
