<script lang="ts">
	import { m } from '../paraglide/messages';
	import { currentLocale, LOCALE_NAMES, locales, type Locale } from '../i18n.svelte';

	let { onSelect }: { onSelect: (locale: Locale) => void } = $props();

	const current = $derived(currentLocale());
</script>

<!--
	The label is visible rather than an `aria-label`, so `aria-labelledby` points at it:
	naming the group twice would have a screen reader announce "Language" and then read
	the same word again as its first child.
-->
<div class="language-switch" role="group" aria-labelledby="language-switch-label">
	<span class="eyebrow language-switch-label" id="language-switch-label">{m.language_label()}</span>
	{#each locales as code (code)}
		<button
			type="button"
			class="lang-btn"
			class:active={code === current}
			lang={code}
			title={LOCALE_NAMES[code]}
			aria-label={LOCALE_NAMES[code]}
			aria-pressed={code === current}
			onclick={() => onSelect(code)}
		>
			{code.toUpperCase()}
		</button>
	{/each}
</div>

<style>
	/*
	 * One bordered control rather than a loose row of chips. The border is what separates
	 * the switcher from the project links beneath it, which are plain text — the corner
	 * previously held two rows of equally weighted buttons and read as a toolbar.
	 */
	.language-switch {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.2rem;
		padding: 0.22rem 0.3rem;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-md);
		background: var(--surface-card);
	}

	/* `.eyebrow` carries the size, weight and casing; only the spacing is local. */
	.language-switch-label {
		margin-right: 0.1rem;
		padding-left: 0.12rem;
		white-space: nowrap;
	}

	:global(.retirement-planner) .language-switch .lang-btn {
		min-width: 1.9rem;
		margin: 0;
		padding: 0.16rem 0.3rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-xs);
		background: var(--surface-sunken);
		box-shadow: none;
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		font-weight: 700;
		letter-spacing: 0.03em;
		line-height: 1.2;
		color: var(--ink-soft);
	}

	:global(.retirement-planner) .language-switch .lang-btn:hover:not(:disabled) {
		transform: none;
		filter: none;
		border-color: var(--accent-soft);
		background: var(--accent-wash);
		box-shadow: none;
		color: var(--accent-deep);
	}

	:global(.retirement-planner) .language-switch .lang-btn.active {
		border-color: var(--accent-deep);
		background: linear-gradient(135deg, var(--accent), var(--accent-bright));
		color: var(--surface);
	}
</style>
