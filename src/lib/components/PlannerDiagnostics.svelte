<script lang="ts">
	import { m } from '../paraglide/messages';
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
	const withdrawalRuleLabel = $derived(
		m.withdrawal_rule_label({ rate: Number((input.safeWithdrawalRate * 100).toFixed(2)) })
	);
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
				return m.strategy_label_guardrails();
			case 'percentOfPortfolio':
				return m.strategy_label_percent();
			default:
				return m.strategy_label_fixed();
		}
	});

	/**
	 * Both engines label the sequence-risk quintiles in English (`stats.sequenceRisk`
	 * crosses the WASM boundary), so the label is treated as an ordinal here and the
	 * displayed text comes from the catalogue.
	 */
	function bucketLabel(index: number, total: number): string {
		if (index === 0) return m.bucket_worst();
		if (index === total - 1) return m.bucket_best();
		return m.bucket_quintile({ index: index + 1 });
	}

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
		<summary>{m.summary_diagnostics()}</summary>
		<p class="diagnostics-intro">{m.diagnostics_intro()}</p>
		<div class="diagnostics-grid">
			<section>
				<h4>{m.diag_h_spending_capacity({ percent: targetPercent })}</h4>
				{#if sustainableSpending != null}
					<table class="stat-table stat-table-dense mono-value">
						<tbody>
							<tr
								><th scope="row">{m.diag_row_sustainable_spending()}</th><td>
									{sustainableIsCapped ? '≥ ' : ''}{fmtCompactCurrency(sustainableSpending)}
								</td></tr
							>
							<tr
								><th scope="row">{m.diag_row_versus_planned()}</th><td>
									{sustainableIsCapped ? '≥ ' : ''}{percentFormatter.format(sustainableMultiplier)}
								</td></tr
							>
						</tbody>
					</table>
					<p>
						{#if sustainableIsCapped}
							{m.diag_capacity_capped({ age: fmtNum(input.retirementAge) })}
						{:else}
							{m.diag_capacity_note({ age: fmtNum(input.retirementAge) })}
						{/if}
					</p>
				{:else}
					<p>{m.diag_capacity_none({ age: fmtNum(input.retirementAge) })}</p>
				{/if}
			</section>

			<section>
				<h4>{m.diag_h_rule_of_thumb()}</h4>
				<table class="stat-table stat-table-dense mono-value">
					<tbody>
						<tr
							><th scope="row">{withdrawalRuleLabel}</th><td
								>{fmtCompactCurrency(stats.fiTargetSWR)}</td
							></tr
						>
						<tr
							><th scope="row">{m.diag_row_chance_of_reaching()}</th><td
								>{fmtWholePercent(stats.fiProbabilitySWR)}</td
							></tr
						>
						<tr
							><th scope="row">{m.diag_row_simulation_target()}</th><td
								>{fmtCompactCurrency(stats.fiTargetP95)}</td
							></tr
						>
					</tbody>
				</table>
				<p>{m.diag_rule_note({ rule: withdrawalRuleLabel })}</p>
			</section>

			<section>
				<h4>{m.diag_h_sequence_exposure()}</h4>
				{#if sequenceBuckets.length > 0}
					<table class="stat-table stat-table-dense mono-value">
						<tbody>
							{#each sequenceBuckets as bucket, index (bucket.bucketLabel)}
								<tr
									><th scope="row">{bucketLabel(index, sequenceBuckets.length)}</th><td
										>{m.diag_ruin_suffix({
											percent: fmtWholePercent(bucket.ruinProbability)
										})}</td
									></tr
								>
							{/each}
						</tbody>
					</table>
					<p>{m.diag_sequence_note({ points: (sequenceSpread * 100).toFixed(0) })}</p>
				{:else}
					<p>{m.diag_sequence_unavailable()}</p>
				{/if}
			</section>

			<section>
				<h4>{m.diag_h_sampling_precision()}</h4>
				{#if simCount > 0}
					<p class="mono-value">
						{m.diag_sampling_noise({
							value: (successProbabilitySE * 1.96 * 100).toFixed(1),
							count: fmtNum(simCount)
						})}
					</p>
				{/if}
				<p class="mono-value">
					{m.diag_mode_line({
						mode:
							input.simulationMode === 'historical'
								? m.diag_mode_historical_bootstrap()
								: m.diag_mode_parametric_regime(),
						strategy: strategyLabel,
						years: fmtNum(input.simulateUntilAge - input.currentAge)
					})}
				</p>
				{#if input.simulationMode === 'historical' && historicalMonths > 0}
					<p>
						{m.diag_historical_robustness({
							months: fmtNum(historicalMonths),
							chunks: fmtNum(historicalBlockChunks),
							blockLength: fmtNum(input.blockLength)
						})}
					</p>
				{:else}
					<p>{m.diag_model_robustness()}</p>
				{/if}
			</section>

			<section>
				<h4>{m.diag_h_return_distribution()}</h4>
				<p class="mono-value">
					{m.diag_requested_line({
						mean: percentFormatter.format(stats.requestedReturnMoments.arithmeticMean),
						std: percentFormatter.format(stats.requestedReturnMoments.stdDev)
					})}
				</p>
				<p class="mono-value">
					{m.diag_effective_line({
						mean: percentFormatter.format(stats.returnMoments.arithmeticMean),
						std: percentFormatter.format(stats.returnMoments.stdDev),
						cagr: percentFormatter.format(stats.returnMoments.geometricMean)
					})}
				</p>
				<p class="mono-value">
					{m.diag_requested_shape({
						skew: fmtNum(stats.requestedReturnMoments.skewness, 1),
						kurt: fmtNum(stats.requestedReturnMoments.kurtosis, 1)
					})}
				</p>
				<p class="mono-value">
					{m.diag_effective_shape({
						skew: fmtNum(stats.returnMoments.skewness, 1),
						kurt: fmtNum(stats.returnMoments.kurtosis, 1)
					})}
				</p>
				<p>{m.diag_distribution_note()}</p>
			</section>

			<section>
				<h4>{m.diag_h_sensitivity_coverage()}</h4>
				<p class="mono-value">
					{m.diag_sensitivity_ages({
						ages: stats.ruinSurface.retirementAges.map((age: number) => fmtNum(age)).join(', ')
					})}<br />
					{m.diag_sensitivity_levels({
						levels: stats.ruinSurface.spendingMultipliers
							.map((value: number) => percentFormatter.format(value))
							.join(', ')
					})}
				</p>
				{#if surfaceSampleCount > 0}
					<p>
						{m.diag_sensitivity_noise({
							count: fmtNum(surfaceSampleCount),
							margin: (surfaceWorstMargin * 100).toFixed(1)
						})}
					</p>
				{/if}
				<p>{m.diag_sensitivity_scope()}</p>
			</section>
		</div>
	</details>
{/if}
