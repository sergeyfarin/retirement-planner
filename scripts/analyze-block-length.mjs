/**
 * Politis & White (2004) automatic block-length selection, with the
 * Patton, Politis & White (2009) correction.
 *
 *   Politis, D. & White, H. (2004) "Automatic Block-Length Selection for the
 *     Dependent Bootstrap", Econometric Reviews 23(1), 53-70.
 *     doi:10.1081/ETC-120028836
 *   Patton, A., Politis, D. & White, H. (2009) "Correction to ...",
 *     Econometric Reviews 28(4), 372-375. doi:10.1080/07474930802459016
 *
 * Parameter defaults follow the reference implementations (`np::b.star`,
 * R package `blocklength::pwsd`):
 *   K_N   = max(5, ceil(log10(n)))            lags for the implied hypothesis test
 *   M_max = ceil(sqrt(n)) + K_N               upper bound on the lag window
 *   B_max = ceil(min(3*sqrt(n), n/3))         upper bound on the block length
 *   c     = qnorm(0.975) ~ 1.96               significance level for the test
 *
 * Run:  node scripts/analyze-block-length.mjs
 *
 * This is an analysis tool, not runtime code. PWSD selects a block length for
 * long-run-variance estimation; it is a useful diagnostic, but it does not by
 * itself select the best block length for retirement ruin or drawdown paths.
 * Re-run it when the market data is refreshed. See TODO 0.13 and README section 4.3.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(projectRoot, 'static', 'assets', 'historical-market-data.json');

/** Flat-top lag window of Politis & Romano (1995). */
function flatTop(s) {
	const a = Math.abs(s);
	if (a <= 0.5) return 1;
	if (a <= 1) return 2 * (1 - a);
	return 0;
}

/** Autocovariance at lag k, divisor n (matches R's acf type="covariance"). */
function autocovariance(x, k, mean) {
	let acc = 0;
	for (let i = k; i < x.length; i++) acc += (x[i] - mean) * (x[i - k] - mean);
	return acc / x.length;
}

export function selectMHat(rho, threshold, KN) {
	if (!Number.isInteger(KN) || KN < 1) throw new RangeError('KN must be a positive integer');

	// rho[0] is lag 1. Current blocklength::pwsd chooses the significant lag immediately
	// before the first run of KN insignificant lags, with 1 as the lower bound.
	for (let start = 0; start + KN <= rho.length; start++) {
		let allSmall = true;
		for (let offset = 0; offset < KN; offset++) {
			if (Math.abs(rho[start + offset]) >= threshold) {
				allSmall = false;
				break;
			}
		}
		if (allSmall) return Math.max(1, start);
	}

	// Reference fallback: largest significant lag, or 1 if every lag is insignificant.
	for (let index = rho.length - 1; index >= 0; index--) {
		if (Math.abs(rho[index]) > threshold) return index + 1;
	}
	return 1;
}

export function theoreticalAr1CircularBlockLength(n, phi) {
	if (!Number.isFinite(n) || n <= 0) throw new RangeError('n must be positive');
	if (!Number.isFinite(phi) || Math.abs(phi) >= 1) throw new RangeError('phi must be stationary');
	if (phi === 0) return 0;
	return Math.cbrt((6 * phi * phi) / (1 - phi * phi) ** 2) * Math.cbrt(n);
}

export function politisWhiteBlockLength(x, opts = {}) {
	const n = x.length;
	if (n < 3 || x.some((value) => !Number.isFinite(value))) {
		throw new RangeError('x must contain at least three finite observations');
	}
	const KN = opts.KN ?? Math.max(5, Math.ceil(Math.log10(n)));
	const MMax = opts.MMax ?? Math.ceil(Math.sqrt(n)) + KN;
	const BMax = opts.BMax ?? Math.ceil(Math.min(3 * Math.sqrt(n), n / 3));
	const c = opts.c ?? 1.959963984540054; // qnorm(0.975)
	if (!Number.isInteger(KN) || KN < 1) throw new RangeError('KN must be a positive integer');
	if (!Number.isInteger(MMax) || MMax < KN) throw new RangeError('MMax must be an integer >= KN');
	if (!Number.isFinite(BMax) || BMax <= 0) throw new RangeError('BMax must be positive');
	if (!Number.isFinite(c) || c <= 0) throw new RangeError('c must be positive');

	const mean = x.reduce((a, b) => a + b, 0) / n;
	const cov0 = autocovariance(x, 0, mean);
	if (!Number.isFinite(cov0) || cov0 <= 0) throw new RangeError('x must have positive variance');
	const rho = [];
	for (let k = 1; k <= MMax; k++) rho.push(autocovariance(x, k, mean) / cov0);

	// m_hat: smallest m after which the correlogram looks negligible for K_N lags.
	const threshold = c * Math.sqrt(Math.log10(n) / n);
	const mHat = selectMHat(rho, threshold, KN);

	const M = Math.min(2 * mHat, MMax);

	let gHat = 0;
	let g0 = 0;
	for (let k = -M; k <= M; k++) {
		const w = flatTop(k / M);
		if (w === 0) continue;
		const R = autocovariance(x, Math.abs(k), mean);
		gHat += w * Math.abs(k) * R;
		g0 += w * R;
	}

	const dCB = (4 / 3) * g0 * g0;
	const dSB = 2 * g0 * g0;
	const cube = (v) => Math.cbrt(v);
	const bCB = Math.min(BMax, cube((2 * gHat * gHat) / dCB) * cube(n));
	const bSB = Math.min(BMax, cube((2 * gHat * gHat) / dSB) * cube(n));

	return { n, KN, MMax, BMax, mHat, M, gHat, g0, bCB, bSB };
}

/* ------------------------------------------------------------------ *
 * Smoke diagnostics. Exact reference fixtures live in the accompanying
 * node:test file; these examples make dependence sensitivity visible.
 * ------------------------------------------------------------------ */
function mulberry32(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function normals(rng, n) {
	const out = [];
	while (out.length < n) {
		let u = 0,
			v = 0;
		while (u === 0) u = rng();
		while (v === 0) v = rng();
		const mag = Math.sqrt(-2 * Math.log(u));
		out.push(mag * Math.cos(2 * Math.PI * v));
		if (out.length < n) out.push(mag * Math.sin(2 * Math.PI * v));
	}
	return out;
}
function ar1(n, phi, seed) {
	const rng = mulberry32(seed);
	const e = normals(rng, n + 200);
	let x = 0;
	const out = [];
	for (let i = 0; i < n + 200; i++) {
		x = phi * x + e[i];
		if (i >= 200) out.push(x);
	}
	return out;
}

function showSmokeDiagnostics() {
	console.log('Smoke diagnostics (exact reference checks run separately via node:test):\n');
	const cases = [
		[
			'iid noise (phi=0)      ',
			ar1(500, 0.0, 11),
			'no dependence -> block should collapse toward 1'
		],
		['AR(1) phi=0.3          ', ar1(500, 0.3, 12), 'mild dependence -> small block'],
		['AR(1) phi=0.5          ', ar1(500, 0.5, 13), 'moderate dependence -> larger than phi=0.3'],
		['AR(1) phi=0.8          ', ar1(500, 0.8, 14), 'strong dependence -> larger again']
	];
	for (const [label, series, expectation] of cases) {
		const r = politisWhiteBlockLength(series);
		console.log(
			`  ${label} b_CB ${r.bCB.toFixed(2)}  b_SB ${r.bSB.toFixed(2)}  (m_hat ${r.mHat}, M ${r.M})`
		);
		console.log(`      expected: ${expectation}`);
	}
	console.log('');
}

export function main() {
	showSmokeDiagnostics();
	const data = JSON.parse(readFileSync(DATA, 'utf8'));
	const allocations = [
		['100/0/0  ', { stocks: 1, bonds: 0, bank: 0 }],
		['80/20/0  ', { stocks: 0.8, bonds: 0.2, bank: 0 }],
		['60/30/10 ', { stocks: 0.6, bonds: 0.3, bank: 0.1 }],
		['40/50/10 ', { stocks: 0.4, bonds: 0.5, bank: 0.1 }],
		['20/40/40 ', { stocks: 0.2, bonds: 0.4, bank: 0.4 }]
	];

	console.log('Optimal block length (months) for the blended monthly portfolio series');
	console.log('b_CB = fixed-length circular block bootstrap (what this engine uses)\n');

	const all = [];
	for (const [code, region] of Object.entries(data.regions)) {
		const rows = [];
		for (const [label, a] of allocations) {
			const series = region.monthlySeries.map(
				(m) => a.stocks * m.equity + a.bonds * m.bond + a.bank * m.cash
			);
			const r = politisWhiteBlockLength(series);
			rows.push(
				`${label} b_CB ${r.bCB.toFixed(1).padStart(5)}  b_SB ${r.bSB.toFixed(1).padStart(5)}  (m_hat ${r.mHat})`
			);
			all.push(r.bCB);
		}
		console.log(`  ${code}`);
		rows.forEach((r) => console.log(`    ${r}`));
	}

	all.sort((x, y) => x - y);
	const median = all[Math.floor(all.length / 2)];
	console.log(
		`\n  across all regions x allocations: min ${all[0].toFixed(1)}  median ${median.toFixed(1)}  max ${all[all.length - 1].toFixed(1)}`
	);
	console.log(`  => PWSD diagnostic median: ${Math.round(median)} months`);
	console.log(
		'  This is not a retirement-path optimum; compare product outcomes across a sensitivity grid.'
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
