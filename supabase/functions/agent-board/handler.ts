// Request handler for the agent door. Everything outside (the database, the secret key) comes in through `deps`,
// so every path can be tested without the network.
import { checkTransition, NOTICE, parseRequest, shapeListItem, shapeThread } from './logic.ts';
import type { IdeaRow, Stats, ThreadIn } from './logic.ts';

export type Deps = {
  expectedKey: string; // the secret key; empty means "not set up"
  board: (status: string | null, limit: number) => Promise<{ idea: IdeaRow; stats: Stats }[]>;
  counts: () => Promise<Record<string, number>>;
  thread: (ideaId: string) => Promise<ThreadIn | null>;
  statusOf: (ideaId: string) => Promise<{ status: string; title: string } | null>;
  // Only changes the idea if it is still in `from` (so two quick requests cannot both win). Returns false if it was not.
  move: (ideaId: string, from: string, to: string, patch: { built_version: string | null }) => Promise<boolean>;
  addFeature: (ideaId: string, name: string, description: string, version: string) => Promise<void>;
  setOverview: (body: string) => Promise<void>;
  log: (action: string, ideaId: string | null, detail: Record<string, unknown>) => Promise<void>;
};

// Compare keys without leaking, through timing, how much of the key was right: hash both and compare every byte.
export async function sameKey(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < p.length; i++) d |= p[i] ^ q[i];
  return d === 0;
}

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ notice: NOTICE, ...body }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'POST only.' });

  // 1. The key. Without a long enough key set on the server, the door stays shut.
  if (!deps.expectedKey || deps.expectedKey.length < 32) return json(503, { error: 'Agent access is not set up.' });
  const given = req.headers.get('x-agent-key') || '';
  if (!given || !(await sameKey(given, deps.expectedKey))) return json(401, { error: 'Not allowed.' });

  // 2. What is being asked.
  let raw: unknown;
  try { raw = await req.json(); } catch (_) { return json(400, { error: 'Send JSON.' }); }
  const parsed = parseRequest(raw);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const r = parsed.req;

  try {
    if (r.action === 'ping') {
      return json(200, { ok: true, board: await deps.counts() });
    }

    if (r.action === 'list') {
      const rows = await deps.board(r.status, r.limit);
      await deps.log('list', null, { status: r.status, returned: rows.length });
      return json(200, { ok: true, counts: await deps.counts(), ideas: rows.map((x) => shapeListItem(x.idea, x.stats)) });
    }

    if (r.action === 'get') {
      const t = await deps.thread(r.idea_id);
      if (!t) return json(404, { error: 'That idea was not found.' });
      await deps.log('get', r.idea_id, { comments: t.comments.length });
      return json(200, { ok: true, idea: shapeThread(t) });
    }

    // set_status
    const cur = await deps.statusOf(r.idea_id);
    if (!cur) return json(404, { error: 'That idea was not found.' });
    if (cur.status === r.to) return json(200, { ok: true, unchanged: true, status: cur.status });
    const problem = checkTransition(cur.status, r.to);
    if (problem) {
      await deps.log('set_status_refused', r.idea_id, { from: cur.status, to: r.to });
      return json(409, { error: problem, status: cur.status });
    }
    const moved = await deps.move(r.idea_id, cur.status, r.to, { built_version: r.version });
    if (!moved) return json(409, { error: 'The idea changed while this was happening. Read it again.', status: (await deps.statusOf(r.idea_id))?.status });
    if (r.to === 'built') {
      await deps.addFeature(r.idea_id, r.feature_name, r.feature_description, r.version as string);
      if (r.overview) await deps.setOverview(r.overview);
    }
    await deps.log('set_status', r.idea_id, { from: cur.status, to: r.to, version: r.version, overview_updated: !!r.overview });
    return json(200, { ok: true, from: cur.status, status: r.to, title: cur.title });
  } catch (_) {
    return json(500, { error: 'Something went wrong on the server.' });
  }
}
