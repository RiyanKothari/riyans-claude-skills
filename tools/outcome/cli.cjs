#!/usr/bin/env node
'use strict';

const path = require('path');
const { MemoryStore } = require('../memory/store.cjs');
const { backtest, collectTurns, formatReport } = require('./backtest.cjs');
const { actualTier } = require('./score.cjs');

const { projectDataDir } = require('../paths.cjs');

const DB = process.env.SMART_MEMORY_PATH
  || path.join(projectDataDir(), 'records.jsonl');

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'backtest') {
    const turns = collectTurns();
    if (!turns.length) {
      console.log('no transcripts found');
      return;
    }
    const result = backtest(turns);
    console.log(formatReport(result));

    if (rest.includes('--rows')) {
      console.log('\nper-turn:');
      for (const r of result.rows) {
        const mark = r.delta < 0 ? 'UNDER' : r.delta > 0 ? 'over ' : '  ok ';
        console.log(
          `  ${mark} ${r.predicted.padEnd(9)}->${r.actual.padEnd(9)} ` +
          `(${r.files}f ${r.edits}e ${r.commands}c)  ${r.prompt}`,
        );
      }
    }
    return;
  }

  // Turn real history into the neighbour corpus the router learns from.
  if (cmd === 'seed') {
    const turns = collectTurns();
    const store = new MemoryStore({ path: DB }).load();
    let added = 0;
    for (const t of turns) {
      if (t.prompt.length < 12) continue;
      const tier = actualTier(t);
      store.add({
        kind: 'outcome',
        text: t.prompt.slice(0, 300),
        tags: ['outcome', tier, `files:${t.distinctFiles}`, `edits:${t.edits}`],
      });
      added++;
    }
    store.save();
    console.log(`seeded ${added} outcome record(s); store now ${store.all().length}`);
    return;
  }

  console.log('Usage: cli.cjs <backtest [--rows] | seed>');
}

main();
