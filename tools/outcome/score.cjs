'use strict';

// Midpoints of the bands classify() produces, so an observed tier can be
// blended with a predicted score on the same scale.
const TIER_SCORE = { trivial: 0, simple: 2, moderate: 5, complex: 9 };
const TIERS = ['trivial', 'simple', 'moderate', 'complex'];

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CMD_TOOLS = new Set(['Bash', 'PowerShell']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

function emptyObservation() {
  return { edits: 0, commands: 0, reads: 0, files: [], distinctFiles: 0 };
}

function classifyTool(name) {
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (CMD_TOOLS.has(name)) return 'command';
  if (READ_TOOLS.has(name)) return 'read';
  return 'other';
}

/**
 * What the task actually turned out to be, judged only by what was done.
 * Deliberately coarse: the signal is noisy, so four buckets is all it can
 * honestly support.
 */
function actualTier(obs) {
  const files = obs.distinctFiles ?? (obs.files ? obs.files.length : 0);
  const edits = obs.edits || 0;
  const commands = obs.commands || 0;
  const reads = obs.reads || 0;
  const effort = edits + commands;

  if (files === 0 && effort <= 2) return 'trivial';
  if (files <= 1 && edits <= 2 && effort <= 5) return 'simple';
  if (files <= 3 && effort <= 14 && reads <= 12) return 'moderate';
  return 'complex';
}

function actualScore(obs) {
  return TIER_SCORE[actualTier(obs)];
}

function tierIndex(tier) {
  return TIERS.indexOf(tier);
}

/** Negative means the prediction was cheaper than reality — the costly error. */
function tierDelta(predicted, actual) {
  return tierIndex(predicted) - tierIndex(actual);
}

module.exports = {
  actualTier,
  actualScore,
  tierDelta,
  tierIndex,
  classifyTool,
  emptyObservation,
  TIER_SCORE,
  TIERS,
  EDIT_TOOLS,
  CMD_TOOLS,
  READ_TOOLS,
};
