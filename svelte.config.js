import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// Use the static adapter for a single-page frontend-only app.
		// Provide a fallback to support client-side routing in SPA mode.
		adapter: adapter({ fallback: 'index.html' }),
		paths: {
      		base: '/retirement',
      		relative: false
    	}
	}
};

export default config;
