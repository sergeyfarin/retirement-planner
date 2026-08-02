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

		// Keep the vertical axis conventional: larger spending changes appear higher.
		// This makes the safer directions down (spend less) and right (retire later).
		const spendingChanges = spendingMultipliers.map(
			(multiplier) => Math.round((multiplier - 1) * 1000) / 10
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
		// A logarithmic-style transform devotes much more of the legend to 90–100%, where
		// planning decisions are made. All labels and overlays continue to use raw probability.
		const colorStretch = 19;
		const warpProbability = (probability: number): number =>
			1 - Math.log1p(colorStretch * (1 - probability)) / Math.log1p(colorStretch);
		const colorZValues = zValues.map((row) => row.map(warpProbability));
		const rawColorStops: Array<[number, string]> = [
			[0, '#fee2e2'],
			[0.25, '#fecaca'],
			[0.5, '#fed7aa'],
			[0.75, '#fef3c7'],
			[0.9, '#d9f99d'],
			[0.9479, '#86efac'],
			[0.948, '#166534'],
			[0.952, '#166534'],
			[0.9521, '#86efac'],
			[0.975, '#4ade80'],
			[1, '#16a34a']
		];
		const colorscale = rawColorStops.map(
			([probability, color]) => [warpProbability(probability), color] as [number, string]
		);
		const movingToSaferPlan = currentPlanProbability < 0.95;
		const scenarioSpendingChange = movingToSaferPlan ? -10 : 10;
		const scenarioAge = Math.max(
			retirementAges[0],
			Math.min(
				retirementAges[retirementAges.length - 1],
				retirementAge + (movingToSaferPlan ? 3 : -3)
			)
		);
		const scenarioSpendingIndex = spendingChanges.reduce(
			(best, change, index) =>
				Math.abs(change - scenarioSpendingChange) <
				Math.abs(spendingChanges[best] - scenarioSpendingChange)
					? index
					: best,
			0
		);
		const scenarioAgeIndex = retirementAges.reduce(
			(best, age, index) =>
				Math.abs(age - scenarioAge) < Math.abs(retirementAges[best] - scenarioAge) ? index : best,
			0
		);
		const spendingScenarioProbability = zValues[scenarioSpendingIndex][baselineAgeIndex];
		const ageScenarioProbability = zValues[baselineSpendingIndex][scenarioAgeIndex];
		const contourTrace = {
			type: spendingOnly ? 'heatmap' : 'contour',
			x: retirementAges,
			y: spendingChanges,
			z: colorZValues,
			customdata: zValues,
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
				title: { text: 'Chance funded', side: 'right' },
				tickmode: 'array',
				tickvals: [0, 0.5, 0.75, 0.9, 0.95, 0.99, 1].map(warpProbability),
				ticktext: ['0%', '50%', '75%', '90%', '95% goal', '99%', '100%'],
				tickfont: { family: "'JetBrains Mono', monospace", size: 9, color: '#334155' },
				titlefont: { family: 'Inter, system-ui, sans-serif', size: 10, color: '#334155' },
				ticks: 'outside',
				tickcolor: '#475569',
				thickness: 18,
				len: 0.9,
				y: 0.5,
				yanchor: 'middle'
			},
			hovertemplate: spendingOnly
				? 'Spending change %{y:.0f}%<br>Estimated chance funded %{customdata:.1%}<extra></extra>'
				: 'Retire at age %{x}<br>Spending change %{y:.0f}%<br>Estimated chance funded %{customdata:.1%}<extra></extra>'
		};
		const currentPlan = {
			type: 'scatter',
			mode: 'markers',
			x: [retirementAge],
			y: [0],
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
		const actualAgeChange = Math.abs(retirementAges[scenarioAgeIndex] - retirementAge);
		const arrowColor = '#172554';
		const annotationBackground = 'rgba(255,255,255,0.78)';
		const scenarioAnnotations: Array<Record<string, unknown>> = [
			{
				x: retirementAge,
				y: 0,
				text: `<b>Your plan: ${Math.round(currentPlanProbability * 100)}%</b><br>chance funded`,
				showarrow: false,
				xanchor: 'center',
				yanchor: movingToSaferPlan ? 'bottom' : 'top',
				yshift: movingToSaferPlan ? 12 : -12,
				bgcolor: annotationBackground,
				borderpad: 3,
				font: { size: 10, color: '#0f172a' }
			}
		];
		scenarioAnnotations.push({
			x: retirementAge,
			y: spendingChanges[scenarioSpendingIndex],
			ax: retirementAge,
			ay: 0,
			axref: 'x',
			ayref: 'y',
			text: '',
			showarrow: true,
			arrowhead: 3,
			arrowsize: 1,
			arrowwidth: 2,
			arrowcolor: arrowColor
		});
		scenarioAnnotations.push({
			x: retirementAge,
			y: spendingChanges[scenarioSpendingIndex],
			text: `<b>Spend 10% ${movingToSaferPlan ? 'less' : 'more'}</b><br>${Math.round(spendingScenarioProbability * 100)}% chance funded`,
			showarrow: false,
			xanchor: 'left',
			yanchor: 'middle',
			xshift: 10,
			bgcolor: annotationBackground,
			borderpad: 3,
			font: { size: 10, color: '#334155' }
		});
		if (!spendingOnly && actualAgeChange > 0) {
			scenarioAnnotations.push({
				x: retirementAges[scenarioAgeIndex],
				y: 0,
				ax: retirementAge,
				ay: 0,
				axref: 'x',
				ayref: 'y',
				text: '',
				showarrow: true,
				arrowhead: 3,
				arrowsize: 1,
				arrowwidth: 2,
				arrowcolor: arrowColor
			});
			scenarioAnnotations.push({
				x: retirementAges[scenarioAgeIndex],
				y: 0,
				text: `<b>Retire ${actualAgeChange.toFixed(actualAgeChange % 1 === 0 ? 0 : 1)} years ${movingToSaferPlan ? 'later' : 'earlier'}</b><br>${Math.round(ageScenarioProbability * 100)}% chance funded`,
				showarrow: false,
				xanchor: 'center',
				yanchor: 'bottom',
				yshift: 8,
				bgcolor: annotationBackground,
				borderpad: 3,
				font: { size: 10, color: '#334155' }
			});
		}
		const layout = {
			margin: { t: 24, l: 72, r: 74, b: 52 },
			paper_bgcolor: 'transparent',
			plot_bgcolor: 'rgba(255,255,255,0.5)',
			xaxis: {
				title: {
					text: spendingOnly ? 'Already retired' : 'Retirement age',
					font: { size: 11, color: '#334155', family: 'Inter, system-ui, sans-serif' }
				},
				tickmode: 'array',
				tickvals: retirementTicks,
				ticktext: retirementTicks.map((age) => (spendingOnly ? `age ${age} (now)` : `${age}`)),
				tickfont: { family: "'JetBrains Mono', monospace", size: 10, color: '#334155' },
				ticks: 'outside',
				tickcolor: '#475569',
				showgrid: false,
				fixedrange: true
			},
			yaxis: {
				title: {
					text: 'Change annual spending',
					font: { size: 11, color: '#334155', family: 'Inter, system-ui, sans-serif' }
				},
				tickmode: 'array',
				tickvals: spendingTicks,
				ticktext: spendingTicks.map((change) =>
					change === 0 ? 'Current' : change > 0 ? `${change}% more` : `${Math.abs(change)}% less`
				),
				tickfont: { family: "'JetBrains Mono', monospace", size: 10, color: '#334155' },
				ticks: 'outside',
				tickcolor: '#475569',
				fixedrange: true
			},
			annotations: scenarioAnnotations,
			font: { family: 'Inter, system-ui, sans-serif', color: '#475569', size: 10 },
			hoverlabel: { font: { family: 'Inter, system-ui, sans-serif', size: 10 } }
		};

		const config = {
			responsive: true,
			displayModeBar: false,
			staticPlot: false
		};

		void Plotly.react(ruinSurfaceEl, [contourTrace, currentPlan], layout, config);
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
	<div class="card chart-card">
		<div class="chart-card-heading">
			<div>
				<p class="eyebrow">Plan adjustment map</p>
				<h3 class="card-title">
					{stats.ruinSurface.retirementAges.length === 1
						? `How spending changes the chance of staying funded to age ${simulateUntilAge}`
						: `How retirement timing and spending change the chance of staying funded to age ${simulateUntilAge}`}
				</h3>
			</div>
		</div>
		<div class="ruin-surface-chart" bind:this={ruinSurfaceEl}></div>
		<p class="chart-explainer">
			The arrows compare practical changes with your current plan. The thin dark-green band marks
			the 95% planning goal on both the surface and legend. The smooth surface is estimated from 81
			replayed combinations; values between them are interpolated. The colour scale expands the
			90–100% range so differences near the goal remain visible.
		</p>
		{#if surfaceSampleCount > 0}
			<p
				class="note"
				title="Each cell replays the same stored set of simulated market paths against that cell's retirement age and spending level. Because every cell reuses the same paths, differences between neighbouring cells are more reliable than each cell's own margin suggests."
			>
				Each cell is estimated from {surfaceSampleCount.toLocaleString()} simulated paths, so individual
				percentages carry up to ±{worstCellMarginPercent.toFixed(1)}% of sampling noise; cells near
				0% or 100% are more precise. Read it for the shape of the trade-off rather than for any
				single cell's exact value — the card above carries the precise figures.
			</p>
		{/if}
	</div>

	{#if stats.sequenceRisk?.length}
		<details class="card chart-card" ontoggle={handleSequenceRiskToggle}>
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
