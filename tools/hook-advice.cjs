'use strict';

/**
 * The advice the per-prompt, session-start, stop and model-switch hooks print:
 * compaction lines, cache notices, model-switch advice and the reasoning handoff.
 *
 * Moved out of learning-hook.cjs unchanged. The hook injects its own helpers, so
 * tools still resolve exactly as before (harness repo first, then the project) and
 * state files stay where they were.
 *
 * @param {{
 *   req: (rel: string) => any,
 *   readJsonFile: (p: string) => any,
 *   writeJsonFile: (p: string, v: any) => void,
 *   sessionActivity: (input: any, prompt: string) => any,
 *   AGENT_PREFIX: string, MAX_NEIGHBORS: number,
 *   paths: {COMPACT_STATE: string, SWITCH_STATE: string, SWITCH_HANDOFF: string,
 *     GUARD_STATE: string, NOTICE_STATE: string, HANDOFF: string},
 * }} env
 */
module.exports = function createAdvice(env) {
  const { req, readJsonFile, writeJsonFile, sessionActivity, AGENT_PREFIX, MAX_NEIGHBORS } = env;
  const { COMPACT_STATE, SWITCH_STATE, SWITCH_HANDOFF, GUARD_STATE, NOTICE_STATE, HANDOFF } = env.paths;

  /**
   * The compaction prompt, governed by `rcskills config compact ...`. The prompt
   * point is worked out per session from the model, where the work is and how fast
   * context is growing — SessionStart alone could never notice a session growing.
   */
  function lastAsk(activity) {
    const asks = activity && activity.handoff && activity.handoff.prompts;
    return asks && asks.length ? asks[asks.length - 1] : null;
  }

  function compactPrompt(tokens, input, activity, extra = {}) {
    const compactMod = req('compact.cjs');
    const configMod = req('config.cjs');
    if (!compactMod || !configMod || !tokens) return null;

    const result = compactMod.adviseCompact({
      tokens,
      sessionId: input.session_id || null,
      state: readJsonFile(COMPACT_STATE),
      settings: configMod.load().compact,
      model: activity ? activity.model : null,
      phase: activity ? activity.phase : null,
      rewriteUsd: extra.rewriteUsd || null,
      focus: extra.focus || lastAsk(activity),
    });
    writeJsonFile(COMPACT_STATE, result.state);
    return result.message;
  }

  /**
   * Which model the next work should run on, for Opus and Sonnet sessions. Down to
   * Sonnet after measured small work, as a line relayed at the end of the reply; up to
   * Opus before work that needs it, holding the message once so it does not run on the
   * weaker model. `session-switch.cjs` owns the rule and its backtest.
   */
  function modelSwitchAdvice(activity, input, prompt) {
    const quiet = { message: null, hold: null };
    if (!activity) return quiet;
    const switchMod = req('model-router/session-switch.cjs');
    const configMod = req('config.cjs');
    if (!switchMod || !configMod) return quiet;
    try {
      const result = switchMod.adviseSessionSwitch({
        model: activity.model,
        tokens: activity.tokens,
        cacheTtl: activity.cacheTtl,
        recent: activity.recent,
        prompt,
        sessionId: input.session_id || null,
        state: readJsonFile(SWITCH_STATE),
        settings: configMod.load().modelSwitch,
      });
      if (result.state) writeJsonFile(SWITCH_STATE, result.state);
      return { message: result.message, hold: result.hold };
    } catch {
      // Model advice is optional; never block the prompt over a failure in it.
      return quiet;
    }
  }

  function switchHandoffLine(input) {
    const mod = req('model-router/switch-handoff.cjs');
    const record = readJsonFile(SWITCH_HANDOFF);
    if (!mod || !record) return null;
    const line = mod.handoffLine(record, { sessionId: input.session_id || null });
    if (line) writeJsonFile(SWITCH_HANDOFF, { ...record, shown: true });
    return line;
  }

  function writeHandoff(guardMod, activity, sessionId) {
    const storeMod = req('memory/store.cjs');
    const redact = storeMod && storeMod.redactSecrets ? storeMod.redactSecrets : (s) => s;
    const summary = guardMod.handoffSummary(activity.handoff);
    if (summary) writeJsonFile(HANDOFF, { at: Date.now(), summary: redact(summary), sessionId });
  }

  function writeLargeSessionHandoff(input) {
    const guardMod = req('cache-guard.cjs');
    const configMod = req('config.cjs');
    const activity = sessionActivity(input, '');
    if (!guardMod || !configMod || !activity) return;
    try {
      const s = configMod.load().cacheGuard;
      const pr = guardMod.price(activity.tokens, activity.model, activity.cacheTtl);
      if (s.enabled && pr && pr.rewriteUsd - pr.freshUsd >= s.budgetUsd) {
        writeHandoff(guardMod, activity, input.session_id || null);
      }
    } catch {
      // The handoff is a convenience; never fail a stop over it.
    }
  }

  const parseLine = (l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  };

  /**
   * Cache lines Claude relays at the end of its reply: why the last turn paid to
   * re-send cached context (once per rewrite), and, in a large session, how long the
   * cache stays cheap. The reply is the channel because the desktop app does not show
   * a Stop hook's systemMessage: the user confirmed a notice sent that way never appeared.
   */
  function cacheLines(input, activity, compacting) {
    const guardMod = req('cache-guard.cjs');
    const configMod = req('config.cjs');
    const spendMod = req('outcome/spend.cjs');
    const tsMod = req('outcome/transcript.cjs');
    if (!guardMod || !configMod || !activity) return [];
    const lines = [];
    try {
      const settings = configMod.load().cacheGuard;
      const sessionId = input.session_id || null;
      const now = Date.now();
      const saved = readJsonFile(NOTICE_STATE);
      const state = saved && saved.sessionId === sessionId ? saved : null;
      // A session seen for the first time only reports rewrites from the last half hour.
      const explainedAt = state ? Number(state.explainedAt || 0) : now - 30 * 60000;

      const tPath = input.transcript_path || input.transcriptPath;
      const tail = spendMod && tsMod && tPath ? tsMod.readTailLines(tPath, 2000000) : null;
      if (tail) {
        const fresh = spendMod.classifyRewrites(tail.map(parseLine).filter(Boolean)).filter((ev) => ev.at > explainedAt);
        for (const ev of fresh.slice(-2)) {
          const line = guardMod.explainRewrite(ev, settings);
          if (line) lines.push(line);
        }
      }

      // A compaction prompt already tells the user to shrink the session.
      const notice = compacting
        ? { message: null, state }
        : guardMod.afterReplyNotice({
          tokens: activity.tokens, model: activity.model, cacheTtl: activity.cacheTtl, sessionId, state, settings,
        });
      if (notice.message) lines.push(notice.message);
      writeJsonFile(NOTICE_STATE, { ...(notice.state || {}), sessionId, explainedAt: now });
    } catch {
      // Advice is optional; never block the prompt.
    }
    return lines;
  }

  function captureSwitchHandoff(input) {
    const router = req('model-router/index.cjs');
    const mod = req('model-router/switch-handoff.cjs');
    if (!router || !mod) return;
    const from = router.modelFamily(input.from_model);
    const to = router.modelFamily(input.to_model);
    if (!from || !to || from === to) return;
    const activity = sessionActivity(input, '');
    const record = activity && mod.captureSwitch(activity.handoff, {
      sessionId: input.session_id || null, from: input.from_model, to: input.to_model,
    });
    if (record) writeJsonFile(SWITCH_HANDOFF, record);
  }

  /**
   * Holds the first message after the prompt cache expires, once, when re-caching this
   * session costs clearly more than starting fresh. Writes a handoff first, so /clear
   * loses nothing. Any failure lets the prompt through.
   */
  function coldCacheBlock(input, prompt, activity) {
    const guardMod = req('cache-guard.cjs');
    const configMod = req('config.cjs');
    if (!guardMod || !configMod || !activity) return null;
    try {
      const sessionId = input.session_id || null;
      const result = guardMod.adviseColdCache({
        prompt,
        tokens: activity.tokens,
        model: activity.model,
        lastResponseAt: activity.lastResponseAt,
        cacheTtl: activity.cacheTtl,
        sessionId,
        state: readJsonFile(GUARD_STATE),
        settings: configMod.load().cacheGuard,
      });
      if (!result.block) return null;

      writeHandoff(guardMod, activity, sessionId);
      writeJsonFile(GUARD_STATE, result.state);
      return result.block;
    } catch {
      return null;
    }
  }

  // Past turns whose prompts resemble this one, with what they actually cost.
  function findNeighbors(store, prompt, scoreMod) {
    if (!store || !scoreMod) return [];
    let ranked;
    try {
      ranked = store.score(prompt);
    } catch {
      return [];
    }
    const outcomes = ranked.filter((h) => h.rec.kind === 'outcome');
    if (!outcomes.length) return [];

    const top = outcomes.slice(0, MAX_NEIGHBORS);
    const max = top[0].score || 1;

    return top
      .map((h) => {
        const tierTag = (h.rec.tags || []).find((t) => scoreMod.TIERS.includes(t));
        if (!tierTag) return null;
        return {
          actualScore: scoreMod.TIER_SCORE[tierTag],
          similarity: Number((h.score / max).toFixed(3)),
          tier: tierTag,
        };
      })
      .filter(Boolean);
  }

  /**
   * A directive, not a hint. The advisory "Mechanical subtasks -> Agent tool" line was
   * attached to 9 real turns and acted on in none, so the line now names the exact
   * subagent and the brief it needs, and fires only on the router's measured rule.
   */
  function routerNote(r, neighbors) {
    // The cost model already demands a 15% margin against this session's real context.
    if (r.direction === 'down') {
      const ev = neighbors.length >= 2 ? `, ${neighbors.length} similar past turns` : '';
      const ctx = `${Math.round(r.contextTokens / 1000)}k`;
      return `[router] delegate -> haiku (${r.tier}, score ${r.score}${ev}; ~${r.savedPct}% cheaper than ${r.sessionModel} at ${ctx} context). ` +
        `Call the Agent tool with subagent_type "${AGENT_PREFIX}${r.agentType}" and model "haiku", passing a self-contained brief: ` +
        'the files, the exact change, and the command that verifies it. Check its result. ' +
        'Stay inline only if the brief would need this conversation\'s history.';
    }
    if (r.direction === 'up') {
      return `[router] escalate -> opus (${r.tier}; this session runs ${r.sessionModel}). ` +
        `Hand the reasoning-heavy core to the Agent tool with subagent_type "${AGENT_PREFIX}${r.agentType}" and model "opus", ` +
        'with a complete brief, and keep the mechanical parts here.';
    }
    return null;
  }

  /** At most one [next] line per reply, however many pieces of advice fired. */
  function finish(lines) {
    const nc = req('next-command.cjs');
    return nc ? nc.mergeNext(lines) : lines;
  }

  return { finish, findNeighbors, routerNote, compactPrompt, modelSwitchAdvice, switchHandoffLine, writeLargeSessionHandoff, cacheLines, captureSwitchHandoff, coldCacheBlock };
};
