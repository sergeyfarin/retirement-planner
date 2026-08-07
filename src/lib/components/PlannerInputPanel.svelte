<script lang="ts">
	import { m } from '../paraglide/messages';
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
	let showTaxInfo = $state(false);

	/**
	 * The dataset labels its regions in English ("Euro area"), and the label is shown in
	 * two places in this panel. Map by the code the panel already has rather than
	 * translating strings that arrive from a JSON file.
	 */
	const regionLabel = $derived.by(() => {
		switch (selectedCurrencyCode) {
			case 'USD':
				return m.region_us();
			case 'GBP':
				return m.region_uk();
			case 'EUR':
				return m.region_eu();
			default:
				return m.region_world();
		}
	});

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
	<div class="currency-switch" role="group" aria-label={m.currency_switch_aria()}>
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
				<span>{m.field_current_age()}</span>
				<input type="number" min="12" max="80" step="1" bind:value={input.currentAge} />
			</label>
			<label class="already-retired" title={m.field_already_retired_title()}>
				<span>{m.field_already_retired()}</span>
				<span class="checkbox-control">
					<input
						type="checkbox"
						checked={alreadyRetired}
						onchange={(e) => onAlreadyRetiredChange(e.currentTarget.checked)}
					/>
				</span>
			</label>
			<label class:input-disabled={alreadyRetired}>
				<span>{m.field_retire_at_age()}</span>
				<input
					type="number"
					min="25"
					max="80"
					step="1"
					disabled={alreadyRetired}
					title={alreadyRetired ? m.field_retire_disabled_title() : ''}
					value={input.retirementAge}
					onchange={(e) => {
						input.retirementAge = numFromEvent(e);
					}}
				/>
			</label>
			<label title={m.field_plan_until_title()}>
				<span>{m.field_plan_until_age()}</span>
				<input type="number" min="50" max="110" step="1" bind:value={input.simulateUntilAge} />
			</label>
		</div>
		<div class="section-split">
			<div>
				<div class="data-table">
					<div class="table-header">
						<span>{m.th_income_sources()}</span><span>{m.th_from()}</span><span>{m.th_to()}</span
						><span>{m.th_yearly()}</span><span
							class="inflation-cell"
							title={m.title_inflation_adjusted()}>{m.th_inflation_adjusted_short()}</span
						><span></span>
					</div>
					<!-- The salary row spans current age → retirement age, an interval that is empty
					     once retirement is today. It is hidden rather than zeroed so it keeps its
					     amount for anyone who unticks the box. -->
					{#each incomeSources.filter((src: { id: string }) => !(alreadyRetired && src.id === 'is-default')) as src (src.id)}
						<div class="table-row">
							<input type="text" bind:value={src.label} placeholder={m.placeholder_salary()} />

							{#if src.id === 'is-default'}
								<div class="readonly-age-cell" aria-label={m.aria_salary_starts()}>
									{fmtNum(input.currentAge)}
								</div>
							{:else}
								<input class="age-input" type="number" min="0" step="1" bind:value={src.fromAge} />
							{/if}

							{#if src.id === 'is-default'}
								<div class="readonly-age-cell" aria-label={m.aria_salary_ends()}>
									{fmtNum(input.retirementAge)}
								</div>
							{:else if src.id === 'is-pension'}
								<div class="readonly-age-cell" aria-label={m.aria_pension_ends()}>
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
									title={m.title_inflation_adjusted()}
									aria-label={m.aria_inflation_adjusted_income()}
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
				<button class="btn-add" onclick={addIncomeSource}>{m.btn_add_income()}</button>
			</div>

			<div class="section-split">
				<div class="data-table">
					<div class="table-header">
						<span>{m.th_expenses()}</span><span>{m.th_from()}</span><span>{m.th_to()}</span><span
							>{m.th_yearly()}</span
						><span class="inflation-cell" title={m.title_inflation_adjusted()}
							>{m.th_inflation_adjusted_short()}</span
						><span></span>
					</div>
					{#each spendingPeriods as period (period.id)}
						<div class="table-row">
							<input type="text" bind:value={period.label} placeholder={m.placeholder_living()} />

							{#if period.id === 'sp-default'}
								<div class="readonly-age-cell" aria-label={m.aria_living_starts()}>
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
								<div class="readonly-age-cell" aria-label={m.aria_living_ends()}>
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
									title={m.title_inflation_adjusted()}
									aria-label={m.aria_inflation_adjusted_spending()}
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
				<button class="btn-add" onclick={addSpendingPeriod}>{m.btn_add_period()}</button>
				<p class="note">{m.note_surplus_invested()}</p>
			</div>

			<div class="section-split">
				<p class="eyebrow">{m.eyebrow_one_time_events()}</p>
				<p class="note">{m.note_one_time_today()}</p>
				{#if lumpSumEvents.length > 0}
					<div class="data-table data-table-events">
						<div class="table-header">
							<span>{m.th_label()}</span><span>{m.th_age()}</span><span>{m.th_amount()}</span><span
							></span>
						</div>
						{#each lumpSumEvents as evt (evt.id)}
							<div class="table-row">
								<input type="text" bind:value={evt.label} placeholder={m.placeholder_tuition()} />
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
					<p class="note">{m.note_no_one_time_events()}</p>
				{/if}
				<button class="btn-add" onclick={addLumpSumEvent}>{m.btn_add_event()}</button>
			</div>
		</div>

		<div class="section-split withdrawal-strategy-block">
			<p class="eyebrow">
				{m.eyebrow_spending_in_retirement()}
				<span class="strategy-hint" title={m.strategy_hint_title()}>(?)</span>
			</p>
			<div class="strategy-toggle-group" role="group" aria-label={m.aria_withdrawal_strategy()}>
				<button
					type="button"
					class="btn-mode"
					class:active={(input.withdrawalStrategy?.kind ?? 'fixed') === 'fixed'}
					onclick={() => setWithdrawalKind('fixed')}
					aria-pressed={(input.withdrawalStrategy?.kind ?? 'fixed') === 'fixed'}
					title={m.strategy_fixed_title()}
				>
					{m.strategy_fixed()}
				</button>
				<button
					type="button"
					class="btn-mode"
					class:active={input.withdrawalStrategy?.kind === 'guardrails'}
					onclick={() => setWithdrawalKind('guardrails')}
					aria-pressed={input.withdrawalStrategy?.kind === 'guardrails'}
					title={m.strategy_guardrails_title()}
				>
					{m.strategy_guardrails()}
				</button>
				<button
					type="button"
					class="btn-mode"
					class:active={input.withdrawalStrategy?.kind === 'percentOfPortfolio'}
					onclick={() => setWithdrawalKind('percentOfPortfolio')}
					aria-pressed={input.withdrawalStrategy?.kind === 'percentOfPortfolio'}
					title={m.strategy_percent_of_portfolio_title()}
				>
					{m.strategy_percent_of_portfolio()}
				</button>
			</div>

			{#if input.withdrawalStrategy?.kind === 'guardrails'}
				<div class="strategy-params">
					<label>
						{m.label_guardrail_band()}
						<input
							type="text"
							inputmode="decimal"
							value={fmtPercentInputSig3(input.withdrawalStrategy.guardrailBand ?? 0.2)}
							onchange={(e) => updateWithdrawalParam('guardrailBand', decimalFromPercentEvent(e))}
						/>
					</label>
					<label>
						{m.label_adjustment_step()}
						<input
							type="text"
							inputmode="decimal"
							value={fmtPercentInputSig3(input.withdrawalStrategy.adjustment ?? 0.1)}
							onchange={(e) => updateWithdrawalParam('adjustment', decimalFromPercentEvent(e))}
						/>
					</label>
				</div>
				<p class="note strategy-note">
					{m.note_strategy_guardrails({
						floor: fmtPercentDisplay(input.withdrawalStrategy.spendingFloor ?? 0.6, 0),
						ceiling: fmtPercentDisplay(input.withdrawalStrategy.spendingCeiling ?? 1.4, 0)
					})}
				</p>
			{:else if input.withdrawalStrategy?.kind === 'percentOfPortfolio'}
				<div class="strategy-params">
					<label>
						{m.label_withdraw_each_year()}
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
					{m.note_strategy_percent({
						floor: fmtPercentDisplay(input.withdrawalStrategy.spendingFloor ?? 0.6, 0),
						ceiling: fmtPercentDisplay(input.withdrawalStrategy.spendingCeiling ?? 1.4, 0)
					})}
				</p>
			{:else}
				<p class="note strategy-note">{m.note_strategy_fixed()}</p>
			{/if}
		</div>

		<div class="allocation-control">
			<label>
				{m.label_portfolio_amount({ symbol: selectedCurrency.symbol })}
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
				<span>{m.label_investment_split()}</span>
				<span class="mono-value"
					>{m.allocation_summary({
						stocks: stockAllocationPercent,
						bonds: bondAllocationPercent,
						bank: bankAllocationPercent
					})}</span
				>
			</div>
			<div class="allocation-slider-wrap" aria-label={m.aria_investment_split_slider()}>
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
					aria-label={m.aria_stocks_boundary()}
				/>
				<input
					class="allocation-range allocation-range-top"
					type="range"
					min="0"
					max="100"
					step="1"
					bind:value={bondBoundaryPercent}
					oninput={onBondBoundaryChange}
					aria-label={m.aria_bonds_boundary()}
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
			{m.summary_advanced_assumptions()}
			<span class="assumptions-summary-line">
				{#if input.simulationMode === 'parametric'}
					{m.assumptions_mode_parametric()}
				{:else if selectedHistoricalRegion}
					{m.assumptions_mode_historical({
						region: regionLabel,
						coverage: selectedHistoricalRegion.coverage
					})}{input.historicalMomentTargeting ? m.assumptions_mode_adjusted_suffix() : ''}
				{:else}
					{m.assumptions_mode_fallback()}
				{/if}
				{m.assumptions_summary_tail({
					fees: fmtPercentDisplay(input.annualFeePercent, 1),
					tax: fmtPercentDisplay(input.taxOnGainsPercent, 0)
				})}
			</span>
		</summary>

		<div class="simulation-mode-section">
			{#if selectedHistoricalRegion}
				<p class="assumption-context-line historical-dataset-line">
					<strong>{m.historical_data_available_label()}</strong>
					{m.historical_dataset_line({
						region: regionLabel,
						sampleSize: selectedHistoricalRegion.sampleSize,
						coverage: selectedHistoricalRegion.annualCoverage ?? selectedHistoricalRegion.coverage,
						monthly: selectedHistoricalRegion.monthlyCoverage ?? m.coverage_unavailable()
					})}
					{#if showHistoricalMethodologyInfo}
						<br />{m.historical_methodology()}
						<a href="https://stooq.com/q/d/" target="_blank" rel="noopener noreferrer">Stooq</a>,
						<a href="https://fred.stlouisfed.org/" target="_blank" rel="noopener noreferrer">FRED</a
						>,
						<a
							href="https://github.com/sergeyfarin/retirement-planner#31-historical-sources-per-region"
							target="_blank"
							rel="noopener noreferrer">{m.link_full_methodology()}</a
						>.
					{/if}
					<button
						type="button"
						class="inline-link"
						onclick={() => {
							showHistoricalMethodologyInfo = !showHistoricalMethodologyInfo;
						}}
						aria-expanded={showHistoricalMethodologyInfo}
					>
						{showHistoricalMethodologyInfo ? m.link_less_info() : m.link_more_info()}
					</button>
				</p>
			{:else if historicalDataLoadError}
				<p class="assumption-context-line">{historicalDataLoadError}</p>
			{/if}
			<div class="simulation-mode-options" role="group" aria-label={m.aria_simulation_mode()}>
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
						title={m.mode_historical_sampling_title()}
					>
						{m.mode_historical_sampling()}
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
						title={m.mode_historical_adjusted_title()}
					>
						{m.mode_historical_adjusted()}
					</button>
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
						title={m.mode_parametric_title()}
					>
						{m.mode_parametric()}
					</button>
				</div>
			</div>
			<div class="assumption-context">
				<p class="assumption-context-line">
					{#if input.simulationMode === 'parametric'}
						<strong>{m.context_parametric_strong()}</strong>
						{m.context_parametric_rest()}
					{:else if input.historicalMomentTargeting}
						<strong>{m.context_adjusted_strong()}</strong>
						{m.context_adjusted_rest()}
					{:else}
						<strong>{m.context_historical_strong()}</strong>
						{m.context_historical_rest()}
					{/if}
				</p>
				{#if currentConditions}
					<p class="assumption-context-line current-yields-row">
						<strong>{m.preset_adjusted_label()}</strong>
						<button
							type="button"
							class="btn-preset current-yields-btn"
							onclick={applyCurrentConditions}
							title={m.btn_use_current_yields_title()}
						>
							{m.btn_use_current_yields()}
						</button>
						<span>
							{m.current_yields_summary({
								cash: fmtPercentDisplay(currentConditions.metrics.bankMean, 1),
								bonds: fmtPercentDisplay(currentConditions.metrics.bondMean, 1),
								stocks: fmtPercentDisplay(currentConditions.metrics.stockMean, 1),
								asOf: currentConditions.asOf
							})}
						</span>
					</p>
				{/if}

				{#if selectedHistoricalRegion}
					{#if input.simulationMode === 'historical' && !input.historicalMomentTargeting && input.historicalMonthlyInflation?.length}
						<p class="assumption-context-line" title={m.joint_inflation_title()}>
							<strong>{m.joint_inflation_text()}</strong>
						</p>
					{/if}
				{/if}
			</div>
		</div>
		<div class="assumptions-table-wrap">
			<table class="assumptions-table">
				<thead>
					<tr>
						<th></th>
						<th title={m.th_arith_input_title()}>{m.th_arith_input()}</th>
						<th title={m.th_volatility_title()}>{m.th_volatility()}</th>
						<th title={m.th_cagr_title()}>{m.th_cagr()}</th>
						<th>{m.th_skew()}</th>
						<th>{m.th_kurt()}</th>
						<th>{m.th_reset()}</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>{m.row_stocks()}</td>
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
							title={m.variance_drag_title({
								value: fmtPercentDisplay(
									(investmentMetrics.stockStd * investmentMetrics.stockStd) / 2,
									2
								)
							})}
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
								>{m.btn_reset()}</button
							></td
						>
					</tr>

					<tr>
						<td>{m.row_bonds()}</td>
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
							title={m.variance_drag_title({
								value: fmtPercentDisplay(
									(investmentMetrics.bondStd * investmentMetrics.bondStd) / 2,
									2
								)
							})}
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
								>{m.btn_reset()}</button
							></td
						>
					</tr>

					<tr>
						<td>{m.row_cash()}</td>
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
							title={m.variance_drag_title({
								value: fmtPercentDisplay(
									(investmentMetrics.bankStd * investmentMetrics.bankStd) / 2,
									2
								)
							})}
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
								>{m.btn_reset()}</button
							></td
						>
					</tr>
					<tr>
						<td>{m.row_equity_bond_correlation()}</td>
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
						<td>{m.row_portfolio()}</td>
						<td>{fmtPercentDisplay(input.meanReturn, 1)}</td>
						<td>{fmtPercentDisplay(input.returnVariability, 1)}</td>
						<td
							title={m.variance_drag_title({
								value: fmtPercentDisplay((input.returnVariability * input.returnVariability) / 2, 2)
							})}
							>{fmtPercentDisplay(
								input.meanReturn - (input.returnVariability * input.returnVariability) / 2,
								1
							)}</td
						>
						<td>{fmtNum(portfolioDisplaySkew, 1)}</td>
						<td>{fmtNum(portfolioDisplayKurt, 1)}</td>
						<td></td>
					</tr>

					<tr class="assumptions-separator"><td colspan="7"></td></tr>

					<tr>
						<td>{m.row_inflation()}</td>
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
							title={m.variance_drag_title({
								value: fmtPercentDisplay(
									(input.inflationVariability * input.inflationVariability) / 2,
									2
								)
							})}
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
								>{m.btn_reset()}</button
							></td
						>
					</tr>

					<tr>
						<td>{m.row_annual_fees()}</td>
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
								>{m.btn_reset()}</button
							></td
						>
					</tr>

					<tr>
						<td title={m.row_tax_drag_title()}>{m.row_tax_drag()}</td>
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
								<strong>{m.tax_caveat_strong()}</strong>
								{m.tax_caveat_short()}
								{#if showTaxInfo}
									{m.tax_caveat_long()}
								{/if}
								<button
									type="button"
									class="inline-link"
									onclick={() => (showTaxInfo = !showTaxInfo)}
									aria-expanded={showTaxInfo}
								>
									{showTaxInfo ? m.link_less_info() : m.link_more_info()}
								</button>
							</p>
						</td>
					</tr>

					<tr
						class="portfolio-row real-return-highlight-row"
						class:positive-return-row={realReturnEstimate >= 0}
						class:negative-return-row={realReturnEstimate < 0}
					>
						<td>{m.row_real_return()}</td>
						<td>{fmtPercentDisplay(realReturnEstimate, 1)}</td>
						<td>{fmtPercentDisplay(realReturnStdEstimate, 1)}</td>
						<td
							title={m.variance_drag_title({
								value: fmtPercentDisplay((realReturnStdEstimate * realReturnStdEstimate) / 2, 2)
							})}
							>{fmtPercentDisplay(
								realReturnEstimate - (realReturnStdEstimate * realReturnStdEstimate) / 2,
								1
							)}</td
						>
						<td>{fmtNum(realReturnSkewEstimate, 1)}</td>
						<td>{fmtNum(realReturnKurtEstimate, 1)}</td>
						<td></td>
					</tr>
				</tbody>
			</table>
		</div>
		<div class="real-return-cdf-wrap">
			<p class="note mono-value"><br />{m.cdf_caption()}</p>
			<div
				class="real-return-cdf"
				bind:this={realReturnCdfEl}
				role="img"
				aria-label={m.cdf_aria()}
			></div>
		</div>
	</details>
	<details class="card expert-tuning-card">
		<summary>{m.summary_expert_tuning()}</summary>
		<div class="expert-tuning-fields">
			<div class="expert-tuning-field">
				<label for="adv-block-length">{m.label_block_length()}</label>
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
						title={m.block_length_title()}
					/>
					<span class="expert-tuning-note">
						{m.block_length_note_lead()}
						<strong>{m.block_length_note_strong()}</strong>
						{m.block_length_note_tail()}
					</span>
				</div>
			</div>
			<div class="expert-tuning-field">
				<label for="adv-crisis-jump">{m.label_crisis_inflation_jump()}</label>
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
						title={m.crisis_inflation_jump_title()}
					/>
					<span class="expert-tuning-note">
						{m.crisis_inflation_note_lead()}
						{#if input.historicalMonthlyInflation?.length}
							<strong>{m.crisis_inflation_no_effect_strong()}</strong>
							{m.crisis_inflation_no_effect_tail()}
						{:else}
							{m.crisis_inflation_active()}
						{/if}
					</span>
				</div>
			</div>
			<div class="expert-tuning-field">
				<label for="adv-seed">{m.label_random_seed()}</label>
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
					<span class="expert-tuning-note">{m.random_seed_note()}</span>
				</div>
			</div>
		</div>
	</details>

	{#if errorMessage}
		<div class="error">{errorMessage}</div>
	{/if}
</section>
