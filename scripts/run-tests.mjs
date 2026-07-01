// scripts/run-tests.mjs
//
// Test runner for the repo's hand-rolled, self-executing tsx test scripts.
// Replaces the old `find lib -name '*.test.ts' -exec npx tsx {} ';'`, which
//   (1) never descended into packages/, so 22 domain/pose tests never ran, and
//   (2) swallowed child exit codes — `find -exec` does not propagate them, so
//       `npm test` exited 0 even when a test called process.exit(1).
//
// This runner discovers *.test.ts under lib/ and packages/, runs each in its
// own child process (the tests call process.exit(1), so they can't share one
// process), runs ALL of them even after a failure, and exits 1 if any failed.
//
// Usage:
//   npm test              # run everything
//   npm test -- scoring   # run only files whose path contains "scoring"

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['lib', 'packages'];
const filter = process.argv[2]; // optional path substring filter

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else if (e.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r))
  .filter((f) => !filter || f.includes(filter))
  .sort();

const tsx = join('node_modules', '.bin', 'tsx');
const failed = [];

for (const f of files) {
  const r = spawnSync(tsx, [f], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ${files.length} files, ${files.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('  FAILED:\n' + failed.map((f) => `   - ${f}`).join('\n'));
}
console.log('═'.repeat(55));
process.exit(failed.length ? 1 : 0);
