import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const RAW_DIR = path.join(projectRoot, 'data', 'retirement', 'raw');
// SvelteKit serves `static/` (kit.files.assets default), and the planner fetches
// `/assets/historical-market-data.json`. Writing anywhere else means the pipeline's
// output never reaches the running app — which is exactly what happened while this
// pointed at `public/assets/retirement/`.
const OUT_PATH = path.join(projectRoot, 'static', 'assets', 'historical-market-data.json');

const REGIONS = {
	WORLD: { file: 'world.csv', label: 'World' },
	USD: { file: 'usd.csv', label: 'United States' },
	GBP: { file: 'gbp.csv', label: 'United Kingdom' },
	EUR: { file: 'eur.csv', label: 'Euro area' }
};

// ─── Synthetic dividend adjustment ────────────────────────────────────────────
// The raw equity closes for USD (^SPX), GBP (^UKX) and the non-EUR components of
// WORLD (^SPX/^UKX/^NKX/^HSI) are PRICE indices — dividends are not included.
// The EUR proxy is already ~total-return at import time (DAX is TR by construction;
// CAC gets +3%/yr synthetic dividends in import-retirement-market-data.mjs), so it
// gets no adjustment here. If the import script is ever switched to total-return
// sources, remove the corresponding schedule below to avoid double counting.
//
// Decade-level average dividend yields (annual %), rounded approximations from:
//   US — Shiller S&P 500 data (multpl.com/s-p-500-dividend-yield)
//   UK — Barclays Equity Gilt Study ranges for FT All-Share / FTSE 100
//   WORLD — component-weighted blend of US(55%)/UK(5%)/JP(15%)/HK-EM(10%) yields;
//           the EUR 15% share contributes 0 because it is already total-return.
//           (JP: ~4% in the 1960s falling below 1% in the bubble era, recovering to
//            ~2% by the 2020s; HK: ~3.3–4% throughout.)
const DIVIDEND_YIELD_SCHEDULES = {
	USD: { 1960: 3.1, 1970: 4.1, 1980: 4.3, 1990: 2.5, 2000: 1.8, 2010: 2.0, 2020: 1.5 },
	GBP: { 1960: 5.0, 1970: 5.5, 1980: 4.5, 1990: 3.8, 2000: 3.3, 2010: 3.8, 2020: 3.7 },
	WORLD: { 1960: 2.9, 1970: 3.2, 1980: 3.1, 1990: 2.0, 2000: 1.7, 2010: 1.9, 2020: 1.7 },
	EUR: null
};

function syntheticMonthlyDividend(regionCode, dateStr) {
	const schedule = DIVIDEND_YIELD_SCHEDULES[regionCode];
	if (!schedule) return 0;
	const year = Number(dateStr.slice(0, 4));
	if (!Number.isFinite(year)) return 0;
	const decade = Math.min(2020, Math.max(1960, Math.floor(year / 10) * 10));
	const annualYieldPct = schedule[decade];
	if (!Number.isFinite(annualYieldPct)) return 0;
	return Math.pow(1 + annualYieldPct / 100, 1 / 12) - 1;
}

// Fail loud on mid-series gaps: a missing month would silently shift every
// downstream 12-month aggregation window (different start dates across regions
// are fine; holes are not).
function assertContiguousMonths(rows, regionCode) {
	const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
	for (let index = 1; index < sorted.length; index++) {
		const prev = sorted[index - 1].date;
		const curr = sorted[index].date;
		const prevYear = Number(prev.slice(0, 4));
		const prevMonth = Number(prev.slice(5, 7));
		const expected =
			prevMonth === 12
				? `${prevYear + 1}-01`
				: `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`;
		if (curr !== expected) {
			throw new Error(
				`[retirement-preprocess] ${regionCode}: month gap between ${prev} and ${curr} (expected ${expected})`
			);
		}
	}
}

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
	const cpiIndex = header.indexOf('cpi_index');
	const yieldIndex = header.indexOf('bond_yield_pct');
	if (dateIndex < 0 || equityIndex < 0 || bondIndex < 0 || cashIndex < 0) {
		throw new Error(`Invalid CSV header in ${filePath}`);
	}

	return dataLines
		.slice(1)
		.map((line) => {
			const parts = line.split(',');
			const date = parts[dateIndex]?.trim();
			const equityClose = Number(parts[equityIndex]);
			const bondClose = Number(parts[bondIndex]);
			const cashRatePct = Number(parts[cashIndex]);
			const rawCpi = cpiIndex >= 0 ? parts[cpiIndex]?.trim() : '';
			const cpiLevel = rawCpi ? Number(rawCpi) : NaN;
			const rawYield = yieldIndex >= 0 ? parts[yieldIndex]?.trim() : '';
			const bondYieldPct = rawYield ? Number(rawYield) : NaN;
			return { date, equityClose, bondClose, cashRatePct, cpiLevel, bondYieldPct };
		})
		.filter(
			(row) =>
				row.date &&
				Number.isFinite(row.equityClose) &&
				Number.isFinite(row.bondClose) &&
				Number.isFinite(row.cashRatePct)
		);
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
	const geometricMean =
		Math.pow(
			values.reduce((product, value) => product * Math.max(0.0001, 1 + value), 1),
			1 / values.length
		) - 1;
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
	if (
		!Number.isFinite(previousClose) ||
		!Number.isFinite(currentClose) ||
		previousClose <= 0 ||
		currentClose <= 0
	) {
		return null;
	}
	return currentClose / previousClose - 1;
}

function monthlyCashReturn(cashRatePct) {
	if (!Number.isFinite(cashRatePct)) return null;
	return cashRatePct / 1200;
}

function buildMonthlyReturnRows(rows, regionCode) {
	const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
	const monthly = [];
	for (let index = 1; index < sorted.length; index++) {
		const prev = sorted[index - 1];
		const curr = sorted[index];
		const priceReturn = monthlyReturnFromCloses(prev.equityClose, curr.equityClose);
		const bond = monthlyReturnFromCloses(prev.bondClose, curr.bondClose);
		const cash = monthlyCashReturn(curr.cashRatePct);
		if (priceReturn == null || bond == null || cash == null) continue;

		// Realized monthly inflation from the regional CPI index, kept on the same row as
		// the returns so the engine can bootstrap (return, inflation) jointly (TODO 0.4).
		const inflation = monthlyReturnFromCloses(prev.cpiLevel, curr.cpiLevel);

		monthly.push({
			month: curr.date,
			year: Number(curr.date.slice(0, 4)),
			equity: priceReturn + syntheticMonthlyDividend(regionCode, curr.date),
			bond,
			cash,
			inflation
		});
	}

	return monthly;
}

// Statistical agencies occasionally skip a month (e.g. US CPI was not published for
// 2025-10 during the federal shutdown). A short interior hole is filled by spreading the
// price change across the gap geometrically, which preserves the total change over the
// window and yields a sensible monthly path. Longer holes are a data problem, not
// something to paper over, so they still throw.
const MAX_INTERPOLATED_CPI_GAP = 3;

function fillShortCpiGaps(rows, regionCode) {
	const filled = [];
	for (let index = 0; index < rows.length; index++) {
		if (Number.isFinite(rows[index].cpiLevel)) continue;
		const previous = index - 1;
		let next = index;
		while (next < rows.length && !Number.isFinite(rows[next].cpiLevel)) next++;
		// Leading or trailing holes are handled by trimming, not interpolation.
		if (previous < 0 || next >= rows.length) continue;
		const gapLength = next - index;
		if (gapLength > MAX_INTERPOLATED_CPI_GAP) {
			throw new Error(
				`${regionCode}: CPI gap of ${gapLength} months at ${rows[index].date} exceeds the ${MAX_INTERPOLATED_CPI_GAP}-month interpolation limit`
			);
		}
		const startLevel = rows[previous].cpiLevel;
		const endLevel = rows[next].cpiLevel;
		const steps = next - previous;
		for (let offset = 1; offset < steps; offset++) {
			rows[previous + offset].cpiLevel = startLevel * (endLevel / startLevel) ** (offset / steps);
			filled.push(rows[previous + offset].date);
		}
		index = next - 1;
	}
	if (filled.length > 0) {
		console.log(
			`[retirement-preprocess] ${regionCode}: interpolated CPI for ${filled.length} missing month(s): ${filled.join(', ')}`
		);
	}
	return rows;
}

// The joint bootstrap needs a contiguous run of months where BOTH returns and inflation
// exist. CPI series can lag the market data by a few months, so trim the tail (and any
// leading gap) rather than emitting rows the engine would have to special-case.
function trimToInflationCoverage(monthlyRows) {
	const firstWithCpi = monthlyRows.findIndex((row) => row.inflation != null);
	if (firstWithCpi < 0) return { rows: [], trimmedLeading: 0, trimmedTrailing: monthlyRows.length };
	let lastWithCpi = monthlyRows.length - 1;
	while (lastWithCpi >= 0 && monthlyRows[lastWithCpi].inflation == null) lastWithCpi--;
	const slice = monthlyRows.slice(firstWithCpi, lastWithCpi + 1);
	if (slice.some((row) => row.inflation == null)) {
		throw new Error('CPI series has an interior gap; joint bootstrap requires contiguous coverage');
	}
	return {
		rows: slice,
		trimmedLeading: firstWithCpi,
		trimmedTrailing: monthlyRows.length - 1 - lastWithCpi
	};
}

function aggregateAnnualSeries(monthlyRows) {
	const byYear = new Map();
	for (const row of monthlyRows) {
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

// Latest observed yield levels, used by the "current conditions" preset. Starting yield
// is a far better predictor of forward bond/cash returns than a multi-decade average,
// which is standard capital-market-assumption practice.
function latestYieldConditions(rows) {
	let bondYieldPct = null;
	let cashRatePct = null;
	let asOf = null;
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		if (bondYieldPct == null && Number.isFinite(row.bondYieldPct)) {
			bondYieldPct = row.bondYieldPct;
			asOf = asOf ?? row.date;
		}
		if (cashRatePct == null && Number.isFinite(row.cashRatePct)) {
			cashRatePct = row.cashRatePct;
			asOf = asOf ?? row.date;
		}
		if (bondYieldPct != null && cashRatePct != null) break;
	}
	if (bondYieldPct == null || cashRatePct == null) return null;
	return {
		asOf,
		bondYield: roundValue(bondYieldPct / 100),
		cashRate: roundValue(cashRatePct / 100)
	};
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
		cash: roundValue(row.cash),
		...(row.inflation == null ? {} : { inflation: roundValue(row.inflation) })
	}));
}

function main() {
	const output = {
		generatedAt: new Date().toISOString(),
		methodology: {
			frequency: 'monthly -> annual',
			annualization: 'compound monthly returns within year',
			cash: 'monthly short-rate / 12',
			dividends:
				'price-only equity series (USD, GBP, WORLD non-EUR components) adjusted with decade-level synthetic dividend yields; EUR proxy already total-return at import',
			currencyConversion:
				'WORLD foreign equity legs converted to USD before blending; GBP via EXUSUK, EUR via EXGEUS/EXUSEU, Japan via EXJPUS, Hong Kong via EXHKUS; fixed pre-1971 GBP/DEM parities fill early history',
			inflation:
				'realized monthly regional CPI change stored per month alongside returns, enabling joint (return, inflation) block bootstrapping; monthly series trimmed to CPI coverage'
		},
		regions: {}
	};

	for (const [code, config] of Object.entries(REGIONS)) {
		const filePath = path.join(RAW_DIR, config.file);
		const rows = parseRawCsv(filePath);
		assertContiguousMonths(rows, code);
		fillShortCpiGaps(rows, code);
		const monthlyRows = buildMonthlyReturnRows(rows, code);
		// Annual moments keep the full market history; only the monthly series (which drives
		// the joint bootstrap) is trimmed to where CPI is also available.
		const annualSeries = aggregateAnnualSeries(monthlyRows);
		const {
			rows: monthlySeries,
			trimmedLeading,
			trimmedTrailing
		} = trimToInflationCoverage(monthlyRows);
		const summary = summarizeRegion(annualSeries);
		const inflationCoverage = monthlySeries.length
			? `${monthlySeries[0].month}..${monthlySeries[monthlySeries.length - 1].month}`
			: 'none';
		if (trimmedLeading || trimmedTrailing) {
			console.log(
				`[retirement-preprocess] ${code}: monthly series trimmed to CPI coverage (${trimmedLeading} leading, ${trimmedTrailing} trailing months dropped)`
			);
		}

		output.regions[code] = {
			code,
			label: config.label,
			...summary,
			annualCoverage: summary.coverage,
			monthlyCoverage: inflationCoverage,
			currentConditions: latestYieldConditions(rows),
			annualSeries: normalizeAnnualSeries(annualSeries),
			monthlySeries: normalizeMonthlySeries(monthlySeries)
		};

		console.log(
			`[retirement-preprocess] ${code}: ${summary.sampleSize} annual rows (${summary.coverage}), ${monthlySeries.length} monthly rows with CPI (${inflationCoverage})`
		);
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
