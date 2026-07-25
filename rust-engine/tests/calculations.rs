//! RNG, percentile and clamp primitives.

use rust_engine::calculations::{clamp, percentile, summarize, RandomSource};

#[test]
fn seeded_stream_is_deterministic_and_in_unit_range() {
    let mut a = RandomSource::new(Some(42.0));
    let mut b = RandomSource::new(Some(42.0));
    for _ in 0..2000 {
        let value = a.random();
        assert_eq!(value, b.random());
        assert!((0.0..1.0).contains(&value), "value out of range: {value}");
    }
}

#[test]
fn different_seeds_produce_different_streams() {
    let mut a = RandomSource::new(Some(1.0));
    let mut b = RandomSource::new(Some(2.0));
    let first: Vec<f64> = (0..20).map(|_| a.random()).collect();
    let second: Vec<f64> = (0..20).map(|_| b.random()).collect();
    assert_ne!(first, second);
}

#[test]
fn seed_is_truncated_to_u32_like_javascript() {
    // The seed is rounded then wrapped to 32 bits, so these collide by construction.
    let mut a = RandomSource::new(Some(7.0));
    let mut b = RandomSource::new(Some(7.4));
    assert_eq!(a.random(), b.random());

    let mut c = RandomSource::new(Some(1.0));
    let mut d = RandomSource::new(Some(1.0 + 4294967296.0));
    assert_eq!(c.random(), d.random());
}

#[test]
fn normal_draws_match_requested_moments() {
    let mut rng = RandomSource::new(Some(99.0));
    let n = 200_000;
    let samples: Vec<f64> = (0..n).map(|_| rng.normal(0.5, 2.0)).collect();
    let mean = samples.iter().sum::<f64>() / n as f64;
    let variance = samples.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64;
    assert!((mean - 0.5).abs() < 0.02, "mean drifted: {mean}");
    assert!((variance.sqrt() - 2.0).abs() < 0.03, "std drifted: {}", variance.sqrt());
}

#[test]
fn normal_with_non_positive_std_returns_the_mean_without_consuming_randomness() {
    let mut rng = RandomSource::new(Some(5.0));
    assert_eq!(rng.normal(1.25, 0.0), 1.25);
    assert_eq!(rng.normal(1.25, -3.0), 1.25);

    // The degenerate branch must not advance the stream.
    let mut reference = RandomSource::new(Some(5.0));
    assert_eq!(rng.random(), reference.random());
}

#[test]
fn box_muller_spare_is_used_on_the_following_call() {
    // Two normals cost exactly two uniforms: the second comes from the cached spare.
    let mut rng = RandomSource::new(Some(77.0));
    let _ = rng.normal(0.0, 1.0);
    let _ = rng.normal(0.0, 1.0);
    let after_two_normals = rng.random();

    let mut reference = RandomSource::new(Some(77.0));
    let _ = reference.random();
    let _ = reference.random();
    assert_eq!(after_two_normals, reference.random());
}

#[test]
fn percentile_handles_empty_and_boundary_inputs() {
    assert_eq!(percentile(&[], 0.5), 0.0);
    assert_eq!(percentile(&[7.0], 0.0), 7.0);
    assert_eq!(percentile(&[7.0], 1.0), 7.0);

    let data = [0.0, 10.0, 20.0, 30.0];
    assert_eq!(percentile(&data, -1.0), 0.0);
    assert_eq!(percentile(&data, 2.0), 30.0);
    assert_eq!(percentile(&data, 0.0), 0.0);
    assert_eq!(percentile(&data, 1.0), 30.0);
}

#[test]
fn percentile_interpolates_linearly_between_neighbours() {
    let data = [0.0, 10.0, 20.0, 30.0];
    // index = p * (len - 1) = 1.5 → halfway between 10 and 20.
    assert_eq!(percentile(&data, 0.5), 15.0);
    // index = 0.9 → 90% of the way from 0 to 10.
    assert!((percentile(&data, 0.3) - 9.0).abs() < 1e-12);
}

#[test]
fn summarize_sorts_before_taking_percentiles() {
    let unsorted: Vec<f64> = (0..=10).rev().map(|v| v as f64).collect();
    let series = summarize(&unsorted);
    assert_eq!(series.p10, 1.0);
    assert_eq!(series.p50, 5.0);
    assert_eq!(series.p90, 9.0);
    assert!(series.p10 <= series.p25 && series.p25 <= series.p50);
    assert!(series.p50 <= series.p75 && series.p75 <= series.p90);
}

#[test]
fn summarize_of_a_single_value_is_flat() {
    let series = summarize(&[4.0]);
    assert_eq!((series.p10, series.p50, series.p90), (4.0, 4.0, 4.0));
}

#[test]
fn clamp_bounds_both_sides_and_passes_interior_values_through() {
    assert_eq!(clamp(-5.0, 0.0, 1.0), 0.0);
    assert_eq!(clamp(5.0, 0.0, 1.0), 1.0);
    assert_eq!(clamp(0.4, 0.0, 1.0), 0.4);
    // NaN fails both comparisons and falls through unchanged.
    assert!(clamp(f64::NAN, 0.0, 1.0).is_nan());
}
