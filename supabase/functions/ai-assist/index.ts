// Supabase Edge Function: the AI assistant for ideas.
// Secrets it needs (set by the deploy workflow, never in the repo): ANTHROPIC_API_KEY.
// Supabase supplies SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY itself.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './handler.ts';
import type { Deps } from './handler.ts';
import type { Bundle } from './logic.ts';
import { makeBlueprintLoader } from './blueprint.ts';
import { makeClaude } from './claude.ts';

const env = (k: string, d = ''): string => Deno.env.get(k) ?? d;
const num = (k: string, d: number): number => { const n = Number(env(k)); return Number.isFinite(n) && n > 0 ? n : d; };

const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const MODEL = env('AI_MODEL', 'claude-haiku-5-5'); // Haiku is the proven default; try Sonnet with the self-test's model option first
const loadBlueprint = makeBlueprintLoader((url, init) => fetch(url, init), () => Date.now());
// The advisor: a stronger model the main one may consult once for strategic direction. 'off' (or empty) turns it off.
const ADVISOR_RAW = env('AI_ADVISOR', 'claude-opus-5-5').trim();
const ADVISOR: string | null = ['', 'off', 'none'].includes(ADVISOR_RAW.toLowerCase()) ? null : ADVISOR_RAW;
const claude = makeClaude({ apiKey: () => env('ANTHROPIC_API_KEY'), model: MODEL, advisor: ADVISOR, fetchFn: (url, init) => fetch(url, init) });

const deps: Deps = {
  limits: { cooldownSec: num('AI_COOLDOWN_SEC', 90), memberHourly: num('AI_MEMBER_HOURLY', 30), dailyCap: num('AI_DAILY_CAP', 300) },
  now: () => new Date(),
  loadBlueprint,
  agentKey: env('AGENT_KEY'),
  model: MODEL,
  advisor: ADVISOR,
  log: (event, data) => console.log(JSON.stringify({ fn: 'ai-assist', event, ...data })),

  async getUserId(token) {
    const { data, error } = await db.auth.getUser(token);
    return error || !data.user ? null : data.user.id;
  },

  async getMember(userId) {
    const { data } = await db.from('members').select('is_admin').eq('id', userId).maybeSingle();
    return data ? { isAdmin: !!data.is_admin } : null;
  },

  async loadBundle(ideaId): Promise<Bundle | null> {
    const { data: idea } = await db.from('ideas')
      .select('id,title,body,status,summary,open_questions,answered_qa,spec,ai_updated_at,ready_by,author_id,author:members!author_id(name)')
      .eq('id', ideaId).maybeSingle();
    if (!idea) return null;
    const { data: comments } = await db.from('comments')
      .select('id,parent_id,is_ai,kind,body,author_id,created_at,author:members!author_id(name)')
      .eq('idea_id', ideaId).order('created_at', { ascending: true }).limit(200);
    const { data: polls } = await db.from('polls')
      .select('question,poll_options(id,label),poll_votes(option_id,voter_id)')
      .eq('idea_id', ideaId).order('created_at', { ascending: true });
    const { data: others } = await db.from('ideas').select('title,status').neq('id', ideaId).order('created_at', { ascending: false }).limit(40);
    // deno-lint-ignore no-explicit-any
    const nameOf = (a: any) => (Array.isArray(a) ? a[0]?.name : a?.name) || '';
    return {
      idea: { ...idea, author_name: nameOf(idea.author) },
      board: (others || []).map((o: { title: string; status: string }) => ({ title: o.title, status: o.status })),
      // deno-lint-ignore no-explicit-any
      comments: (comments || []).map((c: any) => ({ ...c, author_name: nameOf(c.author) })),
      // deno-lint-ignore no-explicit-any
      polls: (polls || []).map((p: any) => ({
        question: p.question,
        // deno-lint-ignore no-explicit-any
        options: (p.poll_options || []).map((o: any) => ({ label: o.label, votes: (p.poll_votes || []).filter((v: any) => v.option_id === o.id).length })),
        // deno-lint-ignore no-explicit-any
        voters: (p.poll_votes || []).map((v: any) => v.voter_id),
      })),
    };
  },

  async latestHumanCommentAt(ideaId) {
    const { data } = await db.from('comments').select('created_at').eq('idea_id', ideaId).eq('is_ai', false)
      .order('created_at', { ascending: false }).limit(1);
    return data && data[0] ? data[0].created_at : null;
  },

  async usage(ideaId, memberId, sinceHour, sinceDay) {
    const last = ideaId ? await db.from('ai_runs').select('created_at').eq('idea_id', ideaId).order('created_at', { ascending: false }).limit(1) : { data: null };
    const hour = await db.from('ai_runs').select('id', { count: 'exact', head: true }).eq('member_id', memberId).gte('created_at', sinceHour);
    const day = await db.from('ai_runs').select('id', { count: 'exact', head: true }).gte('created_at', sinceDay);
    // Brainstorm runs have no idea; they count toward the same limits and have their own, smaller hourly limit.
    const bHour = await db.from('ai_runs').select('id', { count: 'exact', head: true }).eq('member_id', memberId).is('idea_id', null).gte('created_at', sinceHour);
    const bLast = await db.from('ai_runs').select('created_at').eq('member_id', memberId).is('idea_id', null).order('created_at', { ascending: false }).limit(1);
    return { ideaLast: last.data && last.data[0] ? last.data[0].created_at : null, memberHour: hour.count || 0, dayTotal: day.count || 0, brainstormHour: bHour.count || 0, brainstormLast: bLast.data && bLast.data[0] ? bLast.data[0].created_at : null };
  },

  async recordRun(row) {
    const { data } = await db.from('ai_runs').insert(row).select('id').single();
    return data ? data.id : null;
  },

  async finishRun(runId, ok, inputTokens, outputTokens) {
    if (!runId) return;
    await db.from('ai_runs').update({ ok, input_tokens: inputTokens, output_tokens: outputTokens }).eq('id', runId);
  },

  callClaude: (system, user, tool, model, advisor, opts) => claude(system, user, tool, model, advisor, opts),

  async loadBoard() {
    const { data } = await db.from('ideas').select('title,status').order('created_at', { ascending: false }).limit(60);
    return (data || []).map((o: { title: string; status: string }) => ({ title: o.title, status: o.status }));
  },

  async save(ideaId, plan) {
    // Comments first, then the idea's update, so the "last updated" time is after the questions it asked.
    if (plan.newComments.length) {
      const { error } = await db.from('comments').insert(plan.newComments);
      if (error) throw error;
    }
    const { error } = await db.from('ideas').update(plan.ideaPatch).eq('id', ideaId);
    if (error) throw error;
  },
};

Deno.serve((req) => handle(req, deps));
