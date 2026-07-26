use crate::calculations::summarize;
use crate::engine::{RuinSurface, SequenceRiskBucket};
use crate::engine2::{build_cashflow_arrays, evaluate_path, CashflowArrays, PathTape};
use crate::structs::{
    IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod, WithdrawalStrategy,
};

/// Groups simulations into quintiles by their mean real return over the first ten
/// *post-retirement* years — the Kitces/Pfau danger window, when withdrawals turn a
/// drawdown into permanently sold-off capital.
///
/// The caller supplies retirement-relative annual buckets, so a fractional retirement
/// age never mixes accumulation months into the first bucket.
pub fn build_sequence_risk_summary(
    annual_real_returns_by_sim: &[Vec<f64>],
    final_balances: &[f64],
    depleted_flags: &[bool],
) -> Vec<SequenceRiskBucket> {
    let sim_count = annual_real_returns_by_sim.len();
    if sim_count == 0 || annual_real_returns_by_sim.iter().any(Vec::is_empty) {
        return vec![];
    }

    let early_years = annual_real_returns_by_sim
        .iter()
        .map(Vec::len)
        .min()
        .unwrap_or(0)
        .min(10);

    struct EnrichedIndex {
        index: usize,
        early_mean: f64,
    }

    let mut enriched: Vec<EnrichedIndex> = annual_real_returns_by_sim
        .iter()
        .enumerate()
        .map(|(index, series)| {
            let sum: f64 = series.iter().take(early_years).sum();
            EnrichedIndex {
                index,
                early_mean: sum / (early_years as f64),
            }
        })
        .collect();

    enriched.sort_by(|a, b| {
        a.early_mean
            .partial_cmp(&b.early_mean)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let bucket_count = 5;
    let mut buckets: Vec<SequenceRiskBucket> = Vec::with_capacity(bucket_count);

    for bucket in 0..bucket_count {
        let from = (bucket * sim_count) / bucket_count;
        let to = ((bucket + 1) * sim_count) / bucket_count;
        let members = &enriched[from..to];
        if members.is_empty() {
            continue;
        }

        let early_mean_sum: f64 = members.iter().map(|m| m.early_mean).sum();
        let early_mean = early_mean_sum / (members.len() as f64);

        let mut ruin_count = 0;
        let mut member_final_balances = Vec::with_capacity(members.len());

        for member in members {
            let idx = member.index;
            if depleted_flags[idx] {
                ruin_count += 1;
            }
            member_final_balances.push(final_balances[idx]);
        }

        let p_series = summarize(&member_final_balances);
        let ending_median = p_series.p50;

        let label = if bucket == 0 {
            format!("Q{} (worst early sequence)", bucket + 1)
        } else if bucket == bucket_count - 1 {
            format!("Q{} (best early sequence)", bucket + 1)
        } else {
            format!("Q{}", bucket + 1)
        };

        buckets.push(SequenceRiskBucket {
            bucket_label: label,
            early_years_mean_return: early_mean,
            ruin_probability: (ruin_count as f64) / (members.len() as f64),
            ending_median,
        });
    }

    buckets
}

#[allow(clippy::too_many_arguments)]
pub fn replay_ruin_probability(
    path_tapes: &[PathTape],
    cashflows: &CashflowArrays,
    current_savings: f64,
    sample_count: usize,
    months: u32,
    strategy: &WithdrawalStrategy,
    retire_month: usize,
    annual_fee_percent: f64,
    tax_on_gains_percent: f64,
    stop_contributions_at: Option<usize>,
) -> f64 {
    let mut ruin_count = 0;
    let replay_count = sample_count.min(path_tapes.len());

    for sim in 0..replay_count {
        let result = evaluate_path(
            &path_tapes[sim],
            cashflows,
            current_savings,
            months as usize,
            strategy,
            retire_month,
            annual_fee_percent,
            tax_on_gains_percent,
            stop_contributions_at,
            false,
        );
        if result.depleted {
            ruin_count += 1;
        }
    }

    (ruin_count as f64) / (replay_count.max(1) as f64)
}

/// Already-retired mode. There is no separate flag: `retirement_age == current_age` *is*
/// the encoding, so it survives share links and the wasm boundary without a new field, and
/// both engines derive it from the same two numbers. `retire_month` then comes out as 0 and
/// the whole accumulation phase collapses to nothing.
///
/// Three outputs are only meaningful with an accumulation phase ahead, and each is handled
/// explicitly rather than left to degenerate: Coast FIRE returns `None` (already the case
/// for `retire_month == 0`), the ruin surface drops its retirement-age axis
/// (`build_ruin_surface`), and the P95 FI target switches to a required-starting-capital
/// search (`find_required_starting_capital`). See README §7.6.
///
/// Mirrored in TypeScript as `isAlreadyRetired`.
pub fn is_already_retired(input: &RetirementInput) -> bool {
    input.retirement_age <= input.current_age
}

/// Smallest starting capital that still clears `target_success_probability`, found by
/// bisection over exact replays of stored exogenous return/inflation paths.
///
/// This is the already-retired replacement for the P95 FI target. The usual construction
/// (`find_retirement_balance_target`) reads the answer off the spread of balances *at
/// retirement*, which only exists because different paths accumulate differently. With
/// `retire_month == 0` every path starts from the same capital, that spread collapses to
/// one month of return dispersion, and the empirical target degenerates into roughly
/// "current savings" regardless of whether the plan works — a number that looks like an
/// answer and is not one. Here the question is turned around: hold the paths fixed and vary
/// the capital.
///
/// Success is monotone non-decreasing in starting capital along fixed paths, so bisection
/// is exact up to the tolerance. Returns 0 when income alone survives every path. Panics
/// if invalid inputs or floating-point limits prevent a valid upper bracket; it never
/// returns an unverified capital amount as though it met the target.
///
/// Mirrored in TypeScript as `findRequiredStartingCapital`.
#[allow(clippy::too_many_arguments)]
pub fn find_required_starting_capital(
    path_tapes: &[PathTape],
    cashflows: &CashflowArrays,
    sample_count: usize,
    months: u32,
    strategy: &WithdrawalStrategy,
    retire_month: usize,
    target_success_probability: f64,
    initial_guess: f64,
    annual_fee_percent: f64,
    tax_on_gains_percent: f64,
) -> f64 {
    if sample_count == 0 || path_tapes.is_empty() {
        return 0.0;
    }
    assert!(
        (0.0..=1.0).contains(&target_success_probability),
        "target success probability must be between 0 and 1"
    );

    let success_at = |capital: f64| {
        1.0 - replay_ruin_probability(
            path_tapes,
            cashflows,
            capital,
            sample_count,
            months,
            strategy,
            retire_month,
            annual_fee_percent,
            tax_on_gains_percent,
            None,
        )
    };

    if success_at(0.0) >= target_success_probability {
        return 0.0;
    }

    // Bracket upward from the SWR target, which is the right order of magnitude whenever
    // spending dominates. Keep expanding while finite instead of imposing an arbitrary
    // number of doublings: a small initial guess must not silently become a false answer.
    let mut low = 0.0;
    let mut high = initial_guess.max(1.0);
    while success_at(high) < target_success_probability {
        low = high;
        high *= 2.0;
        assert!(
            high.is_finite(),
            "could not bracket the required starting capital within finite numeric limits"
        );
    }

    // Relative tolerance rather than absolute: the answer spans a few thousand to tens of
    // millions depending on the plan's currency and scale.
    let mut step = 0;
    while step < 60 && high - low > (high * 1e-4).max(1.0) {
        let mid = (low + high) / 2.0;
        if success_at(mid) >= target_success_probability {
            high = mid;
        } else {
            low = mid;
        }
        step += 1;
    }

    high
}

#[allow(clippy::too_many_arguments)]
pub fn build_ruin_surface(
    input: &RetirementInput,
    spending_periods: &[SpendingPeriod],
    income_sources: &[IncomeSource],
    lump_sum_events: &[LumpSumEvent],
    path_tapes: &[PathTape],
    months: u32,
    sim_count: usize,
    strategy: &WithdrawalStrategy,
) -> RuinSurface {
    let spending_multipliers = vec![0.8, 0.9, 1.0, 1.1, 1.2];

    // Already retired: the retirement-age axis is gone, not merely shifted. Sweeping it
    // would clamp every candidate to `current_age + 1..+6` and label the result "retire
    // later", but with the salary already ended a later retirement age changes nothing
    // except when the withdrawal strategy starts — a difference with no real-world
    // counterpart. The surface collapses to the one axis that still means something:
    // sensitivity to spending. See README §7.6.
    let already_retired = is_already_retired(input);

    let mut retirement_ages: Vec<usize> = if already_retired {
        vec![input.current_age.round() as usize]
    } else {
        let offsets = vec![-6.0, -3.0, 0.0, 3.0, 6.0];
        offsets
            .iter()
            .map(|&offset| {
                let age = input.retirement_age + offset;
                (input.simulate_until_age - 1.0)
                    .min((input.current_age + 1.0).max(age))
                    .round() as usize
            })
            .collect()
    };

    retirement_ages.sort_unstable();
    retirement_ages.dedup();

    // Must stay in sync with RUIN_SAMPLE_CAP in simulation.rs.
    let sampled_scenarios = sim_count.min(2000);

    let ruin_probabilities: Vec<Vec<f64>> = spending_multipliers
        .iter()
        .map(|&multiplier| {
            let scaled_spending: Vec<SpendingPeriod> = spending_periods
                .iter()
                .map(|period| SpendingPeriod {
                    yearly_amount: period.yearly_amount * multiplier,
                    ..period.clone()
                })
                .collect();

            retirement_ages
                .iter()
                .map(|&ret_age| {
                    let mut adjusted_input = input.clone();
                    adjusted_input.retirement_age = ret_age as f64;

                    let adjusted_income: Vec<IncomeSource> = income_sources
                        .iter()
                        .map(|source| {
                            if source.id == "is-default" {
                                IncomeSource {
                                    to_age: ret_age as f64,
                                    ..source.clone()
                                }
                            } else {
                                source.clone()
                            }
                        })
                        .collect();

                    let arrays = build_cashflow_arrays(
                        &adjusted_input,
                        &scaled_spending,
                        &adjusted_income,
                        lump_sum_events,
                        months,
                    );

                    // `ret_age` is rounded for the axis label, so derive the month from the
                    // flag rather than from the rounded age — a fractional `current_age`
                    // would otherwise reintroduce up to six months of phantom accumulation.
                    let cell_retire_month = if already_retired {
                        0
                    } else {
                        (((ret_age as f64 - input.current_age) * 12.0)
                            .round()
                            .max(0.0) as usize)
                            .min(months as usize)
                    };

                    replay_ruin_probability(
                        path_tapes,
                        &arrays,
                        input.current_savings,
                        sampled_scenarios,
                        months,
                        strategy,
                        cell_retire_month,
                        input.annual_fee_percent,
                        input.tax_on_gains_percent,
                        None,
                    )
                })
                .collect()
        })
        .collect();

    RuinSurface {
        retirement_ages,
        spending_multipliers,
        ruin_probabilities,
        sample_count: sampled_scenarios,
    }
}

/// Coast FIRE: the earliest age at which contributions could stop while still clearing
/// `target_success_probability`.
///
/// "Stopping contributions" removes only positive pre-retirement net cash flow from that
/// age onward. Deficit months and lump sums remain scheduled.
///
/// Returns `None` when there are no positive contributions to stop, or when the target is
/// unreachable even by contributing right up to retirement.
#[allow(clippy::too_many_arguments)]
pub fn find_coast_age(
    input: &RetirementInput,
    spending_periods: &[SpendingPeriod],
    income_sources: &[IncomeSource],
    lump_sum_events: &[LumpSumEvent],
    path_tapes: &[PathTape],
    months: u32,
    sample_count: usize,
    strategy: &WithdrawalStrategy,
    retire_month: usize,
    target_success_probability: f64,
) -> Option<f64> {
    if retire_month == 0 || sample_count == 0 || path_tapes.is_empty() {
        return None;
    }

    let base = build_cashflow_arrays(
        input,
        spending_periods,
        income_sources,
        lump_sum_events,
        months,
    );

    let has_contribution = path_tapes.iter().any(|tape| {
        let mut inflation_index = 1.0;
        for month in 0..retire_month {
            let income = base.monthly_real_income_flow[month]
                + base.monthly_nominal_income_flow[month] / inflation_index;
            let spending = base.monthly_real_spending_flow[month]
                + base.monthly_nominal_spending_flow[month] / inflation_index;
            if income > spending {
                return true;
            }
            inflation_index *= 1.0 + tape.inflation_rates[month];
        }
        false
    });
    if !has_contribution {
        return None;
    }

    let success_at = |coast_month: usize| -> f64 {
        1.0 - replay_ruin_probability(
            path_tapes,
            &base,
            input.current_savings,
            sample_count,
            months,
            strategy,
            retire_month,
            input.annual_fee_percent,
            input.tax_on_gains_percent,
            Some(coast_month),
        )
    };

    // Contributing all the way to retirement is the best case; if even that misses the
    // target there is no coast age to report.
    if success_at(retire_month) < target_success_probability {
        return None;
    }

    // Adaptive withdrawal policies can spend more after a higher retirement balance and
    // introduce discontinuities. Scan every candidate rather than assuming monotonicity.
    if strategy.kind != "fixed" {
        for month in 0..=retire_month {
            if success_at(month) >= target_success_probability {
                return Some(input.current_age + (month as f64) / 12.0);
            }
        }
        return None;
    }

    let mut low = 0usize;
    let mut high = retire_month;
    while low < high {
        let mid = low + (high - low) / 2;
        if success_at(mid) >= target_success_probability {
            high = mid;
        } else {
            low = mid + 1;
        }
    }

    Some(input.current_age + (low as f64) / 12.0)
}

// `success_flags` must use the same definition as the headline success probability
// (spending was always fully funded), so the P95 FI target and the success rate
// agree on what counts as a surviving path.
pub fn find_retirement_balance_target(
    retirement_balances: &[f64],
    success_flags: &[bool],
    target_success_probability: f64,
) -> f64 {
    let outcome_count = retirement_balances.len().min(success_flags.len());
    if outcome_count == 0 {
        return 0.0;
    }

    struct Outcome {
        retirement_balance: f64,
        ending_positive: bool,
    }

    let mut outcomes: Vec<Outcome> = (0..outcome_count)
        .map(|index| Outcome {
            retirement_balance: retirement_balances[index],
            ending_positive: success_flags[index],
        })
        .collect();

    outcomes.sort_by(|a, b| {
        a.retirement_balance
            .partial_cmp(&b.retirement_balance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut suffix_success = vec![0; outcome_count + 1];
    for index in (0..outcome_count).rev() {
        suffix_success[index] = suffix_success[index + 1]
            + if outcomes[index].ending_positive {
                1
            } else {
                0
            };
    }

    let mut required_target = outcomes[outcome_count - 1].retirement_balance;
    for index in 0..outcome_count {
        let sample_size = (outcome_count - index) as f64;
        let success_probability = (suffix_success[index] as f64) / sample_size;
        if success_probability >= target_success_probability {
            required_target = outcomes[index].retirement_balance;
            break;
        }
    }

    required_target.max(0.0)
}
