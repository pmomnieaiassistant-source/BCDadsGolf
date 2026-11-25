// The agent door's database side, tested on the real SQL. See _db.mjs for how to run these.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, ADMIN, DAD, freshDb, as, fails, q } from './_db.mjs';

test('members and visitors cannot read or write the agent log', { skip }, async () => {
  const db = await freshDb();
  for (const who of [DAD, ADMIN]) {
    await fails(as(db, who, () => db.query('select * from public.agent_log')), /permission denied/i);
    await fails(as(db, who, () => db.query(`insert into public.agent_log (action) values ('x')`)), /permission denied/i);
  }
  await fails(as(db, null, () => db.query('select * from public.agent_log'), 'anon'), /permission denied/i);
});

test('the function (service role) can do exactly what the agent door needs', { skip }, async () => {
  const db = await freshDb();
  const idea = (await q(db, `insert into public.ideas (author_id, title, body, status) values ($1, 'Test idea', 'b', 'ready') returning id`, [DAD]))[0].id;
  const sr = fn => as(db, null, fn, 'service_role');
  await sr(() => db.query(`insert into public.agent_log (action, idea_id, detail) values ('set_status', $1, '{"to":"building"}')`, [idea]));
  assert.equal((await sr(() => q(db, 'select action from public.agent_log')))[0].action, 'set_status');
  // move an idea along, add the feature, rewrite the overview
  assert.equal((await sr(() => db.query(`update public.ideas set status = 'building' where id = $1 and status = 'ready' returning id`, [idea]))).rows.length, 1);
  assert.equal((await sr(() => db.query(`update public.ideas set status = 'building' where id = $1 and status = 'ready' returning id`, [idea]))).rows.length, 0, 'compare-and-set: a second try finds nothing');
  await sr(() => db.query(`update public.ideas set status = 'built', built_version = '0.5.0', built_at = now() where id = $1`, [idea]));
  await sr(() => db.query(`insert into public.features (idea_id, name, description, version) values ($1, 'Thing', 'It does a thing.', '0.5.0')`, [idea]));
  await sr(() => db.query(`update public.overview set body = 'New overview text here.' where id = 1`));
  const i = (await q(db, 'select status, built_version from public.ideas where id = $1', [idea]))[0];
  assert.deepEqual(i, { status: 'built', built_version: '0.5.0' });
  // reading the board
  for (const t of ['ideas', 'comments', 'polls', 'poll_options', 'poll_votes', 'attachments', 'idea_likes', 'members', 'features']) await sr(() => db.query(`select 1 from public.${t} limit 1`));
});

test('the agent door cannot see the join codes', { skip }, async () => {
  const db = await freshDb();
  await fails(as(db, null, () => db.query('select * from public.settings'), 'service_role'), /permission denied/i);
});
