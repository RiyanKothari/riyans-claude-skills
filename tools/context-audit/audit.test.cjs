'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { audit, formatReport, estimateTokens, LIMITS } = require('./audit.cjs');

/**
 * @param {{skills?: Record<string,string>, agents?: Record<string,string>,
 *          claudeMd?: string, mcp?: string}} [opts]
 */
function fixture(opts = {}) {
  const { skills = {}, agents = {}, claudeMd, mcp } = opts;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const dot = path.join(root, '.claude');

  for (const [name, body] of Object.entries(skills)) {
    const d = path.join(dot, 'skills', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), body);
  }
  for (const [name, body] of Object.entries(agents)) {
    const d = path.join(dot, 'agents', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'AGENT.md'), body);
  }
  fs.mkdirSync(dot, { recursive: true });
  if (claudeMd) fs.writeFileSync(path.join(root, 'CLAUDE.md'), claudeMd);
  if (mcp) fs.writeFileSync(path.join(root, '.mcp.json'), mcp);

  return { root, dir: dot, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function bigSkill(lines) {
  return `---\nname: big\ndescription: short\n---\n${'filler line here\n'.repeat(lines)}`;
}

test('prose and code are estimated differently', () => {
  const text = 'word '.repeat(100);
  assert.notStrictEqual(estimateTokens(text, false), estimateTokens(text, true));
  assert.ok(estimateTokens(text, false) > 0);
});

test('empty input costs nothing', () => {
  assert.strictEqual(estimateTokens('', false), 0);
  assert.strictEqual(estimateTokens(null, true), 0);
});

test('an oversized skill is flagged', () => {
  const f = fixture({ skills: { heavy: bigSkill(LIMITS.skillLines + 50) } });
  const r = audit({ dir: f.dir });
  assert.strictEqual(r.offenders.length, 1);
  assert.match(r.offenders[0].flags[0], /lines/);
  f.clean();
});

test('a skill within limits is not flagged', () => {
  const f = fixture({ skills: { lean: bigSkill(10) } });
  const r = audit({ dir: f.dir });
  assert.strictEqual(r.offenders.length, 0);
  assert.strictEqual(r.components.length, 1);
  f.clean();
});

test('agents are held to a tighter line limit than skills', () => {
  const between = Math.floor((LIMITS.agentLines + LIMITS.skillLines) / 2);
  const f = fixture({
    skills: { s: bigSkill(between) },
    agents: { a: bigSkill(between) },
  });
  const r = audit({ dir: f.dir });
  const names = r.offenders.map((o) => o.name);
  assert.ok(names.includes('a'), 'agent should be flagged');
  assert.ok(!names.includes('s'), 'skill of the same size should not be');
  f.clean();
});

test('a bloated frontmatter description is flagged', () => {
  const desc = 'word '.repeat(LIMITS.descriptionWords + 10).trim();
  const f = fixture({ skills: { verbose: `---\nname: v\ndescription: ${desc}\n---\nbody\n` } });
  const r = audit({ dir: f.dir });
  assert.ok(r.offenders[0].flags.some((x) => /description/.test(x)));
  f.clean();
});

test('MCP servers are counted and costed', () => {
  const f = fixture({
    mcp: JSON.stringify({ mcpServers: { a: {}, b: {}, c: {} } }),
  });
  const r = audit({ dir: f.dir });
  assert.strictEqual(r.mcp.servers.length, 3);
  assert.ok(r.mcp.totalTokens > 0);
  assert.ok(r.mcp.estimated, 'must be marked an estimate, not a measurement');
  f.clean();
});

test('too many MCP servers raises a warning', () => {
  const servers = {};
  for (let i = 0; i < LIMITS.mcpServers + 2; i++) servers[`s${i}`] = {};
  const f = fixture({ mcp: JSON.stringify({ mcpServers: servers }) });
  const r = audit({ dir: f.dir });
  assert.ok(r.warnings.some((w) => /MCP servers/.test(w)));
  f.clean();
});

test('an unreadable .mcp.json is reported, not crashed on', () => {
  const f = fixture({ mcp: '{ broken' });
  const r = audit({ dir: f.dir });
  assert.ok(r.mcp.unreadable);
  assert.strictEqual(r.mcp.servers.length, 0);
  f.clean();
});

test('an oversized CLAUDE.md warns because it is always loaded', () => {
  const f = fixture({ claudeMd: 'line\n'.repeat(LIMITS.claudeMdLines + 20) });
  const r = audit({ dir: f.dir });
  assert.ok(r.warnings.some((w) => /CLAUDE\.md/.test(w)));
  assert.ok(r.totals.claudeMdTokens > 0);
  f.clean();
});

test('always-loaded cost is separated from the on-demand pool', () => {
  const f = fixture({
    claudeMd: 'line\n'.repeat(50),
    mcp: JSON.stringify({ mcpServers: { a: {} } }),
    skills: { s: bigSkill(20) },
  });
  const r = audit({ dir: f.dir });

  assert.strictEqual(r.totals.alwaysLoaded, r.totals.claudeMdTokens + r.totals.mcpTokens);
  assert.ok(r.totals.grand > r.totals.alwaysLoaded);
  assert.ok(r.totals.componentTokens > 0);
  f.clean();
});

test('offenders are ranked by token weight', () => {
  const f = fixture({
    skills: {
      small: bigSkill(LIMITS.skillLines + 10),
      huge: bigSkill(LIMITS.skillLines + 900),
    },
  });
  const r = audit({ dir: f.dir });
  assert.strictEqual(r.offenders[0].name, 'huge');
  f.clean();
});

test('auditing an empty project reports zero rather than throwing', () => {
  const f = fixture({});
  const r = audit({ dir: f.dir });
  assert.strictEqual(r.totals.componentCount, 0);
  assert.strictEqual(r.offenders.length, 0);
  f.clean();
});

test('a missing directory is handled', () => {
  const r = audit({ dir: path.join(os.tmpdir(), `nope-${Math.random()}`) });
  assert.strictEqual(r.totals.componentCount, 0);
});

test('the report names where the leverage is', () => {
  const f = fixture({ mcp: JSON.stringify({ mcpServers: { a: {} } }) });
  const out = formatReport(audit({ dir: f.dir }));
  assert.match(out, /always loaded/);
  assert.match(out, /leverage/);
  assert.match(out, /MCP/);
  f.clean();
});
