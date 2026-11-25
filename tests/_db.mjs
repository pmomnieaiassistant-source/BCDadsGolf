// Shared setup for the database tests: the real SQL (every file in supabase/migrations, in order) on an in-process Postgres.
// Needs @electric-sql/pglite; if it is not installed the database tests skip. To run them:
//   PGLITE_DIR=/path/to/node_modules/@electric-sql/pglite node --test tests/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let PGlite = null;
try {
  const entry = process.env.PGLITE_DIR ? pathToFileURL(path.join(process.env.PGLITE_DIR, 'dist/index.js')).href : '@electric-sql/pglite';
  ({ PGlite } = await import(entry));
} catch (_) { /* skip below */ }

export const skip = PGlite ? false : 'pglite not installed';
export const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ADMIN = U(1), DAD = U(2), NEW1 = U(3), NEW2 = U(4), NEW3 = U(5), NEW4 = U(6), STRANGER = U(7);

// The bits of Supabase the migrations lean on, faked just enough to run them.
const STUBS = `
  create schema auth; create schema storage;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
  grant usage on schema auth, storage to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant select, insert on storage.objects to authenticated;
`;

export async function freshDb() {
  const db = new PGlite();
  await db.exec(STUBS);
  const dir = path.join(here, '..', 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    let sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '');
    await db.exec(sql);
  }
  for (const n of [ADMIN, DAD, NEW1, NEW2, NEW3, NEW4, STRANGER]) await db.query('insert into auth.users (id) values ($1)', [n]);
  // Two existing members, joined the normal way, with the group codes from schema.sql
  await as(db, ADMIN, () => db.query(`select public.join_group('CHANGE-ME-ADMIN', 'Admin Paul')`));
  await as(db, DAD, () => db.query(`select public.join_group('CHANGE-ME-INVITE', 'Dave')`));
  return db;
}
// Run something as a signed-in user (role "authenticated" with that user id), like Supabase does for a browser.
export async function as(db, uid, fn, role = 'authenticated') {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
export const fails = async (p, re) => { await assert.rejects(p, re); };
export const q = (db, sql, args) => db.query(sql, args).then(r => r.rows);
export const memberCount = db => q(db, 'select count(*)::int n from public.members').then(r => r[0].n);

