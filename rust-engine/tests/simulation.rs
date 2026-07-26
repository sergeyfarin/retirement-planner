//! End-to-end `run_monte_carlo_simulation` behaviour.

mod common;

use common::{assert_close, base_input, income, lump_sum, spending};
use rust_engine::simulation::run_monte_carlo_simulation;
use rust_engine::structs::{RetirementInput, SpendingPeriod, WithdrawalStrategy};

struct Plan {
    input: RetirementInput,
    spending: Vec<SpendingPeriod>,
    months: u32,
    retire_month: u32,
}

/// A deterministic 80-year annual history, ~7% mean / ~16% std with a couple of deep
/// drawdowns. Comparative tests run in `historical` mode against this fixed series: in
/// `parametric` mode the engine draws its own 120-year synthetic history once per seed,
/// so two seeds can differ by a whole regime and no cross-run comparison is meaningful
/// (see `parametric_runs_are_sensitive_to_the_history_draw`).
fn synthetic_history() -> Vec<f64> {
    (0..80)
        .map(|year| {
            let y = year as f64;
            let base = 0.07 + 0.16 * (y * 0.9).sin() + 0.06 * (y * 0.31).cos();
            if year % 17 == 0 { base - 0.30 } else { base }
        })
        .collect()
}

fn plan() -> Plan {
    let mut input = base_input();
    input.simulations = 400.0;
    input.simulation_mode = Some("historical".to_string());
    input.historical_annual_returns = Some(synthetic_history());
    let months = ((input.simulate_until_age - input.current_age) * 12.0) as u32;
    let retire_month = ((input.retirement_age - input.current_age) * 12.0) as u32;
    Plan {
        input,
        spending: vec![spending(40.0, 95.0, 40_000.0, true)],
        months,
        retire_month,
    }
}

fn run(plan: &Plan) -> rust_engine::simulation::SimulationResultWrapper {
    run_monte_carlo_simulation(
        &plan.input,
        &plan.spending,
        &[income(40.0, 65.0, 90_000.0, true)],
        &[],
        plan.months,
        plan.retire_month,
        None,
    )
}

#[test]
fn a_seeded_run_is_reproducible() {
    let plan = plan();
    let first = run(&plan);
    let second = run(&plan);

    assert_eq!(first.stats.success_probability, second.stats.success_probability);
    assert_eq!(first.stats.final_median, second.stats.final_median);
    assert_eq!(first.stats.coast_age, second.stats.coast_age);
    assert_eq!(
        first.simulation.percentiles.p50,
        second.simulation.percentiles.p50
    );
}

#[test]
fn changing_the_seed_changes_the_sample_but_not_the_shape() {
    let plan = plan();
    let first = run(&plan);
    let mut other = plan;
    other.input.seed = Some(987_654.0);
    let second = run(&other);

    assert_ne!(first.stats.final_median, second.stats.final_median);
    // Bootstrapping the same fixed history, so only sampling noise separates the runs.
    assert_close(
        first.stats.success_probability,
        second.stats.success_probability,
        0.1,
    );
}

#[test]
fn parametric_runs_are_sensitive_to_the_history_draw() {
    // Parametric mode synthesises one 120-year history per seed and then bootstraps every
    // path from *that* sample, so the seed sets the whole run's return distribution rather
    // than just its sampling noise. This pins the behaviour so a change in it is visible.
    let mut plan = plan();
    plan.input.simulation_mode = Some("parametric".to_string());
    plan.input.historical_annual_returns = None;

    let mut realized = Vec::new();
    for seed in [12_345.0, 987_654.0, 5150.0] {
        plan.input.seed = Some(seed);
        let result = run(&plan);
        assert!(result.stats.return_moments.std_dev > 0.0);
        assert!((0.0..=1.0).contains(&result.stats.success_probability));
        realized.push(result.stats.return_moments.arithmetic_mean);
    }
    let spread = realized
        .iter()
        .cloned()
        .fold(f64::MIN, f64::max)
        - realized.iter().cloned().fold(f64::MAX, f64::min);
    assert!(
        spread > 0.01,
        "expected the per-seed history draw to move realized returns, spread was {spread}"
    );
}

#[test]
fn output_series_have_the_requested_shape() {
    let plan = plan();
    let result = run(&plan);

    assert_eq!(result.simulation.months, plan.months);
    assert_eq!(result.simulation.retire_month, plan.retire_month);
    assert_eq!(result.simulation.ages.len(), plan.months as usize);
    assert_eq!(result.simulation.ages[0], plan.input.current_age);
    assert_close(
        *result.simulation.ages.last().unwrap(),
        plan.input.simulate_until_age - 1.0 / 12.0,
        0.02,
    );

    for series in [
        &result.simulation.percentiles.p10,
        &result.simulation.percentiles.p50,
        &result.simulation.percentiles.p90,
    ] {
        assert_eq!(series.len(), plan.months as usize);
        assert!(series.iter().all(|b| b.is_finite() && *b >= 0.0));
    }
}

#[test]
fn percentile_bands_are_ordered_at_every_month() {
    let plan = plan();
    let result = run(&plan);
    let p = &result.simulation.percentiles;
    for month in 0..plan.months as usize {
        assert!(p.p10[month] <= p.p25[month]);
        assert!(p.p25[month] <= p.p50[month]);
        assert!(p.p50[month] <= p.p75[month]);
        assert!(p.p75[month] <= p.p90[month]);
    }
    assert!(result.simulation.final_percentiles.p10 <= result.simulation.final_percentiles.p90);
    assert!(result.simulation.retire_percentiles.p10 <= result.simulation.retire_percentiles.p90);

    let cdf = &result.simulation.final_wealth_cdf;
    assert_eq!(cdf.balances.len(), 101);
    assert_eq!(cdf.probabilities.len(), 101);
    assert_eq!(cdf.probabilities.first(), Some(&0.0));
    assert_eq!(cdf.probabilities.last(), Some(&1.0));
    assert!(cdf.balances.windows(2).all(|pair| pair[0] <= pair[1]));
}

#[test]
fn probabilities_and_summary_statistics_stay_in_range() {
    let plan = plan();
    let result = run(&plan);
    let stats = &result.stats;

    for probability in [
        stats.success_probability,
        stats.fi_probability_swr,
        stats.fi_probability_p95,
    ] {
        assert!((0.0..=1.0).contains(&probability), "out of range: {probability}");
    }
    assert!(stats.shortfall_low <= stats.shortfall_median);
    assert!(stats.shortfall_median <= stats.shortfall_high);
    assert!(stats.depleted_years_low <= stats.depleted_years_median);
    assert!(stats.depleted_years_median <= stats.depleted_years_high);
    assert!(stats.final_low <= stats.final_median && stats.final_median <= stats.final_high);
    assert!(stats.retire_low <= stats.retire_median && stats.retire_median <= stats.retire_high);
    assert!(stats.fi_target > 0.0);
    assert_eq!(stats.fi_target, stats.fi_target_p95);
}

#[test]
fn the_swr_target_is_spending_at_retirement_divided_by_the_rate() {
    let plan = plan();
    let result = run(&plan);
    assert_close(result.stats.fi_target_swr, 40_000.0 / 0.04, 1e-6);
}

#[test]
fn the_swr_target_subtracts_income_active_at_retirement() {
    let plan = plan();
    let incomes = [
        income(40.0, 65.0, 90_000.0, true),
        income(
            plan.input.retirement_age,
            plan.input.simulate_until_age,
            30_000.0,
            true,
        ),
    ];
    let result = run_monte_carlo_simulation(
        &plan.input,
        &plan.spending,
        &incomes,
        &[],
        plan.months,
        plan.retire_month,
        None,
    );
    assert_close(result.stats.fi_target_swr, 10_000.0 / 0.04, 1e-6);
}

#[test]
fn a_degenerate_safe_withdrawal_rate_is_floored_rather_than_dividing_by_zero() {
    let mut plan = plan();
    plan.input.safe_withdrawal_rate = 0.0;
    let result = run(&plan);
    // The rate floors at 1%, so the target is 100× annual spending, not infinity.
    assert_close(result.stats.fi_target_swr, 40_000.0 / 0.01, 1e-6);
    assert!(result.stats.fi_target_swr.is_finite());
}

#[test]
fn the_simulation_count_has_a_floor() {
    let mut plan = plan();
    plan.input.simulations = 1.0;
    assert_eq!(run(&plan).sim_count, 400);
    plan.input.simulations = 750.0;
    assert_eq!(run(&plan).sim_count, 750);
}

#[test]
fn sequence_risk_buckets_are_ranked_and_riskier_early_years_ruin_more_often() {
    let plan = plan();
    let result = run(&plan);
    let buckets = &result.stats.sequence_risk;
    assert_eq!(buckets.len(), 5);
    for pair in buckets.windows(2) {
        assert!(pair[0].early_years_mean_return <= pair[1].early_years_mean_return);
    }
    assert!(
        buckets[0].ruin_probability >= buckets[4].ruin_probability,
        "the worst early sequence should not fare better than the best"
    );
}

#[test]
fn the_ruin_surface_is_reported_with_its_own_sample_count() {
    let plan = plan();
    let result = run(&plan);
    let surface = &result.stats.ruin_surface;
    assert_eq!(surface.spending_multipliers.len(), 5);
    assert_eq!(surface.ruin_probabilities.len(), 5);
    assert!(surface.sample_count <= result.sim_count as usize);
    assert!(surface.sample_count <= 2000);
    assert!(surface
        .ruin_probabilities
        .iter()
        .flatten()
        .all(|p| (0.0..=1.0).contains(p)));
}

#[test]
fn realized_return_moments_track_the_request_under_moment_targeting() {
    let mut plan = plan();
    plan.input.historical_moment_targeting = Some(true);
    plan.input.mean_return = 0.05;
    plan.input.return_variability = 0.15;
    // A synthetic 60-year history the retargeting can rescale.
    plan.input.historical_annual_returns = Some(
        (0..60)
            .map(|year| 0.09 + 0.18 * ((year as f64 * 0.7).sin()))
            .collect(),
    );

    let result = run(&plan);
    let moments = &result.stats.return_moments;
    assert_close(moments.arithmetic_mean, 0.05, 0.01);
    assert_close(moments.std_dev, 0.15, 0.03);
    assert!(moments.geometric_mean < moments.arithmetic_mean);

    let requested = &result.stats.requested_return_moments;
    assert_eq!(requested.arithmetic_mean, 0.05);
    assert_eq!(requested.std_dev, 0.15);
}

#[test]
fn a_short_history_falls_back_to_the_synthetic_generator() {
    let mut plan = plan();
    // Under the 25-observation minimum, so the regime model must supply the history.
    plan.input.historical_annual_returns = Some(vec![0.05; 10]);
    let result = run(&plan);
    assert!(result.stats.return_moments.std_dev > 0.0);
    assert!(result.stats.final_median.is_finite());
}

#[test]
fn a_monthly_history_drives_the_block_bootstrap() {
    let mut plan = plan();
    let monthly: Vec<f64> = (0..600)
        .map(|month| 0.006 + 0.04 * ((month as f64 * 0.37).sin()))
        .collect();
    plan.input.historical_monthly_returns = Some(monthly.clone());
    plan.input.block_length = Some(12);

    let result = run(&plan);
    // Moments are read off the monthly history once it is long enough to calibrate with.
    assert!(result.stats.return_moments.std_dev > 0.0);
    assert!(result.stats.success_probability >= 0.0);

    // A joint (return, inflation) history must be accepted when it is aligned...
    plan.input.historical_monthly_inflation = Some(vec![0.0016; 600]);
    let joint = run(&plan);
    assert!(joint.stats.final_median.is_finite());
    // ...and ignored, without panicking, when it is not.
    plan.input.historical_monthly_inflation = Some(vec![0.0016; 599]);
    let misaligned = run(&plan);
    assert_eq!(misaligned.stats.final_median, result.stats.final_median);
}

#[test]
fn every_withdrawal_strategy_produces_a_complete_result() {
    for kind in ["fixed", "guardrails", "percentOfPortfolio"] {
        let mut plan = plan();
        plan.input.withdrawal_strategy = Some(WithdrawalStrategy {
            kind: kind.to_string(),
            ..WithdrawalStrategy::default()
        });
        let result = run(&plan);
        assert!(
            (0.0..=1.0).contains(&result.stats.success_probability),
            "{kind} produced {}",
            result.stats.success_probability
        );
        assert!(result.stats.final_median.is_finite(), "{kind}");
        assert_eq!(result.stats.sequence_risk.len(), 5, "{kind}");
    }
}

#[test]
fn an_omitted_withdrawal_strategy_defaults_to_fixed() {
    let mut plan = plan();
    let with_default = run(&plan);
    plan.input.withdrawal_strategy = None;
    let omitted = run(&plan);
    assert_eq!(omitted.stats.final_median, with_default.stats.final_median);
}

#[test]
fn fees_and_taxes_reduce_ending_wealth() {
    let plan = plan();
    let clean = run(&plan);

    let mut charged = plan;
    charged.input.annual_fee_percent = 0.02;
    charged.input.tax_on_gains_percent = 0.3;
    let charged = run(&charged);

    assert!(charged.stats.final_median < clean.stats.final_median);
    assert!(charged.stats.success_probability <= clean.stats.success_probability);
}

#[test]
fn a_lump_sum_can_only_help() {
    let plan = plan();
    let baseline = run(&plan);

    let windfall = run_monte_carlo_simulation(
        &plan.input,
        &plan.spending,
        &[income(40.0, 65.0, 90_000.0, true)],
        &[lump_sum(50.0, 250_000.0)],
        plan.months,
        plan.retire_month,
        None,
    );
    assert!(windfall.stats.final_median > baseline.stats.final_median);
    assert!(windfall.stats.success_probability >= baseline.stats.success_probability);
}

#[test]
fn coast_age_lies_between_today_and_retirement_when_reported() {
    let plan = plan();
    let result = run(&plan);
    if let Some(age) = result.stats.coast_age {
        assert!(age >= plan.input.current_age);
        assert!(age <= plan.input.retirement_age);
    }
}

#[test]
fn an_already_retired_plan_reports_a_required_capital_instead_of_a_coast_age() {
    let mut input = base_input();
    input.current_age = 67.0;
    input.retirement_age = 67.0;
    input.simulate_until_age = 92.0;
    input.current_savings = 1_200_000.0;
    let months = 300;

    let result = run_monte_carlo_simulation(
        &input,
        &[spending(67.0, 95.0, 45_000.0, true)],
        &[income(67.0, 95.0, 15_000.0, true)],
        &[],
        months,
        0,
        None,
    );

    // Coast FIRE is meaningless with no accumulation phase ahead.
    assert_eq!(result.stats.coast_age, None);
    // The retirement-age axis collapses to today.
    assert_eq!(result.stats.ruin_surface.retirement_ages, vec![67]);
    // The P95 target becomes a required starting capital, and the "probability" is the
    // yes/no comparison against the capital actually held.
    assert!(result.stats.fi_target_p95 > 0.0);
    let expected = if input.current_savings >= result.stats.fi_target_p95 {
        1.0
    } else {
        0.0
    };
    assert_eq!(result.stats.fi_probability_p95, expected);
    assert!(result.stats.fi_probability_swr == 0.0 || result.stats.fi_probability_swr == 1.0);
}

#[test]
fn a_hopeless_plan_fails_every_path_without_producing_nonsense() {
    let mut plan = plan();
    plan.input.current_savings = 0.0;
    plan.spending = vec![spending(40.0, 95.0, 500_000.0, true)];
    let result = run(&plan);

    assert_eq!(result.stats.success_probability, 0.0);
    assert_eq!(result.stats.final_median, 0.0);
    assert!(result.stats.shortfall_median > 0.0);
    assert!(result.stats.depleted_years_median > 0.0);
    assert!(result.stats.coast_age.is_none());
    assert!(result
        .stats
        .ruin_surface
        .ruin_probabilities
        .iter()
        .flatten()
        .all(|&p| p == 1.0));
}

#[test]
fn an_over_funded_plan_succeeds_on_every_path() {
    let mut plan = plan();
    plan.input.current_savings = 50_000_000.0;
    let result = run(&plan);
    assert_eq!(result.stats.success_probability, 1.0);
    assert_eq!(result.stats.shortfall_median, 0.0);
    assert_eq!(result.stats.depleted_years_median, 0.0);
    assert!(result.stats.final_low > 0.0);
}

#[test]
fn progress_is_reported_monotonically_from_zero() {
    use std::cell::RefCell;
    let plan = plan();
    let seen = RefCell::new(Vec::new());
    {
        let callback = |progress: f64| seen.borrow_mut().push(progress);
        run_monte_carlo_simulation(
            &plan.input,
            &plan.spending,
            &[income(40.0, 65.0, 90_000.0, true)],
            &[],
            plan.months,
            plan.retire_month,
            Some(&callback),
        );
    }

    let seen = seen.into_inner();
    assert_eq!(seen.first(), Some(&0.0));
    assert_eq!(seen.last(), Some(&0.90));
    assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress went backwards");
    assert!(seen.iter().all(|p| (0.0..=1.0).contains(p)));
}

#[test]
fn a_single_month_horizon_still_produces_a_well_formed_result() {
    let mut input = base_input();
    input.simulate_until_age = input.current_age + 1.0 / 12.0;
    let result = run_monte_carlo_simulation(
        &input,
        &[spending(40.0, 95.0, 12_000.0, true)],
        &[],
        &[],
        1,
        0,
        None,
    );
    assert_eq!(result.simulation.ages.len(), 1);
    assert_eq!(result.simulation.percentiles.p50.len(), 1);
    assert!(result.stats.final_median.is_finite());
}

#[test]
fn retiring_on_the_final_month_does_not_index_past_the_horizon() {
    let mut plan = plan();
    plan.retire_month = plan.months;
    plan.input.retirement_age = plan.input.simulate_until_age;
    let result = run(&plan);
    assert!(result.stats.retire_median.is_finite());
    assert_eq!(result.simulation.retire_month, plan.months);
}

#[test]
#[ignore = "known defect: blockLength = 0 underflows `block_remaining` in simulation.rs"]
fn a_zero_block_length_does_not_panic() {
    // `min=\"1\"` in the UI is not a guarantee — the field can be cleared and share links
    // carry arbitrary values across the wasm boundary. In monthly-calibration mode a zero
    // block sets `block_remaining = 0` and then decrements it, which underflows the usize.
    // Un-ignore once the block length is floored at 1.
    let mut plan = plan();
    plan.input.block_length = Some(0);
    plan.input.historical_monthly_returns = Some(
        (0..600)
            .map(|month| 0.006 + 0.03 * ((month as f64 * 0.37).sin()))
            .collect(),
    );
    let result = run(&plan);
    assert!(result.stats.final_median.is_finite());
}
