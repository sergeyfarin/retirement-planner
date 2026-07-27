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
	const retirementGoalProbability = $derived(stats?.fiProbabilityP95 ?? 0);
	const lifetimeProbability = $derived(stats?.successProbability ?? 0);
	const lowestPhaseProbability = $derived(Math.min(retirementGoalProbability, lifetimeProbability));
	const meetsBothGoals = $derived(
		retirementGoalProbability >= FI_TARGET_SUCCESS_PROBABILITY &&
			lifetimeProbability >= FI_TARGET_SUCCESS_PROBABILITY
	);
	const assessmentTitle = $derived.by(() => {
		if (meetsBothGoals) return `Plan meets the tested ${targetPercent}% goal`;
		if (alreadyRetired && retirementGoalProbability < FI_TARGET_SUCCESS_PROBABILITY) {
			return 'Current capital is below the simulation-based target';
		}
		if (retirementGoalProbability < 0.5 && lifetimeProbability < 0.5) {
			return 'Both phases have a substantial funding gap';
		}
		if (lifetimeProbability < 0.5) return 'More lifetime scenarios fall short than succeed';
		if (retirementGoalProbability < 0.5) {
			return 'Reaching the retirement target is the main constraint';
		}
		if (
			retirementGoalProbability >= FI_TARGET_SUCCESS_PROBABILITY &&
			lifetimeProbability < FI_TARGET_SUCCESS_PROBABILITY
		) {
			return 'Retirement capital is within reach, but lifetime spending needs attention';
		}
		if (
			lifetimeProbability >= FI_TARGET_SUCCESS_PROBABILITY &&
			retirementGoalProbability < FI_TARGET_SUCCESS_PROBABILITY
		) {
			return 'Lifetime funding is resilient if the retirement target is reached';
		}
		return `Plan is below the tested ${targetPercent}% goal`;
	});

	const capitalMargin = $derived(
		alreadyRetired && stats && stats.fiTargetP95 > 0
			? input.currentSavings / stats.fiTargetP95 - 1
			: 0
	);
	const swrMargin = $derived(
		alreadyRetired && stats && stats.fiTargetSWR > 0
			? input.currentSavings / stats.fiTargetSWR - 1
			: 0
	);
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
</script>

{#if stats}
	<div class="results-summary">
		<section
			class="card assessment-card"
			class:assessment-positive={meetsBothGoals}
			class:assessment-warning={!meetsBothGoals && lowestPhaseProbability >= 0.5}
			class:assessment-critical={lowestPhaseProbability < 0.5}
			aria-labelledby="assessment-title"
		>
			<p class="assessment-eyebrow">Plan assessment</p>
			<h3 id="assessment-title">{assessmentTitle}</h3>

			<div class="horizon-grid">
				<div class="horizon-result">
					<p class="horizon-label">
						{alreadyRetired ? 'Today' : `At retirement · age ${input.retirementAge}`}
					</p>
					<div class="horizon-value mono-value">
						{#if alreadyRetired}
							{fmtMargin(capitalMargin)}
						{:else}
							{Math.round(retirementGoalProbability * 100)} <span>of 100</span>
						{/if}
					</div>
					<p>
						{alreadyRetired
							? `${fmtCompactCurrency(input.currentSavings)} compared with the simulation-based capital target.`
							: 'simulated futures reach the simulation-based capital target by retirement.'}
					</p>
				</div>

				<div class="horizon-connector" aria-hidden="true">→</div>

				<div class="horizon-result">
					<p class="horizon-label">Through retirement · age {fmtNum(input.simulateUntilAge)}</p>
					<div class="horizon-value mono-value">
						{Math.round(lifetimeProbability * 100)} <span>of 100</span>
					</div>
					<p>simulated futures cover every month of planned spending.</p>
				</div>
			</div>
		</section>

		<div class="results-disclaimer" role="note" aria-label="Important planning limitation">
			<strong>Planning estimate—not personal financial advice.</strong>
			Results depend on your inputs and market assumptions; they are not forecasts or guarantees. Consider
			your complete circumstances and regulated professional advice before making a major retirement,
			investment, or spending decision.
		</div>

		<section class="card action-card" aria-labelledby="action-title">
			{#if actionableRecommendations?.targetResult === 'already-met'}
				<div>
					<p class="action-eyebrow">What to do next</p>
					<h3 id="action-title">Test whether the result remains resilient</h3>
					<p>
						The plan meets the goal under these assumptions. Before relying on it, compare lower
						returns, higher inflation, other market regions, and changes to later-life spending.
					</p>
				</div>
			{:else if actionableRecommendations?.targetResult === 'single-lever'}
				<div>
					<p class="action-eyebrow">Tested paths toward {targetPercent}%</p>
					<h3 id="action-title">A single change reached the goal in the model</h3>
					<div class="action-options">
						{#if actionableRecommendations.yearlySpendingReduction != null}
							<div>
								<span>Spending scenario</span>
								<strong
									>{fmtCompactCurrency(actionableRecommendations.yearlySpendingReduction)}/yr lower</strong
								>
							</div>
						{/if}
						{#if actionableRecommendations.monthsLonger != null}
							<div>
								<span>Retirement scenario</span>
								<strong>{fmtNum(actionableRecommendations.monthsLonger)} months later</strong>
							</div>
						{/if}
					</div>
					<p class="action-caveat">
						These are independently tested model scenarios, not personal recommendations. Compare
						their practical and tax consequences before choosing a change.
					</p>
				</div>
			{:else if actionableRecommendations?.targetResult === 'combined' && actionableRecommendations.combinedScenario}
				<div>
					<p class="action-eyebrow">Tested path toward {targetPercent}%</p>
					<h3 id="action-title">The tested changes only reached the goal when combined</h3>
					<p class="combined-action">
						<strong
							>{Math.round(
								(1 - actionableRecommendations.combinedScenario.spendingMultiplier) * 100
							)}% lower spending</strong
						>
						<span>and</span>
						<strong
							>retirement at age {fmtNum(
								actionableRecommendations.combinedScenario.retirementAge
							)}</strong
						>
						produced {Math.round(
							actionableRecommendations.combinedScenario.successProbability * 100
						)} of 100 fully funded scenarios in the sensitivity test.
					</p>
					<p class="action-caveat">
						Neither change reached the goal alone. This is a tested scenario, not a personal
						recommendation.
					</p>
				</div>
			{:else}
				<div>
					<p class="action-eyebrow">Plan revision needed</p>
					<h3 id="action-title">No tested adjustment reached the {targetPercent}% goal</h3>
					{#if bestScenario}
						<p class="best-scenario">
							The strongest result within the tested range was
							<strong>{Math.round(bestScenario.successProbability * 100)} of 100</strong> fully
							funded futures{#if bestScenarioChanges.length > 0}, using {bestScenarioChanges.join(
									' and '
								)}{/if}.
						</p>
					{/if}
					<p>
						A larger redesign or several coordinated changes may be needed. Review essential versus
						discretionary spending, retirement timing, pensions and other income, lump sums, taxes,
						longevity needs, and your ability to absorb losses.
					</p>
					{#if actionableRecommendations && !actionableRecommendations.retirementDelayAvailable && !alreadyRetired}
						<p class="action-caveat">
							A later-retirement estimate is not shown because another income source ends inside the
							tested age range; assuming that income continues would be misleading.
						</p>
					{/if}
				</div>
			{/if}
		</section>

		<section class="card phase-card" aria-labelledby="retirement-phase-title">
			<div class="phase-heading">
				<span>1</span>
				<div>
					<p>{alreadyRetired ? 'Starting position' : 'Before retirement'}</p>
					<h3 id="retirement-phase-title">
						{alreadyRetired
							? 'Retirement funding today'
							: `At retirement · age ${input.retirementAge}`}
					</h3>
				</div>
			</div>

			<div class="metric-grid">
				<div class="metric-panel primary-metric">
					<h4>Simulation-based target</h4>
					<strong class="metric-value mono-value">{fmtCompactCurrency(stats.fiTargetP95)}</strong>
					{#if alreadyRetired}
						<p class:amount-positive={capitalMargin >= 0} class:amount-negative={capitalMargin < 0}>
							Current portfolio is {fmtMargin(capitalMargin)} versus this target
						</p>
					{:else}
						<p
							class:amount-positive={retirementGoalProbability >= FI_TARGET_SUCCESS_PROBABILITY}
							class:amount-negative={retirementGoalProbability < 0.5}
						>
							{percentFormatter.format(retirementGoalProbability)} chance of reaching it
						</p>
					{/if}
					<span>Capital associated with the {targetPercent}% lifetime planning goal.</span>
				</div>

				<div class="metric-panel">
					<h4>{alreadyRetired ? 'Portfolio today' : 'Projected portfolio'}</h4>
					<strong class="metric-value mono-value">
						{fmtCompactCurrency(alreadyRetired ? input.currentSavings : stats.retireMedian)}
					</strong>
					{#if alreadyRetired}
						<p>Capital available at the start of the plan</p>
					{:else}
						<p class="mono-value">
							10–90% range: {fmtCompactCurrency(stats.retireLow)}–{fmtCompactCurrency(
								stats.retireHigh
							)}
						</p>
					{/if}
					<span
						>{alreadyRetired
							? 'Compared with both targets.'
							: 'Median and central 80% of simulated outcomes.'}</span
					>
				</div>

				<div class="metric-panel secondary-metric">
					<h4>Spending-rule comparison</h4>
					<strong class="metric-value mono-value">{fmtCompactCurrency(stats.fiTargetSWR)}</strong>
					{#if alreadyRetired}
						<p class:amount-positive={swrMargin >= 0} class:amount-negative={swrMargin < 0}>
							Current portfolio is {fmtMargin(swrMargin)} versus this estimate
						</p>
					{:else}
						<p>{percentFormatter.format(stats.fiProbabilitySWR)} chance of reaching it</p>
					{/if}
					<span>Rule-of-thumb comparison using the selected withdrawal rate.</span>
				</div>
			</div>

			<div class="coast-callout">
				{#if alreadyRetired}
					<strong>Coast age:</strong> Not applicable because retirement has already started.
				{:else if stats.coastAge != null}
					<strong>Regular saving could stop at age {Math.ceil(stats.coastAge)}</strong> while still
					reaching the {targetPercent}% goal in the model; planned deficits and lump sums still
					apply.
				{:else}
					<strong>Coast age is not available.</strong> There are no regular contributions to stop, or
					the target remains out of reach.
				{/if}
			</div>
		</section>

		<section class="card phase-card" aria-labelledby="lifetime-phase-title">
			<div class="phase-heading">
				<span>2</span>
				<div>
					<p>After retirement</p>
					<h3 id="lifetime-phase-title">
						Through retirement · age {fmtNum(input.simulateUntilAge)}
					</h3>
				</div>
			</div>

			<div class="lifetime-overview">
				<div>
					<h4>Spending fully covered</h4>
					<strong class="metric-value mono-value"
						>{percentFormatter.format(lifetimeProbability)}</strong
					>
					<p>Every planned month was funded in this share of simulated futures.</p>
				</div>
				<div>
					<h4>Ending balance</h4>
					<strong class="metric-value mono-value"
						>{fmtCompactCurrency(stats.finalMedian)} median</strong
					>
					<p class="mono-value">
						10–90% range: {fmtCompactCurrency(stats.finalLow)}–{fmtCompactCurrency(stats.finalHigh)}
					</p>
				</div>
			</div>

			<details class="downside-details" open={lifetimeProbability < FI_TARGET_SUCCESS_PROBABILITY}>
				<summary>
					<span>What weaker outcomes look like</span>
					<span class="mono-value"
						>Worst 10% shortfall: {fmtCompactCurrency(stats.shortfallHigh)}</span
					>
				</summary>
				<p class="downside-definition">
					A future counts as unsuccessful after even one short month. These figures show the size
					and duration of misses, so a small shortfall is not treated like a prolonged depletion.
				</p>
				<div class="downside-grid">
					<div>
						<h4>Cumulative spending shortfall</h4>
						<p class="mono-value">
							<span class:amount-negative={stats.shortfallHigh > 0}
								>Worst 10%: {fmtCompactCurrency(stats.shortfallHigh)}</span
							>
							<span>Median: {fmtCompactCurrency(stats.shortfallMedian)}</span>
							<span>Best 10%: {fmtCompactCurrency(stats.shortfallLow)}</span>
						</p>
					</div>
					<div>
						<h4>Years at zero balance</h4>
						<p class="mono-value">
							<span class:amount-negative={stats.depletedYearsHigh > 0}
								>Worst 10%: {fmtNum(stats.depletedYearsHigh, 1)}</span
							>
							<span>Median: {fmtNum(stats.depletedYearsMedian, 1)}</span>
							<span>Best 10%: {fmtNum(stats.depletedYearsLow, 1)}</span>
						</p>
					</div>
				</div>
			</details>
		</section>

		<details class="model-scope">
			<summary>What this assessment includes</summary>
			<p>
				Retirement timing, changing spending periods, pensions and other income, lump sums, taxes
				and fees, inflation, withdrawal strategy, and simulated sequences of market returns. Open
				the advanced statistics below the charts for numerical diagnostics and model precision.
			</p>
		</details>
	</div>
{/if}
