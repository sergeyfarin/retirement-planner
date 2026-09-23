/**
 * Parse a number entered with either common decimal convention. A separator used
 * between groups of three digits is treated as a thousands separator; when both
 * separators occur, the last one is the decimal separator.
 *
 * Ambiguous values such as `1.000` intentionally follow the common financial
 * convention and mean one thousand. Enter `1` or `1.0` for a decimal value.
 */
export function parseLocalizedNumber(value: string): number | null {
	let source = String(value)
		.trim()
		.replace(/[\s\u00a0']/g, '');
	if (!source) return null;

	const sign = /^[+-]/.test(source) ? source[0] : '';
	if (sign) source = source.slice(1);
	if (!/^\d+(?:[.,]\d+)*$/.test(source)) return null;

	const dots = [...source.matchAll(/\./g)].map((match) => match.index ?? 0);
	const commas = [...source.matchAll(/,/g)].map((match) => match.index ?? 0);
	let normalized: string;

	if (dots.length && commas.length) {
		const decimalIndex = Math.max(dots.at(-1)!, commas.at(-1)!);
		const decimalSeparator = source[decimalIndex];
		const groupSeparator = decimalSeparator === '.' ? ',' : '.';
		const [integer, fraction] = source.split(decimalSeparator);
		if (!fraction || fraction.includes(decimalSeparator) || !/^\d+$/.test(fraction)) return null;
		const groups = integer.split(groupSeparator);
		if (groups.some((group, index) => !/^\d+$/.test(group) || (index > 0 && group.length !== 3))) {
			return null;
		}
		normalized = `${groups.join('')}.${fraction}`;
	} else {
		const separator = dots.length ? '.' : commas.length ? ',' : null;
		if (!separator) {
			normalized = source;
		} else {
			const parts = source.split(separator);
			if (parts.some((part) => !/^\d+$/.test(part))) return null;
			if (parts.length > 2 && !parts.slice(1).every((part) => part.length === 3)) return null;
			const looksGrouped = parts.length > 2 || (parts[1].length === 3 && parts[0] !== '0');
			normalized = looksGrouped ? parts.join('') : `${parts[0]}.${parts.slice(1).join('')}`;
		}
	}

	const parsed = Number(`${sign}${normalized}`);
	return Number.isFinite(parsed) ? parsed : null;
}
