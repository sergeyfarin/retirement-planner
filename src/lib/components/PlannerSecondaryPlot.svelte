<script lang="ts">
	import type { PlotlyApi } from 'plotly.js-cartesian-dist-min';
	import { onDestroy, untrack } from 'svelte';
	import type { SimulationResult, SummaryStats } from '../retirementEngine';

	let {
		Plotly,
		plotReady = false,
		simulation = null,
		stats = null,
		retirementAge = 0,
		simulateUntilAge = 0,
		currencySymbol = '$',
		fmtCompactValue,
		fmtHoverCompactCurrency
	}: {
		Plotly: PlotlyApi | null;
		plotReady?: boolean;
		simulation?: SimulationResult | null;
		stats?: SummaryStats | null;
		retirementAge?: number;
		simulateUntilAge?: number;
		currencySymbol?: string;
		fmtCompactValue: (value: number) => string;
		fmtHoverCompactCurrency: (value: number) => string;
	} = $props();

	let ruinSurfaceEl: HTMLDivElement | null = $state(null);
	let sequenceRiskEl: HTMLDivElement | null = $state(null);

	// Precision of the heatmap. Each cell replays `sampleCount` stored paths, a cap that
	// is independent of the run's simulation count — so raising "Simulations" past the
	// cap does not sharpen this chart, which is worth telling the user explicitly.
	const surfaceSampleCount = $derived(stats?.ruinSurface?.sampleCount ?? 0);
	const worstCellMarginPercent = $derived.by(() => {
		const survivalRows = stats?.ruinSurface?.ruinProbabilities;
		if (!survivalRows || surfaceSampleCount <= 0) return 0;
		let worst = 0;
		for (const row of survivalRows) {
			for (const ruin of row) {
				const survival = Math.max(0, Math.min(1, 1 - ruin));
				const margin = 1.96 * Math.sqrt((survival * (1 - survival)) / surfaceSampleCount) * 100;
				if (margin > worst) worst = margin;
			}
		}
		return worst;
	});

	$effect(() => {
		const ruinSurface = stats?.ruinSurface;
		if (plotReady && Plotly && ruinSurfaceEl && ruinSurface) {
			untrack(drawRuinSurfaceChart);
		}
	});

	$effect(() => {
		const sequenceRisk = stats?.sequenceRisk;
		if (plotReady && Plotly && sequenceRiskEl && sequenceRisk?.length) {
			untrack(drawSequenceRiskChart);
		}
	});

	onDestroy(() => {
		if (Plotly && ruinSurfaceEl) {
			Plotly.purge(ruinSurfaceEl);
		}
		if (Plotly && sequenceRiskEl) {
			Plotly.purge(sequenceRiskEl);
		}
	});

	function drawRuinSurfaceChart() {
		if (!Plotly || !ruinSurfaceEl || !stats?.ruinSurface) return;

		const retirementAges = stats.ruinSurface.retirementAges;
		const spendingMultipliers = stats.ruinSurface.spendingMultipliers;
		// The engine collapses the retirement-age axis to a single column when the plan is
		// already in drawdown, because sweeping it there would compare scenarios that differ
		// only in when the withdrawal strategy starts. Relabel rather than pretend it is
		// still a two-way surface. See README §7.6.
		const spendingOnly = retirementAges.length === 1;
		const zValues = stats.ruinSurface.ruinProbabilities.map((row) =>
			row.map((value) => Math.max(0, Math.min(1, 1 - value)))
		);

		// Express the vertical axis as improvement, so the two useful directions are
		// literally up (spend less) and right (retire later).
		const spendingChanges = spendingMultipliers.map(
			(multiplier) => Math.round((1 - multiplier) * 1000) / 10
		);
		const baselineAgeIndex = retirementAges.reduce(
			(best, age, index) =>
				Math.abs(age - retirementAge) < Math.abs(retirementAges[best] - retirementAge)
					? index
					: best,
			0
		);
		const baselineSpendingIndex = spendingMultipliers.reduce(
			(best, multiplier, index) =>
				Math.abs(multiplier - 1) < Math.abs(spendingMultipliers[best] - 1) ? index : best,
			0
		);
		const currentPlanProbability = zValues[baselineSpendingIndex][baselineAgeIndex];
		const currentPlanColor =
			currentPlanProbability >= 0.95
				? '#16a34a'
				: currentPlanProbability >= 0.75
					? '#f59e0b'
					: currentPlanProbability >= 0.5
						? '#f97316'
						: '#dc2626';
		const colorscale: Array<[number, string]> = [
			[0, '#fee2e2'],
			[0.25, '#fecaca'],
			[0.5, '#fed7aa'],
			[0.75, '#fef3c7'],
			[0.9, '#d9f99d'],
			[0.95, '#86efac'],
			[0.975, '#4ade80'],
			[1, '#16a34a']
		];

		const contourTrace = {
			type: spendingOnly ? 'heatmap' : 'contour',
			x: retirementAges,
			y: spendingChanges,
			z: zValues,
			zmin: 0,
			zmax: 1,
			colorscale,
			contours: spendingOnly
				? undefined
				: {
						coloring: 'fill',
						showlabels: false,
						start: 0,
						end: 1,
						size: 0.025
					},
			line: spendingOnly ? undefined : { width: 0, smoothing: 0.75 },
			showscale: true,
			colorbar: {
				title: { text: 'Plan funded', side: 'right' },
				tickmode: 'array',
				tickvals: [0, 0.5, 0.75, 0.95, 1],
				ticktext: ['0%', '50%', '75%', '95% goal', '100%'],
				tickfont: { family: "'JetBrains Mono', monospace", size: 9 },
				titlefont: { family: 'Inter, system-ui, sans-serif', size: 10, color: '#475569' },
				thickness: 12,
				len: 0.9,
				y: 0.5,
				yanchor: 'middle'
			},
			hovertemplate: spendingOnly
				? 'Spending change %{y:.0f}%<br>Estimated chance funded %{z:.1%}<extra></extra>'
				: 'Retire at age %{x}<br>Spending change %{y:.0f}%<br>Estimated chance funded %{z:.1%}<extra></extra>'
		};
		const goalContour = {
			type: 'contour',
			x: retirementAges,
			y: spendingChanges,
			z: zValues,
			contours: { coloring: 'none', start: 0.95, end: 0.95, size: 0.01, showlabels: false },
			line: { width: 4, color: '#0f766e', smoothing: 0.75 },
			showscale: false,
			hoverinfo: 'skip',
			showlegend: false
		};
		const currentPlan = {
			type: 'scatter',
			mode: 'markers+text',
			x: [retirementAge],
			y: [0],
			text: [`${Math.round(currentPlanProbability * 100)}% chance funded`],
			textposition: 'top center',
			textfont: { size: 11, color: '#0f172a' },
			marker: {
				size: 15,
				color: currentPlanColor,
				symbol: 'circle',
				line: { width: 3, color: '#fff' }
			},
			hoverinfo: 'skip',
			showlegend: false
		};

		const retirementTicks = Array.from(
			new Set([retirementAges[0], retirementAge, retirementAges[retirementAges.length - 1]])
		).sort((a, b) => a - b);
		const spendingTicks = [Math.min(...spendingChanges), 0, Math.max(...spendingChanges)];
		const layout = {
			margin: { t: 24, l: 72, r: 66, b: 52 },
			paper_bgcolor: 'transparent',
			plot_bgcolor: 'rgba(255,255,255,0.5)',
			xaxis: {
				title: {
					text: spendingOnly ? 'Already retired' : 'Retirement age',
					font: { size: 11, color: '#64748b', family: 'Inter, system-ui, sans-serif' }
				},
				tickmode: 'array',
				tickvals: retirementTicks,
				ticktext: retirementTicks.map((age) => (spendingOnly ? `age ${age} (now)` : `${age}`)),
				tickfont: { family: "'JetBrains Mono', monospace", size: 10 },
				showgrid: false,
				fixedrange: true
			},
			yaxis: {
				title: {
					text: 'Change annual spending',
					font: { size: 11, color: '#64748b', family: 'Inter, system-ui, sans-serif' }
				},
				tickmode: 'array',
				tickvals: spendingTicks,
				ticktext: spendingTicks.map((change) =>
					change === 0 ? 'Current' : change > 0 ? `${change}% less` : `${Math.abs(change)}% more`
				),
				tickfont: { family: "'JetBrains Mono', monospace", size: 10 },
				fixedrange: true
			},
			font: { family: 'Inter, system-ui, sans-serif', color: '#475569', size: 10 },
			hoverlabel: { font: { family: 'Inter, system-ui, sans-serif', size: 10 } }
		};

		const config = {
			responsive: true,
			displayModeBar: false,
			staticPlot: false
		};

		void Plotly.react(
			ruinSurfaceEl,
			spendingOnly ? [contourTrace, currentPlan] : [contourTrace, goalContour, currentPlan],
			layout,
			config
		);
	}

	function buildYAxisTicksForRange(
		minValue: number,
		maxValue: number,
		targetSteps = 8
	): { values: number[]; labels: string[] } {
		if (!isFinite(minValue) || !isFinite(maxValue) || maxValue <= minValue) {
			return { values: [0], labels: ['0'] };
		}

		const roughStep = (maxValue - minValue) / Math.max(1, targetSteps);
		const magnitude = 10 ** Math.floor(Math.log10(roughStep));
		const normalized = roughStep / magnitude;
		const niceFactor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
		const step = niceFactor * magnitude;
		const minTick = Math.floor(minValue / step) * step;
		const maxTick = Math.ceil(maxValue / step) * step;

		const values: number[] = [];
		for (let current = minTick; current <= maxTick + step * 0.25; current += step) {
			const normalizedValue = Math.abs(current) < 1e-10 ? 0 : Number(current.toFixed(8));
			values.push(normalizedValue);
		}

		return {
			values,
			labels: values.map(fmtCompactValue)
		};
	}

	function buildYAxisTicks(maxValue: number): { values: number[]; labels: string[] } {
		if (!isFinite(maxValue) || maxValue <= 0) {
			return { values: [0], labels: ['0'] };
		}

		return buildYAxisTicksForRange(0, maxValue, 8);
	}

	function drawSequenceRiskChart() {
		if (!Plotly || !sequenceRiskEl || !stats?.sequenceRisk?.length) return;

		const plainLanguageBuckets = [
			'Worst early returns',
			'Below-average early returns',
			'Typical early returns',
			'Above-average early returns',
			'Best early returns'
		];
		const buckets = stats.sequenceRisk.map(
			(_row, index) => plainLanguageBuckets[index] ?? `Group ${index + 1}`
		);
		const ruinProbabilities = stats.sequenceRisk.map((row) => row.ruinProbability);
		const endingMedians = stats.sequenceRisk.map((row) => row.endingMedian);

		const traces = [
			{
				type: 'bar',
				x: buckets,
				y: ruinProbabilities,
				name: 'Ruin probability',
				marker: {
					color: ruinProbabilities.map((value) =>
						value >= 0.35 ? '#dc2626' : value <= 0.15 ? '#16a34a' : '#f59e0b'
					)
				},
				yaxis: 'y',
				hovertemplate: 'Bucket %{x}<br>Ruin %{y:.1%}<extra></extra>'
			},
			{
				type: 'scatter',
				mode: 'lines+markers',
				x: buckets,
				y: endingMedians,
				name: 'Ending median',
				yaxis: 'y2',
				line: { color: '#2563eb', width: 2 },
				marker: { size: 6, color: '#2563eb' },
				customdata: endingMedians.map((value) => fmtHoverCompactCurrency(value)),
				hovertemplate: 'Bucket %{x}<br>Ending median %{customdata}<extra></extra>'
			}
		];

		const endingMedianTicks = buildYAxisTicks(Math.max(...endingMedians, 0));

		const layout = {
			height: 220,
			margin: { t: 12, l: 44, r: 50, b: 44 },
			barmode: 'group',
			showlegend: false,
			paper_bgcolor: 'transparent',
			plot_bgcolor: 'rgba(255,255,255,0.45)',
			xaxis: {
				tickfont: { family: "'JetBrains Mono', monospace", size: 9 },
				showgrid: false,
				tickangle: -15,
				fixedrange: true
			},
			yaxis: {
				title: {
					text: 'Ruin %',
					font: { size: 10, color: '#64748b', family: 'Inter, system-ui, sans-serif' }
				},
				tickformat: '.0%',
				rangemode: 'tozero',
				showgrid: true,
				gridcolor: '#e2e8f0',
				tickfont: { family: "'JetBrains Mono', monospace", size: 9 },
				fixedrange: true
			},
			yaxis2: {
				title: {
					text: `Ending median (${currencySymbol})`,
					font: { size: 10, color: '#64748b', family: 'Inter, system-ui, sans-serif' }
				},
				overlaying: 'y',
				side: 'right',
				showgrid: false,
				tickfont: { family: "'JetBrains Mono', monospace", size: 9 },
				tickvals: endingMedianTicks.values,
				ticktext: endingMedianTicks.labels,
				fixedrange: true
			},
			font: { family: 'Inter, system-ui, sans-serif', color: '#475569', size: 10 },
			hoverlabel: { font: { family: 'Inter, system-ui, sans-serif', size: 10 } }
		};

		const config = {
			responsive: true,
			displayModeBar: false,
			staticPlot: false
		};

		void Plotly.react(sequenceRiskEl, traces, layout, config);
	}

	function handleSequenceRiskToggle(event: Event) {
		if ((event.currentTarget as HTMLDetailsElement).open) {
			drawSequenceRiskChart();
		}
	}
</script>

{#if stats && simulation}
	<div class="card chart-card chart-card-ruin">
		<div class="chart-card-heading">
			<div>
				<p class="phase-eyebrow">Plan adjustment map</p>
				<h3 class="card-title">
					{stats.ruinSurface.retirementAges.length === 1
						? `How spending changes the chance of staying funded to age ${simulateUntilAge}`
						: `How retirement timing and spending change the chance of staying funded to age ${simulateUntilAge}`}
				</h3>
			</div>
			{#if stats.ruinSurface.retirementAges.length > 1}
				<p class="chart-direction">Spend less ↑<br />Retire later →</p>
			{/if}
		</div>
		<div class="ruin-surface-chart" bind:this={ruinSurfaceEl}></div>
		<p class="chart-explainer">
			The dark-green boundary marks the 95% planning goal. The smooth surface is estimated from 81
			replayed combinations; values between them are interpolated.
		</p>
		{#if surfaceSampleCount > 0}
			<p
				class="note"
				title="Each cell replays the same stored set of simulated market paths against that cell's retirement age and spending level. Because every cell reuses the same paths, differences between neighbouring cells are more reliable than each cell's own margin suggests."
			>
				Each cell is estimated from {surfaceSampleCount.toLocaleString()} simulated paths, so individual
				percentages carry up to ±{worstCellMarginPercent.toFixed(1)}% of sampling noise; cells near
				0% or 100% are more precise. This sample is capped independently of the “Simulations”
				setting — raising that number sharpens the summary cards above, not this chart. Read it for
				the shape of the trade-off between retiring earlier and spending more, rather than for any
				single cell's exact value.
			</p>
		{/if}
	</div>

	{#if stats.sequenceRisk?.length}
		<details class="card chart-card advanced-chart" ontoggle={handleSequenceRiskToggle}>
			<summary>How much does the timing of market gains and losses matter?</summary>
			<p class="chart-explainer">
				This groups simulations by returns during the first ten years after retirement. Early losses
				can do more damage because withdrawals leave less invested for a recovery. This is often
				called sequence risk.
			</p>
			<div class="sequence-risk-chart" bind:this={sequenceRiskEl}></div>
		</details>
	{/if}
{/if}
