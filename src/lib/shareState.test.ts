import { describe, expect, it } from 'vitest';
import {
	MAX_SHARED_SIMULATIONS,
	SHARE_INPUT_SCALARS,
	decodeShareHash,
	normalizeSharedScalar,
	normalizeSharedScalars,
	parseShareState,
	toBase64Url
} from './shareState';
import { DEFAULT_WITHDRAWAL_STRATEGY } from './retirementEngine';

const isKnownCurrency = (code: string) => ['USD', 'EUR', 'GBP', 'WORLD'].includes(code);

/** A minimal valid payload; the `v: 1` version marker is what makes it readable at all. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { v: 1, c: 'EUR', m: 'historical', t: 0, i: {}, ...overrides };
}

describe('share-link scalar normalization', () => {
	// A share payload is untrusted input: the numbers in it never went through the input
	// handlers that clamp equivalents typed into the UI. Before this normalization a link
	// could seat the app in a state the UI would not produce — the field showing one number
	// while the engine clamped it to another.

	it('drops values that are not finite numbers', () => {
		for (const key of SHARE_INPUT_SCALARS) {
			expect(normalizeSharedScalar(key, Number.NaN), key).toBeUndefined();
			expect(normalizeSharedScalar(key, Number.POSITIVE_INFINITY), key).toBeUndefined();
			expect(normalizeSharedScalar(key, '42'), key).toBeUndefined();
			expect(normalizeSharedScalar(key, null), key).toBeUndefined();
			expect(normalizeSharedScalar(key, undefined), key).toBeUndefined();
		}
	});

	it('floors the block length at one whole month, matching both engines', () => {
		expect(normalizeSharedScalar('blockLength', 0)).toBe(1);
		expect(normalizeSharedScalar('blockLength', -6)).toBe(1);
		expect(normalizeSharedScalar('blockLength', 6.7)).toBe(7);
		expect(normalizeSharedScalar('blockLength', 6)).toBe(6);
	});

	it('clamps the correlation to [-1, 1]', () => {
		expect(normalizeSharedScalar('equityBondCorrelation', 5)).toBe(1);
		expect(normalizeSharedScalar('equityBondCorrelation', -5)).toBe(-1);
		expect(normalizeSharedScalar('equityBondCorrelation', -0.1)).toBe(-0.1);
	});

	it('clamps fees and tax to [0, 1] the way the input handlers do', () => {
		expect(normalizeSharedScalar('annualFeePercent', -0.2)).toBe(0);
		expect(normalizeSharedScalar('annualFeePercent', 4)).toBe(1);
		expect(normalizeSharedScalar('taxOnGainsPercent', -1)).toBe(0);
		expect(normalizeSharedScalar('taxOnGainsPercent', 12)).toBe(1);
		expect(normalizeSharedScalar('taxOnGainsPercent', 0.15)).toBe(0.15);
	});

	it('keeps the crisis inflation spread non-negative', () => {
		expect(normalizeSharedScalar('inflationCrisisSpread', -0.02)).toBe(0);
		expect(normalizeSharedScalar('inflationCrisisSpread', 0.015)).toBe(0.015);
	});

	it('clamps the withdrawal rate to the domain both engines assume', () => {
		// Both engines apply `max(0.01)` internally, so a smaller shared value would be
		// displayed as one rate and simulated as another.
		expect(normalizeSharedScalar('safeWithdrawalRate', 0)).toBe(0.01);
		expect(normalizeSharedScalar('safeWithdrawalRate', -0.04)).toBe(0.01);
		expect(normalizeSharedScalar('safeWithdrawalRate', 8)).toBe(1);
		expect(normalizeSharedScalar('safeWithdrawalRate', 0.04)).toBe(0.04);
	});

	it('caps a shared simulation count so a link cannot freeze the recipient', () => {
		expect(normalizeSharedScalar('simulations', 1e9)).toBe(MAX_SHARED_SIMULATIONS);
		expect(normalizeSharedScalar('simulations', 0)).toBe(1);
		expect(normalizeSharedScalar('simulations', 20_000)).toBe(20_000);
	});

	it('rounds the seed to a whole number, as both PRNGs do', () => {
		expect(normalizeSharedScalar('seed', 12.4)).toBe(12);
		expect(normalizeSharedScalar('seed', -7)).toBe(-7);
	});

	it('leaves fields with no edit-time bound untouched', () => {
		// The HTML min/max attributes on these are not enforced for typed input either, so
		// clamping them here would rewrite plans the app itself accepts. `validateSimulationInputs`
		// owns the age invariants and reports them as errors instead.
		expect(normalizeSharedScalar('currentAge', 4)).toBe(4);
		expect(normalizeSharedScalar('simulateUntilAge', 240)).toBe(240);
		expect(normalizeSharedScalar('retirementAge', 62.5)).toBe(62.5);
		expect(normalizeSharedScalar('currentSavings', -50_000)).toBe(-50_000);
	});

	it('ignores keys that are not shared scalars', () => {
		const restored = normalizeSharedScalars({
			blockLength: 0,
			meanReturn: 99,
			returnKurtosis: 0,
			simulations: 1e12
		});
		expect(restored).toEqual({ blockLength: 1, simulations: MAX_SHARED_SIMULATIONS });
		expect('meanReturn' in restored).toBe(false);
	});

	it('returns nothing for a payload with no scalar section', () => {
		expect(normalizeSharedScalars(undefined)).toEqual({});
		expect(normalizeSharedScalars(null)).toEqual({});
		expect(normalizeSharedScalars('nope')).toEqual({});
	});
});

describe('share hash decoding', () => {
	it('round-trips a payload through the location hash', () => {
		const encoded = toBase64Url(JSON.stringify(payload({ i: { seed: 4242 } })));
		expect(decodeShareHash(`#s=${encoded}`)).toEqual(payload({ i: { seed: 4242 } }));
		// Also when the hash carries other parameters alongside it.
		expect(decodeShareHash(`#tab=advanced&s=${encoded}`)).not.toBeNull();
	});

	it('survives non-ASCII labels, which is why the codec goes through UTF-8', () => {
		const withUnicode = payload({
			sp: [
				{ id: 'sp-1', label: 'Wohnkosten — Zürich 🏔', fromAge: 40, toAge: 90, yearlyAmount: 30_000 }
			]
		});
		const decoded = decodeShareHash(`#s=${toBase64Url(JSON.stringify(withUnicode))}`);
		expect((decoded?.sp as { label: string }[])[0].label).toBe('Wohnkosten — Zürich 🏔');
	});

	it('returns null rather than throwing for anything unreadable', () => {
		expect(decodeShareHash('')).toBeNull();
		expect(decodeShareHash('#other=1')).toBeNull();
		// Valid base64url, but not JSON.
		expect(decodeShareHash(`#s=${toBase64Url('not json at all')}`)).toBeNull();
		// Valid JSON, but not an object.
		expect(decodeShareHash(`#s=${toBase64Url('7')}`)).toBeNull();
		// Truncated payload, the shape a hand-edited or line-wrapped link arrives in.
		expect(decodeShareHash('#s=eyJ2IjoxLCJjIjoiRVVS')).toBeNull();
	});
});

describe('share payload validation', () => {
	it('rejects a payload from an incompatible version', () => {
		expect(parseShareState(payload({ v: 2 }), isKnownCurrency)).toBeNull();
		expect(parseShareState(payload({ v: undefined }), isKnownCurrency)).toBeNull();
		expect(parseShareState(null, isKnownCurrency)).toBeNull();
		expect(parseShareState('nope', isKnownCurrency)).toBeNull();
	});

	it('accepts only known currencies and simulation modes', () => {
		expect(parseShareState(payload({ c: 'CHF' }), isKnownCurrency)?.currencyCode).toBeNull();
		expect(parseShareState(payload({ c: 'USD' }), isKnownCurrency)?.currencyCode).toBe('USD');
		expect(parseShareState(payload({ m: 'wishful' }), isKnownCurrency)?.simulationMode).toBeNull();
		expect(parseShareState(payload({ m: 'parametric' }), isKnownCurrency)?.simulationMode).toBe(
			'parametric'
		);
	});

	it('fills an unrecognized withdrawal strategy from the defaults', () => {
		const restored = parseShareState(
			payload({ ws: { kind: 'vibes', guardrailBand: 0.3, spendingFloor: 'low' } }),
			isKnownCurrency
		);
		expect(restored?.withdrawalStrategy).toEqual({
			...DEFAULT_WITHDRAWAL_STRATEGY,
			guardrailBand: 0.3
		});
	});

	it('clamps the allocation boundaries to whole percentages in [0, 100]', () => {
		const restored = parseShareState(payload({ sb: 140.6, bb: -20 }), isKnownCurrency);
		expect(restored?.stockBoundaryPercent).toBe(100);
		expect(restored?.bondBoundaryPercent).toBe(0);
		expect(parseShareState(payload({ sb: 62.4 }), isKnownCurrency)?.stockBoundaryPercent).toBe(62);
		expect(parseShareState(payload({}), isKnownCurrency)?.stockBoundaryPercent).toBeNull();
	});

	it('rejects a whole cashflow list when any row is malformed', () => {
		// All-or-nothing: a half-restored spending plan is a plan the user never made.
		const bad = parseShareState(
			payload({
				sp: [
					{ id: 'sp-1', label: 'Living', fromAge: 40, toAge: 90, yearlyAmount: 30_000 },
					{ id: 'sp-2', label: 'Travel', fromAge: 65, toAge: 75, yearlyAmount: null }
				]
			}),
			isKnownCurrency
		);
		expect(bad?.spendingPeriods).toBeNull();
	});

	it('gives every restored row an id and a label', () => {
		const restored = parseShareState(
			payload({ sp: [{ fromAge: 40, toAge: 90, yearlyAmount: 30_000 }] }),
			isKnownCurrency
		);
		expect(restored?.spendingPeriods).toHaveLength(1);
		expect(restored?.spendingPeriods?.[0].id).toMatch(/[0-9a-f-]{36}/);
		expect(restored?.spendingPeriods?.[0].label).toBe('');
	});

	it('treats an empty spending list as nothing shared, but an empty lump-sum list as real', () => {
		// Restoring zero spending periods would leave the planner with no plan to simulate;
		// having no lump sums is an ordinary state worth reproducing.
		const restored = parseShareState(payload({ sp: [], is: [], ls: [] }), isKnownCurrency);
		expect(restored?.spendingPeriods).toBeNull();
		expect(restored?.incomeSources).toBeNull();
		expect(restored?.lumpSumEvents).toEqual([]);
	});

	it('normalizes the scalars it carries', () => {
		const restored = parseShareState(
			payload({ i: { blockLength: 0, taxOnGainsPercent: 9, currentSavings: 250_000 } }),
			isKnownCurrency
		);
		expect(restored?.scalars).toEqual({
			blockLength: 1,
			taxOnGainsPercent: 1,
			currentSavings: 250_000
		});
	});

	it('reads moment targeting only from an explicit 1', () => {
		expect(parseShareState(payload({ t: 1 }), isKnownCurrency)?.momentTargeting).toBe(true);
		expect(parseShareState(payload({ t: 0 }), isKnownCurrency)?.momentTargeting).toBe(false);
		expect(parseShareState(payload({ t: 'yes' }), isKnownCurrency)?.momentTargeting).toBe(false);
	});
});
