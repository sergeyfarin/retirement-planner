use js_sys::Math;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PercentileSeries<T> {
    pub p05: T,
    pub p10: T,
    pub p25: T,
    pub p50: T,
    pub p75: T,
    pub p90: T,
}

pub struct RandomSource {
    state: Option<u32>,
    spare_normal: Option<f64>,
}

impl RandomSource {
    pub fn new(seed: Option<f64>) -> Self {
        let state = if let Some(s) = seed {
            if s.is_finite() {
                // `Math.round(seed) >>> 0` in the TS engine, which is ToUint32: reduce the
                // rounded value modulo 2^32. A plain `as i64 as u32` cast agrees for every
                // seed the UI produces but not in general — Rust's float-to-int casts
                // saturate, so a seed past i64::MAX became u32::MAX here while JS wrapped it
                // to something else entirely, and the two engines then drew different paths
                // from the same share link. `rem_euclid` is exact at these magnitudes and
                // handles negative seeds the same way ToUint32 does.
                //
                // The rounding itself also has to be JS's: `Math.round` is round-half-up
                // (`Math.round(-2.5) === -2`) where Rust's `f64::round` is round-half-away
                // (`-3.0`). They differ only on an exact half, where `s + 0.5` is exactly
                // representable, so the branch below is precise — and falling back to
                // `f64::round` elsewhere keeps the `0.49999999999999994` case that a naive
                // `(s + 0.5).floor()` would get wrong.
                let rounded = if s.fract().abs() == 0.5 {
                    (s + 0.5).floor()
                } else {
                    s.round()
                };
                Some(rounded.rem_euclid(4294967296.0) as u32)
            } else {
                None
            }
        } else {
            None
        };

        Self {
            state,
            spare_normal: None,
        }
    }

    pub fn random(&mut self) -> f64 {
        if let Some(state) = &mut self.state {
            // Mulberry32, mirroring JS Math.imul semantics exactly (wrapping 32-bit multiply).
            *state = state.wrapping_add(0x6D2B79F5);
            let js_imul1 = (*state ^ (*state >> 15)).wrapping_mul(1 | *state);
            let js_imul2 = (js_imul1 ^ (js_imul1 >> 7)).wrapping_mul(61 | js_imul1);
            let t_val = js_imul1 ^ js_imul1.wrapping_add(js_imul2);
            let final_val = t_val ^ (t_val >> 14);
            (final_val as f64) / 4294967296.0
        } else {
            Math::random()
        }
    }

    pub fn normal(&mut self, mean: f64, std: f64) -> f64 {
        if std <= 0.0 {
            return mean;
        }

        if let Some(cached) = self.spare_normal.take() {
            return mean + std * cached;
        }

        let mut u = 0.0;
        let mut v = 0.0;
        while u == 0.0 {
            u = self.random();
        }
        while v == 0.0 {
            v = self.random();
        }

        let mag = (-2.0 * u.ln()).sqrt();
        let z0 = mag * (2.0 * std::f64::consts::PI * v).cos();
        let z1 = mag * (2.0 * std::f64::consts::PI * v).sin();

        self.spare_normal = Some(z1);
        mean + std * z0
    }
}

pub fn percentile(sorted_array: &[f64], p: f64) -> f64 {
    let len = sorted_array.len();
    if len == 0 {
        return 0.0;
    }
    if p <= 0.0 {
        return sorted_array[0];
    }
    if p >= 1.0 {
        return sorted_array[len - 1];
    }

    let index = p * (len - 1) as f64;
    let lower = index.floor() as usize;
    let upper = index.ceil() as usize;
    let weight = index % 1.0;

    if lower == upper {
        return sorted_array[lower];
    }

    sorted_array[lower] * (1.0 - weight) + sorted_array[upper] * weight
}

pub fn summarize(values: &[f64]) -> PercentileSeries<f64> {
    let mut sorted = values.to_vec();
    // f64 doesn't implement Ord directly because of NaN, but our values are always finite
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    PercentileSeries {
        p05: percentile(&sorted, 0.05),
        p10: percentile(&sorted, 0.1),
        p25: percentile(&sorted, 0.25),
        p50: percentile(&sorted, 0.5),
        p75: percentile(&sorted, 0.75),
        p90: percentile(&sorted, 0.9),
    }
}

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}
