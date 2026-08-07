<script lang="ts">
	import { m } from '../paraglide/messages';
	import { currentLocale, LOCALE_NAMES, locales, type Locale } from '../i18n.svelte';

	let { onSelect }: { onSelect: (locale: Locale) => void } = $props();

	const current = $derived(currentLocale());
</script>

<div class="language-switch" role="group" aria-label={m.language_switch_aria()}>
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
	.language-switch {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.2rem;
	}

	:global(.retirement-planner) .language-switch .lang-btn {
		min-width: 1.9rem;
		margin: 0;
		padding: 0.16rem 0.3rem;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-xs);
		background: var(--surface-card);
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
