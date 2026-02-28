<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { SummaryStats } from '../retirementEngine';

  export let Plotly: any;
  export let plotReady = false;
  export let stats: SummaryStats | null = null;
  export let simulateUntilAge = 0;
  export let currencySymbol = '$';
  export let fmtCompactValue: (value: number) => string;
  export let fmtHoverCompactCurrency: (value: number) => string;

  let ruinSurfaceEl: HTMLDivElement | null = null;
  let sequenceRiskEl: HTMLDivElement | null = null;

  $: if (plotReady && Plotly && ruinSurfaceEl && stats?.ruinSurface) {
    drawRuinSurfaceChart();
  }

  $: if (plotReady && Plotly && sequenceRiskEl && stats?.sequenceRisk?.length) {
    drawSequenceRiskChart();
  }

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
    const colorStretch = 14;
    const warpSurvivalForColor = (probability: number): number => {
      const bounded = Math.max(0, Math.min(1, probability));
      return 1 - Math.log1p(colorStretch * (1 - bounded)) / Math.log1p(colorStretch);
    };

    const zValues = stats.ruinSurface.ruinProbabilities.map((row) => row.map((value) => Math.max(0, Math.min(1, 1 - value))));
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
    const warpedColorStops = baseColorStops.map(([value, color]) => [warpSurvivalForColor(value), color] as const);
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
      customdata: zValues,
      hovertemplate: 'Retirement age %{x}<br>Spending %{y:.0%}<br>Survival %{customdata:.1%}<extra></extra>'
    };

    const layout = {
      title: {
        text: `Sensitivity to retirement age and spending<br />Portfolio surviving chance until age ${simulateUntilAge}`,
        font: { size: 13, color: '#334155', family: 'Inter, system-ui, sans-serif' },
        pad: { b: 12 }
      },
      margin: { t: 52, l: 60, r: 44, b: 44 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'rgba(255,255,255,0.5)',
      xaxis: {
        title: { text: 'Retirement age', font: { size: 11, color: '#64748b', family: 'Inter, system-ui, sans-serif' } },
        tickmode: 'array',
        tickvals: retirementAges,
        ticktext: retirementAges.map((age) => `${age}`),
        tickfont: { family: "'JetBrains Mono', monospace", size: 10 },
        showgrid: false,
        fixedrange: true
      },
      yaxis: {
        title: { text: 'Spending scale', font: { size: 11, color: '#64748b', family: 'Inter, system-ui, sans-serif' } },
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

  function buildYAxisTicksForRange(minValue: number, maxValue: number, targetSteps = 8): { values: number[]; labels: string[] } {
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

    const buckets = stats.sequenceRisk.map((row) => row.bucketLabel.replace(' (worst early sequence)', ' (worst)').replace(' (best early sequence)', ' (best)'));
    const ruinProbabilities = stats.sequenceRisk.map((row) => row.ruinProbability);
    const endingMedians = stats.sequenceRisk.map((row) => row.endingMedian);

    const traces = [
      {
        type: 'bar',
        x: buckets,
        y: ruinProbabilities,
        name: 'Ruin probability',
        marker: {
          color: ruinProbabilities.map((value) => (value >= 0.35 ? '#dc2626' : value <= 0.15 ? '#16a34a' : '#f59e0b'))
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
        title: { text: 'Ruin %', font: { size: 10, color: '#64748b', family: 'Inter, system-ui, sans-serif' } },
        tickformat: '.0%',
        rangemode: 'tozero',
        showgrid: true,
        gridcolor: '#e2e8f0',
        tickfont: { family: "'JetBrains Mono', monospace", size: 9 },
        fixedrange: true
      },
      yaxis2: {
        title: { text: `Ending median (${currencySymbol})`, font: { size: 10, color: '#64748b', family: 'Inter, system-ui, sans-serif' } },
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
</script>

{#if stats}
  <div class="card chart-card chart-card-ruin">
    <div class="ruin-surface-chart" bind:this={ruinSurfaceEl}></div>
    <!-- <div class="sequence-risk-chart" bind:this={sequenceRiskEl}></div> -->
  </div>
{/if}
