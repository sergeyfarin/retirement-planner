import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.join(projectRoot, 'data', 'retirement', 'raw');

const MIN_START_YEAR = 1960;
const BOND_DURATION_YEARS = 7;
const MIN_REQUIRED_MONTHS = 480;

// NOTE: ^SPX, ^UKX, ^NKX and ^HSI are PRICE indices; the preprocess script
// (preprocess-retirement-market-data.mjs) adds decade-level synthetic dividend
// yields for USD, GBP and WORLD. Only the CAC leg of the EUR proxy gets its
// dividend adjustment here. If any source is switched to total-return, update
// DIVIDEND_YIELD_SCHEDULES in the preprocess script to avoid double counting.

function encodeStooqSymbol(symbol) {
	return encodeURIComponent(symbol.toLowerCase());
}

async function fetchStooqMonthlyCloses(symbol) {
	const encoded = encodeStooqSymbol(symbol);
	const url = `https://stooq.com/q/d/l/?s=${encoded}&i=m`;
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${symbol} from Stooq: ${response.status} ${response.statusText}`
		);
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
		throw new Error(
			`Failed to fetch ${seriesId} from FRED: ${response.status} ${response.statusText}`
		);
	}

	const text = await response.text();
	if (text.startsWith('<!DOCTYPE html>') || text.startsWith('<html>')) {
		throw new Error(`FRED series ${seriesId} unavailable`);
	}

	const lines = text.trim().split(/\r?\n/);
	const out = new Map();
	for (let index = 1; index < lines.length; index++) {
		const [date, value] = lines[index].split(',');
		const trimmed = value?.trim();
		// FRED marks missing observations with an empty field or ".". Number('') is 0, so
		// guard explicitly — otherwise a missing month silently becomes a 0 level/rate.
		if (!date || !trimmed || trimmed === '.') continue;
		const number = Number(trimmed);
		if (!Number.isFinite(number)) continue;
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
		if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0 || current <= 0)
			continue;
		out.set(months[index], current / previous - 1);
	}
	return out;
}

function getPrevMonth(monthStr) {
	const year = parseInt(monthStr.slice(0, 4), 10);
	const month = parseInt(monthStr.slice(5, 7), 10);
	if (month === 1) {
		return `${year - 1}-12`;
	} else {
		const m = month - 1;
		return `${year}-${m < 10 ? '0' : ''}${m}`;
	}
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
		const values = seriesList
			.map((series) => series.get(month))
			.filter((value) => Number.isFinite(value));
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
		if (
			!Number.isFinite(equityClose) ||
			!Number.isFinite(bondClose) ||
			!Number.isFinite(cashRatePct)
		)
			continue;
		rows.push({ month, equityClose, bondClose, cashRatePct });
	}
	return rows;
}

const RAW_CSV_HEADER = 'date,equity_close,bond_close,cash_rate_pct,cpi_index,bond_yield_pct';

function toCsv(regionCode, sourceLines, rows) {
	const lines = [];
	lines.push(`# region=${regionCode}`);
	for (const line of sourceLines) {
		lines.push(`# ${line}`);
	}
	lines.push(RAW_CSV_HEADER);
	for (const row of rows) {
		const cpi = Number.isFinite(row.cpiIndex) ? row.cpiIndex : '';
		const bondYield = Number.isFinite(row.bondYieldPct) ? row.bondYieldPct : '';
		lines.push(
			`${row.month},${row.equityClose},${row.bondClose},${row.cashRatePct},${cpi},${bondYield}`
		);
	}
	return `${lines.join('\n')}\n`;
}

// ─── Regional CPI (for joint return/inflation bootstrapping, TODO 0.4) ─────────
// Each region needs a price index denominated in the same currency as its returns.
// WORLD returns are USD-converted, so US CPI is the correct deflator for them.
const CPI_SOURCES = {
	USD: { primary: 'CPIAUCSL', label: 'US CPI-U (CPIAUCSL, FRED)' },
	GBP: { primary: 'GBRCPIALLMINMEI', label: 'UK CPI (GBRCPIALLMINMEI, FRED)' },
	// Euro-area HICP only starts 1996-12; stitch German CPI before that.
	EUR: {
		primary: 'CP0000EZ19M086NEST',
		fallback: 'DEUCPIALLMINMEI',
		label: 'Euro-area HICP (CP0000EZ19M086NEST) stitched with German CPI (DEUCPIALLMINMEI) pre-1997'
	},
	WORLD: {
		primary: 'CPIAUCSL',
		label: 'US CPI-U (CPIAUCSL, FRED) — WORLD returns are USD-denominated'
	}
};

// Long-bond yield level per region. The starting yield is the single best predictor of
// a bond portfolio's forward return, so it anchors the "current conditions" preset.
// WORLD uses the same 50/20/30 US/UK/DE weighting as its bond return blend.
const BOND_YIELD_SOURCES = {
	USD: { series: [{ id: 'GS10', weight: 1 }], label: 'US 10Y (GS10, FRED)' },
	GBP: { series: [{ id: 'IRLTLT01GBM156N', weight: 1 }], label: 'UK 10Y (IRLTLT01GBM156N, FRED)' },
	EUR: {
		series: [{ id: 'IRLTLT01DEM156N', weight: 1 }],
		label: 'German 10Y (IRLTLT01DEM156N, FRED)'
	},
	WORLD: {
		series: [
			{ id: 'GS10', weight: 0.5 },
			{ id: 'IRLTLT01GBM156N', weight: 0.2 },
			{ id: 'IRLTLT01DEM156N', weight: 0.3 }
		],
		label: 'weighted 10Y yields: US 50% / UK 20% / DE 30% (FRED)'
	}
};

async function fetchRegionBondYield(regionCode) {
	const config = BOND_YIELD_SOURCES[regionCode];
	if (!config) return { series: new Map(), label: 'none' };
	const fetched = await Promise.all(
		config.series.map(async (part) => ({
			weight: part.weight,
			values: await fetchFredSeries(part.id)
		}))
	);
	const months = monthSetUnion(fetched.map((part) => part.values));
	const out = new Map();
	for (const month of months) {
		let weighted = 0;
		let weightSum = 0;
		for (const part of fetched) {
			const value = part.values.get(month);
			if (!Number.isFinite(value)) continue;
			weighted += part.weight * value;
			weightSum += part.weight;
		}
		if (weightSum > 0) out.set(month, weighted / weightSum);
	}
	return { series: out, label: config.label };
}

async function fetchRegionCpi(regionCode) {
	const config = CPI_SOURCES[regionCode];
	if (!config) return { series: new Map(), label: 'none' };
	const primary = await fetchFredSeries(config.primary);
	if (!config.fallback) return { series: primary, label: config.label };
	const fallback = await fetchFredSeries(config.fallback);
	// Rescale the fallback onto the primary's level at the first overlapping month so
	// the stitched index has no artificial jump (only ratios matter downstream).
	const overlap = [...primary.keys()].filter((month) => fallback.has(month)).sort();
	let scaled = fallback;
	if (overlap.length > 0) {
		const anchor = overlap[0];
		const ratio = primary.get(anchor) / fallback.get(anchor);
		if (Number.isFinite(ratio) && ratio > 0) {
			scaled = new Map([...fallback.entries()].map(([month, value]) => [month, value * ratio]));
		}
	}
	return { series: stitchSeries(primary, scaled), label: config.label };
}

function parseExistingCsv(filePath) {
	const text = readFileSync(filePath, 'utf8');
	const lines = text.split(/\r?\n/).filter(Boolean);
	const comments = lines.filter((line) => line.startsWith('#'));
	const dataLines = lines.filter((line) => !line.startsWith('#'));
	const header = dataLines[0].split(',').map((item) => item.trim());
	const rows = dataLines.slice(1).map((line) => {
		const parts = line.split(',');
		const row = {};
		header.forEach((key, index) => (row[key] = parts[index]));
		return row;
	});
	return { comments, rows };
}

// `--merge-rates` adds/refreshes only the derived rate columns (cpi_index,
// bond_yield_pct) on the existing raw CSVs, leaving the committed market-data vintage
// byte-for-byte intact. Use a full import to refresh prices themselves.
async function mergeRatesIntoExistingCsvs(regionToFile) {
	for (const [regionCode, fileName] of Object.entries(regionToFile)) {
		const filePath = path.join(outDir, fileName);
		const { comments, rows } = parseExistingCsv(filePath);
		const { series: cpi, label: cpiLabel } = await fetchRegionCpi(regionCode);
		const { series: bondYield, label: yieldLabel } = await fetchRegionBondYield(regionCode);

		const keptComments = comments.filter(
			(line) => !line.startsWith('# cpi_source=') && !line.startsWith('# bond_yield_source=')
		);
		keptComments.push(`# cpi_source=${cpiLabel}`);
		keptComments.push(`# bond_yield_source=${yieldLabel}`);

		const lines = [...keptComments, RAW_CSV_HEADER];
		let withCpi = 0;
		let withYield = 0;
		for (const row of rows) {
			const cpiValue = cpi.get(row.date);
			const yieldValue = bondYield.get(row.date);
			if (Number.isFinite(cpiValue)) withCpi++;
			if (Number.isFinite(yieldValue)) withYield++;
			lines.push(
				[
					row.date,
					row.equity_close,
					row.bond_close,
					row.cash_rate_pct,
					Number.isFinite(cpiValue) ? cpiValue : '',
					Number.isFinite(yieldValue) ? yieldValue : ''
				].join(',')
			);
		}
		writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
		console.log(
			`[retirement-import] ${regionCode}: cpi_index ${withCpi}/${rows.length}, bond_yield_pct ${withYield}/${rows.length} -> ${filePath}`
		);
	}
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
		rows: mergeRows(
			filterFromYear(spxClose, MIN_START_YEAR),
			filterFromYear(bondClose, MIN_START_YEAR),
			filterFromYear(usCashRate, MIN_START_YEAR)
		),
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
		rows: mergeRows(
			filterFromYear(ukxClose, MIN_START_YEAR),
			filterFromYear(bondClose, MIN_START_YEAR),
			filterFromYear(ukCashRate, MIN_START_YEAR)
		),
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

	// Apply a 3.0% synthetic annual dividend yield to the CAC 40 to approximate Total Return
	const monthlyCacDiv = Math.pow(1.03, 1 / 12) - 1;
	const adjustedCacReturns = new Map();
	for (const [month, ret] of cacReturns.entries()) {
		adjustedCacReturns.set(month, ret + monthlyCacDiv);
	}

	const eurEquityReturns = blendReturnSeries([
		{ returns: daxReturns, weight: 0.6 },
		{ returns: adjustedCacReturns, weight: 0.4 }
	]);
	const eurEquityClose = buildIndexFromMonthlyReturns(eurEquityReturns);

	const bondReturns = monthlyBondReturnsFromYield(de10yYield);
	const bondClose = buildIndexFromMonthlyReturns(bondReturns);

	const eurCashRate = stitchSeries(ezCashRate, deCashRate);

	return {
		rows: mergeRows(
			filterFromYear(eurEquityClose, MIN_START_YEAR),
			filterFromYear(bondClose, MIN_START_YEAR),
			filterFromYear(eurCashRate, MIN_START_YEAR)
		),
		sourceLines: [
			'equity_source=synthetic Euro equity index from ^DAX (60%) + ^CAC (40% + 3% synthetic annual div), Stooq monthly',
			'bond_source=synthetic EUR 10Y total return from Germany 10Y IRLTLT01DEM156N (FRED) with duration 7y',
			'cash_source=IR3TIB01EZM156N (FRED) stitched with IR3TIB01DEM156N pre-euro'
		]
	};
}

async function buildWorldRegion() {
	const [
		spxClose,
		ukxClose,
		daxClose,
		cacClose,
		nkxClose,
		hsiClose,
		us10yYield,
		uk10yYield,
		de10yYield,
		usCashRate,
		ukCashRate,
		deCashRate,
		ezCashRate,
		usdJpy,
		usdHkd
	] = await Promise.all([
		fetchStooqMonthlyCloses('^spx'),
		fetchStooqMonthlyCloses('^ukx'),
		fetchStooqMonthlyCloses('^dax'),
		fetchStooqMonthlyCloses('^cac'),
		fetchStooqMonthlyCloses('^nkx'),
		fetchStooqMonthlyCloses('^hsi'),
		fetchFredSeries('GS10'),
		fetchFredSeries('IRLTLT01GBM156N'),
		fetchFredSeries('IRLTLT01DEM156N'),
		fetchFredSeries('TB3MS'),
		fetchFredSeries('IR3TIB01GBM156N'),
		fetchFredSeries('IR3TIB01DEM156N'),
		fetchFredSeries('IR3TIB01EZM156N'),
		fetchFredSeries('EXJPUS'), // JPY per USD
		fetchFredSeries('EXHKUS') // HKD per USD
	]);

	// Process EUR proxy (DAX + CAC TR)
	const daxReturns = monthlyReturnsFromCloseMap(daxClose);
	const cacReturns = monthlyReturnsFromCloseMap(cacClose);
	const monthlyCacDiv = Math.pow(1.03, 1 / 12) - 1;
	const adjustedCacReturns = new Map();
	for (const [month, ret] of cacReturns.entries()) {
		adjustedCacReturns.set(month, ret + monthlyCacDiv);
	}
	const eurEquityReturns = blendReturnSeries([
		{ returns: daxReturns, weight: 0.6 },
		{ returns: adjustedCacReturns, weight: 0.4 }
	]);

	// Process Japan (Nikkei) to USD
	const nkxLocalReturns = monthlyReturnsFromCloseMap(nkxClose);
	const nkxUsdReturns = new Map();
	for (const [month, localRet] of nkxLocalReturns.entries()) {
		// Before 1971, JPY was pegged to USD at 360
		let prevFx = usdJpy.get(getPrevMonth(month)) || 360;
		let currFx = usdJpy.get(month) || 360;
		// Return in USD = (1 + local_return) * (prevFx / currFx) - 1
		// (If JPY per USD goes down, JPY strengthened, US investor gains)
		let fxReturn = prevFx / currFx;
		nkxUsdReturns.set(month, (1 + localRet) * fxReturn - 1);
	}

	// Process Asia/EM (Hang Seng) to USD
	const hsiLocalReturns = monthlyReturnsFromCloseMap(hsiClose);
	const hsiUsdReturns = new Map();
	for (const [month, localRet] of hsiLocalReturns.entries()) {
		// Before 1983 peg, HKD hovered around 5-6, but for simplicity assuming fixed 5.7 if missing
		let prevFx = usdHkd.get(getPrevMonth(month)) || 5.7;
		let currFx = usdHkd.get(month) || 5.7;
		let fxReturn = prevFx / currFx;
		hsiUsdReturns.set(month, (1 + localRet) * fxReturn - 1);
	}

	// Option D backfill: Hang Seng starts in 1969. Backfill with Nikkei USD returns.
	const emAsiaReturns = stitchSeries(hsiUsdReturns, nkxUsdReturns);

	// Option D World Blend
	const worldEquityReturns = blendReturnSeries([
		{ returns: monthlyReturnsFromCloseMap(spxClose), weight: 0.55 },
		{ returns: eurEquityReturns, weight: 0.15 },
		{ returns: monthlyReturnsFromCloseMap(ukxClose), weight: 0.05 },
		{ returns: nkxUsdReturns, weight: 0.15 },
		{ returns: emAsiaReturns, weight: 0.1 }
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
		rows: mergeRows(
			filterFromYear(worldEquityClose, MIN_START_YEAR),
			filterFromYear(worldBondClose, MIN_START_YEAR),
			filterFromYear(worldCashRate, MIN_START_YEAR)
		),
		sourceLines: [
			'equity_source=synthetic Option D World Blend: US(55%) + EUR(15%) + UK(5%) + Japan(15%) + AsiaEM(10%, HSI backfilled w/ NKX), Stooq monthly, USD adjusted',
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

	if (process.argv.includes('--merge-rates')) {
		await mergeRatesIntoExistingCsvs(regionToFile);
		return;
	}

	for (const regionCode of Object.keys(regionToFile)) {
		const regionData = await importRegion(regionCode);
		const rows = regionData.rows;
		if (rows.length < MIN_REQUIRED_MONTHS) {
			throw new Error(`Insufficient monthly history for ${regionCode}: ${rows.length} rows`);
		}

		const { series: cpi, label: cpiLabel } = await fetchRegionCpi(regionCode);
		const { series: bondYield, label: yieldLabel } = await fetchRegionBondYield(regionCode);
		for (const row of rows) {
			row.cpiIndex = cpi.get(row.month);
			row.bondYieldPct = bondYield.get(row.month);
		}

		const csv = toCsv(
			regionCode,
			[...regionData.sourceLines, `cpi_source=${cpiLabel}`, `bond_yield_source=${yieldLabel}`],
			rows
		);
		const filePath = path.join(outDir, regionToFile[regionCode]);
		writeFileSync(filePath, csv, 'utf8');
		console.log(
			`[retirement-import] ${regionCode}: ${rows.length} rows (${rows[0].month} -> ${rows[rows.length - 1].month}) -> ${filePath}`
		);
	}
}

main().catch((error) => {
	console.error('[retirement-import] Failed:', error);
	process.exit(1);
});
