// Supabase Edge Function: the narrow door Claude Code uses to read the ideas board and move ideas along.
// Needs the secret AGENT_KEY (set by the deploy workflow from the GitHub secret of the same name; at least 32 characters).
// Supabase supplies SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY itself.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './handler.ts';
import type { Deps } from './handler.ts';

const env = (k: string, d = ''): string => Deno.env.get(k) ?? d;
const URL_ = env('SUPABASE_URL');
const db = createClient(URL_, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });

// deno-lint-ignore no-explicit-any
const nameOf = (a: any): string => (Array.isArray(a) ? a[0]?.name : a?.name) || '';
// Always say WHICH link to members is the author: ideas and comments are linked to members twice (author and likes).
const IDEA_COLS = 'id,title,body,status,summary,open_questions,answered_qa,spec,built_version,created_at,last_activity_at,author:members!author_id(name)';

const deps: Deps = {
  expectedKey: env('AGENT_KEY'),

  async board(status, limit) {
    let q = db.from('ideas').select(IDEA_COLS).order('created_at', { ascending: false }).limit(limit);
    if (status) q = q.eq('status', status);
    const { data: ideas, error } = await q;
    if (error) throw error;
    const ids = (ideas || []).map((i) => i.id);
    const stats: Record<string, { comments: number; people: Set<string>; likes: number }> = {};
    for (const id of ids) stats[id] = { comments: 0, people: new Set(), likes: 0 };
    if (ids.length) {
      const [c, l] = await Promise.all([
        db.from('comments').select('idea_id,author_id,is_ai').in('idea_id', ids).limit(5000),
        db.from('idea_likes').select('idea_id').in('idea_id', ids).limit(5000),
      ]);
      for (const x of c.data || []) { const s = stats[x.idea_id]; if (!s) continue; s.comments++; if (!x.is_ai && x.author_id) s.people.add(x.author_id); }
      for (const x of l.data || []) { const s = stats[x.idea_id]; if (s) s.likes++; }
    }
    // deno-lint-ignore no-explicit-any
    return (ideas || []).map((i: any) => ({
      idea: { ...i, author_name: nameOf(i.author) },
      stats: { comments: stats[i.id].comments, people: stats[i.id].people.size, likes: stats[i.id].likes },
    }));
  },

  async counts() {
    const out: Record<string, number> = { open: 0, ready: 0, building: 0, built: 0 };
    for (const s of Object.keys(out)) {
      const { count } = await db.from('ideas').select('id', { count: 'exact', head: true }).eq('status', s);
      out[s] = count || 0;
    }
    return out;
  },

  async thread(ideaId) {
    const { data: idea } = await db.from('ideas').select(IDEA_COLS).eq('id', ideaId).maybeSingle();
    if (!idea) return null;
    const [c, p, a, l] = await Promise.all([
      db.from('comments').select('id,parent_id,is_ai,kind,body,created_at,author:members!author_id(name)').eq('idea_id', ideaId).order('created_at').limit(500),
      db.from('polls').select('question,poll_options(id,label),poll_votes(option_id)').eq('idea_id', ideaId).order('created_at'),
      db.from('attachments').select('path').eq('idea_id', ideaId).order('created_at').limit(50),
      db.from('idea_likes').select('idea_id', { count: 'exact', head: true }).eq('idea_id', ideaId),
    ]);
    return {
      // deno-lint-ignore no-explicit-any
      idea: { ...(idea as any), author_name: nameOf((idea as any).author) },
      // deno-lint-ignore no-explicit-any
      comments: (c.data || []).map((x: any) => ({ ...x, author_name: nameOf(x.author) })),
      // deno-lint-ignore no-explicit-any
      polls: (p.data || []).map((x: any) => ({
        question: x.question,
        // deno-lint-ignore no-explicit-any
        options: (x.poll_options || []).map((o: any) => ({ label: o.label, votes: (x.poll_votes || []).filter((v: any) => v.option_id === o.id).length })),
      })),
      // deno-lint-ignore no-explicit-any
      photos: (a.data || []).map((x: any) => `${URL_}/storage/v1/object/public/photos/${x.path}`),
      likes: l.count || 0,
    };
  },

  async statusOf(ideaId) {
    const { data } = await db.from('ideas').select('status,title').eq('id', ideaId).maybeSingle();
    return data ? { status: data.status, title: data.title } : null;
  },

  async move(ideaId, from, to, patch) {
    const upd: Record<string, unknown> = { status: to };
    if (to === 'built') { upd.built_version = patch.built_version; upd.built_at = new Date().toISOString(); }
    // Only if it is still in `from`: two quick requests cannot both win.
    const { data, error } = await db.from('ideas').update(upd).eq('id', ideaId).eq('status', from).select('id');
    if (error) throw error;
    return !!(data && data.length);
  },

  async addFeature(ideaId, name, description, version) {
    const { data } = await db.from('features').select('id').eq('idea_id', ideaId).limit(1);
    if (data && data.length) return;
    const { error } = await db.from('features').insert({ idea_id: ideaId, name, description, version });
    if (error) throw error;
  },

  async setOverview(body) {
    const { error } = await db.from('overview').update({ body, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) throw error;
  },

  async log(action, ideaId, detail) {
    await db.from('agent_log').insert({ action, idea_id: ideaId, detail }).then(() => {}, () => {});
  },
};

Deno.serve((req) => handle(req, deps));
