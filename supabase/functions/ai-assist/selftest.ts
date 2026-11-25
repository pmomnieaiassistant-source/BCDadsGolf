// A self-test for the assistant, so Claude Code (which cannot sign in as a member) can check that the real pipeline works:
// the Anthropic key, the model, the forced answer shape, and the blueprint from GitHub.
//
// It sits behind the same secret key as the agent door (header x-agent-key). It uses made-up ideas only: no member data
// is read or written, nothing is saved, and the answer never contains a key. Three tiny Claude calls, at most one test per 20 seconds.
import { buildPrompt, validateAnalysis } from './logic.ts';
import type { Bundle } from './logic.ts';

export type SelfTestDeps = {
  agentKey?: string;
  model?: string;
  now: () => Date;
  loadBlueprint?: () => Promise<string | null>;
  callClaude: (system: string, user: string, tool: unknown, model?: string) => Promise<{ input: unknown; inputTokens: number | null; outputTokens: number | null }>;
};

export const SELFTEST_GAP_MS = 20_000;
// The self-test can try either of these, so the models can be compared on the same made-up ideas before switching.
export const SELFTEST_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
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
  return (e instanceof Error ? e.message : String(e)).replace(/[^\x20-\x7E]/g, '').slice(0, 160);
};

export async function handleSelfTest(req: Request, deps: SelfTestDeps, body: { model?: unknown } = {}): Promise<Response> {
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

  const now = deps.now().getTime();
  const prev = lastRun.get(deps);
  if (prev !== undefined && now - prev < SELFTEST_GAP_MS) return out(429, { error: 'Wait a few seconds between self-tests.' });
  lastRun.set(deps, now);

  const blueprint = deps.loadBlueprint ? await deps.loadBlueprint().catch(() => null) : null;
  const scenarios = [];
  let reachable = true, shapeOk = true;
  for (const s of SCENARIOS) {
    const prompt = buildPrompt(s.bundle, blueprint);
    const t0 = Date.now();
    try {
      const r = await deps.callClaude(prompt.system, prompt.user, prompt.tool, model);
      const a = validateAnalysis(r.input, { existing: [], participants: 2 });
      if (!a) shapeOk = false;
      const text = a ? `${a.summary} ${a.open_questions.join(' ')} ${a.new_questions.join(' ')}` : '';
      scenarios.push({
        name: s.name, ok: !!a, ms: Date.now() - t0, input_tokens: r.inputTokens, output_tokens: r.outputTokens,
        says_it_exists: /\balready\b|\bexists?\b|\bcurrently\b|\bexisting\b/i.test(text), expected_it_exists: s.expectsExisting,
        summary: a?.summary ?? null, questions: a ? [...a.open_questions, ...a.new_questions] : [], answered: a?.answered ?? null,
      });
    } catch (e) {
      reachable = false;
      scenarios.push({ name: s.name, ok: false, ms: Date.now() - t0, error: reasonOf(e) });
      break; // the same failure would just repeat
    }
  }
  const third = scenarios[2] as { answered?: { question: string; answer: string }[] | null } | undefined;
  const checks = [
    { name: 'Claude answers (key, model and network are fine)', ok: reachable },
    { name: 'the answer has the right shape and passes the app checks', ok: reachable && shapeOk },
    { name: 'the blueprint loads from GitHub', ok: !!blueprint },
    { name: 'a clearly answered question is recorded as a short question and answer', ok: !!third && Array.isArray(third.answered) && third.answered.length > 0 },
  ];
  return out(200, {
    ok: checks.every((c) => c.ok),
    model: model ?? deps.model ?? null,
    tried_override: !!model,
    blueprint: { loaded: !!blueprint, chars: blueprint ? blueprint.length : 0, first_line: blueprint ? blueprint.split('\n')[0].slice(0, 80) : null },
    checks, scenarios,
  });
}
