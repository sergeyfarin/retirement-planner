export type ResultTone = 'neutral' | 'good' | 'warn' | 'caution' | 'bad';

/**
 * A key rather than a sentence: this module has no locale, and the card that renders
 * the verdict does. Keep the four keys in step with `verdict_*` in `messages/`.
 */
export type LifetimeVerdictKey = 'on-track' | 'needs-adjustment' | 'at-risk' | 'unlikely-to-last';

export type LifetimeVerdict = {
	key: LifetimeVerdictKey;
	tone: ResultTone;
	nearBoundary: number | null;
};

const LIFETIME_BOUNDARIES = [0.5, 0.75] as const;

/** 95% Wilson score interval for a simulated success proportion. */
export function probabilityInterval(probability: number, sampleSize: number): [number, number] {
	if (!(sampleSize > 0)) return [probability, probability];
	const p = Math.min(1, Math.max(0, probability));
	const z = 1.96;
	const zSquaredOverN = (z * z) / sampleSize;
	const centre = (p + zSquaredOverN / 2) / (1 + zSquaredOverN);
	const halfWidth =
		(z * Math.sqrt((p * (1 - p) + zSquaredOverN / 4) / sampleSize)) / (1 + zSquaredOverN);
	return [Math.max(0, centre - halfWidth), Math.min(1, centre + halfWidth)];
}

/**
 * Keep Monte Carlo noise from presenting a hard colour verdict when the plausible result
 * straddles any rating boundary. The displayed percentage remains the point estimate.
 */
export function lifetimeVerdict(
	probability: number,
	sampleSize: number,
	target = 0.95
): LifetimeVerdict {
	const key: LifetimeVerdictKey =
		probability >= target
			? 'on-track'
			: probability >= 0.75
				? 'needs-adjustment'
				: probability >= 0.5
					? 'at-risk'
					: 'unlikely-to-last';
	const tone =
		probability >= target
			? 'good'
			: probability >= 0.75
				? 'warn'
				: probability >= 0.5
					? 'caution'
					: 'bad';
	const [low, high] = probabilityInterval(probability, sampleSize);
	const nearBoundary = [target, ...LIFETIME_BOUNDARIES].find(
		(boundary) => low <= boundary && high >= boundary
	);

	return {
		key,
		tone: nearBoundary == null ? tone : 'neutral',
		nearBoundary: nearBoundary ?? null
	};
}
