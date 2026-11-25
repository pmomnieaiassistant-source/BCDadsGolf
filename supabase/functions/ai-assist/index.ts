// Supabase Edge Function: the AI assistant for ideas.
// Secrets it needs (set by the deploy workflow, never in the repo): ANTHROPIC_API_KEY.
// Supabase supplies SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY itself.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './handler.ts';
import type { Deps } from './handler.ts';
import type { Bundle } from './logic.ts';
import { makeBlueprintLoader } from './blueprint.ts';

const env = (k: string, d = ''): string => Deno.env.get(k) ?? d;
const num = (k: string, d: number): number => { const n = Number(env(k)); return Number.isFinite(n) && n > 0 ? n : d; };

const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const MODEL = env('AI_MODEL', 'claude-haiku-5-5');
const loadBlueprint = makeBlueprintLoader((url, init) => fetch(url, init), () => Date.now());

const deps: Deps = {
  limits: { cooldownSec: num('AI_COOLDOWN_SEC', 90), memberHourly: num('AI_MEMBER_HOURLY', 30), dailyCap: num('AI_DAILY_CAP', 300) },
  now: () => new Date(),
  loadBlueprint,
  agentKey: env('AGENT_KEY'),
  model: MODEL,
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
      .select('id,title,body,status,summary,open_questions,spec,ai_updated_at,ready_by,author_id,author:members!author_id(name)')
      .eq('id', ideaId).maybeSingle();
    if (!idea) return null;
    const { data: comments } = await db.from('comments')
      .select('id,parent_id,is_ai,kind,body,author_id,created_at,author:members!author_id(name)')
      .eq('idea_id', ideaId).order('created_at', { ascending: true }).limit(200);
    const { data: polls } = await db.from('polls')
      .select('question,poll_options(id,label),poll_votes(option_id,voter_id)')
      .eq('idea_id', ideaId).order('created_at', { ascending: true });
    // deno-lint-ignore no-explicit-any
    const nameOf = (a: any) => (Array.isArray(a) ? a[0]?.name : a?.name) || '';
    return {
      idea: { ...idea, author_name: nameOf(idea.author) },
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
    const last = await db.from('ai_runs').select('created_at').eq('idea_id', ideaId).order('created_at', { ascending: false }).limit(1);
    const hour = await db.from('ai_runs').select('id', { count: 'exact', head: true }).eq('member_id', memberId).gte('created_at', sinceHour);
    const day = await db.from('ai_runs').select('id', { count: 'exact', head: true }).gte('created_at', sinceDay);
    return { ideaLast: last.data && last.data[0] ? last.data[0].created_at : null, memberHour: hour.count || 0, dayTotal: day.count || 0 };
  },

  async recordRun(row) {
    const { data } = await db.from('ai_runs').insert(row).select('id').single();
    return data ? data.id : null;
  },

  async finishRun(runId, ok, inputTokens, outputTokens) {
    if (!runId) return;
    await db.from('ai_runs').update({ ok, input_tokens: inputTokens, output_tokens: outputTokens }).eq('id', runId);
  },

  async callClaude(system, user, tool) {
    const key = env('ANTHROPIC_API_KEY');
    if (!key) throw new Error('missing key');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45_000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1800,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [tool],
          tool_choice: { type: 'tool', name: 'record_analysis' },
        }),
      });
      if (!res.ok) {
        // The kind of problem Anthropic reports (for example authentication_error or not_found_error): enough to fix it, never the key.
        let kind = '';
        try { const e = await res.json(); kind = String(e?.error?.type ?? '').replace(/[^a-z_]/g, '').slice(0, 40); } catch (_) { /* no body */ }
        throw new Error('claude ' + res.status + (kind ? ' ' + kind : ''));
      }
      const out = await res.json();
      // deno-lint-ignore no-explicit-any
      const block = (out.content || []).find((b: any) => b.type === 'tool_use');
      if (!block) throw new Error('no tool call');
      return { input: block.input, inputTokens: out.usage?.input_tokens ?? null, outputTokens: out.usage?.output_tokens ?? null };
    } finally {
      clearTimeout(timer);
    }
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
