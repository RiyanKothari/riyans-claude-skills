'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readDemand } = require('./demand.cjs');
const { cases } = require('./demand-bench.json');

test('the benchmark is balanced and every case is labelled', () => {
  const h = cases.filter(([l]) => l === 'H').length;
  const l = cases.filter(([l]) => l === 'L').length;
  assert.strictEqual(h + l, cases.length);
  assert.ok(h >= 70 && l >= 70, `${h} heavy, ${l} light`);
});

test('no heavy request is ever read as light: that is the one error that costs quality', () => {
  const wrong = cases.filter(([l, p]) => l === 'H' && readDemand(p).level === 'light').map(([, p]) => p);
  assert.deepStrictEqual(wrong, []);
});

test('nearly every light request is read as light, so Sonnet is actually used', () => {
  const light = cases.filter(([l]) => l === 'L');
  const caught = light.filter(([, p]) => readDemand(p).level === 'light').length;
  assert.ok(caught / light.length >= 0.9, `${caught}/${light.length}`);
});

test('a go-ahead is never light: its size is whatever came before it', () => {
  for (const p of ['yes', 'ok', 'go ahead', 'do it', 'continue', 'start building the backend', 'push it, then start working on the rest']) {
    assert.notStrictEqual(readDemand(p).level, 'light', p);
  }
});

test('a question about the whole project is not a small question', () => {
  assert.notStrictEqual(readDemand('are we making use of the skills across the codebase').level, 'light');
  assert.strictEqual(readDemand('what does this function return').level, 'light');
});

test('every answer says why', () => {
  for (const p of ['', 'thanks', 'build an app', 'the other one too']) {
    const d = readDemand(p);
    assert.ok(['light', 'heavy', 'unclear'].includes(d.level));
    assert.ok(d.why.length > 0, p);
  }
});
