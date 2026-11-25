// The request handler for the AI assistant. All outside connections (sign-in check, database, Claude) come in
// through `deps`, so every path can be tested without the network.
import { buildPrompt, existingQuestions, participantIds, planWrites, validateAnalysis } from './logic.ts';
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
  usage: (ideaId: string, memberId: string, sinceHour: string, sinceDay: string) => Promise<{ ideaLast: string | null; memberHour: number; dayTotal: number }>;
  recordRun: (row: { idea_id: string; member_id: string; ok: boolean | null; input_tokens: number | null; output_tokens: number | null }) => Promise<string | null>;
  finishRun: (runId: string | null, ok: boolean, inputTokens: number | null, outputTokens: number | null) => Promise<void>;
  callClaude: (system: string, user: string, tool: unknown, model?: string, advisor?: string | null) => Promise<{ input: unknown; inputTokens: number | null; outputTokens: number | null; advisor?: string | null; advisorCalls?: number; advisorErrors?: string[]; fellBack?: boolean; fallbackReason?: string | null }>;
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
  let body: { idea_id?: unknown; force?: unknown; action?: unknown; model?: unknown } = {};
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
