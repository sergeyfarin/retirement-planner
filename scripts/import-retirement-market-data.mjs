import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'data', 'retirement', 'raw');

const MIN_START_YEAR = 1960;
const BOND_DURATION_YEARS = 7;
const MIN_REQUIRED_MONTHS = 480;

function encodeStooqSymbol(symbol) {
  return encodeURIComponent(symbol.toLowerCase());
}

async function fetchStooqMonthlyCloses(symbol) {
  const encoded = encodeStooqSymbol(symbol);
  const url = `https://stooq.com/q/d/l/?s=${encoded}&i=m`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${symbol} from Stooq: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= 1 || /^no data/i.test(lines[0])) {
    throw new Error(`No Stooq data for symbol ${symbol}`);
  }

  const result = new Map();
  for (let index = 1; index < lines.length; index++) {
    const parts = lines[index].split(',');
    if (parts.length < 5) continue;
    const date = parts[0]?.trim();
    const close = Number(parts[4]);
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    result.set(date.slice(0, 7), close);
  }

  return result;
}

async function fetchFredSeries(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${seriesId} from FRED: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  if (text.startsWith('<!DOCTYPE html>') || text.startsWith('<html>')) {
    throw new Error(`FRED series ${seriesId} unavailable`);
  }

  const lines = text.trim().split(/\r?\n/);
  const out = new Map();
  for (let index = 1; index < lines.length; index++) {
    const [date, value] = lines[index].split(',');
    const number = Number(value);
    if (!date || !Number.isFinite(number)) continue;
    out.set(date.slice(0, 7), number);
  }
  return out;
}

function filterFromYear(monthMap, startYear) {
  const out = new Map();
  for (const [month, value] of monthMap.entries()) {
    const year = Number(month.slice(0, 4));
    if (Number.isFinite(year) && year >= startYear) {
      out.set(month, value);
    }
  }
  return out;
}

function monthSetUnion(seriesList) {
  return [...new Set(seriesList.flatMap((series) => [...series.keys()]))].sort();
}

function monthlyReturnsFromCloseMap(closeMap) {
  const months = [...closeMap.keys()].sort();
  const out = new Map();
  for (let index = 1; index < months.length; index++) {
    const previous = closeMap.get(months[index - 1]);
    const current = closeMap.get(months[index]);
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0 || current <= 0) continue;
    out.set(months[index], current / previous - 1);
  }
  return out;
}

function buildIndexFromMonthlyReturns(returnMap, base = 100) {
  const months = [...returnMap.keys()].sort();
  const closeMap = new Map();
  let level = base;
  for (const month of months) {
    const monthlyReturn = returnMap.get(month);
    if (!Number.isFinite(monthlyReturn)) continue;
    level *= 1 + monthlyReturn;
    if (Number.isFinite(level) && level > 0) {
      closeMap.set(month, level);
    }
  }
  return closeMap;
}

function blendReturnSeries(components) {
  const months = monthSetUnion(components.map((item) => item.returns));
  const out = new Map();

  for (const month of months) {
    let weightedReturn = 0;
    let weightSum = 0;
    for (const component of components) {
      const value = component.returns.get(month);
      if (!Number.isFinite(value)) continue;
      weightedReturn += component.weight * value;
      weightSum += component.weight;
    }
    if (weightSum > 0) {
      out.set(month, weightedReturn / weightSum);
    }
  }

  return out;
}

function monthlyBondReturnsFromYield(yieldMap, durationYears = BOND_DURATION_YEARS) {
  const months = [...yieldMap.keys()].sort();
  const out = new Map();
  for (let index = 1; index < months.length; index++) {
    const previousYield = yieldMap.get(months[index - 1]);
    const currentYield = yieldMap.get(months[index]);
    if (!Number.isFinite(previousYield) || !Number.isFinite(currentYield)) continue;

    const carry = previousYield / 1200;
    const deltaY = (currentYield - previousYield) / 100;
    const durationEffect = -durationYears * deltaY;
    const convexityEffect = 0.5 * durationYears * (durationYears + 1) * (deltaY * deltaY);

    const monthlyReturn = Math.max(-0.25, Math.min(0.25, carry + durationEffect + convexityEffect));
    out.set(months[index], monthlyReturn);
  }
  return out;
}

function stitchSeries(primaryMap, fallbackMap) {
  const out = new Map(fallbackMap);
  for (const [month, value] of primaryMap.entries()) {
    out.set(month, value);
  }
  return out;
}

function avgSeries(seriesList) {
  const months = monthSetUnion(seriesList);
  const out = new Map();
  for (const month of months) {
    const values = seriesList.map((series) => series.get(month)).filter((value) => Number.isFinite(value));
    if (values.length === 0) continue;
    out.set(month, values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  return out;
}

function mergeRows(equityCloseMap, bondCloseMap, cashRateMap) {
  const months = monthSetUnion([equityCloseMap, bondCloseMap, cashRateMap]);
  const rows = [];
  for (const month of months) {
    const equityClose = equityCloseMap.get(month);
    const bondClose = bondCloseMap.get(month);
    const cashRatePct = cashRateMap.get(month);
    if (!Number.isFinite(equityClose) || !Number.isFinite(bondClose) || !Number.isFinite(cashRatePct)) continue;
    rows.push({ month, equityClose, bondClose, cashRatePct });
  }
  return rows;
}

function toCsv(regionCode, sourceLines, rows) {
  const lines = [];
  lines.push(`# region=${regionCode}`);
  for (const line of sourceLines) {
    lines.push(`# ${line}`);
  }
  lines.push('date,equity_close,bond_close,cash_rate_pct');
  for (const row of rows) {
    lines.push(`${row.month},${row.equityClose},${row.bondClose},${row.cashRatePct}`);
  }
  return `${lines.join('\n')}\n`;
}

async function buildUsdRegion() {
  const [spxClose, us10yYield, usCashRate] = await Promise.all([
    fetchStooqMonthlyCloses('^spx'),
    fetchFredSeries('GS10'),
    fetchFredSeries('TB3MS')
  ]);

  const bondReturns = monthlyBondReturnsFromYield(us10yYield);
  const bondClose = buildIndexFromMonthlyReturns(bondReturns);
  return {
    rows: mergeRows(filterFromYear(spxClose, MIN_START_YEAR), filterFromYear(bondClose, MIN_START_YEAR), filterFromYear(usCashRate, MIN_START_YEAR)),
    sourceLines: [
      'equity_source=S&P 500 index proxy (^SPX, Stooq monthly)',
      'bond_source=synthetic US 10Y total return from GS10 (FRED) with duration 7y',
      'cash_source=US 3m T-bill (TB3MS, FRED)'
    ]
  };
}

async function buildGbpRegion() {
  const [ukxClose, uk10yYield, ukCashRate] = await Promise.all([
    fetchStooqMonthlyCloses('^ukx'),
    fetchFredSeries('IRLTLT01GBM156N'),
    fetchFredSeries('IR3TIB01GBM156N')
  ]);

  const bondReturns = monthlyBondReturnsFromYield(uk10yYield);
  const bondClose = buildIndexFromMonthlyReturns(bondReturns);
  return {
    rows: mergeRows(filterFromYear(ukxClose, MIN_START_YEAR), filterFromYear(bondClose, MIN_START_YEAR), filterFromYear(ukCashRate, MIN_START_YEAR)),
    sourceLines: [
      'equity_source=FTSE 100 index proxy (^UKX, Stooq monthly)',
      'bond_source=synthetic UK 10Y total return from IRLTLT01GBM156N (FRED) with duration 7y',
      'cash_source=UK 3m interbank rate IR3TIB01GBM156N (FRED)'
    ]
  };
}

async function buildEurRegion() {
  const [daxClose, cacClose, de10yYield, deCashRate, ezCashRate] = await Promise.all([
    fetchStooqMonthlyCloses('^dax'),
    fetchStooqMonthlyCloses('^cac'),
    fetchFredSeries('IRLTLT01DEM156N'),
    fetchFredSeries('IR3TIB01DEM156N'),
    fetchFredSeries('IR3TIB01EZM156N')
  ]);

  const daxReturns = monthlyReturnsFromCloseMap(daxClose);
  const cacReturns = monthlyReturnsFromCloseMap(cacClose);
  const eurEquityReturns = blendReturnSeries([
    { returns: daxReturns, weight: 0.6 },
    { returns: cacReturns, weight: 0.4 }
  ]);
  const eurEquityClose = buildIndexFromMonthlyReturns(eurEquityReturns);

  const bondReturns = monthlyBondReturnsFromYield(de10yYield);
  const bondClose = buildIndexFromMonthlyReturns(bondReturns);

  const eurCashRate = stitchSeries(ezCashRate, deCashRate);

  return {
    rows: mergeRows(filterFromYear(eurEquityClose, MIN_START_YEAR), filterFromYear(bondClose, MIN_START_YEAR), filterFromYear(eurCashRate, MIN_START_YEAR)),
    sourceLines: [
      'equity_source=synthetic Euro equity index from ^DAX (60%) + ^CAC (40%), Stooq monthly',
      'bond_source=synthetic EUR 10Y total return from Germany 10Y IRLTLT01DEM156N (FRED) with duration 7y',
      'cash_source=IR3TIB01EZM156N (FRED) stitched with IR3TIB01DEM156N pre-euro'
    ]
  };
}

async function buildWorldRegion() {
  const [spxClose, ukxClose, daxClose, us10yYield, uk10yYield, de10yYield, usCashRate, ukCashRate, deCashRate, ezCashRate] = await Promise.all([
    fetchStooqMonthlyCloses('^spx'),
    fetchStooqMonthlyCloses('^ukx'),
    fetchStooqMonthlyCloses('^dax'),
    fetchFredSeries('GS10'),
    fetchFredSeries('IRLTLT01GBM156N'),
    fetchFredSeries('IRLTLT01DEM156N'),
    fetchFredSeries('TB3MS'),
    fetchFredSeries('IR3TIB01GBM156N'),
    fetchFredSeries('IR3TIB01DEM156N'),
    fetchFredSeries('IR3TIB01EZM156N')
  ]);

  const worldEquityReturns = blendReturnSeries([
    { returns: monthlyReturnsFromCloseMap(spxClose), weight: 0.55 },
    { returns: monthlyReturnsFromCloseMap(ukxClose), weight: 0.2 },
    { returns: monthlyReturnsFromCloseMap(daxClose), weight: 0.25 }
  ]);
  const worldEquityClose = buildIndexFromMonthlyReturns(worldEquityReturns);

  const worldBondReturns = blendReturnSeries([
    { returns: monthlyBondReturnsFromYield(us10yYield), weight: 0.5 },
    { returns: monthlyBondReturnsFromYield(uk10yYield), weight: 0.2 },
    { returns: monthlyBondReturnsFromYield(de10yYield), weight: 0.3 }
  ]);
  const worldBondClose = buildIndexFromMonthlyReturns(worldBondReturns);

  const eurCashRate = stitchSeries(ezCashRate, deCashRate);
  const worldCashRate = avgSeries([usCashRate, ukCashRate, eurCashRate]);

  return {
    rows: mergeRows(filterFromYear(worldEquityClose, MIN_START_YEAR), filterFromYear(worldBondClose, MIN_START_YEAR), filterFromYear(worldCashRate, MIN_START_YEAR)),
    sourceLines: [
      'equity_source=synthetic World equity from ^SPX (55%) + ^UKX (20%) + ^DAX (25%), Stooq monthly',
      'bond_source=synthetic World bond from US/UK/DE 10Y yields with duration 7y, FRED',
      'cash_source=average of US TB3MS + UK 3m + EUR 3m (stitched pre/post euro), FRED'
    ]
  };
}

async function importRegion(regionCode) {
  if (regionCode === 'USD') return buildUsdRegion();
  if (regionCode === 'GBP') return buildGbpRegion();
  if (regionCode === 'EUR') return buildEurRegion();
  if (regionCode === 'WORLD') return buildWorldRegion();
  throw new Error(`Unsupported region: ${regionCode}`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const regionToFile = {
    WORLD: 'world.csv',
    USD: 'usd.csv',
    GBP: 'gbp.csv',
    EUR: 'eur.csv'
  };

  for (const regionCode of Object.keys(regionToFile)) {
    const regionData = await importRegion(regionCode);
    const rows = regionData.rows;
    if (rows.length < MIN_REQUIRED_MONTHS) {
      throw new Error(`Insufficient monthly history for ${regionCode}: ${rows.length} rows`);
    }

    const csv = toCsv(regionCode, regionData.sourceLines, rows);
    const filePath = path.join(outDir, regionToFile[regionCode]);
    writeFileSync(filePath, csv, 'utf8');
    console.log(`[retirement-import] ${regionCode}: ${rows.length} rows (${rows[0].month} -> ${rows[rows.length - 1].month}) -> ${filePath}`);
  }
}

main().catch((error) => {
  console.error('[retirement-import] Failed:', error);
  process.exit(1);
});
