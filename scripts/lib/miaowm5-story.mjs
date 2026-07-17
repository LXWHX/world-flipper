// Story-related ports of the miaowm5 site's parsing logic, shared by the two pipelines:
// scripts/fetch-miaowm5.mjs (per-character) and scripts/fetch-main-story.mjs (main/event story
// browser). Kept here — rather than duplicated — because both need the same encyclopedia/
// story_character decoders, the same scenario-dialogue interpreter, and the same story-only-NPC
// head-portrait builder. See the block comment on each function for the upstream file it mirrors.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  blit,
  createRgba,
  decodeScenarioText,
  encodePng,
  scaleBilinear,
  writeIfChanged,
  writeJsonIfChanged,
} from './miaowm5-common.mjs';

// ---------------------------------------------------------------------------
// Table decoders
// ---------------------------------------------------------------------------

// Port of the upstream `encyclopedia` database handler: each entry is a sub-map whose values'
// [0] is the row; [4] is the entry type, [17] the title, [19] a CSV of related entry ids, and
// each row's [20] contributes one description block.
//
// Story entries (type 3/4/5) additionally carry the fields the main-story browser needs — this
// is a superset of what the character pipeline reads (which only touches type/characterID/
// storyID/title/related/desc), so adding them is transparent to that pipeline.
export function parseEncyclopedia(raw) {
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
      entry.eventID = first[1];
      entry.banner = first[16];
      if (first[4] === '3') {
        entry.subType = 'main';
        entry.storyID = first[12];
      } else if (first[4] === '5') {
        entry.subType = 'prologue';
        entry.storyID = ''; // prologue episodes live at main_quest[0]
      } else {
        // type 4 events: [13] picks the quest bucket, [14] is the storyID within it.
        const sub = first[13];
        entry.subType = sub === '6' ? 'event-world' : sub === '2' ? 'event-single' : 'event-quest';
        entry.storyID = first[14];
      }
    }
    entry.related = first[19] ? String(first[19]).split(',') : [];
    entry.desc = rows.map((r) => decodeScenarioText(String(r[20] ?? '')));
    out[key] = entry;
  }
  return out;
}

// Port of the upstream `story_character` handler: [0] display name, [1] 0xAARRGGBB colour,
// [3]/[4]/[5] are parallel CSVs of emotion name / back sprite / front sprite.
export function parseStoryCharacter(raw) {
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

// The scenario command interpreter (port of src/detail/scenario/parseData.js), reduced to the
// commands the dialogue reader cares about. Emotion state is tracked per speaker (devName), not
// per on-screen slot: type 6 (face) introduces a character with an emotion, but type 12
// (face-change) updates it by devName alone and is far more common, so keying off the slot
// would show a stale emotion.
//
//   opts.special    — prologue scenarios (main_chapter_00) store one row per index key instead
//                     of an array of rows; upstream calls parse(config[path], true) for them.
//   opts.captureBgm — also emit inline { marker:'bgm', name } rows at each BGM change (type 1,
//                     column [36]); the character pipeline leaves this off so its story_zh.json
//                     files stay byte-identical.
export function buildStoryDialogs(rows, storyChar, opts = {}) {
  const { special = false, captureBgm = false } = opts;
  const emotionByChar = new Map();
  const dialogs = [];
  for (const key of Object.keys(rows)) {
    const items = special ? [rows[key]] : rows[key];
    for (const item of items) {
      const type = item[0];
      if (type === '6') {
        if (item[12]) emotionByChar.set(item[12], item[14] || null);
      } else if (type === '12') {
        if (item[19]) emotionByChar.set(item[19], item[20] || null);
      } else if (type === '8') {
        emotionByChar.clear();
      } else if (type === '1') {
        if (captureBgm && item[36]) dialogs.push({ marker: 'bgm', name: String(item[36]) });
      } else if (type === '0') {
        const dev = item[4] || '';
        const sc = storyChar[dev];
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

// ---------------------------------------------------------------------------
// Framed head portraits (shared by both pipelines)
// ---------------------------------------------------------------------------

// Element badge sprite per character.json row[3] index (0..5 → red/blue/yellow/green/white/black),
// matching the ATTRIBUTES order the roster uses.
export const ELEMENT_ICONS = [
  'element_red_medium', // 0 Fire
  'element_blue_medium', // 1 Water
  'element_yellow_medium', // 2 Thunder
  'element_green_medium', // 3 Wind
  'element_white_medium', // 4 Light
  'element_black_medium', // 5 Dark
];

// The 212x212 framed square portrait (port of headIcon.svelte's canvas composite), shared by
// buildHeadIcon (roster characters) and buildStoryHeads (story-only NPCs). The portrait is inset
// to 184x184 at (14,14) so the frame's white border rings it, and the element badge lands in the
// notch the frame leaves at the top right. A character with no element (elementIndex < 0 — every
// pure NPC, since they carry no character.json row) gets the un-notched empty frame and no badge.
export async function composeHeadIcon(portrait, elementIndex, sheets) {
  const canvas = createRgba(212, 212);
  const inset = scaleBilinear(portrait, 184, 184);
  blit(canvas, inset, 0, 0, inset.w, inset.h, 14, 14);

  const elementName = ELEMENT_ICONS[elementIndex];
  const frame = await sheets.icon.getSprite(
    elementName ? 'character_face_frame' : 'character_face_empty_frame'
  );
  if (frame) blit(canvas, frame, 0, 0, frame.w, frame.h, 0, 0);
  if (elementName) {
    const badge = await sheets.icon.getSprite(elementName);
    if (badge) {
      const b = scaleBilinear(badge, 48, 48);
      blit(canvas, b, 0, 0, b.w, b.h, 154, 10);
    }
  }
  return canvas;
}

// Every speaker that appears in any already-written story file, read off disk rather than
// accumulated in a per-target loop so the set stays complete under --only/--limit (a partial run
// still sees every prior run's story files). Scans both story sources so whichever pipeline runs
// buildStoryHeads produces the union: rarityN/<dev>/story_zh.json (character stories) and
// story/episodes/**/*.json (main/event stories).
export function collectStorySpeakers(assetsDir) {
  const speakers = new Set();
  const addDialogs = (dialogs) => {
    for (const d of dialogs || []) if (d.speakerDev) speakers.add(d.speakerDev);
  };

  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^rarity\d+$/.test(entry.name)) continue;
    const rarityDir = path.join(assetsDir, entry.name);
    for (const sub of readdirSync(rarityDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const storyPath = path.join(rarityDir, sub.name, 'story_zh.json');
      if (!existsSync(storyPath)) continue;
      try {
        const data = JSON.parse(readFileSync(storyPath, 'utf8'));
        for (const st of data.stories || []) addDialogs(st.dialogs);
      } catch {
        // a corrupt/half-written story file just contributes no speakers
      }
    }
  }

  const epRoot = path.join(assetsDir, 'story', 'episodes');
  if (existsSync(epRoot)) {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.json')) {
          try {
            addDialogs(JSON.parse(readFileSync(full, 'utf8')).dialogs);
          } catch {
            // ignore a corrupt episode file
          }
        }
      }
    };
    walk(epRoot);
  }

  return speakers;
}

// Portraits for the story-only NPCs — the speakers the front-end can't resolve through the roster
// (protagonists like Light/Stella, recurring NPCs, story bosses). Same 212x212 composite as the
// roster head icons, but with no element (these carry no character.json row → empty frame). Writes
// a flat devName->path map the front-end loads once; the UI trusts the manifest, not the bare path,
// so a speaker with no head sprite keeps its plain name plate instead of a 404.
//
// `g` need only carry `byDevName` (for the rare NPC that does have a character.json row → element).
export async function buildStoryHeads(g, roster, sheets, opts) {
  const { assetsDir, storyHeadsDir, manifestPath, force = false, invalidateR2 } = opts;
  const rosterDevs = new Set(roster.characters.map((c) => c.devName));
  const speakers = [...collectStorySpeakers(assetsDir)].filter((d) => !rosterDevs.has(d)).sort();
  const manifest = {};
  let wrote = 0;
  for (const dev of speakers) {
    const dest = path.join(storyHeadsDir, `${dev}.png`);
    if (!force && existsSync(dest)) {
      manifest[dev] = `story_heads/${dev}.png`;
      continue;
    }
    const portrait = await sheets.head.getSprite(dev);
    if (!portrait) continue; // NPC with dialogue but no head sprite — stays a name plate
    const rec = g.byDevName.get(dev); // almost always absent; -1 -> empty frame, no badge
    const canvas = await composeHeadIcon(portrait, rec ? Number(rec.row[3]) : -1, sheets);
    if (!existsSync(storyHeadsDir)) mkdirSync(storyHeadsDir, { recursive: true });
    if (writeIfChanged(dest, encodePng(canvas))) {
      invalidateR2(dest);
      wrote++;
    }
    manifest[dev] = `story_heads/${dev}.png`;
  }
  if (writeJsonIfChanged(manifestPath, manifest)) invalidateR2(manifestPath);
  return { wrote, count: Object.keys(manifest).length };
}
