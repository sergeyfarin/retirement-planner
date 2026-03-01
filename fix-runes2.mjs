import fs from 'fs';

const file = 'src/lib/RetirementPlanner.svelte';
let content = fs.readFileSync(file, 'utf8');

// The $effect(() => if { ... } is invalid JS. Needs to be $effect(() => { if { ... } });
content = content.replace(/\$effect\(\(\) => (if\s*\(.*?\)\s*\{[\s\S]*?\n\s*\})\);/gm, '$effect(() => { $1 });');

fs.writeFileSync(file, content);
console.log('Fixed syntax error!');
