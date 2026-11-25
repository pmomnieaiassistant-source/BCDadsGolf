// The request handler for the AI assistant. All outside connections (sign-in check, database, Claude) come in
// through `deps`, so every path can be tested without the network.
import { BRAINSTORM_ADVISOR_GUIDE, LIMITS, buildBrainstormPrompt, buildPrompt, cleanIn, existingQuestions, participantIds, planWrites, validateAnalysis, validateBrainstorm } from './logic.ts';
import type { Bundle, Plan } from './logic.ts';
import { handleSelfTest } from './selftest.ts';

export type Limits = { cooldownSec: number; memberHourly: number; dailyCap: number };

export type Deps = {
  limits: Limits;
  now: () => Date;
  getUserId: (token: string) => Promise<string | null>;
  getMember: (userId: string) => Promise<{ isAdmin: boolean } | null>;
  loadBundle: (ideaId: string) => Promise<Bundle | null>;
  agentKey?: string; // the agent door's secret; only used to guard the self-test
  model?: string;
  advisor?: string | null;
  log?: (event: string, data: Record<string, unknown>) => void; // ids, counts, timings and safe reasons only: never member text or keys
  loadBlueprint?: () => Promise<string | null>; // the app blueprint from GitHub; never required, a failure just means no blueprint this time
  latestHumanCommentAt: (ideaId: string) => Promise<string | null>;
  usage: (ideaId: string | null, memberId: string, sinceHour: string, sinceDay: string) => Promise<{ ideaLast: string | null; memberHour: number; dayTotal: number; brainstormHour?: number; brainstormLast?: string | null }>;
  loadBoard?: () => Promise<{ title: string; status: string }[]>; // every idea's title and status, for brainstorming
  recordRun: (row: { idea_id: string | null; member_id: string; ok: boolean | null; input_tokens: number | null; output_tokens: number | null }) => Promise<string | null>;
  finishRun: (runId: string | null, ok: boolean, inputTokens: number | null, outputTokens: number | null) => Promise<void>;
  callClaude: (system: string, user: string, tool: unknown, model?: string, advisor?: string | null, opts?: { advisorGuide?: string; maxTokens?: number }) => Promise<{ input: unknown; inputTokens: number | null; outputTokens: number | null; advisor?: string | null; advisorCalls?: number; advisorErrors?: string[]; fellBack?: boolean; fallbackReason?: string | null }>;
  save: (ideaId: string, plan: Plan) => Promise<void>;
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// A short, safe reason for a failure: the kind of error only, never anything a member wrote, never a key.
export function safeReason(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return (e instanceof Error ? e.message : String(e)).replace(/[^\x20-\x7E]/g, '').slice(0, 220);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const log = deps.log || (() => {});
  // The body is read once, up front, only so the self-test (key-protected, made-up data) can be told apart from a member's request.
  let body: { idea_id?: unknown; force?: unknown; action?: unknown; model?: unknown; seen?: unknown } = {};
  let badBody = false;
  try { body = await req.json(); } catch (_) { badBody = true; }
  if (body && body.action === 'selftest') return handleSelfTest(req, deps, body);

  // 1. Who is asking? Must be a signed-in member of the group.
  const auth = req.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return json(401, { error: 'Sign in first.' });
  const userId = await deps.getUserId(token).catch(() => null);
  if (!userId) return json(401, { error: 'Sign in first.' });
  const member = await deps.getMember(userId).catch(() => null);
  if (!member) return json(403, { error: 'Only members can use the assistant.' });

  // Brainstorm: AI-written starter ideas for the group to browse (see brainstormFlow below).
  if (body && body.action === 'brainstorm') return brainstormFlow(deps, userId, body.seen, log);

  // 2. What are they asking about?
  if (badBody || !body || typeof body !== 'object') return json(400, { error: 'Bad request.' });
  const ideaId = typeof body.idea_id === 'string' ? body.idea_id : '';
  if (!UUID.test(ideaId)) { log('bad_request', { member_id: userId }); return json(400, { error: 'Bad idea id.' }); }
  const force = body.force === true;

  const bundle = await deps.loadBundle(ideaId);
  if (!bundle) { log('idea_not_found', { idea_id: ideaId, member_id: userId }); return json(404, { error: 'That idea was not found.' }); }

  // 3. Limits: keep the cost predictable. Admins asking for a refresh skip the cooldown and the "nothing new" check.
  const now = deps.now();
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const u = await deps.usage(ideaId, userId, hourAgo, dayAgo);
  const adminForce = member.isAdmin && force;

  if (!adminForce && u.ideaLast && now.getTime() - new Date(u.ideaLast).getTime() < deps.limits.cooldownSec * 1000) {
    log('skipped', { idea_id: ideaId, member_id: userId, why: 'cooldown' });
    return json(200, { ok: true, skipped: 'cooldown', retry_after: deps.limits.cooldownSec });
  }
  if (u.dayTotal >= deps.limits.dailyCap) { log('limit', { idea_id: ideaId, member_id: userId, which: 'day' }); return json(429, { error: 'The assistant has reached its limit for today. Try again tomorrow.' }); }
  if (!adminForce && u.memberHour >= deps.limits.memberHourly) { log('limit', { idea_id: ideaId, member_id: userId, which: 'hour' }); return json(429, { error: 'You have asked the assistant a lot this hour. Try again later.' }); }

  if (!force) {
    const last = bundle.idea.ai_updated_at;
    const newest = await deps.latestHumanCommentAt(ideaId);
    // Compare as real dates: the database and this function write timestamps in different text formats.
    if (last && (!newest || new Date(newest).getTime() <= new Date(last).getTime())) { log('skipped', { idea_id: ideaId, member_id: userId, why: 'nothing_new' }); return json(200, { ok: true, skipped: 'nothing_new' }); }
  }

  // 4. Claim the run first (so two quick requests do not both spend), then ask Claude.
  const runId = await deps.recordRun({ idea_id: ideaId, member_id: userId, ok: null, input_tokens: null, output_tokens: null });
  const blueprint = deps.loadBlueprint ? await deps.loadBlueprint().catch(() => null) : null;
  const prompt = buildPrompt(bundle, blueprint);
  log('run_start', { idea_id: ideaId, member_id: userId, force, comments: bundle.comments.length, blueprint_chars: blueprint ? blueprint.length : 0, board_ideas: (bundle.board || []).length, model: deps.model ?? null, advisor: deps.advisor ?? null });
  const t0 = deps.now().getTime();
  let result;
  try {
    result = await deps.callClaude(prompt.system, prompt.user, prompt.tool);
  } catch (e) {
    const reason = safeReason(e);
    log('claude_error', { idea_id: ideaId, reason, ms: deps.now().getTime() - t0 });
    await deps.finishRun(runId, false, null, null).catch(() => {});
    return json(502, { error: 'The assistant is not available right now. Try again in a minute.' }); // the reason goes to the log, never to the member
  }
  log('claude_ok', { idea_id: ideaId, ms: deps.now().getTime() - t0, input_tokens: result.inputTokens, output_tokens: result.outputTokens, advisor_calls: result.advisorCalls ?? 0, advisor_errors: result.advisorErrors ?? [], fell_back: result.fellBack ?? false, fallback_reason: result.fallbackReason ?? null });

  // 5. Check what came back, then save only what we allow.
  const analysis = validateAnalysis(result.input, { existing: existingQuestions(bundle.idea, bundle.comments), participants: participantIds(bundle).length });
  if (!analysis) {
    log('bad_answer', { idea_id: ideaId });
    await deps.finishRun(runId, false, result.inputTokens, result.outputTokens).catch(() => {});
    return json(502, { error: 'The assistant gave an answer the app could not use. Try again.' });
  }
  const plan = planWrites(bundle.idea, analysis, now.toISOString());
  try {
    await deps.save(ideaId, plan);
  } catch (e) {
    log('save_error', { idea_id: ideaId, reason: safeReason(e) });
    await deps.finishRun(runId, false, result.inputTokens, result.outputTokens).catch(() => {});
    return json(500, { error: 'Could not save the assistant\'s update.' });
  }
  await deps.finishRun(runId, true, result.inputTokens, result.outputTokens).catch(() => {});
  log('saved', { idea_id: ideaId, status: (plan.ideaPatch.status as string) || bundle.idea.status, asked: plan.newComments.length, ready: analysis.ready });
  return json(200, { ok: true, status: (plan.ideaPatch.status as string) || bundle.idea.status, asked: plan.newComments.length, ready: analysis.ready, blueprint: !!blueprint });
}

// ---------------------------------------------------------------- brainstorm
// A member opens Brainstorm and gets a batch of starter ideas (a short title and a few sentences each). Nothing is saved here and no
// idea is created: when a member likes one, the app adds it under their own name through the normal "new idea" path.
// It uses the same assistant (Haiku with the Opus advisor, which it is asked to consult first) and counts against the same limits.
export const BRAINSTORM_LIMITS = { cooldownSec: 20, memberHourly: 6 };

async function brainstormFlow(deps: Deps, userId: string, seenIn: unknown, log: (e: string, d: Record<string, unknown>) => void): Promise<Response> {
  const now = deps.now();
  const u = await deps.usage(null, userId, new Date(now.getTime() - 3600_000).toISOString(), new Date(now.getTime() - 86_400_000).toISOString());
  if (u.brainstormLast && now.getTime() - new Date(u.brainstormLast).getTime() < BRAINSTORM_LIMITS.cooldownSec * 1000) {
    log('limit', { member_id: userId, which: 'brainstorm_cooldown' });
    return json(429, { error: 'Give it a few seconds, then ask for more ideas.', retry_after: BRAINSTORM_LIMITS.cooldownSec });
  }
  if ((u.brainstormHour ?? 0) >= BRAINSTORM_LIMITS.memberHourly) { log('limit', { member_id: userId, which: 'brainstorm_hour' }); return json(429, { error: 'You have brainstormed a lot this hour. Try again later.' }); }
  if (u.dayTotal >= deps.limits.dailyCap) { log('limit', { member_id: userId, which: 'day' }); return json(429, { error: 'The assistant has reached its limit for today. Try again tomorrow.' }); }
  if (u.memberHour >= deps.limits.memberHourly) { log('limit', { member_id: userId, which: 'hour' }); return json(429, { error: 'You have asked the assistant a lot this hour. Try again later.' }); }

  // What the app says it has already shown: only text, capped, cleaned like any other member text.
  const seen = (Array.isArray(seenIn) ? seenIn : []).filter((x): x is string => typeof x === 'string').slice(0, LIMITS.maxSeen).map((x) => cleanIn(x, LIMITS.maxStubTitle)).filter(Boolean);
  const board = deps.loadBoard ? await deps.loadBoard().catch(() => []) : [];
  const blueprint = deps.loadBlueprint ? await deps.loadBlueprint().catch(() => null) : null;

  const runId = await deps.recordRun({ idea_id: null, member_id: userId, ok: null, input_tokens: null, output_tokens: null });
  const prompt = buildBrainstormPrompt({ board, seen }, blueprint);
  log('brainstorm_start', { member_id: userId, board_ideas: board.length, seen: seen.length, blueprint_chars: blueprint ? blueprint.length : 0, model: deps.model ?? null, advisor: deps.advisor ?? null });
  const t0 = now.getTime();
  let result;
  try {
    result = await deps.callClaude(prompt.system, prompt.user, prompt.tool, undefined, undefined, { advisorGuide: BRAINSTORM_ADVISOR_GUIDE, maxTokens: 2400 });
  } catch (e) {
    log('claude_error', { member_id: userId, reason: safeReason(e), ms: deps.now().getTime() - t0 });
    await deps.finishRun(runId, false, null, null).catch(() => {});
    return json(502, { error: 'The assistant is not available right now. Try again in a minute.' });
  }
  log('claude_ok', { member_id: userId, ms: deps.now().getTime() - t0, input_tokens: result.inputTokens, output_tokens: result.outputTokens, advisor_calls: result.advisorCalls ?? 0, advisor_errors: result.advisorErrors ?? [], fell_back: result.fellBack ?? false, fallback_reason: result.fallbackReason ?? null });
  const ideas = validateBrainstorm(result.input, { board, seen });
  if (!ideas) {
    log('bad_answer', { member_id: userId });
    await deps.finishRun(runId, false, result.inputTokens, result.outputTokens).catch(() => {});
    return json(502, { error: 'The assistant gave an answer the app could not use. Try again.' });
  }
  await deps.finishRun(runId, true, result.inputTokens, result.outputTokens).catch(() => {});
  log('brainstorm_done', { member_id: userId, ideas: ideas.length });
  return json(200, { ok: true, ideas });
}
