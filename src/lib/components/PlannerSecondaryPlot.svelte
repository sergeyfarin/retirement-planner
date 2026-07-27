<script lang="ts">
	import type { PlotlyApi } from 'plotly.js-cartesian-dist-min';
	import { onDestroy, untrack } from 'svelte';
	import type { SimulationResult, SummaryStats } from '../retirementEngine';

	let {
		Plotly,
		plotReady = false,
		simulation = null,
		stats = null,
		simulateUntilAge = 0,
		currencySymbol = '$',
		fmtCompactValue,
		fmtHoverCompactCurrency
	}: {
		Plotly: PlotlyApi | null;
		plotReady?: boolean;
		simulation?: SimulationResult | null;
		stats?: SummaryStats | null;
		simulateUntilAge?: number;
		currencySymbol?: string;
		fmtCompactValue: (value: number) => string;
		fmtHoverCompactCurrency: (value: number) => string;
	} = $props();

	let ruinSurfaceEl: HTMLDivElement | null = $state(null);
	let terminalWealthEl: HTMLDivElement | null = $state(null);
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
		const finalWealthCdf = simulation?.finalWealthCdf;
		if (plotReady && Plotly && terminalWealthEl && finalWealthCdf?.balances.length) {
			untrack(drawTerminalWealthChart);
		}
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
		if (Plotly && terminalWealthEl) {
			Plotly.purge(terminalWealthEl);
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
		const colorStretch = 14;
		const warpSurvivalForColor = (probability: number): number => {
			const bounded = Math.max(0, Math.min(1, probability));
			return 1 - Math.log1p(colorStretch * (1 - bounded)) / Math.log1p(colorStretch);
		};

		const zValues = stats.ruinSurface.ruinProbabilities.map((row) =>
			row.map((value) => Math.max(0, Math.min(1, 1 - value)))
		);

		// Each cell is a proportion estimated from `sampleCount` replayed paths, so it
		// carries binomial sampling error: SE = sqrt(p(1-p)/N), shown at 95% confidence.
		// Cells share the same underlying paths (common random numbers), which makes
		// *differences* between cells steadier than these absolute margins suggest.
		const cellMarginPercent = zValues.map((row) =>
			row.map((survival) =>
				surfaceSampleCount > 0
					? 1.96 * Math.sqrt((survival * (1 - survival)) / surfaceSampleCount) * 100
					: 0
			)
		);
		const colorZValues = zValues.map((row) => row.map((value) => warpSurvivalForColor(value)));
		const yLabels = spendingMultipliers.map((multiplier) => `${Math.round(multiplier * 100)}%`);
		const cellText = zValues.map((row) => row.map((value) => `${Math.round(value * 100)}%`));
		const baseColorStops: Array<[number, string]> = [
			[0.0, '#7f1d1d'],
			[0.08, '#991b1b'],
			[0.16, '#b91c1c'],
			[0.3, '#dc2626'],
			[0.5, '#f87171'],
			[0.65, '#f59e0b'],
			[0.8, '#facc15'],
			[0.9, '#d9f99d'],
			[0.94, '#86efac'],
			[0.97, '#22c55e'],
			[0.99, '#16a34a'],
			[1.0, '#15803d']
		];
		const warpedColorStops = baseColorStops.map(
			([value, color]) => [warpSurvivalForColor(value), color] as const
		);
		const legendTicks = [0, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1];

		const trace = {
			type: 'heatmap',
			x: retirementAges,
			y: spendingMultipliers,
			z: colorZValues,
			text: cellText,
			texttemplate: '%{text}',
			textfont: {
				size: 10,
				family: "'JetBrains Mono', monospace",
				color: '#0f172a'
			},
			zmin: 0,
			zmax: 1,
			colorscale: warpedColorStops,
			showscale: true,
			colorbar: {
				title: { text: 'Survival chance', side: 'right' },
				tickmode: 'array',
				tickvals: legendTicks.map((value) => warpSurvivalForColor(value)),
				ticktext: legendTicks.map((value) => `${Math.round(value * 1000) / 10}%`),
				tickfont: { family: "'JetBrains Mono', monospace", size: 9 },
				titlefont: { family: 'Inter, system-ui, sans-serif', size: 10, color: '#475569' },
				thickness: 12,
				len: 0.9,
				y: 0.5,
				yanchor: 'middle'
			},
			customdata: zValues.map((row, rowIndex) =>
				row.map((survival, columnIndex) => [survival, cellMarginPercent[rowIndex][columnIndex]])
			),
			hovertemplate: spendingOnly
				? 'Spending %{y:.0%}<br>Survival %{customdata[0]:.1%} ±%{customdata[1]:.1f}%<extra></extra>'
				: 'Retirement age %{x}<br>Spending %{y:.0%}<br>Survival %{customdata[0]:.1%} ±%{customdata[1]:.1f}%<extra></extra>'
		};

		const layout = {
			title: {
				text: spendingOnly
					? `Sensitivity to spending<br />Portfolio surviving chance until age ${simulateUntilAge}`
					: `Sensitivity to retirement age and spending<br />Portfolio surviving chance until age ${simulateUntilAge}`,
				font: { size: 13, color: '#334155', family: 'Inter, system-ui, sans-serif' },
				pad: { b: 12 }
			},
			margin: { t: 52, l: 60, r: 44, b: 44 },
			paper_bgcolor: 'transparent',
			plot_bgcolor: 'rgba(255,255,255,0.5)',
			xaxis: {
				title: {
					text: spendingOnly ? 'Already retired' : 'Retirement age',
					font: { size: 11, color: '#64748b', family: 'Inter, system-ui, sans-serif' }
				},
				tickmode: 'array',
				tickvals: retirementAges,
				ticktext: retirementAges.map((age) => (spendingOnly ? `age ${age} (now)` : `${age}`)),
				tickfont: { family: "'JetBrains Mono', monospace", size: 10 },
				showgrid: false,
				fixedrange: true
			},
			yaxis: {
				title: {
					text: 'Spending scale',
					font: { size: 11, color: '#64748b', family: 'Inter, system-ui, sans-serif' }
				},
				tickmode: 'array',
				tickvals: spendingMultipliers,
				ticktext: yLabels,
				tickfont: { family: "'JetBrains Mono', monospace", size: 10 },
				autorange: 'reversed',
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

		void Plotly.react(ruinSurfaceEl, [trace], layout, config);
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

	function drawTerminalWealthChart() {
		if (!Plotly || !terminalWealthEl || !simulation?.finalWealthCdf) return;

		const { balances, probabilities } = simulation.finalWealthCdf;
		const balanceTicks = buildYAxisTicksForRange(
			Math.min(...balances, 0),
			Math.max(...balances, 0),
			6
		);
		const trace = {
			type: 'scatter',
			mode: 'lines',
			x: balances,
			y: probabilities,
			line: { color: '#2563eb', width: 3, shape: 'hv' },
			fill: 'tozeroy',
			fillcolor: 'rgba(37, 99, 235, 0.10)',
			customdata: balances.map((value) => fmtHoverCompactCurrency(value)),
			hovertemplate: '%{y:.0%} of simulations ended with<br>%{customdata} or less<extra></extra>'
		};

		const layout = {
			height: 260,
			margin: { t: 10, l: 54, r: 16, b: 48 },
			showlegend: false,
			paper_bgcolor: 'transparent',
			plot_bgcolor: 'rgba(255,255,255,0.45)',
			xaxis: {
				title: {
					text: `Balance at age ${simulateUntilAge} (${currencySymbol})`,
					font: { size: 10, color: '#64748b', family: 'Inter, system-ui, sans-serif' }
				},
				tickvals: balanceTicks.values,
				ticktext: balanceTicks.labels,
				tickfont: { family: "'JetBrains Mono', monospace", size: 9 },
				showgrid: true,
				gridcolor: '#e2e8f0',
				fixedrange: true
			},
			yaxis: {
				title: {
					text: 'Chance of this amount or less',
					font: { size: 10, color: '#64748b', family: 'Inter, system-ui, sans-serif' }
				},
				tickformat: '.0%',
				range: [0, 1],
				tickfont: { family: "'JetBrains Mono', monospace", size: 9 },
				fixedrange: true
			},
			font: { family: 'Inter, system-ui, sans-serif', color: '#475569', size: 10 },
			hoverlabel: { font: { family: 'Inter, system-ui, sans-serif', size: 10 } }
		};

		void Plotly.react(terminalWealthEl, [trace], layout, {
			responsive: true,
			displayModeBar: false
		});
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
	<div class="card chart-card">
		<p class="chart-question">How much might I have left?</p>
		<p class="chart-explainer">
			See the range of balances the simulations reached by age {simulateUntilAge}. Hover over the
			line to read the chance of ending with that amount or less.
		</p>
		<div class="terminal-wealth-chart" bind:this={terminalWealthEl}></div>
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

	<div class="card chart-card chart-card-ruin">
		<div class="ruin-surface-chart" bind:this={ruinSurfaceEl}></div>
		{#if surfaceSampleCount > 0}
			<p
				class="note"
				title="Each cell replays the same stored set of simulated market paths against that cell's retirement age and spending level. Because every cell reuses the same paths, differences between neighbouring cells are more reliable than each cell's own margin suggests."
			>
				Each cell is estimated from {surfaceSampleCount.toLocaleString()} simulated paths, so individual
				percentages carry up to ±{worstCellMarginPercent.toFixed(1)}% of sampling noise (hover a
				cell for its own margin; cells near 0% or 100% are more precise). This sample is capped
				independently of the “Simulations” setting — raising that number sharpens the summary cards
				above, not this chart. Read it for the shape of the trade-off between retiring earlier and
				spending more, rather than for any single cell's exact value.
			</p>
		{/if}
	</div>
{/if}
