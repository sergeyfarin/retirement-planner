import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const base = process.env.VITEST === 'true' ? '' : '/retirement';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Use the static adapter for a single-page frontend-only app.
		// Provide a fallback to support client-side routing in SPA mode.
		adapter: adapter({ fallback: 'index.html' }),
		paths: {
			base,
			relative: false
		}
	}
};

export default config;
