import {
	DEFAULT_WITHDRAWAL_STRATEGY,
	type IncomeSource,
	type LumpSumEvent,
	type RetirementInput,
	type SpendingPeriod,
	type WithdrawalStrategy
} from './retirementEngine';
import { randomId } from './randomId';

/**
 * Share links carry a base64 payload that becomes application state on load, so every
 * number in one is untrusted input from whoever built the link — not from this UI.
 *
 * The invariants the planner relies on live in three different places, and only two of
 * them cover a restored link:
 *
 *  1. The engines clamp what would otherwise be unsafe (`blockLength` >= 1,
 *     `safeWithdrawalRate` >= 0.01, fees and tax to [0, 1], `simulations` >= 400). Both
 *     engines must agree on these, which is what the parity suite checks.
 *  2. `validateSimulationInputs` owns the cross-field invariants (horizon length, the
 *     age ordering) and reports them to the user as errors rather than clamping.
 *  3. The input handlers clamp several fields *at edit time* — `equityBondCorrelation`
 *     to [-1, 1], the fee and tax percentages to [0, 1], `inflationCrisisSpread` to
 *     >= 0. Restoration bypasses those handlers entirely, so a link could seat the app
 *     in a state the UI itself would never produce: the field renders the out-of-range
 *     number back to the user while the engine silently simulates the clamped one.
 *
 * This module closes (3). The rule is deliberately narrow: **clamp to a bound enforced by
 * the UI or public simulation boundary, and leave everything else alone.** Fields with no
 * edit-time bound (the ages) are not clamped here, because the HTML
 * `min`/`max` attributes are not enforced for typed input either — treating them as
 * invariants would let restoration quietly rewrite a plan that the app would have
 * accepted if it had been typed in by hand. Those stay the validator's business.
 */

type ScalarBound = {
	min?: number;
	max?: number;
	/** Rounded to a whole number, for fields the engines index or count with. */
	integer?: boolean;
	/** Why this bound exists — kept next to it so it can be checked against the UI. */
	because: string;
};

/**
 * A shared `simulations` count is the one field where a hostile (or careless) link can
 * hurt the recipient rather than just mislead them: the run is synchronous inside the
 * worker, so a 10⁹-path request is a frozen tab with no way back. The cap is far above
 * any useful run — `FULL_MONTE_CARLO_MIN_SIMULATIONS` is 20 000 — and only applies to
 * restored links; a count typed in locally is still the user's own call.
 */
export const MAX_SHARED_SIMULATIONS = 500_000;

/**
 * Every scalar carried in a share link, in payload order. The keys double as the list
 * `buildShareState` serializes, so a field cannot be shared without a stated bound (or
 * an explicit empty one, meaning "no edit-time invariant to enforce").
 */
export const SHARE_INPUT_SCALAR_BOUNDS = {
	currentAge: { because: 'no edit-time clamp; validateSimulationInputs owns the horizon' },
	retirementAge: { because: 'no edit-time clamp; may legitimately equal currentAge' },
	simulateUntilAge: {
		because: 'no edit-time clamp; validateSimulationInputs rejects short horizons'
	},
	currentSavings: { min: 0, because: 'the simulation boundary rejects negative portfolio value' },
	equityBondCorrelation: { min: -1, max: 1, because: 'a correlation outside [-1, 1] is not one' },
	annualFeePercent: { min: 0, max: 1, because: 'matches the edit-time clamp and both engines' },
	taxOnGainsPercent: { min: 0, max: 1, because: 'matches the edit-time clamp and both engines' },
	blockLength: {
		min: 1,
		integer: true,
		because: 'a block spans at least one month; both engines floor it'
	},
	inflationCrisisSpread: {
		min: 0,
		because: 'a negative spread inverts the growth/crisis inflation means'
	},
	safeWithdrawalRate: {
		min: 0.01,
		max: 1,
		because: 'both engines floor at 0.01; above 1 is not a rate'
	},
	simulations: {
		min: 1,
		max: MAX_SHARED_SIMULATIONS,
		integer: true,
		because: 'see MAX_SHARED_SIMULATIONS'
	},
	seed: { integer: true, because: 'both PRNGs round the seed to a u32 before using it' }
} as const satisfies Record<string, ScalarBound>;

export type ShareInputScalar = keyof typeof SHARE_INPUT_SCALAR_BOUNDS;

export const SHARE_INPUT_SCALARS = Object.keys(SHARE_INPUT_SCALAR_BOUNDS) as ShareInputScalar[];

/**
 * One restored scalar, or `undefined` when the payload has nothing usable for this key —
 * in which case the caller keeps the currency/reference default already in place rather
 * than substituting a zero.
 */
export function normalizeSharedScalar(key: ShareInputScalar, value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;

	const bound: ScalarBound = SHARE_INPUT_SCALAR_BOUNDS[key];
	let normalized = bound.integer ? Math.round(value) : value;
	if (bound.min !== undefined) normalized = Math.max(bound.min, normalized);
	if (bound.max !== undefined) normalized = Math.min(bound.max, normalized);
	return normalized;
}

/**
 * The scalar half of a restored share payload, normalized. Unknown keys are ignored, so
 * a link built by a newer version cannot inject arbitrary fields into `input`.
 */
export function normalizeSharedScalars(
	raw: unknown
): Partial<Pick<RetirementInput, ShareInputScalar>> {
	if (!raw || typeof raw !== 'object') return {};

	const scalars = raw as Record<string, unknown>;
	const out: Record<string, number> = {};
	for (const key of SHARE_INPUT_SCALARS) {
		const normalized = normalizeSharedScalar(key, scalars[key]);
		if (normalized !== undefined) out[key] = normalized;
	}
	return out as Partial<Pick<RetirementInput, ShareInputScalar>>;
}

// ─── Payload codec ────────────────────────────────────────────────────────────

export function toBase64Url(json: string): string {
	const bytes = new TextEncoder().encode(json);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): string {
	const b64 = value.replaceAll('-', '+').replaceAll('_', '/');
	const bin = atob(b64);
	return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/**
 * The payload object out of a `#s=` location hash, or `null` when there is nothing to
 * restore — no hash, malformed base64, or JSON that does not parse. A bad link must leave
 * the planner on its defaults rather than throwing during mount.
 */
export function decodeShareHash(hash: string): Record<string, unknown> | null {
	const match = hash.match(/[#&]s=([A-Za-z0-9_-]+)/);
	if (!match) return null;
	try {
		const parsed = JSON.parse(fromBase64Url(match[1]));
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

// ─── Payload validation ───────────────────────────────────────────────────────

function sanitizeCashflowRows<T extends { id?: unknown; label?: unknown }>(
	rows: unknown,
	numericKeys: string[]
): T[] | null {
	if (!Array.isArray(rows)) return null;
	const out: T[] = [];
	for (const raw of rows) {
		if (!raw || typeof raw !== 'object') return null;
		const row = raw as Record<string, unknown>;
		for (const key of numericKeys) {
			if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) return null;
		}
		out.push({
			...row,
			id: typeof row.id === 'string' ? row.id : randomId(),
			label: typeof row.label === 'string' ? row.label : ''
		} as T);
	}
	return out;
}

/**
 * Everything a share payload is allowed to say, validated. `null` fields mean "the payload
 * had nothing usable here, keep what is already loaded" — never "reset to zero".
 *
 * The caller applies these in a specific order (currency and mode first, then
 * `applyReferenceDefaults`, then the overlay) because the reference defaults overwrite the
 * very fields the payload is restoring. That sequencing is the only part of restoration
 * that stays in the component; every decision about *what is acceptable* is here.
 */
export type RestoredShareState = {
	currencyCode: string | null;
	simulationMode: 'historical' | 'parametric' | null;
	momentTargeting: boolean;
	withdrawalStrategy: WithdrawalStrategy | null;
	stockBoundaryPercent: number | null;
	bondBoundaryPercent: number | null;
	parametricMetrics: Record<string, number>;
	parametricInflation: Partial<Record<'mean' | 'std' | 'skew' | 'kurt', number>>;
	scalars: Partial<Pick<RetirementInput, ShareInputScalar>>;
	spendingPeriods: SpendingPeriod[] | null;
	incomeSources: IncomeSource[] | null;
	lumpSumEvents: LumpSumEvent[] | null;
};

function finiteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validates a decoded share payload, or returns `null` for one this version cannot read.
 *
 * `isKnownCurrency` is injected rather than imported so this module stays independent of
 * the currency table in the UI.
 */
export function parseShareState(
	state: unknown,
	isKnownCurrency: (code: string) => boolean
): RestoredShareState | null {
	if (!state || typeof state !== 'object') return null;
	const payload = state as Record<string, unknown>;
	if (payload.v !== 1) return null;

	let withdrawalStrategy: WithdrawalStrategy | null = null;
	if (payload.ws && typeof payload.ws === 'object') {
		const ws = payload.ws as Record<string, unknown>;
		withdrawalStrategy = { ...DEFAULT_WITHDRAWAL_STRATEGY };
		if (ws.kind === 'fixed' || ws.kind === 'guardrails' || ws.kind === 'percentOfPortfolio') {
			withdrawalStrategy.kind = ws.kind;
		}
		for (const key of [
			'guardrailBand',
			'adjustment',
			'withdrawalPercent',
			'spendingFloor',
			'spendingCeiling'
		] as const) {
			const value = finiteNumber(ws[key]);
			if (value !== null) withdrawalStrategy[key] = value;
		}
	}

	const metricBounds: Record<string, { min: number; max: number }> = {
		stockMean: { min: -0.95, max: 1.2 },
		stockStd: { min: 0, max: 2 },
		stockSkew: { min: -2, max: 2 },
		stockKurt: { min: 1, max: 20 },
		bondMean: { min: -0.95, max: 1.2 },
		bondStd: { min: 0, max: 2 },
		bondSkew: { min: -2, max: 2 },
		bondKurt: { min: 1, max: 20 },
		bankMean: { min: -0.95, max: 1.2 },
		bankStd: { min: 0, max: 2 },
		bankSkew: { min: -2, max: 2 },
		bankKurt: { min: 1, max: 20 }
	};
	const parametricMetrics: Record<string, number> = {};
	if (payload.pm && typeof payload.pm === 'object') {
		for (const [key, value] of Object.entries(payload.pm as Record<string, unknown>)) {
			const numeric = finiteNumber(value);
			const bound = metricBounds[key];
			if (numeric !== null && bound) {
				parametricMetrics[key] = Math.min(bound.max, Math.max(bound.min, numeric));
			}
		}
	}

	const parametricInflation: RestoredShareState['parametricInflation'] = {};
	if (payload.pi && typeof payload.pi === 'object') {
		const pi = payload.pi as Record<string, unknown>;
		const bounds = {
			mean: { min: -0.95, max: 1.2 },
			std: { min: 0, max: 0.5 },
			skew: { min: -2, max: 2 },
			kurt: { min: 1, max: 20 }
		};
		for (const key of ['mean', 'std', 'skew', 'kurt'] as const) {
			const value = finiteNumber(pi[key]);
			if (value !== null) {
				parametricInflation[key] = Math.min(bounds[key].max, Math.max(bounds[key].min, value));
			}
		}
	}

	const boundary = (value: unknown): number | null => {
		const numeric = finiteNumber(value);
		return numeric === null ? null : Math.min(100, Math.max(0, Math.round(numeric)));
	};

	const spendingPeriods = sanitizeCashflowRows<SpendingPeriod>(payload.sp, [
		'fromAge',
		'toAge',
		'yearlyAmount'
	]);
	const incomeSources = sanitizeCashflowRows<IncomeSource>(payload.is, [
		'fromAge',
		'toAge',
		'yearlyAmount'
	]);

	return {
		currencyCode: typeof payload.c === 'string' && isKnownCurrency(payload.c) ? payload.c : null,
		simulationMode: payload.m === 'historical' || payload.m === 'parametric' ? payload.m : null,
		momentTargeting: payload.t === 1,
		withdrawalStrategy,
		stockBoundaryPercent: boundary(payload.sb),
		bondBoundaryPercent: boundary(payload.bb),
		parametricMetrics,
		parametricInflation,
		scalars: normalizeSharedScalars(payload.i),
		// An empty list would leave the planner with no plan at all, so it is treated as
		// "nothing shared" — unlike lump sums, where empty is a meaningful state.
		spendingPeriods: spendingPeriods && spendingPeriods.length > 0 ? spendingPeriods : null,
		incomeSources: incomeSources && incomeSources.length > 0 ? incomeSources : null,
		lumpSumEvents: sanitizeCashflowRows<LumpSumEvent>(payload.ls, ['age', 'amount'])
	};
}
