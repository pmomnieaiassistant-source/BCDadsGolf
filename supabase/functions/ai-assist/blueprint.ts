// Loads the app blueprint (docs/BLUEPRINT.md) from the public GitHub repo, so what the assistant knows about the app
// is whatever is on main right now. Nothing about members or ideas is sent: it is a plain GET of a public file.
// It never blocks the assistant: slow, missing or odd answers mean "no blueprint this time" (or the last good copy).

export const BLUEPRINT_URL = 'https://raw.githubusercontent.com/pmomnieaiassistant-source/BCDadsGolf/main/docs/BLUEPRINT.md';
export const BLUEPRINT = { ttlMs: 5 * 60_000, timeoutMs: 3000, maxBytes: 100_000 };

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; text: () => Promise<string> }>;

export function makeBlueprintLoader(fetchFn: Fetch, now: () => number, url: string = BLUEPRINT_URL) {
  let cached: { text: string; at: number } | null = null;
  return async function loadBlueprint(): Promise<string | null> {
    if (cached && now() - cached.at < BLUEPRINT.ttlMs) return cached.text;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(BLUEPRINT.timeoutMs), headers: { accept: 'text/plain' } });
      if (!res.ok) throw new Error('not ok');
      const text = (await res.text()).trim();
      if (!text || text.length > BLUEPRINT.maxBytes) throw new Error('empty or too big');
      cached = { text, at: now() };
      return text;
    } catch (_) {
      return cached ? cached.text : null; // an old copy is better than none
    }
  };
}
