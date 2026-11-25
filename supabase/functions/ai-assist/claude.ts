// Talking to Anthropic. Kept apart from the rest so every request shape can be tested with a fake network.
//
// Two ways to ask:
//  - with an advisor: a cheap, fast "executor" model (Haiku) does the work and may consult a stronger "advisor" model (Opus)
//    once, mid-way, for strategic direction. Anthropic runs the advisor on its side (a server tool). The executor decides
//    whether to consult, so the tool choice cannot be forced to the answer tool.
//  - plain: one model, the answer tool forced where the model allows it (otherwise "auto" and the instruction to call it).
// If the advisor way fails for any reason, the same question is asked the plain way, so the advisor can never break the assistant.
import { ADVISOR_GUIDE } from './logic.ts';

export type CallOpts = { advisorGuide?: string; maxTokens?: number }; // brainstorm uses its own guide and a smaller cap

export const ADVISOR_TOOL_TYPE = 'advisor_20260301';
export const ADVISOR_BETA = 'advisor-tool-2026-03-01';
// Models that accept a forced tool choice. Every other model (Sonnet 5.5, Opus 5.5, ...) rejects it with a 400.
export const FORCED_TOOL_OK = new Set(['claude-haiku-5-5']);
export const LIMITS_CLAUDE = { advisorMs: 40_000, plainMs: 30_000, maxTurns: 3 };

export type ClaudeResult = {
  input: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  advisor: string | null;        // the advisor model asked for this run, if any
  advisorCalls: number;          // how many times the executor actually consulted it
  advisorErrors: string[];       // error codes from consultations that failed (e.g. max_uses_exceeded)
  fellBack: boolean;             // the advisor way failed and the plain way answered
  fallbackReason: string | null;
};

// deno-lint-ignore no-explicit-any
type Json = any;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<Json> }>;
export type ClaudeConfig = { apiKey: () => string; model: string; advisor: string | null; fetchFn: FetchLike; maxTokens?: number };

const printable = (s: unknown, n: number): string => String(s ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, n);
export const reasonOf = (e: unknown): string => {
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return printable(e instanceof Error ? e.message : e, 220);
};

export function makeClaude(cfg: ClaudeConfig) {
  const maxTokens = cfg.maxTokens ?? 3200; // room for a long spec plus the answered Q&As; a reply cut off mid-way would be unusable

  async function post(body: Json, extra: Record<string, string>, ms: number): Promise<Json> {
    const key = cfg.apiKey();
    if (!key) throw new Error('missing key');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await cfg.fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', ...extra },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // The kind of problem Anthropic reports and what it objected to: enough to fix it, never the key.
        let kind = '', detail = '';
        try { const e = await res.json(); kind = String(e?.error?.type ?? '').replace(/[^a-z_]/g, '').slice(0, 40); detail = printable(e?.error?.message, 160); } catch (_) { /* no body */ }
        throw new Error('claude ' + res.status + (kind ? ' ' + kind : '') + (detail ? ': ' + detail : ''));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const answerOf = (out: Json, toolName: string): Json => (out?.content || []).find((b: Json) => b?.type === 'tool_use' && b.name === toolName);

  async function plain(model: string, system: string, user: string, tool: Json, opts: CallOpts): Promise<Omit<ClaudeResult, 'advisor' | 'fellBack' | 'fallbackReason'>> {
    const forced = FORCED_TOOL_OK.has(model);
    const out = await post({
      model, max_tokens: opts.maxTokens ?? maxTokens, system,
      messages: [{ role: 'user', content: user }],
      tools: [tool],
      ...(forced ? { tool_choice: { type: 'tool', name: tool.name } } : {}),
    }, {}, LIMITS_CLAUDE.plainMs);
    const block = answerOf(out, tool.name);
    if (!block) throw new Error('no tool call');
    return { input: block.input, inputTokens: out.usage?.input_tokens ?? null, outputTokens: out.usage?.output_tokens ?? null, advisorCalls: 0, advisorErrors: [] };
  }

  async function withAdvisor(model: string, advisor: string, system: string, user: string, tool: Json, opts: CallOpts): Promise<Omit<ClaudeResult, 'advisor' | 'fellBack' | 'fallbackReason'>> {
    const messages: Json[] = [{ role: 'user', content: user }];
    let inTok = 0, outTok = 0, advisorCalls = 0;
    const advisorErrors: string[] = [];
    for (let turn = 0; turn < LIMITS_CLAUDE.maxTurns; turn++) {
      const out = await post({
        model, max_tokens: opts.maxTokens ?? maxTokens,
        system: `${system}\n\n${opts.advisorGuide ?? ADVISOR_GUIDE}`,
        messages,
        tools: [tool, { type: ADVISOR_TOOL_TYPE, name: 'advisor', model: advisor, max_uses: 1 }],
        // no tool_choice: forcing the answer tool would stop the model from ever consulting the advisor
      }, { 'anthropic-beta': ADVISOR_BETA }, LIMITS_CLAUDE.advisorMs);
      inTok += out.usage?.input_tokens ?? 0;
      outTok += out.usage?.output_tokens ?? 0;
      for (const b of out.content || []) {
        if (b?.type !== 'advisor_tool_result') continue;
        advisorCalls++;
        if (b.content?.type === 'advisor_tool_result_error') advisorErrors.push(printable(b.content.error_code, 40));
      }
      const block = answerOf(out, tool.name);
      if (block) return { input: block.input, inputTokens: inTok, outputTokens: outTok, advisorCalls, advisorErrors };
      if (out.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: out.content }); continue; } // the server paused a long turn: carry on
      throw new Error('no tool call');
    }
    throw new Error('too many turns');
  }

  // modelOverride / advisorOverride are for the self-test only. advisorOverride: undefined = the live setting, null = no advisor.
  return async function callClaude(system: string, user: string, tool: unknown, modelOverride?: string, advisorOverride?: string | null, opts: CallOpts = {}): Promise<ClaudeResult> {
    const model = modelOverride || cfg.model;
    const advisor = advisorOverride === undefined ? cfg.advisor : advisorOverride;
    const t = tool as Json;
    if (!advisor) return { ...(await plain(model, system, user, t, opts)), advisor: null, fellBack: false, fallbackReason: null };
    try {
      return { ...(await withAdvisor(model, advisor, system, user, t, opts)), advisor, fellBack: false, fallbackReason: null };
    } catch (e) {
      const reason = reasonOf(e);
      return { ...(await plain(model, system, user, t, opts)), advisor, fellBack: true, fallbackReason: reason };
    }
  };
}
