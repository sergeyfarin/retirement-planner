use crate::calculations::{percentile, summarize, PercentileSeries, RandomSource};
use crate::engine::{
    annual_to_monthly_return, clamp_annual_return, clamp_monthly_return,
    draw_monthly_return_shaped, draw_student_t, initial_regime_state,
    student_t_degrees_from_kurtosis, transition_regime_state, ReturnMoments, SimulationResult,
    SummaryStats,
};
use crate::engine2::{
    apply_moment_targeting, bootstrap_indices_by_regime_monthly, bootstrap_pool_by_regime,
    build_cashflow_arrays, detect_regimes, detect_regimes_monthly,
    estimate_markov_stay_probabilities, monthly_returns_to_annual_series, spending_at_age,
};
use crate::stats::{
    build_ruin_surface, build_sequence_risk_summary, find_retirement_balance_target,
};
use crate::structs::{IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod};
use std::f64;

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
    let target_monthly_mean = target_annual_mean / 12.0;
    let target_monthly_std = target_annual_std / 12.0_f64.sqrt();

    let arrays = build_cashflow_arrays(
        input,
        spending_periods,
        income_sources,
        lump_sum_events,
        months,
    );
    let monthly_net_flow = arrays.monthly_net_flow;
    let lump_sum_by_month = arrays.lump_sum_by_month;

    let stay_growth = crate::engine::clamp_transition_probability(input.regime_model.stay_growth);
    let stay_crisis = crate::engine::clamp_transition_probability(input.regime_model.stay_crisis);
    let growth_mean = input.regime_model.growth_mean;
    let growth_std = input.regime_model.growth_std.max(0.0);
    let crisis_mean = input.regime_model.crisis_mean;
    let crisis_std = input.regime_model.crisis_std.max(0.0);

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
        bootstrap_history
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
                        target_monthly_mean,
                        target_monthly_std,
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

    let annual_detected_regimes = detect_regimes(&effective_annual_history);
    let annual_regime_bootstrap_pool =
        bootstrap_pool_by_regime(&effective_annual_history, &annual_detected_regimes);

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
    let mut all_balances: Vec<Vec<f64>> = Vec::with_capacity(sim_count);
    let mut final_balances = Vec::with_capacity(sim_count);
    let mut retire_balances = Vec::with_capacity(sim_count);
    let mut shortfall_totals = Vec::with_capacity(sim_count);
    let mut depleted_years_series = Vec::with_capacity(sim_count);
    let mut depleted_flags = Vec::with_capacity(sim_count);
    let mut annual_real_returns_by_sim = Vec::with_capacity(sim_count);
    let mut growth_factors: Vec<Vec<f64>> = Vec::with_capacity(sim_count);
    let mut success_count = 0;

    let spending_at_retirement = spending_at_age(input.retirement_age, spending_periods, 1.0);

    let growth_prob = crate::engine::get_growth_stationary_probability(stay_growth, stay_crisis);
    let crisis_prob = 1.0 - growth_prob;
    let requested_inflation_spread = input.inflation_crisis_spread.unwrap_or(0.015);
    let max_inflation_spread =
        (input.inflation_variability.powi(2) / (growth_prob * crisis_prob)).sqrt();
    let effective_inflation_spread = requested_inflation_spread.min(max_inflation_spread * 0.8);
    let growth_inflation_mean = input.inflation_mean - crisis_prob * effective_inflation_spread;
    let crisis_inflation_mean = input.inflation_mean + growth_prob * effective_inflation_spread;

    let block_length = input.block_length.unwrap_or(6);

    let progress_step = (sim_count / 10).max(1);

    // Signal that setup is complete, simulation is starting
    if let Some(cb) = &progress_callback {
        cb(0.0);
    }

    for sim in 0..sim_count {
        let mut balance = input.current_savings;
        let mut depleted = false;
        let mut cumulative_shortfall = 0.0;
        let mut depleted_months = 0;
        let annual_fee_rate = input.annual_fee_percent.clamp(0.0, 1.0);
        let tax_on_gains_rate = input.tax_on_gains_percent.clamp(0.0, 1.0);
        let monthly_fee_factor = (1.0 - annual_fee_rate / 12.0).max(0.0);
        let mut regime_state = initial_regime_state(monthly_markov.0, monthly_markov.1, &mut rng);
        let mut annual_real_returns = Vec::new();
        let mut sim_balances = vec![0.0_f64; months as usize];
        let mut sim_growth = vec![1.0_f64; months as usize];

        let mut block_remaining = 0;
        let mut current_history_index = 0;
        let mut active_monthly_asset_return = 0.0;

        if !use_monthly_calibration {
            let pool = if regime_state == 0 {
                &annual_regime_bootstrap_pool.growth
            } else {
                &annual_regime_bootstrap_pool.crisis
            };
            let random_idx = (rng.random() * pool.len() as f64).floor() as usize;
            active_monthly_asset_return =
                annual_to_monthly_return(pool[random_idx.min(pool.len().saturating_sub(1))]);
        }

        let mut annual_asset_return = 0.0;
        let mut annual_inflation = 0.0;

        for m in 0..months as usize {
            let mut regime_changed = false;

            if m > 0 {
                let next_regime_state = transition_regime_state(
                    regime_state,
                    monthly_markov.0,
                    monthly_markov.1,
                    &mut rng,
                );
                if next_regime_state != regime_state {
                    regime_changed = true;
                    regime_state = next_regime_state;
                }
            } else {
                regime_changed = true;
            }

            if use_monthly_calibration {
                if block_remaining <= 0 || regime_changed {
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
            } else if m > 0 && m % 12 == 0 {
                let pool = if regime_state == 0 {
                    &annual_regime_bootstrap_pool.growth
                } else {
                    &annual_regime_bootstrap_pool.crisis
                };
                let random_idx = (rng.random() * pool.len() as f64).floor() as usize;
                let sampled_annual_return = pool[random_idx.min(pool.len().saturating_sub(1))];
                active_monthly_asset_return = annual_to_monthly_return(sampled_annual_return);
                annual_asset_return = 0.0;
                annual_inflation = 0.0;
            }

            let stress_drift = if regime_state == 0 {
                0.0
            } else {
                (crisis_mean - growth_mean) * 0.1
            };
            let stress_noise = if regime_state == 0 {
                growth_std * 0.04
            } else {
                crisis_std * 0.08
            };

            let monthly_asset_return = if use_monthly_calibration || use_historical_bootstrap {
                active_monthly_asset_return
            } else {
                active_monthly_asset_return
                    + draw_monthly_return_shaped(
                        stress_drift,
                        stress_noise,
                        input.return_skewness,
                        input.return_kurtosis,
                        &mut rng,
                    )
            };

            let monthly_asset_return_after_tax = if monthly_asset_return > 0.0 {
                monthly_asset_return * (1.0 - tax_on_gains_rate)
            } else {
                monthly_asset_return
            };

            let monthly_portfolio_growth_factor =
                (1.0 + monthly_asset_return_after_tax) * monthly_fee_factor;
            let monthly_portfolio_return_after_costs = monthly_portfolio_growth_factor - 1.0;

            let effective_inflation_mean = if regime_state == 0 {
                growth_inflation_mean
            } else {
                crisis_inflation_mean
            };
            let monthly_inflation = draw_monthly_return_shaped(
                effective_inflation_mean,
                input.inflation_variability,
                input.inflation_skewness,
                input.inflation_kurtosis,
                &mut rng,
            );

            annual_asset_return =
                (1.0 + annual_asset_return) * (1.0 + monthly_portfolio_return_after_costs) - 1.0;
            annual_inflation = (1.0 + annual_inflation) * (1.0 + monthly_inflation) - 1.0;

            balance += monthly_net_flow[m] + lump_sum_by_month[m];
            balance *= monthly_portfolio_growth_factor;
            balance /= 1.0 + monthly_inflation;
            sim_growth[m] = monthly_portfolio_growth_factor / (1.0 + monthly_inflation);

            if balance <= 0.0 {
                cumulative_shortfall += (0.0_f64).max(-balance);
                depleted = true;
                balance = 0.0;
            }

            if m % 12 == 11 || m == months as usize - 1 {
                annual_real_returns
                    .push((1.0 + annual_asset_return) / (1.0 + annual_inflation).max(0.0001) - 1.0);
            }

            if balance == 0.0 {
                depleted_months += 1;
            }
            sim_balances[m] = balance;
        }

        let retire_index = (retire_month as usize)
            .saturating_sub(1)
            .min((months as usize).saturating_sub(1));
        retire_balances.push(sim_balances[retire_index]);
        final_balances.push(balance);
        shortfall_totals.push(cumulative_shortfall);
        depleted_years_series.push((depleted_months as f64) / 12.0);
        depleted_flags.push(depleted);
        annual_real_returns_by_sim.push(annual_real_returns);
        all_balances.push(sim_balances);
        growth_factors.push(sim_growth);

        if !depleted && balance > 0.0 {
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

    let target_fi_p95 = find_retirement_balance_target(&retire_balances, &final_balances, 0.95);
    let target_fi_swr = spending_at_retirement / input.safe_withdrawal_rate.max(0.01);
    let fi_count_p95 = retire_balances
        .iter()
        .filter(|&&b| b >= target_fi_p95)
        .count();
    let fi_count_swr = retire_balances
        .iter()
        .filter(|&&b| b >= target_fi_swr)
        .count();

    let mut pt10 = Vec::with_capacity(months as usize);
    let mut pt25 = Vec::with_capacity(months as usize);
    let mut pt50 = Vec::with_capacity(months as usize);
    let mut pt75 = Vec::with_capacity(months as usize);
    let mut pt90 = Vec::with_capacity(months as usize);

    let mut column = vec![0.0; sim_count];
    for m in 0..months as usize {
        for s in 0..sim_count {
            column[s] = all_balances[s][m];
        }
        column.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        pt10.push(percentile(&column, 0.1));
        pt25.push(percentile(&column, 0.25));
        pt50.push(percentile(&column, 0.5));
        pt75.push(percentile(&column, 0.75));
        pt90.push(percentile(&column, 0.9));
    }

    let percentile_series = PercentileSeries {
        p10: pt10,
        p25: pt25,
        p50: pt50,
        p75: pt75,
        p90: pt90,
    };

    let mut ages = Vec::with_capacity(months as usize);
    for i in 0..months {
        ages.push(((input.current_age + (i as f64) / 12.0) * 100.0).round() / 100.0);
    }

    let final_percentiles = summarize(&final_balances);
    let retire_percentiles = summarize(&retire_balances);

    let simulation = SimulationResult {
        months,
        ages,
        retire_month,
        percentiles: percentile_series,
        final_percentiles: final_percentiles.clone(),
        retire_percentiles: retire_percentiles.clone(),
    };

    let shortfall_percentiles = summarize(&shortfall_totals);
    let depleted_years_percentiles = summarize(&depleted_years_series);
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
        &growth_factors,
        months,
        sim_count,
    );

    let stats = SummaryStats {
        fi_target: target_fi_p95,
        fi_target_swr: target_fi_swr,
        fi_target_p95: target_fi_p95,
        success_probability: (success_count as f64) / (sim_count as f64),
        fi_probability_swr: (fi_count_swr as f64) / (sim_count as f64),
        fi_probability_p95: (fi_count_p95 as f64) / (sim_count as f64),
        return_moments,
        sequence_risk,
        ruin_surface,
        shortfall_low: shortfall_percentiles.p10,
        shortfall_median: shortfall_percentiles.p50,
        shortfall_high: shortfall_percentiles.p90,
        depleted_years_low: depleted_years_percentiles.p10,
        depleted_years_median: depleted_years_percentiles.p50,
        depleted_years_high: depleted_years_percentiles.p90,
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
