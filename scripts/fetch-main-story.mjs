// Fetches the main-story / event-story browser data from worldflipper.miaowm5.com's public CDNs
// into Character Assets/story/, mirroring the site's /story section. Companion to
// scripts/fetch-miaowm5.mjs (per-character data); shared CDN map + parsing ports live in
// scripts/lib/miaowm5-common.mjs and scripts/lib/miaowm5-story.mjs.
//
// Output layout (all under Character Assets/story/, all shipped to R2):
//   index.json                     list-page manifest (fetched once when the Story tab opens)
//   detail/<slug>.json             per-story detail: info/episodes/gallery/bgm references
//   banners/<slug>.png             list banner sprite (res/banner atlas; absent on a sprite miss)
//   headers/<slug>.png             detail header background (encyclopedia stories)
//   orb/chapter_<n>.png            main-chapter orb art
//   gallery/<slug>/<i>.<ext>       event/prologue gallery images (renamed to indexes)
//   episodes/<qkey>/<id>/<n>.json  dialogue, one file per episode (lazy reader fetch)
//   bgm/<filelist path>.mp3        BGM, shared across stories (world buckets reused by many)
//
// Story-only NPC speakers get framed portraits via the shared buildStoryHeads (writes into
// Character Assets/story_heads/, the same dir the character pipeline uses).
//
// Usage:
//   node scripts/fetch-main-story.mjs                     resume; only fetch what's missing
//   node scripts/fetch-main-story.mjs --force             re-decode/re-download everything
//   node scripts/fetch-main-story.mjs --limit=3           only the first 3 stories
//   node scripts/fetch-main-story.mjs --only=prologue,... only these slugs (comma-separated)
//   node scripts/fetch-main-story.mjs --skip-bgm          write all JSON/images but skip mp3s

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ORDEREDMAP,
  CDN_A,
  CDN_B,
  CDN_D,
  Spritesheet,
  cachedFetchJson,
  decodeScenarioText,
  encodePng,
  fetchToFile,
  writeIfChanged,
  writeJsonIfChanged,
} from './lib/miaowm5-common.mjs';
import {
  buildStoryDialogs,
  buildStoryHeads,
  parseEncyclopedia,
  parseStoryCharacter,
} from './lib/miaowm5-story.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const ROSTER_PATH = path.join(ASSETS_DIR, 'roster.json');
const STORY_DIR = path.join(ASSETS_DIR, 'story');
const STORY_HEADS_DIR = path.join(ASSETS_DIR, 'story_heads');
const STORY_HEADS_MANIFEST = path.join(ASSETS_DIR, 'story_heads.json');
const R2_MANIFEST_PATH = path.resolve('scripts/.r2-upload-manifest.json');
const REPORT_PATH = path.join(ASSETS_DIR, '_story_report.md');
const SOURCE = 'worldflipper.miaowm5.com';

const RAW_DB = 'https://raw.githubusercontent.com/miaowm5/wf-encyclopedia/main/src/database/';

const FORCE = process.argv.includes('--force');
const SKIP_BGM = process.argv.includes('--skip-bgm');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const ONLY = new Set(
  ((process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '')
    .split(',')
    .filter(Boolean)
);

// Slug → category override, for the rare event whose id doesn't match the /collabo?/ heuristic
// below. Empty by default; add entries here if a story is miscategorised.
const CATEGORY_OVERRIDES = {};

// ---------------------------------------------------------------------------
// R2 invalidation (same contract as fetch-miaowm5.mjs: drop rewritten keys from the upload
// manifest so upload-to-r2.mjs re-ships them).
// ---------------------------------------------------------------------------

const r2Invalidated = new Set();
function invalidateR2(absPath) {
  r2Invalidated.add(path.relative(ASSETS_DIR, absPath).split(path.sep).join('/'));
}
function flushR2Invalidations() {
  if (!r2Invalidated.size || !existsSync(R2_MANIFEST_PATH)) return 0;
  let done;
  try {
    done = new Set(JSON.parse(readFileSync(R2_MANIFEST_PATH, 'utf8')));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const key of r2Invalidated) if (done.delete(key)) removed++;
  if (removed) writeFileSync(R2_MANIFEST_PATH, JSON.stringify([...done], null, 0));
  return removed;
}

// ---------------------------------------------------------------------------
// Global tables
// ---------------------------------------------------------------------------

// Maps a story to the normal_quest bucket that holds its episode list, plus a stable qkey used
// as the on-disk episodes/<qkey>/ folder. Two stories that resolve to the same bucket+id (an
// encyclopedia event and its extra-quest twin) therefore share one set of episode files.
const QUEST_BUCKET = {
  main: { key: 'main_quest', bucket: 'main_quest' },
  prologue: { key: 'main_quest', bucket: 'main_quest' },
  'event-world': { key: 'event_world', bucket: 'event/world_story_event_quest' },
  'event-single': { key: 'event_single', bucket: 'event/story_event_single_quest' },
  'event-quest': { key: 'event_adv', bucket: 'event/advent_event_quest' },
  'extra-adv': { key: 'event_adv', bucket: 'event/advent_event_quest' },
  'extra-single': { key: 'event_single', bucket: 'event/story_event_single_quest' },
};

async function loadGlobals() {
  const [characterRaw, characterText, encyclopediaRaw, storyCharRaw, extraQuest, normalQuest, equipment, filelist, bgmRule, extraGallery] =
    await Promise.all([
      cachedFetchJson(`${ORDEREDMAP}character/character.json`),
      cachedFetchJson(`${ORDEREDMAP}character/character_text.json`),
      cachedFetchJson(`${ORDEREDMAP}encyclopedia/encyclopedia.json`),
      cachedFetchJson(`${ORDEREDMAP}story/story_character.json`),
      cachedFetchJson(`${ORDEREDMAP}quest/extra_quest.json`),
      cachedFetchJson(`${ORDEREDMAP}quest/normal_quest.json`),
      cachedFetchJson(`${ORDEREDMAP}item/equipment.json`),
      cachedFetchJson(`${CDN_D}filelist.json`),
      cachedFetchJson(`${RAW_DB}bgmRule.json`),
      cachedFetchJson(`${RAW_DB}extraGallery.json`),
    ]);

  const byDevName = new Map();
  const byGameId = new Map();
  for (const gameId of Object.keys(characterRaw)) {
    const row = characterRaw[gameId][0];
    if (!row) continue;
    const rec = { gameId, devName: row[0], storyId: row[8] || row[0], row };
    byGameId.set(gameId, rec);
    byDevName.set(rec.devName, rec);
  }

  const text = {};
  for (const k of Object.keys(characterText)) text[k] = characterText[k][0];

  return {
    byDevName,
    byGameId,
    text,
    encyclopedia: parseEncyclopedia(encyclopediaRaw),
    storyChar: parseStoryCharacter(storyCharRaw),
    extraQuest,
    normalQuest,
    equipment,
    music: buildMusicBuckets(filelist),
    bgmRule: bgmRule.story || {},
    extraGallery,
  };
}

// Port of the upstream `music_list` handler's bucketing: world tracks grouped by their top folder
// (world_grass, …), event tracks by event/<id>/ (advent by the third path segment).
function buildMusicBuckets(filelist) {
  const world = {};
  const event = {};
  for (const name of filelist) {
    if (!name.endsWith('.mp3')) continue;
    const parts = name.split('/');
    if (parts[0].startsWith('world')) {
      (world[parts[0]] ||= []).push(name);
    } else if (parts[0] === 'event') {
      const key = parts[1] === 'advent_event' ? parts[2] || 'advent_event' : parts[1];
      (event[key] ||= []).push(name);
    }
  }
  return { world, event };
}

// ---------------------------------------------------------------------------
// Story entry assembly
// ---------------------------------------------------------------------------

// main/prologue → 主线; a collab (id contains "collab") → 联动; anything else → 活动.
function categoryFor(slug, kind, eventID) {
  if (CATEGORY_OVERRIDES[slug]) return CATEGORY_OVERRIDES[slug];
  if (kind === 'main' || kind === 'prologue') return 'main';
  if (/collabo?/i.test(eventID || '')) return 'collab';
  return 'event';
}

// The ordered list of stories, matching upstream's /story list: encyclopedia stories in key
// order, then extra advent-quest stories, then extra single-quest stories.
function buildStoryEntries(g) {
  const entries = [];
  for (const [id, e] of Object.entries(g.encyclopedia)) {
    if (e.type !== 'story') continue;
    const slug = e.eventID || id;
    entries.push({
      slug,
      kind: e.subType,
      eventID: e.eventID,
      storyID: e.subType === 'prologue' ? '0' : e.storyID,
      encId: id,
      banner: e.banner,
      title: decodeScenarioText(String(e.title ?? '')),
      desc: e.desc.map((d) => d.trim()).filter(Boolean),
      related: e.related,
    });
  }
  const pushExtra = (bucket, kind) => {
    const grp = g.extraQuest[bucket];
    if (!grp) return;
    for (const id of Object.keys(grp)) {
      const row = grp[id][0];
      if (!row) continue;
      const eventID = `event_${row[0]}`;
      entries.push({
        slug: `${kind === 'extra-adv' ? 'extra_adv' : 'extra_single'}_${id}`,
        kind,
        eventID,
        storyID: id,
        encId: null,
        banner: row[4],
        title: decodeScenarioText(String(row[2] ?? '')),
        desc: [], // extras carry no info blocks → no info tab
        related: [],
      });
    }
  };
  pushExtra('advent_event_quest', 'extra-adv');
  pushExtra('story_event_single_quest', 'extra-single');
  return entries;
}

// Related entries split into playable characters (resolvable back to the roster) and keyword
// chips — the same split the character pipeline's buildRelated uses.
function buildRelated(relatedIds, g, rosterByDev) {
  const characters = [];
  const keywords = [];
  for (const id of relatedIds || []) {
    const e = g.encyclopedia[id];
    if (!e) continue;
    if (e.type === 'character' && e.characterID) {
      const rec = g.byGameId.get(String(e.characterID));
      const devName = rec && rosterByDev.has(rec.devName) ? rec.devName : null;
      const zhName = g.text[String(e.characterID)]?.[0] || e.title || '';
      characters.push({ id, devName, zhName });
    } else {
      const title = e.title || '';
      if (!title) continue;
      keywords.push({ id, title, desc: e.desc.map((d) => d.trim()).filter(Boolean).join('\n') });
    }
  }
  const out = {};
  if (characters.length) out.characters = characters;
  if (keywords.length) out.keywords = keywords;
  return out;
}

// ---------------------------------------------------------------------------
// Scenario / episodes
// ---------------------------------------------------------------------------

// Story scenario JSON lives at orderedmap/story/<type>/<chapter>.json (type/chapter are the 2nd
// and 3rd path segments), keyed by the full quest path. (Unlike character_story_quest, story
// chapters are not suffix-trimmed.)
function scenarioUrlForStory(questPath) {
  const parts = questPath.split('/');
  if (parts[0] !== 'story' || !parts[1] || !parts[2]) return null;
  return `${ORDEREDMAP}story/${parts[1]}/${parts[2]}.json`;
}

async function buildEpisodes(entry, g, stats) {
  const qb = QUEST_BUCKET[entry.kind];
  const grp = qb && g.normalQuest[qb.bucket];
  const list = grp && grp[entry.storyID];
  if (!list || !list.length) return [];

  const episodes = [];
  const byUrl = new Map();
  for (const [i, q] of list.entries()) {
    const questPath = q[4];
    const title = decodeScenarioText(String(q[0] ?? ''));
    const desc = decodeScenarioText(String(q[1] ?? ''));
    let dialogs = [];
    const url = questPath && scenarioUrlForStory(questPath);
    if (url) {
      if (!byUrl.has(url)) {
        try {
          byUrl.set(url, await cachedFetchJson(url));
        } catch {
          byUrl.set(url, null);
        }
      }
      const data = byUrl.get(url);
      const rows = data && data[questPath];
      if (rows) {
        dialogs = buildStoryDialogs(rows, g.storyChar, {
          special: questPath.includes('main_chapter_00'),
          captureBgm: true,
        });
      }
    }
    const rel = `story/episodes/${qb.key}/${entry.storyID}/${i}.json`;
    const dest = path.join(ASSETS_DIR, rel);
    if (writeJsonIfChanged(dest, { title, desc, dialogs })) invalidateR2(dest);
    stats.dialogLines += dialogs.filter((d) => !d.marker).length;
    episodes.push({ title, desc, file: rel });
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

async function writeBanner(entry, bannerSheet, stats) {
  const dest = path.join(STORY_DIR, 'banners', `${entry.slug}.png`);
  if (!FORCE && existsSync(dest)) return `story/banners/${entry.slug}.png`;
  const sprite = entry.eventID && (await bannerSheet.getSprite(entry.eventID));
  if (!sprite) {
    stats.bannerMisses.push(entry.slug);
    return null;
  }
  if (writeIfChanged(dest, encodePng(sprite))) invalidateR2(dest);
  return `story/banners/${entry.slug}.png`;
}

async function writeHeader(entry, stats) {
  if (!entry.banner || !entry.banner.includes('header_background')) return null;
  const rel = `story/headers/${entry.slug}.png`;
  const dest = path.join(ASSETS_DIR, rel);
  const url = `${CDN_A}${entry.banner.replace(/^encyclopedia\//, '')}.png`;
  try {
    if (await fetchToFile(url, dest, { force: FORCE })) invalidateR2(dest);
    return rel;
  } catch {
    stats.headerMisses.push(entry.slug);
    return null;
  }
}

// Main chapters show an orb/chapter illustration plus a name/desc card from equipment (key
// 100000+chapter, cols [1]/[5]); events/prologue show the extraGallery image set.
async function writeGallery(entry, g) {
  const out = { images: [] };
  if (entry.kind === 'main') {
    const n = Number(entry.storyID);
    const rel = `story/orb/chapter_${n}.png`;
    const dest = path.join(ASSETS_DIR, rel);
    try {
      if (await fetchToFile(`${CDN_B}orb/chapter${n}.png`, dest, { force: FORCE })) invalidateR2(dest);
      // equipment is an ordered map whose value is the row array directly (not double-wrapped
      // like encyclopedia); the chapter orb card is key 100000+chapter, name [1] / desc [5].
      const eq = g.equipment[String(100000 + n)];
      const row = eq && eq[Object.keys(eq)[0]];
      out.orb = {
        file: rel,
        name: row ? decodeScenarioText(String(row[1] ?? '')) : '',
        desc: row ? decodeScenarioText(String(row[5] ?? '')) : '',
      };
    } catch {
      // no orb art for this chapter
    }
  }
  const files = g.extraGallery[entry.eventID] || [];
  for (const [i, filename] of files.entries()) {
    const ext = path.extname(filename) || '.png';
    const rel = `story/gallery/${entry.slug}/${i}${ext}`;
    const dest = path.join(ASSETS_DIR, rel);
    try {
      if (await fetchToFile(`${CDN_B}gallery/${encodeURIComponent(filename)}`, dest, { force: FORCE })) {
        invalidateR2(dest);
      }
      out.images.push(rel);
    } catch {
      // skip a missing gallery image
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BGM
// ---------------------------------------------------------------------------

async function resolveBgm(entry, g, stats) {
  const ids = g.bgmRule[entry.eventID] || [entry.eventID];
  let tracks = [];
  if (entry.kind === 'main' || entry.kind === 'prologue') {
    tracks = g.music.world[ids[0]] || [];
  } else {
    for (const id of ids) tracks = tracks.concat(g.music.event[id] || []);
  }
  const out = [];
  for (const trackPath of tracks) {
    const rel = `story/bgm/${trackPath}`;
    const dest = path.join(ASSETS_DIR, rel);
    if (!SKIP_BGM) {
      try {
        if (await fetchToFile(`${CDN_D}${trackPath}`, dest, { force: FORCE })) invalidateR2(dest);
      } catch {
        continue; // skip a track that won't download
      }
    }
    out.push({ name: path.basename(trackPath, '.mp3'), file: rel });
    stats.bgmTracks++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function dirSizeMB(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  walk(dir);
  return total / (1024 * 1024);
}

async function main() {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8'));
  const rosterByDev = new Map(roster.characters.map((c) => [c.devName, c]));

  console.log('Loading global tables…');
  const g = await loadGlobals();

  const bannerSheet = new Spritesheet('res/banner', CDN_A);
  const sheets = {
    head: new Spritesheet('head', CDN_B),
    icon: new Spritesheet('res/icon', CDN_A),
  };

  let entries = buildStoryEntries(g);
  if (ONLY.size) entries = entries.filter((e) => ONLY.has(e.slug));
  if (LIMIT) entries = entries.slice(0, LIMIT);
  console.log(`${entries.length} story target(s)\n`);

  const stats = { dialogLines: 0, bgmTracks: 0, bannerMisses: [], headerMisses: [] };
  const index = [];
  const catCounts = { main: 0, event: 0, collab: 0 };
  let processed = 0;
  let failures = 0;

  for (const entry of entries) {
    try {
      const category = categoryFor(entry.slug, entry.kind, entry.eventID);
      const banner = await writeBanner(entry, bannerSheet, stats);
      const header = await writeHeader(entry, stats);
      const episodes = await buildEpisodes(entry, g, stats);
      const gallery = await writeGallery(entry, g);
      const bgm = await resolveBgm(entry, g, stats);
      const related = buildRelated(entry.related, g, rosterByDev);

      const detail = { slug: entry.slug, kind: entry.kind, category, title: entry.title };
      if (header) detail.header = header;
      if (entry.desc.length) detail.desc = entry.desc;
      if (related.characters || related.keywords) detail.related = related;
      detail.episodes = episodes;
      if (gallery.orb) detail.orb = gallery.orb;
      if (gallery.images.length) detail.gallery = gallery.images;
      if (bgm.length) detail.bgm = bgm;

      const detailDest = path.join(STORY_DIR, 'detail', `${entry.slug}.json`);
      if (writeJsonIfChanged(detailDest, detail)) invalidateR2(detailDest);

      const row = { slug: entry.slug, kind: entry.kind, category, title: entry.title, episodeCount: episodes.length };
      if (banner) row.banner = banner;
      index.push(row);
      catCounts[category]++;

      processed++;
      const bits = [`ep ${episodes.length}`];
      if (banner) bits.push('banner');
      if (gallery.images.length || gallery.orb) bits.push('gallery');
      if (bgm.length) bits.push(`bgm ${bgm.length}`);
      console.log(`[${processed}/${entries.length}] ${entry.slug} (${category})  ${bits.join(' | ')}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${entry.slug}: ${err.message}`);
    }
  }

  const indexDest = path.join(STORY_DIR, 'index.json');
  if (writeJsonIfChanged(indexDest, { source: SOURCE, stories: index })) invalidateR2(indexDest);

  // Portraits for main-story NPC speakers. Scans story/episodes off disk, so it covers every
  // story written so far, not just this run's targets.
  const storyHeads = await buildStoryHeads(g, roster, sheets, {
    assetsDir: ASSETS_DIR,
    storyHeadsDir: STORY_HEADS_DIR,
    manifestPath: STORY_HEADS_MANIFEST,
    force: FORCE,
    invalidateR2,
  });

  const removed = flushR2Invalidations();
  const bgmMB = dirSizeMB(path.join(STORY_DIR, 'bgm'));

  writeFileSync(
    REPORT_PATH,
    [
      '# main-story pipeline report',
      '',
      `Generated ${new Date().toISOString()}`,
      '',
      `- stories processed: ${processed} (main ${catCounts.main} | event ${catCounts.event} | collab ${catCounts.collab})`,
      `- failures: ${failures}`,
      `- dialogue lines: ${stats.dialogLines}`,
      `- BGM tracks referenced: ${stats.bgmTracks}${SKIP_BGM ? ' (mp3 download skipped)' : ''}`,
      `- BGM on disk: ${bgmMB.toFixed(1)} MB`,
      `- story-only NPC portraits: ${storyHeads.count} (${storyHeads.wrote} written this run)`,
      `- R2 keys invalidated: ${removed}`,
      '',
      `## banner sprite misses (${stats.bannerMisses.length}) — front-end shows a text banner`,
      '',
      ...stats.bannerMisses.map((s) => `- ${s}`),
      '',
      `## header background misses (${stats.headerMisses.length})`,
      '',
      ...stats.headerMisses.map((s) => `- ${s}`),
      '',
    ].join('\n')
  );

  console.log(
    `\nDone. ${processed} stories (main ${catCounts.main} | event ${catCounts.event} | collab ${catCounts.collab}), ${failures} failure(s).` +
      `\n  dialogue lines: ${stats.dialogLines} | BGM tracks: ${stats.bgmTracks} | BGM on disk: ${bgmMB.toFixed(1)} MB | NPC heads: ${storyHeads.count} | R2 invalidated: ${removed}` +
      `\n  See ${path.relative(process.cwd(), REPORT_PATH)}.`
  );
  process.exit(failures > 0 ? 1 : 0);
}

main();
