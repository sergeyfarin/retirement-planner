import test from 'node:test';
import assert from 'node:assert/strict';

import {
	politisWhiteBlockLength,
	selectMHat,
	theoreticalAr1CircularBlockLength
} from './analyze-block-length.mjs';

test('m_hat uses the corrected pwsd run convention', () => {
	const insignificant = 0.05;
	const significant = 0.5;

	assert.equal(selectMHat(Array(8).fill(insignificant), 0.1, 5), 1);
	assert.equal(selectMHat([significant, significant, ...Array(5).fill(insignificant)], 0.1, 5), 2);
});

test('m_hat fallback uses the largest significant lag rather than MMax', () => {
	assert.equal(selectMHat([0.2, 0.01, 0.3, 0.01], 0.1, 3), 3);
	assert.equal(selectMHat([0.01, 0.02, 0.03], 0.1, 4), 1);
});

test('corrected circular-bootstrap constant reproduces published AR(1) optima', () => {
	// Patton, Politis & White (2009), corrected Table 1.
	const fixtures = [
		[200, 0.7, 13.12],
		[800, 0.7, 20.83],
		[200, 0.1, 2.31],
		[800, 0.1, 3.66],
		[200, -0.4, 6.48]
	];
	for (const [n, phi, expected] of fixtures) {
		assert.ok(Math.abs(theoreticalAr1CircularBlockLength(n, phi) - expected) < 0.01);
	}
});

test('end-to-end selector matches a hand-calculated covariance fixture', () => {
	// Mean 0, R(0)=2/3 and R(1)=-1/6. With M=2, the flat-top window keeps only
	// lags -1, 0, 1, giving G=-1/3 and g(0)=1/3. Therefore b_CB=cuberoot(9).
	const result = politisWhiteBlockLength([-1, 0, 1, -1, 0, 1], {
		KN: 1,
		MMax: 2,
		BMax: 10,
		c: 10
	});
	assert.equal(result.mHat, 1);
	assert.ok(Math.abs(result.bCB - Math.cbrt(9)) < 1e-12);
	assert.ok(Math.abs(result.bSB - Math.cbrt(6)) < 1e-12);
});

test('selector rejects degenerate inputs instead of returning NaN', () => {
	assert.throws(() => politisWhiteBlockLength([]), /at least three/);
	assert.throws(() => politisWhiteBlockLength([1, 1, 1]), /positive variance/);
	assert.throws(() => politisWhiteBlockLength([1, Number.NaN, 2]), /finite observations/);
});
