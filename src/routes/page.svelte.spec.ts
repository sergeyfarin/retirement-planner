import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

describe('/+page.svelte', () => {
	it('should render the planner heading', async () => {
		render(Page);

		const heading = page.getByRole('heading', {
			level: 2,
			name: 'FIRE Retirement Plan Stress Test'
		});
		await expect.element(heading).toBeInTheDocument();
	});
});
