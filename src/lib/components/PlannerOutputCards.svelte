<script lang="ts">
	import { retirementCapitalLabel, retirementCapitalTone } from '../resultPresentation';

	let {
		stats,
		input,
		fmtCompactCurrency,
		FI_TARGET_SUCCESS_PROBABILITY = 0.95,
		fmtNum,
		alreadyRetired = false,
		actionableRecommendations = null
	} = $props();

	const targetPercent = $derived(Math.round(FI_TARGET_SUCCESS_PROBABILITY * 100));

	/**
	 * The single question this tool answers: does the money last to the end of the plan?
	 * Everything else — reaching a capital target by the retirement date, ending balances,
	 * downside sizes — supports that answer and lives in the cards below.
	 */
	const lifetimeProbability = $derived(stats?.successProbability ?? 0);
	const lifetimeScore = $derived(Math.round(lifetimeProbability * 100));

	const verdictLabel = $derived(
		lifetimeProbability >= FI_TARGET_SUCCESS_PROBABILITY
			? 'On track'
			: lifetimeProbability >= 0.75
				? 'Needs adjustment'
				: lifetimeProbability >= 0.5
					? 'At risk'
					: 'Unlikely to last'
	);
	const verdictTone = $derived(
		lifetimeProbability >= FI_TARGET_SUCCESS_PROBABILITY
			? 'good'
			: lifetimeProbability >= 0.75
				? 'warn'
				: lifetimeProbability >= 0.5
					? 'caution'
					: 'bad'
	);

	/** Money-terms position at the retirement date, used by the portfolio card. */
	const capitalToday = $derived(alreadyRetired ? input.currentSavings : (stats?.retireMedian ?? 0));
	const capitalGap = $derived(capitalToday - (stats?.fiTargetP95 ?? 0));
	const capitalMargin = $derived(
		stats && stats.fiTargetP95 > 0 ? capitalToday / stats.fiTargetP95 - 1 : 0
	);
	const retirementTone = $derived(retirementCapitalTone(capitalMargin));
	const retirementLabel = $derived(retirementCapitalLabel(capitalMargin));

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
			changes.push(`${Math.round((1 - bestScenario.spendingMultiplier) * 100)}% lower spending`);
		}
		if (bestScenario.retirementAge > input.retirementAge) {
			changes.push(`retirement at age ${fmtNum(bestScenario.retirementAge)}`);
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
			label: 'Difficult 1-in-10 outcome',
			value: alreadyRetired ? null : (stats?.retireLow ?? 0)
		},
		{
			label: alreadyRetired ? 'Portfolio today' : 'Typical outcome',
			value: capitalToday
		},
		{
			label: 'Strong 1-in-10 outcome',
			value: alreadyRetired ? null : (stats?.retireHigh ?? 0)
		}
	]);

	function fmtMargin(margin: number): string {
		const pct = margin * 100;
		return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
	}

	function fmtSignedCurrency(amount: number): string {
		return `${amount >= 0 ? '+' : '−'}${fmtCompactCurrency(Math.abs(amount))}`;
	}
</script>

{#if stats}
	<div class="results-summary">
		<section
			class="card outcome-card verdict-card tone-{verdictTone}"
			aria-labelledby="verdict-title"
		>
			<p class="eyebrow">Plan through age {fmtNum(input.simulateUntilAge)} · {verdictLabel}</p>
			<h3 id="verdict-title" class="stat-sentence">
				<strong class="mono-value">{lifetimeScore}%</strong> estimated chance your plan stays funded
				through age {fmtNum(input.simulateUntilAge)}
			</h3>

			<div class="verdict-next">
				<table class="stat-table stat-table-compact">
					<tbody>
						{#if stats.failureMedianDepletionAge != null && stats.failureMedianShortfall != null}
							<tr>
								<th scope="row">If a simulation falls short, typical depletion age</th>
								<td class="mono-value">{fmtNum(Math.floor(stats.failureMedianDepletionAge))}</td>
							</tr>
							<tr>
								<th scope="row">Planned spending left unfunded in those cases</th>
								<td class="mono-value">{fmtCompactCurrency(stats.failureMedianShortfall)}</td>
							</tr>
						{:else}
							<tr>
								<th scope="row"
									>Difficult 1-in-10 balance at age {fmtNum(input.simulateUntilAge)}</th
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
									<th scope="row">Chance funded with 10% higher spending</th>
									<td class="mono-value">{Math.round(higherSpendingResult * 100)}%</td>
								</tr>
							</tbody>
						</table>
					{/if}
				{:else if actionableRecommendations?.targetResult === 'single-lever'}
					<table class="stat-table">
						<caption>Tested ways to reach {targetPercent}%</caption>
						<tbody>
							{#if actionableRecommendations.yearlySpendingReduction != null}<tr>
									<th scope="row">Spend less each year</th><td class="mono-value"
										>{fmtCompactCurrency(actionableRecommendations.yearlySpendingReduction)}/yr</td
									>
								</tr>{/if}
							{#if actionableRecommendations.monthsLonger != null}<tr>
									<th scope="row">Or retire later by</th><td class="mono-value"
										>{fmtNum(actionableRecommendations.monthsLonger)} months</td
									>
								</tr>{/if}
						</tbody>
					</table>
				{:else if actionableRecommendations?.targetResult === 'combined' && actionableRecommendations.combinedScenario}
					<p class="card-note">
						<strong>To reach {targetPercent}% in the tested range:</strong> spend
						{Math.round((1 - actionableRecommendations.combinedScenario.spendingMultiplier) * 100)}%
						less and retire at age {fmtNum(
							actionableRecommendations.combinedScenario.retirementAge
						)}.
					</p>
				{:else if bestScenario}
					<p class="card-note">
						The strongest tested adjustment reaches
						<strong>{Math.round(bestScenario.successProbability * 100)}%</strong
						>{#if bestScenarioChanges.length > 0}
							with {bestScenarioChanges.join(' and ')}{/if}.
					</p>
				{/if}
			</div>
		</section>

		<section
			class="card outcome-card retirement-card tone-{retirementTone}"
			aria-labelledby="portfolio-title"
		>
			<p class="eyebrow">
				{alreadyRetired ? 'Portfolio today' : `At retirement age ${fmtNum(input.retirementAge)}`} ·
				{retirementLabel}
			</p>
			<h3 id="portfolio-title" class="stat-sentence">
				{alreadyRetired ? 'Your portfolio today is' : `A typical path reaches`}
				<strong class="mono-value">{fmtCompactCurrency(capitalToday)}</strong>
				{alreadyRetired ? '' : `at retirement`},
				<span
					class="mono-value"
					class:amount-positive={capitalGap >= 0}
					class:amount-negative={capitalGap < 0}
					>{fmtSignedCurrency(capitalGap)} ({fmtMargin(capitalMargin)})</span
				>
				against the {fmtCompactCurrency(stats.fiTargetP95)} simulation-based target
			</h3>

			<table class="stat-table stat-table-compact">
				<tbody>
					{#each retirementRows as row (row.label)}
						<tr>
							<th scope="row">{row.label}</th>
							<td class="mono-value">{row.value == null ? '—' : fmtCompactCurrency(row.value)}</td>
						</tr>
					{/each}
					<tr>
						<th scope="row">Simulation-based target</th>
						<td class="mono-value">{fmtCompactCurrency(stats.fiTargetP95)}</td>
					</tr>
				</tbody>
			</table>
			<p class="card-note">
				Status reflects the typical portfolio's gap to the target. The 4% rule comparison and full
				percentile statistics are in advanced statistics.
			</p>
		</section>

		<p class="scope-note">
			Modelled here: retirement timing, changing spending periods, pensions and other income, lump
			sums, taxes and fees, inflation, withdrawal strategy, and simulated sequences of market
			returns. Tested scenarios, not personal financial advice.
		</p>
	</div>
{/if}
