// The blueprint loader (fetches docs/BLUEPRINT.md from GitHub) and the blueprint file itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeBlueprintLoader, BLUEPRINT, BLUEPRINT_URL } from '../supabase/functions/ai-assist/blueprint.ts';
import { LIMITS } from '../supabase/functions/ai-assist/logic.ts';

const ok = (text) => async () => ({ ok: true, text: async () => text });
function loader(fetchFn) { let t = 0; const calls = []; const l = makeBlueprintLoader(async (u, i) => { calls.push({ u, i }); return fetchFn(u, i); }, () => t, 'https://example.test/bp.md'); return { l, calls, tick: (ms) => { t += ms; } }; }

test('loads the blueprint, asks only for the public file, and sends nothing else', async () => {
  const { l, calls } = loader(ok('  Hello blueprint  '));
  assert.equal(await l(), 'Hello blueprint');
  assert.equal(calls.length, 1); assert.equal(calls[0].u, 'https://example.test/bp.md');
  assert.deepEqual(Object.keys(calls[0].i).sort(), ['headers', 'signal']);
  assert.deepEqual(calls[0].i.headers, { accept: 'text/plain' }, 'no keys, no tokens, no member data');
  assert.match(BLUEPRINT_URL, /^https:\/\/raw\.githubusercontent\.com\/pmomnieaiassistant-source\/BCDadsGolf\/main\/docs\/BLUEPRINT\.md$/);
});

test('it is cached for a few minutes, then fetched again', async () => {
  const { l, calls, tick } = loader(ok('v1'));
  await l(); await l(); tick(BLUEPRINT.ttlMs - 1); await l();
  assert.equal(calls.length, 1);
  tick(2); await l();
  assert.equal(calls.length, 2);
});

test('when GitHub fails: no blueprint the first time, the last good copy after that', async () => {
  let fail = true;
  const { l, tick } = loader(async () => { if (fail) throw new Error('down'); return { ok: true, text: async () => 'good copy' }; });
  assert.equal(await l(), null);
  fail = false; assert.equal(await l(), 'good copy');
  fail = true; tick(BLUEPRINT.ttlMs + 1); assert.equal(await l(), 'good copy', 'an old copy beats none');
});

test('error pages, empty files and giant files are not used', async () => {
  assert.equal(await loader(async () => ({ ok: false, text: async () => '404: Not Found' })).l(), null);
  assert.equal(await loader(ok('   ')).l(), null);
  assert.equal(await loader(ok('x'.repeat(BLUEPRINT.maxBytes + 1))).l(), null);
});

test('the blueprint file exists, says which version it covers, and fits the prompt without being cut off', () => {
  const text = fs.readFileSync(new URL('../docs/BLUEPRINT.md', import.meta.url), 'utf8');
  assert.match(text, /^# /);
  assert.match(text, /Last updated for version \d+\.\d+\.\d+\./);
  assert.ok(text.length <= LIMITS.maxBlueprintChars, `blueprint is ${text.length} characters; the assistant reads at most ${LIMITS.maxBlueprintChars}`);
  assert.ok(text.length > 300, 'not empty');
});
