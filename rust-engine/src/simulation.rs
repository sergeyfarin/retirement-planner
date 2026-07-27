use crate::calculations::{percentile, summarize, PercentileSeries, RandomSource};
use crate::engine::{
    clamp_annual_return, clamp_monthly_return, spread_annual_return_across_months,
    draw_monthly_return_shaped, draw_student_t, initial_regime_state,
    student_t_degrees_from_kurtosis, transition_regime_state, RequestedReturnMoments,
    ReturnMoments, SimulationResult, SummaryStats, WealthCdf,
};
use crate::engine2::{
    apply_moment_targeting, bootstrap_indices_by_regime_monthly, bootstrap_pool_by_regime,
    build_cashflow_arrays, detect_regimes, detect_regimes_monthly, evaluate_path,
    estimate_markov_stay_probabilities, monthly_returns_to_annual_series, PathTape,
};
use crate::stats::{
    build_ruin_surface, build_sequence_risk_summary, find_coast_age, find_required_starting_capital,
    find_retirement_balance_target, is_already_retired,
};
use crate::structs::{IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod};
use std::f64;

/// Capital implied by the future portfolio-funded spending schedule at the selected SWR.
/// The final simulated month's gap is treated as the continuing terminal pattern, preserving
/// the conventional annual-gap / SWR result for a level schedule.
fn schedule_aware_swr_target(
    monthly_spending: &[f64],
    monthly_income: &[f64],
    retire_month: usize,
    safe_withdrawal_rate: f64,
) -> f64 {
    let end = monthly_spending.len().min(monthly_income.len());
    let start = retire_month.min(end);
    if start >= end {
        return 0.0;
    }

    let annual_rate = safe_withdrawal_rate.max(0.01);
    let monthly_rate = annual_rate / 12.0;
    let gap_at = |month: usize| (monthly_spending[month] - monthly_income[month]).max(0.0);
    let mut required = gap_at(end - 1) * 12.0 / annual_rate;
    for month in (start..end - 1).rev() {
        required = (gap_at(month) + required) / (1.0 + monthly_rate);
    }
    required
}

fn build_bootstrap_history(
    input: &RetirementInput,
    rng: &mut RandomSource,
    years: u32,
) -> Vec<f64> {
    let stay_growth = crate::engine::clamp_transition_probability(input.regime_model.stay_growth);
    let stay_crisis = crate::engine::clamp_transition_probability(input.regime_model.stay_crisis);
    let growth_mean = input.regime_model.growth_mean;
    let growth_std = input.regime_model.growth_std.max(0.01);
    let crisis_mean = input.regime_model.crisis_mean;
    let crisis_std = input.regime_model.crisis_std.max(growth_std + 0.01);
    let return_df = student_t_degrees_from_kurtosis(input.return_kurtosis);
    let skew_shift = input.return_skewness.clamp(-2.0, 2.0) * 0.12;

    let mut series = Vec::with_capacity(years as usize);
    let mut state = initial_regime_state(stay_growth, stay_crisis, rng);

    for year in 0..years {
        if year > 0 {
            state = transition_regime_state(state, stay_growth, stay_crisis, rng);
        }
        let mean = if state == 0 { growth_mean } else { crisis_mean };
        let std = if state == 0 { growth_std } else { crisis_std };
        let annual_return =
            clamp_annual_return(mean + std * (draw_student_t(return_df, rng) + skew_shift));
        series.push(annual_return);
    }
    series
}

fn summarize_return_moments(values: &[f64]) -> ReturnMoments {
    let n = values.len() as f64;
    if n == 0.0 {
        return ReturnMoments {
            arithmetic_mean: 0.0,
            geometric_mean: 0.0,
            std_dev: 0.0,
            skewness: 0.0,
            kurtosis: 3.0,
        };
    }

    let mean = values.iter().sum::<f64>() / n;
    let variance = values.iter().map(|&v| (v - mean).powi(2)).sum::<f64>() / n;
    let std_dev = variance.max(0.0).sqrt();

    let geometric_mean = values
        .iter()
        .fold(1.0, |prod, &v| prod * (1.0 + v).max(0.0001))
        .powf(1.0 / n)
        - 1.0;

    if std_dev <= 1e-9 {
        return ReturnMoments {
            arithmetic_mean: mean,
            geometric_mean,
            std_dev: 0.0,
            skewness: 0.0,
            kurtosis: 3.0,
        };
    }

    let m3 = values.iter().map(|&v| (v - mean).powi(3)).sum::<f64>() / n;
    let m4 = values.iter().map(|&v| (v - mean).powi(4)).sum::<f64>() / n;

    ReturnMoments {
        arithmetic_mean: mean,
        geometric_mean,
        std_dev,
        skewness: m3 / std_dev.powi(3),
        kurtosis: m4 / std_dev.powi(4),
    }
}

pub struct SimulationResultWrapper {
    pub simulation: SimulationResult,
    pub stats: SummaryStats,
    pub sim_count: u32,
}

pub fn run_monte_carlo_simulation(
    input: &RetirementInput,
    spending_periods: &[SpendingPeriod],
    income_sources: &[IncomeSource],
    lump_sum_events: &[LumpSumEvent],
    months: u32,
    retire_month: u32,
    progress_callback: Option<&dyn Fn(f64)>,
) -> SimulationResultWrapper {
    let mut rng = RandomSource::new(input.seed);

    let simulation_mode = input.simulation_mode.as_deref().unwrap_or("historical");
    let use_historical_bootstrap = simulation_mode == "historical";

    let target_annual_mean = input.mean_return;
    let target_annual_std = input.return_variability.max(0.0);
    // Intra-year dispersion for annual-mode spreading. The naive √12 scaling is the right
    // convention here and does not bias anything: spread_annual_return_across_months
    // renormalizes each year by its own geometric mean, so the year still compounds to the
    // sampled annual return exactly and this parameter only sets intra-year texture.
    let target_monthly_std = target_annual_std / 12.0_f64.sqrt();

    // Moment targeting is different: it rewrites *monthly* observations that are then
    // compounded into years, so the monthly targets must be the ones whose 12-fold
    // compounding reproduces the requested annual moments. Using √12 here overshot both.
    let (retarget_monthly_mean, retarget_monthly_std) =
        crate::engine2::monthly_targets_for_annual_moments(target_annual_mean, target_annual_std);

    let arrays = build_cashflow_arrays(
        input,
        spending_periods,
        income_sources,
        lump_sum_events,
        months,
    );
    let withdrawal_strategy = input.withdrawal_strategy.clone().unwrap_or_default();
    let retire_month_usize = (retire_month as usize).min(months as usize);

    let stay_growth = crate::engine::clamp_transition_probability(input.regime_model.stay_growth);
    let stay_crisis = crate::engine::clamp_transition_probability(input.regime_model.stay_crisis);
    let mut bootstrap_history = vec![];
    if use_historical_bootstrap {
        if let Some(hist) = &input.historical_annual_returns {
            if hist.len() >= 25 {
                bootstrap_history = hist.clone();
            }
        }
    }
    if bootstrap_history.is_empty() {
        bootstrap_history = build_bootstrap_history(input, &mut rng, 120);
    }

    let annual_history_len = bootstrap_history.len() as f64;
    let annual_history_mean = bootstrap_history.iter().sum::<f64>() / annual_history_len;
    let annual_history_variance = bootstrap_history
        .iter()
        .map(|&v| (v - annual_history_mean).powi(2))
        .sum::<f64>()
        / annual_history_len;
    let annual_history_std = annual_history_variance.max(0.0).sqrt();

    let moment_targeting = input.historical_moment_targeting.unwrap_or(false);

    let effective_annual_history: Vec<f64> = if use_historical_bootstrap {
        bootstrap_history
            .iter()
            .map(|&v| {
                let val = if moment_targeting {
                    apply_moment_targeting(
                        v,
                        annual_history_mean,
                        annual_history_std,
                        target_annual_mean,
                        target_annual_std,
                    )
                } else {
                    v
                };
                clamp_annual_return(val)
            })
            .collect()
    } else {
        // This finite synthetic pool is drawn only once per run. Target its realized
        // moments before every path bootstraps from it, otherwise the pool's sampling
        // error becomes a seed-dependent return offset shared by all simulation paths.
        bootstrap_history
            .iter()
            .map(|&v| {
                clamp_annual_return(apply_moment_targeting(
                    v,
                    annual_history_mean,
                    annual_history_std,
                    target_annual_mean,
                    target_annual_std,
                ))
            })
            .collect()
    };

    let monthly_history = if use_historical_bootstrap {
        input.historical_monthly_returns.clone().unwrap_or_default()
    } else {
        vec![]
    };
    let monthly_history: Vec<f64> = monthly_history
        .into_iter()
        .filter(|v| v.is_finite())
        .map(clamp_monthly_return)
        .collect();

    let monthly_history_len = monthly_history.len().max(1) as f64;
    let monthly_history_mean = monthly_history.iter().sum::<f64>() / monthly_history_len;
    let monthly_history_variance = monthly_history
        .iter()
        .map(|&v| (v - monthly_history_mean).powi(2))
        .sum::<f64>()
        / monthly_history_len;
    let monthly_history_std = monthly_history_variance.max(0.0).sqrt();

    let effective_monthly_history: Vec<f64> = if use_historical_bootstrap {
        monthly_history
            .iter()
            .map(|&v| {
                let val = if moment_targeting {
                    apply_moment_targeting(
                        v,
                        monthly_history_mean,
                        monthly_history_std,
                        retarget_monthly_mean,
                        retarget_monthly_std,
                    )
                } else {
                    v
                };
                clamp_monthly_return(val)
            })
            .collect()
    } else {
        monthly_history
    };

    let use_monthly_calibration = effective_monthly_history.len() >= 120;

    // Joint (return, inflation) bootstrap: only when the caller supplied a realized
    // inflation series aligned with the monthly return history. Sampling both from the
    // same historical month preserves their correlation, and contiguous blocks carry
    // inflation's own persistence — neither of which the parametric draw reproduces.
    let historical_monthly_inflation = input
        .historical_monthly_inflation
        .as_ref()
        .filter(|series| use_monthly_calibration && series.len() == effective_monthly_history.len());

    let annual_detected_regimes = detect_regimes(&effective_annual_history);
    let annual_regime_bootstrap_pool =
        bootstrap_pool_by_regime(&effective_annual_history, &annual_detected_regimes);
    // Estimate annual transitions from the labels that formed these pools. Reusing the
    // input template can assign a different stationary crisis share and reweight the two
    // pool means away from the calibrated unconditional mean.
    let annual_markov = estimate_markov_stay_probabilities(&annual_detected_regimes);

    let monthly_detected_regimes = if use_monthly_calibration {
        detect_regimes_monthly(&effective_monthly_history)
    } else {
        vec![]
    };

    let monthly_regime_bootstrap_indices = if use_monthly_calibration {
        bootstrap_indices_by_regime_monthly(&effective_monthly_history, &monthly_detected_regimes)
    } else {
        crate::engine2::RegimePools {
            growth: vec![],
            crisis: vec![],
        }
    };

    let monthly_markov = if use_monthly_calibration {
        estimate_markov_stay_probabilities(&monthly_detected_regimes)
    } else {
        (
            crate::engine::clamp_transition_probability(stay_growth.powf(1.0 / 12.0)),
            crate::engine::clamp_transition_probability(stay_crisis.powf(1.0 / 12.0)),
        )
    };

    let converted_monthly;
    let return_moments = summarize_return_moments(if use_monthly_calibration {
        converted_monthly = monthly_returns_to_annual_series(&effective_monthly_history);
        &converted_monthly
    } else {
        &effective_annual_history
    });
    let sim_count = 400.max(input.simulations.round() as usize);

    // ── Memory-efficient data structures ──────────────────────────────────
    // Reservoir sampling: keep at most RESERVOIR_K balances per month
    // for percentile computation. Exact for sim_count <= K, sampled above.
    const RESERVOIR_K: usize = 5000;
    let months_usize = months as usize;
    let mut reservoirs: Vec<Vec<f64>> = (0..months_usize)
        .map(|_| Vec::with_capacity(RESERVOIR_K.min(sim_count)))
        .collect();

    // Cap exogenous path tapes at 2000 rows. Replays rerun all balance-dependent rules
    // exactly while keeping tail-probability SE in the heatmap under roughly ±1%.
    const RUIN_SAMPLE_CAP: usize = 2000;
    let replay_sample_count = sim_count.min(RUIN_SAMPLE_CAP);
    let mut path_tapes: Vec<PathTape> = Vec::with_capacity(replay_sample_count);

    let mut final_balances = Vec::with_capacity(sim_count);
    let mut retire_balances = Vec::with_capacity(sim_count);
    let mut shortfall_totals = Vec::with_capacity(sim_count);
    let mut depleted_years_series = Vec::with_capacity(sim_count);
    let mut first_depletion_months: Vec<f64> = Vec::with_capacity(sim_count);
    let mut depleted_flags = Vec::with_capacity(sim_count);
    let mut success_flags = Vec::with_capacity(sim_count);
    let mut annual_real_returns_by_sim = Vec::with_capacity(sim_count);
    let mut success_count = 0;

    let growth_prob = crate::engine::get_growth_stationary_probability(stay_growth, stay_crisis);
    let crisis_prob = 1.0 - growth_prob;
    // Floored at 0 for the same reason the block length is floored at 1: the input handler
    // clamps it, restored share links do not, and a negative spread would put the crisis
    // regime's mean inflation *below* the growth regime's — silently inverting the model
    // rather than failing. Mirrored in the TS engine.
    let requested_inflation_spread = input.inflation_crisis_spread.unwrap_or(0.015).max(0.0);
    let max_inflation_spread =
        (input.inflation_variability.powi(2) / (growth_prob * crisis_prob)).sqrt();
    let effective_inflation_spread = requested_inflation_spread.min(max_inflation_spread * 0.8);
    let growth_inflation_mean = input.inflation_mean - crisis_prob * effective_inflation_spread;
    let crisis_inflation_mean = input.inflation_mean + growth_prob * effective_inflation_spread;

    // Floored at 1: the UI's `min="1"` is not an invariant at this boundary (the field can be
    // cleared, and share links carry arbitrary numbers), and a zero block would set
    // `block_remaining = 0` and then underflow the `usize` below — a debug panic, and in
    // release a wrap to `usize::MAX` that silently replays one endless block. A block of 1
    // means "redraw every month", which is what a zero-length block degenerates to anyway.
    let block_length = input.block_length.unwrap_or(6).max(1);

    let progress_step = (sim_count / 10).max(1);

    // Signal that setup is complete, simulation is starting
    if let Some(cb) = &progress_callback {
        cb(0.0);
    }

    for sim in 0..sim_count {
        let mut regime_state = initial_regime_state(monthly_markov.0, monthly_markov.1, &mut rng);
        let mut annual_regime_state = 0;
        let mut tape = PathTape {
            asset_returns: vec![0.0; months_usize],
            inflation_rates: vec![0.0; months_usize],
        };

        let mut block_remaining = 0;
        let mut current_history_index = 0;
        // Always assigned before use: monthly calibration reads the bootstrap block,
        // annual mode reads the current year's spread.
        let mut active_monthly_asset_return;

        // Annual mode: the 12 monthly returns for the current year, compounding to the
        // sampled annual return (see spread_annual_return_across_months).
        let mut annual_mode_months = [0.0_f64; 12];
        if !use_monthly_calibration {
            annual_regime_state =
                initial_regime_state(annual_markov.0, annual_markov.1, &mut rng);
            let pool = if annual_regime_state == 0 {
                &annual_regime_bootstrap_pool.growth
            } else {
                &annual_regime_bootstrap_pool.crisis
            };
            let random_idx = (rng.random() * pool.len() as f64).floor() as usize;
            annual_mode_months = spread_annual_return_across_months(
                pool[random_idx.min(pool.len().saturating_sub(1))],
                target_monthly_std,
                input.return_skewness,
                input.return_kurtosis,
                &mut rng,
            );
        }

        for m in 0..months as usize {
            if m > 0 {
                regime_state = transition_regime_state(
                    regime_state,
                    monthly_markov.0,
                    monthly_markov.1,
                    &mut rng,
                );
            }

            if use_monthly_calibration {
                // Blocks are only re-drawn when the current one is exhausted; a regime
                // switch mid-block takes effect at the next block boundary. Aborting the
                // block on every switch used to bias the sampler: because a fresh block
                // always *starts* on a month matching the new regime, and crisis runs are
                // shorter than growth runs, crisis months were over-drawn ~1.06-1.09x,
                // costing 0.64-1.29pp/yr of return depending on the region. Letting blocks
                // finish also preserves more of the autocorrelation the block bootstrap
                // exists to capture. See TODO 0.11.
                // `== 0`, not `<= 0`: the counter is a `usize`. The old signed-looking
                // comparison is what made the underflow below easy to miss, and clippy
                // flags it as always-true-or-always-false.
                if block_remaining == 0 {
                    let index_pool = if regime_state == 0 {
                        &monthly_regime_bootstrap_indices.growth
                    } else {
                        &monthly_regime_bootstrap_indices.crisis
                    };
                    let random_idx = (rng.random() * index_pool.len() as f64).floor() as usize;
                    current_history_index =
                        index_pool[random_idx.min(index_pool.len().saturating_sub(1))];
                    block_remaining = block_length;
                } else {
                    current_history_index =
                        (current_history_index + 1) % effective_monthly_history.len();
                }
                active_monthly_asset_return = effective_monthly_history[current_history_index];
                block_remaining -= 1;
            } else {
                if m > 0 && m % 12 == 0 {
                    annual_regime_state = transition_regime_state(
                        annual_regime_state,
                        annual_markov.0,
                        annual_markov.1,
                        &mut rng,
                    );
                    let pool = if annual_regime_state == 0 {
                        &annual_regime_bootstrap_pool.growth
                    } else {
                        &annual_regime_bootstrap_pool.crisis
                    };
                    let random_idx = (rng.random() * pool.len() as f64).floor() as usize;
                    annual_mode_months = spread_annual_return_across_months(
                        pool[random_idx.min(pool.len().saturating_sub(1))],
                        target_monthly_std,
                        input.return_skewness,
                        input.return_kurtosis,
                        &mut rng,
                    );
                }
                // Walk through the current year's months instead of repeating one rate.
                active_monthly_asset_return = annual_mode_months[m % 12];
            }

            // The annual pool draw is already regime-conditioned and calibrated. The old
            // parametric-only monthly crisis overlay counted the regime twice and changed
            // both the mean and volatility after calibration.
            let monthly_asset_return = active_monthly_asset_return;

            let monthly_inflation = if let Some(series) = historical_monthly_inflation {
                // Same index as the return sampled this month, so the pair comes from
                // one real historical month. The regime inflation spread is deliberately
                // NOT applied here — the historical series already carries the
                // inflation/market co-movement it is meant to approximate.
                series[current_history_index]
            } else {
                let effective_inflation_mean = if regime_state == 0 {
                    growth_inflation_mean
                } else {
                    crisis_inflation_mean
                };
                draw_monthly_return_shaped(
                    effective_inflation_mean,
                    input.inflation_variability,
                    input.inflation_skewness,
                    input.inflation_kurtosis,
                    &mut rng,
                )
            };

            tape.asset_returns[m] = monthly_asset_return;
            tape.inflation_rates[m] = monthly_inflation;
        }

        let evaluation = evaluate_path(
            &tape,
            &arrays,
            input.current_savings,
            months_usize,
            &withdrawal_strategy,
            retire_month_usize,
            input.annual_fee_percent,
            input.tax_on_gains_percent,
            None,
            true,
        );

        let retire_index = (retire_month as usize)
            .saturating_sub(1)
            .min((months as usize).saturating_sub(1));
        retire_balances.push(evaluation.balances[retire_index]);
        final_balances.push(evaluation.final_balance);
        shortfall_totals.push(evaluation.cumulative_shortfall);
        depleted_years_series.push((evaluation.depleted_months as f64) / 12.0);
        first_depletion_months.push(
            evaluation
                .first_depletion_month
                .map_or(f64::INFINITY, |month| month as f64),
        );
        depleted_flags.push(evaluation.depleted);
        annual_real_returns_by_sim.push(evaluation.annual_real_returns);

        // Reservoir sampling: insert this sim's balances into per-month reservoirs
        for m in 0..months_usize {
            if sim < RESERVOIR_K {
                reservoirs[m].push(evaluation.balances[m]);
            } else {
                // Reservoir replacement with probability K/(sim+1)
                let j = (rng.random() * (sim + 1) as f64).floor() as usize;
                if j < RESERVOIR_K {
                    reservoirs[m][j] = evaluation.balances[m];
                }
            }
        }

        // Only retain tapes used by the exact scenario replays.
        if sim < RUIN_SAMPLE_CAP {
            path_tapes.push(tape);
        }

        let success = !evaluation.depleted;
        success_flags.push(success);
        if success {
            success_count += 1;
        }

        // Report progress every ~10%
        if sim % progress_step == 0 || sim == sim_count - 1 {
            if let Some(cb) = &progress_callback {
                let progress = (sim + 1) as f64 / sim_count as f64 * 0.9; // 0-90% for sim loop
                cb(progress);
            }
        }
    }

    // Report "processing results" phase at 90%
    if let Some(cb) = &progress_callback {
        cb(0.90);
    }

    let target_fi_swr = schedule_aware_swr_target(
        &arrays.monthly_spending_flow,
        &arrays.monthly_income_flow,
        retire_month_usize,
        input.safe_withdrawal_rate,
    );
    let already_retired = is_already_retired(input);

    // Already retired: every path starts from the same capital, so both the P95 target and
    // the "chance to reach FI" question change shape. The target becomes the capital the
    // plan *requires*, and the probability becomes a yes/no comparison against the capital
    // actually held — computed from `current_savings` directly rather than from the
    // retirement balances, whose one month of return dispersion would otherwise turn a
    // settled fact into a spurious percentage. See `find_required_starting_capital` and
    // README §7.6.
    let target_fi_p95 = if already_retired {
        find_required_starting_capital(
            &path_tapes,
            &arrays,
            replay_sample_count,
            months,
            &withdrawal_strategy,
            retire_month_usize,
            0.95,
            target_fi_swr,
            input.annual_fee_percent,
            input.tax_on_gains_percent,
        )
    } else {
        find_retirement_balance_target(&retire_balances, &success_flags, 0.95)
    };
    let fi_count_p95 = if already_retired {
        if input.current_savings >= target_fi_p95 {
            sim_count
        } else {
            0
        }
    } else {
        retire_balances
            .iter()
            .filter(|&&b| b >= target_fi_p95)
            .count()
    };
    let fi_count_swr = if already_retired {
        if input.current_savings >= target_fi_swr {
            sim_count
        } else {
            0
        }
    } else {
        retire_balances
            .iter()
            .filter(|&&b| b >= target_fi_swr)
            .count()
    };

    let mut pt10 = Vec::with_capacity(months_usize);
    let mut pt25 = Vec::with_capacity(months_usize);
    let mut pt50 = Vec::with_capacity(months_usize);
    let mut pt75 = Vec::with_capacity(months_usize);
    let mut pt90 = Vec::with_capacity(months_usize);

    for m in 0..months_usize {
        reservoirs[m].sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        pt10.push(percentile(&reservoirs[m], 0.1));
        pt25.push(percentile(&reservoirs[m], 0.25));
        pt50.push(percentile(&reservoirs[m], 0.5));
        pt75.push(percentile(&reservoirs[m], 0.75));
        pt90.push(percentile(&reservoirs[m], 0.9));
    }

    let percentile_series = PercentileSeries {
        p10: pt10,
        p25: pt25,
        p50: pt50,
        p75: pt75,
        p90: pt90,
    };

    let mut ages = Vec::with_capacity(months_usize);
    for i in 0..months {
        ages.push(((input.current_age + (i as f64) / 12.0) * 100.0).round() / 100.0);
    }

    let final_percentiles = summarize(&final_balances);
    let retire_percentiles = summarize(&retire_balances);
    let mut sorted_final_balances = final_balances.clone();
    sorted_final_balances.sort_by(|a, b| a.total_cmp(b));
    let final_wealth_probabilities: Vec<f64> =
        (0..=100).map(|index| index as f64 / 100.0).collect();
    let final_wealth_cdf = WealthCdf {
        balances: final_wealth_probabilities
            .iter()
            .map(|probability| percentile(&sorted_final_balances, *probability))
            .collect(),
        probabilities: final_wealth_probabilities,
    };

    let simulation = SimulationResult {
        months,
        ages,
        retire_month,
        percentiles: percentile_series,
        final_percentiles: final_percentiles.clone(),
        retire_percentiles: retire_percentiles.clone(),
        final_wealth_cdf,
    };

    let shortfall_percentiles = summarize(&shortfall_totals);
    let depleted_years_percentiles = summarize(&depleted_years_series);
    let mut sorted_first_depletion = first_depletion_months.clone();
    sorted_first_depletion.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    // Nearest-rank, deliberately not the interpolating `summarize`: the series carries
    // +Infinity for paths that never ran short, and interpolating towards it yields
    // Infinity or NaN. Mirrors `depletionAge` in `retirementEngine.ts` exactly.
    let depletion_age = |quantile: f64| -> Option<f64> {
        if sorted_first_depletion.is_empty() {
            return None;
        }
        let rank = ((quantile * sorted_first_depletion.len() as f64).floor() as usize)
            .min(sorted_first_depletion.len() - 1);
        let month = sorted_first_depletion[rank];
        if month.is_finite() {
            Some(input.current_age + month / 12.0)
        } else {
            None
        }
    };
    let sequence_risk = build_sequence_risk_summary(
        &annual_real_returns_by_sim,
        &final_balances,
        &depleted_flags,
    );

    let ruin_surface = build_ruin_surface(
        input,
        spending_periods,
        income_sources,
        lump_sum_events,
        &path_tapes,
        months,
        replay_sample_count,
        &withdrawal_strategy,
    );

    let coast_age = find_coast_age(
        input,
        spending_periods,
        income_sources,
        lump_sum_events,
        &path_tapes,
        months,
        replay_sample_count,
        &withdrawal_strategy,
        retire_month_usize,
        0.95,
    );

    let stats = SummaryStats {
        coast_age,
        fi_target: target_fi_p95,
        fi_target_swr: target_fi_swr,
        fi_target_p95: target_fi_p95,
        success_probability: (success_count as f64) / (sim_count as f64),
        fi_probability_swr: (fi_count_swr as f64) / (sim_count as f64),
        fi_probability_p95: (fi_count_p95 as f64) / (sim_count as f64),
        requested_return_moments: RequestedReturnMoments {
            arithmetic_mean: target_annual_mean,
            std_dev: target_annual_std,
            skewness: input.return_skewness,
            kurtosis: input.return_kurtosis,
        },
        return_moments,
        sequence_risk,
        ruin_surface,
        shortfall_low: shortfall_percentiles.p10,
        shortfall_median: shortfall_percentiles.p50,
        shortfall_high: shortfall_percentiles.p90,
        depleted_years_low: depleted_years_percentiles.p10,
        depleted_years_median: depleted_years_percentiles.p50,
        depleted_years_high: depleted_years_percentiles.p90,
        depletion_age_p10: depletion_age(0.1),
        depletion_age_p50: depletion_age(0.5),
        retire_low: retire_percentiles.p10,
        final_median: final_percentiles.p50,
        final_low: final_percentiles.p10,
        final_high: final_percentiles.p90,
        retire_median: retire_percentiles.p50,
        retire_high: retire_percentiles.p90,
    };

    SimulationResultWrapper {
        simulation,
        stats,
        sim_count: sim_count as u32,
    }
}
