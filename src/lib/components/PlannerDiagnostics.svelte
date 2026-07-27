<script lang="ts">
	let { stats, input, simCount = 0, percentFormatter, fmtNum, fmtCompactCurrency } = $props();

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
</script>

{#if stats}
	<details class="card diagnostics-card">
		<summary>Advanced statistics and model diagnostics</summary>
		<p class="diagnostics-intro">
			Detailed outcome percentiles, sampling precision, sensitivity-test coverage, and the return
			distribution used for this run. Hidden by default because these figures support—not
			replace—the planning assessment above.
		</p>
		<div class="diagnostics-grid">
			<section>
				<h4>Planning probabilities and targets</h4>
				<dl class="diagnostics-table mono-value">
					<div>
						<dt>Spending fully covered</dt>
						<dd>{percentFormatter.format(stats.successProbability)}</dd>
					</div>
					<div>
						<dt>Reach simulation target</dt>
						<dd>{percentFormatter.format(stats.fiProbabilityP95)}</dd>
					</div>
					<div>
						<dt>Reach spending-rule estimate</dt>
						<dd>{percentFormatter.format(stats.fiProbabilitySWR)}</dd>
					</div>
					<div>
						<dt>Simulation-based target</dt>
						<dd>{fmtCompactCurrency(stats.fiTargetP95)}</dd>
					</div>
					<div>
						<dt>Spending-rule estimate</dt>
						<dd>{fmtCompactCurrency(stats.fiTargetSWR)}</dd>
					</div>
				</dl>
			</section>

			<section>
				<h4>Outcome percentiles</h4>
				<dl class="diagnostics-table mono-value">
					<div>
						<dt>At retirement · P10</dt>
						<dd>{fmtCompactCurrency(stats.retireLow)}</dd>
					</div>
					<div>
						<dt>At retirement · median</dt>
						<dd>{fmtCompactCurrency(stats.retireMedian)}</dd>
					</div>
					<div>
						<dt>At retirement · P90</dt>
						<dd>{fmtCompactCurrency(stats.retireHigh)}</dd>
					</div>
					<div>
						<dt>Ending balance · P10</dt>
						<dd>{fmtCompactCurrency(stats.finalLow)}</dd>
					</div>
					<div>
						<dt>Ending balance · median</dt>
						<dd>{fmtCompactCurrency(stats.finalMedian)}</dd>
					</div>
					<div>
						<dt>Ending balance · P90</dt>
						<dd>{fmtCompactCurrency(stats.finalHigh)}</dd>
					</div>
					<div>
						<dt>Shortfall · worst 10%</dt>
						<dd>{fmtCompactCurrency(stats.shortfallHigh)}</dd>
					</div>
					<div>
						<dt>Zero-balance years · worst 10%</dt>
						<dd>{fmtNum(stats.depletedYearsHigh, 1)}</dd>
					</div>
				</dl>
			</section>

			<section>
				<h4>Simulation reliability</h4>
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
					Requested shape: skew {fmtNum(stats.requestedReturnMoments.skewness, 2)} · kurtosis
					{fmtNum(stats.requestedReturnMoments.kurtosis, 2)}
				</p>
				<p class="mono-value">
					Effective shape: skew {fmtNum(stats.returnMoments.skewness, 2)} · kurtosis
					{fmtNum(stats.returnMoments.kurtosis, 2)}
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
