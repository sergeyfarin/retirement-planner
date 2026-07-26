//! `evaluate_path` accounting and the withdrawal strategies it drives.

mod common;

use common::{assert_close, empty_cashflows, fixed_strategy, flat_tape};
use rust_engine::engine2::{evaluate_path, PathTape, WithdrawalRunner};
use rust_engine::structs::WithdrawalStrategy;

fn strategy(kind: &str) -> WithdrawalStrategy {
    WithdrawalStrategy {
        kind: kind.to_string(),
        ..WithdrawalStrategy::default()
    }
}

// ── WithdrawalRunner ──────────────────────────────────────────────────────

#[test]
fn fixed_strategy_follows_the_planned_schedule_exactly() {
    let mut runner = WithdrawalRunner::new(&fixed_strategy(), 12);
    for month in 0..60 {
        // Balance is irrelevant to the fixed rule, including at zero.
        assert_eq!(runner.monthly_spending(month, 0.0, 2_500.0), 2_500.0);
    }
}

#[test]
fn dynamic_strategies_are_inert_before_retirement() {
    for kind in ["guardrails", "percentOfPortfolio"] {
        let mut runner = WithdrawalRunner::new(&strategy(kind), 24);
        for month in 0..24 {
            assert_eq!(runner.monthly_spending(month, 1_000_000.0, 3_000.0), 3_000.0);
        }
    }
}

#[test]
fn guardrails_cut_spending_when_the_withdrawal_rate_runs_hot() {
    let mut runner = WithdrawalRunner::new(&strategy("guardrails"), 0);
    // Year 0 anchors the initial rate: 36,000 / 1,000,000 = 3.6%.
    assert_eq!(runner.monthly_spending(0, 1_000_000.0, 3_000.0), 3_000.0);
    // A halved portfolio doubles the rate, well past the +20% band ⇒ −10% spending.
    let year_two = runner.monthly_spending(12, 500_000.0, 3_000.0);
    assert_close(year_two, 3_000.0 * 0.9, 1e-9);
    // Still hot the following year ⇒ another 10% cut, compounding.
    let year_three = runner.monthly_spending(24, 400_000.0, 3_000.0);
    assert_close(year_three, 3_000.0 * 0.81, 1e-9);
}

#[test]
fn guardrails_raise_spending_when_the_portfolio_outgrows_the_plan() {
    let mut runner = WithdrawalRunner::new(&strategy("guardrails"), 0);
    runner.monthly_spending(0, 1_000_000.0, 3_000.0);
    let year_two = runner.monthly_spending(12, 3_000_000.0, 3_000.0);
    assert_close(year_two, 3_000.0 * 1.1, 1e-9);
}

#[test]
fn guardrails_hold_spending_inside_the_band() {
    let mut runner = WithdrawalRunner::new(&strategy("guardrails"), 0);
    runner.monthly_spending(0, 1_000_000.0, 3_000.0);
    // A 10% drop moves the rate by ~11%, inside the ±20% band.
    assert_eq!(runner.monthly_spending(12, 900_000.0, 3_000.0), 3_000.0);
}

#[test]
fn guardrails_only_reassess_at_retirement_year_boundaries() {
    let mut runner = WithdrawalRunner::new(&strategy("guardrails"), 0);
    runner.monthly_spending(0, 1_000_000.0, 3_000.0);
    // Mid-year collapse: the multiplier is held until the next anniversary.
    for month in 1..12 {
        assert_eq!(runner.monthly_spending(month, 100_000.0, 3_000.0), 3_000.0);
    }
    assert!(runner.monthly_spending(12, 100_000.0, 3_000.0) < 3_000.0);
}

#[test]
fn guardrail_anniversaries_are_measured_from_retirement_not_from_month_zero() {
    let mut runner = WithdrawalRunner::new(&strategy("guardrails"), 7);
    runner.monthly_spending(7, 1_000_000.0, 3_000.0);
    // Month 12 is not a retirement anniversary; month 19 is.
    assert_eq!(runner.monthly_spending(12, 100_000.0, 3_000.0), 3_000.0);
    assert!(runner.monthly_spending(19, 100_000.0, 3_000.0) < 3_000.0);
}

#[test]
fn guardrail_multiplier_is_clamped_to_the_floor_and_ceiling() {
    let mut runner = WithdrawalRunner::new(&strategy("guardrails"), 0);
    runner.monthly_spending(0, 1_000_000.0, 3_000.0);
    let mut last = 3_000.0;
    for year in 1..40 {
        last = runner.monthly_spending(year * 12, 10_000.0, 3_000.0);
    }
    // Repeated cuts bottom out at the 0.6 floor rather than decaying to zero.
    assert_close(last, 3_000.0 * 0.6, 1e-9);

    let mut up = WithdrawalRunner::new(&strategy("guardrails"), 0);
    up.monthly_spending(0, 1_000_000.0, 3_000.0);
    let mut high = 3_000.0;
    for year in 1..40 {
        high = up.monthly_spending(year * 12, 1e12, 3_000.0);
    }
    assert_close(high, 3_000.0 * 1.4, 1e-9);
}

#[test]
fn guardrails_are_dormant_when_the_portfolio_is_already_empty_at_retirement() {
    // With no balance the initial rate is undefined; spending must not be adjusted on the
    // basis of a zero anchor.
    let mut runner = WithdrawalRunner::new(&strategy("guardrails"), 0);
    assert_eq!(runner.monthly_spending(0, 0.0, 3_000.0), 3_000.0);
    assert_eq!(runner.monthly_spending(12, 5_000_000.0, 3_000.0), 3_000.0);
}

#[test]
fn percent_of_portfolio_spends_a_share_of_the_balance_and_holds_it_for_the_year() {
    let mut runner = WithdrawalRunner::new(&strategy("percentOfPortfolio"), 0);
    // 4% of 1,000,000 = 40,000/yr, inside [0.6, 1.4] × the 36,000 anchor.
    assert_close(runner.monthly_spending(0, 1_000_000.0, 3_000.0), 40_000.0 / 12.0, 1e-9);
    // Held flat for the rest of the year regardless of balance moves.
    for month in 1..12 {
        assert_close(
            runner.monthly_spending(month, 2_000_000.0, 3_000.0),
            40_000.0 / 12.0,
            1e-9,
        );
    }
    // Recomputed on the anniversary.
    assert_close(
        runner.monthly_spending(12, 1_200_000.0, 3_000.0),
        48_000.0 / 12.0,
        1e-9,
    );
}

#[test]
fn dynamic_strategies_apply_to_portfolio_funded_spending_only() {
    let mut guardrails = WithdrawalRunner::new(&strategy("guardrails"), 0);
    // Gross spending is 3,000/month, but pension income funds 2,000 of it. The initial
    // withdrawal rate is therefore 12,000 / 1,000,000 = 1.2%, not 3.6%.
    assert_eq!(
        guardrails.monthly_spending_with_income(0, 1_000_000.0, 3_000.0, 2_000.0),
        3_000.0
    );
    let cut = guardrails.monthly_spending_with_income(12, 500_000.0, 3_000.0, 2_000.0);
    assert_close(cut, 2_000.0 + 1_000.0 * 0.9, 1e-9);

    let mut percent = WithdrawalRunner::new(&strategy("percentOfPortfolio"), 0);
    // The percentage is a portfolio withdrawal, and pension income is added to it to
    // obtain total spending. The existing gross-spending guardrails still cap extremes.
    let spend = percent.monthly_spending_with_income(0, 1_000_000.0, 3_000.0, 2_000.0);
    assert_close(spend, 2_000.0 + 40_000.0 / 12.0, 1e-9);
}

#[test]
fn percent_of_portfolio_is_clamped_by_the_floor_and_ceiling() {
    let mut runner = WithdrawalRunner::new(&strategy("percentOfPortfolio"), 0);
    runner.monthly_spending(0, 1_000_000.0, 3_000.0);
    // Anchor = 36,000/yr. A tiny portfolio would imply near-zero spending; the floor is
    // 0.6 × 36,000.
    assert_close(runner.monthly_spending(12, 1_000.0, 3_000.0), 21_600.0 / 12.0, 1e-9);
    // A huge portfolio is capped at 1.4 × 36,000.
    assert_close(runner.monthly_spending(24, 1e12, 3_000.0), 50_400.0 / 12.0, 1e-9);
    // Negative balances are floored at zero before the percentage is taken.
    assert_close(runner.monthly_spending(36, -5_000.0, 3_000.0), 21_600.0 / 12.0, 1e-9);
}

#[test]
fn unknown_strategy_kinds_fall_back_to_fixed() {
    let mut runner = WithdrawalRunner::new(&strategy("something-else"), 0);
    assert_eq!(runner.monthly_spending(0, 1_000_000.0, 3_000.0), 3_000.0);
    assert_eq!(runner.monthly_spending(12, 10.0, 3_000.0), 3_000.0);
}

#[test]
fn strategy_parameters_are_sanitised() {
    // A zero band would fire on every rounding error; a >100% adjustment would flip the
    // sign of spending. Both are bounded at construction.
    let hostile = WithdrawalStrategy {
        kind: "guardrails".to_string(),
        guardrail_band: Some(-1.0),
        adjustment: Some(5.0),
        withdrawal_percent: Some(-0.5),
        spending_floor: Some(-2.0),
        spending_ceiling: Some(-1.0),
    };
    let mut runner = WithdrawalRunner::new(&hostile, 0);
    runner.monthly_spending(0, 1_000_000.0, 3_000.0);
    let cut = runner.monthly_spending(12, 1_000.0, 3_000.0);
    assert!(cut >= 0.0, "spending must never go negative, got {cut}");

    let mut percent = WithdrawalRunner::new(
        &WithdrawalStrategy {
            kind: "percentOfPortfolio".to_string(),
            ..hostile
        },
        0,
    );
    let spend = percent.monthly_spending(0, 1_000_000.0, 3_000.0);
    assert!(spend >= 0.0 && spend.is_finite());
}

#[test]
fn missing_optional_strategy_fields_use_the_documented_defaults() {
    let bare = WithdrawalStrategy {
        kind: "percentOfPortfolio".to_string(),
        guardrail_band: None,
        adjustment: None,
        withdrawal_percent: None,
        spending_floor: None,
        spending_ceiling: None,
    };
    let mut runner = WithdrawalRunner::new(&bare, 0);
    // Default withdrawal_percent = 4%.
    assert_close(runner.monthly_spending(0, 1_000_000.0, 3_000.0), 40_000.0 / 12.0, 1e-9);
}

// ── evaluate_path ─────────────────────────────────────────────────────────

#[test]
fn a_flat_path_with_no_cashflows_compounds_the_starting_balance() {
    let months = 12;
    let evaluation = evaluate_path(
        &flat_tape(months, 0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        true,
    );
    assert_close(evaluation.final_balance, 1_000.0 * 1.01_f64.powi(12), 1e-9);
    assert_eq!(evaluation.balances.len(), months);
    assert_close(evaluation.balances[0], 1_010.0, 1e-9);
    assert!(!evaluation.depleted);
    assert_eq!(evaluation.depleted_months, 0);
    assert_eq!(evaluation.cumulative_shortfall, 0.0);
}

#[test]
fn balances_are_reported_in_real_terms() {
    let months = 12;
    // Nominal growth exactly equal to inflation ⇒ no real change.
    let evaluation = evaluate_path(
        &flat_tape(months, 0.01, 0.01),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        true,
    );
    assert_close(evaluation.final_balance, 1_000.0, 1e-9);
}

#[test]
fn fees_are_charged_monthly_on_the_whole_balance() {
    let months = 12;
    let evaluation = evaluate_path(
        &flat_tape(months, 0.0, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.012, // 1.2%/yr ⇒ 0.1%/month
        0.0,
        None,
        false,
    );
    assert_close(evaluation.final_balance, 1_000.0 * 0.999_f64.powi(12), 1e-9);
}

#[test]
fn absurd_fee_rates_are_clamped_rather_than_making_the_balance_negative() {
    let months = 12;
    let evaluation = evaluate_path(
        &flat_tape(months, 0.0, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        50.0,
        0.0,
        None,
        false,
    );
    // The rate is clamped to 100%/yr, so the balance erodes at 1/12 per month but never
    // goes negative and never turns into a NaN.
    assert_close(
        evaluation.final_balance,
        1_000.0 * (1.0 - 1.0 / 12.0_f64).powi(12),
        1e-9,
    );
    assert!(evaluation.final_balance > 0.0);
    assert!(!evaluation.depleted);
}

#[test]
fn gains_tax_is_settled_once_a_year_on_realized_pnl() {
    let months = 12;
    let untaxed = evaluate_path(
        &flat_tape(months, 0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        true,
    );
    let taxed = evaluate_path(
        &flat_tape(months, 0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.25,
        None,
        true,
    );

    // No tax is taken until the December settlement.
    for month in 0..11 {
        assert_close(taxed.balances[month], untaxed.balances[month], 1e-9);
    }
    let gain = untaxed.final_balance - 1_000.0;
    assert_close(taxed.final_balance, untaxed.final_balance - gain * 0.25, 1e-9);
}

#[test]
fn a_losing_year_is_not_taxed() {
    let months = 12;
    let taxed = evaluate_path(
        &flat_tape(months, -0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.4,
        None,
        false,
    );
    assert_close(taxed.final_balance, 1_000.0 * 0.99_f64.powi(12), 1e-9);
}

#[test]
fn a_partial_final_year_is_still_settled() {
    // 18 months: the second settlement happens at the last month, not silently skipped.
    let months = 18;
    let with_tax = evaluate_path(
        &flat_tape(months, 0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.3,
        None,
        false,
    );
    let without_tax = evaluate_path(
        &flat_tape(months, 0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        false,
    );
    // Two settlements, so the shortfall against the untaxed path exceeds one year's worth.
    assert!(with_tax.final_balance < without_tax.final_balance);
    let one_settlement_only = without_tax.final_balance
        - (without_tax.final_balance - 1_000.0 * 1.01_f64.powi(12)) * 0.0;
    assert!(with_tax.final_balance < one_settlement_only);
}

#[test]
fn overspending_records_a_shortfall_and_marks_the_path_depleted() {
    let months = 6;
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        cashflows.monthly_real_spending_flow[month] = 400.0;
    }
    let evaluation = evaluate_path(
        &flat_tape(months, 0.0, 0.0),
        &cashflows,
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        true,
    );

    assert!(evaluation.depleted);
    assert_eq!(evaluation.final_balance, 0.0);
    // 1,000 covers 2.5 months; months 3-6 are unfunded: 200 + 400 × 3.
    assert_close(evaluation.cumulative_shortfall, 1_400.0, 1e-9);
    assert_eq!(evaluation.depleted_months, 4);
    assert!(evaluation.balances[3..].iter().all(|&b| b == 0.0));
}

#[test]
fn a_balance_that_touches_zero_stays_flagged_even_if_income_revives_it() {
    let months = 6;
    let mut cashflows = empty_cashflows(months);
    cashflows.monthly_real_spending_flow[0] = 5_000.0;
    cashflows.monthly_real_income_flow[3] = 10_000.0;
    let evaluation = evaluate_path(
        &flat_tape(months, 0.0, 0.0),
        &cashflows,
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        false,
    );
    assert!(evaluation.depleted, "a ruined path must stay ruined");
    assert!(evaluation.final_balance > 0.0);
    assert_close(evaluation.cumulative_shortfall, 4_000.0, 1e-9);
    assert_eq!(evaluation.depleted_months, 3);
}

#[test]
fn nominal_flows_are_deflated_by_the_paths_realized_inflation() {
    let months = 12;
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        cashflows.monthly_nominal_income_flow[month] = 100.0;
    }
    let evaluation = evaluate_path(
        &flat_tape(months, 0.0, 0.01),
        &cashflows,
        0.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        true,
    );

    // Month 0 credits the full face value (the realized index is still 1.0), and the
    // balance is then reported in real terms, so one month of inflation is taken off.
    assert_close(evaluation.balances[0], 100.0 / 1.01, 1e-9);
    let real_sum: f64 = (0..months)
        .map(|m| 100.0 / 1.01_f64.powi(m as i32))
        // ...and each contribution is then deflated for every month it is held.
        .zip((0..months).map(|m| 1.0 / 1.01_f64.powi((months - m) as i32)))
        .map(|(contribution, holding)| contribution * holding)
        .sum();
    assert_close(evaluation.final_balance, real_sum, 1e-6);
}

#[test]
fn real_flows_are_immune_to_inflation() {
    let months = 12;
    let mut real = empty_cashflows(months);
    let mut nominal = empty_cashflows(months);
    for month in 0..months {
        real.monthly_real_income_flow[month] = 100.0;
        nominal.monthly_nominal_income_flow[month] = 100.0;
    }
    let tape = flat_tape(months, 0.0, 0.02);
    let args = |c: &_| {
        evaluate_path(
            &tape, c, 0.0, months, &fixed_strategy(), 0, 0.0, 0.0, None, false,
        )
        .final_balance
    };
    assert!(args(&real) > args(&nominal));
}

#[test]
fn lump_sums_are_credited_in_their_month() {
    let months = 6;
    let mut cashflows = empty_cashflows(months);
    cashflows.lump_sum_by_month[2] = 500.0;
    let evaluation = evaluate_path(
        &flat_tape(months, 0.0, 0.0),
        &cashflows,
        100.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        true,
    );
    assert_eq!(evaluation.balances[1], 100.0);
    assert_eq!(evaluation.balances[2], 600.0);
    assert_eq!(evaluation.final_balance, 600.0);
}

#[test]
fn stopping_contributions_removes_only_pre_retirement_surpluses() {
    let months = 24;
    let retire_month = 12;
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        cashflows.monthly_real_income_flow[month] = 1_000.0;
        cashflows.monthly_real_spending_flow[month] = 400.0;
    }

    let tape = flat_tape(months, 0.0, 0.0);
    let run = |stop| {
        evaluate_path(
            &tape,
            &cashflows,
            0.0,
            months,
            &fixed_strategy(),
            retire_month,
            0.0,
            0.0,
            stop,
            false,
        )
        .final_balance
    };

    let full = run(None);
    assert_close(full, 600.0 * 24.0, 1e-9);
    // Coasting from month 6 drops six months of the 600 surplus...
    assert_close(run(Some(6)), full - 600.0 * 6.0, 1e-9);
    // ...and coasting from month 0 drops the whole accumulation phase, but never touches
    // the post-retirement months.
    assert_close(run(Some(0)), 600.0 * 12.0, 1e-9);
    // A stop at or after retirement changes nothing.
    assert_close(run(Some(retire_month)), full, 1e-9);
    assert_close(run(Some(months)), full, 1e-9);
}

#[test]
fn stopping_contributions_leaves_deficits_and_lump_sums_on_schedule() {
    let months = 12;
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        // A deficit, not a contribution: capping income at spending must not "fix" it.
        cashflows.monthly_real_income_flow[month] = 100.0;
        cashflows.monthly_real_spending_flow[month] = 300.0;
    }
    cashflows.lump_sum_by_month[3] = 1_000.0;

    let tape = flat_tape(months, 0.0, 0.0);
    let with_stop = evaluate_path(
        &tape, &cashflows, 5_000.0, months, &fixed_strategy(), 12, 0.0, 0.0, Some(0), false,
    );
    let without_stop = evaluate_path(
        &tape, &cashflows, 5_000.0, months, &fixed_strategy(), 12, 0.0, 0.0, None, false,
    );
    assert_close(with_stop.final_balance, without_stop.final_balance, 1e-9);
    assert_close(with_stop.final_balance, 5_000.0 - 200.0 * 12.0 + 1_000.0, 1e-9);
}

#[test]
fn annual_real_returns_are_only_recorded_from_retirement_onward() {
    let months = 36;
    let retire_month = 12;
    let evaluation = evaluate_path(
        &flat_tape(months, 0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        retire_month,
        0.0,
        0.0,
        None,
        true,
    );
    // 24 post-retirement months ⇒ two complete retirement years.
    assert_eq!(evaluation.annual_real_returns.len(), 2);
    for year in &evaluation.annual_real_returns {
        assert_close(*year, 1.01_f64.powi(12) - 1.0, 1e-9);
    }
}

#[test]
fn real_returns_are_net_of_inflation_fees_and_tax() {
    let months = 12;
    let evaluation = evaluate_path(
        &flat_tape(months, 0.01, 0.002),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.012,
        0.25,
        None,
        true,
    );
    assert_eq!(evaluation.annual_real_returns.len(), 1);
    // The recorded year must reconcile with the balance it actually produced.
    assert_close(
        evaluation.annual_real_returns[0],
        evaluation.final_balance / 1_000.0 - 1.0,
        1e-9,
    );
}

#[test]
fn no_series_is_allocated_when_recording_is_off() {
    let months = 24;
    let evaluation = evaluate_path(
        &flat_tape(months, 0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        false,
    );
    assert!(evaluation.balances.is_empty());
    assert!(evaluation.annual_real_returns.is_empty());
    // The headline numbers are unaffected by the recording flag.
    let recorded = evaluate_path(
        &flat_tape(months, 0.01, 0.0),
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        true,
    );
    assert_eq!(evaluation.final_balance, recorded.final_balance);
}

#[test]
fn a_short_tape_truncates_the_run_without_reading_past_its_end() {
    // The evaluator must clamp to the shortest of months / returns / inflation.
    let tape = PathTape {
        asset_returns: vec![0.01; 5],
        inflation_rates: vec![0.0; 3],
    };
    let evaluation = evaluate_path(
        &tape,
        &empty_cashflows(24),
        1_000.0,
        24,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        true,
    );
    assert_close(evaluation.final_balance, 1_000.0 * 1.01_f64.powi(3), 1e-9);
    // The recorded series still spans the requested horizon; unrun months stay zero.
    assert_eq!(evaluation.balances.len(), 24);
    assert!(evaluation.balances[3..].iter().all(|&b| b == 0.0));
}

#[test]
fn a_zero_month_horizon_returns_the_starting_balance_untouched() {
    let evaluation = evaluate_path(
        &flat_tape(0, 0.0, 0.0),
        &empty_cashflows(0),
        1_234.0,
        0,
        &fixed_strategy(),
        0,
        0.01,
        0.2,
        None,
        true,
    );
    assert_eq!(evaluation.final_balance, 1_234.0);
    assert!(!evaluation.depleted);
    assert!(evaluation.balances.is_empty());
}

#[test]
fn a_total_loss_month_is_survivable_arithmetic() {
    let months = 3;
    let tape = PathTape {
        asset_returns: vec![-1.0, 0.5, 0.5],
        inflation_rates: vec![0.0; 3],
    };
    let evaluation = evaluate_path(
        &tape,
        &empty_cashflows(months),
        1_000.0,
        months,
        &fixed_strategy(),
        0,
        0.0,
        0.0,
        None,
        false,
    );
    assert_eq!(evaluation.final_balance, 0.0);
    assert!(evaluation.depleted);
    assert!(evaluation.final_balance.is_finite());
}

#[test]
fn dynamic_strategies_survive_a_ruinous_path_without_producing_nonsense() {
    let months = 120;
    let mut cashflows = empty_cashflows(months);
    for month in 0..months {
        cashflows.monthly_real_spending_flow[month] = 5_000.0;
    }
    for kind in ["fixed", "guardrails", "percentOfPortfolio"] {
        let evaluation = evaluate_path(
            &flat_tape(months, -0.02, 0.01),
            &cashflows,
            100_000.0,
            months,
            &strategy(kind),
            0,
            0.01,
            0.2,
            None,
            true,
        );
        assert!(evaluation.depleted, "{kind} should deplete here");
        assert_eq!(evaluation.final_balance, 0.0);
        assert!(evaluation.cumulative_shortfall > 0.0);
        assert!(evaluation.balances.iter().all(|b| b.is_finite() && *b >= 0.0));
    }
}
