import { describe, expect, it } from 'vitest';
import { lifetimeVerdict, probabilityInterval } from './resultPresentation';

describe('lifetime verdict presentation', () => {
	it('keeps decisive results in their normal rating tones', () => {
		expect(lifetimeVerdict(0.97, 10_000)).toMatchObject({ tone: 'good', nearBoundary: null });
		expect(lifetimeVerdict(0.9, 10_000)).toMatchObject({ tone: 'warn', nearBoundary: null });
		expect(lifetimeVerdict(0.65, 10_000)).toMatchObject({ tone: 'caution', nearBoundary: null });
		expect(lifetimeVerdict(0.4, 10_000)).toMatchObject({ tone: 'bad', nearBoundary: null });
	});

	it.each([
		{ probability: 0.949, boundary: 0.95 },
		{ probability: 0.751, boundary: 0.75 },
		{ probability: 0.499, boundary: 0.5 }
	])('uses a neutral tone near the $boundary boundary', ({ probability, boundary }) => {
		expect(lifetimeVerdict(probability, 5_000)).toMatchObject({
			tone: 'neutral',
			nearBoundary: boundary
		});
	});

	it('honours a custom target boundary', () => {
		expect(lifetimeVerdict(0.899, 5_000, 0.9)).toMatchObject({
			tone: 'neutral',
			nearBoundary: 0.9
		});
	});

	it('returns a bounded interval at the extremes', () => {
		expect(probabilityInterval(0, 1_000)[0]).toBe(0);
		expect(probabilityInterval(1, 1_000)[1]).toBe(1);
	});
});
