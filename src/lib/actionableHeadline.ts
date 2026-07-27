import type { IncomeSource, SummaryStats } from './retirementEngine';

type Point = { x: number; success: number };

export type TestedPlanScenario = {
	retirementAge: number;
	spendingMultiplier: number;
	successProbability: number;
};

export type ActionableRecommendations = {
	yearlySpendingReduction: number | null;
	monthsLonger: number | null;
	combinedScenario: TestedPlanScenario | null;
	bestTestedScenario: TestedPlanScenario | null;
	targetResult: 'already-met' | 'single-lever' | 'combined' | 'outside-tested-range';
	retirementDelayAvailable: boolean;
};

function crossing(points: Point[], target: number): number | null {
	const sorted = [...points].sort((a, b) => a.x - b.x);

	for (let index = 0; index < sorted.length; index++) {
		const point = sorted[index];
		if (point.success >= target) return point.x;

		const next = sorted[index + 1];
		if (next && next.success >= target && next.success !== point.success) {
			const progress = (target - point.success) / (next.success - point.success);
			return point.x + progress * (next.x - point.x);
		}
	}

	return null;
}

/** Recommendations supported by the ruin-surface replays, interpolated between cells. */
export function buildActionableRecommendations(
	stats: SummaryStats,
	retirementAge: number,
	yearlySpending: number,
	target = 0.95,
	incomeSources: readonly IncomeSource[] = []
): ActionableRecommendations {
	const surface = stats.ruinSurface;
	const firstSweptAge = Math.min(...surface.retirementAges);
	const lastSweptAge = Math.max(...surface.retirementAges);
	const hasUnshiftedIncomeEndingInSweep = incomeSources.some(
		(source) =>
			source.id !== 'is-default' && source.toAge >= firstSweptAge && source.toAge <= lastSweptAge
	);
	const retirementDelayAvailable =
		!hasUnshiftedIncomeEndingInSweep && surface.retirementAges.some((age) => age > retirementAge);
	const baselineAgeIndex = surface.retirementAges.reduce(
		(best, age, index) =>
			Math.abs(age - retirementAge) < Math.abs(surface.retirementAges[best] - retirementAge)
				? index
				: best,
		0
	);
	const baselineSpendingIndex = surface.spendingMultipliers.reduce(
		(best, multiplier, index) =>
			Math.abs(multiplier - 1) < Math.abs(surface.spendingMultipliers[best] - 1) ? index : best,
		0
	);

	const spendingMultiplier = crossing(
		surface.spendingMultipliers.map((multiplier, row) => ({
			x: -multiplier,
			success: 1 - surface.ruinProbabilities[row][baselineAgeIndex]
		})),
		target
	);
	const qualifyingMultiplier = spendingMultiplier == null ? null : -spendingMultiplier;

	const qualifyingAge = crossing(
		surface.retirementAges.map((age, column) => ({
			x: age,
			success: 1 - surface.ruinProbabilities[baselineSpendingIndex][column]
		})),
		target
	);
	const yearlySpendingReduction =
		qualifyingMultiplier != null && qualifyingMultiplier < 1
			? yearlySpending * (1 - qualifyingMultiplier)
			: null;
	const monthsLonger =
		retirementDelayAvailable && qualifyingAge != null && qualifyingAge > retirementAge
			? Math.ceil((qualifyingAge - retirementAge) * 12)
			: null;

	const minimumSpendingMultiplier = Math.min(...surface.spendingMultipliers);
	const maximumRetirementAge = Math.max(...surface.retirementAges);
	const maximumSpendingReduction = Math.max(0.0001, 1 - minimumSpendingMultiplier);
	const maximumRetirementDelay = Math.max(0.0001, maximumRetirementAge - retirementAge);
	const baselineAge = surface.retirementAges[baselineAgeIndex];
	const candidates: Array<TestedPlanScenario & { adjustmentScore: number }> = [];

	for (let row = 0; row < surface.spendingMultipliers.length; row++) {
		const spendingMultiplier = surface.spendingMultipliers[row];
		if (spendingMultiplier > 1) continue;

		for (let column = 0; column < surface.retirementAges.length; column++) {
			const candidateAge = surface.retirementAges[column];
			if (candidateAge < baselineAge) continue;
			if (!retirementDelayAvailable && column !== baselineAgeIndex) continue;

			const spendingAdjustment = Math.max(0, 1 - spendingMultiplier);
			const retirementAdjustment = Math.max(0, candidateAge - baselineAge);
			candidates.push({
				retirementAge: candidateAge,
				spendingMultiplier,
				successProbability: 1 - surface.ruinProbabilities[row][column],
				adjustmentScore:
					spendingAdjustment / maximumSpendingReduction +
					retirementAdjustment / maximumRetirementDelay
			});
		}
	}

	const combinedScenario =
		candidates
			.filter(
				(candidate) =>
					candidate.successProbability >= target &&
					candidate.spendingMultiplier < 1 &&
					candidate.retirementAge > baselineAge
			)
			.sort(
				(a, b) =>
					a.adjustmentScore - b.adjustmentScore || b.successProbability - a.successProbability
			)[0] ?? null;

	const bestTestedScenario =
		candidates.sort(
			(a, b) => b.successProbability - a.successProbability || a.adjustmentScore - b.adjustmentScore
		)[0] ?? null;

	let targetResult: ActionableRecommendations['targetResult'];
	if (stats.successProbability >= target) targetResult = 'already-met';
	else if (yearlySpendingReduction != null || monthsLonger != null) targetResult = 'single-lever';
	else if (combinedScenario) targetResult = 'combined';
	else targetResult = 'outside-tested-range';

	return {
		yearlySpendingReduction,
		monthsLonger,
		combinedScenario,
		bestTestedScenario,
		targetResult,
		retirementDelayAvailable
	};
}
