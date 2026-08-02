<script lang="ts">
	let {
		stats,
		input,
		fmtCompactCurrency,
		FI_TARGET_SUCCESS_PROBABILITY = 0.95,
		percentFormatter,
		fmtNum,
		simCount = 0,
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
	const gapPoints = $derived(Math.max(0, targetPercent - lifetimeScore));
	const retirementGoalProbability = $derived(stats?.fiProbabilityP95 ?? 0);

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
	// Consequence and likelihood are two views of the same plan. Sharing the tone prevents
	// a 92% plan from presenting an amber assessment beside a falsely reassuring green tail.
	const drawdownTone = $derived(verdictTone);

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
	const portfolioRows = $derived([
		{
			label: 'Difficult 1-in-10 outcome',
			atRetirement: alreadyRetired ? null : (stats?.retireLow ?? 0),
			atEnd: stats?.finalLow ?? 0
		},
		{
			label: alreadyRetired ? 'Portfolio today' : 'Typical outcome',
			atRetirement: capitalToday,
			atEnd: stats?.finalMedian ?? 0
		},
		{
			label: 'Strong 1-in-10 outcome',
			atRetirement: alreadyRetired ? null : (stats?.retireHigh ?? 0),
			atEnd: stats?.finalHigh ?? 0
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
		<!--
			One card, one answer. The levers that close the gap are rows of the same table as
			the verdict rather than a panel inside the card: a bordered box inside a bordered
			card reads as a second card that failed to escape the first.
		-->
		<section class="card verdict-card tone-{verdictTone}" aria-labelledby="verdict-title">
			<p class="eyebrow">Plan assessment · {verdictLabel}</p>
			<h3 id="verdict-title" class="stat-sentence">
				<strong class="mono-value">{lifetimeScore}%</strong> estimated chance your plan stays funded
				through age {fmtNum(input.simulateUntilAge)}
			</h3>

			<div class="verdict-gauge">
				<div
					class="gauge-track"
					role="img"
					aria-label="{lifetimeScore} of 100 against a goal of {targetPercent} of 100"
				>
					<div class="gauge-fill" style="width: {Math.min(100, lifetimeScore)}%"></div>
					<div class="gauge-goal" style="left: {targetPercent}%"></div>
				</div>
				<p class="gauge-scale">
					<span>0</span>
					<span class="gauge-goal-label">goal {targetPercent}</span>
					<span>100</span>
				</p>
			</div>

			<p class="verdict-detail" aria-live="polite">
				{#if verdictTone === 'good'}
					This meets the {targetPercent}% planning goal used here.
				{:else if lifetimeScore === 0}
					Every tested path ran short before the end of the plan.
				{:else}
					This is {gapPoints}
					{gapPoints === 1 ? 'point' : 'points'} below the {targetPercent}% planning goal.
				{/if}
			</p>

			{#if actionableRecommendations?.targetResult === 'already-met'}
				{#if higherSpendingResult != null}
					<table class="stat-table">
						<tbody>
							<tr>
								<th scope="row">Still funded with 10% higher spending</th>
								<td class="mono-value">{Math.round(higherSpendingResult * 100)}%</td>
							</tr>
						</tbody>
					</table>
				{/if}
				<p class="card-note">
					Also compare lower returns, higher inflation, other market regions, and a longer lifetime.
				</p>
			{:else if actionableRecommendations?.targetResult === 'single-lever'}
				<table class="stat-table">
					<caption>Either change reaches {targetPercent}% on its own</caption>
					<tbody>
						{#if actionableRecommendations.yearlySpendingReduction != null}
							<tr>
								<th scope="row">Spend less each year</th>
								<td class="mono-value"
									>{fmtCompactCurrency(actionableRecommendations.yearlySpendingReduction)}/yr</td
								>
							</tr>
						{/if}
						{#if actionableRecommendations.monthsLonger != null}
							<tr>
								<th scope="row">Or retire later by</th>
								<td class="mono-value">{fmtNum(actionableRecommendations.monthsLonger)} months</td>
							</tr>
						{/if}
					</tbody>
				</table>
			{:else if actionableRecommendations?.targetResult === 'combined' && actionableRecommendations.combinedScenario}
				<table class="stat-table">
					<caption>Neither change reaches {targetPercent}% alone; together they do</caption>
					<tbody>
						<tr>
							<th scope="row">Spend less</th>
							<td class="mono-value"
								>{Math.round(
									(1 - actionableRecommendations.combinedScenario.spendingMultiplier) * 100
								)}%</td
							>
						</tr>
						<tr>
							<th scope="row">And retire at</th>
							<td class="mono-value"
								>age {fmtNum(actionableRecommendations.combinedScenario.retirementAge)}</td
							>
						</tr>
						<tr>
							<th scope="row" class="stat-subrow">Resulting chance</th>
							<td class="mono-value stat-subrow"
								>{Math.round(
									actionableRecommendations.combinedScenario.successProbability * 100
								)}%</td
							>
						</tr>
					</tbody>
				</table>
			{:else}
				<p class="card-note">
					{#if bestScenario}
						Nothing in the tested range reached {targetPercent}%. The strongest tested result was
						<strong>{Math.round(bestScenario.successProbability * 100)}%</strong
						>{#if bestScenarioChanges.length > 0}, using {bestScenarioChanges.join(' and ')}{/if}. A
						larger redesign is needed: review spending, retirement timing, pensions or temporary
						income, lump sums, taxes, and the planning horizon.
					{:else}
						No tested adjustment reached {targetPercent}%. A larger redesign is needed: review
						spending, retirement timing, pensions or temporary income, lump sums, taxes, and the
						planning horizon.
					{/if}
					{#if actionableRecommendations && !actionableRecommendations.retirementDelayAvailable && !alreadyRetired}
						A later-retirement estimate is not shown because another income source ends inside the
						tested age range, so assuming it continues would overstate the result.
					{/if}
				</p>
			{/if}

			<!--
				The lever table answers "what closes the gap" with two numbers. The adjustment map
				further down answers "what does the trade-off look like between them", so this points
				at it instead of restating the same levers in prose a second time.
			-->
			<p class="card-note">
				{#if actionableRecommendations?.targetResult !== 'already-met'}Everything between those
					points is in the plan adjustment map below.
				{/if}{#if simCount > 0}
					Based on {fmtNum(simCount)} simulated market paths.
				{/if} Tested scenarios, not personal financial advice.
			</p>
		</section>

		<!--
			Money position, both dates in one table. The three tiles and the collapsed
			"portfolio and target details" card said the same thing twice at two levels of
			disclosure; the percentiles are the detail, so they are simply shown.
		-->
		<section class="card portfolio-card" aria-labelledby="portfolio-title">
			<p class="eyebrow">Portfolio versus target</p>
			<h3 id="portfolio-title" class="stat-sentence">
				{alreadyRetired ? 'Your portfolio today is' : `A typical path reaches`}
				<strong class="mono-value">{fmtCompactCurrency(capitalToday)}</strong>
				{alreadyRetired ? '' : `at age ${fmtNum(input.retirementAge)}`},
				<span
					class="mono-value"
					class:amount-positive={capitalGap >= 0}
					class:amount-negative={capitalGap < 0}
					>{fmtSignedCurrency(capitalGap)} ({fmtMargin(capitalMargin)})</span
				>
				against the {fmtCompactCurrency(stats.fiTargetP95)} simulation-based target
			</h3>

			<table class="stat-table">
				<thead>
					<tr>
						<th></th>
						<th>{alreadyRetired ? 'Today' : `At age ${fmtNum(input.retirementAge)}`}</th>
						<th>At age {fmtNum(input.simulateUntilAge)}</th>
					</tr>
				</thead>
				<tbody>
					{#each portfolioRows as row (row.label)}
						<tr>
							<th scope="row">{row.label}</th>
							<td class="mono-value"
								>{row.atRetirement == null ? '—' : fmtCompactCurrency(row.atRetirement)}</td
							>
							<td class="mono-value">{fmtCompactCurrency(row.atEnd)}</td>
						</tr>
					{/each}
					<tr>
						<th scope="row">Simulation-based target</th>
						<td class="mono-value">{fmtCompactCurrency(stats.fiTargetP95)}</td>
						<td class="mono-value">—</td>
					</tr>
					<tr>
						<th scope="row">{alreadyRetired ? 'Position versus target' : 'Chance of hitting it'}</th
						>
						<td class="mono-value">
							{alreadyRetired
								? fmtMargin(capitalMargin)
								: percentFormatter.format(retirementGoalProbability)}
						</td>
						<td class="mono-value">—</td>
					</tr>
					<tr>
						<th scope="row">Years at zero · difficult outcome</th>
						<td class="mono-value">—</td>
						<td class="mono-value" class:amount-negative={stats.depletedYearsHigh > 0}
							>{fmtNum(stats.depletedYearsHigh, 1)}</td
						>
					</tr>
				</tbody>
			</table>
			<p class="card-note">
				The target is the capital that cleared the {targetPercent}% goal in simulation. The 4% rule
				comparison and full percentile statistics are in advanced statistics below.
			</p>
		</section>

		<!--
			Failure-conditional only. Restating the headline probability here made this card read
			as an 80/20 rewrite of the card above; what it uniquely knows is when the money runs
			out and how much spending goes unfunded when it does.
		-->
		<section class="card downside-card tone-{drawdownTone}" aria-labelledby="drawdown-title">
			<p class="eyebrow">If the plan falls short</p>
			{#if stats.failureMedianDepletionAge != null && stats.failureMedianShortfall != null}
				<h3 id="drawdown-title" class="stat-sentence">
					The money typically runs out around age
					<strong class="mono-value">{fmtNum(Math.floor(stats.failureMedianDepletionAge))}</strong>,
					leaving
					<strong class="mono-value">{fmtCompactCurrency(stats.failureMedianShortfall)}</strong>
					of planned spending unfunded
				</h3>
				<p class="card-note">
					Measured only across the simulations that ran short — how often that happens is the
					assessment above. Every year after that age is funded by other income, or not at all.
				</p>
			{:else}
				<h3 id="drawdown-title" class="stat-sentence">
					No simulated path ran short; even a difficult 1-in-10 outcome still holds
					<strong class="mono-value">{fmtCompactCurrency(stats.finalLow)}</strong>
					at age {fmtNum(input.simulateUntilAge)}
				</h3>
				<p class="card-note">
					With no failures to measure, no depletion age or shortfall size can be reported.
				</p>
			{/if}
		</section>

		<p class="scope-note">
			Modelled here: retirement timing, changing spending periods, pensions and other income, lump
			sums, taxes and fees, inflation, withdrawal strategy, and simulated sequences of market
			returns.
		</p>
	</div>
{/if}
