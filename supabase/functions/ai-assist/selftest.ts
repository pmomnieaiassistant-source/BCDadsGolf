// A self-test for the assistant, so Claude Code (which cannot sign in as a member) can check that the real pipeline works:
// the Anthropic key, the model, the forced answer shape, and the blueprint from GitHub.
//
// It sits behind the same secret key as the agent door (header x-agent-key). It uses made-up ideas only: no member data
// is read or written, nothing is saved, and the answer never contains a key. Three tiny Claude calls, at most one test per 20 seconds.
import { BRAINSTORM_ADVISOR_GUIDE, BRAINSTORM_WEB_GUIDE, buildBrainstormPrompt, buildPrompt, validateAnalysis, validateBrainstorm } from './logic.ts';
import type { Bundle } from './logic.ts';

export type SelfTestDeps = {
  agentKey?: string;
  model?: string;
  now: () => Date;
  loadBlueprint?: () => Promise<string | null>;
  advisor?: string | null;
  webSearch?: boolean;
  callClaude: (system: string, user: string, tool: unknown, model?: string, advisor?: string | null, opts?: { advisorGuide?: string; maxTokens?: number; webSearch?: boolean; webGuide?: string }) => Promise<{ input: unknown; inputTokens: number | null; outputTokens: number | null; advisorCalls?: number; advisorErrors?: string[]; advisorModelSeen?: string | null; advisorText?: string | null; advisorInputTokens?: number; advisorOutputTokens?: number; webSearches?: number; webErrors?: string[]; degraded?: string[]; fellBack?: boolean; fallbackReason?: string | null }>;
};

export const SELFTEST_GAP_MS = 20_000;
// The self-test can try either of these, so the models can be compared on the same made-up ideas before switching.
export const SELFTEST_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
// The advisor can be tried the same way: a model, or "off" for none. Only models that make sense as an advisor.
// claude-opus-4-8 returns its advice as plain text, so the self-test can show what the advisor actually said (Opus 5.5's advice is encrypted).
export const SELFTEST_ADVISORS = ['claude-opus-5-5', 'claude-opus-4-8', 'claude-sonnet-5-5', 'off'];
const lastRun = new WeakMap<object, number>();

// Compare keys without leaking, through timing, how much of the key was right: hash both and compare every byte.
async function sameKey(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < p.length; i++) d |= p[i] ^ q[i];
  return d === 0;
}

const out = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const bundle = (title: string, body: string, reply: string): Bundle => ({
  idea: { id: 'selftest', title, body, status: 'open', summary: null, open_questions: [], spec: null, ai_updated_at: null, author_id: 't1', author_name: 'Tester One' },
  comments: [{ id: 'c1', parent_id: null, is_ai: false, kind: 'comment', body: reply, author_id: 't2', author_name: 'Tester Two', created_at: '2026-01-01T00:00:00Z' }],
  polls: [],
});

// One idea that the blueprint says already exists (the how-it-works guide) and one that it says does not (a leaderboard).
// A third idea where the assistant asked a question and the group clearly answered it, so it should be recorded as a short Q&A.
const answeredBundle = (): Bundle => ({
  idea: { id: 'selftest', title: 'Season leaderboard', body: 'Rank everyone by stableford points over the season.', status: 'open', summary: null, open_questions: [], spec: null, ai_updated_at: null, author_id: 't1', author_name: 'Tester One' },
  comments: [
    { id: 'q1', parent_id: null, is_ai: true, kind: 'question', body: 'How long is a season: a calendar year, or dates the admin sets?', author_id: null, author_name: '', created_at: '2026-01-01T00:00:00Z' },
    { id: 'a1', parent_id: 'q1', is_ai: false, kind: 'comment', body: 'A calendar year, January to December.', author_id: 't2', author_name: 'Tester Two', created_at: '2026-01-01T00:01:00Z' },
    { id: 'a2', parent_id: 'q1', is_ai: false, kind: 'comment', body: 'Yes, agreed, calendar year.', author_id: 't1', author_name: 'Tester One', created_at: '2026-01-01T00:02:00Z' },
  ],
  polls: [],
});

// A fourth idea, only when asked for (strategic): it overlaps ideas on a made-up board and its questions are settled, so it looks ready.
// These are the situations where the assistant is told to consult its advisor.
const strategicBundle = (): Bundle => ({
  idea: { id: 'selftest', title: 'Let each round use a different scoring format', body: 'Before each round the group picks stableford, stroke play or skins, and the app scores it that way.', status: 'open', summary: null, open_questions: [], spec: null, ai_updated_at: null, author_id: 't1', author_name: 'Tester One' },
  comments: [
    { id: 'q1', parent_id: null, is_ai: true, kind: 'question', body: 'Is the format chosen once per round, or can it change hole by hole?', author_id: null, author_name: '', created_at: '2026-01-01T00:00:00Z' },
    { id: 'a1', parent_id: 'q1', is_ai: false, kind: 'comment', body: 'Once per round, picked before the first tee.', author_id: 't2', author_name: 'Tester Two', created_at: '2026-01-01T00:01:00Z' },
    { id: 'a2', parent_id: 'q1', is_ai: false, kind: 'comment', body: 'Agreed, once per round.', author_id: 't3', author_name: 'Tester Three', created_at: '2026-01-01T00:02:00Z' },
  ],
  polls: [],
  board: [{ title: 'Stableford scoring', status: 'open' }, { title: 'Skins tracker', status: 'ready' }, { title: 'Season leaderboard', status: 'open' }, { title: 'Handicap tracking', status: 'open' }, { title: 'Pick teams for a scramble', status: 'open' }],
});

const SCENARIOS: { name: string; expectsExisting: boolean; bundle: Bundle }[] = [
  { name: 'idea for something that already exists', expectsExisting: true,
    bundle: bundle('Show the how-it-works guide when the app opens', 'When someone opens the app, show a short swipeable guide that explains how it works, with a way to hide it.', 'Good idea, new members would find it useful.') },
  { name: 'idea for something new', expectsExisting: false,
    bundle: bundle('Season leaderboard', 'Rank everyone by stableford points over the whole season.', 'Maybe only the best 8 rounds should count?') },
  { name: 'idea where a question was clearly answered', expectsExisting: false, bundle: answeredBundle() },
];

const reasonOf = (e: unknown): string => {
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return (e instanceof Error ? e.message : String(e)).replace(/[^\x20-\x7E]/g, '').slice(0, 240);
};

export async function handleSelfTest(req: Request, deps: SelfTestDeps, body: { model?: unknown; advisor?: unknown; consult?: unknown; strategic?: unknown; brainstorm?: unknown } = {}): Promise<Response> {
  // The door stays shut unless a long enough key is set on the server and the caller has it.
  if (!deps.agentKey || deps.agentKey.length < 32) return out(503, { error: 'Self-test is not set up.' });
  const given = req.headers.get('x-agent-key') || '';
  if (!given || !(await sameKey(given, deps.agentKey))) return out(401, { error: 'Not allowed.' });

  // Optional: try a specific model instead of the live one. Only the two known models are allowed.
  let model: string | undefined;
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !SELFTEST_MODELS.includes(body.model)) return out(400, { error: 'Unknown model.', allowed: SELFTEST_MODELS });
    model = body.model;
  }

  // Optional: try a specific advisor, or none, instead of the live setting.
  let advisorOverride: string | null | undefined;
  if (body.advisor !== undefined) {
    if (typeof body.advisor !== 'string' || !SELFTEST_ADVISORS.includes(body.advisor)) return out(400, { error: 'Unknown advisor.', allowed: SELFTEST_ADVISORS });
    advisorOverride = body.advisor === 'off' ? null : body.advisor;
  }
  const advisorUsed = advisorOverride === undefined ? deps.advisor ?? null : advisorOverride;

  const now = deps.now().getTime();
  const prev = lastRun.get(deps);
  if (prev !== undefined && now - prev < SELFTEST_GAP_MS) return out(429, { error: 'Wait a few seconds between self-tests.' });
  lastRun.set(deps, now);

  const blueprint = deps.loadBlueprint ? await deps.loadBlueprint().catch(() => null) : null;
  if (body.brainstorm === true) return brainstormTest(deps, blueprint, model, advisorOverride, advisorUsed);
  const consult = body.consult === true; // test only: tell the model to consult its advisor, to prove the advisor really answers
  const list = body.strategic === true ? [...SCENARIOS, { name: 'strategic idea: overlaps the board and looks ready', expectsExisting: false, bundle: strategicBundle() }] : SCENARIOS;
  const scenarios = [];
  let reachable = true, shapeOk = true;
  for (const s of list) {
    const prompt = buildPrompt(s.bundle, blueprint);
    if (consult) prompt.user += '\n\nFor this test, consult your advisor once before you answer.';
    const t0 = Date.now();
    try {
      const r = await deps.callClaude(prompt.system, prompt.user, prompt.tool, model, advisorOverride);
      const a = validateAnalysis(r.input, { existing: [], participants: 2 });
      if (!a) shapeOk = false;
      const text = a ? `${a.summary} ${a.open_questions.join(' ')} ${a.new_questions.join(' ')}` : '';
      scenarios.push({
        name: s.name, ok: !!a, ms: Date.now() - t0, input_tokens: r.inputTokens, output_tokens: r.outputTokens,
        advisor_calls: r.advisorCalls ?? 0, advisor_errors: r.advisorErrors ?? [], advisor_model_seen: r.advisorModelSeen ?? null, advisor_text: r.advisorText ?? null, advisor_tokens: [r.advisorInputTokens ?? 0, r.advisorOutputTokens ?? 0], fell_back: r.fellBack ?? false, fallback_reason: r.fallbackReason ?? null,
        says_it_exists: /\balready\b|\bexists?\b|\bcurrently\b|\bexisting\b/i.test(text), expected_it_exists: s.expectsExisting,
        summary: a?.summary ?? null, questions: a ? [...a.open_questions, ...a.new_questions] : [], answered: a?.answered ?? null,
      });
    } catch (e) {
      reachable = false;
      scenarios.push({ name: s.name, ok: false, ms: Date.now() - t0, error: reasonOf(e) });
      break; // the same failure would just repeat
    }
  }
  const fellBack = (scenarios as { fell_back?: boolean }[]).some((s) => s.fell_back);
  const third = scenarios[2] as { answered?: { question: string; answer: string }[] | null } | undefined;
  const checks = [
    { name: 'Claude answers (key, model and network are fine)', ok: reachable },
    { name: 'the answer has the right shape and passes the app checks', ok: reachable && shapeOk },
    { name: 'the blueprint loads from GitHub', ok: !!blueprint },
    { name: 'a clearly answered question is recorded as a short question and answer', ok: !!third && Array.isArray(third.answered) && third.answered.length > 0 },
    { name: 'the advisor way works (or there is no advisor): no fallback to the plain way', ok: !advisorUsed || (reachable && !fellBack) },
    ...(consult ? [{ name: 'the advisor really answers when asked (it was consulted at least once)', ok: !!advisorUsed && (scenarios as { advisor_calls?: number }[]).some((s) => (s.advisor_calls ?? 0) > 0) }] : []),
  ];
  return out(200, {
    ok: checks.every((c) => c.ok),
    model: model ?? deps.model ?? null,
    tried_override: !!model || advisorOverride !== undefined,
    advisor: advisorUsed,
    blueprint: { loaded: !!blueprint, chars: blueprint ? blueprint.length : 0, first_line: blueprint ? blueprint.split('\n')[0].slice(0, 80) : null },
    checks, scenarios,
  });
}

// The brainstorm feature, end to end on a made-up board: the real prompt, the real Claude call (advisor included), the real checks.
async function brainstormTest(deps: SelfTestDeps, blueprint: string | null, model: string | undefined, advisorOverride: string | null | undefined, advisorUsed: string | null): Promise<Response> {
  const board = [{ title: 'Skins tracker', status: 'open', summary: 'Track skins won on each hole.' }, { title: 'Handicap tracking', status: 'open', summary: null }, { title: 'Season leaderboard', status: 'ready', summary: 'Rank everyone over a season.' }, { title: 'Stableford scoring', status: 'open', summary: null }];
  const features = [{ name: 'How-it-works guide', description: 'A short swipeable guide that opens when you launch the app.', version: '0.5.0' }];
  const prompt = buildBrainstormPrompt({ board, features, seen: [] }, blueprint);
  const web = deps.webSearch !== false;
  const t0 = Date.now();
  let ideas: ReturnType<typeof validateBrainstorm> = null, error: string | null = null, r: Awaited<ReturnType<SelfTestDeps['callClaude']>> | null = null;
  try {
    r = await deps.callClaude(prompt.system, prompt.user, prompt.tool, model, advisorOverride, { advisorGuide: BRAINSTORM_ADVISOR_GUIDE, maxTokens: 2800, webSearch: web, webGuide: BRAINSTORM_WEB_GUIDE });
    ideas = validateBrainstorm(r.input, { board, seen: [] });
  } catch (e) { error = reasonOf(e); }
  const checks = [
    { name: 'Claude answers (key, model and network are fine)', ok: !error },
    { name: 'brainstorm returns usable ideas (at least 3, all different from the board)', ok: !!ideas && ideas.length >= 3 },
    { name: 'the blueprint loads from GitHub', ok: !!blueprint },
    { name: 'the advisor way works (or there is no advisor): it was not dropped', ok: !error && (!advisorUsed || !(r?.degraded ?? []).includes('advisor')) },
    { name: 'web search works (or it is off): it was not dropped', ok: !error && (!web || !(r?.degraded ?? []).includes('web_search')) },
  ];
  return out(200, {
    ok: checks.every((c) => c.ok), mode: 'brainstorm', web_search: web,
    model: model ?? deps.model ?? null, tried_override: !!model || advisorOverride !== undefined, advisor: advisorUsed,
    blueprint: { loaded: !!blueprint, chars: blueprint ? blueprint.length : 0, first_line: blueprint ? blueprint.split('\n')[0].slice(0, 80) : null },
    checks,
    result: { ms: Date.now() - t0, input_tokens: r?.inputTokens ?? null, output_tokens: r?.outputTokens ?? null, advisor_calls: r?.advisorCalls ?? 0, advisor_errors: r?.advisorErrors ?? [], advisor_model_seen: r?.advisorModelSeen ?? null, advisor_text: r?.advisorText ?? null, advisor_tokens: [r?.advisorInputTokens ?? 0, r?.advisorOutputTokens ?? 0], web_searches: r?.webSearches ?? 0, web_errors: r?.webErrors ?? [], degraded: r?.degraded ?? [], fell_back: r?.fellBack ?? false, fallback_reason: r?.fallbackReason ?? null, error, ideas },
  });
}
