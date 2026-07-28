// Builds Character Assets/story/gallery_index.json — the Art tab's gallery wall — plus the
// downscaled thumbnails under story/thumbs/, from the story files fetch-main-story.mjs already
// wrote. Pure local derivation, no network: every story's `orb` (if any) followed by its
// `gallery[]`, flattened into one array with each image's pixel dimensions attached.
// Re-run after any fetch:story run so the wall tracks new events.
//
// The dimensions are the reason this file exists at all: the front-end packs the wall into two
// masonry columns arithmetically, which needs w/h *before* the first paint, and the detail files
// carry no dimensions. (Fetching all 42 detail files to render 64 tiles would also be ~872 KB
// against this index's few KB — the same trade music_index.json already makes.)
//
// Usage: node scripts/build-gallery-index.mjs [--force] [--no-thumbs]
//        --force      regenerate thumbnails that already exist (see THUMB_WIDTH below)
//        --no-thumbs  write the index only

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { writeJsonIfChanged } from './lib/miaowm5-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const STORY_DIR = path.join(ASSETS_DIR, 'story');
const INDEX_PATH = path.join(STORY_DIR, 'index.json');
const DEST_PATH = path.join(STORY_DIR, 'gallery_index.json');
const THUMBS_DIR = path.join(STORY_DIR, 'thumbs');
const R2_MANIFEST_PATH = path.resolve('scripts/.r2-upload-manifest.json');
const SOURCE = 'worldflipper.miaowm5.com';

// 440px against the wall's 197px design column is ~2.2x — right for DPR 2-3 phones. The sources
// run up to 3.2 MB each (55 MB for all 64); at this size the whole wall is ~3 MB.
const THUMB_WIDTH = 440;
const THUMB_QUALITY = 78;

const FORCE = process.argv.includes('--force');
const NO_THUMBS = process.argv.includes('--no-thumbs');

// ---------------------------------------------------------------------------
// R2 invalidation (same contract as fetch-main-story.mjs: drop rewritten keys from the upload
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

if (!existsSync(INDEX_PATH)) {
  console.error('Character Assets/story/index.json not found — run `npm run fetch:story` first.');
  process.exit(1);
}

// story/gallery/<slug>/0.png -> story/thumbs/gallery/<slug>/0.webp
function thumbRelFor(rel) {
  const inner = rel.replace(/^story\//, '').replace(/\.[^./]+$/, '.webp');
  return `story/thumbs/${inner}`;
}

let written = 0;
let skipped = 0;

// Thumbnails follow the composited-image rule: present means done, so a re-run touches nothing.
// Changing THUMB_WIDTH/THUMB_QUALITY therefore means deleting story/thumbs/ first (or --force).
async function makeThumb(srcAbs, thumbRel) {
  const destAbs = path.join(ASSETS_DIR, thumbRel);
  if (!FORCE && existsSync(destAbs)) {
    skipped++;
    return;
  }
  mkdirSync(path.dirname(destAbs), { recursive: true });
  await sharp(srcAbs)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toFile(destAbs);
  invalidateR2(destAbs);
  written++;
}

const stories = JSON.parse(readFileSync(INDEX_PATH, 'utf8')).stories || [];
const images = [];
let dropped = 0;

for (const story of stories) {
  const detailPath = path.join(STORY_DIR, 'detail', `${story.slug}.json`);
  if (!existsSync(detailPath)) {
    console.warn(`  ! missing detail/${story.slug}.json — skipped`);
    continue;
  }
  const detail = JSON.parse(readFileSync(detailPath, 'utf8'));

  // Orb first, then the gallery in the detail file's own array order. Never readdir the gallery
  // folder: it sorts lexicographically, so event_1stanv would come out 0, 1, 10, 2, 3, ...
  const entries = [];
  if (detail.orb && detail.orb.file) {
    entries.push({ type: 'orb', rel: detail.orb.file, name: detail.orb.name, desc: detail.orb.desc });
  }
  for (const rel of detail.gallery || []) entries.push({ type: 'gallery', rel });

  for (const entry of entries) {
    const srcAbs = path.join(ASSETS_DIR, entry.rel);
    if (!existsSync(srcAbs)) {
      console.warn(`  ! missing ${entry.rel} — dropped`);
      dropped++;
      continue;
    }
    const meta = await sharp(srcAbs).metadata();
    if (!meta.width || !meta.height) {
      console.warn(`  ! unreadable ${entry.rel} — dropped`);
      dropped++;
      continue;
    }
    const thumbRel = thumbRelFor(entry.rel);
    if (!NO_THUMBS) await makeThumb(srcAbs, thumbRel);

    const row = {
      slug: story.slug,
      title: story.title,
      category: story.category,
      kind: story.kind,
      type: entry.type,
      path: entry.rel,
      thumb: thumbRel,
      w: meta.width,
      h: meta.height,
    };
    // Orb flavour text only; the keys are omitted rather than nulled on gallery rows.
    if (entry.name) row.name = entry.name;
    if (entry.desc) row.desc = entry.desc;
    images.push(row);
  }
}

const changed = writeJsonIfChanged(DEST_PATH, { source: SOURCE, images });
if (changed) invalidateR2(DEST_PATH);
const removed = flushR2Invalidations();

const orbs = images.filter(i => i.type === 'orb').length;
console.log(
  `gallery_index.json: ${images.length} images (${orbs} orbs, ${images.length - orbs} gallery)` +
    (dropped ? `, ${dropped} dropped` : '') +
    ` — ${changed ? 'written' : 'unchanged'}`
);
console.log(
  NO_THUMBS
    ? 'thumbnails: skipped (--no-thumbs)'
    : `thumbnails: ${written} written, ${skipped} already present` +
        (removed ? ` — ${removed} R2 key(s) invalidated` : '')
);
