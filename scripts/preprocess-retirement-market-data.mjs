import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const RAW_DIR = path.join(projectRoot, 'data', 'retirement', 'raw');
const OUT_PATH = path.join(projectRoot, 'public', 'assets', 'retirement', 'historical-market-data.json');

const REGIONS = {
  WORLD: { file: 'world.csv', label: 'World' },
  USD: { file: 'usd.csv', label: 'United States' },
  GBP: { file: 'gbp.csv', label: 'United Kingdom' },
  EUR: { file: 'eur.csv', label: 'Euro area' }
};

function parseRawCsv(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const dataLines = lines.filter((line) => !line.startsWith('#'));
  if (dataLines.length < 3) {
    throw new Error(`Not enough rows in ${filePath}`);
  }

  const header = dataLines[0].split(',').map((item) => item.trim());
  const dateIndex = header.indexOf('date');
  const equityIndex = header.indexOf('equity_close');
  const bondIndex = header.indexOf('bond_close');
  const cashIndex = header.indexOf('cash_rate_pct');
  if (dateIndex < 0 || equityIndex < 0 || bondIndex < 0 || cashIndex < 0) {
    throw new Error(`Invalid CSV header in ${filePath}`);
  }

  return dataLines.slice(1).map((line) => {
    const parts = line.split(',');
    const date = parts[dateIndex]?.trim();
    const equityClose = Number(parts[equityIndex]);
    const bondClose = Number(parts[bondIndex]);
    const cashRatePct = Number(parts[cashIndex]);
    return { date, equityClose, bondClose, cashRatePct };
  }).filter((row) => row.date && Number.isFinite(row.equityClose) && Number.isFinite(row.bondClose) && Number.isFinite(row.cashRatePct));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function moments(values) {
  if (!values.length) {
    return { arithmeticMean: 0, geometricMean: 0, stdDev: 0, skewness: 0, kurtosis: 3 };
  }

  const m = mean(values);
  const sd = stdDev(values);
  const geometricMean = Math.pow(values.reduce((product, value) => product * Math.max(0.0001, 1 + value), 1), 1 / values.length) - 1;
  if (sd <= 1e-9) {
    return { arithmeticMean: m, geometricMean, stdDev: sd, skewness: 0, kurtosis: 3 };
  }

  const m3 = mean(values.map((value) => (value - m) ** 3));
  const m4 = mean(values.map((value) => (value - m) ** 4));

  return {
    arithmeticMean: m,
    geometricMean,
    stdDev: sd,
    skewness: m3 / sd ** 3,
    kurtosis: m4 / sd ** 4
  };
}

function monthlyReturnFromCloses(previousClose, currentClose) {
  if (!Number.isFinite(previousClose) || !Number.isFinite(currentClose) || previousClose <= 0 || currentClose <= 0) {
    return null;
  }
  return currentClose / previousClose - 1;
}

function monthlyCashReturn(cashRatePct) {
  if (!Number.isFinite(cashRatePct)) return null;
  return cashRatePct / 1200;
}

function aggregateAnnualSeries(rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const monthly = [];
  for (let index = 1; index < sorted.length; index++) {
    const prev = sorted[index - 1];
    const curr = sorted[index];
    const eq = monthlyReturnFromCloses(prev.equityClose, curr.equityClose);
    const bond = monthlyReturnFromCloses(prev.bondClose, curr.bondClose);
    const cash = monthlyCashReturn(curr.cashRatePct);
    if (eq == null || bond == null || cash == null) continue;

    monthly.push({
      year: Number(curr.date.slice(0, 4)),
      equity: eq,
      bond,
      cash
    });
  }

  const byYear = new Map();
  for (const row of monthly) {
    if (!byYear.has(row.year)) byYear.set(row.year, []);
    byYear.get(row.year).push(row);
  }

  const annual = [];
  for (const [year, entries] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    if (entries.length < 12) continue;

    const equity = entries.reduce((acc, item) => acc * (1 + item.equity), 1) - 1;
    const bond = entries.reduce((acc, item) => acc * (1 + item.bond), 1) - 1;
    const cash = entries.reduce((acc, item) => acc * (1 + item.cash), 1) - 1;
    annual.push({ year, equity, bond, cash });
  }

  return annual;
}

function buildMonthlySeries(rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const monthly = [];
  for (let index = 1; index < sorted.length; index++) {
    const prev = sorted[index - 1];
    const curr = sorted[index];
    const eq = monthlyReturnFromCloses(prev.equityClose, curr.equityClose);
    const bond = monthlyReturnFromCloses(prev.bondClose, curr.bondClose);
    const cash = monthlyCashReturn(curr.cashRatePct);
    if (eq == null || bond == null || cash == null) continue;

    monthly.push({
      month: curr.date,
      equity: eq,
      bond,
      cash
    });
  }

  return monthly;
}

function summarizeRegion(annualSeries) {
  const equity = annualSeries.map((row) => row.equity);
  const bond = annualSeries.map((row) => row.bond);
  const cash = annualSeries.map((row) => row.cash);

  return {
    years: annualSeries.map((row) => row.year),
    sampleSize: annualSeries.length,
    coverage: annualSeries.length
      ? `${annualSeries[0].year}-${annualSeries[annualSeries.length - 1].year}`
      : 'n/a',
    assetMoments: {
      equity: moments(equity),
      bond: moments(bond),
      cash: moments(cash)
    }
  };
}

function roundValue(value) {
  return Number(value.toFixed(8));
}

function normalizeAnnualSeries(series) {
  return series.map((row) => ({
    year: row.year,
    equity: roundValue(row.equity),
    bond: roundValue(row.bond),
    cash: roundValue(row.cash)
  }));
}

function normalizeMonthlySeries(series) {
  return series.map((row) => ({
    month: row.month,
    equity: roundValue(row.equity),
    bond: roundValue(row.bond),
    cash: roundValue(row.cash)
  }));
}

function main() {
  const output = {
    generatedAt: new Date().toISOString(),
    methodology: {
      frequency: 'monthly -> annual',
      annualization: 'compound monthly returns within year',
      cash: 'monthly short-rate / 12'
    },
    regions: {}
  };

  for (const [code, config] of Object.entries(REGIONS)) {
    const filePath = path.join(RAW_DIR, config.file);
    const rows = parseRawCsv(filePath);
    const annualSeries = aggregateAnnualSeries(rows);
    const monthlySeries = buildMonthlySeries(rows);
    const summary = summarizeRegion(annualSeries);

    output.regions[code] = {
      code,
      label: config.label,
      ...summary,
      annualSeries: normalizeAnnualSeries(annualSeries),
      monthlySeries: normalizeMonthlySeries(monthlySeries)
    };

    console.log(`[retirement-preprocess] ${code}: ${summary.sampleSize} annual rows (${summary.coverage})`);
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`[retirement-preprocess] Wrote ${OUT_PATH}`);
}

try {
  main();
} catch (error) {
  console.error('[retirement-preprocess] Failed:', error);
  process.exit(1);
}
