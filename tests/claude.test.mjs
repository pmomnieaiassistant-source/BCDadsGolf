// How the assistant talks to Anthropic: the plain way and the advisor way, tested with a fake network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClaude, ADVISOR_BETA, ADVISOR_TOOL_TYPE, WEB_SEARCH_TYPE, FORCED_TOOL_OK, LIMITS_CLAUDE } from '../supabase/functions/ai-assist/claude.ts';
import { ADVISOR_GUIDE, TOOL } from '../supabase/functions/ai-assist/logic.ts';

const KEY = 'sk-ant-test-secret-key-0123456789';
const ANSWER = { summary: 'S.', answered: [], open_questions: [], new_questions: [], ready: false };
const toolUse = (input = ANSWER) => ({ type: 'tool_use', id: 't1', name: 'record_analysis', input });
const reply = (content, extra = {}) => ({ ok: true, status: 200, json: async () => ({ content, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 }, ...extra }) });
const failure = (status, type, message) => ({ ok: false, status, json: async () => ({ error: { type, message } }) });
const advisorResult = (content = { type: 'advisor_redacted_result', encrypted_content: 'xyz', stop_reason: 'end_turn' }) => ({ type: 'advisor_tool_result', tool_use_id: 'a1', content });

// A fake network that plays back scripted answers and records every request.
function net(...script) {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal }); const next = script.shift(); if (!next) throw new Error('unexpected request'); return typeof next === 'function' ? next() : next; };
  return { fetchFn, calls };
}
const make = (n, o = {}) => makeClaude({ apiKey: () => KEY, model: 'claude-haiku-5-5', advisor: null, fetchFn: n.fetchFn, ...o });
const ask = (c, ...rest) => c('SYSTEM TEXT', 'USER TEXT', TOOL, ...rest);

test('plain, Haiku: the answer tool is forced, no advisor, no beta header', async () => {
  const n = net(reply([toolUse()])); const r = await ask(make(n));
  const q = n.calls[0];
  assert.equal(q.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(q.body.tool_choice, { type: 'tool', name: 'record_analysis' });
  assert.deepEqual(q.body.tools, [TOOL]); assert.equal(q.body.system, 'SYSTEM TEXT'); assert.equal(q.body.model, 'claude-haiku-5-5');
  assert.equal('anthropic-beta' in q.headers, false); assert.equal(q.headers['x-api-key'], KEY);
  assert.deepEqual([r.advisor, r.advisorCalls, r.fellBack, r.inputTokens, r.outputTokens], [null, 0, false, 100, 50]);
});

test('plain, Sonnet or Opus: no forced tool choice (they reject it with a 400)', async () => {
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    const n = net(reply([toolUse()])); await ask(make(n), model);
    assert.equal('tool_choice' in n.calls[0].body, false, model); assert.equal(n.calls[0].body.model, model);
  }
  assert.deepEqual([...FORCED_TOOL_OK], ['claude-haiku-5-5']);
});

test('advisor way: Haiku does the work, Opus is offered as a server tool, nothing forces the answer tool', async () => {
  const n = net(reply([{ type: 'server_tool_use', name: 'advisor' }, advisorResult(), toolUse()]));
  const r = await ask(make(n, { advisor: 'claude-opus-5-5' }));
  const q = n.calls[0];
  assert.equal(q.body.model, 'claude-haiku-5-5');
  assert.equal(q.headers['anthropic-beta'], ADVISOR_BETA);
  assert.deepEqual(q.body.tools, [TOOL, { type: ADVISOR_TOOL_TYPE, name: 'advisor', model: 'claude-opus-5-5', max_uses: 1 }]);
  assert.equal('tool_choice' in q.body, false, 'forcing the answer tool would stop it ever consulting the advisor');
  assert.equal(q.body.system, `SYSTEM TEXT\n\n${ADVISOR_GUIDE}`);
  assert.deepEqual([r.advisor, r.advisorCalls, r.fellBack, r.fallbackReason, r.input], ['claude-opus-5-5', 1, false, null, ANSWER]);
  assert.equal(n.calls.length, 1);
});

test('advisor way: not consulting is fine; failed consultations are reported, not fatal', async () => {
  let n = net(reply([toolUse()])); let r = await ask(make(n, { advisor: 'claude-opus-5-5' }));
  assert.deepEqual([r.advisorCalls, r.fellBack], [0, false]);
  n = net(reply([advisorResult({ type: 'advisor_tool_result_error', error_code: 'overloaded' }), toolUse()])); r = await ask(make(n, { advisor: 'claude-opus-5-5' }));
  assert.deepEqual([r.advisorCalls, r.advisorErrors, r.fellBack], [1, ['overloaded'], false]);
});

test('advisor way: a paused turn is continued, and tokens add up', async () => {
  const pausedContent = [{ type: 'server_tool_use', name: 'advisor' }];
  const n = net(reply(pausedContent, { stop_reason: 'pause_turn', usage: { input_tokens: 300, output_tokens: 10 } }), reply([advisorResult(), toolUse()], { usage: { input_tokens: 400, output_tokens: 60 } }));
  const r = await ask(make(n, { advisor: 'claude-opus-5-5' }));
  assert.equal(n.calls.length, 2);
  assert.deepEqual(n.calls[1].body.messages, [{ role: 'user', content: 'USER TEXT' }, { role: 'assistant', content: pausedContent }]);
  assert.deepEqual([r.inputTokens, r.outputTokens, r.advisorCalls, r.fellBack], [700, 70, 1, false]);
});

test('if the advisor way fails, the same question is asked the plain way and the assistant still answers', async () => {
  const cases = [
    ['a 400 from Anthropic', failure(400, 'invalid_request_error', 'advisor not allowed here'), /400 invalid_request_error: advisor not allowed here/],
    ['an overloaded service', failure(529, 'overloaded_error', 'Overloaded'), /529 overloaded_error/],
    ['no answer tool called', reply([{ type: 'text', text: 'I would say...' }]), /no tool call/],
    ['paused forever', () => reply([{ type: 'server_tool_use' }], { stop_reason: 'pause_turn' }), /too many turns/],
    ['the network dropping', () => { throw new Error('connection reset'); }, /connection reset/],
  ];
  for (const [name, bad, reason] of cases) {
    const script = name === 'paused forever' ? [bad, bad, bad, reply([toolUse()])] : [bad, reply([toolUse()])];
    const n = net(...script); const r = await ask(make(n, { advisor: 'claude-opus-5-5' }));
    assert.equal(r.fellBack, true, name); assert.match(r.fallbackReason, reason, name); assert.deepEqual(r.input, ANSWER, name);
    const last = n.calls[n.calls.length - 1];
    assert.equal('anthropic-beta' in last.headers, false, `${name}: the fallback is the plain way`);
    assert.deepEqual(last.body.tool_choice, { type: 'tool', name: 'record_analysis' }, name);
    assert.equal(last.body.tools.length, 1, name);
  }
  assert.equal(LIMITS_CLAUDE.maxTurns, 3);
});

test('if both ways fail the call fails, with the reason, and never with the key', async () => {
  const n = net(failure(401, 'authentication_error', 'invalid x-api-key'), failure(401, 'authentication_error', 'invalid x-api-key'));
  await assert.rejects(ask(make(n, { advisor: 'claude-opus-5-5' })), (e) => { assert.match(e.message, /claude 401 authentication_error: invalid x-api-key/); assert.ok(!e.message.includes(KEY)); return true; });
  await assert.rejects(ask(make(net(reply([{ type: 'text', text: 'no tool' }])))), /no tool call/);
  await assert.rejects(ask(makeClaude({ apiKey: () => '', model: 'claude-haiku-5-5', advisor: null, fetchFn: net().fetchFn })), /missing key/);
});

test('overrides for the self-test: another model, another advisor, or none', async () => {
  let n = net(reply([toolUse()])); let r = await ask(make(n, { advisor: 'claude-opus-5-5' }), undefined, null);
  assert.equal(r.advisor, null); assert.equal('anthropic-beta' in n.calls[0].headers, false, 'null turns the advisor off');
  n = net(reply([toolUse()])); r = await ask(make(n), undefined, 'claude-sonnet-5-5');
  assert.equal(r.advisor, 'claude-sonnet-5-5'); assert.equal(n.calls[0].body.tools[1].model, 'claude-sonnet-5-5');
  n = net(reply([toolUse()])); await ask(make(n, { advisor: 'claude-opus-5-5' }), 'claude-sonnet-5-5');
  assert.equal(n.calls[0].body.model, 'claude-sonnet-5-5'); assert.equal(n.calls[0].body.tools[1].model, 'claude-opus-5-5', 'the live advisor stays unless overridden');
});

test('every request has a time limit', async () => {
  const n = net(reply([toolUse()])); await ask(make(n, { advisor: 'claude-opus-5-5' }));
  assert.ok(n.calls[0].signal instanceof AbortSignal);
});

// ---------- advisor proof, web search, and the ladder of fallbacks
const webResult = (content = [{ type: 'web_search_result', url: 'https://example.test', title: 'x', encrypted_content: 'abc' }]) => ({ type: 'web_search_tool_result', tool_use_id: 'w1', content });
const WG = 'WEB GUIDE TEXT', AG = 'ADVISOR GUIDE TEXT';
const OPTS = { webSearch: true, webGuide: WG, advisorGuide: AG };

test('advisor proof: the model Anthropic says ran, and what it read and wrote, come from usage.iterations', async () => {
  const usage = { input_tokens: 1760, output_tokens: 531, iterations: [
    { type: 'message', input_tokens: 412, output_tokens: 89 },
    { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 823, output_tokens: 1612 },
    { type: 'message', input_tokens: 1348, output_tokens: 442 }] };
  const n = net(reply([{ type: 'server_tool_use', name: 'advisor' }, advisorResult(), toolUse()], { usage }));
  const r = await ask(make(n, { advisor: 'claude-opus-5-5' }));
  assert.deepEqual([r.advisorCalls, r.advisorModelSeen, r.advisorInputTokens, r.advisorOutputTokens, r.inputTokens, r.outputTokens], [1, 'claude-opus-5-5', 823, 1612, 1760, 531]);
  // not consulted: no advisor entries, so no proof and no advisor tokens
  const q = await ask(make(net(reply([toolUse()])), { advisor: 'claude-opus-5-5' }));
  assert.deepEqual([q.advisorCalls, q.advisorModelSeen, q.advisorInputTokens, q.advisorOutputTokens], [0, null, 0, 0]);
  // two turns add up
  const m = net(reply([{ type: 'server_tool_use' }], { stop_reason: 'pause_turn', usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 200 }] } }), reply([toolUse()], { usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20 }] } }));
  const t = await ask(make(m, { advisor: 'claude-opus-5-5' })); assert.deepEqual([t.advisorInputTokens, t.advisorOutputTokens], [110, 220]);
});

test('web search only: the search tool is offered with a cap, nothing forces the answer tool, no advisor header, and the search instructions are added', async () => {
  const n = net(reply([{ type: 'server_tool_use', name: 'web_search' }, webResult(), webResult(), toolUse()]));
  const r = await ask(make(n), undefined, undefined, { webSearch: true, webGuide: WG });
  const q = n.calls[0];
  assert.deepEqual(q.body.tools, [TOOL, { type: WEB_SEARCH_TYPE, name: 'web_search', max_uses: 3 }]); assert.equal(WEB_SEARCH_TYPE, 'web_search_20250305');
  assert.equal('tool_choice' in q.body, false); assert.equal('anthropic-beta' in q.headers, false); assert.equal(q.body.system, `SYSTEM TEXT\n\n${WG}`);
  assert.deepEqual([r.webRequested, r.webSearches, r.webErrors, r.degraded, r.fellBack, r.advisor], [true, 2, [], [], false, null]);
});

test('web search and the advisor together: both tools, the advisor header, and both sets of instructions in order', async () => {
  const n = net(reply([{ type: 'server_tool_use', name: 'web_search' }, webResult(), advisorResult(), toolUse()]));
  const r = await ask(make(n, { advisor: 'claude-opus-5-5' }), undefined, undefined, OPTS);
  const q = n.calls[0];
  assert.deepEqual(q.body.tools.map((t) => t.name), ['record_analysis', 'web_search', 'advisor']); assert.equal(q.headers['anthropic-beta'], ADVISOR_BETA);
  assert.equal(q.body.system, `SYSTEM TEXT\n\n${WG}\n\n${AG}`); assert.equal('tool_choice' in q.body, false);
  assert.deepEqual([r.advisorCalls, r.webSearches, r.degraded, r.fellBack], [1, 1, [], false]);
});

test('search errors are reported, not fatal', async () => {
  const n = net(reply([webResult({ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }), toolUse()]));
  const r = await ask(make(n), undefined, undefined, OPTS);
  assert.deepEqual([r.webSearches, r.webErrors, r.fellBack], [1, ['max_uses_exceeded'], false]);
});

test('the ladder: advisor and search first; if that fails, the advisor alone; then plain. Each step says what was dropped', async () => {
  const ok = reply([toolUse()]);
  // search is not enabled on the account: the next rung (advisor, no search) answers
  let n = net(failure(400, 'invalid_request_error', 'web search is not enabled'), ok);
  let r = await ask(make(n, { advisor: 'claude-opus-5-5' }), undefined, undefined, OPTS);
  assert.deepEqual([r.fellBack, r.degraded, r.advisor, r.webRequested], [true, ['web_search'], 'claude-opus-5-5', true]); assert.match(r.fallbackReason, /web search is not enabled/);
  assert.deepEqual(n.calls[1].body.tools.map((t) => t.name), ['record_analysis', 'advisor']); assert.equal(n.calls[1].body.system, `SYSTEM TEXT\n\n${AG}`, 'no search instructions when search is off');
  // both of those fail: plain Haiku, forced answer tool, nothing else
  n = net(failure(529, 'overloaded_error', 'Overloaded'), failure(529, 'overloaded_error', 'Overloaded'), ok);
  r = await ask(make(n, { advisor: 'claude-opus-5-5' }), undefined, undefined, OPTS);
  assert.deepEqual([r.fellBack, r.degraded, n.calls.length], [true, ['advisor', 'web_search'], 3]); assert.deepEqual(n.calls[2].body.tool_choice, { type: 'tool', name: 'record_analysis' }); assert.equal(n.calls[2].body.system, 'SYSTEM TEXT'); assert.equal(n.calls[2].body.tools.length, 1);
  // search without an advisor: search, then plain
  n = net(failure(400, 'invalid_request_error', 'nope'), ok); r = await ask(make(n), undefined, undefined, OPTS);
  assert.deepEqual([r.fellBack, r.degraded, r.advisor], [true, ['web_search'], null]); assert.equal(n.calls.length, 2);
  // nothing asked for: one plain request, as before
  n = net(ok); r = await ask(make(n)); assert.deepEqual([r.fellBack, r.degraded, n.calls.length], [false, [], 1]);
  // everything fails: the call fails, with a reason
  n = net(failure(401, 'authentication_error', 'invalid x-api-key'), failure(401, 'authentication_error', 'invalid x-api-key'), failure(401, 'authentication_error', 'invalid x-api-key'));
  await assert.rejects(ask(make(n, { advisor: 'claude-opus-5-5' }), undefined, undefined, OPTS), /401 authentication_error/);
  assert.equal(LIMITS_CLAUDE.maxSearches, 3);
});

test('per-call settings: a smaller token cap, and a search cap, are passed through', async () => {
  const n = net(reply([toolUse()])); await ask(make(n), undefined, undefined, { webSearch: true, maxTokens: 1234, maxSearches: 2 });
  assert.equal(n.calls[0].body.max_tokens, 1234); assert.equal(n.calls[0].body.tools[1].max_uses, 2);
});

test('plain-text advice (Opus 4.8) is captured for the self-test; encrypted advice (Opus 5.5) gives no text', async () => {
  let r = await ask(make(net(reply([advisorResult({ type: 'advisor_result', text: 'Decide the format first.\u0000', stop_reason: 'end_turn' }), toolUse()])), { advisor: 'claude-opus-4-8' }));
  assert.equal(r.advisorText, 'Decide the format first.');
  r = await ask(make(net(reply([advisorResult(), toolUse()])), { advisor: 'claude-opus-5-5' })); assert.equal(r.advisorText, null);
  r = await ask(make(net(reply([toolUse()])), { advisor: 'claude-opus-5-5' })); assert.equal(r.advisorText, null);
});
