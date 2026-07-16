// Fetches character data from worldflipper.miaowm5.com's public CDNs and merges it into
// Character Assets/. See scripts/lib/miaowm5-common.mjs for the CDN map and the ports of the
// upstream site's parsing logic.
//
// What this pipeline owns (and the only things it may touch) in wiki_zh.json:
//   info, related, emotions, pixelActions, storyCount, miaowm5Meta, and voice[].textJp
// Everything else in that file belongs to the bilibili wiki pipeline and is passed through
// untouched. Separately it writes story_zh.json, emotion/*.png and the missing pixel *.gif.
//
// Three ID spaces, and mixing them up is the main trap here:
//   devName  — roster.json + the on-disk folder name; the key for character.json/pixel.json
//   gameId   — numeric; the key for character_text / character_quest / encyclopedia[5]
//   storyId  — character.json[8]; the key for story_character and the pixel atlases
// storyId usually equals devName but not always, so never assume.
//
// Usage:
//   node scripts/fetch-miaowm5.mjs                     resume; only do what's missing
//   node scripts/fetch-miaowm5.mjs --force             redo every step, ignore the manifest
//   node scripts/fetch-miaowm5.mjs --limit=30          only the first 30 roster characters
//   node scripts/fetch-miaowm5.mjs --only=fire_dragon  only these devNames (comma-separated)
//   node scripts/fetch-miaowm5.mjs --new-chars         add characters missing from roster.json
//
// --new-chars iterates character.json instead of roster.json, so it can bootstrap characters
// the roster has never heard of: it creates rarityN/<devName>/, runs the same per-character
// steps, and appends a roster entry. Those characters get no full_shot_1440_1920_*.png —
// miaowm5 has no 1440x1920 art, only the 570x690 story bust we already export as emotion/*.png
// — so their roster entry carries `bustOnly: true` and the detail page uses the bust as hero
// art. They also carry no enName/jpName (miaowm5 is a Chinese source), only zhName.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ORDEREDMAP,
  CDN_A,
  CDN_B,
  CDN_C,
  PIXEL_SCALE,
  PIXEL_SPEED_MS,
  BATTLE_VOICE_MAP,
  Spritesheet,
  cachedFetchJson,
  createFrame,
  createTimeline,
  decodeScenarioText,
  encodeGif,
  encodePng,
  scaleNearest,
  writeIfChanged,
  writeJsonIfChanged,
} from './lib/miaowm5-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const ROSTER_PATH = path.join(ASSETS_DIR, 'roster.json');
const MANIFEST_PATH = path.resolve('scripts/.miaowm5-manifest.json');
const R2_MANIFEST_PATH = path.resolve('scripts/.r2-upload-manifest.json');
const REPORT_PATH = path.join(ASSETS_DIR, '_miaowm5_report.md');
const SOURCE = 'worldflipper.miaowm5.com';

const FORCE = process.argv.includes('--force');
const NEW_CHARS = process.argv.includes('--new-chars');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const ONLY = new Set(
  ((process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '')
    .split(',')
    .filter(Boolean)
);

// character.json row columns, verified against all 377 pre-existing roster entries:
// row[0] devName, row[2] rarity, row[3] attribute, row[8] storyId.
const ATTRIBUTES = ['Fire', 'Water', 'Thunder', 'Wind', 'Light', 'Dark'];

// Engine-internal entries — assist-character stubs, mechanic variants (`_no_piercing`) and
// story-boss forms (`_chapter12`) — all live in this gameId block, and none of the roster's
// real characters do, so the prefix is a safe exclusion rule on its own.
const INTERNAL_GAMEID_PREFIX = '700';

// The five pixel actions the site already ships per character (plus `special`), so the pixel
// step only generates what's genuinely missing.
const EXISTING_GIFS = ['neutral', 'walk_front', 'walk_back', 'kachidoki', 'skill_ready', 'special'];

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

function loadManifest() {
  if (FORCE || !existsSync(MANIFEST_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveManifest(m) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 0));
}

// Any asset we actually rewrote must be re-uploaded, but upload-to-r2.mjs skips anything
// already in its path-keyed manifest. Dropping the key here (rather than teaching that script
// about content hashes) keeps the two pipelines decoupled.
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
  for (const key of r2Invalidated) {
    if (done.delete(key)) removed++;
  }
  if (removed) writeFileSync(R2_MANIFEST_PATH, JSON.stringify([...done], null, 0));
  return removed;
}

// ---------------------------------------------------------------------------
// Phase 0: global tables
// ---------------------------------------------------------------------------

// Port of the upstream `encyclopedia` database handler: each entry is a sub-map whose values'
// [0] is the row; [4] is the entry type, [17] the title, [19] a CSV of related entry ids, and
// each row's [20] contributes one description block.
function parseEncyclopedia(raw) {
  const out = {};
  for (const key of Object.keys(raw)) {
    const rows = Object.keys(raw[key]).map((k) => raw[key][k][0]);
    const first = rows[0];
    if (!first) continue;
    const entry = { type: 'normal', title: first[17], related: [], desc: [] };
    if (first[4] === '0' || first[4] === '1') {
      entry.type = 'character';
      entry.characterID = first[5];
      entry.storyID = first[6];
    } else if (first[4] === '2') {
      entry.type = 'npc';
      entry.storyID = first[6];
    } else if (first[4] === '3' || first[4] === '4' || first[4] === '5') {
      entry.type = 'story';
    }
    entry.related = first[19] ? String(first[19]).split(',') : [];
    entry.desc = rows.map((r) => decodeScenarioText(String(r[20] ?? '')));
    out[key] = entry;
  }
  return out;
}

// Port of the upstream `story_character` handler: [0] display name, [1] 0xRRGGBB colour,
// [3]/[4]/[5] are parallel CSVs of emotion name / back sprite / front sprite.
function parseStoryCharacter(raw) {
  const out = {};
  for (const key of Object.keys(raw)) {
    const row = raw[key][0];
    if (!row) continue;
    const names = String(row[3] ?? '').split(',');
    const backs = String(row[4] ?? '').split(',');
    const fronts = String(row[5] ?? '').split(',');
    const emotions = {};
    names.forEach((name, i) => {
      if (!name) return;
      const back = (backs[i] || '(None)') === '(None)' ? null : backs[i];
      const front = (fronts[i] || '(None)') === '(None)' ? null : fronts[i];
      emotions[name] = { back, front };
    });
    out[key] = { name: row[0], color: row[1], emotions };
  }
  return out;
}

// Port of the upstream `character_quest` handler: rows grouped by gameId ([0]), carrying
// title [3], synopsis [123] and the scenario path [126].
function parseCharacterQuest(raw) {
  const out = {};
  for (const key of Object.keys(raw)) {
    const row = raw[key][0];
    if (!row) continue;
    const gameId = String(row[0]);
    if (!out[gameId]) out[gameId] = [];
    out[gameId].push({ title: row[3], desc: row[123], path: row[126] });
  }
  return out;
}

async function loadGlobals() {
  const [characterRaw, characterText, encyclopediaRaw, voiceLine, storyCharRaw, questRaw, pixel] =
    await Promise.all([
      cachedFetchJson(`${ORDEREDMAP}character/character.json`),
      cachedFetchJson(`${ORDEREDMAP}character/character_text.json`),
      cachedFetchJson(`${ORDEREDMAP}encyclopedia/encyclopedia.json`),
      cachedFetchJson(`${CDN_C}common/voiceLine.json`),
      cachedFetchJson(`${ORDEREDMAP}story/story_character.json`),
      cachedFetchJson(`${ORDEREDMAP}quest/character_quest.json`),
      cachedFetchJson(`${CDN_B}pixel.json`),
    ]);

  // character.json: gameId -> row; row[0] is devName, row[8] is storyId.
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

  const encyclopedia = parseEncyclopedia(encyclopediaRaw);
  // encyclopedia entries are keyed by their own id; characters are found via [5] = gameId.
  const encByGameId = new Map();
  for (const [id, e] of Object.entries(encyclopedia)) {
    if (e.type === 'character' && e.characterID) encByGameId.set(String(e.characterID), { id, ...e });
  }

  return {
    byDevName,
    byGameId,
    text,
    encyclopedia,
    encByGameId,
    voiceLine,
    storyChar: parseStoryCharacter(storyCharRaw),
    quest: parseCharacterQuest(questRaw),
    pixel,
  };
}

// ---------------------------------------------------------------------------
// per-character steps
// ---------------------------------------------------------------------------

const normalize = (s) => String(s ?? '').replace(/\s+/g, '');

// (a) The encyclopedia's description blocks duplicate a lot of what the bilibili wiki already
// gives us as story.intro / story.stories[].text, so drop any block that's a (whitespace-
// insensitive) repeat or substring of existing text.
function buildInfo(encEntry, wiki) {
  if (!encEntry) return [];
  const existing = [];
  if (wiki?.story?.intro) existing.push(normalize(wiki.story.intro));
  for (const s of wiki?.story?.stories || []) existing.push(normalize(s.text));
  const out = [];
  for (const block of encEntry.desc) {
    const t = block.trim();
    if (!t) continue;
    const n = normalize(t);
    if (existing.some((e) => e === n || e.includes(n))) continue;
    if (out.some((o) => normalize(o) === n)) continue;
    out.push(t);
  }
  return out;
}

// (b) Related entries split into playable characters (encyclopedia type 0/1, which carry a
// gameId we can resolve back to the roster) and everything else, shown as keyword chips.
function buildRelated(encEntry, g, rosterByDev) {
  if (!encEntry) return null;
  const characters = [];
  const keywords = [];
  for (const id of encEntry.related) {
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
      keywords.push({ id, title, desc: e.desc.join('\n').trim() });
    }
  }
  if (!characters.length && !keywords.length) return null;
  const out = {};
  if (characters.length) out.characters = characters;
  if (keywords.length) out.keywords = keywords;
  return out;
}

// (c) Stamp the Japanese battle line onto the matching wiki voice entry. Always strip every
// existing textJp first so a re-run can't leave a stale one behind.
function applyTextJp(wiki, devName, g) {
  let count = 0;
  for (const entry of wiki.voice || []) delete entry.textJp;
  const lines = g.voiceLine[devName];
  if (!lines) return 0;
  for (const entry of wiki.voice || []) {
    if (entry.context !== '战斗') continue;
    const key = BATTLE_VOICE_MAP[String(entry.text || '').split('\n')[0].trim()];
    if (!key) continue;
    const jp = lines[key];
    if (!jp) continue;
    entry.textJp = jp;
    count++;
  }
  return count;
}

// (d) Emotion art is two stacked 570x690 layers (a shared body `back` + a per-emotion `front`),
// which we store as separate PNGs and let the front-end overlay — far fewer bytes than
// flattening every emotion into its own full composite.
async function buildEmotions(storyId, charDir, g, sheets) {
  const sc = g.storyChar[storyId];
  if (!sc || !Object.keys(sc.emotions).length) return null;

  const emotionDir = path.join(charDir, 'emotion');
  const backIndex = new Map();
  const manifest = [];
  let wrote = 0;

  // Filenames are positional, so they're derivable without touching the atlas. That lets a
  // re-run skip decoding a ~6MB atlas page whenever the PNG is already on disk — an existing
  // file means the sprite resolved on an earlier run. Emitting the sprite is the slow path.
  const emit = async (spriteName, file) => {
    const dest = path.join(emotionDir, file);
    if (!FORCE && existsSync(dest)) return true;
    const sprite = await sheets.story.getSprite(spriteName);
    if (!sprite) return false;
    if (writeIfChanged(dest, encodePng(sprite))) {
      invalidateR2(dest);
      wrote++;
    }
    return true;
  };

  for (const [name, { back, front }] of Object.entries(sc.emotions)) {
    let baseFile = null;
    if (back) {
      if (!backIndex.has(back)) {
        const file = `base_${backIndex.size}.png`;
        backIndex.set(back, (await emit(back, file)) ? file : null);
      }
      baseFile = backIndex.get(back);
    }

    let frontFile = null;
    if (front) {
      const file = `${manifest.length}_${name}.png`;
      if (await emit(front, file)) frontFile = file;
    }

    if (!baseFile && !frontFile) continue;
    manifest.push({ name, base: baseFile, front: frontFile });
  }

  return manifest.length ? { manifest, wrote } : null;
}

// (e) Generate any pixel action the character folder is missing. The site ships 5 normal
// actions + special; pixel.json's timeline usually also holds into_coffin / ghost_raise /
// ghost_neutral / revive, which is what this fills in.
async function buildPixelGifs(storyId, charDir, g, sheets) {
  const cfg = g.pixel[storyId];
  if (!cfg) return null;

  const present = new Set(
    readdirSync(charDir)
      .filter((f) => f.endsWith('.gif'))
      .map((f) => f.slice(0, -4))
  );
  const wanted = (cfg.timeline || []).filter((t) => FORCE || !present.has(t.name));

  const generated = [];
  if (wanted.length) {
    const sheet = await sheets.pixelNormal.getSprite(storyId);
    if (!sheet) return null;
    const imageList = createFrame(cfg.normal || [], sheet, 0);

    for (const t of wanted) {
      const movie = createTimeline(t, imageList);
      if (!movie) continue;
      const frames = [];
      for (const [id, duration] of movie.timeline2) {
        const frame = movie.frames.get(id);
        if (!frame) continue;
        frames.push({ rgba: scaleNearest(frame, PIXEL_SCALE), delayMs: duration * PIXEL_SPEED_MS });
      }
      if (!frames.length) continue;
      const dest = path.join(charDir, `${t.name}.gif`);
      if (encodeGif(frames, dest)) invalidateR2(dest);
      generated.push(t.name);
      present.add(t.name);
    }
  }

  // Report what the folder actually holds now, so the UI never advertises a missing file.
  const actions = readdirSync(charDir)
    .filter((f) => f.endsWith('.gif'))
    .map((f) => f.slice(0, -4));
  const order = (cfg.timeline || []).map((t) => t.name);
  actions.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  return { actions, generated };
}

// (f) Full story dialogue. One fetch per character returns every one of their stories, keyed
// by the same scenario path character_quest gave us.
//
// Emotion state is tracked per speaker, not per on-screen slot: type 6 (face) introduces a
// character with an emotion, but type 12 (face-change) later updates it by devName alone, and
// it's by far the more common command — keying off the slot would show a stale emotion.
function buildStoryDialogs(rows, g) {
  const emotionByChar = new Map();
  const dialogs = [];
  for (const key of Object.keys(rows)) {
    for (const item of rows[key]) {
      const type = item[0];
      if (type === '6') {
        if (item[12]) emotionByChar.set(item[12], item[14] || null);
      } else if (type === '12') {
        if (item[19]) emotionByChar.set(item[19], item[20] || null);
      } else if (type === '8') {
        emotionByChar.clear();
      } else if (type === '0') {
        const dev = item[4] || '';
        const sc = g.storyChar[dev];
        const color = sc?.color ? `#${String(sc.color).slice(2)}` : '#3E4450';
        dialogs.push({
          speakerDev: dev,
          speaker: sc?.name || dev,
          color,
          emotion: emotionByChar.get(dev) || null,
          text: decodeScenarioText(String(item[5] ?? '')),
        });
      }
    }
  }
  return dialogs;
}

// The scenario JSON lives at .../character_story_quest/<base>.json, where <base> is the quest
// path's folder minus its _NNN suffix (mirrors upstream getUrl); the file is keyed by the
// full original path.
function scenarioUrlFor(questPath) {
  const parts = questPath.split('/');
  if (parts[0] !== 'story' || parts[1] !== 'character_story_quest' || !parts[2]) return null;
  const base = parts[2].slice(0, parts[2].length - 4);
  if (!base) return null;
  return `${ORDEREDMAP}story/character_story_quest/${base}.json`;
}

async function buildStories(gameId, g) {
  const quests = g.quest[String(gameId)];
  if (!quests || !quests.length) return null;

  const byUrl = new Map();
  const stories = [];
  for (const [i, q] of quests.entries()) {
    if (!q.path) continue;
    const url = scenarioUrlFor(q.path);
    if (!url) continue;
    if (!byUrl.has(url)) {
      try {
        byUrl.set(url, await cachedFetchJson(url));
      } catch (err) {
        byUrl.set(url, null);
      }
    }
    const data = byUrl.get(url);
    const rows = data && data[q.path];
    if (!rows) continue;
    const dialogs = buildStoryDialogs(rows, g);
    if (!dialogs.length) continue;
    stories.push({
      id: `${i + 1}`,
      title: decodeScenarioText(String(q.title ?? '')),
      desc: decodeScenarioText(String(q.desc ?? '')),
      dialogs,
    });
  }
  return stories.length ? stories : null;
}

// (g) A minimal wiki_zh.json for the handful of roster characters the bilibili pipeline never
// matched, so the front-end can treat every character's file the same shape.
function emptyWiki() {
  return {
    sourceUrl: null,
    basicInfo: {},
    stats: {},
    skills: [],
    story: { intro: '', stories: [] },
    review: '',
    voice: [],
  };
}

// `generatedAt` records when the data was last actually generated, not when the script last
// ran: stamping every run would rewrite all ~370 story files (and force a full R2 re-upload)
// daily, and would make the "re-run produces zero diff" idempotency check impossible.
function withStableStamp(filePath, payload) {
  let generatedAt = new Date().toISOString().slice(0, 10);
  if (existsSync(filePath)) {
    try {
      const prev = JSON.parse(readFileSync(filePath, 'utf8'));
      const { generatedAt: prevAt, ...prevRest } = prev;
      if (prevAt && JSON.stringify(prevRest) === JSON.stringify(payload)) generatedAt = prevAt;
    } catch {
      // unreadable/corrupt previous file: fall through and stamp today
    }
  }
  return { generatedAt, ...payload };
}

function setOrDelete(obj, key, value) {
  const empty =
    value == null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  if (empty) delete obj[key];
  else obj[key] = value;
}

// ---------------------------------------------------------------------------
// target selection
// ---------------------------------------------------------------------------

// Default mode: the roster is the source of truth, and a character.json/folder miss is
// reportable (`missing`) rather than something to create.
function rosterTargets(roster, g, missing) {
  const out = [];
  for (const c of roster.characters) {
    if (!c.thumb) continue;
    const rec = g.byDevName.get(c.devName);
    if (!rec) {
      missing.push(c);
      continue;
    }
    const charDir = path.join(ASSETS_DIR, path.dirname(c.thumb));
    if (!existsSync(charDir)) {
      missing.push(c);
      continue;
    }
    out.push({ devName: c.devName, gameId: rec.gameId, storyId: rec.storyId, charDir, isNew: false });
  }
  return out;
}

// --new-chars mode: character.json is the source of truth. A real, addable character is one
// the roster lacks that has both a pixel timeline (its sprites, incl. the neutral.gif we use
// as the thumbnail) and story_character art (its bust, which is the only hero art available).
function newCharTargets(roster, g) {
  const known = new Set(roster.characters.map((c) => c.devName));
  const out = [];
  for (const [devName, rec] of g.byDevName) {
    if (known.has(devName)) continue;
    if (String(rec.gameId).startsWith(INTERNAL_GAMEID_PREFIX)) continue;
    if (!g.pixel[rec.storyId]) continue;
    const sc = g.storyChar[rec.storyId];
    if (!sc || !Object.keys(sc.emotions).length) continue;
    const rarity = Number(rec.row[2]);
    const attribute = ATTRIBUTES[Number(rec.row[3])];
    const zhName = g.text[String(rec.gameId)]?.[0] || '';
    if (!rarity || !attribute || !zhName) continue;
    out.push({
      devName,
      gameId: rec.gameId,
      storyId: rec.storyId,
      charDir: path.join(ASSETS_DIR, `rarity${rarity}`, devName),
      isNew: true,
      rarity,
      attribute,
      zhName,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8'));
  const manifest = loadManifest();

  console.log('Loading global tables…');
  const g = await loadGlobals();
  console.log(
    `  character ${g.byDevName.size} | encyclopedia chars ${g.encByGameId.size} | story_character ${
      Object.keys(g.storyChar).length
    } | pixel ${Object.keys(g.pixel).length}`
  );

  const sheets = {
    story: new Spritesheet('character/story', CDN_A),
    pixelNormal: new Spritesheet('pixel_normal', CDN_B),
  };

  const rosterByDev = new Map(roster.characters.map((c) => [c.devName, c]));
  const missing = [];
  let targets = NEW_CHARS ? newCharTargets(roster, g) : rosterTargets(roster, g, missing);
  if (ONLY.size) targets = targets.filter((t) => ONLY.has(t.devName));
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(`${targets.length} target(s)${NEW_CHARS ? ' (new characters)' : ''}\n`);

  const added = [];
  const noThumb = [];
  let processed = 0;
  let failures = 0;
  let storyFiles = 0;
  let gifCount = 0;
  let emotionCount = 0;

  for (const t of targets) {
    const { devName, gameId, storyId, charDir } = t;
    try {
      if (t.isNew) mkdirSync(charDir, { recursive: true });

      const wikiPath = path.join(charDir, 'wiki_zh.json');
      const wiki = existsSync(wikiPath) ? JSON.parse(readFileSync(wikiPath, 'utf8')) : emptyWiki();

      const encEntry = g.encByGameId.get(String(gameId));
      const info = buildInfo(encEntry, wiki);
      const related = buildRelated(encEntry, g, rosterByDev);
      const jpCount = applyTextJp(wiki, devName, g);

      const emotions = await buildEmotions(storyId, charDir, g, sheets);
      if (emotions) emotionCount += emotions.wrote;

      const pixel = await buildPixelGifs(storyId, charDir, g, sheets);
      if (pixel) gifCount += pixel.generated.length;

      const stories = await buildStories(gameId, g);
      if (stories) {
        const storyPath = path.join(charDir, 'story_zh.json');
        if (writeJsonIfChanged(storyPath, withStableStamp(storyPath, { source: SOURCE, stories }))) {
          invalidateR2(storyPath);
        }
        storyFiles++;
      }

      setOrDelete(wiki, 'info', info);
      setOrDelete(wiki, 'related', related);
      setOrDelete(wiki, 'emotions', emotions ? emotions.manifest : null);
      setOrDelete(wiki, 'pixelActions', pixel ? pixel.actions : null);
      setOrDelete(wiki, 'storyCount', stories ? stories.length : 0);
      wiki.miaowm5Meta = { gameId, storyId, source: SOURCE };

      if (writeJsonIfChanged(wikiPath, wiki)) invalidateR2(wikiPath);

      // The roster entry is only worth adding once the character has the two things the UI
      // needs: a thumbnail (neutral.gif) for the grid and a bust for the detail hero. Adding
      // it earlier would put a broken tile in the grid.
      if (t.isNew) {
        if (existsSync(path.join(charDir, 'neutral.gif'))) {
          const entry = {
            devName,
            rarity: t.rarity,
            attribute: t.attribute,
            thumb: `rarity${t.rarity}/${devName}/neutral.gif`,
            zhName: t.zhName,
            hasWiki: false,
            bustOnly: true,
          };
          roster.characters.push(entry);
          rosterByDev.set(devName, entry);
          added.push(entry);
        } else {
          noThumb.push(devName);
        }
      }

      manifest[devName] = { gameId, storyId, at: new Date().toISOString() };
      processed++;
      const bits = [];
      if (info.length) bits.push(`info ${info.length}`);
      if (related) bits.push(`related ${(related.characters?.length || 0) + (related.keywords?.length || 0)}`);
      if (jpCount) bits.push(`jp ${jpCount}`);
      if (emotions) bits.push(`emotions ${emotions.manifest.length}`);
      if (pixel?.generated.length) bits.push(`gif +${pixel.generated.join(',')}`);
      if (stories) bits.push(`stories ${stories.length}`);
      console.log(`[${processed}/${targets.length}] ${devName}  ${bits.join(' | ') || '(nothing new)'}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${devName}: ${err.message}`);
    }

    if (processed % 10 === 0) saveManifest(manifest);
  }

  saveManifest(manifest);
  if (added.length) {
    roster.count = roster.characters.length;
    roster.generatedAt = new Date().toISOString();
  }
  if (writeIfChanged(ROSTER_PATH, Buffer.from(JSON.stringify(roster, null, 2), 'utf8'))) {
    invalidateR2(ROSTER_PATH);
  }

  const removed = flushR2Invalidations();

  // The roster-vs-miaowm5 gap report only means anything when the roster drives the run;
  // --new-chars walks character.json, so leave the existing report alone.
  if (!NEW_CHARS) {
    writeFileSync(
      REPORT_PATH,
      [
        '# miaowm5 pipeline report',
        '',
        `Generated ${new Date().toISOString()}`,
        '',
        `- processed: ${processed}`,
        `- failures: ${failures}`,
        `- story_zh.json written: ${storyFiles}`,
        `- pixel GIFs generated: ${gifCount}`,
        `- emotion PNGs written: ${emotionCount}`,
        '',
        `## roster characters not found in miaowm5 character.json (${missing.length})`,
        '',
        ...missing.map((c) => `- ${c.devName} — "${c.enName}"`),
        '',
      ].join('\n')
    );
  }

  console.log(
    `\nDone. ${processed} processed, ${failures} failure(s), ${missing.length} not in miaowm5 data.` +
      `\n  story_zh.json: ${storyFiles} | new GIFs: ${gifCount} | emotion PNGs: ${emotionCount} | R2 keys invalidated: ${removed}` +
      (NEW_CHARS ? `\n  roster entries added: ${added.length}${noThumb.length ? ` | skipped (no neutral.gif): ${noThumb.join(', ')}` : ''}` : '') +
      (NEW_CHARS ? '' : `\n  See ${path.relative(process.cwd(), REPORT_PATH)}.`)
  );
  process.exit(failures > 0 ? 1 : 0);
}

main();
