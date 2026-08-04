//! Sequence-risk buckets, FI targets, ruin surface and Coast FIRE.

mod common;

use common::{
    assert_close, base_input, empty_cashflows, fixed_strategy, flat_tape, income, lump_sum,
    spending,
};
use rust_engine::engine2::{PathTape, build_cashflow_arrays};
use rust_engine::stats::{
    build_ruin_surface, build_sequence_risk_summary, find_coast_age,
    find_required_capital_at_month, is_already_retired, replay_ruin_probability,
};
use rust_engine::structs::WithdrawalStrategy;

// ── sequence risk ─────────────────────────────────────────────────────────

#[test]
fn sequence_risk_sorts_simulations_into_five_quintiles_by_early_returns() {
    let sim_count = 100;
    let returns: Vec<Vec<f64>> = (0..sim_count)
        .map(|sim| vec![sim as f64 / 1000.0; 10])
        .collect();
    let finals: Vec<f64> = (0..sim_count).map(|sim| sim as f64 * 1_000.0).collect();
    let depleted = vec![false; sim_count];

    let buckets = build_sequence_risk_summary(&returns, &finals, &depleted);
    assert_eq!(buckets.len(), 5);
    assert_eq!(buckets[0].bucket_label, "Q1 (worst early sequence)");
    assert_eq!(buckets[4].bucket_label, "Q5 (best early sequence)");
    assert_eq!(buckets[2].bucket_label, "Q3");

    // Means and endings both rise with the bucket index.
    for pair in buckets.windows(2) {
        assert!(pair[0].early_years_mean_return < pair[1].early_years_mean_return);
        assert!(pair[0].ending_median < pair[1].ending_median);
    }
    // Q1 covers sims 0..20, whose mean early return is the mean of 0.000..0.019.
    assert_close(buckets[0].early_years_mean_return, 0.0095, 1e-9);
}

#[test]
fn sequence_risk_counts_only_paths_with_an_actual_shortfall_as_ruined() {
    let sim_count = 10;
    let returns: Vec<Vec<f64>> = (0..sim_count)
        .map(|sim| vec![sim as f64 / 100.0; 3])
        .collect();
    let mut finals = vec![100.0; sim_count];
    let mut depleted = vec![false; sim_count];
    // Worst two sims: one ends at zero without a shortfall, one has an actual shortfall.
    finals[0] = 0.0;
    depleted[1] = true;

    let buckets = build_sequence_risk_summary(&returns, &finals, &depleted);
    assert_eq!(buckets[0].ruin_probability, 0.5);
    assert_eq!(buckets[1].ruin_probability, 0.0);
}

#[test]
fn sequence_risk_uses_at_most_the_first_ten_years_and_the_shortest_series() {
    // One short series caps the window for everyone, so buckets stay comparable.
    let returns = vec![
        vec![0.10, 0.20, 0.30],
        vec![0.10, 0.20],
        vec![0.50, 0.10, 0.10, 0.10],
        vec![0.05, 0.05, 0.05],
        vec![0.01, 0.02, 0.03],
    ];
    let finals = vec![1.0; 5];
    let depleted = vec![false; 5];
    let buckets = build_sequence_risk_summary(&returns, &finals, &depleted);
    assert_eq!(buckets.len(), 5);
    // Only the first two years count, so sim 2 (0.50, 0.10) leads.
    assert_close(buckets[4].early_years_mean_return, 0.30, 1e-12);
}

#[test]
fn sequence_risk_is_empty_when_there_is_nothing_to_rank() {
    assert!(build_sequence_risk_summary(&[], &[], &[]).is_empty());
    // A simulation with no completed retirement year makes the ranking meaningless.
    assert!(
        build_sequence_risk_summary(&[vec![0.1], vec![]], &[1.0, 2.0], &[false, false]).is_empty()
    );
}

#[test]
fn sequence_risk_skips_empty_quintiles_for_tiny_runs() {
    let returns = vec![vec![0.1], vec![0.2], vec![0.3]];
    let buckets = build_sequence_risk_summary(&returns, &[1.0, 2.0, 3.0], &[false; 3]);
    // Three sims cannot fill five quintiles; only the non-empty ones are reported.
    assert_eq!(buckets.len(), 3);
    assert!(buckets.iter().all(|b| b.ruin_probability == 0.0));
}

// ── already-retired detection ─────────────────────────────────────────────

#[test]
fn already_retired_is_derived_from_the_two_ages_alone() {
    let mut input = base_input();
    assert!(!is_already_retired(&input));
    input.retirement_age = input.current_age;
    assert!(is_already_retired(&input));
    input.retirement_age = input.current_age - 5.0;
    assert!(is_already_retired(&input));
}

// ── replay ────────────────────────────────────────────────────────────────

fn ruinous_setup(months: usize) -> (Vec<PathTape>, rust_engine::engine2::CashflowArrays) {
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        cashflows.monthly_real_spending_flow[month] = 1_000.0;
    }
    let tapes = vec![flat_tape(months, 0.0, 0.0), flat_tape(months, 0.0, 0.0)];
    (tapes, cashflows)
}

#[test]
fn replay_ruin_probability_is_monotone_in_starting_capital() {
    let months = 24;
    let (tapes, cashflows) = ruinous_setup(months);
    let run = |capital: f64| {
        replay_ruin_probability(
            &tapes,
            &cashflows,
            capital,
            tapes.len(),
            months as u32,
            &fixed_strategy(),
            0,
            0.0,
            0.0,
            None,
        )
    };
    // 24 months × 1,000 of spending: 30,000 survives, 1,000 does not.
    assert_eq!(run(30_000.0), 0.0);
    assert_eq!(run(1_000.0), 1.0);
    assert!(run(30_000.0) <= run(20_000.0));
}

#[test]
fn replay_never_divides_by_zero_when_there_are_no_tapes() {
    let months = 12;
    let cashflows = empty_cashflows(months);
    assert_eq!(
        replay_ruin_probability(
            &[],
            &cashflows,
            1_000.0,
            10,
            months as u32,
            &fixed_strategy(),
            0,
            0.0,
            0.0,
            None,
        ),
        0.0
    );
}

#[test]
fn replay_uses_at_most_the_requested_sample_count() {
    let months = 12;
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        cashflows.monthly_real_spending_flow[month] = 1_000.0;
    }
    // First tape survives (positive returns), the rest are irrelevant if not sampled.
    let tapes = vec![
        flat_tape(months, 0.10, 0.0),
        flat_tape(months, -0.5, 0.0),
        flat_tape(months, -0.5, 0.0),
    ];
    let run = |samples| {
        replay_ruin_probability(
            &tapes,
            &cashflows,
            12_000.0,
            samples,
            months as u32,
            &fixed_strategy(),
            0,
            0.0,
            0.0,
            None,
        )
    };
    assert_eq!(run(1), 0.0);
    assert!(run(3) > 0.0);
    // Asking for more samples than exist is clamped, not an out-of-bounds read.
    assert_eq!(run(999), run(3));
}

// ── required starting capital ─────────────────────────────────────────────

#[test]
fn required_capital_is_zero_when_the_plan_survives_with_nothing() {
    let months = 24;
    let cashflows = empty_cashflows(months);
    let tapes = vec![flat_tape(months, 0.0, 0.0)];
    let capital = find_required_capital_at_month(
        &tapes,
        &cashflows,
        1,
        months as u32,
        &fixed_strategy(),
        0,
        0,
        0.95,
        100_000.0,
        0.0,
        0.0,
    );
    // No spending at all: the plan needs no capital. A zero ending balance is successful
    // because no scheduled spending went unfunded.
    assert!(
        capital >= 0.0 && capital < 10.0,
        "unexpected capital: {capital}"
    );
}

#[test]
fn required_capital_brackets_upward_from_a_hopeless_initial_guess() {
    let months = 120;
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        cashflows.monthly_real_spending_flow[month] = 1_000.0;
    }
    let tapes = vec![flat_tape(months, 0.0, 0.0)];
    let capital = find_required_capital_at_month(
        &tapes,
        &cashflows,
        1,
        months as u32,
        &fixed_strategy(),
        0,
        0,
        0.95,
        1.0, // deliberately far too small a starting bracket
        0.0,
        0.0,
    );
    // With zero returns the answer is 120 months × 1,000, found by doubling then bisecting.
    assert_close(capital, 120_000.0, 120_000.0 * 1e-3);
}

#[test]
fn the_capital_the_search_returns_actually_clears_the_target() {
    let months = 60;
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        cashflows.monthly_real_spending_flow[month] = 2_000.0;
    }
    let tapes: Vec<PathTape> = (0..20)
        .map(|i| flat_tape(months, -0.01 + i as f64 * 0.002, 0.001))
        .collect();

    let capital = find_required_capital_at_month(
        &tapes,
        &cashflows,
        tapes.len(),
        months as u32,
        &fixed_strategy(),
        0,
        0,
        0.95,
        50_000.0,
        0.001,
        0.1,
    );
    let success = 1.0
        - replay_ruin_probability(
            &tapes,
            &cashflows,
            capital,
            tapes.len(),
            months as u32,
            &fixed_strategy(),
            0,
            0.001,
            0.1,
            None,
        );
    assert!(success >= 0.95, "returned capital only reaches {success}");
}

#[test]
fn required_capital_is_zero_without_paths_to_replay() {
    let months = 12;
    let cashflows = empty_cashflows(months);
    assert_eq!(
        find_required_capital_at_month(
            &[],
            &cashflows,
            10,
            months as u32,
            &fixed_strategy(),
            0,
            0,
            0.95,
            1_000.0,
            0.0,
            0.0,
        ),
        0.0
    );
    assert_eq!(
        find_required_capital_at_month(
            &[flat_tape(months, 0.0, 0.0)],
            &cashflows,
            0,
            months as u32,
            &fixed_strategy(),
            0,
            0,
            0.95,
            1_000.0,
            0.0,
            0.0,
        ),
        0.0
    );
}

#[test]
#[should_panic(expected = "target success probability")]
fn required_capital_rejects_an_out_of_range_target() {
    let months = 12;
    find_required_capital_at_month(
        &[flat_tape(months, 0.0, 0.0)],
        &empty_cashflows(months),
        1,
        months as u32,
        &fixed_strategy(),
        0,
        0,
        1.5,
        1_000.0,
        0.0,
        0.0,
    );
}

// ── ruin surface ──────────────────────────────────────────────────────────

fn surface_fixture() -> (
    rust_engine::structs::RetirementInput,
    Vec<rust_engine::structs::SpendingPeriod>,
    Vec<rust_engine::structs::IncomeSource>,
    Vec<PathTape>,
    u32,
) {
    let input = base_input();
    let months = ((input.simulate_until_age - input.current_age) * 12.0) as u32;
    let spend = vec![spending(40.0, 90.0, 40_000.0, true)];
    let earn = vec![income(40.0, 65.0, 70_000.0, true)];
    let tapes: Vec<PathTape> = (0..8)
        .map(|i| flat_tape(months as usize, 0.002 + i as f64 * 0.0005, 0.0015))
        .collect();
    (input, spend, earn, tapes, months)
}

#[test]
fn the_ruin_surface_sweeps_both_axes() {
    let (input, spend, earn, tapes, months) = surface_fixture();
    let surface = build_ruin_surface(
        &input,
        &spend,
        &earn,
        &[],
        &tapes,
        months,
        tapes.len(),
        &fixed_strategy(),
    );

    assert_eq!(surface.spending_multipliers.len(), 9);
    assert_eq!(surface.spending_multipliers.first(), Some(&0.8));
    assert_eq!(surface.spending_multipliers.last(), Some(&1.2));
    // Retirement age 65 ± 6 years, sampled every 18 months.
    assert_eq!(
        surface.retirement_ages,
        vec![59.0, 60.5, 62.0, 63.5, 65.0, 66.5, 68.0, 69.5, 71.0]
    );
    assert_eq!(surface.ruin_probabilities.len(), 9);
    assert!(
        surface
            .ruin_probabilities
            .iter()
            .all(|row| row.len() == surface.retirement_ages.len())
    );
    assert!(
        surface
            .ruin_probabilities
            .iter()
            .flatten()
            .all(|p| (0.0..=1.0).contains(p))
    );
    assert_eq!(surface.sample_count, tapes.len());
}

#[test]
fn ruin_rises_with_spending_and_falls_with_a_later_retirement() {
    let (input, spend, earn, tapes, months) = surface_fixture();
    let surface = build_ruin_surface(
        &input,
        &spend,
        &earn,
        &[],
        &tapes,
        months,
        tapes.len(),
        &fixed_strategy(),
    );

    let column = surface.retirement_ages.len() - 1;
    for row in surface.ruin_probabilities.windows(2) {
        assert!(
            row[0][column] <= row[1][column],
            "spending more should never reduce ruin"
        );
    }
    let last_row = &surface.ruin_probabilities[surface.ruin_probabilities.len() - 1];
    assert!(
        last_row[0] >= last_row[column],
        "retiring earlier should never reduce ruin"
    );
}

#[test]
fn the_retirement_age_axis_is_bounded_by_the_plan_horizon() {
    let mut input = base_input();
    // A retirement age near the simulation end would otherwise push candidates past it.
    input.current_age = 60.0;
    input.retirement_age = 63.0;
    input.simulate_until_age = 66.0;
    let months = 72;
    let tapes = vec![flat_tape(months as usize, 0.003, 0.0015)];

    let surface = build_ruin_surface(
        &input,
        &[spending(60.0, 70.0, 20_000.0, true)],
        &[income(60.0, 63.0, 50_000.0, true)],
        &[],
        &tapes,
        months,
        1,
        &fixed_strategy(),
    );
    assert!(
        surface
            .retirement_ages
            .iter()
            .all(|&age| age >= 61.0 && age <= 65.0)
    );
    // Sorted and deduplicated after clamping.
    let mut sorted = surface.retirement_ages.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    sorted.dedup();
    assert_eq!(sorted, surface.retirement_ages);
}

#[test]
fn an_already_retired_plan_collapses_the_retirement_age_axis() {
    let mut input = base_input();
    input.current_age = 67.0;
    input.retirement_age = 67.0;
    input.simulate_until_age = 90.0;
    let months = 276;
    let tapes = vec![flat_tape(months as usize, 0.003, 0.0015)];

    let surface = build_ruin_surface(
        &input,
        &[spending(67.0, 95.0, 30_000.0, true)],
        &[],
        &[],
        &tapes,
        months,
        1,
        &fixed_strategy(),
    );
    assert_eq!(surface.retirement_ages, vec![67.0]);
    assert!(surface.ruin_probabilities.iter().all(|row| row.len() == 1));
}

// ── coast FIRE ────────────────────────────────────────────────────────────

fn coast_fixture(
    savings: f64,
) -> (
    rust_engine::structs::RetirementInput,
    Vec<rust_engine::structs::SpendingPeriod>,
    Vec<rust_engine::structs::IncomeSource>,
    Vec<PathTape>,
    u32,
    usize,
) {
    let mut input = base_input();
    input.current_savings = savings;
    let months = ((input.simulate_until_age - input.current_age) * 12.0) as u32;
    let retire_month = ((input.retirement_age - input.current_age) * 12.0) as usize;
    let spend = vec![spending(40.0, 95.0, 30_000.0, true)];
    let earn = vec![income(40.0, 65.0, 80_000.0, true)];
    let tapes: Vec<PathTape> = (0..8)
        .map(|i| flat_tape(months as usize, 0.004 + i as f64 * 0.0002, 0.0015))
        .collect();
    (input, spend, earn, tapes, months, retire_month)
}

#[test]
fn coast_age_is_between_today_and_retirement_and_is_actually_sufficient() {
    let (input, spend, earn, tapes, months, retire_month) = coast_fixture(600_000.0);
    let coast = find_coast_age(
        &input,
        &spend,
        &earn,
        &[],
        &tapes,
        months,
        tapes.len(),
        &fixed_strategy(),
        retire_month,
        0.95,
    )
    .expect("a well-funded plan should have a coast age");

    assert!(
        coast >= input.current_age && coast <= input.retirement_age,
        "coast age {coast}"
    );

    // Verify the reported month really clears the bar, and that one month earlier does not.
    let arrays = build_cashflow_arrays(&input, &spend, &earn, &[], months);
    let success_at = |stop: usize| {
        1.0 - replay_ruin_probability(
            &tapes,
            &arrays,
            input.current_savings,
            tapes.len(),
            months,
            &fixed_strategy(),
            retire_month,
            input.annual_fee_percent,
            input.tax_on_gains_percent,
            Some(stop),
        )
    };
    let coast_month = ((coast - input.current_age) * 12.0).round() as usize;
    assert!(success_at(coast_month) >= 0.95);
    if coast_month > 0 {
        assert!(success_at(coast_month - 1) < 0.95, "the search overshot");
    }
}

#[test]
fn coast_age_is_none_when_even_full_contributions_miss_the_target() {
    let (input, _spend, earn, tapes, months, retire_month) = coast_fixture(0.0);
    let starved = vec![spending(40.0, 95.0, 500_000.0, true)];
    assert!(
        find_coast_age(
            &input,
            &starved,
            &earn,
            &[],
            &tapes,
            months,
            tapes.len(),
            &fixed_strategy(),
            retire_month,
            0.95,
        )
        .is_none()
    );
}

#[test]
fn coast_age_is_none_without_contributions_to_stop() {
    let (input, spend, _, tapes, months, retire_month) = coast_fixture(3_000_000.0);
    // No income at all ⇒ there is no contribution to give up.
    assert!(
        find_coast_age(
            &input,
            &spend,
            &[],
            &[],
            &tapes,
            months,
            tapes.len(),
            &fixed_strategy(),
            retire_month,
            0.95,
        )
        .is_none()
    );
}

#[test]
fn coast_age_is_none_for_degenerate_inputs() {
    let (input, spend, earn, tapes, months, _) = coast_fixture(600_000.0);
    let call = |tapes: &[PathTape], samples, retire_month| {
        find_coast_age(
            &input,
            &spend,
            &earn,
            &[],
            tapes,
            months,
            samples,
            &fixed_strategy(),
            retire_month,
            0.95,
        )
    };
    // Already retired.
    assert!(call(&tapes, tapes.len(), 0).is_none());
    assert!(call(&[], 8, 300).is_none());
    assert!(call(&tapes, 0, 300).is_none());
}

#[test]
fn coast_age_scans_every_month_for_adaptive_strategies() {
    // Guardrails can spend *more* after a better accumulation, so the search must not
    // assume monotonicity; it should still return a month that clears the target.
    let (input, spend, earn, tapes, months, retire_month) = coast_fixture(700_000.0);
    let strategy = WithdrawalStrategy {
        kind: "guardrails".to_string(),
        ..WithdrawalStrategy::default()
    };
    let coast = find_coast_age(
        &input,
        &spend,
        &earn,
        &[],
        &tapes,
        months,
        tapes.len(),
        &strategy,
        retire_month,
        0.95,
    );

    if let Some(age) = coast {
        let arrays = build_cashflow_arrays(&input, &spend, &earn, &[], months);
        let stop = ((age - input.current_age) * 12.0).round() as usize;
        let success = 1.0
            - replay_ruin_probability(
                &tapes,
                &arrays,
                input.current_savings,
                tapes.len(),
                months,
                &strategy,
                retire_month,
                input.annual_fee_percent,
                input.tax_on_gains_percent,
                Some(stop),
            );
        assert!(success >= 0.95, "reported coast age only reaches {success}");
    }
}

#[test]
fn lump_sums_survive_the_coast_calculation() {
    // Lump sums stay scheduled even after contributions stop, so a large windfall can only
    // move the coast age earlier.
    let (input, spend, earn, tapes, months, retire_month) = coast_fixture(300_000.0);
    let without = find_coast_age(
        &input,
        &spend,
        &earn,
        &[],
        &tapes,
        months,
        tapes.len(),
        &fixed_strategy(),
        retire_month,
        0.95,
    );
    let with = find_coast_age(
        &input,
        &spend,
        &earn,
        &[lump_sum(50.0, 500_000.0)],
        &tapes,
        months,
        tapes.len(),
        &fixed_strategy(),
        retire_month,
        0.95,
    );
    if let (Some(without), Some(with)) = (without, with) {
        assert!(with <= without, "a windfall should not delay coasting");
    } else {
        assert!(
            with.is_some(),
            "the windfall plan should be at least as feasible"
        );
    }
}
