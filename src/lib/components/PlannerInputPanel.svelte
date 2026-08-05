<script lang="ts">
	import type {
		CurrencyCode,
		HistoricalRegionDataset,
		InvestmentMetricInputs
	} from '../calculations';
	import type { CurrencyOption } from '../plannerTypes';
	import type {
		IncomeSource,
		LumpSumEvent,
		RetirementInput,
		SpendingPeriod
	} from '../retirementEngine';

	let {
		CURRENCIES = [],
		selectedCurrencyCode = $bindable(),
		selectedCurrency,
		input = $bindable(),
		incomeSources = $bindable([]),
		spendingPeriods = $bindable([]),
		lumpSumEvents = $bindable([]),
		stockBoundaryPercent = $bindable(0),
		bondBoundaryPercent = $bindable(0),
		stockAllocationPercent = 0,
		bondAllocationPercent = 0,
		bankAllocationPercent = 0,
		investmentMetrics,
		parametricMetrics = $bindable(),
		parametricInflationMean = $bindable(0),
		parametricInflationVariability = $bindable(0),
		parametricInflationSkewness = $bindable(0),
		parametricInflationKurtosis = $bindable(0),
		selectedHistoricalRegion,
		historicalDataLoadError = '',
		showHistoricalMethodologyInfo = $bindable(false),
		portfolioDisplaySkew = 0,
		portfolioDisplayKurt = 0,
		realReturnEstimate = 0,
		realReturnStdEstimate = 0,
		realReturnSkewEstimate = 0,
		realReturnKurtEstimate = 0,
		errorMessage = '',
		realReturnCdfEl = $bindable(null),

		fmtNum,
		numFromEvent,
		decimalFromPercentEvent,
		fmtPercentInputSig3,
		fmtPercentDisplay,
		clamp,

		addIncomeSource,
		removeIncomeSource,
		addSpendingPeriod,
		removeSpendingPeriod,
		addLumpSumEvent,
		removeLumpSumEvent,
		onStockBoundaryChange,
		onBondBoundaryChange,
		onInvestmentMetricChange,
		onInflationMetricChange,
		onSimulationSettingsChange,
		resetStockMetricsToDefault,
		resetBondMetricsToDefault,
		resetBankMetricsToDefault,
		resetInflationToDefault,
		resetDragToDefault,
		onAssumptionsToggle = undefined,
		currentConditions = null,
		applyCurrentConditions = () => {},
		alreadyRetired = false,
		onAlreadyRetiredChange = () => {}
	}: {
		CURRENCIES?: CurrencyOption[];
		selectedCurrencyCode: CurrencyCode;
		selectedCurrency: CurrencyOption;
		input: RetirementInput;
		incomeSources?: IncomeSource[];
		spendingPeriods?: SpendingPeriod[];
		lumpSumEvents?: LumpSumEvent[];
		stockBoundaryPercent?: number;
		bondBoundaryPercent?: number;
		stockAllocationPercent?: number;
		bondAllocationPercent?: number;
		bankAllocationPercent?: number;
		investmentMetrics: InvestmentMetricInputs;
		parametricMetrics: InvestmentMetricInputs;
		parametricInflationMean?: number;
		parametricInflationVariability?: number;
		parametricInflationSkewness?: number;
		parametricInflationKurtosis?: number;
		selectedHistoricalRegion: HistoricalRegionDataset | null;
		historicalDataLoadError?: string;
		showHistoricalMethodologyInfo?: boolean;
		portfolioDisplaySkew?: number;
		portfolioDisplayKurt?: number;
		realReturnEstimate?: number;
		realReturnStdEstimate?: number;
		realReturnSkewEstimate?: number;
		realReturnKurtEstimate?: number;
		errorMessage?: string;
		realReturnCdfEl?: HTMLDivElement | null;

		fmtNum: (value: number, decimals?: number) => string;
		numFromEvent: (e: Event) => number;
		decimalFromPercentEvent: (e: Event) => number;
		fmtPercentInputSig3: (value: number) => string;
		fmtPercentDisplay: (value: number, decimals?: number) => string;
		clamp: (value: number, min: number, max: number) => number;

		addIncomeSource: () => void;
		removeIncomeSource: (id: string) => void;
		addSpendingPeriod: () => void;
		removeSpendingPeriod: (id: string) => void;
		addLumpSumEvent: () => void;
		removeLumpSumEvent: (id: string) => void;
		onStockBoundaryChange: () => void;
		onBondBoundaryChange: () => void;
		onInvestmentMetricChange: () => void;
		onInflationMetricChange: () => void;
		onSimulationSettingsChange: () => void;
		resetStockMetricsToDefault: () => void;
		resetBondMetricsToDefault: () => void;
		resetBankMetricsToDefault: () => void;
		resetInflationToDefault: () => void;
		resetDragToDefault: () => void;
		onAssumptionsToggle?: () => void;
		currentConditions?: {
			asOf: string;
			equityRiskPremium: number;
			metrics: { stockMean: number; bondMean: number; bankMean: number };
		} | null;
		applyCurrentConditions?: () => void;
		alreadyRetired?: boolean;
		onAlreadyRetiredChange?: (next: boolean) => void;
	} = $props();

	const DEFAULT_WITHDRAWAL_STRATEGY = {
		kind: 'fixed' as const,
		guardrailBand: 0.2,
		adjustment: 0.1,
		withdrawalPercent: 0.04,
		spendingFloor: 0.6,
		spendingCeiling: 1.4
	};

	function setWithdrawalKind(kind: 'fixed' | 'guardrails' | 'percentOfPortfolio') {
		input.withdrawalStrategy = {
			...DEFAULT_WITHDRAWAL_STRATEGY,
			...input.withdrawalStrategy,
			kind
		};
		onSimulationSettingsChange();
	}

	function updateWithdrawalParam(
		key: 'guardrailBand' | 'adjustment' | 'withdrawalPercent' | 'spendingFloor' | 'spendingCeiling',
		value: number
	) {
		const current = input.withdrawalStrategy ?? { ...DEFAULT_WITHDRAWAL_STRATEGY };
		input.withdrawalStrategy = {
			...DEFAULT_WITHDRAWAL_STRATEGY,
			...current,
			[key]: Math.max(0, value)
		};
		onSimulationSettingsChange();
	}
</script>

<section class="left-panel">
	<div class="currency-switch" role="group" aria-label="Currency selection">
		{#each CURRENCIES as c (c.code)}
			<button
				type="button"
				class={`currency-btn currency-${c.code.toLowerCase()}`}
				style={c.flagAsset ? `--flag-url: url('${c.flagAsset}')` : ''}
				class:active={selectedCurrencyCode === c.code}
				onclick={() => {
					selectedCurrencyCode = c.code;
				}}
				aria-pressed={selectedCurrencyCode === c.code}
			>
				<span>{c.buttonLabel}</span>
			</button>
		{/each}
	</div>

	<div class="card input-overview-card">
		<div class="form-grid">
			<label>
				Current age
				<input type="number" min="12" max="80" step="1" bind:value={input.currentAge} />
			</label>
			<label
				class="already-retired"
				title="Drawdown only: retirement starts today, so there is no saving phase."
			>
				<input
					type="checkbox"
					checked={alreadyRetired}
					onchange={(e) => onAlreadyRetiredChange(e.currentTarget.checked)}
				/>
				<span>Already retired</span>
			</label>
			<label class:input-disabled={alreadyRetired}>
				Retire at age
				<input
					type="number"
					min="25"
					max="80"
					step="1"
					disabled={alreadyRetired}
					title={alreadyRetired ? 'Already retired — retirement is now, at your current age.' : ''}
					value={input.retirementAge}
					onchange={(e) => {
						input.retirementAge = numFromEvent(e);
					}}
				/>
			</label>
			<label title="A longer planning horizon provides a more conservative longevity stress test.">
				Plan until age
				<input type="number" min="50" max="110" step="1" bind:value={input.simulateUntilAge} />
			</label>
		</div>
		<div class="section-split">
			<div>
				<div class="data-table">
					<div class="table-header">
						<span>Income sources</span><span>From</span><span>To</span><span>Yearly</span><span
							class="inflation-cell"
							title="Inflation-adjusted">Infl<br />adj.</span
						><span></span>
					</div>
					<!-- The salary row spans current age → retirement age, an interval that is empty
					     once retirement is today. It is hidden rather than zeroed so it keeps its
					     amount for anyone who unticks the box. -->
					{#each incomeSources.filter((src: { id: string }) => !(alreadyRetired && src.id === 'is-default')) as src (src.id)}
						<div class="table-row">
							<input type="text" bind:value={src.label} placeholder="Salary" />

							{#if src.id === 'is-default'}
								<div class="readonly-age-cell" aria-label="Salary starts at current age">
									{fmtNum(input.currentAge)}
								</div>
							{:else}
								<input class="age-input" type="number" min="0" step="1" bind:value={src.fromAge} />
							{/if}

							{#if src.id === 'is-default'}
								<div class="readonly-age-cell" aria-label="Salary ends at retirement age">
									{fmtNum(input.retirementAge)}
								</div>
							{:else if src.id === 'is-pension'}
								<div class="readonly-age-cell" aria-label="Pension ends at plan-until age">
									{fmtNum(input.simulateUntilAge)}
								</div>
							{:else}
								<input class="age-input" type="number" min="0" step="1" bind:value={src.toAge} />
							{/if}

							<input
								type="text"
								inputmode="numeric"
								value={fmtNum(src.yearlyAmount)}
								onchange={(e) => {
									src.yearlyAmount = numFromEvent(e);
									onSimulationSettingsChange();
								}}
							/>
							<span class="inflation-cell">
								<input
									class="inflation-flag"
									type="checkbox"
									bind:checked={src.inflationAdjusted}
									title="Inflation-adjusted"
									aria-label="Inflation-adjusted income"
								/>
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
					<div class="table-header">
						<span>Expenses</span><span>From</span><span>To</span><span>Yearly</span><span
							class="inflation-cell"
							title="Inflation-adjusted">Infl<br />adj.</span
						><span></span>
					</div>
					{#each spendingPeriods as period (period.id)}
						<div class="table-row">
							<input type="text" bind:value={period.label} placeholder="Living" />

							{#if period.id === 'sp-default'}
								<div class="readonly-age-cell" aria-label="Living expenses starts at current age">
									{fmtNum(input.currentAge)}
								</div>
							{:else}
								<input
									class="age-input"
									type="number"
									min="0"
									step="1"
									bind:value={period.fromAge}
								/>
							{/if}

							{#if period.id === 'sp-default'}
								<div class="readonly-age-cell" aria-label="Living expenses end at plan-until age">
									{fmtNum(input.simulateUntilAge)}
								</div>
							{:else}
								<input class="age-input" type="number" min="0" step="1" bind:value={period.toAge} />
							{/if}

							<input
								type="text"
								inputmode="numeric"
								value={fmtNum(period.yearlyAmount)}
								onchange={(e) => {
									period.yearlyAmount = numFromEvent(e);
									onSimulationSettingsChange();
								}}
							/>
							<span class="inflation-cell">
								<input
									class="inflation-flag"
									type="checkbox"
									bind:checked={period.inflationAdjusted}
									title="Inflation-adjusted"
									aria-label="Inflation-adjusted spending"
								/>
							</span>
							{#if period.id !== 'sp-default'}
								<button class="btn-remove" onclick={() => removeSpendingPeriod(period.id)}>×</button
								>
							{:else}
								<span></span>
							{/if}
						</div>
					{/each}
				</div>
				<button class="btn-add" onclick={addSpendingPeriod}>+ Add period</button>
				<p class="note">Income left after expenses is assumed to be invested.</p>
			</div>

			<div class="section-split">
				<p class="eyebrow">One-Time Events</p>
				<p class="note">Enter one-time amounts in today's purchasing power.</p>
				{#if lumpSumEvents.length > 0}
					<div class="data-table data-table-events">
						<div class="table-header">
							<span>Label</span><span>Age</span><span>Amount</span><span></span>
						</div>
						{#each lumpSumEvents as evt (evt.id)}
							<div class="table-row">
								<input type="text" bind:value={evt.label} placeholder="Tuition" />
								<input type="number" min="0" step="1" bind:value={evt.age} />
								<input
									type="text"
									inputmode="numeric"
									value={fmtNum(evt.amount)}
									onchange={(e) => {
										evt.amount = numFromEvent(e);
										onSimulationSettingsChange();
									}}
								/>
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

		<div class="section-split withdrawal-strategy-block">
			<p class="eyebrow">
				Spending in retirement
				<span
					class="strategy-hint"
					title="How your retirement spending responds to how the portfolio actually performs."
					>(?)</span
				>
			</p>
			<div class="strategy-toggle-group" role="group" aria-label="Withdrawal strategy">
				<button
					type="button"
					class="btn-mode"
					class:active={(input.withdrawalStrategy?.kind ?? 'fixed') === 'fixed'}
					onclick={() => setWithdrawalKind('fixed')}
					aria-pressed={(input.withdrawalStrategy?.kind ?? 'fixed') === 'fixed'}
					title="Spend the same amount every year, adjusted for inflation. Simple, but ignores market performance."
				>
					Fixed<br />(steady)
				</button>
				<button
					type="button"
					class="btn-mode"
					class:active={input.withdrawalStrategy?.kind === 'guardrails'}
					onclick={() => setWithdrawalKind('guardrails')}
					aria-pressed={input.withdrawalStrategy?.kind === 'guardrails'}
					title="Simplified withdrawal-rate guardrails inspired by Guyton-Klinger: trim spending when the withdrawal rate rises beyond its band, and raise it when the rate falls below the band."
				>
					Guardrails<br />(adaptive)
				</button>
				<button
					type="button"
					class="btn-mode"
					class:active={input.withdrawalStrategy?.kind === 'percentOfPortfolio'}
					onclick={() => setWithdrawalKind('percentOfPortfolio')}
					aria-pressed={input.withdrawalStrategy?.kind === 'percentOfPortfolio'}
					title="Recalculate portfolio-funded spending annually from the current balance. Spending adapts, but the floor, market losses, taxes, and other outflows mean the portfolio can still run out."
				>
					% of portfolio
				</button>
			</div>

			{#if input.withdrawalStrategy?.kind === 'guardrails'}
				<div class="strategy-params">
					<label>
						Guardrail band
						<input
							type="text"
							inputmode="decimal"
							value={fmtPercentInputSig3(input.withdrawalStrategy.guardrailBand ?? 0.2)}
							onchange={(e) => updateWithdrawalParam('guardrailBand', decimalFromPercentEvent(e))}
						/>
					</label>
					<label>
						Adjustment step
						<input
							type="text"
							inputmode="decimal"
							value={fmtPercentInputSig3(input.withdrawalStrategy.adjustment ?? 0.1)}
							onchange={(e) => updateWithdrawalParam('adjustment', decimalFromPercentEvent(e))}
						/>
					</label>
				</div>
				<p class="note strategy-note">
					Cuts or raises spending by the adjustment step whenever your withdrawal rate drifts past
					the band from its starting level. Spending stays within {fmtPercentDisplay(
						input.withdrawalStrategy.spendingFloor ?? 0.6,
						0
					)}–{fmtPercentDisplay(input.withdrawalStrategy.spendingCeiling ?? 1.4, 0)} of your planned amount.
				</p>
			{:else if input.withdrawalStrategy?.kind === 'percentOfPortfolio'}
				<div class="strategy-params">
					<label>
						Withdraw each year
						<input
							type="text"
							inputmode="decimal"
							value={fmtPercentInputSig3(input.withdrawalStrategy.withdrawalPercent ?? 0.04)}
							onchange={(e) =>
								updateWithdrawalParam('withdrawalPercent', decimalFromPercentEvent(e))}
						/>
					</label>
				</div>
				<p class="note strategy-note">
					Spends this share of the current balance each year, clamped to {fmtPercentDisplay(
						input.withdrawalStrategy.spendingFloor ?? 0.6,
						0
					)}–{fmtPercentDisplay(input.withdrawalStrategy.spendingCeiling ?? 1.4, 0)} of your planned amount
					so income never collapses or balloons.
				</p>
			{:else}
				<p class="note strategy-note">
					Keeps planned real spending unchanged regardless of portfolio performance — the
					conventional assumption behind fixed-withdrawal analyses such as the “4% rule”.
				</p>
			{/if}
		</div>

		<div class="allocation-control">
			<label>
				Portfolio ({selectedCurrency.symbol})
				<input
					type="text"
					inputmode="numeric"
					value={fmtNum(input.currentSavings)}
					onchange={(e) => {
						input.currentSavings = numFromEvent(e);
						onSimulationSettingsChange();
					}}
				/>
			</label>
			<div class="allocation-head">
				<span>Investment split</span>
				<span class="mono-value"
					>Stocks {stockAllocationPercent}% · Bonds {bondAllocationPercent}% · Bank {bankAllocationPercent}%</span
				>
			</div>
			<div class="allocation-slider-wrap" aria-label="Investment split slider">
				<div class="allocation-track">
					<span class="allocation-segment stocks" style={`width: ${stockAllocationPercent}%`}
					></span>
					<span
						class="allocation-segment bonds"
						style={`left: ${stockAllocationPercent}%; width: ${bondAllocationPercent}%`}
					></span>
					<span
						class="allocation-segment bank"
						style={`left: ${bondBoundaryPercent}%; width: ${bankAllocationPercent}%`}
					></span>
				</div>
				<input
					class="allocation-range"
					type="range"
					min="0"
					max="100"
					step="1"
					bind:value={stockBoundaryPercent}
					oninput={onStockBoundaryChange}
					aria-label="Stocks allocation boundary"
				/>
				<input
					class="allocation-range allocation-range-top"
					type="range"
					min="0"
					max="100"
					step="1"
					bind:value={bondBoundaryPercent}
					oninput={onBondBoundaryChange}
					aria-label="Bonds allocation boundary"
				/>
			</div>
		</div>
	</div>

	<details
		class="card"
		ontoggle={(e) => {
			if ((e.target as HTMLDetailsElement).open) onAssumptionsToggle?.();
		}}
	>
		<summary>
			Advanced assumptions
			<span class="assumptions-summary-line">
				{#if input.simulationMode === 'parametric'}
					parametric (user inputs)
				{:else if selectedHistoricalRegion}
					{selectedHistoricalRegion.label} history {selectedHistoricalRegion.coverage}{input.historicalMomentTargeting
						? ' (adjusted)'
						: ''}
				{:else}
					fallback assumptions
				{/if}
				· {fmtPercentDisplay(input.annualFeePercent, 1)} fees · {fmtPercentDisplay(
					input.taxOnGainsPercent,
					0
				)} tax — open to customize the model
			</span>
		</summary>

		<div class="simulation-mode-section">
			<div class="simulation-mode-options" role="group" aria-label="Simulation mode selection">
				<div class="simulation-mode-option">
					<button
						type="button"
						class="btn-mode"
						class:active={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
						onclick={() => {
							input.simulationMode = 'historical';
							input.historicalMomentTargeting = false;
							onSimulationSettingsChange();
						}}
						aria-pressed={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
						title="Replays real market history. Stitches together runs of actual past months in their original order. Returns and inflation are taken from the same real months, so the two stay linked. Averages match history and cannot be edited — the table below is read-only in this mode."
					>
						Historical<br />Data Sampling
					</button>
				</div>
				<div class="simulation-mode-option">
					<button
						type="button"
						class="btn-mode"
						class:active={input.simulationMode === 'historical' && input.historicalMomentTargeting}
						onclick={() => {
							input.simulationMode = 'historical';
							input.historicalMomentTargeting = true;
							onSimulationSettingsChange();
						}}
						aria-pressed={input.simulationMode === 'historical' && input.historicalMomentTargeting}
						title="The same real market history, rescaled to return targets you choose. Keeps history's shape — the crashes, recoveries and clustering — while sliding average return and volatility to your numbers. Use it to ask 'what if returns are worse than the past?'. Trade-off: inflation reverts to a modelled draw, so the return/inflation link is lost."
					>
						Historical <br />(with Adjustments)
					</button>
					{#if currentConditions}
						<button
							type="button"
							class="btn-preset current-yields-btn"
							onclick={applyCurrentConditions}
							title="Use the latest yields embedded in this dataset plus the historical equity risk premium as editable return assumptions. These are dated observations, not live market data."
						>
							Use 2025–2026 yields
						</button>
						<span class="current-yields-note mono-value">
							{fmtPercentDisplay(currentConditions.metrics.bankMean, 1)} cash ·
							{fmtPercentDisplay(currentConditions.metrics.bondMean, 1)} bonds ·
							{fmtPercentDisplay(currentConditions.metrics.stockMean, 1)} stocks<br />
							<span>(as of {currentConditions.asOf})</span>
						</span>
					{/if}
				</div>
				<div class="simulation-mode-option">
					<button
						type="button"
						class="btn-mode"
						class:active={input.simulationMode === 'parametric'}
						onclick={() => {
							input.simulationMode = 'parametric';
							input.historicalMomentTargeting = false;
							onSimulationSettingsChange();
						}}
						aria-pressed={input.simulationMode === 'parametric'}
						title="Uses no historical data. Returns are generated from a statistical model built only from the numbers you enter, via a two-state growth/crisis regime switcher with fat-tailed draws. Most flexible and least anchored to reality — for exploring hypothetical markets rather than planning against history."
					>
						Parametric<br />(User Inputs)
					</button>
				</div>
			</div>
			<div class="assumption-context">
				<p class="assumption-context-line">
					{#if input.simulationMode === 'parametric'}
						<strong>Uses no historical data.</strong> Returns are generated from a statistical model built
						only from the numbers you enter below. Most flexible, least anchored to what markets actually
						did.
					{:else if input.historicalMomentTargeting}
						<strong>Real history, rescaled to your targets.</strong> Keeps the shape of history — the
						crashes, recoveries and clustering — but slides average return and volatility to the values
						you set below. Answers “what if returns are worse than the past?”. Inflation falls back to
						a modelled draw in this mode.
					{:else}
						<strong>Replays real market history.</strong> Stitches together runs of actual past months
						in their original order. Returns and inflation come from the same real months, so high-inflation
						periods land on the markets that truly accompanied them. Averages match history, so the table
						below is read-only.
					{/if}
				</p>

				{#if selectedHistoricalRegion}
					{#if input.historicalMonthlyInflation?.length}
						<p
							class="assumption-context-line"
							title="Each simulated month draws its return and its inflation from the same real historical month, so high-inflation periods land on the same months as weak markets — and inflation keeps its real-world persistence."
						>
							<strong>✓ Inflation sampled jointly with returns from history</strong>
						</p>
					{/if}
					<p class="assumption-context-line">
						<strong>Historical dataset:</strong>
						{selectedHistoricalRegion.label}: {selectedHistoricalRegion.sampleSize} complete annual observations
						({selectedHistoricalRegion.annualCoverage ?? selectedHistoricalRegion.coverage});
						monthly data {selectedHistoricalRegion.monthlyCoverage ?? 'coverage unavailable'}
						<button
							type="button"
							class="inline-link"
							onclick={() => {
								showHistoricalMethodologyInfo = !showHistoricalMethodologyInfo;
							}}
							aria-expanded={showHistoricalMethodologyInfo}
						>
							{showHistoricalMethodologyInfo ? 'less info' : 'more info'}
						</button>
					</p>
					{#if showHistoricalMethodologyInfo}
						<div class="note mono-value methodology-info">
							Active calibration dataset (used now):<br />
							• Coverage: {selectedHistoricalRegion.annualCoverage ??
								selectedHistoricalRegion.coverage}
							({selectedHistoricalRegion.sampleSize} complete annual observations); CPI-aligned monthly
							series {selectedHistoricalRegion.monthlyCoverage ?? 'unavailable'}.<br />
							• Equity (stocks): estimated monthly total-return proxies from Stooq price-index series
							(with synthetic dividend adjustments if needed, e.g. for CAC). World blend includes US/EUR/UK
							+ Japan (Nikkei) and Asia/EM (Hang Seng, backfilled 1960-69 with Nikkei to preserve deep
							history). All foreign indices in the World blend are converted to USD.<br />
							• Bonds: synthetic 10Y bond total-return proxy from monthly yield change + carry (duration-based),
							then compounded to annual returns.<br />
							• Bank/cash: short-rate proxy converted as monthly rate/12 and compounded to annual returns.<br
							/>
							• For each instrument (stocks, bonds, bank), Average/Volatility/Skew/Kurt are sample moments
							computed from that annual return series (not handbook constants).<br />
							• Monte Carlo path is monthly; when monthly history is available, calibration now uses empirical
							monthly portfolio returns with monthly regime detection/bootstrap. Annual moments are retained
							for summary/inputs.<br />
							• Inflation: in unadjusted Historical mode, regional CPI changes are replayed from the same
							months as returns. Adjusted Historical and Parametric modes instead use the editable modelled
							inflation assumptions.<br />
							• Sources: equity index prices from
							<a href="https://stooq.com/q/d/" target="_blank" rel="noopener noreferrer">Stooq</a>;
							bond yields, cash rates, CPI, and currency conversion from
							<a href="https://fred.stlouisfed.org/" target="_blank" rel="noopener noreferrer"
								>FRED</a
							>. Exact series IDs and transformations are listed in the
							<a
								href="https://github.com/sergeyfarin/retirement-planner#31-historical-sources-per-region"
								target="_blank"
								rel="noopener noreferrer">source methodology</a
							>.
						</div>
					{/if}
				{:else if historicalDataLoadError}
					<p class="assumption-context-line">{historicalDataLoadError}</p>
				{/if}
			</div>
		</div>
		<div class="assumptions-table-wrap">
			<table class="assumptions-table">
				<thead>
					<tr>
						<th></th>
						<th
							title="The arithmetic mean is the mathematical center used to generate random Monte Carlo paths."
							>Arith. Input</th
						>
						<th title="The statistical standard deviation (volatility).">Volatility</th>
						<th
							title="Expected Compound Annual Growth Rate (Geometric Mean). Growth over time is dragged down by volatility: CAGR ≈ Arithmetic Mean - Volatility²/2"
							>CAGR (Geom)</th
						>
						<th>Skew</th>
						<th>Kurt</th>
						<th>Reset</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Stocks</td>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentInputSig3(investmentMetrics.stockMean)}
								onchange={(e) => {
									parametricMetrics.stockMean = decimalFromPercentEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentInputSig3(investmentMetrics.stockStd)}
								onchange={(e) => {
									parametricMetrics.stockStd = decimalFromPercentEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							title="Variance Drag ≈ {fmtPercentDisplay(
								(investmentMetrics.stockStd * investmentMetrics.stockStd) / 2,
								2
							)}"
							>{fmtPercentDisplay(
								investmentMetrics.stockMean -
									(investmentMetrics.stockStd * investmentMetrics.stockStd) / 2,
								1
							)}</td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(investmentMetrics.stockSkew, 2)}
								onchange={(e) => {
									parametricMetrics.stockSkew = numFromEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(investmentMetrics.stockKurt, 2)}
								onchange={(e) => {
									parametricMetrics.stockKurt = numFromEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><button
								type="button"
								class="assumptions-reset-cell-btn"
								onclick={resetStockMetricsToDefault}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
								>Reset</button
							></td
						>
					</tr>

					<tr>
						<td>Bonds</td>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentInputSig3(investmentMetrics.bondMean)}
								onchange={(e) => {
									parametricMetrics.bondMean = decimalFromPercentEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentInputSig3(investmentMetrics.bondStd)}
								onchange={(e) => {
									parametricMetrics.bondStd = decimalFromPercentEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							title="Variance Drag ≈ {fmtPercentDisplay(
								(investmentMetrics.bondStd * investmentMetrics.bondStd) / 2,
								2
							)}"
							>{fmtPercentDisplay(
								investmentMetrics.bondMean -
									(investmentMetrics.bondStd * investmentMetrics.bondStd) / 2,
								1
							)}</td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(investmentMetrics.bondSkew, 2)}
								onchange={(e) => {
									parametricMetrics.bondSkew = numFromEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(investmentMetrics.bondKurt, 2)}
								onchange={(e) => {
									parametricMetrics.bondKurt = numFromEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><button
								type="button"
								class="assumptions-reset-cell-btn"
								onclick={resetBondMetricsToDefault}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
								>Reset</button
							></td
						>
					</tr>

					<tr>
						<td>Cash</td>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentInputSig3(investmentMetrics.bankMean)}
								onchange={(e) => {
									parametricMetrics.bankMean = decimalFromPercentEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentInputSig3(investmentMetrics.bankStd)}
								onchange={(e) => {
									parametricMetrics.bankStd = decimalFromPercentEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							title="Variance Drag ≈ {fmtPercentDisplay(
								(investmentMetrics.bankStd * investmentMetrics.bankStd) / 2,
								2
							)}"
							>{fmtPercentDisplay(
								investmentMetrics.bankMean -
									(investmentMetrics.bankStd * investmentMetrics.bankStd) / 2,
								1
							)}</td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(investmentMetrics.bankSkew, 2)}
								onchange={(e) => {
									parametricMetrics.bankSkew = numFromEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(investmentMetrics.bankKurt, 2)}
								onchange={(e) => {
									parametricMetrics.bankKurt = numFromEvent(e);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><button
								type="button"
								class="assumptions-reset-cell-btn"
								onclick={resetBankMetricsToDefault}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
								>Reset</button
							></td
						>
					</tr>
					<tr>
						<td>Equity-bond <br />correlation</td>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(input.equityBondCorrelation, 2)}
								onchange={(e) => {
									input.equityBondCorrelation = clamp(numFromEvent(e), -1, 1);
									onInvestmentMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td></td>
						<td></td>
						<td></td>
						<td></td>
						<td></td>
					</tr>

					<tr
						class="portfolio-row portfolio-highlight-row"
						class:positive-return-row={input.meanReturn >= 0}
						class:negative-return-row={input.meanReturn < 0}
					>
						<td>Portfolio</td>
						<td>{fmtPercentDisplay(input.meanReturn, 1)}</td>
						<td>{fmtPercentDisplay(input.returnVariability, 1)}</td>
						<td
							title="Variance Drag ≈ {fmtPercentDisplay(
								(input.returnVariability * input.returnVariability) / 2,
								2
							)}"
							>{fmtPercentDisplay(
								input.meanReturn - (input.returnVariability * input.returnVariability) / 2,
								1
							)}</td
						>
						<td>{fmtNum(portfolioDisplaySkew, 2)}</td>
						<td>{fmtNum(portfolioDisplayKurt, 1)}</td>
						<td></td>
					</tr>

					<tr class="assumptions-separator"><td colspan="7"></td></tr>

					<tr>
						<td>Inflation</td>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentInputSig3(input.inflationMean)}
								onchange={(e) => {
									parametricInflationMean = decimalFromPercentEvent(e);
									onInflationMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentInputSig3(input.inflationVariability)}
								onchange={(e) => {
									parametricInflationVariability = decimalFromPercentEvent(e);
									onInflationMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							title="Variance Drag ≈ {fmtPercentDisplay(
								(input.inflationVariability * input.inflationVariability) / 2,
								2
							)}"
							>{fmtPercentDisplay(
								input.inflationMean - (input.inflationVariability * input.inflationVariability) / 2,
								1
							)}</td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(input.inflationSkewness, 2)}
								onchange={(e) => {
									parametricInflationSkewness = numFromEvent(e);
									onInflationMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtNum(input.inflationKurtosis, 2)}
								onchange={(e) => {
									parametricInflationKurtosis = Math.max(1, numFromEvent(e));
									onInflationMetricChange();
								}}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
							/></td
						>
						<td
							><button
								type="button"
								class="assumptions-reset-cell-btn"
								onclick={resetInflationToDefault}
								disabled={input.simulationMode === 'historical' && !input.historicalMomentTargeting}
								>Reset</button
							></td
						>
					</tr>

					<tr>
						<td>Annual fees</td>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentDisplay(input.annualFeePercent, 2)}
								onchange={(e) => {
									input.annualFeePercent = clamp(decimalFromPercentEvent(e), 0, 1);
									onSimulationSettingsChange();
								}}
							/></td
						>
						<td></td>
						<td></td>
						<td></td>
						<td></td>
						<td
							><button type="button" class="assumptions-reset-cell-btn" onclick={resetDragToDefault}
								>Reset</button
							></td
						>
					</tr>

					<tr>
						<td
							title="Applied once a year to the year's net investment gains (losses untaxed). At 15% this costs roughly 1.5–2% of returns per year."
							>Tax drag on real gains</td
						>
						<td
							><input
								type="text"
								inputmode="decimal"
								value={fmtPercentDisplay(input.taxOnGainsPercent, 2)}
								onchange={(e) => {
									input.taxOnGainsPercent = clamp(decimalFromPercentEvent(e), 0, 1);
									onSimulationSettingsChange();
								}}
							/></td
						>
						<td></td>
						<td></td>
						<td></td>
						<td></td>
						<td></td>
					</tr>

					<tr>
						<td colspan="7">
							<p class="assumption-context-line tax-caveat">
								<strong>Tax here is deliberately simplified.</strong> It is one flat rate charged
								every year on that year's gains, whether or not you sold anything — closer to an
								annual wealth-style levy than to capital gains tax. It is charged on the
								<em>real</em>
								(inflation-adjusted) gain, while most tax systems tax the nominal gain, so high-inflation
								paths are taxed too lightly. There are no account types: no ISA, 401(k), IRA, Roth, SIPP
								or Box 3, no tax-free allowances, no withdrawal ordering between accounts, and no required
								minimum distributions. Treat it as a rough drag on returns, not as your tax bill — if
								your savings are mostly in tax-sheltered accounts, a lower rate is usually the better
								approximation.
							</p>
						</td>
					</tr>

					<tr
						class="portfolio-row real-return-highlight-row"
						class:positive-return-row={realReturnEstimate >= 0}
						class:negative-return-row={realReturnEstimate < 0}
					>
						<td>Real return</td>
						<td>{fmtPercentDisplay(realReturnEstimate, 1)}</td>
						<td>{fmtPercentDisplay(realReturnStdEstimate, 1)}</td>
						<td
							title="Variance Drag ≈ {fmtPercentDisplay(
								(realReturnStdEstimate * realReturnStdEstimate) / 2,
								2
							)}"
							>{fmtPercentDisplay(
								realReturnEstimate - (realReturnStdEstimate * realReturnStdEstimate) / 2,
								1
							)}</td
						>
						<td>{fmtNum(realReturnSkewEstimate, 2)}</td>
						<td>{fmtNum(realReturnKurtEstimate, 1)}</td>
						<td></td>
					</tr>
				</tbody>
			</table>
		</div>
		<div class="real-return-cdf-wrap">
			<p class="note mono-value">
				<br />Real return cumulative probability <br />(68% and 95% ranges shaded)
			</p>
			<div
				class="real-return-cdf"
				bind:this={realReturnCdfEl}
				role="img"
				aria-label="Real return cumulative probability plot"
			></div>
		</div>
	</details>
	<details class="card expert-tuning-card">
		<summary>Expert simulation tuning</summary>
		<div class="expert-tuning-fields">
			<div class="expert-tuning-field">
				<label for="adv-block-length"
					>Historical replay length (bootstrap block length, months)</label
				>
				<div class="expert-tuning-control">
					<input
						id="adv-block-length"
						type="number"
						min="1"
						max="120"
						step="1"
						bind:value={input.blockLength}
						oninput={onSimulationSettingsChange}
						class="expert-tuning-input"
						title="How many consecutive real months are replayed before jumping elsewhere in history. Longer blocks preserve longer historical runs; shorter blocks preserve only short-run dependence. Six months is provisional: Politis-White is a short-block diagnostic, not a retirement-path optimum."
					/>
					<span class="expert-tuning-note">
						Consecutive real months replayed before jumping elsewhere in history.
						<strong>The main lever on how long historical runs remain intact.</strong> Six months is provisional;
						Politis-White supports short blocks for variance estimation, not a unique retirement-path
						optimum.
					</span>
				</div>
			</div>
			<div class="expert-tuning-field">
				<label for="adv-crisis-jump">Crisis Inflation Jump</label>
				<div class="expert-tuning-control">
					<input
						id="adv-crisis-jump"
						type="text"
						inputmode="decimal"
						value={fmtPercentInputSig3(input.inflationCrisisSpread ?? 0.015)}
						onchange={(e) => {
							input.inflationCrisisSpread = Math.max(0, decimalFromPercentEvent(e));
							onSimulationSettingsChange();
						}}
						class="expert-tuning-input"
						title="How much higher inflation runs during a simulated crisis than in calm periods. This only bites when inflation is modelled rather than taken from history — Parametric mode, or Historical (with Adjustments). In plain Historical Data Sampling it does nothing, because inflation is read from the same real month as the return."
					/>
					<span class="expert-tuning-note">
						Extra inflation during simulated crises.
						{#if input.historicalMonthlyInflation?.length}
							<strong>No effect in the current mode</strong> — inflation is being read from real history
							rather than modelled.
						{:else}
							Active in this mode, because inflation is modelled rather than read from history.
						{/if}
					</span>
				</div>
			</div>
			<div class="expert-tuning-field">
				<label for="adv-seed">Random Seed</label>
				<div class="expert-tuning-control">
					<input
						id="adv-seed"
						type="number"
						step="1"
						placeholder="auto"
						value={input.seed ?? ''}
						oninput={(e) => {
							const raw = (e.target as HTMLInputElement).value;
							input.seed = raw === '' ? undefined : Number(raw);
						}}
						class="expert-tuning-input expert-tuning-input-wide"
					/>
					<span class="expert-tuning-note"
						>Leave blank for a fresh random seed each run. Set a value to reproduce an exact result
						— the seed actually used is shown after each run completes.</span
					>
				</div>
			</div>
		</div>
	</details>

	{#if errorMessage}
		<div class="error">{errorMessage}</div>
	{/if}
</section>
