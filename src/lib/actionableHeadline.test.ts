import { describe, expect, it } from 'vitest';
import { buildActionableRecommendations } from './actionableHeadline';
import type { SummaryStats } from './retirementEngine';

function statsWithSurface(): SummaryStats {
  return {
    successProbability: 0.93,
    ruinSurface: {
      retirementAges: [62, 65, 68],
      spendingMultipliers: [0.8, 0.9, 1, 1.1, 1.2],
      ruinProbabilities: [
        [0.02, 0.01, 0.005],
        [0.06, 0.04, 0.02],
        [0.12, 0.08, 0.04],
        [0.2, 0.15, 0.1],
        [0.3, 0.25, 0.2]
      ],
      sampleCount: 2000
    }
  } as SummaryStats;
}

describe('buildActionableRecommendations', () => {
  it('interpolates spending and retirement changes that reach the target', () => {
    const result = buildActionableRecommendations(statsWithSurface(), 65, 40_000);

    expect(result.yearlySpendingReduction).toBeCloseTo(3_000);
    expect(result.monthsLonger).toBe(27);
  });

  it('omits a lever when the sampled range never reaches the target', () => {
    const stats = statsWithSurface();
    stats.ruinSurface.ruinProbabilities = stats.ruinSurface.ruinProbabilities.map((row) =>
      row.map(() => 0.1)
    );

    expect(buildActionableRecommendations(stats, 65, 40_000)).toEqual({
      yearlySpendingReduction: null,
      monthsLonger: null
    });
  });
});
