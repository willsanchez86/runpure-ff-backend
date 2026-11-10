#!/usr/bin/env node
// Fails a pull request unless its "Implements:" list names planning files that exist on
// runpure-ff-planning main, including at least one PRD or spec, and every named ADR has
// an "Implementation started" line.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const planning = process.argv[2] ?? 'planning';
const body = process.env.PR_BODY ?? '';
const section = body.split(/^Implements:\s*$/m)[1] ?? '';
const paths = [...section.matchAll(/^\s*-\s*(\S+\.md)\s*$/gm)].map((m) => m[1]).filter((p) => !p.includes('<'));
const problems = [];

if (!paths.some((p) => /^(prds|specs)\//.test(p))) problems.push('Implements: must name at least one prds/ or specs/ file.');
for (const p of paths) {
  const full = join(planning, p);
  if (!existsSync(full)) { problems.push(`${p} is not on runpure-ff-planning main.`); continue; }
  if (/^design\/decisions\/ADR-\d{4}-/.test(p) &&
      !/^(\*\*Implementation started:\*\*|\|\s*Implementation started\s*\|)/m.test(readFileSync(full, 'utf8'))) {
    problems.push(`${p} has no "Implementation started" line; add it in the planning repo first.`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Planning references OK: ${paths.join(', ')}`);
