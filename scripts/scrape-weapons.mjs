// Scrapes the bilibili biligame World Flipper wiki equipment (装备) pages into the top-level
// Weapons/ folder: Weapons/weapons.json (the index the site reads) + Weapons/icons/<hash>.png
// (self-hosted icons). Same source, HTTP-manners, resume-cache and byte-stability rules as the
// character wiki pipeline (scripts/scrape-wiki-zh.mjs) — see CLAUDE.md.
//
// Usage:
//   node scripts/scrape-weapons.mjs                scrape everything not already cached
//   node scripts/scrape-weapons.mjs --force        ignore the manifest, re-scrape every page
//   node scripts/scrape-weapons.mjs --limit=5       only scrape the first N weapons (debugging)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadHtml, politeFetch, cellText } from './lib/wiki-common.mjs';

const WIKI_BASE = 'https://wiki.biligame.com';
const LIST_URL = `${WIKI_BASE}/worldflipper/%E8%A3%85%E5%A4%87`; // 装备
const CACHE_DIR = path.resolve('scripts/.weapons-scrape-cache');
const MANIFEST_PATH = path.resolve('scripts/.weapons-scrape-manifest.json');
const OUT_DIR = path.resolve('Weapons');
const ICON_DIR = path.join(OUT_DIR, 'icons');
const OUT_JSON = path.join(OUT_DIR, 'weapons.json');
const DELAY_MS = 1200;
// biligame's edge returns HTTP 567 to bot-shaped requests; a clean browser UA + these headers
// (the same shape a browser sends) is what turns it back into a normal 200.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: `${WIKI_BASE}/worldflipper/%E8%A3%85%E5%A4%87`,
};

const FORCE = process.argv.includes('--force');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

// The list page encodes rarity+element in each tile's `unit-icon-{rarity}-{element}` class.
// Element names map onto the site's own ELEMENT_ORDER; `none` is a real (non-elemental) bucket.
const ELEMENT_MAP = {
  fire: 'Fire',
  water: 'Water',
  thunder: 'Thunder',
  wind: 'Wind',
  light: 'Light',
  dark: 'Dark',
  none: 'None',
};

// Byte-stable writes (a no-op re-run produces zero diff). Local copy so the scraper stays
// self-contained like scrape-wiki-zh.mjs; no trailing newline, matching the other pipelines.
function writeIfChanged(filePath, buf) {
  if (existsSync(filePath)) {
    if (readFileSync(filePath).equals(buf)) return false;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  return true;
}

function loadManifest() {
  if (FORCE || !existsSync(MANIFEST_PATH)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveManifest(done) {
  writeFileSync(MANIFEST_PATH, JSON.stringify([...done], null, 0));
}

// Cache a page's HTML on disk so a re-run resumes without re-fetching (the scrape cache is the
// resume mechanism; gitignored). Keyed by the URL's decoded page name.
async function cachedFetch(url) {
  const key = decodeURIComponent(url.split('/').pop()).replace(/[\\/:*?"<>|]/g, '_');
  const file = path.join(CACHE_DIR, `${key}.html`);
  if (!FORCE && existsSync(file)) return readFileSync(file, 'utf8');
  // biligame answers a bot-looking request (the default scraper UA, no Accept/Referer) with
  // HTTP 567; a clean browser UA plus these headers gets a normal 200.
  const html = await politeFetch(url, { delayMs: DELAY_MS, retries: 4, headers: BROWSER_HEADERS });
  writeFileSync(file, html);
  return html;
}

// The list icon src points at a scaled thumbnail (/thumb/x/xx/<hash>.png/NNpx-name.png); the
// original lives one level up (/x/xx/<hash>.png). The <hash> is a stable, unique, CJK-free id.
function fullResIcon(src) {
  const m = (src || '').match(/\/images\/worldflipper\/thumb\/(.+?\.(?:png|jpg|jpeg|gif))\/\d+px-/i);
  return m ? `https://patchwiki.biligame.com/images/worldflipper/${m[1]}` : (src || '');
}

function iconHash(fullUrl) {
  return decodeURIComponent(fullUrl.split('/').pop()).replace(/\.(png|jpg|jpeg|gif)$/i, '');
}

async function downloadIcon(fullUrl, dest) {
  if (existsSync(dest)) return; // skip-if-exists fast path (delete to re-fetch)
  const res = await fetch(fullUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for icon ${fullUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

// Each tile in the 装备 grid is a `div.unit-icon` carrying a rarity-element class, an icon <img>,
// and a name link. Two <a>s per tile (image + caption) both point at the same page — dedupe by href.
async function fetchWeaponList() {
  const html = await cachedFetch(LIST_URL);
  const $ = loadHtml(html);
  const seen = new Map(); // href -> record
  $('div.unit-icon').each((_, div) => {
    const cls = $(div).attr('class') || '';
    const m = cls.match(/unit-icon-(\d+)-([a-z]+)/i);
    if (!m) return; // not a weapon tile
    const link = $(div).find('a[href^="/worldflipper/"]').first();
    const href = link.attr('href');
    if (!href || seen.has(href)) return;
    const nameZh = (link.attr('title') || link.text() || '').trim();
    if (!nameZh) return;
    const fullIcon = fullResIcon($(div).find('img').attr('src'));
    seen.set(href, {
      href,
      url: WIKI_BASE + href,
      slug: decodeURIComponent(href.split('/').pop()),
      nameZh,
      rarity: Number(m[1]),
      element: ELEMENT_MAP[m[2].toLowerCase()] || 'None',
      iconUrl: fullIcon,
      icon: fullIcon ? `icons/${iconHash(fullIcon)}.png` : '',
    });
  });
  return [...seen.values()];
}

const toNum = (t) => {
  const m = (t || '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// The detail page's data is one `table.wikitable`. The caption holds name(alt)/rarity/element and a
// <p> flavor line; the body is label→value rows (some rows carry two th/td pairs, e.g.
// 生命值|242|攻击力|99). 初始/满级 header rows switch the HP/ATK phase between base and max.
function parseWeaponDetail($) {
  const table = $('.mw-parser-output table.wikitable').first();
  const out = {};
  if (!table.length) return out;

  const flavor = cellText($, table.find('caption p').first());
  if (flavor) out.flavor = flavor;
  // Alt name in the caption's leading parenthetical, e.g. 灼炎龙剑(火龙剑).
  const capOwn = table
    .find('caption')
    .first()
    .clone()
    .children()
    .remove()
    .end()
    .text()
    .replace(/\s+/g, ' ')
    .trim();
  const altM = capOwn.match(/[（(]([^）)]+)[）)]/);
  if (altM) out.altName = altM[1].trim();

  let phase = 'base';
  table.find('> tbody > tr').each((_, tr) => {
    const cells = $(tr).children('th, td').toArray();
    const tds = cells.filter((c) => c.tagName === 'td');
    // A lone-th row (no td) is a section header; switch the HP/ATK phase.
    if (!tds.length) {
      const label = cellText($, cells[0]);
      if (/初始/.test(label)) phase = 'base';
      else if (/满级|满/.test(label)) phase = 'max';
      return;
    }
    // Walk cells left→right pairing each th label with the td that follows it (an empty leading
    // th — the icon cell — is simply overwritten by the next label before any td appears).
    let label = '';
    for (const c of cells) {
      if (c.tagName === 'th') {
        label = cellText($, c);
      } else {
        const val = cellText($, c);
        switch (label) {
          case '能力': out.role = val; break;
          case '限制': out.limit = val; break;
          case '体系': out.system = val; break;
          case '获取方式': out.acquisition = val; break;
          case '效果': out.effect = val; break;
          case '最大效果': out.maxEffect = val; break;
          case '生命值': out[phase === 'max' ? 'maxHp' : 'baseHp'] = toNum(val); break;
          case '攻击力': out[phase === 'max' ? 'maxAtk' : 'baseAtk'] = toNum(val); break;
          default:
            // 觉醒 rows (LV3觉醒/LV5觉醒) carry extra awakening text on some weapons.
            if (/觉醒/.test(label) && val) (out.awaken || (out.awaken = [])).push(`${label}: ${val}`);
        }
        label = '';
      }
    }
  });
  return out;
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(ICON_DIR, { recursive: true });

  console.log('Fetching equipment list...');
  const list = await fetchWeaponList();
  console.log(`Found ${list.length} equipment links.`);

  const done = loadManifest();
  const targets = list.slice(0, LIMIT);

  // Merge into any existing index so --limit/partial runs don't drop already-scraped weapons.
  const byHref = new Map();
  if (existsSync(OUT_JSON)) {
    try {
      for (const w of JSON.parse(readFileSync(OUT_JSON, 'utf8')).weapons || []) byHref.set(w.href, w);
    } catch {}
  }

  let failures = 0;
  for (let i = 0; i < targets.length; i++) {
    const w = targets[i];
    try {
      const html = await cachedFetch(w.url);
      const $ = loadHtml(html);
      const detail = parseWeaponDetail($);
      if (w.iconUrl) {
        try {
          await downloadIcon(w.iconUrl, path.join(OUT_DIR, w.icon));
        } catch (e) {
          console.error(`  icon FAIL ${w.nameZh}: ${e.message}`);
        }
      }
      // Persist only what the site + a resume merge need: drop the debug-only url/iconUrl (both
      // derivable) and prune empty strings/nulls so the index stays lean.
      const { url, iconUrl, ...keep } = w;
      const record = { ...keep, ...detail };
      for (const k of Object.keys(record)) {
        if (record[k] === '' || record[k] == null) delete record[k];
      }
      byHref.set(w.href, record);
      done.add(w.href);
      if ((i + 1) % 20 === 0) saveManifest(done);
      console.log(`[${i + 1}/${targets.length}] ok   ${w.nameZh}`);
    } catch (err) {
      failures++;
      console.error(`[${i + 1}/${targets.length}] FAIL ${w.nameZh}: ${err.message}`);
    }
  }
  saveManifest(done);

  // Stable order (rarest first, then site element order, then name) so weapons.json is diff-friendly
  // regardless of scrape order. `iconUrl`/`href` are kept for resume/debug; the front-end ignores them.
  const ELEMENT_ORDER = ['Fire', 'Water', 'Thunder', 'Wind', 'Light', 'Dark', 'None'];
  const weapons = [...byHref.values()].sort(
    (a, b) =>
      b.rarity - a.rarity ||
      ELEMENT_ORDER.indexOf(a.element) - ELEMENT_ORDER.indexOf(b.element) ||
      a.nameZh.localeCompare(b.nameZh, 'zh')
  );
  const changed = writeIfChanged(
    OUT_JSON,
    Buffer.from(JSON.stringify({ weapons }, null, 2), 'utf8')
  );
  console.log(
    `Done. ${weapons.length} weapons, ${failures} failure(s). weapons.json ${changed ? 'updated' : 'unchanged'}.`
  );
  process.exit(failures > 0 ? 1 : 0);
}

main();
