import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { resolve } from 'path';

import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
	plugins: [
		sveltekit(),
		/**
		 * Compiles `messages/*.json` into `src/lib/paraglide` on dev and build.
		 *
		 * No `url` strategy: the app ships as a static SPA under a fixed base path, so a
		 * locale segment would need prerendered routes per language for a page that has
		 * exactly one route. The switcher writes localStorage and updates the reactive locale
		 * in place; first-time visitors get their browser's language.
		 *
		 * The `i18n:compile` script must pass the same `--strategy` list: `check` and
		 * `prepare` run the CLI without going through this plugin, and the CLI's own
		 * default (cookie/globalVariable/baseLocale) would otherwise overwrite the
		 * generated runtime with different behaviour.
		 */
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['localStorage', 'preferredLanguage', 'baseLocale']
		}),
		wasm(),
		topLevelAwait()
	],
	/**
	 * `src/lib/plotly.ts` builds Plotly from source rather than shipping a prebuilt dist, and
	 * parts of that source tree (`has-hover`, and Plotly's promise polyfill) are CommonJS
	 * modules that reference the Node-style `global`. The dist bundles were built with
	 * browserify, which shimmed it; building from source, nothing does, and the identifier
	 * reaches the browser and throws `ReferenceError: global is not defined` the moment
	 * Plotly is imported. No app code uses the name, so aliasing it is a safe fix.
	 */
	define: {
		global: 'globalThis'
	},
	build: {
		target: 'esnext'
	},
	worker: {
		format: 'es',
		plugins: () => [wasm(), topLevelAwait()]
	},
	server: {
		fs: {
			allow: ['.', resolve(import.meta.dirname, 'rust-engine/pkg')]
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
