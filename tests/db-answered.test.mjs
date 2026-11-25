// The answered Q&As column, tested on the real SQL. See _db.mjs for how to run these.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, ADMIN, DAD, freshDb, as, q } from './_db.mjs';

const QA = [{ question: 'Season length?', answer: 'A calendar year.' }];
const mk = async (db, author = DAD) => (await q(db, `insert into public.ideas (author_id, title, body) values ($1, 'Test idea', 'b') returning id`, [author]))[0].id;
const qa = async (db, id) => (await q(db, 'select answered_qa a from public.ideas where id = $1', [id]))[0].a;

test('new ideas start with no answered questions', { skip }, async () => {
  const db = await freshDb();
  assert.deepEqual(await qa(db, await mk(db)), []);
});

test('only the assistant (service role) and admins can write the answered Q&As; members cannot', { skip }, async () => {
  const db = await freshDb();
  const id = await mk(db, DAD);
  // a member cannot set it on their own idea, by update or at creation
  await as(db, DAD, () => db.query(`update public.ideas set answered_qa = $2::jsonb where id = $1`, [id, JSON.stringify(QA)]));
  assert.deepEqual(await qa(db, id), [], 'a member update is ignored');
  const n = (await as(db, DAD, () => q(db, `insert into public.ideas (author_id, title, body, answered_qa) values ($1, 'Sneaky', 'b', $2::jsonb) returning id`, [DAD, JSON.stringify(QA)])))[0].id;
  assert.deepEqual(await qa(db, n), [], 'a member insert starts empty');
  // the assistant can
  await as(db, null, () => db.query(`update public.ideas set answered_qa = $2::jsonb where id = $1`, [id, JSON.stringify(QA)]), 'service_role');
  assert.deepEqual(await qa(db, id), QA);
  // and a member still cannot change or clear it afterwards
  await as(db, DAD, () => db.query(`update public.ideas set answered_qa = '[]'::jsonb, title = 'Renamed' where id = $1`, [id]));
  assert.deepEqual(await qa(db, id), QA);
  assert.equal((await q(db, 'select title from public.ideas where id = $1', [id]))[0].title, 'Renamed', 'ordinary edits still work');
  // an admin can
  await as(db, ADMIN, () => db.query(`update public.ideas set answered_qa = '[]'::jsonb where id = $1`, [id]));
  assert.deepEqual(await qa(db, id), []);
});

test('the older protections still hold after the guard was replaced', { skip }, async () => {
  const db = await freshDb();
  const id = await mk(db, DAD);
  await as(db, DAD, () => db.query(`update public.ideas set status = 'built', summary = 'x', spec = 'y', open_questions = '["q"]'::jsonb where id = $1`, [id]));
  const [i] = await q(db, 'select status, summary, spec, open_questions oq from public.ideas where id = $1', [id]);
  assert.deepEqual(i, { status: 'open', summary: null, spec: null, oq: [] });
  // the Ready switch and spin-off flag logic still work
  await as(db, DAD, () => db.query('select public.set_ready($1, true)', [id]));
  assert.equal((await q(db, 'select status from public.ideas where id = $1', [id]))[0].status, 'ready');
});
