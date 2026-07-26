import type { SummaryStats } from './retirementEngine';

type Point = { x: number; success: number };

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
  target = 0.95
): { yearlySpendingReduction: number | null; monthsLonger: number | null } {
  const surface = stats.ruinSurface;
  const baselineAgeIndex = surface.retirementAges.reduce(
    (best, age, index) =>
      Math.abs(age - retirementAge) < Math.abs(surface.retirementAges[best] - retirementAge)
        ? index
        : best,
    0
  );
  const baselineSpendingIndex = surface.spendingMultipliers.reduce(
    (best, multiplier, index) =>
      Math.abs(multiplier - 1) < Math.abs(surface.spendingMultipliers[best] - 1)
        ? index
        : best,
    0
  );

  const spendingMultiplier = crossing(
    surface.spendingMultipliers
      .map((multiplier, row) => ({
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

  return {
    yearlySpendingReduction:
      qualifyingMultiplier != null && qualifyingMultiplier < 1
        ? yearlySpending * (1 - qualifyingMultiplier)
        : null,
    monthsLonger:
      qualifyingAge != null && qualifyingAge > retirementAge
        ? Math.ceil((qualifyingAge - retirementAge) * 12)
        : null
  };
}
