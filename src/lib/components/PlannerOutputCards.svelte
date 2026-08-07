<script lang="ts">
	import { m } from '../paraglide/messages';
	import { lifetimeVerdict } from '../resultPresentation';

	let {
		stats,
		input,
		fmtCompactCurrency,
		FI_TARGET_SUCCESS_PROBABILITY = 0.95,
		fmtNum,
		alreadyRetired = false,
		actionableRecommendations = null,
		simCount = 0
	} = $props();

	const targetPercent = $derived(Math.round(FI_TARGET_SUCCESS_PROBABILITY * 100));

	/**
	 * The single question this tool answers: does the money last to the end of the plan?
	 * Everything else — reaching a capital target by the retirement date, ending balances,
	 * downside sizes — supports that answer and lives in the cards below.
	 */
	const lifetimeProbability = $derived(stats?.successProbability ?? 0);
	const lifetimeScore = $derived(Math.round(lifetimeProbability * 100));
	const verdict = $derived(
		lifetimeVerdict(lifetimeProbability, simCount, FI_TARGET_SUCCESS_PROBABILITY)
	);
	const verdictLabel = $derived.by(() => {
		switch (verdict.key) {
			case 'on-track':
				return m.verdict_on_track();
			case 'needs-adjustment':
				return m.verdict_needs_adjustment();
			case 'at-risk':
				return m.verdict_at_risk();
			default:
				return m.verdict_unlikely_to_last();
		}
	});

	/** Money-terms outcomes at the retirement date, used by the portfolio card. */
	const capitalToday = $derived(alreadyRetired ? input.currentSavings : (stats?.retireMedian ?? 0));

	const bestScenario = $derived(actionableRecommendations?.bestTestedScenario ?? null);
	const baselineAgeIndex = $derived.by(() => {
		const ages: number[] = stats?.ruinSurface?.retirementAges ?? [];
		if (ages.length === 0) return -1;
		return ages.reduce(
			(best, age, index) =>
				Math.abs(age - input.retirementAge) < Math.abs(ages[best] - input.retirementAge)
					? index
					: best,
			0
		);
	});
	const higherSpendingResult = $derived.by(() => {
		if (!stats?.ruinSurface || baselineAgeIndex < 0) return null;
		const row = stats.ruinSurface.spendingMultipliers.findIndex(
			(multiplier: number) => Math.abs(multiplier - 1.1) < 0.001
		);
		if (row < 0) return null;
		return 1 - stats.ruinSurface.ruinProbabilities[row][baselineAgeIndex];
	});
	const bestScenarioChanges = $derived.by(() => {
		if (!bestScenario) return [] as string[];
		const changes: string[] = [];
		if (bestScenario.spendingMultiplier < 0.999) {
			changes.push(
				m.change_lower_spending({
					percent: Math.round((1 - bestScenario.spendingMultiplier) * 100)
				})
			);
		}
		if (bestScenario.retirementAge > input.retirementAge) {
			changes.push(m.change_retirement_at_age({ age: fmtNum(bestScenario.retirementAge) }));
		}
		return changes;
	});

	/**
	 * Both money columns of the portfolio card in one place. These used to sit in a
	 * collapsed second card that repeated the three tiles above it; as one table they
	 * are the same information without the duplication or the disclosure.
	 */
	const retirementRows = $derived([
		{
			label: m.row_difficult_outcome(),
			value: alreadyRetired ? null : (stats?.retireLow ?? 0)
		},
		{
			label: alreadyRetired ? m.row_portfolio_today() : m.row_typical_outcome(),
			value: capitalToday
		},
		{
			label: m.row_strong_outcome(),
			value: alreadyRetired ? null : (stats?.retireHigh ?? 0)
		}
	]);
</script>

{#if stats}
	<div class="results-summary">
		<section
			class="card outcome-card verdict-card tone-{verdict.tone}"
			aria-labelledby="verdict-title"
		>
			<h3 id="verdict-title" class="card-title">
				{m.verdict_card_title({
					age: fmtNum(input.simulateUntilAge),
					verdict: verdictLabel
				})}
			</h3>
			<p class="stat-sentence">
				<strong class="mono-value">{lifetimeScore}%</strong>
				{m.verdict_sentence_tail({ age: fmtNum(input.simulateUntilAge) })}
			</p>
			{#if verdict.nearBoundary != null}
				<p class="card-note boundary-note">
					{m.verdict_boundary_note({ percent: Math.round(verdict.nearBoundary * 100) })}
				</p>
			{/if}

			<div class="verdict-next">
				<table class="stat-table stat-table-compact">
					<tbody>
						{#if stats.failureMedianDepletionAge != null && stats.failureMedianShortfall != null}
							<tr>
								<th scope="row">{m.row_typical_depletion_age()}</th>
								<td class="mono-value">{fmtNum(Math.floor(stats.failureMedianDepletionAge))}</td>
							</tr>
							<tr>
								<th scope="row">{m.row_unfunded_spending()}</th>
								<td class="mono-value">{fmtCompactCurrency(stats.failureMedianShortfall)}</td>
							</tr>
						{:else}
							<tr>
								<th scope="row"
									>{m.row_difficult_balance_at_age({ age: fmtNum(input.simulateUntilAge) })}</th
								>
								<td class="mono-value">{fmtCompactCurrency(stats.finalLow)}</td>
							</tr>
						{/if}
					</tbody>
				</table>

				{#if actionableRecommendations?.targetResult === 'already-met'}
					{#if higherSpendingResult != null}
						<table class="stat-table stat-table-compact">
							<tbody>
								<tr>
									<th scope="row">{m.row_chance_higher_spending()}</th>
									<td class="mono-value">{Math.round(higherSpendingResult * 100)}%</td>
								</tr>
							</tbody>
						</table>
					{/if}
				{:else if actionableRecommendations?.targetResult === 'single-lever'}
					<table class="stat-table">
						<caption>{m.caption_tested_adjustments({ percent: targetPercent })}</caption>
						<tbody>
							{#if actionableRecommendations.spendingReductionPercent != null}<tr>
									<th scope="row">{m.row_spend_less_from_now()}</th><td class="mono-value"
										>{m.value_about_percent({
											value: fmtNum(actionableRecommendations.spendingReductionPercent)
										})}</td
									>
								</tr>{/if}
							{#if actionableRecommendations.monthsLonger != null}<tr>
									<th scope="row"
										>{actionableRecommendations.spendingReductionPercent != null
											? m.row_or_retire_later_by()
											: m.row_retire_later_by()}</th
									><td class="mono-value"
										>{m.value_about_months({
											value: fmtNum(Math.ceil(actionableRecommendations.monthsLonger / 6) * 6)
										})}</td
									>
								</tr>{/if}
						</tbody>
					</table>
				{:else if actionableRecommendations?.targetResult === 'combined' && actionableRecommendations.combinedScenario}
					<p class="card-note">
						<strong>{m.combined_note_strong({ percent: targetPercent })}</strong>
						{m.combined_note_rest({
							reduction: Math.round(
								(1 - actionableRecommendations.combinedScenario.spendingMultiplier) * 100
							),
							age: fmtNum(actionableRecommendations.combinedScenario.retirementAge)
						})}
					</p>
				{:else if bestScenario}
					<p class="card-note">
						{m.best_scenario_lead()}
						<strong>{Math.round(bestScenario.successProbability * 100)}%</strong
						>{#if bestScenarioChanges.length > 0}
							{m.best_scenario_with({
								changes: bestScenarioChanges.join(` ${m.join_and()} `)
							})}{/if}.
					</p>
				{/if}
			</div>
		</section>

		<section
			class="card outcome-card retirement-card tone-neutral"
			aria-labelledby="portfolio-title"
		>
			<h3 id="portfolio-title" class="card-title">
				{alreadyRetired
					? m.card_title_capital_today()
					: m.card_title_capital_at_retirement({ age: fmtNum(input.retirementAge) })}
			</h3>
			<p class="stat-sentence">
				<strong class="mono-value">{fmtCompactCurrency(stats.fiTargetP95)}</strong>
				{alreadyRetired
					? m.capital_sentence_today({ percent: targetPercent })
					: m.capital_sentence_at_retirement({ percent: targetPercent })}
			</p>

			<table class="stat-table stat-table-compact">
				<caption
					>{alreadyRetired
						? m.caption_portfolio_comparison()
						: m.caption_projected_balance()}</caption
				>
				<tbody>
					{#each retirementRows as row (row.label)}
						{#if row.value != null}
							<tr>
								<th scope="row">{row.label}</th>
								<td class="mono-value">{fmtCompactCurrency(row.value)}</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
			<p class="card-note">{m.capital_card_note()}</p>
		</section>
	</div>
{/if}
