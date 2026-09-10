#!/usr/bin/env node
'use strict';

const path = require('path');
const { MemoryStore } = require('./store.cjs');

const DB = process.env.SMART_MEMORY_PATH
  || path.join(process.cwd(), '.claude', 'memory', 'records.jsonl');

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new MemoryStore({ path: DB }).load();

  if (cmd === 'add') {
    const pinned = rest.includes('--pin');
    const kind = flag(rest, 'kind', 'note');
    const text = rest.filter((a, i) =>
      !a.startsWith('--') && rest[i - 1] !== '--kind').join(' ');
    const rec = store.add({ text, kind, pinned });
    store.save();
    console.log(`stored ${rec.id} (${rec.tokens} tok)${pinned ? ' [pinned]' : ''}`);
    return;
  }

  if (cmd === 'recall') {
    const budget = Number(flag(rest, 'budget', '600'));
    const query = rest.filter((a, i) =>
      !a.startsWith('--') && rest[i - 1] !== '--budget').join(' ');
    const r = store.recall(query, { budgetTokens: budget });
    store.save();
    console.log(`${r.records.length}/${r.totalCandidates} matches, ${r.tokensUsed}/${budget} tokens\n`);
    for (const rec of r.records) console.log(`- [${rec.kind}] ${rec.text}`);
    return;
  }

  // Core records are injected into every session, so a stale one keeps being
  // wrong forever. Correcting them has to be possible.
  if (cmd === 'forget') {
    const needle = rest.filter((a) => !a.startsWith('--')).join(' ').toLowerCase();
    if (!needle) { console.log('forget needs a substring to match'); return; }
    const before = store.all().length;
    const doomed = store.all().filter((r) => r.text.toLowerCase().includes(needle));
    if (!doomed.length) { console.log('no match'); return; }
    if (!rest.includes('--yes')) {
      console.log(`would forget ${doomed.length} record(s):`);
      for (const r of doomed) console.log(`  [${r.kind}] ${r.text.slice(0, 90)}`);
      console.log('re-run with --yes to confirm');
      return;
    }
    store.records = store.all().filter((r) => !r.text.toLowerCase().includes(needle));
    store.save();
    console.log(`forgot ${before - store.all().length} record(s)`);
    return;
  }

  // Scrubs records written before redaction existed at write time.
  if (cmd === 'scrub') {
    const { containsSecret, redactSecrets } = require('./store.cjs');
    let n = 0;
    for (const rec of store.all()) {
      if (!containsSecret(rec.text)) continue;
      rec.text = redactSecrets(rec.text);
      rec.tokens = Math.ceil(rec.text.length / 4);
      n++;
    }
    if (n) store.save();
    console.log(n ? `redacted ${n} record(s)` : 'no secrets found');
    return;
  }

  if (cmd === 'stats') {
    console.log(JSON.stringify(store.stats(), null, 2));
    return;
  }

  if (cmd === 'prune') {
    const n = store.prune();
    store.save();
    console.log(`pruned ${n} record(s); ${store.all().length} remain`);
    return;
  }

  console.log('Usage: cli.cjs <add|recall|forget|stats|prune> [...]');
  console.log('  add "text" [--pin] [--kind k]');
  console.log('  recall "query" [--budget N]');
  console.log('  forget "substring" [--yes]   (dry-run without --yes)');
}

main();
