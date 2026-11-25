// Spinning a discussion off into its own idea, tested on the real SQL. See _db.mjs for how to run these.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, ADMIN, DAD, STRANGER, freshDb, as, fails, q } from './_db.mjs';

let t = 0;
const idea = async (db, author = ADMIN, status = 'open', title = 'Source idea') =>
  (await q(db, `insert into public.ideas (author_id, title, body, status) values ($1, $2, 'b', $3) returning id`, [author, title, status]))[0].id;
const comment = async (db, ideaId, author, body, parent = null, isAi = false) =>
  (await q(db, `insert into public.comments (idea_id, parent_id, author_id, body, is_ai, created_at) values ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval) returning id`,
    [ideaId, parent, author, body, isAi, String(++t)]))[0].id;
const spin = (db, who, cid, title = 'A new idea', withReplies = true) =>
  as(db, who, () => q(db, 'select public.spin_off($1, $2, $3) as id', [cid, title, withReplies])).then(r => r[0].id);

test('a comment with all its replies becomes a new idea, with the real authors, linked both ways', { skip }, async () => {
  const db = await freshDb();
  const src = await idea(db, ADMIN, 'built', 'Handicap tracking');
  const top = await comment(db, src, ADMIN, 'What about teams?');
  const r1 = await comment(db, src, DAD, 'Two man scramble please', top);
  const r2 = await comment(db, src, ADMIN, 'And best ball', r1); // a reply to a reply
  await comment(db, src, DAD, 'Something unrelated'); // another top comment: must not come along
  const n = await spin(db, DAD, top, 'Team formats');
  const [i] = await q(db, 'select * from public.ideas where id = $1', [n]);
  assert.equal(i.author_id, DAD); assert.equal(i.status, 'open'); assert.equal(i.title, 'Team formats');
  assert.equal(i.source_idea_id, src); assert.equal(i.source_comment_id, top);
  assert.match(i.body, /Handicap tracking/);
  assert.ok(i.body.indexOf('Admin Paul: What about teams?') < i.body.indexOf('Dave: Two man scramble please'));
  assert.ok(i.body.indexOf('Dave: Two man scramble please') < i.body.indexOf('Admin Paul: And best ball'), 'nested replies come along, in order');
  assert.ok(!/unrelated/.test(i.body));
  const [note] = await q(db, 'select * from public.comments where spun_idea_id = $1', [n]);
  assert.equal(note.idea_id, src); assert.equal(note.author_id, DAD); assert.equal(note.parent_id, top);
  assert.match(note.body, /Team formats/);
  assert.ok(r2);
});

test('replies can be left behind, and a reply can be the one spun off', { skip }, async () => {
  const db = await freshDb();
  const src = await idea(db);
  const top = await comment(db, src, ADMIN, 'Top comment');
  const rep = await comment(db, src, DAD, 'A reply with its own idea', top);
  await comment(db, src, ADMIN, 'Deeper reply', rep);
  const a = (await q(db, 'select body from public.ideas where id = $1', [await spin(db, DAD, top, 'Just the top', false)]))[0].body;
  assert.ok(a.includes('Top comment') && !a.includes('A reply with'));
  const b = (await q(db, 'select body from public.ideas where id = $1', [await spin(db, DAD, rep, 'From a reply', true)]))[0].body;
  assert.ok(b.includes('A reply with its own idea') && b.includes('Deeper reply') && !b.includes('Top comment: '));
});

test('the assistant\'s questions can be spun off too', { skip }, async () => {
  const db = await freshDb();
  const src = await idea(db);
  const c = await comment(db, src, null, 'Should ties be split?', null, true);
  const [i] = await q(db, 'select body from public.ideas where id = $1', [await spin(db, DAD, c, 'Ties')]);
  assert.match(i.body, /Assistant: Should ties be split\?/);
});

test('photos come along, up to six', { skip }, async () => {
  const db = await freshDb();
  const src = await idea(db);
  const top = await comment(db, src, ADMIN, 'Look');
  const rep = await comment(db, src, DAD, 'Also', top);
  for (let k = 0; k < 4; k++) await q(db, `insert into public.attachments (idea_id, comment_id, uploader_id, path) values ($1, $2, $3, $4)`, [src, top, ADMIN, `p/top${k}.jpg`]);
  for (let k = 0; k < 4; k++) await q(db, `insert into public.attachments (idea_id, comment_id, uploader_id, path) values ($1, $2, $3, $4)`, [src, rep, DAD, `p/rep${k}.jpg`]);
  await q(db, `insert into public.attachments (idea_id, comment_id, uploader_id, path) values ($1, null, $2, 'p/other.jpg')`, [src, ADMIN]); // the idea's own photo: stays behind
  const n = await spin(db, DAD, top);
  const got = await q(db, 'select path, comment_id from public.attachments where idea_id = $1', [n]);
  assert.equal(got.length, 6); assert.ok(got.every(g => g.comment_id === null && !g.path.includes('other')));
  const m = await spin(db, DAD, top, 'No replies', false);
  assert.equal((await q(db, 'select 1 from public.attachments where idea_id = $1', [m])).length, 4);
});

test('members cannot fake the links or the note', { skip }, async () => {
  const db = await freshDb();
  const src = await idea(db, DAD);
  const top = await comment(db, src, DAD, 'A comment');
  const other = await idea(db, DAD, 'open', 'Other idea');
  // a new idea made by hand never carries a source
  const h = (await as(db, DAD, () => q(db, `insert into public.ideas (author_id, title, body, source_idea_id, source_comment_id) values ($1, 'By hand', 'b', $2, $3) returning id`, [DAD, src, top])))[0].id;
  assert.deepEqual((await q(db, 'select source_idea_id s, source_comment_id c from public.ideas where id = $1', [h]))[0], { s: null, c: null });
  // and cannot be edited into one
  await as(db, DAD, () => db.query(`update public.ideas set source_idea_id = $2 where id = $1`, [other, src]));
  assert.equal((await q(db, 'select source_idea_id s from public.ideas where id = $1', [other]))[0].s, null);
  // a "started a new idea" note cannot be posted or attached by hand
  await fails(as(db, DAD, () => db.query(`insert into public.comments (idea_id, author_id, body, spun_idea_id) values ($1, $2, 'fake', $3)`, [src, DAD, other])), /row-level security/i);
  const n = await spin(db, DAD, top);
  const [note] = await q(db, 'select id from public.comments where spun_idea_id = $1', [n]);
  await as(db, DAD, () => db.query(`update public.comments set spun_idea_id = $2 where id = $1`, [note.id, other]));
  assert.equal((await q(db, 'select spun_idea_id s from public.comments where id = $1', [note.id]))[0].s, n);
  await fails(spin(db, DAD, note.id), /cannot be turned into an idea/);
  // the old rules still hold: status stays locked
  await as(db, DAD, () => db.query(`update public.ideas set status = 'built' where id = $1`, [n]));
  assert.equal((await q(db, 'select status from public.ideas where id = $1', [n]))[0].status, 'open');
});

test('only members, with a real title and a real comment', { skip }, async () => {
  const db = await freshDb();
  const src = await idea(db);
  const top = await comment(db, src, ADMIN, 'Hello');
  await fails(spin(db, STRANGER, top), /Only members/);
  await fails(as(db, null, () => db.query('select public.spin_off($1, $2, true)', [top, 'Fine title']), 'anon'), /permission denied/i);
  await fails(spin(db, DAD, top, 'ab'), /title of 3 to 140/);
  await fails(spin(db, DAD, top, 'x'.repeat(141)), /title of 3 to 140/);
  await fails(spin(db, DAD, '00000000-0000-4000-8000-0000000000ff'), /not found/);
  assert.equal((await q(db, 'select count(*)::int n from public.ideas where source_idea_id is not null'))[0].n, 0);
});

test('ten new ideas an hour is the limit', { skip }, async () => {
  const db = await freshDb();
  const src = await idea(db);
  const top = await comment(db, src, ADMIN, 'Hello');
  for (let k = 0; k < 10; k++) await spin(db, DAD, top, `Idea number ${k}`, false);
  await fails(spin(db, DAD, top, 'One too many', false), /a lot of new ideas/);
  await spin(db, ADMIN, top, 'Someone else is fine', false); // the limit is per person
});

test('long discussions are trimmed to fit, and deleting either side leaves the other intact', { skip }, async () => {
  const db = await freshDb();
  const src = await idea(db);
  const top = await comment(db, src, ADMIN, 'x'.repeat(2500));
  await comment(db, src, DAD, 'y'.repeat(2500), top);
  await comment(db, src, DAD, 'z'.repeat(2500), top);
  const n = await spin(db, DAD, top);
  const [i] = await q(db, 'select body from public.ideas where id = $1', [n]);
  assert.ok(i.body.length <= 5000); assert.match(i.body, /\(Trimmed\.\)$/);
  // delete the new idea: the note stays in the original thread, as plain text
  await q(db, 'delete from public.ideas where id = $1', [n]);
  const [note] = await q(db, `select spun_idea_id s, body from public.comments where idea_id = $1 and body like 'Started a new idea%'`, [src]);
  assert.equal(note.s, null);
  // delete the original: the new idea survives, with no source
  const m = await spin(db, DAD, top, 'Second one', false);
  await q(db, 'delete from public.ideas where id = $1', [src]);
  assert.deepEqual((await q(db, 'select source_idea_id s, source_comment_id c from public.ideas where id = $1', [m]))[0], { s: null, c: null });
});
