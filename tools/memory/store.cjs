'use strict';

const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const K1 = 1.5;
const B = 0.75;

const DEFAULTS = {
  halfLifeDays: 30,
  useBoost: 0.25,
  maxBaseStrength: 3,
  pruneFloor: 0.15,
  pruneMinAgeDays: 14,
};

const STOPWORDS = new Set(
  ('a an the is are was were be been being to of in on at for with and or not this that it its as by ' +
    'from do does did how why what when where should would could will can if then than there here')
    .split(' '),
);

// running -> runn -> run, shipped -> shipp -> ship
function undouble(t) {
  const last = t[t.length - 1];
  if (t.length > 2 && last === t[t.length - 2] && !'aeiou'.includes(last)) {
    return t.slice(0, -1);
  }
  return t;
}

function stem(t) {
  if (t.length > 4 && t.endsWith('ing')) return undouble(t.slice(0, -3));
  if (t.length > 4 && t.endsWith('ed')) return undouble(t.slice(0, -2));
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/**
 * Records are built from raw prompts, and prompts routinely contain live
 * credentials. Redacting at write time is the only reliable point — once a
 * secret is on disk it can be committed, synced or shared before anyone looks.
 */
const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\brzp_(?:test|live)_[A-Za-z0-9]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bEAA[A-Za-z0-9_-]{20,}/g,
  /\bAQ\.[A-Za-z0-9._-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b[A-Za-z0-9+/]{40}\b(?=\s*(?:secret|key|token))/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@\S+/gi,
  /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}["']?/gi,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
];

function redactSecrets(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function containsSecret(text) {
  return redactSecrets(text) !== String(text ?? '');
}

class MemoryStore {
  constructor(opts = {}) {
    this.path = opts.path || path.join('.claude', 'memory', 'records.jsonl');
    this.cfg = { ...DEFAULTS, ...opts };
    this.lambda = Math.LN2 / this.cfg.halfLifeDays;
    /** @type {any[]} */
    this.records = [];
    /** @type {null | {df: Map<string, number>, avgdl: number}} */
    this._index = null;
    this._seq = 0;
  }

  load() {
    if (!fs.existsSync(this.path)) return this;
    const lines = fs.readFileSync(this.path, 'utf8').split('\n');
    this.records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.text === 'string') this.records.push(rec);
      } catch {
        // A torn write must not take the whole store down.
      }
    }
    this._seq = this.records.length;
    this._index = null;
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    // Underscore fields are derived caches. Persisting `_terms` both bloated
    // the file and leaked pre-redaction text that `text` no longer contained.
    const body = this.records
      .map((r) => JSON.stringify(r, (k, v) => (k.startsWith('_') ? undefined : v)))
      .join('\n');
    fs.writeFileSync(this.path, body ? `${body}\n` : '', 'utf8');
    return this;
  }

  add(input) {
    const now = input.now ?? Date.now();
    const text = redactSecrets(String(input.text ?? '').trim());
    if (!text) throw new Error('memory record needs text');

    const existing = this.records.find((r) => r.text === text);
    if (existing) {
      this._touch(existing, now);
      this._index = null;
      return existing;
    }

    const rec = {
      id: `m${++this._seq}`,
      kind: input.kind || 'note',
      text,
      tags: input.tags || [],
      pinned: Boolean(input.pinned),
      createdAt: now,
      lastUsedAt: now,
      uses: 0,
      baseStrength: 1,
      tokens: estimateTokens(text),
    };
    this.records.push(rec);
    this._index = null;
    return rec;
  }

  effectiveStrength(rec, now = Date.now()) {
    if (rec.pinned) return this.cfg.maxBaseStrength;
    const idleDays = Math.max(0, (now - rec.lastUsedAt) / DAY_MS);
    return rec.baseStrength * Math.exp(-this.lambda * idleDays);
  }

  _touch(rec, now) {
    rec.uses += 1;
    rec.lastUsedAt = now;
    rec.baseStrength = Math.min(
      this.cfg.maxBaseStrength,
      rec.baseStrength + this.cfg.useBoost,
    );
  }

  _buildIndex() {
    const df = new Map();
    let totalLen = 0;
    for (const rec of this.records) {
      rec._terms = tokenize(`${rec.text} ${(rec.tags || []).join(' ')}`);
      totalLen += rec._terms.length;
      for (const t of new Set(rec._terms)) {
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
    this._index = {
      df,
      avgdl: this.records.length ? totalLen / this.records.length : 1,
    };
  }

  score(query, now = Date.now()) {
    if (!this._index) this._buildIndex();
    const idx = this._index;
    if (!idx) return [];

    const qTerms = tokenize(query);
    const N = this.records.length;
    if (!N || !qTerms.length) return [];

    const out = [];
    for (const rec of this.records) {
      const terms = rec._terms || [];
      const dl = terms.length || 1;
      let bm25 = 0;
      for (const qt of new Set(qTerms)) {
        let tf = 0;
        for (const t of terms) if (t === qt) tf++;
        if (!tf) continue;
        const dfv = idx.df.get(qt) || 0;
        const idf = Math.log((N - dfv + 0.5) / (dfv + 0.5) + 1);
        bm25 += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / idx.avgdl)));
      }
      if (bm25 <= 0) continue;
      const strength = this.effectiveStrength(rec, now);
      out.push({ rec, bm25, strength, score: bm25 * (0.5 + strength) });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // Retrieval is bounded by a token budget, so recall can never grow the
  // prompt without limit no matter how large the store gets.
  recall(query, opts = {}) {
    const now = opts.now ?? Date.now();
    const budget = opts.budgetTokens ?? 600;
    const limit = opts.limit ?? 5;
    const touch = opts.touch !== false;

    const ranked = this.score(query, now);
    const picked = [];
    let used = 0;

    for (const hit of ranked) {
      if (picked.length >= limit) break;
      if (used + hit.rec.tokens > budget) continue;
      used += hit.rec.tokens;
      picked.push(hit);
      if (touch) this._touch(hit.rec, now);
    }

    if (touch && picked.length) this._index = null;

    return {
      records: picked.map((h) => h.rec),
      hits: picked.map((h) => ({
        id: h.rec.id,
        score: Number(h.score.toFixed(4)),
        strength: Number(h.strength.toFixed(3)),
      })),
      tokensUsed: used,
      budgetTokens: budget,
      totalCandidates: ranked.length,
    };
  }

  prune(opts = {}) {
    const now = opts.now ?? Date.now();
    const before = this.records.length;
    this.records = this.records.filter((rec) => {
      if (rec.pinned) return true;
      const ageDays = (now - rec.createdAt) / DAY_MS;
      if (ageDays < this.cfg.pruneMinAgeDays) return true;
      return this.effectiveStrength(rec, now) >= this.cfg.pruneFloor;
    });
    this._index = null;
    return before - this.records.length;
  }

  stats(now = Date.now()) {
    const strengths = this.records.map((r) => this.effectiveStrength(r, now));
    return {
      count: this.records.length,
      pinned: this.records.filter((r) => r.pinned).length,
      totalTokens: this.records.reduce((a, r) => a + r.tokens, 0),
      avgStrength: strengths.length
        ? Number((strengths.reduce((a, b) => a + b, 0) / strengths.length).toFixed(3))
        : 0,
    };
  }

  /**
   * What every new session gets, unconditionally.
   *
   * Pinned records are standing policy. Beyond those, a record that has been
   * retrieved repeatedly and reached full strength has earned permanence on
   * its own evidence — the core curates itself rather than needing a human to
   * predict in advance what will matter.
   */
  coreRecords(opts = {}) {
    const now = opts.now ?? Date.now();
    const minUses = opts.minUses ?? 5;
    const budget = opts.budgetTokens ?? Infinity;

    const eligible = this.records.filter(
      (r) => r.pinned || (r.uses >= minUses && r.baseStrength >= this.cfg.maxBaseStrength),
    );

    eligible.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return this.effectiveStrength(b, now) - this.effectiveStrength(a, now);
    });

    const kept = [];
    let used = 0;
    for (const r of eligible) {
      if (used + r.tokens > budget) continue;
      used += r.tokens;
      kept.push(r);
    }
    return kept;
  }

  all() {
    return this.records;
  }
}

module.exports = {
  MemoryStore, tokenize, estimateTokens, redactSecrets, containsSecret, DEFAULTS,
};
