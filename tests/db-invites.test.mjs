// Invite link rules, tested on the real SQL. See _db.mjs for how to run these.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, ADMIN, DAD, NEW1, NEW2, NEW3, STRANGER, freshDb, as, fails, q, memberCount } from './_db.mjs';

test('the group-code join still works', { skip }, async () => {
  const db = await freshDb();
  assert.equal(await memberCount(db), 2);
  assert.equal((await q(db, 'select is_admin from public.members where id=$1', [ADMIN]))[0].is_admin, true);
  assert.equal((await q(db, 'select is_admin from public.members where id=$1', [DAD]))[0].is_admin, false);
});

test('only admins can create, see or cancel invites', { skip }, async () => {
  const db = await freshDb();
  await fails(as(db, DAD, () => db.query('select public.create_invite(7, 10)')), /Only admins/);
  await fails(as(db, STRANGER, () => db.query('select public.create_invite(7, 10)')), /Only admins/);
  await fails(as(db, null, () => db.query('select public.create_invite(7, 10)'), 'anon'), /permission denied/i);
  const inv = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 10) as i')))[0].i;
  assert.match(inv.token, /^[0-9a-f]{32}$/);
  assert.equal((await as(db, ADMIN, () => q(db, 'select * from public.invites'))).length, 1, 'admin sees it');
  assert.equal((await as(db, DAD, () => q(db, 'select * from public.invites'))).length, 0, 'a regular member sees nothing');
  await fails(as(db, DAD, () => db.query('select public.revoke_invite($1)', [inv.token])), /Only admins/);
  await fails(as(db, DAD, () => db.query(`insert into public.invites (expires_at, max_uses) values (now() + interval '1 day', 5)`)), /permission denied/i);
  await fails(as(db, ADMIN, () => db.query(`insert into public.invites (expires_at, max_uses) values (now() + interval '1 day', 5)`)), /permission denied/i);
  await fails(as(db, ADMIN, () => db.query(`update public.invites set max_uses = 100`)), /permission denied/i);
});

test('invite limits are enforced when creating', { skip }, async () => {
  const db = await freshDb();
  for (const [d, u] of [[0, 5], [31, 5], [7, 0], [7, 51], [null, 5]]) await fails(as(db, ADMIN, () => db.query('select public.create_invite($1, $2)', [d, u])), /invite can/i);
});

test('joining with a good link makes a regular member and uses one place', { skip }, async () => {
  const db = await freshDb();
  const { token } = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 2) as i')))[0].i;
  const r = (await as(db, NEW1, () => q(db, 'select public.join_with_invite($1, $2) as r', [token, '  Mike  '])))[0].r;
  assert.equal(r.is_admin, false);
  const m = (await q(db, 'select name, is_admin from public.members where id=$1', [NEW1]))[0];
  assert.deepEqual(m, { name: 'Mike', is_admin: false });
  assert.equal((await q(db, 'select uses from public.invites where token=$1', [token]))[0].uses, 1);
});

test('someone already in the group is not charged a use, and cannot become admin through a link', { skip }, async () => {
  const db = await freshDb();
  const { token } = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 2) as i')))[0].i;
  const r = (await as(db, DAD, () => q(db, 'select public.join_with_invite($1, $2) as r', [token, 'Dave Again'])))[0].r;
  assert.equal(r.already, true); assert.equal(r.is_admin, false);
  assert.equal((await q(db, 'select uses from public.invites where token=$1', [token]))[0].uses, 0);
  assert.equal((await q(db, 'select name from public.members where id=$1', [DAD]))[0].name, 'Dave', 'name unchanged');
});

test('a link stops working once it is full', { skip }, async () => {
  const db = await freshDb();
  const { token } = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 2) as i')))[0].i;
  await as(db, NEW1, () => db.query('select public.join_with_invite($1, $2)', [token, 'One']));
  await as(db, NEW2, () => db.query('select public.join_with_invite($1, $2)', [token, 'Two']));
  await fails(as(db, NEW3, () => db.query('select public.join_with_invite($1, $2)', [token, 'Three'])), /not valid or has expired/);
  assert.equal(await memberCount(db), 4, 'only two joined');
  assert.equal((await q(db, 'select uses from public.invites where token=$1', [token]))[0].uses, 2);
});

test('expired, cancelled and made-up links are all refused the same way', { skip }, async () => {
  const db = await freshDb();
  const a = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 5) as i')))[0].i.token;
  const b = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 5) as i')))[0].i.token;
  await db.query(`update public.invites set expires_at = now() - interval '1 minute' where token = $1`, [a]); // expired
  await as(db, ADMIN, () => db.query('select public.revoke_invite($1)', [b]));                              // cancelled
  for (const t of [a, b, 'deadbeef', '', null, `' or 1=1 --`]) {
    await fails(as(db, NEW1, () => db.query('select public.join_with_invite($1, $2)', [t, 'Mike'])), /not valid or has expired/);
  }
  assert.equal(await memberCount(db), 2, 'nobody got in');
});

test('cancelling a link keeps people who already joined with it', { skip }, async () => {
  const db = await freshDb();
  const { token } = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 5) as i')))[0].i;
  await as(db, NEW1, () => db.query('select public.join_with_invite($1, $2)', [token, 'Mike']));
  await as(db, ADMIN, () => db.query('select public.revoke_invite($1)', [token]));
  assert.equal(await memberCount(db), 3);
  await fails(as(db, NEW2, () => db.query('select public.join_with_invite($1, $2)', [token, 'Late'])), /not valid or has expired/);
});

test('a bad name is refused without using up a place', { skip }, async () => {
  const db = await freshDb();
  const { token } = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 1) as i')))[0].i;
  await fails(as(db, NEW1, () => db.query('select public.join_with_invite($1, $2)', [token, 'x'])), /Name must be/);
  await fails(as(db, NEW1, () => db.query('select public.join_with_invite($1, $2)', [token, 'y'.repeat(41)])), /Name must be/);
  assert.equal((await q(db, 'select uses from public.invites where token=$1', [token]))[0].uses, 0);
  await as(db, NEW2, () => db.query('select public.join_with_invite($1, $2)', [token, 'Okay']));
  assert.equal(await memberCount(db), 3);
});

test('visitors who are not signed in cannot use an invite, and a new member gets no extra powers', { skip }, async () => {
  const db = await freshDb();
  const { token } = (await as(db, ADMIN, () => q(db, 'select public.create_invite(7, 5) as i')))[0].i;
  await fails(as(db, null, () => db.query('select public.join_with_invite($1, $2)', [token, 'Mike']), 'anon'), /permission denied/i);
  await as(db, NEW1, () => db.query('select public.join_with_invite($1, $2)', [token, 'Mike']));
  await fails(as(db, NEW1, () => db.query('select public.create_invite(7, 5)')), /Only admins/);
  assert.equal((await as(db, NEW1, () => q(db, 'select * from public.invites'))).length, 0);
  assert.equal((await as(db, NEW1, () => q(db, 'select * from public.settings').catch(e => 'denied'))), 'denied', 'the join codes stay hidden');
});
