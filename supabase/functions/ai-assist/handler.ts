// The request handler for the AI assistant. All outside connections (sign-in check, database, Claude) come in
// through `deps`, so every path can be tested without the network.
import { buildPrompt, existingQuestions, participantIds, planWrites, validateAnalysis } from './logic.ts';
import type { Bundle, Plan } from './logic.ts';

export type Limits = { cooldownSec: number; memberHourly: number; dailyCap: number };

export type Deps = {
  limits: Limits;
  now: () => Date;
  getUserId: (token: string) => Promise<string | null>;
  getMember: (userId: string) => Promise<{ isAdmin: boolean } | null>;
  loadBundle: (ideaId: string) => Promise<Bundle | null>;
  loadBlueprint?: () => Promise<string | null>; // the app blueprint from GitHub; never required, a failure just means no blueprint this time
  latestHumanCommentAt: (ideaId: string) => Promise<string | null>;
  usage: (ideaId: string, memberId: string, sinceHour: string, sinceDay: string) => Promise<{ ideaLast: string | null; memberHour: number; dayTotal: number }>;
  recordRun: (row: { idea_id: string; member_id: string; ok: boolean | null; input_tokens: number | null; output_tokens: number | null }) => Promise<string | null>;
  finishRun: (runId: string | null, ok: boolean, inputTokens: number | null, outputTokens: number | null) => Promise<void>;
  callClaude: (system: string, user: string, tool: unknown) => Promise<{ input: unknown; inputTokens: number | null; outputTokens: number | null }>;
  save: (ideaId: string, plan: Plan) => Promise<void>;
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  // 1. Who is asking? Must be a signed-in member of the group.
  const auth = req.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return json(401, { error: 'Sign in first.' });
  const userId = await deps.getUserId(token).catch(() => null);
  if (!userId) return json(401, { error: 'Sign in first.' });
  const member = await deps.getMember(userId).catch(() => null);
  if (!member) return json(403, { error: 'Only members can use the assistant.' });

  // 2. What are they asking about?
  let body: { idea_id?: unknown; force?: unknown } = {};
  try { body = await req.json(); } catch (_) { return json(400, { error: 'Bad request.' }); }
  const ideaId = typeof body.idea_id === 'string' ? body.idea_id : '';
  if (!UUID.test(ideaId)) return json(400, { error: 'Bad idea id.' });
  const force = body.force === true;

  const bundle = await deps.loadBundle(ideaId);
  if (!bundle) return json(404, { error: 'That idea was not found.' });

  // 3. Limits: keep the cost predictable. Admins asking for a refresh skip the cooldown and the "nothing new" check.
  const now = deps.now();
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const u = await deps.usage(ideaId, userId, hourAgo, dayAgo);
  const adminForce = member.isAdmin && force;

  if (!adminForce && u.ideaLast && now.getTime() - new Date(u.ideaLast).getTime() < deps.limits.cooldownSec * 1000) {
    return json(200, { ok: true, skipped: 'cooldown', retry_after: deps.limits.cooldownSec });
  }
  if (u.dayTotal >= deps.limits.dailyCap) return json(429, { error: 'The assistant has reached its limit for today. Try again tomorrow.' });
  if (!adminForce && u.memberHour >= deps.limits.memberHourly) return json(429, { error: 'You have asked the assistant a lot this hour. Try again later.' });

  if (!force) {
    const last = bundle.idea.ai_updated_at;
    const newest = await deps.latestHumanCommentAt(ideaId);
    // Compare as real dates: the database and this function write timestamps in different text formats.
    if (last && (!newest || new Date(newest).getTime() <= new Date(last).getTime())) return json(200, { ok: true, skipped: 'nothing_new' });
  }

  // 4. Claim the run first (so two quick requests do not both spend), then ask Claude.
  const runId = await deps.recordRun({ idea_id: ideaId, member_id: userId, ok: null, input_tokens: null, output_tokens: null });
  const blueprint = deps.loadBlueprint ? await deps.loadBlueprint().catch(() => null) : null;
  const prompt = buildPrompt(bundle, blueprint);
  let result;
  try {
    result = await deps.callClaude(prompt.system, prompt.user, prompt.tool);
  } catch (_) {
    await deps.finishRun(runId, false, null, null).catch(() => {});
    return json(502, { error: 'The assistant is not available right now. Try again in a minute.' });
  }

  // 5. Check what came back, then save only what we allow.
  const analysis = validateAnalysis(result.input, { existing: existingQuestions(bundle.idea, bundle.comments), participants: participantIds(bundle).length });
  if (!analysis) {
    await deps.finishRun(runId, false, result.inputTokens, result.outputTokens).catch(() => {});
    return json(502, { error: 'The assistant gave an answer the app could not use. Try again.' });
  }
  const plan = planWrites(bundle.idea, analysis, now.toISOString());
  try {
    await deps.save(ideaId, plan);
  } catch (_) {
    await deps.finishRun(runId, false, result.inputTokens, result.outputTokens).catch(() => {});
    return json(500, { error: 'Could not save the assistant\'s update.' });
  }
  await deps.finishRun(runId, true, result.inputTokens, result.outputTokens).catch(() => {});
  return json(200, { ok: true, status: (plan.ideaPatch.status as string) || bundle.idea.status, asked: plan.newComments.length, ready: analysis.ready, blueprint: !!blueprint });
}
