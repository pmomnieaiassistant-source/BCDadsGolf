// Talking to Anthropic. Kept apart from the rest so every request shape can be tested with a fake network.
//
// Ways to ask, from most to least helpful. A request can carry server tools that Anthropic runs on its side:
//  - an advisor: a cheap, fast "executor" model (Haiku) does the work and may consult a stronger "advisor" model (Opus)
//    once, mid-way, for strategic direction;
//  - web search: the executor may search the web (brainstorm uses this for inspiration).
// Either way the executor decides whether to use them, so the answer tool cannot be forced. If a request with server tools
// fails for any reason, the same question is asked again with fewer of them, and finally the plain way (one model, the answer
// tool forced where the model allows it). So an advisor or a search can never break the assistant.
import { ADVISOR_GUIDE } from './logic.ts';

export type CallOpts = {
  advisorGuide?: string;   // brainstorm uses its own advisor instructions
  maxTokens?: number;
  webSearch?: boolean;     // let the model search the web
  webGuide?: string;       // instructions about how to use the search (added only when search is on)
  maxSearches?: number;
};

export const ADVISOR_TOOL_TYPE = 'advisor_20260301';
export const ADVISOR_BETA = 'advisor-tool-2026-03-01';
export const WEB_SEARCH_TYPE = 'web_search_20250305'; // the basic variant, which every current model accepts
// Models that accept a forced tool choice. Every other model (Sonnet 5.5, Opus 5.5, ...) rejects it with a 400.
export const FORCED_TOOL_OK = new Set(['claude-haiku-5-5']);
export const LIMITS_CLAUDE = { advisorMs: 40_000, webMs: 55_000, plainMs: 30_000, maxTurns: 3, maxSearches: 3 };

export type ClaudeResult = {
  input: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  advisor: string | null;        // the advisor model asked for this run, if any
  advisorCalls: number;          // how many times the executor actually consulted it
  advisorErrors: string[];       // error codes from consultations that failed (e.g. max_uses_exceeded)
  advisorModelSeen: string | null; // the model Anthropic reports actually ran as advisor (usage.iterations), the proof it was Opus
  advisorText: string | null;    // the advice itself, only when the advisor returns plain text (Opus 4.8 does; Opus 5.5 is encrypted). For the self-test only: never logged.
  advisorInputTokens: number;    // what the advisor read and wrote, billed at the advisor's rates (0 when not consulted)
  advisorOutputTokens: number;
  webRequested: boolean;
  webSearches: number;           // how many searches actually ran
  webErrors: string[];           // error codes from searches that failed
  fellBack: boolean;             // an attempt with more tools failed and a simpler one answered
  fallbackReason: string | null; // why the first attempt failed
  degraded: string[];            // what the answering attempt went without: 'advisor' and/or 'web_search'
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

type Rung = { advisor: string | null; web: boolean };
type Core = Pick<ClaudeResult, 'input' | 'inputTokens' | 'outputTokens' | 'advisorCalls' | 'advisorErrors' | 'advisorModelSeen' | 'advisorText' | 'advisorInputTokens' | 'advisorOutputTokens' | 'webSearches' | 'webErrors'>;

export function makeClaude(cfg: ClaudeConfig) {
  const defaultMax = cfg.maxTokens ?? 3200; // room for a long spec plus the answered Q&As; a reply cut off mid-way would be unusable

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

  async function plain(model: string, system: string, user: string, tool: Json, opts: CallOpts): Promise<Core> {
    const forced = FORCED_TOOL_OK.has(model);
    const out = await post({
      model, max_tokens: opts.maxTokens ?? defaultMax, system,
      messages: [{ role: 'user', content: user }],
      tools: [tool],
      ...(forced ? { tool_choice: { type: 'tool', name: tool.name } } : {}),
    }, {}, LIMITS_CLAUDE.plainMs);
    const block = answerOf(out, tool.name);
    if (!block) throw new Error('no tool call');
    return { input: block.input, inputTokens: out.usage?.input_tokens ?? null, outputTokens: out.usage?.output_tokens ?? null, advisorCalls: 0, advisorErrors: [], advisorModelSeen: null, advisorText: null, advisorInputTokens: 0, advisorOutputTokens: 0, webSearches: 0, webErrors: [] };
  }

  // A request with server tools (advisor and/or web search). The server may pause a long turn: carry on until the answer tool is called.
  async function withServerTools(model: string, rung: Rung, system: string, user: string, tool: Json, opts: CallOpts): Promise<Core> {
    const serverTools: Json[] = [];
    if (rung.web) serverTools.push({ type: WEB_SEARCH_TYPE, name: 'web_search', max_uses: opts.maxSearches ?? LIMITS_CLAUDE.maxSearches });
    if (rung.advisor) serverTools.push({ type: ADVISOR_TOOL_TYPE, name: 'advisor', model: rung.advisor, max_uses: 1 });
    const sys = [system, rung.web ? opts.webGuide : '', rung.advisor ? (opts.advisorGuide ?? ADVISOR_GUIDE) : ''].filter(Boolean).join('\n\n');
    const messages: Json[] = [{ role: 'user', content: user }];
    let inTok = 0, outTok = 0, advisorCalls = 0, webSearches = 0, advIn = 0, advOut = 0;
    let advModel: string | null = null;
    const advTexts: string[] = [];
    const advisorErrors: string[] = [], webErrors: string[] = [];
    for (let turn = 0; turn < LIMITS_CLAUDE.maxTurns; turn++) {
      const out = await post({
        model, max_tokens: opts.maxTokens ?? defaultMax, system: sys, messages,
        tools: [tool, ...serverTools],
        // no tool_choice: forcing the answer tool would stop the model from ever using the advisor or searching
      }, rung.advisor ? { 'anthropic-beta': ADVISOR_BETA } : {}, rung.web ? LIMITS_CLAUDE.webMs : LIMITS_CLAUDE.advisorMs);
      inTok += out.usage?.input_tokens ?? 0;
      outTok += out.usage?.output_tokens ?? 0;
      // The advisor's own work is reported separately: usage.iterations has an entry of type advisor_message naming the model that ran.
      for (const it of out.usage?.iterations || []) {
        if (it?.type !== 'advisor_message') continue;
        advModel = printable(it.model, 60) || advModel;
        advIn += Number(it.input_tokens) || 0; advOut += Number(it.output_tokens) || 0;
      }
      for (const b of out.content || []) {
        if (b?.type === 'advisor_tool_result') {
          advisorCalls++;
          if (b.content?.type === 'advisor_tool_result_error') advisorErrors.push(printable(b.content.error_code, 40));
          else if (b.content?.type === 'advisor_result' && typeof b.content.text === 'string') advTexts.push(b.content.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 2000));
        } else if (b?.type === 'web_search_tool_result') {
          webSearches++;
          if (b.content && !Array.isArray(b.content) && b.content.type === 'web_search_tool_result_error') webErrors.push(printable(b.content.error_code, 40));
        }
      }
      const block = answerOf(out, tool.name);
      if (block) return { input: block.input, inputTokens: inTok, outputTokens: outTok, advisorCalls, advisorErrors, advisorModelSeen: advModel, advisorText: advTexts.length ? advTexts.join('\n---\n') : null, advisorInputTokens: advIn, advisorOutputTokens: advOut, webSearches, webErrors };
      if (out.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: out.content }); continue; } // the server paused a long turn: carry on
      throw new Error('no tool call');
    }
    throw new Error('too many turns');
  }

  // modelOverride / advisorOverride are for the self-test only. advisorOverride: undefined = the live setting, null = no advisor.
  return async function callClaude(system: string, user: string, tool: unknown, modelOverride?: string, advisorOverride?: string | null, opts: CallOpts = {}): Promise<ClaudeResult> {
    const model = modelOverride || cfg.model;
    const advisor = advisorOverride === undefined ? cfg.advisor : advisorOverride;
    const web = !!opts.webSearch;
    const t = tool as Json;
    // Most helpful first; every later rung drops something. The last one is always the plain way.
    const rungs: Rung[] = [];
    if (advisor || web) rungs.push({ advisor, web });
    if (advisor && web) rungs.push({ advisor, web: false });
    rungs.push({ advisor: null, web: false });

    let firstReason: string | null = null;
    for (let i = 0; i < rungs.length; i++) {
      const r = rungs[i], last = i === rungs.length - 1;
      try {
        const core = r.advisor || r.web ? await withServerTools(model, r, system, user, t, opts) : await plain(model, system, user, t, opts);
        const degraded = [...(advisor && !r.advisor ? ['advisor'] : []), ...(web && !r.web ? ['web_search'] : [])];
        return { ...core, advisor, webRequested: web, fellBack: i > 0, fallbackReason: firstReason, degraded };
      } catch (e) {
        if (last) throw e; // the plain way failed too: nothing left to try
        firstReason = firstReason ?? reasonOf(e);
      }
    }
    throw new Error('unreachable');
  };
}
