<script lang="ts">
	let {
		stats,
		input,
		fmtCompactCurrency,
		FI_TARGET_SUCCESS_PROBABILITY = 0.95,
		percentFormatter,
		fmtNum,
		alreadyRetired = false,
		actionableRecommendations = null
	} = $props();

	const targetPercent = $derived(Math.round(FI_TARGET_SUCCESS_PROBABILITY * 100));

	/**
	 * The single question this tool answers: does the money last to the end of the plan?
	 * Everything else — reaching a capital target by the retirement date, ending balances,
	 * downside sizes — supports that answer and lives in the phase cards below.
	 */
	const lifetimeProbability = $derived(stats?.successProbability ?? 0);
	const lifetimeScore = $derived(Math.round(lifetimeProbability * 100));
	const gapPoints = $derived(Math.max(0, targetPercent - lifetimeScore));
	const retirementGoalProbability = $derived(stats?.fiProbabilityP95 ?? 0);

	const verdictTone = $derived(
		lifetimeProbability >= FI_TARGET_SUCCESS_PROBABILITY
			? 'good'
			: lifetimeProbability >= 0.8
				? 'warn'
				: 'bad'
	);

	/** Money-terms position at the retirement date, used by the accumulation card. */
	const capitalToday = $derived(alreadyRetired ? input.currentSavings : (stats?.retireMedian ?? 0));
	const capitalGap = $derived(capitalToday - (stats?.fiTargetP95 ?? 0));
	const capitalMargin = $derived(
		stats && stats.fiTargetP95 > 0 ? capitalToday / stats.fiTargetP95 - 1 : 0
	);
	const accumulationTone = $derived(
		alreadyRetired
			? capitalMargin >= 0
				? 'good'
				: capitalMargin >= -0.15
					? 'warn'
					: 'bad'
			: retirementGoalProbability >= FI_TARGET_SUCCESS_PROBABILITY
				? 'good'
				: retirementGoalProbability >= 0.8
					? 'warn'
					: 'bad'
	);

	const depletionAgeWorstDecile = $derived(stats?.depletionAgeP10 ?? null);
	const depletionAgeMedian = $derived(stats?.depletionAgeP50 ?? null);

	/**
	 * Deliberately not the lifetime probability again — this card grades *when* a bad case
	 * arrives, which is a different question from how often one does. Running out at 94 and
	 * running out at 70 are the same failure to the headline number and nothing alike here,
	 * so an early worst-decile depletion is graded critical even when the median survives.
	 */
	const drawdownTone = $derived.by(() => {
		if (!stats || depletionAgeWorstDecile == null) return stats ? 'good' : 'bad';
		if (depletionAgeMedian != null) return 'bad';
		const midRetirement = (input.retirementAge + input.simulateUntilAge) / 2;
		return depletionAgeWorstDecile < midRetirement ? 'bad' : 'warn';
	});

	const bestScenario = $derived(actionableRecommendations?.bestTestedScenario ?? null);
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
		<!-- Verdict: the result, what to change about it, and the caveat, in one place. -->
		<section class="card verdict-card tone-{verdictTone}" aria-labelledby="verdict-title">
			<p class="verdict-eyebrow">Plan assessment</p>
			<!--
				Headline, figure and caption are one sentence. Splitting them stranded the number
				between two lines that said the same thing twice. One sentence shape serves every
				state — the count and the tone colour carry the verdict, so nothing needs rewording.
			-->
			<h3 id="verdict-title" class="stat-sentence">
				<strong class="mono-value">{lifetimeScore}</strong> of 100 simulations fund your plan
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

			<p class="verdict-detail">
				{#if verdictTone === 'good'}
					That is at or above the {targetPercent} of 100 planning goal used here: every planned month
					was funded, from now through age {fmtNum(input.simulateUntilAge)}.
				{:else if lifetimeScore === 0}
					Spending ran short before age {fmtNum(input.simulateUntilAge)} in every simulated market history,
					against a {targetPercent} of 100 goal.
				{:else}
					That is {gapPoints}
					{gapPoints === 1 ? 'point' : 'points'} below the {targetPercent} of 100 goal. The other {100 -
						lifetimeScore} ran short at some point before age {fmtNum(input.simulateUntilAge)}.
				{/if}
			</p>

			<div class="verdict-next">
				{#if actionableRecommendations?.targetResult === 'already-met'}
					<h4>What to check next</h4>
					<p>
						Before relying on this, re-run it with lower returns, higher inflation, a different
						market region, and higher later-life spending. A plan that only clears the goal under
						one set of assumptions is not yet a resilient plan.
					</p>
				{:else if actionableRecommendations?.targetResult === 'single-lever'}
					<h4>What would close the gap</h4>
					<p class="next-lead">Either change reached the goal on its own in the model:</p>
					<ul class="lever-list">
						{#if actionableRecommendations.yearlySpendingReduction != null}
							<li>
								<span>Spend less</span>
								<strong class="mono-value"
									>{fmtCompactCurrency(
										actionableRecommendations.yearlySpendingReduction
									)}/yr</strong
								>
							</li>
						{/if}
						{#if actionableRecommendations.monthsLonger != null}
							<li>
								<span>Retire later</span>
								<strong class="mono-value"
									>{fmtNum(actionableRecommendations.monthsLonger)} months</strong
								>
							</li>
						{/if}
					</ul>
				{:else if actionableRecommendations?.targetResult === 'combined' && actionableRecommendations.combinedScenario}
					<h4>What would close the gap</h4>
					<p class="next-lead">No single change was enough; together these reached the goal:</p>
					<ul class="lever-list">
						<li>
							<span>Spend less</span>
							<strong class="mono-value"
								>{Math.round(
									(1 - actionableRecommendations.combinedScenario.spendingMultiplier) * 100
								)}%</strong
							>
						</li>
						<li>
							<span>Retire at</span>
							<strong class="mono-value"
								>age {fmtNum(actionableRecommendations.combinedScenario.retirementAge)}</strong
							>
						</li>
						<li>
							<span>Result</span>
							<strong class="mono-value"
								>{Math.round(actionableRecommendations.combinedScenario.successProbability * 100)} of
								100</strong
							>
						</li>
					</ul>
				{:else}
					<h4>What would close the gap</h4>
					<p class="next-lead">
						{#if bestScenario}
							Nothing in the tested range reached {targetPercent} of 100. The strongest tested result
							was
							<strong>{Math.round(bestScenario.successProbability * 100)} of 100</strong
							>{#if bestScenarioChanges.length > 0}, using {bestScenarioChanges.join(' and ')}{/if}.
						{:else}
							No tested adjustment reached {targetPercent} of 100.
						{/if}
					</p>
					<p>
						This needs a larger redesign than one lever: revisit essential versus discretionary
						spending, retirement timing, pensions and other income, lump sums, taxes, and how long
						the plan must last.
					</p>
					{#if actionableRecommendations && !actionableRecommendations.retirementDelayAvailable && !alreadyRetired}
						<p class="next-caveat">
							A later-retirement estimate is not shown because another income source ends inside the
							tested age range, so assuming it continues would overstate the result.
						</p>
					{/if}
				{/if}
			</div>

			<p class="verdict-disclaimer" role="note">
				<strong>Planning estimate — not personal financial advice.</strong> Figures above are tested model
				scenarios, not recommendations, and depend entirely on the inputs and market assumptions you chose.
				Weigh your full circumstances and regulated professional advice before acting.
			</p>
		</section>

		<div class="phase-grid">
			<section class="card phase-card tone-{accumulationTone}" aria-labelledby="accumulation-title">
				<p class="phase-eyebrow">{alreadyRetired ? 'Starting position' : 'Before retirement'}</p>
				<h3 id="accumulation-title" class="stat-sentence">
					<strong class="mono-value">{fmtCompactCurrency(capitalToday)}</strong>
					{#if alreadyRetired}
						portfolio today, at the start of the plan
					{:else}
						median projected portfolio at retirement age {fmtNum(input.retirementAge)}
					{/if}
				</h3>

				{#if !alreadyRetired}
					<p class="phase-range mono-value">
						Range of outcomes: {fmtCompactCurrency(stats.retireLow)}–{fmtCompactCurrency(
							stats.retireHigh
						)} (central 80%)
					</p>
				{/if}

				<dl class="phase-facts">
					<div>
						<dt>Capital needed for the goal</dt>
						<dd class="mono-value">{fmtCompactCurrency(stats.fiTargetP95)}</dd>
					</div>
					<div>
						<dt>{alreadyRetired ? 'Position versus that' : 'Median versus that'}</dt>
						<dd
							class="mono-value"
							class:amount-positive={capitalGap >= 0}
							class:amount-negative={capitalGap < 0}
						>
							{fmtSignedCurrency(capitalGap)} ({fmtMargin(capitalMargin)})
						</dd>
					</div>
					{#if !alreadyRetired}
						<div>
							<dt>Chance of reaching it by then</dt>
							<dd class="mono-value">{percentFormatter.format(retirementGoalProbability)}</dd>
						</div>
					{/if}
				</dl>

				<p class="phase-note">
					{#if alreadyRetired}
						Retirement has already started, so this is a capital comparison rather than a
						projection.
					{:else if stats.coastAge != null}
						Coast point: regular saving could stop at age {Math.ceil(stats.coastAge)} and the plan still
						reaches this target in the model. Planned deficits and lump sums still apply.
					{:else}
						No coast point: there are no regular contributions to stop, or the target stays out of
						reach even with them.
					{/if}
				</p>
			</section>

			<section class="card phase-card tone-{drawdownTone}" aria-labelledby="drawdown-title">
				<p class="phase-eyebrow">After retirement</p>
				<!--
					One decile, one question: what actually happens down there? The verdict card
					already owns *how often* a plan fails, so restating a probability here would be
					noise — this card only ever reports an outcome the verdict cannot show.

					An age, when the money runs out: it beats "years at a zero balance", which was
					measured against an end-of-plan age the user picked arbitrarily. A balance, when
					it does not: still money, still higher-is-better, so it never reads as a
					reversed-polarity twin of the capital figure in the card to its left. Both
					branches keep the figure first and the qualifier in the same trailing clause.
				-->
				<h3 id="drawdown-title" class="stat-sentence">
					{#if depletionAgeWorstDecile != null}
						<strong class="mono-value">age {fmtNum(Math.floor(depletionAgeWorstDecile))}</strong>
						is when the money ran out, in the worst 10% of simulations
					{:else}
						<strong class="mono-value">{fmtCompactCurrency(stats.finalLow)}</strong>
						still left at age {fmtNum(input.simulateUntilAge)} in the worst 10% of simulations
					{/if}
				</h3>

				{#if depletionAgeMedian != null}
					<p class="phase-range">
						Even the median future ran out, by age {fmtNum(Math.floor(depletionAgeMedian))}.
					</p>
				{:else if depletionAgeWorstDecile != null}
					<p class="phase-range">More than half of all futures never ran out at all.</p>
				{/if}

				<dl class="phase-facts">
					{#if stats.shortfallHigh > 0}
						<div>
							<dt>Spending left unfunded</dt>
							<dd class="mono-value amount-negative">−{fmtCompactCurrency(stats.shortfallHigh)}</dd>
						</div>
						<div>
							<dt>Years spent at a zero balance</dt>
							<dd class="mono-value" class:amount-negative={stats.depletedYearsHigh > 0}>
								{fmtNum(stats.depletedYearsHigh, 1)}
							</dd>
						</div>
					{/if}
					<div>
						<dt>Left at age {fmtNum(input.simulateUntilAge)} · median future</dt>
						<dd class="mono-value">{fmtCompactCurrency(stats.finalMedian)}</dd>
					</div>
					<div>
						<dt>Left at age {fmtNum(input.simulateUntilAge)} · best 10%</dt>
						<dd class="mono-value">{fmtCompactCurrency(stats.finalHigh)}</dd>
					</div>
				</dl>

				<p class="phase-note">
					{#if depletionAgeWorstDecile != null}
						This age is the first month planned spending could not be met in full. Later income or a
						lump sum can lift the balance above zero again afterwards, so it marks the onset of
						trouble rather than a permanent end.
					{:else}
						No future in the weakest decile exhausted the portfolio, so market sequence alone did
						not break this plan. The assumptions above — returns, inflation, spending, longevity —
						still can.
					{/if}
				</p>
			</section>
		</div>

		<details class="model-scope">
			<summary>What this assessment includes</summary>
			<p>
				Retirement timing, changing spending periods, pensions and other income, lump sums, taxes
				and fees, inflation, withdrawal strategy, and simulated sequences of market returns. The
				advanced statistics below carry the numerical diagnostics and model precision.
			</p>
		</details>
	</div>
{/if}
