#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

function loadRouter() {
  const candidates = [
    path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'tools', 'model-router', 'index.cjs'),
    path.join(__dirname, '..', '..', 'tools', 'model-router', 'index.cjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  return null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const router = loadRouter();
  if (!router) process.exit(0);

  // A UTF-8 BOM from the calling shell makes JSON.parse throw; strip it before
  // deciding the payload is not JSON.
  const raw = readStdin().replace(/^﻿/, '').trim();
  let prompt = '';
  try {
    prompt = JSON.parse(raw).prompt || '';
  } catch {
    prompt = raw;
  }
  if (!prompt.trim()) process.exit(0);

  const r = router.recommend(prompt);

  // Silence is the default. Emitting context on every turn would cost more
  // tokens than the routing saves, so only speak when there is a real saving.
  if (!r.delegate || r.savedPct < 50) process.exit(0);

  process.stdout.write(
    `[model-router] ${r.tier} task (conf ${r.confidence}). ` +
    `Delegate mechanical steps to a '${r.agentModel}' subagent via the Agent tool ` +
    `(model: "${r.agentModel}") — est. ${r.savedPct}% cheaper than opus. ` +
    `Handle it inline instead if it needs repo context.\n`
  );
  process.exit(0);
}

main();
