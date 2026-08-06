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

		expect(result.yearlySpendingReduction).toBeCloseTo(2_666.67);
		expect(result.spendingReductionPercent).toBeCloseTo(6.67);
		expect(result.monthsLonger).toBe(24);
		expect(result.targetResult).toBe('single-lever');
	});

	it('omits a lever when the sampled range never reaches the target', () => {
		const stats = statsWithSurface();
		stats.ruinSurface.ruinProbabilities = stats.ruinSurface.ruinProbabilities.map((row) =>
			row.map(() => 0.1)
		);

		expect(buildActionableRecommendations(stats, 65, 40_000)).toMatchObject({
			yearlySpendingReduction: null,
			spendingReductionPercent: null,
			monthsLonger: null,
			targetResult: 'outside-tested-range'
		});
		expect(buildActionableRecommendations(stats, 65, 40_000).bestTestedScenario).toMatchObject({
			retirementAge: 65,
			spendingMultiplier: 1,
			successProbability: 0.93
		});
	});

	it('suppresses work-longer advice when unshifted income ends inside the age sweep', () => {
		const result = buildActionableRecommendations(statsWithSurface(), 65, 40_000, 0.95, [
			{
				id: 'is-partner',
				label: 'Partner salary',
				fromAge: 40,
				toAge: 65,
				yearlyAmount: 30_000,
				inflationAdjusted: true
			}
		]);

		expect(result.yearlySpendingReduction).toBeCloseTo(2_666.67);
		expect(result.monthsLonger).toBeNull();
		expect(result.retirementDelayAvailable).toBe(false);
	});

	it('keeps work-longer advice when non-default income ends outside the age sweep', () => {
		const result = buildActionableRecommendations(statsWithSurface(), 65, 40_000, 0.95, [
			{
				id: 'is-pension',
				label: 'Pension',
				fromAge: 70,
				toAge: 90,
				yearlyAmount: 15_000,
				inflationAdjusted: true
			}
		]);

		expect(result.monthsLonger).toBe(24);
	});

	it('finds a combined tested route when neither lever reaches the target alone', () => {
		const stats = statsWithSurface();
		stats.successProbability = 0.8;
		stats.ruinSurface.ruinProbabilities = [
			[0.2, 0.1, 0.03],
			[0.25, 0.15, 0.08],
			[0.3, 0.2, 0.1],
			[0.4, 0.3, 0.2],
			[0.5, 0.4, 0.3]
		];

		const result = buildActionableRecommendations(stats, 65, 40_000);

		expect(result.yearlySpendingReduction).toBeNull();
		expect(result.monthsLonger).toBeNull();
		expect(result.targetResult).toBe('combined');
		expect(result.combinedScenario).toMatchObject({
			retirementAge: 68,
			spendingMultiplier: 0.8,
			successProbability: 0.97
		});
	});

	it('reports that the goal is already met without manufacturing an adjustment', () => {
		const stats = statsWithSurface();
		stats.successProbability = 0.97;

		const result = buildActionableRecommendations(stats, 65, 40_000);

		expect(result.targetResult).toBe('already-met');
	});

	it('uses the full-run headline probability at the baseline surface cell', () => {
		const stats = statsWithSurface();
		stats.successProbability = 0.94;
		// The capped surface sample says 92% at the unchanged plan. Interpolation should start
		// from the authoritative full-run 94% instead.
		const result = buildActionableRecommendations(stats, 65, 40_000);

		expect(result.spendingReductionPercent).toBeCloseTo(5);
		expect(result.monthsLonger).toBe(18);
	});
});
