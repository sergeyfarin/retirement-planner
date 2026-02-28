<script lang="ts">
  export let CURRENCIES: any[] = [];
  export let selectedCurrencyCode: any;
  export let selectedCurrency: any;
  export let input: any;
  export let incomeSources: any[] = [];
  export let spendingPeriods: any[] = [];
  export let lumpSumEvents: any[] = [];
  export let stockBoundaryPercent = 0;
  export let bondBoundaryPercent = 0;
  export let stockAllocationPercent = 0;
  export let bondAllocationPercent = 0;
  export let bankAllocationPercent = 0;
  export let investmentMetrics: any;
  export let selectedHistoricalRegion: any;
  export let historicalDataLoadError = '';
  export let showHistoricalMethodologyInfo = false;
  export let portfolioDisplaySkew = 0;
  export let portfolioDisplayKurt = 0;
  export let realReturnEstimate = 0;
  export let realReturnStdEstimate = 0;
  export let realReturnSkewEstimate = 0;
  export let realReturnKurtEstimate = 0;
  export let errorMessage = '';
  export let realReturnCdfEl: HTMLDivElement | null = null;

  export let fmtNum: (value: number, decimals?: number) => string;
  export let numFromEvent: (e: Event) => number;
  export let decimalFromPercentEvent: (e: Event) => number;
  export let fmtPercentInputSig3: (value: number) => string;
  export let fmtPercentDisplay: (value: number, decimals?: number) => string;
  export let clamp: (value: number, min: number, max: number) => number;

  export let addIncomeSource: () => void;
  export let removeIncomeSource: (id: string) => void;
  export let addSpendingPeriod: () => void;
  export let removeSpendingPeriod: (id: string) => void;
  export let addLumpSumEvent: () => void;
  export let removeLumpSumEvent: (id: string) => void;
  export let onStockBoundaryChange: () => void;
  export let onBondBoundaryChange: () => void;
  export let onInvestmentMetricChange: () => void;
  export let resetAssumptionsToCurrencyDefaults: () => void;
  export let resetStockMetricsToDefault: () => void;
  export let resetBondMetricsToDefault: () => void;
  export let resetBankMetricsToDefault: () => void;
  export let resetInflationToDefault: () => void;
  export let resetDragToDefault: () => void;
</script>

<section class="left-panel">
  <div class="currency-switch" role="group" aria-label="Currency selection">
    {#each CURRENCIES as c}
      <button
        type="button"
        class={`currency-btn currency-${c.code.toLowerCase()}`}
        style={c.flagAsset ? `--flag-url: url('${c.flagAsset}')` : ''}
        class:active={selectedCurrencyCode === c.code}
        onclick={() => { selectedCurrencyCode = c.code; }}
        aria-pressed={selectedCurrencyCode === c.code}
      >
        <span>{c.buttonLabel}</span>
      </button>
    {/each}
  </div>

  <div class="card mt-2">
    <div class="form-grid">
      <label>
        Age
        <input type="number" min="12" max="80" step="1" bind:value={input.currentAge} />
      </label>
      <label>
        FI Target year
        <input type="number" min="25" max="80" step="1" bind:value={input.retirementAge} />
      </label>
      <label>
        Until year
        <input type="number" min="50" max="110" step="1" bind:value={input.simulateUntilAge} />
      </label>
      
    </div>

    <div class="section-split">
      <div>
        <div class="data-table">
          <div class="table-header"><span>Income sources</span><span>From</span><span>To</span><span>Yearly</span><span class="inflation-cell" title="Inflation-adjusted">Infl</span><span></span></div>
          {#each incomeSources as src (src.id)}
            <div class="table-row">
              <input type="text" bind:value={src.label} placeholder="Salary" />

              {#if src.id === 'is-default'}
                <div class="readonly-age-cell" aria-label="Salary starts at current age">{fmtNum(input.currentAge)}</div>
              {:else}
                <input class="age-input" type="number" min="0" step="1" bind:value={src.fromAge} />
              {/if}

              {#if src.id === 'is-default'}
                <div class="readonly-age-cell" aria-label="Salary ends at FI target year">{fmtNum(input.retirementAge)}</div>
              {:else if src.id === 'is-pension'}
                <div class="readonly-age-cell" aria-label="Pension ends at simulation end year">{fmtNum(input.simulateUntilAge)}</div>
              {:else}
                <input class="age-input" type="number" min="0" step="1" bind:value={src.toAge} />
              {/if}

              <input type="text" inputmode="numeric" value={fmtNum(src.yearlyAmount)} onchange={(e) => { src.yearlyAmount = numFromEvent(e); incomeSources = incomeSources; }} />
              <span class="inflation-cell">
                <input class="inflation-flag" type="checkbox" bind:checked={src.inflationAdjusted} title="Inflation-adjusted" aria-label="Inflation-adjusted income" />
              </span>
              {#if src.id !== 'is-default' && src.id !== 'is-pension'}
                <button class="btn-remove" onclick={() => removeIncomeSource(src.id)}>×</button>
              {:else}
                <span></span>
              {/if}
            </div>
          {/each}
        </div>
        <button class="btn-add" onclick={addIncomeSource}>+ Add income</button>
      </div>

      <div class="section-split">
        <div class="data-table">
          <div class="table-header"><span>Expenses</span><span>From</span><span>To</span><span>Yearly</span><span class="inflation-cell" title="Inflation-adjusted">Infl</span><span></span></div>
          {#each spendingPeriods as period (period.id)}
            <div class="table-row">
              <input type="text" bind:value={period.label} placeholder="Living" />

              {#if period.id === 'sp-default'}
                <div class="readonly-age-cell" aria-label="Living expenses starts at current age">{fmtNum(input.currentAge)}</div>
              {:else}
                <input class="age-input" type="number" min="0" step="1" bind:value={period.fromAge} />
              {/if}

              {#if period.id === 'sp-default'}
                <div class="readonly-age-cell" aria-label="Living expenses ends at simulation end year">{fmtNum(input.simulateUntilAge)}</div>
              {:else}
                <input class="age-input" type="number" min="0" step="1" bind:value={period.toAge} />
              {/if}

              <input type="text" inputmode="numeric" value={fmtNum(period.yearlyAmount)} onchange={(e) => { period.yearlyAmount = numFromEvent(e); spendingPeriods = spendingPeriods; }} />
              <span class="inflation-cell">
                <input class="inflation-flag" type="checkbox" bind:checked={period.inflationAdjusted} title="Inflation-adjusted" aria-label="Inflation-adjusted spending" />
              </span>
              {#if period.id !== 'sp-default'}
                <button class="btn-remove" onclick={() => removeSpendingPeriod(period.id)}>×</button>
              {:else}
                <span></span>
              {/if}
            </div>
          {/each}
        </div>
        <button class="btn-add" onclick={addSpendingPeriod}>+ Add period</button>
      </div>

      <div class="section-split">
        <p class="section-label">One-Time Events</p>
        {#if lumpSumEvents.length > 0}
          <div class="data-table data-table-events">
            <div class="table-header"><span>Label</span><span>Age</span><span>Amount</span><span></span></div>
            {#each lumpSumEvents as evt (evt.id)}
              <div class="table-row">
                <input type="text" bind:value={evt.label} placeholder="Tuition" />
                <input type="number" min="0" step="1" bind:value={evt.age} />
                <input type="text" inputmode="numeric" value={fmtNum(evt.amount)} onchange={(e) => { evt.amount = numFromEvent(e); lumpSumEvents = lumpSumEvents; }} />
                <button class="btn-remove" onclick={() => removeLumpSumEvent(evt.id)}>×</button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="note">No one-time events added.</p>
        {/if}
        <button class="btn-add" onclick={addLumpSumEvent}>+ Add event</button>
      </div>
    </div>
    <div class="allocation-control">
    <label>
        Portfolio ({selectedCurrency.symbol})
        <input type="text" inputmode="numeric" value={fmtNum(input.currentSavings)} onchange={(e) => { input.currentSavings = numFromEvent(e); input = input; }} />
      </label>
      <div class="allocation-head">
        <span>Investment split</span>
        <span class="mono-value">Stocks {stockAllocationPercent}% · Bonds {bondAllocationPercent}% · Bank {bankAllocationPercent}%</span>
      </div>
      <div class="allocation-slider-wrap" aria-label="Investment split slider">
        <div class="allocation-track">
          <span class="allocation-segment stocks" style={`width: ${stockAllocationPercent}%`}></span>
          <span class="allocation-segment bonds" style={`left: ${stockAllocationPercent}%; width: ${bondAllocationPercent}%`}></span>
          <span class="allocation-segment bank" style={`left: ${bondBoundaryPercent}%; width: ${bankAllocationPercent}%`}></span>
        </div>
        <input class="allocation-range" type="range" min="0" max="100" step="1" bind:value={stockBoundaryPercent} oninput={onStockBoundaryChange} aria-label="Stocks allocation boundary" />
        <input class="allocation-range allocation-range-top" type="range" min="0" max="100" step="1" bind:value={bondBoundaryPercent} oninput={onBondBoundaryChange} aria-label="Bonds allocation boundary" />
      </div>
    </div>
  </div>

  <div class="card">
    <div class="assumptions-titlebar">
      <h3>Assumptions</h3>
      <button class="assumptions-reset-btn" type="button" onclick={resetAssumptionsToCurrencyDefaults}>Reset to currency defaults</button>
    </div>
    
    <div>
      <label>
        Simulation mode
        <select bind:value={input.simulationMode}>
          <option value="historical">Historical bootstrapping</option>
          <option value="parametric">Parametric</option>
        </select>
      </label>
      {#if selectedHistoricalRegion}
      <p class="note mono-value">
        Historical market dataset loaded:<br />
        {selectedHistoricalRegion.label} ({selectedHistoricalRegion.coverage}, {selectedHistoricalRegion.sampleSize} annual observations)
        <button
          type="button"
          class="inline-link"
          onclick={() => { showHistoricalMethodologyInfo = !showHistoricalMethodologyInfo; }}
          aria-expanded={showHistoricalMethodologyInfo}
        >
          {showHistoricalMethodologyInfo ? 'less info' : 'more info'}
        </button>
      </p>
      {#if showHistoricalMethodologyInfo}
        <div class="note mono-value methodology-info">
          Active calibration dataset (used now):<br />
          • Coverage: {selectedHistoricalRegion.coverage} ({selectedHistoricalRegion.sampleSize} annual observations), built from monthly market data.<br />
          • Equity (stocks): monthly close-to-close total return proxies from Stooq index series, then compounded to annual returns.<br />
          • Bonds: synthetic 10Y bond total-return proxy from monthly yield change + carry (duration-based), then compounded to annual returns.<br />
          • Bank/cash: short-rate proxy converted as monthly rate/12 and compounded to annual returns.<br />
          • For each instrument (stocks, bonds, bank), Average/Volatility/Skew/Kurt are sample moments computed from that annual return series (not handbook constants).<br />
          • Monte Carlo path is monthly; when monthly history is available, calibration now uses empirical monthly portfolio returns with monthly regime detection/bootstrap. Annual moments are retained for summary/inputs.<br />
          • Inflation currently remains a curated long-run reference input (separate from this market-file pipeline), with user-editable mean/volatility and neutral default shape (skew 0, kurt 3).<br />
          • Legacy reference assumptions (MSCI/STOXX/FTSE/FRED/ECB/ONS-style long-run sources) remain broadly in line; this pipeline is preferred because it is one reproducible method across regions.
        </div>
      {/if}
    {:else if historicalDataLoadError}
      <p class="note mono-value">{historicalDataLoadError}</p>
    {/if}
    </div>
    <div class="assumptions-table-wrap">
      <table class="assumptions-table mono-value">
        <thead>
          <tr>
            <th></th>
            <th>Average</th>
            <th>Volat.</th>
            <th>Skew</th>
            <th>Kurt</th>
            <th>Reset</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Stocks</td>
            <td><input type="text" inputmode="decimal" value={fmtPercentInputSig3(investmentMetrics.stockMean)} onchange={(e) => { investmentMetrics.stockMean = decimalFromPercentEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtPercentInputSig3(investmentMetrics.stockStd)} onchange={(e) => { investmentMetrics.stockStd = decimalFromPercentEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtNum(investmentMetrics.stockSkew, 2)} onchange={(e) => { investmentMetrics.stockSkew = numFromEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtNum(investmentMetrics.stockKurt, 2)} onchange={(e) => { investmentMetrics.stockKurt = numFromEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><button type="button" class="assumptions-reset-cell-btn" onclick={resetStockMetricsToDefault}>Reset</button></td>
          </tr>

          <tr>
            <td>Bonds</td>
            <td><input type="text" inputmode="decimal" value={fmtPercentInputSig3(investmentMetrics.bondMean)} onchange={(e) => { investmentMetrics.bondMean = decimalFromPercentEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtPercentInputSig3(investmentMetrics.bondStd)} onchange={(e) => { investmentMetrics.bondStd = decimalFromPercentEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtNum(investmentMetrics.bondSkew, 2)} onchange={(e) => { investmentMetrics.bondSkew = numFromEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtNum(investmentMetrics.bondKurt, 2)} onchange={(e) => { investmentMetrics.bondKurt = numFromEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><button type="button" class="assumptions-reset-cell-btn" onclick={resetBondMetricsToDefault}>Reset</button></td>
          </tr>

          <tr>
            <td>Cash</td>
            <td><input type="text" inputmode="decimal" value={fmtPercentInputSig3(investmentMetrics.bankMean)} onchange={(e) => { investmentMetrics.bankMean = decimalFromPercentEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtPercentInputSig3(investmentMetrics.bankStd)} onchange={(e) => { investmentMetrics.bankStd = decimalFromPercentEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtNum(investmentMetrics.bankSkew, 2)} onchange={(e) => { investmentMetrics.bankSkew = numFromEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtNum(investmentMetrics.bankKurt, 2)} onchange={(e) => { investmentMetrics.bankKurt = numFromEvent(e); onInvestmentMetricChange(); }} /></td>
            <td><button type="button" class="assumptions-reset-cell-btn" onclick={resetBankMetricsToDefault}>Reset</button></td>
          </tr>
          <tr>
            <td>Equity-bond <br />correlation</td>
            <td><input type="text" inputmode="decimal" value={fmtNum(input.equityBondCorrelation, 2)} onchange={(e) => { input.equityBondCorrelation = clamp(numFromEvent(e), -1, 1); onInvestmentMetricChange(); }} /></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>

          <tr class="portfolio-row portfolio-highlight-row" class:positive-return-row={input.meanReturn >= 0} class:negative-return-row={input.meanReturn < 0}>
            <td>Portfolio</td>
            <td>{fmtPercentDisplay(input.meanReturn, 1)}</td>
            <td>{fmtPercentDisplay(input.returnVariability, 1)}</td>
            <td>{fmtNum(portfolioDisplaySkew, 2)}</td>
            <td>{fmtNum(portfolioDisplayKurt, 1)}</td>
            <td></td>
          </tr>



          <tr class="assumptions-separator"><td colspan="6"></td></tr>

          <tr>
            <td>Inflation</td>
            <td><input type="text" inputmode="decimal" value={fmtPercentInputSig3(input.inflationMean)} onchange={(e) => { input.inflationMean = decimalFromPercentEvent(e); input = input; }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtPercentInputSig3(input.inflationVariability)} onchange={(e) => { input.inflationVariability = decimalFromPercentEvent(e); input = input; }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtNum(input.inflationSkewness, 2)} onchange={(e) => { input.inflationSkewness = numFromEvent(e); input = input; }} /></td>
            <td><input type="text" inputmode="decimal" value={fmtNum(input.inflationKurtosis, 2)} onchange={(e) => { input.inflationKurtosis = Math.max(1, numFromEvent(e)); input = input; }} /></td>
            <td><button type="button" class="assumptions-reset-cell-btn" onclick={resetInflationToDefault}>Reset</button></td>
          </tr>

          <tr>
            <td>Annual fees</td>
            <td><input type="text" inputmode="decimal" value={fmtPercentDisplay(input.annualFeePercent, 2)} onchange={(e) => { input.annualFeePercent = clamp(decimalFromPercentEvent(e), 0, 1); input = input; }} /></td>
            <td></td>
            <td></td>
            <td></td>
            <td><button type="button" class="assumptions-reset-cell-btn" onclick={resetDragToDefault}>Reset</button></td>
          </tr>

          <tr>
            <td>Tax on gains</td>
            <td><input type="text" inputmode="decimal" value={fmtPercentDisplay(input.taxOnGainsPercent, 2)} onchange={(e) => { input.taxOnGainsPercent = clamp(decimalFromPercentEvent(e), 0, 1); input = input; }} /></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>

          <tr class="portfolio-row real-return-highlight-row" class:positive-return-row={realReturnEstimate >= 0} class:negative-return-row={realReturnEstimate < 0}>
            <td>Real return</td>
            <td>{fmtPercentDisplay(realReturnEstimate, 1)}</td>
            <td>{fmtPercentDisplay(realReturnStdEstimate, 1)}</td>
            <td>{fmtNum(realReturnSkewEstimate, 2)}</td>
            <td>{fmtNum(realReturnKurtEstimate, 1)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="real-return-cdf-wrap">
      <p class="note mono-value"><br />Real return cumulative probability <br />(68% and 95% ranges shaded)</p>
      <div class="real-return-cdf" bind:this={realReturnCdfEl} role="img" aria-label="Real return cumulative probability plot"></div>
    </div>
  </div>

  {#if errorMessage}
    <div class="error">{errorMessage}</div>
  {/if}
</section>
