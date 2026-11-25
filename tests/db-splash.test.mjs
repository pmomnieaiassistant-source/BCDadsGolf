// Splash screen rules, tested on the real SQL. See _db.mjs for how to run these.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skip, ADMIN, DAD, NEW1, STRANGER, freshDb, as, fails, q } from './_db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPLASH_SQL = fs.readFileSync(path.join(here, '..', 'supabase', 'migrations', '20261125010000_splash.sql'), 'utf8');

test('the how-it-works screen is seeded: five pages, plain text, only known icons', { skip }, async () => {
  const db = await freshDb();
  const s = (await q(db, `select * from public.splashes where id = 'howto-v1'`))[0];
  assert.equal(s.kind, 'howto'); assert.equal(s.active, true); assert.equal(s.pages.length, 5);
  const allowed = new Set(['flag', 'ideas', 'reply', 'sparkle', 'star', 'chat']);
  for (const p of s.pages) { assert.ok(allowed.has(p.icon), p.icon); assert.ok(p.title && p.body); assert.ok(!/[<>]/.test(p.title + p.body), 'no markup'); }
});

test('the guide says how ideas become features, and names nobody', { skip }, async () => {
  const db = await freshDb();
  const pages = (await q(db, `select pages from public.splashes where id = 'howto-v1'`))[0].pages;
  const text = pages.map(p => p.title + ' ' + p.body).join(' ');
  assert.ok(!/paul/i.test(text), 'no one is named');
  assert.match(text, /talks an idea through/i); assert.match(text, /build queue/i); assert.match(text, /Claude builds it/i); assert.match(text, /Features tab/i);
  assert.equal(pages.length, 5);
  assert.equal(pages.at(-1).title, 'From idea to feature');
  assert.match(pages[0].body, /Build is where we decide/); assert.ok(!/\bCreate\b/.test(text), 'the toggle says Build now, so the guide must too');
});

test('members can read the screens; people who are not members or not signed in cannot', { skip }, async () => {
  const db = await freshDb();
  assert.equal((await as(db, DAD, () => q(db, 'select id from public.splashes'))).length, 1);
  assert.equal((await as(db, STRANGER, () => q(db, 'select id from public.splashes'))).length, 0, 'signed in but not a member: sees nothing');
  await fails(as(db, null, () => db.query('select * from public.splashes'), 'anon'), /permission denied/i);
  await db.query(`update public.splashes set active = false where id = 'howto-v1'`);
  assert.equal((await as(db, DAD, () => q(db, 'select id from public.splashes'))).length, 0, 'switched-off screens are hidden');
});

test('nobody can change or add screens from the app, not even an admin', { skip }, async () => {
  const db = await freshDb();
  for (const who of [DAD, ADMIN]) {
    await fails(as(db, who, () => db.query(`insert into public.splashes (id, kind, title, pages) values ('evil-x', 'whatsnew', 'Hi', '[{"title":"a","body":"b"}]')`)), /permission denied/i);
    await fails(as(db, who, () => db.query(`update public.splashes set title = 'changed'`)), /permission denied/i);
    await fails(as(db, who, () => db.query(`delete from public.splashes`)), /permission denied/i);
  }
});

test('"Don\'t show again" is per member: you can save, see and undo only your own', { skip }, async () => {
  const db = await freshDb();
  await as(db, DAD, () => db.query(`insert into public.splash_hidden (member_id, splash_id) values ($1, 'howto-v1')`, [DAD]));
  assert.equal((await as(db, DAD, () => q(db, 'select * from public.splash_hidden'))).length, 1);
  assert.equal((await as(db, ADMIN, () => q(db, 'select * from public.splash_hidden'))).length, 0, 'someone else sees nothing');
  await fails(as(db, ADMIN, () => db.query(`insert into public.splash_hidden (member_id, splash_id) values ($1, 'howto-v1')`, [DAD])), /row-level security/i); // hide on someone else's behalf
  await fails(as(db, DAD, () => db.query(`insert into public.splash_hidden (member_id, splash_id) values ($1, 'howto-v1')`, [DAD])), /duplicate key/i);  // twice
  await as(db, ADMIN, () => db.query(`delete from public.splash_hidden`));
  assert.equal((await q(db, 'select * from public.splash_hidden')).length, 1, "an admin cannot undo someone else's choice");
  await as(db, DAD, () => db.query('delete from public.splash_hidden'));
  assert.equal((await q(db, 'select * from public.splash_hidden')).length, 0, 'you can undo your own');
  await fails(as(db, STRANGER, () => db.query(`insert into public.splash_hidden (member_id, splash_id) values ($1, 'howto-v1')`, [STRANGER])), /row-level security/i); // not a member
});

test('a screen needs 1 to 8 pages and a valid id and kind', { skip }, async () => {
  const db = await freshDb();
  const ins = (id, kind, pages) => db.query(`insert into public.splashes (id, kind, title, pages) values ($1, $2, 'T', $3::jsonb)`, [id, kind, pages]);
  await fails(ins('ok-1', 'whatsnew', '[]'), /check/i);
  await fails(ins('ok-2', 'whatsnew', JSON.stringify(Array(9).fill({ title: 'a', body: 'b' }))), /check/i);
  await fails(ins('ok-3', 'whatsnew', '{"not":"a list"}'), /check/i);
  await fails(ins('Bad Id!', 'whatsnew', '[{"title":"a","body":"b"}]'), /check/i);
  await fails(ins('ok-4', 'surprise', '[{"title":"a","body":"b"}]'), /check/i);
  await ins('whatsnew-v1', 'whatsnew', '[{"title":"a","body":"b"}]');
});

test('the migration is safe to run twice', { skip }, async () => {
  const db = await freshDb();
  await db.exec(SPLASH_SQL);
  assert.equal((await q(db, 'select * from public.splashes')).length, 1);
});
