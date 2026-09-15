'use strict';

/**
 * Does Claude act on the router? Advice nobody follows is worth nothing: the old
 * advisory line was attached to 9 real turns and acted on in none.
 *
 * A turn is "routed" when a hook wrote a router line into it, and "followed" when
 * that same turn called the Agent tool on the model the line named.
 */

const fs = require('fs');
const { isHumanPrompt } = require('./transcript.cjs');
const { modelFamily } = require('../model-router/index.cjs');

// The directive format and the older advisory one it replaced.
const NOTE = /\[router\] (?:(?:delegate|escalate) -> (haiku|sonnet|opus)|(?:trivial|simple|moderate|complex) \(conf[^)]*\)\. Mechanical subtasks -> Agent tool model:"(\w+)")/;

const TYPE_MODEL = { 'rc-haiku': 'haiku', 'rc-sonnet': 'sonnet', 'rc-opus': 'opus' };

function agentModel(input) {
  if (input.model) return modelFamily(input.model) || String(input.model);
  return TYPE_MODEL[input.subagent_type] || '(inherit)';
}

// Hook output lands as an attachment (or a meta user record in older versions).
// Tool output that merely prints router text — a grep of the hook — is not a decision.
function isHookRecord(o) {
  return o.type === 'attachment' || (o.type === 'user' && o.isMeta === true);
}

/** @param {string[]} files */
function followThrough(files) {
  const out = { transcripts: files.length, prompts: 0, routed: 0, followed: 0, agentCalls: 0, byModel: {}, followedPct: 0 };

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    /** @type {{target: string|null, followed: boolean}|null} */
    let turn = null;
    const close = () => {
      if (!turn || !turn.target) return;
      out.routed++;
      if (turn.followed) out.followed++;
    };

    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o) continue;
      if (isHumanPrompt(o)) {
        close();
        out.prompts++;
        turn = { target: null, followed: false };
        continue;
      }
      if (!turn) continue;

      if (o.type !== 'assistant') {
        if (!turn.target && isHookRecord(o) && line.includes('[router]')) {
          const m = line.replace(/\\"/g, '"').match(NOTE);
          if (m) turn.target = m[1] || m[2];
        }
        continue;
      }

      const blocks = o.message && Array.isArray(o.message.content) ? o.message.content : [];
      for (const b of blocks) {
        if (!b || b.type !== 'tool_use' || (b.name !== 'Agent' && b.name !== 'Task')) continue;
        out.agentCalls++;
        const model = agentModel(b.input || {});
        out.byModel[model] = (out.byModel[model] || 0) + 1;
        if (turn.target && model === turn.target) turn.followed = true;
      }
    }
    close();
  }

  out.followedPct = out.routed ? Number(((out.followed / out.routed) * 100).toFixed(1)) : 0;
  return out;
}

function formatFollowThrough(r) {
  const models = Object.entries(r.byModel).map(([m, n]) => `${m} ${n}`).join(', ') || 'none';
  return [
    '-- delegation follow-through (does Claude act on the router?) --',
    `routed turns:   ${r.routed}   followed: ${r.followed} (${r.followedPct}%)`,
    `subagent calls: ${r.agentCalls}   by model: ${models}`,
  ].join('\n');
}

module.exports = { followThrough, formatFollowThrough, agentModel };
