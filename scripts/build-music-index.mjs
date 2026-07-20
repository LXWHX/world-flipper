// Builds Character Assets/story/music_index.json — the Music Room's world-music album list —
// from the story files fetch-main-story.mjs already wrote. Pure local derivation, no network:
// one album per story (index.json order), tracks copied verbatim from detail/<slug>.json's bgm.
// Re-run after any fetch:story run so the index tracks new events.
//
// Usage: node scripts/build-music-index.mjs   (npm run build:music-index)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonIfChanged } from './lib/miaowm5-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const STORY_DIR = path.join(ASSETS_DIR, 'story');
const INDEX_PATH = path.join(STORY_DIR, 'index.json');
const DEST_PATH = path.join(STORY_DIR, 'music_index.json');
const R2_MANIFEST_PATH = path.resolve('scripts/.r2-upload-manifest.json');
const SOURCE = 'worldflipper.miaowm5.com';

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

const stories = JSON.parse(readFileSync(INDEX_PATH, 'utf8')).stories || [];
const albums = [];
let trackCount = 0;

for (const story of stories) {
  const detailPath = path.join(STORY_DIR, 'detail', `${story.slug}.json`);
  if (!existsSync(detailPath)) {
    console.warn(`  ! missing detail/${story.slug}.json — skipped`);
    continue;
  }
  const detail = JSON.parse(readFileSync(detailPath, 'utf8'));
  const tracks = detail.bgm || [];
  if (!tracks.length) continue;
  albums.push({
    slug: story.slug,
    title: story.title,
    category: story.category,
    banner: story.banner || null,
    tracks,
  });
  trackCount += tracks.length;
}

const changed = writeJsonIfChanged(DEST_PATH, { source: SOURCE, albums });
if (changed) invalidateR2(DEST_PATH);
const removed = flushR2Invalidations();

console.log(
  `music_index.json: ${albums.length} albums, ${trackCount} tracks — ` +
    (changed ? `written${removed ? ` (${removed} R2 key invalidated)` : ''}` : 'unchanged')
);
