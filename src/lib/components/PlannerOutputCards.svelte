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

	function fmtMargin(margin: number): string {
		const pct = margin * 100;
		return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
	}
</script>

{#if stats}
	<div class="results-summary">
		<section
			class="card result-hero"
			class:result-hero-positive={stats.successProbability >= 0.9}
			class:result-hero-warning={stats.successProbability >= 0.7 && stats.successProbability < 0.9}
			class:result-hero-negative={stats.successProbability < 0.7}
			aria-labelledby="plan-outlook-title"
		>
			<div class="result-hero-main">
				<div>
					<h3 id="plan-outlook-title">Your plan outlook</h3>
					<div class="hero-probability mono-value">
						{Math.round(stats.successProbability * 100)} <span>of 100</span>
					</div>
				</div>
				<p class="hero-copy">
					simulated futures cover all of your planned spending through age
					<strong>{fmtNum(input.simulateUntilAge)}</strong>.
				</p>
			</div>

			{#if stats.successProbability < FI_TARGET_SUCCESS_PROBABILITY && actionableRecommendations}
				{#if actionableRecommendations.yearlySpendingReduction != null || actionableRecommendations.monthsLonger != null}
					<p class="hero-action">
						<span
							>To reach {(FI_TARGET_SUCCESS_PROBABILITY * 100).toFixed(0)}% in the tested scenarios:</span
						>
						{#if actionableRecommendations.yearlySpendingReduction != null}
							<strong
								>Spend {fmtCompactCurrency(actionableRecommendations.yearlySpendingReduction)}/yr
								less</strong
							>
							{#if actionableRecommendations.monthsLonger != null}<span class="action-or">or</span
								>{/if}
						{/if}
						{#if actionableRecommendations.monthsLonger != null}
							<strong>Work {fmtNum(actionableRecommendations.monthsLonger)} months longer</strong>
						{/if}
					</p>
				{/if}
			{/if}

			<p class="hero-definition">
				A future counts as covered only when every month of planned spending is met.
			</p>
		</section>

		<section class="card readiness-card" aria-labelledby="readiness-title">
			<div class="section-heading-row">
				<div>
					<h3 id="readiness-title">
						{alreadyRetired
							? 'Retirement funding today'
							: `On track for retirement at age ${input.retirementAge}`}
					</h3>
					<p class="section-intro">
						{alreadyRetired
							? 'Compare your current portfolio with two estimates of the capital your plan may need.'
							: 'Compare your projected portfolio with two estimates of the capital your plan may need.'}
					</p>
				</div>
			</div>

			<div class="readiness-grid">
				<div class="readiness-metric primary-metric">
					<h4>Simulation-based target</h4>
					<div class="readiness-value mono-value">{fmtCompactCurrency(stats.fiTargetP95)}</div>
					{#if alreadyRetired}
						<p class:amount-positive={capitalMargin >= 0} class:amount-negative={capitalMargin < 0}>
							Your portfolio is {fmtMargin(capitalMargin)} versus this target
						</p>
					{:else}
						<p
							class:amount-positive={stats.fiProbabilityP95 >= 0.7}
							class:amount-negative={stats.fiProbabilityP95 < 0.7}
						>
							{percentFormatter.format(stats.fiProbabilityP95)} chance of reaching it
						</p>
					{/if}
					<span
						>Capital associated with a {(FI_TARGET_SUCCESS_PROBABILITY * 100).toFixed(0)}% planning
						goal.</span
					>
				</div>

				<div class="readiness-metric">
					<h4>{alreadyRetired ? 'Portfolio today' : `Projected at age ${input.retirementAge}`}</h4>
					<div class="readiness-value mono-value">
						{fmtCompactCurrency(alreadyRetired ? input.currentSavings : stats.retireMedian)}
					</div>
					{#if alreadyRetired}
						<p>Available capital</p>
					{:else}
						<p class="mono-value">
							10–90% range: {fmtCompactCurrency(stats.retireLow)}–{fmtCompactCurrency(
								stats.retireHigh
							)}
						</p>
					{/if}
					<span
						>{alreadyRetired
							? 'The amount being tested against both targets.'
							: 'The median and central range across simulated futures.'}</span
					>
				</div>

				<div class="readiness-metric secondary-metric">
					<h4>Spending-rule estimate</h4>
					<div class="readiness-value mono-value">{fmtCompactCurrency(stats.fiTargetSWR)}</div>
					{#if alreadyRetired}
						<p class:amount-positive={swrMargin >= 0} class:amount-negative={swrMargin < 0}>
							Your portfolio is {fmtMargin(swrMargin)} versus this estimate
						</p>
					{:else}
						<p
							class:amount-positive={stats.fiProbabilitySWR >= 0.7}
							class:amount-negative={stats.fiProbabilitySWR < 0.7}
						>
							{percentFormatter.format(stats.fiProbabilitySWR)} chance of reaching it
						</p>
					{/if}
					<span>Rule-of-thumb comparison using your chosen withdrawal rate.</span>
				</div>
			</div>

			<div class="coast-callout">
				{#if alreadyRetired}
					<strong>Coast age:</strong> Not applicable because you are already retired.
				{:else if stats.coastAge != null}
					<strong>You could stop regular saving at age {Math.ceil(stats.coastAge)}</strong> and
					still reach the
					{(FI_TARGET_SUCCESS_PROBABILITY * 100).toFixed(0)}% goal; planned deficits and lump sums
					still apply.
				{:else}
					<strong>Coast age is not available.</strong> There are no regular contributions to stop, or
					the goal remains out of reach.
				{/if}
			</div>
		</section>

		<details class="card downside-card" open={stats.successProbability < 0.9}>
			<summary>
				<span>If the plan falls short</span>
				<span class="downside-summary mono-value">
					Worst 10% shortfall: {fmtCompactCurrency(stats.shortfallHigh)}
				</span>
			</summary>
			<p class="downside-definition">
				These figures describe the size of unsuccessful outcomes; they are separate from the chance
				shown above.
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
	</div>
{/if}
