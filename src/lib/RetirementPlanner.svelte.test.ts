import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import RetirementPlanner from './RetirementPlanner.svelte';
import { MAX_SHARED_SIMULATIONS, toBase64Url } from './shareState';

/**
 * Restoration wiring, end to end: a real `#s=` hash on a real mount.
 *
 * `shareState.test.ts` covers what a payload is allowed to say; this file covers that the
 * planner actually seats the validated result into the fields the user sees. The gap
 * between the two is where the original defect lived — the engine clamped `blockLength`
 * while the UI went on displaying the value from the link.
 */

const DEFAULT_BLOCK_LENGTH = '6';

function seatShareLink(payload: Record<string, unknown>): void {
	window.location.hash = `#s=${toBase64Url(JSON.stringify(payload))}`;
}

function fieldById(container: HTMLElement, id: string): HTMLInputElement {
	const element = container.querySelector<HTMLInputElement>(`#${id}`);
	if (!element) throw new Error(`no field #${id} in the rendered planner`);
	return element;
}

/** The assumptions table and the run controls use unlabelled inputs inside rows/labels. */
function fieldInRowLabelled(container: HTMLElement, rowText: string): HTMLInputElement {
	const row = [...container.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(rowText));
	const element = row?.querySelector('input');
	if (!element) throw new Error(`no input in the row for "${rowText}"`);
	return element;
}

function fieldInLabel(container: HTMLElement, labelText: string): HTMLInputElement {
	const label = [...container.querySelectorAll('label')].find((candidate) =>
		candidate.textContent?.trim().startsWith(labelText)
	);
	const element = label?.querySelector('input');
	if (!element) throw new Error(`no input in the label for "${labelText}"`);
	return element;
}

function currencyButton(container: HTMLElement, label: string): HTMLButtonElement {
	const button = [...container.querySelectorAll<HTMLButtonElement>('.currency-btn')].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!button) throw new Error(`no currency button labelled "${label}"`);
	return button;
}

/** Svelte keeps source indentation in text nodes; collapse it before matching prose. */
function squashed(element: Element | null | undefined): string {
	return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Formatted numbers carry grouping separators and percent signs; compare the number. */
function numericValue(field: HTMLInputElement): number {
	return Number(field.value.replace(/[^\d.-]/g, ''));
}

afterEach(() => {
	window.location.hash = '';
});

describe('RetirementPlanner share-link restoration', () => {
	it('restores the values a well-formed link carries', async () => {
		// The control for the clamping tests below: without this, they would also pass if
		// restoration silently did nothing at all.
		seatShareLink({
			v: 1,
			c: 'USD',
			m: 'parametric',
			t: 1,
			i: { seed: 4242, blockLength: 9, currentSavings: 815_000, taxOnGainsPercent: 0.22 }
		});

		const { container } = await render(RetirementPlanner);

		await vi.waitFor(() => expect(fieldById(container, 'adv-seed').value).toBe('4242'), {
			timeout: 20_000
		});
		expect(fieldById(container, 'adv-block-length').value).toBe('9');
		expect(numericValue(fieldInRowLabelled(container, 'Tax drag on real gains'))).toBe(22);
		// The savings field is labelled "Portfolio (<currency symbol>)".
		expect(numericValue(fieldInLabel(container, 'Portfolio'))).toBe(815_000);
	});

	it('displays the clamped block length, not the zero from the link', async () => {
		// The original defect: `blockLength: 0` reached the engine, which floored it to 1 —
		// but the field kept showing 0, so the run the user saw was not the run described
		// on screen. Both ends now agree.
		seatShareLink({ v: 1, c: 'EUR', m: 'historical', t: 0, i: { seed: 11, blockLength: 0 } });

		const { container } = await render(RetirementPlanner);

		await vi.waitFor(() => expect(fieldById(container, 'adv-seed').value).toBe('11'), {
			timeout: 20_000
		});
		expect(fieldById(container, 'adv-block-length').value).toBe('1');
	});

	it('clamps out-of-range rates and caps the simulation count from a link', async () => {
		seatShareLink({
			v: 1,
			c: 'EUR',
			m: 'historical',
			t: 0,
			i: { seed: 77, taxOnGainsPercent: 9, annualFeePercent: -3, simulations: 1e9 }
		});

		const { container } = await render(RetirementPlanner);

		await vi.waitFor(() => expect(fieldById(container, 'adv-seed').value).toBe('77'), {
			timeout: 20_000
		});
		expect(numericValue(fieldInRowLabelled(container, 'Tax drag on real gains'))).toBe(100);
		expect(numericValue(fieldInRowLabelled(container, 'Annual fees'))).toBe(0);
		// Uncapped, this link would have frozen the recipient's tab on the first run.
		expect(numericValue(fieldInLabel(container, 'Simulations'))).toBe(MAX_SHARED_SIMULATIONS);
	});

	it('mounts on its defaults when the payload is unreadable', async () => {
		// A future version's payload, and a corrupted one. Neither may throw out of mount.
		for (const hash of ['#s=eyJ2IjoyfQ', '#s=eyJ2IjoxLCJjIjoiRVVS']) {
			window.location.hash = hash;
			const { container } = await render(RetirementPlanner);
			await vi.waitFor(
				() => expect(fieldById(container, 'adv-block-length').value).toBe(DEFAULT_BLOCK_LENGTH),
				{ timeout: 20_000 }
			);
			expect(fieldById(container, 'adv-seed').value).toBe('');
		}
	});
});

describe('RetirementPlanner currency switching', () => {
	it('retranslates currency-region buttons when the language changes', async () => {
		const { container } = await render(RetirementPlanner);
		expect(fieldById(container, 'adv-seed').placeholder).toBe('auto');
		const russian = container.querySelector<HTMLButtonElement>('button[aria-label="Русский"]');
		if (!russian) throw new Error('no Russian language button');
		russian.click();

		await vi.waitFor(() => {
			expect(currencyButton(container, 'Мир ($)')).not.toBeNull();
			expect(currencyButton(container, 'США ($)')).not.toBeNull();
			expect(currencyButton(container, 'Великобр. (£)')).not.toBeNull();
			expect(currencyButton(container, 'Европа (€)')).not.toBeNull();
			expect(fieldById(container, 'adv-seed').placeholder).toBe('автоматически');
		});

		const english = container.querySelector<HTMLButtonElement>('button[aria-label="English"]');
		if (!english) throw new Error('no English language button');
		english.click();
		await vi.waitFor(() => expect(currencyButton(container, 'World ($)')).not.toBeNull());
		expect(fieldById(container, 'adv-seed').placeholder).toBe('auto');
	});

	it('retranslates a validation error that is already visible', async () => {
		seatShareLink({
			v: 1,
			c: 'EUR',
			m: 'historical',
			t: 0,
			i: { currentAge: 95, retirementAge: 95, simulateUntilAge: 90 }
		});
		const { container } = await render(RetirementPlanner);

		await vi.waitFor(
			() =>
				expect(squashed(container.querySelector('.error'))).toBe(
					'Simulation horizon must be at least 1 year beyond current age.'
				),
			{ timeout: 20_000 }
		);

		const russian = container.querySelector<HTMLButtonElement>('button[aria-label="Русский"]');
		if (!russian) throw new Error('no Russian language button');
		russian.click();
		await vi.waitFor(() =>
			expect(squashed(container.querySelector('.error'))).toBe(
				'План должен охватывать как минимум один год после текущего возраста.'
			)
		);

		const english = container.querySelector<HTMLButtonElement>('button[aria-label="English"]');
		if (!english) throw new Error('no English language button');
		english.click();
	});

	it('stays responsive after completed-result charts mount', async () => {
		const { container } = await render(RetirementPlanner);

		// The freeze only occurred after the initial simulation had mounted all visible plots.
		await vi.waitFor(
			() => expect(container.querySelectorAll('.js-plotly-plot').length).toBeGreaterThanOrEqual(3),
			{ timeout: 45_000 }
		);

		for (const label of ['World ($)', 'US ($)', 'UK (£)', 'Europe (€)']) {
			const button = currencyButton(container, label);
			button.click();
			await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'), {
				timeout: 2_000
			});
		}
	}, 60_000);
});

describe('RetirementPlanner result communication', () => {
	it('leads with one lifetime verdict and keeps advanced statistics closed', async () => {
		const { container } = await render(RetirementPlanner);

		await vi.waitFor(() => expect(container.querySelector('.verdict-card')).not.toBeNull(), {
			timeout: 40_000
		});

		// The default summary has two compact, non-overlapping questions: whether the plan
		// lasts, and where the portfolio stands at retirement.
		expect(container.querySelectorAll('.outcome-card')).toHaveLength(2);
		const verdict = container.querySelector('.verdict-card');
		expect(verdict?.querySelector('.gauge-track')).toBeNull();
		expect(verdict?.querySelector('.verdict-next')).not.toBeNull();

		expect(squashed(verdict?.querySelector('.stat-sentence'))).toMatch(
			/^\d+% — estimated probability that your money lasts through age \d+$/
		);
		expect(squashed(verdict)).not.toContain('simulated market paths');
		expect(squashed(verdict)).not.toContain('meets the 95%');

		const retirement = container.querySelector('.retirement-card');
		expect(retirement?.classList.contains('tone-neutral')).toBe(true);
		expect(retirement?.className).not.toMatch(/tone-(good|warn|caution|bad)/);
		expect(squashed(retirement)).toContain('Capital needed at retirement age');
		expect(squashed(retirement)).toContain('retirement-path replays');
		expect(squashed(retirement)).toContain('Projected balance at retirement');
		expect(squashed(retirement)).toContain('Median balance');
		expect(squashed(retirement)).not.toContain('middle 80%');
		expect(squashed(retirement)).not.toContain('Chance of hitting it');
		expect(container.querySelector('.downside-card')).toBeNull();
		expect(container.querySelector('.terminal-wealth-chart')).toBeNull();
		expect(squashed(container)).not.toContain(
			'How much does the timing of market gains and losses matter?'
		);
		expect(container.querySelector('.scope-note')).toBeNull();

		const strategyGroup = container.querySelector<HTMLElement>('.strategy-toggle-group');
		const strategyButtons = strategyGroup?.querySelectorAll<HTMLElement>('.btn-mode') ?? [];
		expect(strategyButtons).toHaveLength(3);
		expect(getComputedStyle(strategyGroup!).display).toBe('grid');
		for (const button of strategyButtons) {
			expect(button.getBoundingClientRect().width).toBeGreaterThan(
				strategyGroup!.getBoundingClientRect().width * 0.25
			);
		}

		const portfolioChart = container.querySelector('.chart-card-main');
		expect(squashed(portfolioChart?.querySelector('.phase-title'))).toMatch(
			/^Portfolio projection — inflation-adjusted \(.+\)$/
		);

		const diagnostics = container.querySelector<HTMLDetailsElement>('.diagnostics-card');
		expect(diagnostics).not.toBeNull();
		expect(diagnostics?.open).toBe(false);
		expect(diagnostics?.textContent).toContain('Sequence-of-returns exposure');
		expect(diagnostics?.textContent).toContain('Sensitivity-test coverage');

		const russian = container.querySelector<HTMLButtonElement>('button[aria-label="Русский"]');
		if (!russian) throw new Error('no Russian language button');
		russian.click();
		await vi.waitFor(() => {
			expect(diagnostics?.textContent).toContain('Вероятность достичь цели');
			expect(diagnostics?.textContent).toContain('Расчётная цель');
			expect(diagnostics?.textContent).not.toContain('Estimated chance of reaching it');
		});
		const english = container.querySelector<HTMLButtonElement>('button[aria-label="English"]');
		if (!english) throw new Error('no English language button');
		english.click();

		// Advanced statistics must precede the charts, not trail them.
		const firstChart = container.querySelector('.chart-row');
		expect(diagnostics?.compareDocumentPosition(firstChart!)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING
		);
	}, 45_000);
});
