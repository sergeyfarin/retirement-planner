import type { CurrencyCode } from './calculations';

/**
 * UI-layer types shared between `RetirementPlanner.svelte` and its child components.
 *
 * These live here rather than inside the parent's `<script>` block for one practical
 * reason: a type declared inside a Svelte component cannot be imported by another
 * component, which is what pushed the child props to `any` and let the whole props
 * contract go unchecked.
 */
export type CurrencyOption = {
	code: CurrencyCode;
	locale: string;
	symbol: string;
	buttonLabel: string;
	flagAsset?: string;
};
