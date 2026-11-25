// The "Ready to build" button, tested on the real SQL. See _db.mjs for how to run these.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, ADMIN, DAD, STRANGER, freshDb, as, fails, q } from './_db.mjs';

const mk = async (db, author = ADMIN, status = 'open') =>
  (await q(db, `insert into public.ideas (author_id, title, body, status) values ($1, 'Test idea', 'b', $2) returning id`, [author, status]))[0].id;
const row = async (db, id) => (await q(db, 'select status, ready_by from public.ideas where id = $1', [id]))[0];

test('any member can mark an idea Ready to build, and take it back', { skip }, async () => {
  const db = await freshDb();
  const id = await mk(db, ADMIN); // someone else's idea
  const r = await as(db, DAD, () => q(db, 'select public.set_ready($1, true) as r', [id]));
  assert.equal(r[0].r.status, 'ready');
  assert.deepEqual(await row(db, id), { status: 'ready', ready_by: DAD });
  await as(db, DAD, () => db.query('select public.set_ready($1, false)', [id]));
  assert.deepEqual(await row(db, id), { status: 'open', ready_by: null });
});

test('once an idea is Building or Built, members cannot change it', { skip }, async () => {
  const db = await freshDb();
  for (const st of ['building', 'built']) {
    const id = await mk(db, DAD, st);
    await fails(as(db, DAD, () => db.query('select public.set_ready($1, false)', [id])), /already being built/);
    await fails(as(db, DAD, () => db.query('select public.set_ready($1, true)', [id])), /already being built/);
    assert.equal((await row(db, id)).status, st);
  }
});

test('Claude (the service role) still moves Ready -> Building -> Built', { skip }, async () => {
  const db = await freshDb();
  const id = await mk(db, DAD);
  await as(db, DAD, () => db.query('select public.set_ready($1, true)', [id]));
  const sr = sql => as(db, null, () => db.query(sql, [id]), 'service_role');
  await sr(`update public.ideas set status = 'building' where id = $1 and status = 'ready'`);
  assert.equal((await row(db, id)).status, 'building');
  await fails(as(db, DAD, () => db.query('select public.set_ready($1, false)', [id])), /already being built/);
  await sr(`update public.ideas set status = 'built' where id = $1`);
  assert.equal((await row(db, id)).status, 'built');
});

test('members cannot change status or ready_by any other way', { skip }, async () => {
  const db = await freshDb();
  const id = await mk(db, DAD);
  for (const sql of [
    `update public.ideas set status = 'ready' where id = $1`,
    `update public.ideas set status = 'building' where id = $1`,
    `update public.ideas set status = 'built' where id = $1`,
    `update public.ideas set ready_by = '${DAD}' where id = $1`,
  ]) {
    await as(db, DAD, () => db.query(sql, [id]));
    assert.deepEqual(await row(db, id), { status: 'open', ready_by: null }, sql);
  }
  // the flag does not leak: after a real toggle, a direct edit is still ignored
  await as(db, DAD, () => db.query('select public.set_ready($1, true)', [id]));
  await as(db, DAD, () => db.query(`update public.ideas set status = 'building', ready_by = null where id = $1`, [id]));
  assert.deepEqual(await row(db, id), { status: 'ready', ready_by: DAD });
  // a new idea always starts Open, with nobody marked
  const n = (await as(db, DAD, () => q(db, `insert into public.ideas (author_id, title, body, status, ready_by) values ($1, 'Sneaky one', 'b', 'ready', $1) returning id`, [DAD])))[0].id;
  assert.deepEqual(await row(db, n), { status: 'open', ready_by: null });
});

test('only members can use it', { skip }, async () => {
  const db = await freshDb();
  const id = await mk(db, DAD);
  await fails(as(db, STRANGER, () => db.query('select public.set_ready($1, true)', [id])), /Only members/);
  await fails(as(db, null, () => db.query('select public.set_ready($1, true)', [id]), 'anon'), /permission denied/i);
  await fails(as(db, DAD, () => db.query('select public.set_ready($1, true)', ['00000000-0000-4000-8000-0000000000ff'])), /not found/);
  assert.equal((await row(db, id)).status, 'open');
});
