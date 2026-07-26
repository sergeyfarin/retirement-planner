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
  const row = [...container.querySelectorAll('tr')].find((tr) =>
    tr.textContent?.includes(rowText)
  );
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

    await vi.waitFor(
      () => expect(fieldById(container, 'adv-seed').value).toBe('4242'),
      { timeout: 20_000 }
    );
    expect(fieldById(container, 'adv-block-length').value).toBe('9');
    expect(numericValue(fieldInRowLabelled(container, 'Tax on gains'))).toBe(22);
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
    expect(numericValue(fieldInRowLabelled(container, 'Tax on gains'))).toBe(100);
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
