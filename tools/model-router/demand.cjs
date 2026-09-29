'use strict';

/**
 * What a request demands of the model, read from the request alone: 'light' (Sonnet
 * does it as well as Opus), 'heavy' (needs Opus), or 'unclear'. Built from what kinds
 * of work are hard in general — reasoning, proof, design, diagnosis of an unknown
 * cause, anything built from several parts, anything whose scope is open — not from
 * one user's history, and checked against demand-bench.json, a set of requests
 * written and labelled before these rules.
 *
 * Asymmetric on purpose: heavy wins over light, and anything neither clearly light nor
 * clearly heavy is 'unclear', which never moves a session down. Running Opus work on
 * Sonnet costs quality; running Sonnet work on Opus only costs money.
 */

const rx = (words) => new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');

/** Thinking a weaker model does measurably worse: proof, derivation, judgement. */
const REASONING = rx([
  'why', 'prove', 'proof', 'derive', 'derivation', 'deduce', 'theorem', 'recurrence',
  'trade-?offs?', 'pros and cons', 'compare', 'comparison', 'evaluate', 'assess', 'weigh',
  'recommend (?:one|which|an? (?:approach|architecture|stack|design))', 'which (?:is|would be) better',
  'should (?:we|i)', 'best (?:way|approach|practice|architecture|design)', 'how (?:should|would) (?:we|you|i)',
  'in depth', 'in-depth', 'rigorous(?:ly)?', 'thorough(?:ly)?', 'carefully', 'think (?:hard|carefully|deeply)', 'ultrathink',
  'strategy', 'strategic', 'analy[sz]e', 'analysis', 'investigate', 'research', 'figure out',
  'root cause', 'diagnose', 'threat model', 'optimi[sz]e', 'scale (?:this|it|to)',
  'review', 'audit', 'security', 'vulnerabilit(?:y|ies)', 'pentest',
]);

/** Designing or building something of several parts. */
const BUILD_VERB = rx([
  'build', 'implement', 'create', 'develop', 'design', 'architect', 'set ?up', 'make', 'write',
  'add', 'integrate', 'automate', 'port', 'migrate', 'rewrite', 'refactor', 'redesign',
  'convert', 'plan', 'improve', 'increase', 'reduce', 'fix',
]);
const SYSTEM_NOUN = rx([
  'apps?', 'application', 'system', 'service', 'services', 'platform', 'pipeline', 'engine',
  'api', 'backend', 'frontend', 'full.?stack', 'website', 'site', 'game', 'bot', 'compiler',
  'parser', 'interpreter', 'library', 'framework', 'sdk', 'cli', 'tool', 'plugin', 'extension',
  'integration', 'feature', 'module', 'architecture', 'infrastructure', 'infra', 'schema',
  'database', 'model', 'algorithm', 'protocol', 'consensus', 'auth(?:entication)?', 'oauth',
  'payments?', 'checkout', 'onboarding', 'dashboard', 'ci/?cd', 'deploy(?:s|ment)?', 'kubernetes',
  'monitoring', 'alerting', 'test suite', 'tests', 'coverage', 'performance', 'bill', 'costs?',
  'plan', 'strategy', 'essay', 'thesis', 'paper', 'report', 'book', 'novel', 'outline', 'course',
  'design doc', 'proposal', 'spec', 'rfc', 'business', 'startup', 'go to market',
  'recommendation', 'real.?time', 'collaboration', 'dark mode', 'flow', 'editor', 'monorepo',
  'bugs', 'everything',
]);

/** A job whose size is open: every, all, whole, end to end, from scratch. */
const OPEN_SCOPE = rx([
  'all', 'every', 'entire', 'whole', 'across', 'throughout', 'end.to.end', 'from scratch',
  'full', 'complete', 'comprehensive', 'production', 'million', 'at scale', 'under load',
  '\\d{3,}.?words?',
]);

/** Something is broken and the cause is not given. */
const FAILURE = rx([
  'broken', 'breaks', 'crash(?:es|ing)?', 'fail(?:s|ing|ed)?', 'failure', 'hangs?', 'freez(?:es|ing)',
  'drops?', 'leaks?', 'deadlock', 'race condition', 'intermittent(?:ly)?', 'flaky', 'slow', 'regression',
  "doesn'?t work", 'not working', 'stopped working', 'overfitting', 'exception', 'stack ?trace', 'traceback',
  'undefined', 'null pointer', 'segfault', 'errors?',
]);
const REPAIR = rx(['fix', 'debug', 'solve', 'resolve', 'figure out', 'why', 'repair', 'find']);

/** Go-ahead and open-ended orders: their size is whatever came before, so never light. */
const CONTINUATION = /^(?:yes|yeah|yep|ok(?:ay)?|sure|go(?: ahead| on)?|do it|proceed|continue|keep going|carry on|try again|again|next|resume|please do|sounds good|lgtm|ship it|run it|deploy)\b/i;
/** Opening new work of unstated size, anywhere in the request. */
const OPEN_WORK = /\b(?:start (?:building|working|coding|implementing|on)|work on (?:other|everything|the rest)|build everything|everything new)\b/i;
const VAGUE_ORDER = rx(['make it better', 'improve it', 'fix (?:it|this|everything|all)', 'finish it', 'complete it', 'keep going', 'continue', 'proceed']);

/** Requests Sonnet does as well as Opus. */
const QUESTION = /^(?:what|what's|whats|where|when|which|who|whose|how (?:do|does|can|to|many|much|long|old)|is|are|does|do|did|can|could|define|explain (?:what|this|the|how)|meaning of)\b/i;
const TRANSFORM = rx([
  'translate', 'summari[sz]e', 'rephrase', 'reword', 'paraphrase', 'proofread', 'grammar', 'spell ?check',
  'shorten', 'capitali[sz]e', 'sort (?:this|these|the) list', 'alphabeti[sz]e', 'bold', 'italic',
  'convert (?:this|these|\\d)', 'turn (?:this|these) (?:notes|text|list)', 'bullet points',
]);
const SMALL_WRITE = rx([
  'haiku', 'poem', 'tweet', 'caption', 'alt text', 'slogan', 'tagline', 'thank you note', 'note',
  'short reply', 'reply', 'email', 'message', 'commit message', 'docstring', 'regex', 'one-?liner',
  'sql query', 'query', 'function that', 'snippet', 'name ideas', 'ideas for', 'synonym', 'title',
]);
const SMALL_EDIT = rx([
  'typo', 'rename', 'bump', 'version', 'comment', 'color', 'colour', 'text', 'string', 'label',
  'title', 'footer', 'header text', 'link', 'import', 'console\\.log', 'gitignore', 'format', 'prettier',
  'lint', 'whitespace', 'indent',
]);
const EDIT_VERB = rx(['fix', 'rename', 'bump', 'add', 'change', 'update', 'remove', 'delete', 'make', 'format']);
const COMMAND = /^(?:run (?:the )?(?:tests?|lint|build|typecheck)|commit|push|pull|install|start (?:the )?(?:dev )?server|stop|restart|show me|list|find where|find the|open|check|git)\b/i;
const SMALLTALK = /^(?:thanks|thank you|thx|nice|great|cool|got it|perfect|awesome|good)\b/i;

const words = (t) => t.split(/\s+/).filter(Boolean).length;

/**
 * @param {string} prompt
 * @returns {{level: 'light'|'heavy'|'unclear', kind: string, why: string}}
 */
function readDemand(prompt) {
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();
  const n = words(text);
  const r = (level, kind, why) => ({ level, kind, why });
  if (!text) return r('unclear', 'unclear', 'empty');

  // Heavy. Thinking first — reasoning and diagnosis are what Opus is kept for — so a
  // long "why does…" is still read as reasoning, not just as long.
  if (/```|\bat .+:\d+\)?$|Traceback|Exception in/m.test(text)) return r('heavy', 'diagnosis', 'it asks to diagnose a failure');
  if (REASONING.test(lower)) return r('heavy', 'reasoning', 'it asks for reasoning, analysis or judgement');
  if (FAILURE.test(lower) && REPAIR.test(lower)) return r('heavy', 'diagnosis', 'it asks to diagnose a failure');
  if (VAGUE_ORDER.test(lower) || CONTINUATION.test(lower) || OPEN_WORK.test(lower)) {
    return r('heavy', 'continuation', 'it continues or opens work of unknown size');
  }
  const listItems = (text.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
  if (listItems >= 2) return r('heavy', 'build', 'it asks for several things');
  if (n > 35) return r('heavy', 'build', 'it is a long, detailed request');
  if (BUILD_VERB.test(lower) && SYSTEM_NOUN.test(lower) && !SMALL_EDIT.test(lower)) {
    return r('heavy', 'build', 'it builds or changes something of several parts');
  }
  if (OPEN_SCOPE.test(lower) && BUILD_VERB.test(lower)) return r('heavy', 'build', 'its scope is open');

  // Light: short, and a known small kind of work.
  if (n <= 25) {
    if (SMALLTALK.test(lower)) return r('light', 'small', 'it is a reply, not a task');
    if (TRANSFORM.test(lower)) return r('light', 'small', 'it reworks text it was given');
    if (COMMAND.test(lower)) return r('light', 'small', 'it runs or shows something');
    if (EDIT_VERB.test(lower) && SMALL_EDIT.test(lower)) return r('light', 'small', 'it is a small edit');
    if (/\b(?:write|draft|give me|compose|suggest)\b/i.test(lower) && SMALL_WRITE.test(lower)) {
      return r('light', 'small', 'it asks for a short piece of writing or code');
    }
    // A question about the whole project is an audit in disguise, not a lookup.
    const wholeScope = OPEN_SCOPE.test(lower) || /\b(?:skills|codebase|project|repo|everything)\b/i.test(lower);
    if (!wholeScope && (QUESTION.test(lower) || /\?$/.test(text) || /^(?:convert|recommend) /i.test(lower))) {
      return r('light', 'small', 'it is a direct question');
    }
  }
  return r('unclear', 'unclear', 'it could be small or large');
}

/** Work Opus is kept for when Sonnet is the default: thinking, not building. */
const THINKING = new Set(['reasoning', 'diagnosis']);

module.exports = { readDemand, THINKING };
