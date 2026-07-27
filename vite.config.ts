import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { resolve } from 'path';

import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
	plugins: [sveltekit(), wasm(), topLevelAwait()],
	build: {
		target: 'esnext'
	},
	worker: {
		format: 'es',
		plugins: () => [wasm(), topLevelAwait()]
	},
	server: {
		fs: {
			allow: ['.', resolve(__dirname, 'rust-engine/pkg')]
		}
	},
	optimizeDeps: {
		exclude: ['rust-engine']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					/**
					 * These are Monte Carlo runs, not unit tests: several take 1.5-5s of real
					 * compute on their own. Vitest's 5s default left no headroom, so whenever the
					 * browser project's headless Chromium saturated the cores alongside them, a
					 * different arbitrary handful timed out each run — the suite failed on nothing
					 * but scheduling. Run in isolation the same tests pass 112/112.
					 */
					testTimeout: 30_000,
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
