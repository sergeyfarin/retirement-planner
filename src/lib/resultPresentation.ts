export type ResultTone = 'neutral' | 'good' | 'warn' | 'caution' | 'bad';

export type LifetimeVerdict = {
	label: 'On track' | 'Needs adjustment' | 'At risk' | 'Unlikely to last';
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
	const label =
		probability >= target
			? 'On track'
			: probability >= 0.75
				? 'Needs adjustment'
				: probability >= 0.5
					? 'At risk'
					: 'Unlikely to last';
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
		label,
		tone: nearBoundary == null ? tone : 'neutral',
		nearBoundary: nearBoundary ?? null
	};
}

/**
 * Retirement readiness is a money-gap question, not a second lifetime probability.
 * A median portfolio that is 1% below its target should look close, not catastrophic.
 */
export function retirementCapitalTone(margin: number): ResultTone {
	if (margin >= 0) return 'good';
	if (margin >= -0.1) return 'warn';
	if (margin >= -0.25) return 'caution';
	return 'bad';
}

export function retirementCapitalLabel(margin: number): string {
	if (margin >= 0) return 'At or above target';
	if (margin >= -0.1) return 'Close to target';
	if (margin >= -0.25) return 'Below target';
	return 'Well below target';
}
