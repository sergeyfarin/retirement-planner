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
	 * downside sizes — supports that answer and lives in the phase cards below.
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

	/** Money-terms position at the retirement date, used by the accumulation card. */
	const capitalToday = $derived(alreadyRetired ? input.currentSavings : (stats?.retireMedian ?? 0));
	const capitalGap = $derived(capitalToday - (stats?.fiTargetP95 ?? 0));
	const capitalMargin = $derived(
		stats && stats.fiTargetP95 > 0 ? capitalToday / stats.fiTargetP95 - 1 : 0
	);
	const failurePercent = $derived(Math.max(0, 100 - lifetimeScore));
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
		<section class="card verdict-card tone-{verdictTone}" aria-labelledby="verdict-title">
			<p class="verdict-eyebrow">Plan assessment · {verdictLabel}</p>
			<h3 id="verdict-title" class="stat-sentence">
				<strong class="mono-value">{lifetimeScore}%</strong> estimated chance your plan stays funded
				through age {fmtNum(input.simulateUntilAge)}
			</h3>
			{#if simCount > 0}
				<p class="simulation-count mono-value">
					Based on {fmtNum(simCount)} simulated market paths
				</p>
			{/if}

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

			<div class="verdict-next">
				{#if actionableRecommendations?.targetResult === 'already-met'}
					<h4>Resilience check</h4>
					{#if higherSpendingResult != null}
						<div class="scenario-result">
							<span>With 10% higher spending</span>
							<strong class="mono-value">{Math.round(higherSpendingResult * 100)}%</strong>
						</div>
					{/if}
					<p>
						Also compare lower returns, higher inflation, other market regions, and a longer
						lifetime.
					</p>
				{:else if actionableRecommendations?.targetResult === 'single-lever'}
					<h4>Changes estimated to reach the {targetPercent}% goal</h4>
					<ul class="lever-list">
						{#if actionableRecommendations.yearlySpendingReduction != null}
							<li>
								<span>Spend less each year</span>
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
					<h4>Combined change estimated to reach the goal</h4>
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
								>{Math.round(
									actionableRecommendations.combinedScenario.successProbability * 100
								)}%</strong
							>
						</li>
					</ul>
				{:else}
					<h4>A larger redesign is needed</h4>
					<p class="next-lead">
						{#if bestScenario}
							Nothing in the tested range reached {targetPercent}%. The strongest tested result was
							<strong>{Math.round(bestScenario.successProbability * 100)}%</strong
							>{#if bestScenarioChanges.length > 0}, using {bestScenarioChanges.join(' and ')}{/if}.
						{:else}
							No tested adjustment reached {targetPercent}%.
						{/if}
					</p>
					<p>
						Review spending, retirement timing, pensions or temporary income, lump sums, taxes, and
						the planning horizon.
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
				Tested scenarios, not personal financial advice. Results depend on the inputs and
				assumptions you chose.
			</p>
		</section>

		<section class="card retirement-snapshot" aria-labelledby="retirement-snapshot-title">
			<div class="snapshot-heading">
				<div>
					<p class="phase-eyebrow">Retirement readiness</p>
					<h3 id="retirement-snapshot-title" class="card-title">
						{alreadyRetired
							? 'Your portfolio today versus the plan target'
							: `At retirement age ${fmtNum(input.retirementAge)}`}
					</h3>
				</div>
				<span
					class:amount-positive={capitalGap >= 0}
					class:amount-negative={capitalGap < 0}
					class="snapshot-gap mono-value"
				>
					{fmtSignedCurrency(capitalGap)}
				</span>
			</div>
			<div class="snapshot-grid">
				<div>
					<span>{alreadyRetired ? 'Portfolio today' : 'Typical portfolio'}</span>
					<strong class="mono-value">{fmtCompactCurrency(capitalToday)}</strong>
				</div>
				<div>
					<span>Simulation-based target</span>
					<strong class="mono-value">{fmtCompactCurrency(stats.fiTargetP95)}</strong>
				</div>
				<div
					class:tile-good={retirementGoalProbability >= FI_TARGET_SUCCESS_PROBABILITY}
					class:tile-warn={retirementGoalProbability < FI_TARGET_SUCCESS_PROBABILITY}
				>
					<span>{alreadyRetired ? 'Position versus target' : 'Chance of reaching target'}</span>
					<strong class="mono-value"
						>{alreadyRetired
							? fmtMargin(capitalMargin)
							: percentFormatter.format(retirementGoalProbability)}</strong
					>
				</div>
			</div>
		</section>

		<section class="card downside-card tone-{drawdownTone}" aria-labelledby="drawdown-title">
			<p class="phase-eyebrow">Downside to understand</p>
			{#if stats.failureMedianDepletionAge != null && stats.failureMedianShortfall != null}
				<h3 id="drawdown-title" class="stat-sentence">
					<strong class="mono-value">{failurePercent}%</strong>
					of simulations ran short; among those, the typical first shortfall began around age {fmtNum(
						Math.floor(stats.failureMedianDepletionAge)
					)}
				</h3>
				<p class="stat-sentence stat-sentence-second">
					<strong class="mono-value">{fmtCompactCurrency(stats.failureMedianShortfall)}</strong>
					of planned spending went unfunded in a typical shortfall scenario
				</p>
				<p class="phase-note">
					The age and amount describe failed simulations only; the assessment above shows how often
					failure occurred.
				</p>
			{:else}
				<h3 id="drawdown-title" class="stat-sentence">
					<strong class="mono-value">{fmtCompactCurrency(stats.finalLow)}</strong>
					was still left at age {fmtNum(input.simulateUntilAge)} in a difficult 1-in-10 outcome
				</h3>
				<p class="stat-sentence stat-sentence-second">
					<strong class="mono-value">0%</strong> of simulated paths ran short
				</p>
				<p class="phase-note">
					No simulated failure was available to estimate a failure age or shortfall.
				</p>
			{/if}
		</section>

		<details class="card portfolio-details">
			<summary>Portfolio and target details</summary>
			<div class="portfolio-details-grid">
				<section>
					<h4>
						{alreadyRetired
							? 'Starting position'
							: `At retirement age ${fmtNum(input.retirementAge)}`}
					</h4>
					<dl class="phase-facts">
						{#if !alreadyRetired}
							<div>
								<dt>Difficult 1-in-10 outcome</dt>
								<dd class="mono-value">{fmtCompactCurrency(stats.retireLow)}</dd>
							</div>
						{/if}
						<div>
							<dt>{alreadyRetired ? 'Portfolio today' : 'Typical outcome'}</dt>
							<dd class="mono-value">{fmtCompactCurrency(capitalToday)}</dd>
						</div>
						{#if !alreadyRetired}
							<div>
								<dt>Strong 1-in-10 outcome</dt>
								<dd class="mono-value">{fmtCompactCurrency(stats.retireHigh)}</dd>
							</div>
						{/if}
						<div>
							<dt>Simulation-based target</dt>
							<dd class="mono-value">{fmtCompactCurrency(stats.fiTargetP95)}</dd>
						</div>
						<div>
							<dt>{alreadyRetired ? 'Position versus target' : 'Typical versus target'}</dt>
							<dd
								class="mono-value"
								class:amount-positive={capitalGap >= 0}
								class:amount-negative={capitalGap < 0}
							>
								{fmtSignedCurrency(capitalGap)} ({fmtMargin(capitalMargin)})
							</dd>
						</div>
						{#if !alreadyRetired}<div>
								<dt>Chance of reaching target</dt>
								<dd class="mono-value">{percentFormatter.format(retirementGoalProbability)}</dd>
							</div>{/if}
					</dl>
				</section>
				<section>
					<h4>At age {fmtNum(input.simulateUntilAge)}</h4>
					<dl class="phase-facts">
						<div>
							<dt>Difficult 1-in-10 outcome</dt>
							<dd class="mono-value">{fmtCompactCurrency(stats.finalLow)}</dd>
						</div>
						<div>
							<dt>Typical outcome</dt>
							<dd class="mono-value">{fmtCompactCurrency(stats.finalMedian)}</dd>
						</div>
						<div>
							<dt>Strong 1-in-10 outcome</dt>
							<dd class="mono-value">{fmtCompactCurrency(stats.finalHigh)}</dd>
						</div>
						<div>
							<dt>Years at zero · difficult outcome</dt>
							<dd class="mono-value" class:amount-negative={stats.depletedYearsHigh > 0}>
								{fmtNum(stats.depletedYearsHigh, 1)}
							</dd>
						</div>
					</dl>
				</section>
			</div>
			<p class="phase-note">
				The 4% rule and full percentile statistics are available in advanced statistics below.
			</p>
		</details>

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
