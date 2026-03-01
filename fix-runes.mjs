import fs from 'fs';

const file = 'src/lib/RetirementPlanner.svelte';
let content = fs.readFileSync(file, 'utf8');

// Replace standard reactive assignments: $: a = b; -> const a = $derived(b);
content = content.replace(
  /^(\s*)\$:\s*([a-zA-Z0-9_]+)\s*=\s*(.*?);$/gm,
  (match, p1, p2, p3) => {
    // special handling for IIFEs
    if (p3.startsWith('(() => {')) {
       return `${p1}const ${p2} = $derived(${p3});`;
    }
    return `${p1}const ${p2} = $derived(${p3});`;
  }
);

// Replace reactive object definitions: $: a = { ... };
// Not well handled by single line regex, so doing it via multi-line
content = content.replace(
  /^(\s*)\$:\s*([a-zA-Z0-9_]+)\s*=\s*(\{[\s\S]*?\n\1\});/gm,
  (match, p1, p2, p3) => `${p1}const ${p2} = $derived(${p3});`
);

// Replace reactive blocks and function calls: $: { ... } or $: if (...) { ... }
content = content.replace(
  /^(\s*)\$:\s*((\{[\s\S]*?\n\1\})|(if\s*\([\s\S]*?\n\1\}))/gm,
  (match, p1, p2) => `${p1}$effect(() => ${p2});`
);

// The `fmtCurrency = (n: number) => ` case
content = content.replace(
  /^(\s*)\$:\s*(fmt[a-zA-Z0-9_]+)\s*=\s*(\(.*?\)\s*=>\s*.*?;)$/gm,
  (match, p1, p2, p3) => `${p1}const ${p2} = $derived(${p3});`
);


fs.writeFileSync(file, content);
console.log('Fixed runes!');
