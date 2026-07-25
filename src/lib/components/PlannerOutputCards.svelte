<script lang="ts">
	let {
		stats,
		input,
		fmtCompactCurrency,
		retirementYearlySpending = 0,
		FI_TARGET_SUCCESS_PROBABILITY = 0.95,
		percentFormatter,
		fmtNum,
		alreadyRetired = false,
		simCount = 0
	} = $props();

	// Already retired: "chance to reach FI by age X" has no future X to reach, and the
	// balance-at-retirement percentiles are today's capital repeated. The card is replaced
	// by the comparison that does apply — capital held against capital required. The engine
	// reports `fiTargetP95` as a required starting capital in this mode; see
	// `findRequiredStartingCapital`.
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

	// Monte Carlo standard error of a proportion: SE = sqrt(p(1-p)/N).
	// The ±1.96·SE band is the 95%-confidence margin on the success probability itself,
	// i.e. how much this number would wobble across repeated runs at this sample size.
	const successProbabilitySE = $derived(
		simCount > 0 && stats
			? Math.sqrt(
					(stats.successProbability * (1 - stats.successProbability)) / simCount
				)
			: 0
	);
</script>

{#if stats}
	<div class="summary-grid">
		<div class="card">
			<strong>Financial independence targets</strong>
			<div class="results-kpi mono-value">SWR: {fmtCompactCurrency(stats.fiTargetSWR)}</div>
			<div class="results-kpi mono-value">P95: {fmtCompactCurrency(stats.fiTargetP95)}</div>
			<div class="note mono-value">
				SWR target = expenses {fmtCompactCurrency(retirementYearlySpending)}/yr ÷ {(
					input.safeWithdrawalRate * 100
				).toFixed(1)}%
			</div>
			<div class="note mono-value">
				{#if alreadyRetired}
					P95 target = capital needed <em>today</em> for a {(
						FI_TARGET_SUCCESS_PROBABILITY * 100
					).toFixed(0)}%+ chance of ending balance above zero
				{:else}
					P95 target = portfolio at target FI year that implies {(
						FI_TARGET_SUCCESS_PROBABILITY * 100
					).toFixed(0)}%+ chance of ending balance above zero
				{/if}
			</div>
			<div
				class="note mono-value coast-note"
				title="Coast FIRE: from this age you could stop adding to the portfolio and let it compound, as long as your income still covers your spending (part-time or lower-paid work). Retirement age and spending are unchanged; only the contributions stop."
			>
				{#if alreadyRetired}
					Coast FIRE: n/a — there is no accumulation phase left to stop
				{:else if stats.coastAge != null}
					Coast FIRE: stop saving at age <strong>{Math.ceil(stats.coastAge)}</strong> and still
					clear {(FI_TARGET_SUCCESS_PROBABILITY * 100).toFixed(0)}%, if work still covers
					spending
				{:else}
					Coast FIRE: n/a — contributing until age {input.retirementAge} does not reach {(
						FI_TARGET_SUCCESS_PROBABILITY * 100
					).toFixed(0)}%
				{/if}
			</div>
		</div>
		{#if alreadyRetired}
			<div class="card">
				<strong>Capital today vs. targets</strong>
				<div class="results-kpi mono-value">{fmtCompactCurrency(input.currentSavings)}</div>
				<div
					class="note mono-value"
					class:amount-positive={swrMargin >= 0}
					class:amount-negative={swrMargin < 0}
				>
					{fmtMargin(swrMargin)} vs. SWR target
				</div>
				<div
					class="note mono-value"
					class:amount-positive={capitalMargin >= 0}
					class:amount-negative={capitalMargin < 0}
				>
					{fmtMargin(capitalMargin)} vs. P95 target
				</div>
				<div class="note mono-value">
					Already retired — there is no future balance to reach, so the question is whether
					today's capital clears the targets above.
				</div>
			</div>
		{:else}
			<div class="card">
				<strong>Chance to reach FI by age {input.retirementAge}</strong>
				<div
					class="results-kpi mono-value"
					class:amount-positive={stats.fiProbabilitySWR >= 0.7}
					class:amount-negative={stats.fiProbabilitySWR < 0.7}
				>
					SWR: {percentFormatter.format(stats.fiProbabilitySWR)}
				</div>
				<div
					class="results-kpi mono-value"
					class:amount-positive={stats.fiProbabilityP95 >= 0.7}
					class:amount-negative={stats.fiProbabilityP95 < 0.7}
				>
					P95: {percentFormatter.format(stats.fiProbabilityP95)}
				</div>
				<div class="note mono-value">
					Median by age {input.retirementAge}: {fmtCompactCurrency(stats.retireMedian)}
				</div>
				<div class="note mono-value">
					P10: {fmtCompactCurrency(stats.retireLow)} · P90: {fmtCompactCurrency(stats.retireHigh)}
				</div>
			</div>
		{/if}
		<div class="card">
			<strong>Ending balance distribution</strong>
			<div class="results-kpi mono-value">Median: {fmtCompactCurrency(stats.finalMedian)}</div>
			<div class="note mono-value">
				<span
					class:amount-positive={stats.finalLow > 0}
					class:amount-negative={stats.finalLow === 0}
					>P10: {fmtCompactCurrency(stats.finalLow)}</span
				>
				·
				<span
					class:amount-positive={stats.finalHigh > 0}
					class:amount-negative={stats.finalHigh === 0}
					>P90: {fmtCompactCurrency(stats.finalHigh)}</span
				>
			</div>
		</div>
		<div class="card">
			<strong>Portfolio survives to age {input.simulateUntilAge}</strong>
			<div
				class="results-kpi mono-value"
				class:amount-positive={stats.successProbability >= 0.9}
				class:amount-negative={stats.successProbability < 0.7}
			>
				{percentFormatter.format(stats.successProbability)}
			</div>
			{#if simCount > 0}
				<div
					class="note mono-value"
					title="Standard error of the success probability estimate: sqrt(p(1-p)/N). A narrower band means more simulations were run and the number is more precise."
				>
					±{(successProbabilitySE * 1.96 * 100).toFixed(1)}% at 95% confidence ({fmtNum(
						simCount
					)} simulations)
				</div>
			{/if}
			<div
				class="note mono-value"
				title="Percentiles of simulated outcomes, worst to best — not percentiles of the shortfall amount itself"
			>
				Cumulative shortfall —
				<span class:amount-negative={stats.shortfallHigh > 0}
					>Worst 10%: {fmtCompactCurrency(stats.shortfallHigh)}</span
				>
				·
				<span class:amount-negative={stats.shortfallMedian > 0}
					>Median: {fmtCompactCurrency(stats.shortfallMedian)}</span
				>
				·
				<span class:amount-negative={stats.shortfallLow > 0}
					>Best 10%: {fmtCompactCurrency(stats.shortfallLow)}</span
				>
			</div>
			<div
				class="note mono-value"
				title="Percentiles of simulated outcomes, worst to best — not percentiles of years-depleted itself"
			>
				Years at zero balance —
				<span class:amount-negative={stats.depletedYearsHigh > 0}
					>Worst 10%: {fmtNum(stats.depletedYearsHigh, 1)}</span
				>
				·
				<span class:amount-negative={stats.depletedYearsMedian > 0}
					>Median: {fmtNum(stats.depletedYearsMedian, 1)}</span
				>
				·
				<span class:amount-negative={stats.depletedYearsLow > 0}
					>Best 10%: {fmtNum(stats.depletedYearsLow, 1)}</span
				>
			</div>
		</div>
	</div>
{/if}
