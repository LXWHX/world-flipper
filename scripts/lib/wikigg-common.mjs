// Shared helpers for the worldflipper.wiki.gg (English) pipeline.
//
// Unlike the biligame scrapers this source has a full public MediaWiki Action API, so nothing here
// parses HTML: we ask for raw wikitext (`prop=revisions&rvslots=main`) 50 titles at a time and read
// the flat template parameters the wiki's own templates ({{Unit}}, {{Armament}}, ...) are built on.
// That is both far cheaper (379 unit pages ≈ 8 requests) and far more stable than scraping the
// rendered page. HTTP manners (User-Agent, delay, retries) are reused from wiki-common.mjs so all
// pipelines behave the same way against their upstreams.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { politeFetch } from './wiki-common.mjs';

export const WIKIGG_BASE = 'https://worldflipper.wiki.gg';
export const WIKIGG_API = `${WIKIGG_BASE}/api.php`;
const CACHE_DIR = path.resolve('scripts/.wikigg-cache');
const DELAY_MS = 400;

// wiki.gg is a normal MediaWiki behind Cloudflare; a descriptive UA is all it wants. Kept
// browser-shaped like the biligame headers so an edge rule never has a reason to challenge us.
const API_HEADERS = {
  'User-Agent':
    'wf-museum-archive-scraper/1.0 (personal fan-site data collection; contact via github) Node.js',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function pageUrl(title) {
  return `${WIKIGG_BASE}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

// ---------------------------------------------------------------------------
// API access + disk cache
// ---------------------------------------------------------------------------

function cacheKey(params) {
  // Stable, filesystem-safe key: sorted params joined, then hashed if too long for a filename.
  const raw = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const safe = raw.replace(/[\\/:*?"<>|&=]/g, '_');
  if (safe.length <= 120) return safe;
  // Cheap deterministic hash — only needs to avoid collisions within our own query set.
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return `${safe.slice(0, 100)}_${h.toString(36)}`;
}

// Single API call. Responses cache on disk (gitignored) so a re-run resumes without re-fetching —
// the same resume mechanism the other scrapers' page caches provide.
export async function apiCall(params, { force = false } = {}) {
  const query = { format: 'json', formatversion: '2', ...params };
  const file = path.join(CACHE_DIR, `${cacheKey(query)}.json`);
  if (!force && existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // fall through and re-fetch a corrupt cache entry
    }
  }
  const url = `${WIKIGG_API}?${new URLSearchParams(query)}`;
  const text = await politeFetch(url, { delayMs: DELAY_MS, retries: 3, headers: API_HEADERS });
  const json = JSON.parse(text);
  if (json.error) throw new Error(`API error ${json.error.code}: ${json.error.info}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, text);
  return json;
}

// Runs a list=/prop= query to exhaustion, following MediaWiki's `continue` cursor.
async function apiQueryAll(params, collect, opts) {
  let cont = {};
  for (let guard = 0; guard < 200; guard++) {
    const json = await apiCall({ action: 'query', ...params, ...cont }, opts);
    if (json.query) collect(json.query);
    if (!json.continue) return;
    cont = json.continue;
  }
  throw new Error('apiQueryAll: continue cursor did not terminate');
}

// Every page title in a category (no Category:/File: members — we only ever want articles).
export async function categoryMembers(category, opts) {
  const titles = [];
  await apiQueryAll(
    {
      list: 'categorymembers',
      cmtitle: category.startsWith('Category:') ? category : `Category:${category}`,
      cmlimit: '500',
      cmnamespace: '0',
    },
    (q) => {
      for (const m of q.categorymembers || []) titles.push(m.title);
    },
    opts
  );
  return titles;
}

// Raw wikitext for many titles. The API caps `titles` at 50 per request, which is also what makes
// this pipeline cheap. Returns Map<requestedTitle, wikitext>; missing pages are simply absent, and
// titles the wiki normalized or redirected are mapped back to what the caller asked for.
export async function fetchWikitext(titles, opts) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const backMap = new Map(batch.map((t) => [t.replace(/_/g, ' '), t]));
    await apiQueryAll(
      {
        prop: 'revisions',
        rvslots: 'main',
        rvprop: 'content',
        titles: batch.join('|'),
      },
      (q) => {
        // `normalized` maps the wiki's canonical form back to what we sent.
        for (const n of q.normalized || []) backMap.set(n.to, backMap.get(n.from) || n.from);
        for (const p of q.pages || []) {
          if (p.missing || p.invalid) continue;
          const content = p.revisions?.[0]?.slots?.main?.content;
          if (typeof content !== 'string') continue;
          out.set(backMap.get(p.title) || p.title, content);
        }
      },
      opts
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wikitext parsing
// ---------------------------------------------------------------------------

// Splits on `sep` only at brace/bracket depth 0. This is the whole reason the template parser
// can't be a regex: {{Unit story page}}'s episodeNScript parameter holds dozens of nested
// {{SL|...|...}} calls, whose pipes must not be mistaken for parameter separators.
function splitTopLevel(body, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') {
      depth++;
      i++;
    } else if (two === '}}' || two === ']]') {
      depth--;
      i++;
    } else if (depth === 0 && body[i] === sep) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

// Finds every `{{name|...}}` invocation in `text` and returns [{ name, params }]. Matching on the
// template name is case-insensitive on the first letter only, mirroring MediaWiki's own
// first-letter-case behaviour ({{tab/start}} and {{Tab/start}} are the same template).
export function findTemplates(text, name) {
  const want = name ? name.replace(/_/g, ' ').trim().toLowerCase() : null;
  const found = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '{' || text[i + 1] !== '{') continue;
    // Walk to the matching close brace.
    let depth = 0;
    let end = -1;
    for (let j = i; j < text.length - 1; j++) {
      const two = text.slice(j, j + 2);
      if (two === '{{') {
        depth++;
        j++;
      } else if (two === '}}') {
        depth--;
        j++;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end < 0) break; // unbalanced tail; nothing usable after this point
    const body = text.slice(i + 2, end - 2);
    const parts = splitTopLevel(body, '|');
    const tplName = parts[0].trim().replace(/_/g, ' ');
    const matched = !want || tplName.toLowerCase() === want;
    if (matched) {
      const params = {};
      const positional = [];
      for (const part of parts.slice(1)) {
        const eq = splitTopLevel(part, '=');
        if (eq.length > 1) {
          // Only the FIRST top-level '=' separates key from value; '=' inside the value is data.
          const key = eq[0].trim();
          params[key] = eq.slice(1).join('=').trim();
        } else {
          positional.push(part.trim());
        }
      }
      found.push({ name: tplName, params, positional, raw: body });
      // Skip the body of a template we captured, so a same-named nested call isn't returned twice.
      i = end - 1;
    }
    // A NON-matching template must NOT be skipped: the wanted template is often nested inside a
    // wrapper ({{Unit Quotes|quotes= {{Unit Quote}}...}}), so scanning has to descend into it.
  }
  return found;
}

export function findTemplate(text, name) {
  return findTemplates(text, name)[0] || null;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
};

// Renders a parameter value the way a reader sees it: links resolve to their label, formatting
// marks drop away, <br> becomes a newline. `obtain=[[Portals]]` and `obtain=[[A|B]]` both need this.
export function stripWikiMarkup(s) {
  if (!s) return '';
  let out = String(s);
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');
  // [[Target|Label]] -> Label, [[Target]] -> Target (file/category links drop entirely).
  out = out.replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '');
  out = out.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  out = out.replace(/\[\[([^\]]*)\]\]/g, '$1');
  // [https://url Label] -> Label, [https://url] -> the url
  out = out.replace(/\[(?:https?:)?\/\/\S+?\s+([^\]]*)\]/g, '$1');
  out = out.replace(/\[((?:https?:)?\/\/\S+?)\]/g, '$1');
  out = out.replace(/'''''|'''|''/g, '');
  out = out.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // The game's own line-wrapping survives into the wiki as runs of spaces; collapse them but keep
  // real newlines (which <br> produced above).
  out = out.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n');
  return out.trim();
}

// A {{SL|Speaker|line}} script block -> [{ speaker, text }]. Lines with no speaker (narration,
// written as {{SL||text}}) keep an empty speaker rather than being dropped.
export function parseSLLines(script) {
  if (!script) return [];
  const lines = [];
  for (const tpl of findTemplates(script, 'SL')) {
    const [speaker = '', ...rest] = tpl.positional;
    const text = stripWikiMarkup(rest.join('|'));
    if (!text) continue;
    lines.push({ speaker: stripWikiMarkup(speaker), text });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Output helpers (byte-stability + R2 invalidation, same contract as the other pipelines)
// ---------------------------------------------------------------------------

export function writeIfChanged(filePath, buf) {
  if (existsSync(filePath) && readFileSync(filePath).equals(buf)) return false;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  return true;
}

// No trailing newline — matches match-wiki-to-roster.mjs / miaowm5-common.mjs, so these files sit
// beside the existing ones in the same shape.
export function writeJsonIfChanged(filePath, value) {
  return writeIfChanged(filePath, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

// Prunes empty strings, nulls, empty arrays and empty objects — the owned-keys convention the
// miaowm5 pipeline uses, so a field the wiki left blank simply doesn't appear.
export function pruneEmpty(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete obj[k];
    else if (typeof v === 'object' && !Array.isArray(v)) {
      pruneEmpty(v);
      if (!Object.keys(v).length) delete obj[k];
    }
  }
  return obj;
}

const R2_MANIFEST_PATH = path.resolve('scripts/.r2-upload-manifest.json');

// R2 keys are relative to whichever root the uploader collects the file under: `Character Assets/`
// for character files, the literal `Weapons/` prefix for the weapons folder (see upload-to-r2.mjs).
// Callers pass the already-resolved key rather than an abs path, since the two roots differ.
export function makeR2Invalidator() {
  const keys = new Set();
  return {
    add: (key) => keys.add(key),
    flush() {
      if (!keys.size || !existsSync(R2_MANIFEST_PATH)) return 0;
      let done;
      try {
        done = new Set(JSON.parse(readFileSync(R2_MANIFEST_PATH, 'utf8')));
      } catch {
        return 0;
      }
      let removed = 0;
      for (const key of keys) if (done.delete(key)) removed++;
      if (removed) writeFileSync(R2_MANIFEST_PATH, JSON.stringify([...done], null, 0));
      return removed;
    },
  };
}
