<script lang="ts">
  import { onDestroy } from 'svelte';
  import { percentile as calcPercentile } from '../calculations';
  import type { LumpSumEvent, SimulationResult, SpendingPeriod, SummaryStats } from '../retirementEngine';

  export let Plotly: any;
  export let plotReady = false;
  export let simulation: SimulationResult | null = null;
  export let stats: SummaryStats | null = null;
  export let retirementAge = 0;
  export let baselineFiTarget = 0;
  export let spendingPeriods: SpendingPeriod[] = [];
  export let lumpSumEvents: LumpSumEvent[] = [];
  export let currencySymbol = '$';
  export let fmtCompactValue: (value: number) => string;
  export let fmtHoverCompactCurrency: (value: number) => string;

  let chartEl: HTMLDivElement | null = null;
  let relayoutHandlerAttached = false;
  let applyingTickRelayout = false;
  let defaultYAxisTickValues: number[] = [];
  let defaultYAxisTickLabels: string[] = [];
  let defaultYAxisRange: [number, number] = [0, 0];
  let defaultXAxisRange: [number, number] = [0, 0];

  const BAND_COLORS = [
    'rgba(239,68,68,0.06)',
    'rgba(59,130,246,0.06)',
    'rgba(168,85,247,0.06)',
    'rgba(234,179,8,0.06)',
    'rgba(20,184,166,0.06)'
  ];

  $: if (plotReady && Plotly && chartEl && simulation) {
    drawChart(simulation);
  }

  onDestroy(() => {
    if (Plotly && chartEl) {
      Plotly.purge(chartEl);
    }
  });

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

  function restoreDefaultAxes(targetEl: any = chartEl) {
    if (!targetEl || !Plotly) return;
    if (!Number.isFinite(defaultXAxisRange[0]) || !Number.isFinite(defaultXAxisRange[1])) return;
    if (!Number.isFinite(defaultYAxisRange[0]) || !Number.isFinite(defaultYAxisRange[1])) return;

    const restoredX0 = Number(defaultXAxisRange[0]);
    const restoredX1 = Number(defaultXAxisRange[1]);
    const restoredY0 = Number(defaultYAxisRange[0]);
    const restoredY1 = Number(defaultYAxisRange[1]);

    applyingTickRelayout = true;
    Promise.resolve(
      Plotly.relayout(targetEl, {
        'xaxis.autorange': false,
        'xaxis.range[0]': restoredX0,
        'xaxis.range[1]': restoredX1,
        'yaxis.autorange': false,
        'yaxis.range[0]': restoredY0,
        'yaxis.range[1]': restoredY1,
        'yaxis.tickmode': 'array',
        'yaxis.tickvals': [...defaultYAxisTickValues],
        'yaxis.ticktext': [...defaultYAxisTickLabels]
      })
    ).finally(() => {
      applyingTickRelayout = false;
    });
  }

  function handleChartRelayout(eventData: Record<string, unknown>) {
    if (!chartEl || !Plotly || applyingTickRelayout) return;

    const resetRequested = eventData['xaxis.autorange'] === true || eventData['yaxis.autorange'] === true;
    if (resetRequested) {
      restoreDefaultAxes();
      return;
    }

    const yRangeStart = Number(eventData['yaxis.range[0]']);
    const yRangeEnd = Number(eventData['yaxis.range[1]']);
    if (!Number.isFinite(yRangeStart) || !Number.isFinite(yRangeEnd)) return;

    const minY = Math.min(yRangeStart, yRangeEnd);
    const maxY = Math.max(yRangeStart, yRangeEnd);
    if (maxY - minY <= 0) return;

    const refinedTicks = buildYAxisTicksForRange(minY, maxY, 12);

    applyingTickRelayout = true;
    Promise.resolve(
      Plotly.relayout(chartEl, {
        'yaxis.tickmode': 'array',
        'yaxis.tickvals': refinedTicks.values,
        'yaxis.ticktext': refinedTicks.labels
      })
    ).finally(() => {
      applyingTickRelayout = false;
    });
  }

  function ensureRelayoutHandler() {
    if (!chartEl || relayoutHandlerAttached) return;
    (chartEl as any).on('plotly_relayout', handleChartRelayout);
    (chartEl as any).on('plotly_doubleclick', () => {
      restoreDefaultAxes();
      return false;
    });
    relayoutHandlerAttached = true;
  }

  function computeClippedYAxisMax(result: SimulationResult): number {
    const p90Series = result.percentiles.p90
      .filter((value: number) => Number.isFinite(value))
      .map((value: number) => Math.max(0, value));
    const p75Series = result.percentiles.p75
      .filter((value: number) => Number.isFinite(value))
      .map((value: number) => Math.max(0, value));
    const p50Series = result.percentiles.p50
      .filter((value: number) => Number.isFinite(value))
      .map((value: number) => Math.max(0, value));

    const fiTargets = [stats?.fiTargetP95, stats?.fiTargetSWR, baselineFiTarget]
      .filter((value): value is number => Number.isFinite(value))
      .map((value) => Math.max(0, value));

    const rawMax = Math.max(...p90Series, ...fiTargets, 0);
    if (p90Series.length < 8 || rawMax <= 0) {
      return rawMax;
    }

    const sortedP90 = [...p90Series].sort((a, b) => a - b);
    const typicalUpper = calcPercentile(sortedP90, 0.7);
    const centralUpper = Math.max(...p75Series, 0);

    const clipCap = Math.max(typicalUpper * 1.1, centralUpper * 1.2, ...fiTargets, 0);
    const shouldClip = rawMax > clipCap * 1.25;
    const clippedMax = shouldClip ? clipCap : rawMax;

    const medianPeak = Math.max(...p50Series, 0);
    if (medianPeak <= 0) {
      return clippedMax;
    }

    const maxForMedianOneThird = medianPeak * 3;
    const cappedByMedian = Math.min(clippedMax, maxForMedianOneThird);
    const minimumVisibleMax = Math.max(...fiTargets, medianPeak * 1.05, 0);

    return Math.max(cappedByMedian, minimumVisibleMax);
  }

  function drawChart(result: SimulationResult) {
    if (!Plotly || !chartEl) return;
    if (!(Plotly as any).__aposLocale) {
      Plotly.register({ moduleType: 'locale', name: 'apos', format: { decimal: '.', thousands: "'", grouping: [3], currency: ['', ''] } });
      (Plotly as any).__aposLocale = true;
    }
    const { ages, percentiles: p } = result;
    const lastAge = ages[ages.length - 1];
    const yMax = computeClippedYAxisMax(result);
    const yTicks = buildYAxisTicks(yMax);
    const fiTargetP95 = stats?.fiTargetP95 ?? baselineFiTarget;
    const fiTargetSWR = stats?.fiTargetSWR ?? baselineFiTarget;
    defaultXAxisRange = [ages[0], lastAge];
    defaultYAxisTickValues = [...yTicks.values];
    defaultYAxisTickLabels = [...yTicks.labels];
    defaultYAxisRange = [0, yTicks.values[yTicks.values.length - 1]];
    const initialXAxisRange: [number, number] = [defaultXAxisRange[0], defaultXAxisRange[1]];
    const initialYAxisRange: [number, number] = [defaultYAxisRange[0], defaultYAxisRange[1]];

    const traces = [
      {
        x: ages, y: p.p50,
        name: 'Median outcome',
        line: { color: '#15803d', width: 2.5 },
        type: 'scatter',
        customdata: p.p50.map((v: number) => fmtHoverCompactCurrency(v)),
        hovertemplate: 'Age %{x:.1f}<br>Portfolio %{customdata}<extra></extra>'
      },
      {
        x: [...ages, ...ages.slice().reverse()],
        y: [...p.p90, ...p.p10.slice().reverse()],
        fill: 'toself', fillcolor: 'rgba(34,197,94,0.10)',
        line: { width: 0 }, name: '80% of outcomes',
        type: 'scatter', hoverinfo: 'skip'
      },
      {
        x: [...ages, ...ages.slice().reverse()],
        y: [...p.p75, ...p.p25.slice().reverse()],
        fill: 'toself', fillcolor: 'rgba(34,197,94,0.22)',
        line: { width: 0 }, name: '50% of outcomes',
        type: 'scatter', hoverinfo: 'skip'
      },
      {
        x: ages, y: p.p75,
        name: 'P75 boundary',
        showlegend: false,
        line: { color: 'rgba(21,128,61,0.45)', width: 1.3 },
        type: 'scatter',
        customdata: p.p75.map((v: number) => fmtHoverCompactCurrency(v)),
        hovertemplate: 'Age %{x:.1f}<br>P75 %{customdata}<extra></extra>'
      },
      {
        x: ages, y: p.p25,
        name: 'P25 boundary',
        showlegend: false,
        line: { color: 'rgba(21,128,61,0.45)', width: 1.3 },
        type: 'scatter',
        customdata: p.p25.map((v: number) => fmtHoverCompactCurrency(v)),
        hovertemplate: 'Age %{x:.1f}<br>P25 %{customdata}<extra></extra>'
      },
      {
        x: ages, y: p.p10,
        name: 'P10 boundary',
        showlegend: false,
        line: { color: 'rgba(21,128,61,0.35)', width: 1.2, dash: 'dot' },
        type: 'scatter',
        customdata: p.p10.map((v: number) => fmtHoverCompactCurrency(v)),
        hovertemplate: 'Age %{x:.1f}<br>P10 %{customdata}<extra></extra>'
      },
      {
        x: ages, y: p.p90,
        name: 'P90 boundary',
        showlegend: false,
        line: { color: 'rgba(21,128,61,0.35)', width: 1.2, dash: 'dot' },
        type: 'scatter',
        customdata: p.p90.map((v: number) => fmtHoverCompactCurrency(v)),
        hovertemplate: 'Age %{x:.1f}<br>P90 %{customdata}<extra></extra>'
      },
      {
        x: [ages[0], lastAge],
        y: [fiTargetP95, fiTargetP95],
        name: 'FI target (95% success)',
        type: 'scatter',
        mode: 'lines',
        line: { dash: 'dash', width: 1.5, color: '#ef4444' },
        customdata: [fmtHoverCompactCurrency(fiTargetP95), fmtHoverCompactCurrency(fiTargetP95)],
        hovertemplate: 'FI target (95%): %{customdata}<extra></extra>'
      },
      {
        x: [ages[0], lastAge],
        y: [fiTargetSWR, fiTargetSWR],
        name: 'FI target (4% rule)',
        type: 'scatter',
        mode: 'lines',
        line: { dash: 'dot', width: 1.5, color: '#f59e0b' },
        customdata: [fmtHoverCompactCurrency(fiTargetSWR), fmtHoverCompactCurrency(fiTargetSWR)],
        hovertemplate: 'FI target (4%): %{customdata}<extra></extra>'
      }
    ];

    const shapes: any[] = [
      {
        type: 'line',
        x0: retirementAge, x1: retirementAge, y0: 0, y1: 1, yref: 'paper',
        line: { dash: 'dot', width: 1.5, color: '#6b7280' }
      }
    ];

    spendingPeriods.forEach((period, i) => {
      shapes.push({
        type: 'rect',
        x0: Math.max(period.fromAge, ages[0]),
        x1: Math.min(period.toAge, lastAge),
        y0: 0, y1: 1, yref: 'paper',
        fillcolor: BAND_COLORS[i % BAND_COLORS.length],
        line: { width: 0 }, layer: 'below'
      });
    });

    const annotations: any[] = lumpSumEvents
      .filter((event) => event.age >= ages[0] && event.age <= lastAge)
      .map((event) => ({
        x: event.age, y: 0.97, yref: 'paper',
        text: `${event.amount >= 0 ? '▲' : '▼'} ${event.label}`,
        showarrow: true, arrowhead: 2, ax: 0, ay: -28,
        font: { size: 10, color: event.amount >= 0 ? '#15803d' : '#dc2626', family: 'Inter, system-ui, sans-serif' },
        bgcolor: 'rgba(255,255,255,0.85)', borderpad: 3
      }));

    annotations.push({
      x: retirementAge, y: 1, yref: 'paper',
      text: 'FI target year', showarrow: false,
      font: { size: 10, color: '#6b7280', family: 'Inter, system-ui, sans-serif' },
      xanchor: 'left', yanchor: 'top'
    });

    const layout = {
      title: { text: `Portfolio projection — inflation-adjusted (${currencySymbol})`, font: { size: 15, color: '#334155', family: 'Inter, system-ui, sans-serif' } },
      xaxis: {
        title: { text: 'Age', font: { size: 12, color: '#64748b', family: 'Inter, system-ui, sans-serif' } },
        showgrid: false,
        linecolor: '#e2e8f0',
        tickfont: { family: "'JetBrains Mono', monospace", size: 11 },
        autorange: false,
        range: initialXAxisRange
      },
      yaxis: {
        title: { text: `Portfolio value (${currencySymbol})`, font: { size: 12, color: '#64748b', family: 'Inter, system-ui, sans-serif' } },
        showgrid: true,
        gridwidth: 1,
        gridcolor: '#e2e8f0',
        linecolor: '#e2e8f0',
        tickfont: { family: "'JetBrains Mono', monospace", size: 11 },
        ticks: 'outside',
        ticklen: 5,
        tickwidth: 1,
        tickcolor: '#cbd5e1',
        tickmode: 'array',
        tickvals: yTicks.values,
        ticktext: yTicks.labels,
        autorange: false,
        range: initialYAxisRange
      },
      font: { family: 'Inter, system-ui, sans-serif', color: '#475569', size: 11 },
      hoverlabel: { font: { family: 'Inter, system-ui, sans-serif', size: 11 } },
      showlegend: true,
      legend: {
        x: 0.99,
        y: 0.99,
        xanchor: 'right',
        yanchor: 'top',
        orientation: 'v',
        bgcolor: 'rgba(255,255,255,0.68)',
        bordercolor: 'rgba(148,163,184,0.0)',
        borderwidth: 1,
        font: { size: 10, color: '#334155', family: 'Inter, system-ui, sans-serif' }
      },
      plot_bgcolor: 'rgba(255,255,255,0.5)',
      paper_bgcolor: 'transparent',
      shapes,
      annotations,
      margin: { t: 55, l: 70, r: 20, b: 50 }
    };

    const config = {
      responsive: true,
      locale: 'apos',
      modeBarButtonsToRemove: ['resetScale2d', 'autoScale2d'],
      modeBarButtonsToAdd: [
        {
          name: 'Reset axes',
          title: 'Reset axes',
          icon: (Plotly as any)?.Icons?.home ?? (Plotly as any)?.Icons?.autoscale,
          click: (gd: any) => {
            restoreDefaultAxes(gd);
          }
        }
      ]
    };

    Promise.resolve(Plotly.react(chartEl, traces, layout, config)).then(() => {
      ensureRelayoutHandler();
    });
  }
</script>

<div class="card chart-card chart-card-main">
  <div class="chart" bind:this={chartEl}></div>
  <p class="note">
    Fan shows middle 50% and 80% of outcomes. Dotted line is target year to achieve FI.
    Red dashed line is FI target (P95) and orange dotted line is FI target (SWR). Shaded bands indicate spending periods.
    Engine uses bootstrapped annual returns with regime detection to model sequence risk and clustered drawdowns.
  </p>
</div>
