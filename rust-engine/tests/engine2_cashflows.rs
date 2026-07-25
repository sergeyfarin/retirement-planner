//! Cashflow construction, moment retargeting, regime detection and bootstrap pools.

mod common;

use common::{assert_close, base_input, income, lump_sum, spending};
use rust_engine::engine2::{
    apply_moment_targeting, bootstrap_indices_by_regime_monthly, bootstrap_pool_by_regime,
    build_cashflow_arrays, detect_regimes, detect_regimes_monthly,
    estimate_markov_stay_probabilities, expected_inflation_index_at_age,
    income_at_age, monthly_returns_to_annual_series, monthly_targets_for_annual_moments,
    spending_at_age, split_income_at_age, split_spending_at_age,
};

// ── monthly_targets_for_annual_moments ────────────────────────────────────

#[test]
fn monthly_targets_compound_back_to_the_requested_annual_moments() {
    let (mean, std) = monthly_targets_for_annual_moments(0.05, 0.15);
    // Twelve independent months must reproduce the annual mean and variance exactly.
    let annual_mean = (1.0 + mean).powi(12) - 1.0;
    let second_moment = ((1.0 + mean).powi(2) + std * std).powi(12);
    let annual_std = (second_moment - (1.0 + annual_mean).powi(2)).sqrt();
    assert_close(annual_mean, 0.05, 1e-12);
    assert_close(annual_std, 0.15, 1e-10);
}

#[test]
fn monthly_targets_are_below_the_naive_scaling() {
    // The naive M/12 and S/√12 overshoot once compounding cross-terms are removed.
    let (mean, std) = monthly_targets_for_annual_moments(0.05, 0.15);
    assert!(mean < 0.05 / 12.0);
    assert!(std < 0.15 / 12.0_f64.sqrt());
}

#[test]
fn monthly_targets_fall_back_to_naive_scaling_for_impossible_gross_returns() {
    // A gross return of zero or less has no real twelfth root.
    for mean in [-1.0, -1.5, f64::NEG_INFINITY] {
        let (m, s) = monthly_targets_for_annual_moments(mean, 0.15);
        assert_eq!(m, mean / 12.0);
        assert_close(s, 0.15 / 12.0_f64.sqrt(), 1e-15);
    }
    let (_, s) = monthly_targets_for_annual_moments(0.05, f64::NAN);
    assert_eq!(s, 0.0);
    let (_, s) = monthly_targets_for_annual_moments(0.05, -0.2);
    assert!(s >= 0.0);
}

#[test]
fn zero_volatility_targets_stay_at_zero() {
    let (mean, std) = monthly_targets_for_annual_moments(0.05, 0.0);
    assert_eq!(std, 0.0);
    assert_close((1.0 + mean).powi(12) - 1.0, 0.05, 1e-12);
}

// ── apply_moment_targeting ────────────────────────────────────────────────

#[test]
fn moment_targeting_maps_a_series_onto_the_requested_mean_and_std() {
    let source = [0.1, -0.2, 0.35, 0.0, 0.05];
    let n = source.len() as f64;
    let source_mean = source.iter().sum::<f64>() / n;
    let source_std =
        (source.iter().map(|v| (v - source_mean).powi(2)).sum::<f64>() / n).sqrt();

    let mapped: Vec<f64> = source
        .iter()
        .map(|&v| apply_moment_targeting(v, source_mean, source_std, 0.07, 0.18))
        .collect();

    let mapped_mean = mapped.iter().sum::<f64>() / n;
    let mapped_std =
        (mapped.iter().map(|v| (v - mapped_mean).powi(2)).sum::<f64>() / n).sqrt();
    assert_close(mapped_mean, 0.07, 1e-12);
    assert_close(mapped_std, 0.18, 1e-12);
}

#[test]
fn moment_targeting_collapses_to_the_target_mean_for_degenerate_inputs() {
    assert_eq!(apply_moment_targeting(0.1, 0.05, 0.0, 0.07, 0.18), 0.07);
    assert_eq!(apply_moment_targeting(f64::NAN, 0.05, 0.1, 0.07, 0.18), 0.07);
    assert_eq!(apply_moment_targeting(0.1, f64::NAN, 0.1, 0.07, 0.18), 0.07);
    assert_eq!(apply_moment_targeting(0.1, 0.05, f64::NAN, 0.07, 0.18), 0.07);
    // A negative target std is treated as zero, never as a sign flip.
    assert_eq!(apply_moment_targeting(0.5, 0.0, 0.1, 0.07, -0.2), 0.07);
}

// ── regime detection ──────────────────────────────────────────────────────

#[test]
fn annual_regime_detection_flags_drawdowns_as_crisis() {
    let mut returns = vec![0.08; 20];
    returns[10] = -0.40;
    returns[11] = -0.25;
    let labels = detect_regimes(&returns);
    assert_eq!(labels.len(), returns.len());
    assert_eq!(labels[10], 1);
    assert_eq!(labels[11], 1);
    assert_eq!(labels[0], 0);
}

#[test]
fn annual_regime_detection_fills_single_calm_years_between_crises() {
    // A quiet year surrounded by crisis years is absorbed into the crisis run.
    let returns = vec![0.08, 0.08, -0.40, 0.09, -0.40, 0.08, 0.08, 0.08];
    let labels = detect_regimes(&returns);
    assert_eq!(labels[2], 1);
    assert_eq!(labels[3], 1, "isolated calm year should be smoothed into the crisis");
    assert_eq!(labels[4], 1);
}

#[test]
fn regime_detection_handles_empty_and_constant_series() {
    assert!(detect_regimes(&[]).is_empty());
    assert!(detect_regimes_monthly(&[]).is_empty());
    // Constant history: dispersion is (numerically) zero, so no year stands out either by
    // return or by rolling volatility and the whole series is one calm regime.
    let labels = detect_regimes(&[0.05; 10]);
    assert_eq!(labels, vec![0; 10]);
    // The monthly detector is on a knife edge for a constant series — the crisis
    // threshold sits within floating-point dust of the value itself — so only require
    // that it labels the whole series consistently, not which way it falls.
    let monthly = detect_regimes_monthly(&[0.004; 24]);
    assert_eq!(monthly.len(), 24);
    assert!(monthly.iter().all(|&l| l == monthly[0]));

    // Single observation: nothing to compare against, and the smoothing pass must not
    // index out of bounds.
    assert_eq!(detect_regimes(&[0.05]).len(), 1);
    assert_eq!(detect_regimes(&[0.05, -0.4]).len(), 2);
}

#[test]
fn monthly_regime_detection_flags_a_volatile_stretch() {
    let mut returns = vec![0.006; 120];
    for month in 60..66 {
        returns[month] = -0.09;
    }
    let labels = detect_regimes_monthly(&returns);
    assert_eq!(labels.len(), 120);
    assert!(labels[60..66].iter().all(|&l| l == 1));
    assert_eq!(labels[0], 0);
}

// ── bootstrap pools ───────────────────────────────────────────────────────

#[test]
fn annual_pools_partition_the_history_by_label() {
    let returns = vec![0.10, -0.30, 0.12, -0.25, 0.08];
    let labels = vec![0, 1, 0, 1, 0];
    let pools = bootstrap_pool_by_regime(&returns, &labels);
    assert_eq!(pools.growth, vec![0.10, 0.12, 0.08]);
    assert_eq!(pools.crisis, vec![-0.30, -0.25]);
}

#[test]
fn annual_crisis_pool_falls_back_to_the_worst_years_when_no_crisis_is_labelled() {
    let returns: Vec<f64> = (0..20).map(|i| i as f64 / 100.0).collect();
    let labels = vec![0; 20];
    let pools = bootstrap_pool_by_regime(&returns, &labels);
    assert_eq!(pools.growth, returns);
    // max(4, floor(20 × 0.35)) = 7 worst observations.
    assert_eq!(pools.crisis.len(), 7);
    assert_eq!(pools.crisis[0], 0.0);
    assert_eq!(pools.crisis[6], 0.06);
}

#[test]
fn annual_growth_pool_falls_back_to_the_whole_history_when_everything_is_crisis() {
    let returns = vec![-0.3, -0.2, -0.5];
    let pools = bootstrap_pool_by_regime(&returns, &[1, 1, 1]);
    assert_eq!(pools.growth, returns);
    assert_eq!(pools.crisis, returns);
}

#[test]
fn monthly_pools_return_indices_not_values() {
    let returns = vec![0.01, -0.09, 0.02, -0.08];
    let pools = bootstrap_indices_by_regime_monthly(&returns, &[0, 1, 0, 1]);
    assert_eq!(pools.growth, vec![0, 2]);
    assert_eq!(pools.crisis, vec![1, 3]);
}

#[test]
fn monthly_crisis_indices_fall_back_to_the_worst_months() {
    let returns: Vec<f64> = (0..60).map(|i| i as f64 / 1000.0).collect();
    let pools = bootstrap_indices_by_regime_monthly(&returns, &vec![0; 60]);
    // max(12, floor(60 × 0.3)) = 18 worst months, i.e. indices 0..18 here.
    assert_eq!(pools.crisis.len(), 18);
    assert_eq!(pools.crisis[0], 0);
    assert!(pools.crisis.iter().all(|&i| i < 18));
    assert_eq!(pools.growth.len(), 60);
}

#[test]
fn markov_stay_probabilities_are_estimated_from_label_runs() {
    // growth→growth 3 of 4, crisis→crisis 2 of 3.
    let labels = [0, 0, 0, 0, 1, 1, 1, 0];
    let (stay_growth, stay_crisis) = estimate_markov_stay_probabilities(&labels);
    assert_close(stay_growth, 3.0 / 4.0, 1e-12);
    assert_close(stay_crisis, 2.0 / 3.0, 1e-12);
}

#[test]
fn markov_estimates_fall_back_and_stay_clamped() {
    // No transitions observed at all ⇒ documented priors.
    let (g, c) = estimate_markov_stay_probabilities(&[]);
    assert_close(g, 0.88, 1e-12);
    assert_close(c, 0.72, 1e-12);

    // All-growth history: crisis has no observations, growth would be a certainty.
    let (g, c) = estimate_markov_stay_probabilities(&[0; 50]);
    assert_eq!(g, 0.999);
    assert_close(c, 0.72, 1e-12);

    let (g, c) = estimate_markov_stay_probabilities(&[1; 50]);
    assert_close(g, 0.88, 1e-12);
    assert_eq!(c, 0.999);
}

#[test]
fn monthly_returns_compound_into_whole_years_only() {
    let monthly = vec![0.01; 30];
    let annual = monthly_returns_to_annual_series(&monthly);
    // 30 months ⇒ two complete years; the trailing 6 months are dropped.
    assert_eq!(annual.len(), 2);
    assert_close(annual[0], 1.01_f64.powi(12) - 1.0, 1e-12);
    assert!(monthly_returns_to_annual_series(&[0.01; 11]).is_empty());
    assert!(monthly_returns_to_annual_series(&[]).is_empty());
}

// ── age-indexed cashflows ─────────────────────────────────────────────────

#[test]
fn periods_are_half_open_on_the_upper_age() {
    let periods = vec![spending(60.0, 70.0, 12_000.0, true)];
    assert_eq!(spending_at_age(59.99, &periods, 1.0), 0.0);
    assert_eq!(spending_at_age(60.0, &periods, 1.0), 12_000.0);
    assert_eq!(spending_at_age(69.99, &periods, 1.0), 12_000.0);
    assert_eq!(spending_at_age(70.0, &periods, 1.0), 0.0);
}

#[test]
fn overlapping_periods_add_together() {
    let periods = vec![
        spending(60.0, 80.0, 30_000.0, true),
        spending(65.0, 70.0, 10_000.0, true),
    ];
    assert_eq!(spending_at_age(66.0, &periods, 1.0), 40_000.0);
    assert_eq!(spending_at_age(75.0, &periods, 1.0), 30_000.0);
}

#[test]
fn nominal_items_are_deflated_and_real_items_are_not() {
    let periods = vec![
        spending(60.0, 80.0, 10_000.0, true),
        spending(60.0, 80.0, 10_000.0, false),
    ];
    assert_eq!(spending_at_age(65.0, &periods, 2.0), 10_000.0 + 5_000.0);

    let (real, nominal) = split_spending_at_age(65.0, &periods);
    assert_eq!((real, nominal), (10_000.0, 10_000.0));

    let sources = vec![income(60.0, 80.0, 8_000.0, false)];
    assert_eq!(income_at_age(65.0, &sources, 4.0), 2_000.0);
    assert_eq!(split_income_at_age(65.0, &sources), (0.0, 8_000.0));
    assert_eq!(split_income_at_age(90.0, &sources), (0.0, 0.0));
}

#[test]
fn inflation_adjusted_defaults_to_true_when_unset() {
    let mut period = spending(60.0, 80.0, 10_000.0, true);
    period.inflation_adjusted = None;
    assert_eq!(split_spending_at_age(65.0, &[period.clone()]), (10_000.0, 0.0));
    assert_eq!(spending_at_age(65.0, &[period], 3.0), 10_000.0);
}

#[test]
fn expected_inflation_index_grows_forward_and_is_pinned_at_the_past() {
    let input = base_input();
    assert_eq!(expected_inflation_index_at_age(&input, 40.0), 1.0);
    // Ages before today do not deflate below 1.
    assert_eq!(expected_inflation_index_at_age(&input, 10.0), 1.0);
    assert_close(
        expected_inflation_index_at_age(&input, 50.0),
        1.02_f64.powi(10),
        1e-12,
    );
}

#[test]
fn cashflow_arrays_split_real_and_nominal_flows_per_month() {
    let input = base_input();
    let months = 24;
    let arrays = build_cashflow_arrays(
        &input,
        &[spending(40.0, 90.0, 24_000.0, true)],
        &[income(40.0, 41.0, 60_000.0, false)],
        &[],
        months,
    );

    assert_eq!(arrays.monthly_real_spending_flow.len(), months as usize);
    assert_eq!(arrays.monthly_real_spending_flow[0], 2_000.0);
    assert_eq!(arrays.monthly_nominal_spending_flow[0], 0.0);
    assert_eq!(arrays.monthly_nominal_income_flow[0], 5_000.0);
    assert_eq!(arrays.monthly_real_income_flow[0], 0.0);
    // The salary ends at age 41, i.e. month 12.
    assert_eq!(arrays.monthly_nominal_income_flow[12], 0.0);

    // The compatibility arrays use the *expected* inflation index, so the nominal salary
    // is already worth less by month 11 while spending stays flat in real terms.
    assert!(arrays.monthly_income_flow[11] < arrays.monthly_income_flow[0]);
    assert_eq!(arrays.monthly_spending_flow[11], 2_000.0);
    assert_close(
        arrays.monthly_net_flow[0],
        arrays.monthly_income_flow[0] - arrays.monthly_spending_flow[0],
        1e-12,
    );
}

#[test]
fn lump_sums_land_on_the_rounded_month_and_accumulate() {
    let input = base_input();
    let months = 120;
    let arrays = build_cashflow_arrays(
        &input,
        &[],
        &[],
        &[
            lump_sum(45.0, 50_000.0),
            lump_sum(45.0, 25_000.0),
            // Out of range in both directions — silently ignored, never wrapped.
            lump_sum(30.0, 999.0),
            lump_sum(80.0, 999.0),
        ],
        months,
    );

    assert_eq!(arrays.lump_sum_by_month[60], 75_000.0);
    assert_eq!(arrays.lump_sum_by_month.iter().sum::<f64>(), 75_000.0);
}

#[test]
fn a_lump_sum_at_the_current_age_lands_in_the_first_month() {
    let input = base_input();
    let arrays = build_cashflow_arrays(&input, &[], &[], &[lump_sum(40.0, 1_000.0)], 12);
    assert_eq!(arrays.lump_sum_by_month[0], 1_000.0);
}

#[test]
fn zero_month_horizons_produce_empty_arrays() {
    let input = base_input();
    let arrays = build_cashflow_arrays(
        &input,
        &[spending(40.0, 90.0, 24_000.0, true)],
        &[income(40.0, 65.0, 60_000.0, true)],
        &[lump_sum(45.0, 1.0)],
        0,
    );
    assert!(arrays.monthly_net_flow.is_empty());
    assert!(arrays.lump_sum_by_month.is_empty());
}
