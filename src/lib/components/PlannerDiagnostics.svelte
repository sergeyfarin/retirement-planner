<script lang="ts">
	import { probabilityInterval } from '../resultPresentation';

	let {
		stats,
		input,
		simCount = 0,
		percentFormatter,
		fmtNum,
		fmtCompactCurrency,
		retirementYearlySpending = 0,
		FI_TARGET_SUCCESS_PROBABILITY = 0.95
	} = $props();

	const targetPercent = $derived(Math.round(FI_TARGET_SUCCESS_PROBABILITY * 100));
	const successProbabilitySE = $derived(
		simCount > 0 && stats
			? Math.sqrt((stats.successProbability * (1 - stats.successProbability)) / simCount)
			: 0
	);
	const historicalMonths = $derived(input.historicalMonthlyReturns?.length ?? 0);
	const historicalBlockChunks = $derived(
		historicalMonths > 0 ? Math.floor(historicalMonths / Math.max(1, input.blockLength)) : 0
	);
	const surfaceSampleCount = $derived(stats?.ruinSurface?.sampleCount ?? 0);
	const surfaceProbabilities = $derived(
		stats?.ruinSurface?.ruinProbabilities.flat().map((ruin: number) => 1 - ruin) ?? []
	);
	const surfaceWorstMargin = $derived.by(() => {
		if (surfaceSampleCount <= 0) return 0;
		return surfaceProbabilities.reduce((worst: number, probability: number) => {
			const margin = 1.96 * Math.sqrt((probability * (1 - probability)) / surfaceSampleCount);
			return Math.max(worst, margin);
		}, 0);
	});
	const strategyLabel = $derived.by(() => {
		switch (input.withdrawalStrategy?.kind) {
			case 'guardrails':
				return 'Guardrails';
			case 'percentOfPortfolio':
				return 'Percent of portfolio';
			default:
				return 'Fixed real spending';
		}
	});

	/** Column of the sensitivity surface that matches the planned retirement age. */
	const baselineAgeIndex = $derived.by(() => {
		const ages: number[] = stats?.ruinSurface?.retirementAges ?? [];
		return ages.reduce(
			(best, age, index) =>
				Math.abs(age - input.retirementAge) < Math.abs(ages[best] - input.retirementAge)
					? index
					: best,
			0
		);
	});

	/**
	 * Largest tested spending level that still clears the goal at the planned retirement age.
	 * This is the spending capacity of the plan as designed — a number no other card carries,
	 * and the one a reader actually budgets against.
	 */
	const sustainableMultiplier = $derived.by(() => {
		if (!stats?.ruinSurface) return null;
		const { spendingMultipliers, ruinProbabilities } = stats.ruinSurface;
		let best: number | null = null;
		for (let row = 0; row < spendingMultipliers.length; row++) {
			const success = 1 - ruinProbabilities[row][baselineAgeIndex];
			const conservativeSuccess = probabilityInterval(success, surfaceSampleCount)[0];
			if (conservativeSuccess >= FI_TARGET_SUCCESS_PROBABILITY) {
				best = best == null ? spendingMultipliers[row] : Math.max(best, spendingMultipliers[row]);
			}
		}
		return best;
	});
	const fmtWholePercent = (value: number): string => `${Math.round(value * 100)}%`;
	const sustainableSpending = $derived(
		sustainableMultiplier == null ? null : retirementYearlySpending * sustainableMultiplier
	);
	/**
	 * The sweep is bounded, so a plan that clears the goal at the highest tested spending level
	 * has capacity somewhere above it. Reporting that ceiling as *the* answer would understate
	 * the plan; the copy says "at least" instead.
	 */
	const sustainableIsCapped = $derived(
		sustainableMultiplier != null &&
			sustainableMultiplier >= Math.max(...(stats?.ruinSurface?.spendingMultipliers ?? [0]))
	);

	/**
	 * Sequence-of-returns exposure: the spread in ruin probability between the worst and best
	 * early-return buckets. Two plans with the same headline probability can differ sharply
	 * here, and the difference is what makes early-retirement years fragile.
	 */
	const sequenceBuckets = $derived(stats?.sequenceRisk ?? []);
	const sequenceSpread = $derived.by(() => {
		if (sequenceBuckets.length === 0) return 0;
		const ruins = sequenceBuckets.map(
			(bucket: { ruinProbability: number }) => bucket.ruinProbability
		);
		return Math.max(...ruins) - Math.min(...ruins);
	});
</script>

{#if stats}
	<details class="card diagnostics-card">
		<summary>Advanced statistics and model diagnostics</summary>
		<p class="diagnostics-intro">
			Spending capacity, sequence-risk exposure, sampling precision, and the return distribution
			this run actually produced. Hidden by default because these figures support — not replace —
			the assessment above.
		</p>
		<div class="diagnostics-grid">
			<section>
				<h4>Spending capacity at the {targetPercent}% goal</h4>
				{#if sustainableSpending != null}
					<table class="stat-table stat-table-dense mono-value">
						<tbody>
							<tr
								><th scope="row">Sustainable yearly spending</th><td>
									{sustainableIsCapped ? '≥ ' : ''}{fmtCompactCurrency(sustainableSpending)}
								</td></tr
							>
							<tr
								><th scope="row">Versus planned spending</th><td>
									{sustainableIsCapped ? '≥ ' : ''}{percentFormatter.format(sustainableMultiplier)}
								</td></tr
							>
						</tbody>
					</table>
					<p>
						{#if sustainableIsCapped}
							The plan still clears the goal at the highest spending level this sweep tests, so its
							real capacity at age {fmtNum(input.retirementAge)} is somewhere above this figure.
						{:else}
							Highest tested spending level that still clears the goal at age {fmtNum(
								input.retirementAge
							)}. Resolution is limited to the tested levels listed below.
						{/if}
					</p>
				{:else}
					<p>
						No tested spending level cleared the goal at age {fmtNum(input.retirementAge)}, so a
						sustainable figure cannot be reported from this sweep.
					</p>
				{/if}
			</section>

			<section>
				<h4>Rule-of-thumb comparison</h4>
				<table class="stat-table stat-table-dense mono-value">
					<tbody>
						<tr
							><th scope="row">Spending-rule target</th><td
								>{fmtCompactCurrency(stats.fiTargetSWR)}</td
							></tr
						>
						<tr
							><th scope="row">Estimated chance of reaching it</th><td
								>{fmtWholePercent(stats.fiProbabilitySWR)}</td
							></tr
						>
						<tr
							><th scope="row">Simulation-based target</th><td
								>{fmtCompactCurrency(stats.fiTargetP95)}</td
							></tr
						>
					</tbody>
				</table>
				<p>
					The spending-rule target divides spending by the selected withdrawal rate, net of other
					income. It ignores sequence risk and your actual horizon, so where the two targets
					disagree, the simulated one is the one the assessment uses.
				</p>
			</section>

			<section>
				<h4>Sequence-of-returns exposure</h4>
				{#if sequenceBuckets.length > 0}
					<table class="stat-table stat-table-dense mono-value">
						<tbody>
							{#each sequenceBuckets as bucket (bucket.bucketLabel)}
								<tr
									><th scope="row">{bucket.bucketLabel}</th><td
										>{fmtWholePercent(bucket.ruinProbability)} ruin</td
									></tr
								>
							{/each}
						</tbody>
					</table>
					<p>
						Ruin probability spans {(sequenceSpread * 100).toFixed(0)} percentage points between the worst
						and best early-return groups. A wide spread means early retirement returns materially affect
						the result. Compare adaptive spending or a higher bank allocation in separate runs.
					</p>
				{:else}
					<p>Sequence-risk buckets are unavailable for this run.</p>
				{/if}
			</section>

			<section>
				<h4>Sampling precision</h4>
				{#if simCount > 0}
					<p class="mono-value">
						Monte Carlo noise: ±{(successProbabilitySE * 1.96 * 100).toFixed(1)} percentage points (approximate
						95% run-to-run range; {fmtNum(simCount)} paths).
					</p>
				{/if}
				<p class="mono-value">
					Mode: {input.simulationMode === 'historical'
						? 'Historical block bootstrap'
						: 'Parametric regime model'} · withdrawals: {strategyLabel} · horizon: {fmtNum(
						input.simulateUntilAge - input.currentAge
					)} years.
				</p>
				{#if input.simulationMode === 'historical' && historicalMonths > 0}
					<p>
						Historical robustness is not measured: this run uses one regional record with
						{fmtNum(historicalMonths)} months, or about {fmtNum(historicalBlockChunks)} non-overlapping
						{fmtNum(input.blockLength)}-month runs. Compare other regions, periods, and replay
						lengths.
					</p>
				{:else}
					<p>
						Model robustness is not measured. Vary return, inflation, and model assumptions before
						relying on the headline probability.
					</p>
				{/if}
			</section>

			<section>
				<h4>Return distribution</h4>
				<p class="mono-value">
					Requested: mean {percentFormatter.format(stats.requestedReturnMoments.arithmeticMean)} · volatility
					{percentFormatter.format(stats.requestedReturnMoments.stdDev)}
				</p>
				<p class="mono-value">
					Effective: mean {percentFormatter.format(stats.returnMoments.arithmeticMean)} · volatility
					{percentFormatter.format(stats.returnMoments.stdDev)} · CAGR
					{percentFormatter.format(stats.returnMoments.geometricMean)}
				</p>
				<p class="mono-value">
					Requested shape: skew {fmtNum(stats.requestedReturnMoments.skewness, 1)} · kurtosis
					{fmtNum(stats.requestedReturnMoments.kurtosis, 1)}
				</p>
				<p class="mono-value">
					Effective shape: skew {fmtNum(stats.returnMoments.skewness, 1)} · kurtosis
					{fmtNum(stats.returnMoments.kurtosis, 1)}
				</p>
				<p>
					Only mean and volatility are matched to the inputs. Skew and kurtosis emerge from the
					regime mixture and source data, so they need not match requested shape values.
				</p>
			</section>

			<section>
				<h4>Sensitivity-test coverage</h4>
				<p class="mono-value">
					Retirement ages: {stats.ruinSurface.retirementAges
						.map((age: number) => fmtNum(age))
						.join(', ')}<br />
					Spending levels: {stats.ruinSurface.spendingMultipliers
						.map((value: number) => percentFormatter.format(value))
						.join(', ')}
				</p>
				{#if surfaceSampleCount > 0}
					<p>
						Each sensitivity cell replays {fmtNum(surfaceSampleCount)} paths and has up to ±{(
							surfaceWorstMargin * 100
						).toFixed(1)} percentage points of sampling noise. Cells share paths, so nearby differences
						are steadier than their individual margins suggest.
					</p>
				{/if}
				<p>
					Recommendations are reported only from this tested range. The calculator does not
					extrapolate a larger spending cut or later retirement age when the goal remains outside
					it.
				</p>
			</section>
		</div>
	</details>
{/if}
