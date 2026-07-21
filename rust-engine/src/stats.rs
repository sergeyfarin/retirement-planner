use crate::calculations::summarize;
use crate::engine::{RuinSurface, SequenceRiskBucket};
use crate::engine2::{build_cashflow_arrays, WithdrawalRunner};
use crate::structs::{
    IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod, WithdrawalStrategy,
};

pub fn build_sequence_risk_summary(
    annual_real_returns_by_sim: &[Vec<f64>],
    final_balances: &[f64],
    depleted_flags: &[bool],
) -> Vec<SequenceRiskBucket> {
    let sim_count = annual_real_returns_by_sim.len();
    if sim_count == 0 {
        return vec![];
    }

    let min_length = annual_real_returns_by_sim
        .iter()
        .map(|series| series.len().max(1))
        .min()
        .unwrap_or(1);
    let early_years = 1.max(10.min(min_length));

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
            if depleted_flags[idx] || final_balances[idx] <= 0.0 {
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
    growth_factors: &[Vec<f64>],
    monthly_income_flow: &[f64],
    monthly_spending_flow: &[f64],
    lump_sum_by_month: &[f64],
    current_savings: f64,
    sample_count: usize,
    months: u32,
    strategy: &WithdrawalStrategy,
    retire_month: usize,
) -> f64 {
    let mut ruin_count = 0;

    for sim in 0..sample_count {
        let mut balance = current_savings;
        let mut ruined = false;
        // Re-run the withdrawal strategy against the stored growth path so dynamic
        // spending in the ruin surface stays consistent with the main simulation.
        //
        // Note: the flows passed in here have nominal items deflated by the *expected*
        // inflation index, not the realized one. The stored growth factors bake inflation
        // into a single number, so per-path realized inflation cannot be recovered during
        // a replay. Documented as part of the ruin-surface approximation (README §7).
        let mut runner = WithdrawalRunner::new(strategy, retire_month);

        for month in 0..months as usize {
            let effective_spending =
                runner.monthly_spending(month, balance, monthly_spending_flow[month]);
            balance += monthly_income_flow[month] - effective_spending + lump_sum_by_month[month];
            balance *= growth_factors[sim][month];
            if balance <= 0.0 {
                balance = 0.0;
                ruined = true;
            }
        }

        if ruined || balance <= 0.0 {
            ruin_count += 1;
        }
    }

    (ruin_count as f64) / (sample_count.max(1) as f64)
}

#[allow(clippy::too_many_arguments)]
pub fn build_ruin_surface(
    input: &RetirementInput,
    spending_periods: &[SpendingPeriod],
    income_sources: &[IncomeSource],
    lump_sum_events: &[LumpSumEvent],
    growth_factors: &[Vec<f64>],
    months: u32,
    sim_count: usize,
    strategy: &WithdrawalStrategy,
) -> RuinSurface {
    let spending_multipliers = vec![0.8, 0.9, 1.0, 1.1, 1.2];

    let offsets = vec![-6.0, -3.0, 0.0, 3.0, 6.0];
    let mut retirement_ages: Vec<usize> = offsets
        .iter()
        .map(|&offset| {
            let age = input.retirement_age + offset;
            (input.simulate_until_age - 1.0)
                .min((input.current_age + 1.0).max(age))
                .round() as usize
        })
        .collect();

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

                    let cell_retire_month = (((ret_age as f64 - input.current_age) * 12.0)
                        .round()
                        .max(0.0) as usize)
                        .min(months as usize);

                    replay_ruin_probability(
                        growth_factors,
                        &arrays.monthly_income_flow,
                        &arrays.monthly_spending_flow,
                        &arrays.lump_sum_by_month,
                        input.current_savings,
                        sampled_scenarios,
                        months,
                        strategy,
                        cell_retire_month,
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
/// "Stopping contributions" is modelled as net-zero cash flow from that age until
/// retirement — you still cover your spending from work (the coast/barista case), but you
/// neither add to nor draw from the portfolio, which simply compounds. Retirement itself
/// is unchanged.
///
/// Uses the same replay trick as the ruin surface: the stored per-path growth factors are
/// re-run against a modified cash-flow schedule, so this costs a handful of replays rather
/// than fresh simulations. It inherits the same caveat — the growth factors carry a tax
/// factor computed on the *original* balance path, which is scale-invariant but not
/// invariant to a changed contribution pattern.
///
/// Returns `None` when the idea does not apply: when the user is not a net saver before
/// retirement (there are no contributions to stop), or when the target is unreachable even
/// by contributing right up to retirement.
#[allow(clippy::too_many_arguments)]
pub fn find_coast_age(
    input: &RetirementInput,
    spending_periods: &[SpendingPeriod],
    income_sources: &[IncomeSource],
    lump_sum_events: &[LumpSumEvent],
    growth_factors: &[Vec<f64>],
    months: u32,
    sample_count: usize,
    strategy: &WithdrawalStrategy,
    retire_month: usize,
    target_success_probability: f64,
) -> Option<f64> {
    if retire_month == 0 || sample_count == 0 || growth_factors.is_empty() {
        return None;
    }

    let base = build_cashflow_arrays(
        input,
        spending_periods,
        income_sources,
        lump_sum_events,
        months,
    );

    // Only meaningful while the user is actually adding to the portfolio. If they are a
    // net drawer pre-retirement, "stopping contributions" would *help*, which inverts the
    // monotonicity the search relies on and is not what Coast FIRE means anyway.
    let pre_retirement_net: f64 = (0..retire_month)
        .map(|m| base.monthly_income_flow[m] - base.monthly_spending_flow[m])
        .sum();
    if pre_retirement_net <= 0.0 {
        return None;
    }

    // Success as a function of the coast month is monotone non-decreasing: contributing
    // for longer can only leave every path with at least as much money, since all growth
    // factors are positive. That makes a binary search safe.
    let success_at = |coast_month: usize| -> f64 {
        let mut income = base.monthly_income_flow.clone();
        let mut spending = base.monthly_spending_flow.clone();
        for m in coast_month..retire_month {
            income[m] = 0.0;
            spending[m] = 0.0;
        }
        1.0 - replay_ruin_probability(
            growth_factors,
            &income,
            &spending,
            &base.lump_sum_by_month,
            input.current_savings,
            sample_count,
            months,
            strategy,
            retire_month,
        )
    };

    // Contributing all the way to retirement is the best case; if even that misses the
    // target there is no coast age to report.
    if success_at(retire_month) < target_success_probability {
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
// (never depleted AND ending balance > 0), so the P95 FI target and the success rate
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
