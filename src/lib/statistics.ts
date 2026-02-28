export type PercentileSeries<T = number> = {
  p10: T;
  p25: T;
  p50: T;
  p75: T;
  p90: T;
};

type UniformRandom = () => number;

function createMulberry32(seed: number): UniformRandom {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RandomSource {
  private readonly nextUniform: UniformRandom;
  private spareNormal: number | null = null;

  constructor(seed?: number) {
    this.nextUniform = Number.isInteger(seed) ? createMulberry32(seed as number) : Math.random;
  }

  random(): number {
    return this.nextUniform();
  }

  normal(mean: number, std: number): number {
    if (std <= 0) return mean;
    if (this.spareNormal !== null) {
      const cached = this.spareNormal;
      this.spareNormal = null;
      return mean + std * cached;
    }

    let u = 0;
    let v = 0;
    while (u === 0) u = this.random();
    while (v === 0) v = this.random();

    const mag = Math.sqrt(-2.0 * Math.log(u));
    const z0 = mag * Math.cos(2.0 * Math.PI * v);
    const z1 = mag * Math.sin(2.0 * Math.PI * v);
    this.spareNormal = z1;
    return mean + std * z0;
  }
}

const defaultRandomSource = new RandomSource();

export function createRandomSource(seed?: number): RandomSource {
  return new RandomSource(seed);
}

export function randomNormal(mean: number, std: number): number {
  return defaultRandomSource.normal(mean, std);
}

/**
 * Percentile for a pre-sorted array using linear interpolation between ranks.
 */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function summarize(values: number[]): PercentileSeries<number> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9)
  };
}
