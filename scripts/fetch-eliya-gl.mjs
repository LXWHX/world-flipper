// Pulls English character text (skill / leader buff / abilities / epithet) from Eliya-bot's Global
// (GL) collection tracker and writes it as a wiki_en.json-shaped sidecar,
// Character Assets/rarityN/<devName>/eliya_en.json, for the characters the wiki.gg pipeline could
// not match. The front-end tries wiki_en.json first and falls back to this file (loadWikiEn).
//
// WHY THIS SOURCE. Eliya-bot's GL data is keyed by `DevNicknames` — the exact `devName` our roster
// uses — so it joins with zero name-matching, unlike wiki.gg. It carries the game's own English
// skill/leader/ability text for the 432 globally-released characters. The value here is the ~60
// `bustOnly` characters (added from a Chinese source) that today have an English *name* but no
// English skill text anywhere, plus the three characters wiki.gg missed to name drift
// (estateguild_leader=Hildegarde, anger_investigator=Weihu, scissor_ratgirl=Karina). For the 369
// characters that already have wiki_en.json this source is redundant, so those are skipped.
//
// HOW THE DATA ARRIVES. The site serves this over socket.io (EIO=4), not a static endpoint — the
// committed datagl/chars.json in github.com/poswords/EliyaBot is base stats only; the English text
// is merged in at runtime from a Google Sheet. So we connect as a client, emit `connected` with
// 'gl', and capture the `chars` event. The raw capture is cached under scripts/.eliya-cache/ so a
// re-run needs no network (byte-stable output, same as the other pipelines).
//
// Usage:
//   node scripts/fetch-eliya-gl.mjs                 fetch (or reuse cache), write missing sidecars
//   node scripts/fetch-eliya-gl.mjs --refresh       ignore the cache, re-fetch from the live socket
//   node scripts/fetch-eliya-gl.mjs --only=gold_ship,aqua   only these devNames
//   node scripts/fetch-eliya-gl.mjs --limit=5       only the first N writable matches (debugging)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { io } from 'socket.io-client';
import { makeR2Invalidator, pruneEmpty, writeJsonIfChanged } from './lib/wikigg-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const ROSTER_PATH = path.join(ASSETS_DIR, 'roster.json');
const REPORT_PATH = path.join(ASSETS_DIR, '_eliya_gl_report.md');
const CACHE_DIR = path.resolve('scripts/.eliya-cache');
const CACHE_CHARS = path.join(CACHE_DIR, 'gl_chars.json');

const ELIYA_URL = 'https://eliya-bot.herokuapp.com';
const SOURCE_URL = 'https://eliya-bot.herokuapp.com/gl/';

const REFRESH = process.argv.includes('--refresh');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',').map((s) => s.trim())) : null;

// The GL socket sends the fully merged `chars`/`equips` arrays once we announce lang 'gl'. We only
// need `chars`. Cached to disk so a re-run is offline and byte-stable.
function fetchGlChars() {
  if (!REFRESH && existsSync(CACHE_CHARS)) {
    console.log('Using cached scripts/.eliya-cache/gl_chars.json (pass --refresh to re-fetch).');
    return Promise.resolve(JSON.parse(readFileSync(CACHE_CHARS, 'utf8')));
  }
  return new Promise((resolve, reject) => {
    console.log('Connecting to the Eliya-bot GL socket...');
    const socket = io(ELIYA_URL, { transports: ['polling', 'websocket'], reconnection: false, timeout: 20000 });
    const timer = setTimeout(() => { socket.close(); reject(new Error('timed out waiting for the chars event')); }, 30000);
    socket.on('connect', () => socket.emit('connected', 'gl'));
    socket.on('connect_error', (e) => { clearTimeout(timer); socket.close(); reject(e); });
    socket.on('chars', (chars) => {
      clearTimeout(timer);
      socket.close();
      if (!Array.isArray(chars)) return reject(new Error('chars event was not an array'));
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(CACHE_CHARS, JSON.stringify(chars));
      console.log(`Fetched ${chars.length} GL characters (cached).`);
      resolve(chars);
    });
  });
}

// Eliya packs a bracketed label onto its text: "[Winged Inferno]\nVagner" (epithet + name),
// "[Prominence Blaze]\ndeal fire damage..." (skill name + detail). Split the two.
function splitLabel(s) {
  if (!s) return { label: '', body: '' };
  const t = s.replace(/\r/g, '');
  const m = t.match(/^\s*\[([^\]]*)\]\s*\n?([\s\S]*)$/);
  if (m) return { label: m[1].trim(), body: m[2].trim() };
  return { label: '', body: t.trim() };
}

// Map one Eliya GL record into the exact shape the front-end reads from wiki_en.json
// (info / stats / skill / leaderTalent / abilities), so no separate render path is needed. The
// `source: 'eliya'` marker is what switches the on-screen attribution to Eliya-bot.
function toWikiEnShape(c) {
  const name = splitLabel(c.ENName);
  const skill = splitLabel(c.Skill);
  const leader = splitLabel(c.LeaderBuff);
  const abilities = [];
  for (let i = 1; i <= 6; i++) {
    const a = (c['Ability' + i] || '').trim();
    if (a) abilities.push(a);
  }
  return pruneEmpty({
    source: 'eliya',
    sourceUrl: SOURCE_URL,
    info: {
      name: name.body,
      title: name.label,
      // Eliya has no description / voice actor, and its Role vocabulary (Sword/Fist/...) differs
      // from wiki.gg's class names, so those rows are intentionally left to fall back to Chinese.
      race: (c.Race || '').trim(),
      gender: (c.Gender || '').trim(),
      obtain: (c.Obtain || '').trim(),
    },
    stats: {
      rarity: Number(c.Rarity) || '',
      element: (c.Attribute || '').trim(),
      maxHP: Number(c.MaxHP) || '',
      maxAttack: Number(c.MaxATK) || '',
    },
    skill: { name: skill.label, detail: skill.body },
    leaderTalent: { name: leader.label, detail: leader.body },
    abilities,
  });
}

async function main() {
  if (!existsSync(ROSTER_PATH)) {
    console.error('Character Assets/roster.json not found.');
    process.exit(1);
  }
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')).characters || [];
  const glChars = await fetchGlChars();
  const glByDev = new Map(glChars.map((c) => [c.DevNicknames, c]));

  const r2 = makeR2Invalidator();
  const written = [];
  const cleaned = [];
  const skippedHasWiki = [];
  const skippedNoThumb = [];
  const notInEliya = [];

  let count = 0;
  for (const c of roster) {
    if (ONLY && !ONLY.has(c.devName)) continue;
    const gl = glByDev.get(c.devName);
    if (!gl) { notInEliya.push(c.devName); continue; }
    // No thumb → no rarityN/<devName> folder (the three thumb:null entries are filtered from every
    // grid anyway), so there is nowhere to write and nothing on screen to caption.
    if (!c.thumb) { skippedNoThumb.push(c.devName); continue; }

    const dir = path.dirname(c.thumb); // rarityN/<devName>
    const absDir = path.join(ASSETS_DIR, dir);
    const wikiEnPath = path.join(absDir, 'wiki_en.json');
    const eliyaPath = path.join(absDir, 'eliya_en.json');

    // wiki.gg is the primary source; where it matched, this file is redundant and never read. If a
    // stale sidecar is sitting next to a now-present wiki_en.json, remove it so it stops shipping.
    if (existsSync(wikiEnPath)) {
      skippedHasWiki.push(c.devName);
      if (existsSync(eliyaPath)) {
        rmSync(eliyaPath);
        r2.add(`${dir}/eliya_en.json`);
        cleaned.push(c.devName);
      }
      continue;
    }
    if (!existsSync(absDir)) { skippedNoThumb.push(c.devName); continue; }
    if (count >= LIMIT) break;
    count++;

    const record = toWikiEnShape(gl);
    // Nothing worth writing if there's no skill and no leader text (shouldn't happen for GL units).
    if (!record.skill && !record.leaderTalent && !(record.abilities || []).length) continue;
    if (writeJsonIfChanged(eliyaPath, record)) {
      r2.add(`${dir}/eliya_en.json`);
      written.push(c.devName);
    }
  }

  const removed = r2.flush();

  // Report (full runs only — an --only/--limit pass would otherwise shrink it misleadingly).
  if (!ONLY && LIMIT === Infinity) {
    const lines = [
      '# Eliya-bot GL (English) — supplement report',
      '',
      `Source: ${SOURCE_URL} (socket.io \`chars\`, lang=gl), joined to roster.json by devName.`,
      '',
      `- ${glChars.length} GL characters received; ${glByDev.size} unique devNames.`,
      `- ${written.length} eliya_en.json written/updated (characters with no wiki_en.json).`,
      `- ${skippedHasWiki.length} already have wiki_en.json (wiki.gg wins; skipped).`,
      `- ${cleaned.length} stale eliya_en.json removed (wiki.gg has since matched them).`,
      `- ${skippedNoThumb.length} matched but have no character folder (thumb:null; skipped).`,
      `- ${notInEliya.length} roster characters are not in the GL data (CN-only / not globally released).`,
      '',
      '## Written (net-new English skill text)',
      ...written.map((d) => `- ${d}`),
      '',
      '## Not in Eliya GL (still Chinese-only for skill text)',
      ...notInEliya.map((d) => `- ${d}`),
      '',
    ];
    if (cleaned.length) lines.push('## Cleaned up (wiki.gg took over)', ...cleaned.map((d) => `- ${d}`), '');
    writeFileSync(REPORT_PATH, lines.join('\n'));
    console.log('Wrote _eliya_gl_report.md');
  }

  console.log(
    `Done. ${written.length} eliya_en.json written, ${cleaned.length} removed, ` +
    `${skippedHasWiki.length} skipped (wiki.gg), ${notInEliya.length} not in GL. ` +
    `${removed} key(s) dropped from the R2 manifest.`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
