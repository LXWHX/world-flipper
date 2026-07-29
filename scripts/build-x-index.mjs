// Builds X/gallery-dl/twitter/world_flipper/x_index.json — the Art tab's second gallery wall, the
// official @world_flipper X (Twitter) media archive — plus the 440px webp thumbnails under
// thumbs/. Pure local derivation, no network: everything comes from the files gallery-dl already
// wrote, plus what their names encode.
//
// The dimensions are the reason this file exists, exactly as for build-gallery-index.mjs: the
// front-end packs the wall into two masonry columns arithmetically, which needs w/h *before* the
// first paint. There is no other metadata source at all — gallery-dl wrote no JSON sidecars, so a
// file's *name* is the entire record. `<tweetId>_<n>.<ext>` yields the post time (the snowflake id
// embeds a millisecond timestamp) and the permalink, and nothing else: no captions, no titles, no
// alt text, no tags. That is why the wall's tiles are captioned with a date and why the filter
// dialog offers year and media type — those are the only two axes the data can support.
//
// Videos: sharp cannot read mp4, so the poster frame is decoded by ffmpeg and *that* is what both
// the thumbnail and the w/h come from. Deliberately no ffprobe — its stream=width,height reports
// pre-rotation dimensions and ignores the rotate side data, so a rotated clip would get transposed
// w/h and a wrong-shaped tile. ffmpeg auto-rotates on decode, so reading the poster is both correct
// and one subprocess fewer.
//
// Usage: node scripts/build-x-index.mjs [--force] [--no-thumbs] [--limit=N] [--videos-only]
//        --force        regenerate thumbnails that already exist (see THUMB_WIDTH below)
//        --no-thumbs    write the index only
//        --limit=N      only the first N media files (dev)
//        --videos-only  only re-do the mp4 poster extractions; the index is left alone

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { writeJsonIfChanged } from './lib/miaowm5-common.mjs';

// The media folder itself is the root, not X/. X/gallery-dl.exe and X/x.com_cookies.txt (a live
// session cookie jar) live three levels above it, so nothing here — and nothing in
// upload-to-r2.mjs, which uses the same root — can reach them. That is a structural guarantee,
// not a filename rule; see the X/ block in upload-to-r2.mjs.
const X_DIR = path.resolve('X/gallery-dl/twitter/world_flipper');
const DEST_PATH = path.join(X_DIR, 'x_index.json');
const THUMBS_DIR = path.join(X_DIR, 'thumbs');
const R2_MANIFEST_PATH = path.resolve('scripts/.r2-upload-manifest.json');
const SOURCE = 'x.com/world_flipper';
const ACCOUNT = 'world_flipper';

// Same numbers as build-gallery-index.mjs: 440px against the wall's 197px design column is ~2.2x,
// right for DPR 2-3 phones. The sources here run to 7.6 MB (video) and 2.6 MB (jpg).
const THUMB_WIDTH = 440;
const THUMB_QUALITY = 78;

// Twitter's epoch. id >> 22 is the milliseconds since it, which is the only timestamp we have.
const TWITTER_EPOCH = 1288834974657n;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_EXT = new Set(['.mp4']);

const FORCE = process.argv.includes('--force');
const NO_THUMBS = process.argv.includes('--no-thumbs');
const VIDEOS_ONLY = process.argv.includes('--videos-only');
const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  return arg ? Number(arg.slice(8)) : 0;
})();

// ---------------------------------------------------------------------------
// R2 invalidation. Same contract as build-gallery-index.mjs — drop rewritten keys from the upload
// manifest so upload-to-r2.mjs re-ships them — but the keys are X/-prefixed and relative to X_DIR,
// *not* to Character Assets/. Copying that script's version verbatim would compute keys that match
// nothing in the manifest, so the re-upload would silently never happen.
// ---------------------------------------------------------------------------

const r2Invalidated = new Set();
function invalidateR2(absPath) {
  r2Invalidated.add('X/' + path.relative(X_DIR, absPath).split(path.sep).join('/'));
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

if (!existsSync(X_DIR)) {
  console.error(`${path.relative(process.cwd(), X_DIR)} not found — nothing to index.`);
  process.exit(1);
}

// <tweetId>_<n>.jpg -> thumbs/<tweetId>_<n>.webp
function thumbRelFor(file) {
  return 'thumbs/' + file.replace(/\.[^.]+$/, '.webp');
}

function run(bin, args) {
  return new Promise((resolve) => {
    // maxBuffer: a 1080p PNG frame is a few MB and the default is 1 MB.
    execFile(bin, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !(stdout && stdout.length) ? null : stdout);
    });
  });
}

// A single decoded frame, as a PNG buffer. `-ss` before `-i` is an input seek, so it doesn't
// decode the first second just to throw it away. One second in rather than frame 0, because a
// promo clip very often opens on a black fade-in and a black poster is indistinguishable from a
// broken tile; clips shorter than that yield no frame, hence the fallback to 0.
async function posterBuffer(srcAbs) {
  for (const ss of ['1', '0']) {
    const buf = await run(ffmpegPath, [
      '-v', 'error', '-ss', ss, '-i', srcAbs,
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-',
    ]);
    if (buf && buf.length) return buf;
  }
  return null;
}

let written = 0;
let skipped = 0;

// Thumbnails follow the composited-image rule: present means done, so a re-run touches nothing.
// Changing THUMB_WIDTH/THUMB_QUALITY therefore means deleting thumbs/ first (or --force).
// `input` is a path for images and a decoded PNG buffer for videos; sharp takes either.
async function makeThumb(input, thumbRel) {
  const destAbs = path.join(X_DIR, thumbRel);
  if (!FORCE && existsSync(destAbs)) {
    skipped++;
    return;
  }
  mkdirSync(path.dirname(destAbs), { recursive: true });
  await sharp(input)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toFile(destAbs);
  invalidateR2(destAbs);
  written++;
}

// Newest first — that is what a media wall means — with the part number ascending as the tiebreak,
// so a four-image tweet's parts stay adjacent and in the order they were posted. Sorted here so
// the front-end never sorts 1429 rows.
function parseName(file) {
  const m = /^(\d+)_(\d+)\.[^.]+$/.exec(file);
  if (!m) return null;
  return { id: m[1], part: Number(m[2]) };
}

const files = readdirSync(X_DIR, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name)
  .filter((n) => {
    const ext = path.extname(n).toLowerCase();
    return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext);
  })
  .filter((n) => !VIDEOS_ONLY || VIDEO_EXT.has(path.extname(n).toLowerCase()));

const parsed = [];
let unnamed = 0;
for (const file of files) {
  const p = parseName(file);
  if (!p) {
    console.warn(`  ! ${file} is not <tweetId>_<n>.<ext> — dropped`);
    unnamed++;
    continue;
  }
  parsed.push({ file, ...p, ts: Number((BigInt(p.id) >> 22n) + TWITTER_EPOCH) });
}
parsed.sort((a, b) => b.ts - a.ts || a.part - b.part || a.id.localeCompare(b.id));

const work = LIMIT > 0 ? parsed.slice(0, LIMIT) : parsed;

const media = [];
let dropped = 0;
let videos = 0;

for (const item of work) {
  const srcAbs = path.join(X_DIR, item.file);
  const isVideo = VIDEO_EXT.has(path.extname(item.file).toLowerCase());
  const thumbRel = thumbRelFor(item.file);

  let width = 0;
  let height = 0;
  try {
    if (isVideo) {
      // The poster is both the thumbnail source and the dimension source (see the header note on
      // why ffprobe is not used).
      const poster = await posterBuffer(srcAbs);
      if (!poster) {
        console.warn(`  ! no decodable frame in ${item.file} — dropped`);
        dropped++;
        continue;
      }
      const meta = await sharp(poster).metadata();
      width = meta.width || 0;
      height = meta.height || 0;
      if (!NO_THUMBS) await makeThumb(poster, thumbRel);
      videos++;
    } else {
      const meta = await sharp(srcAbs).metadata();
      width = meta.width || 0;
      height = meta.height || 0;
      if (!NO_THUMBS) await makeThumb(srcAbs, thumbRel);
    }
  } catch (err) {
    console.warn(`  ! unreadable ${item.file} (${err.message}) — dropped`);
    dropped++;
    continue;
  }

  // A zero would make the packer's round(197 * h / w) divide by zero and hand the wall an
  // Infinity column height, so an unmeasurable file is dropped rather than shipped.
  if (!width || !height) {
    console.warn(`  ! no dimensions for ${item.file} — dropped`);
    dropped++;
    continue;
  }

  const row = { file: item.file, thumb: thumbRel, w: width, h: height, ts: item.ts };
  // Omitted rather than nulled on images, following gallery_index.json's orb name/desc.
  if (isVideo) row.video = true;
  media.push(row);
}

// --videos-only exists to re-do poster extraction after a change to that logic; rewriting the
// index from a video-only pass would throw away every image row.
let changed = false;
if (!VIDEOS_ONLY && !LIMIT) {
  changed = writeJsonIfChanged(DEST_PATH, { source: SOURCE, account: ACCOUNT, media });
  if (changed) invalidateR2(DEST_PATH);
} else if (LIMIT) {
  console.log('(--limit set — index not written)');
}
const removed = flushR2Invalidations();

console.log(
  `x_index.json: ${media.length} media (${media.length - videos} images, ${videos} videos)` +
    (dropped ? `, ${dropped} dropped` : '') +
    (unnamed ? `, ${unnamed} unnamed` : '') +
    (VIDEOS_ONLY || LIMIT ? '' : ` — ${changed ? 'written' : 'unchanged'}`)
);
console.log(
  NO_THUMBS
    ? 'thumbnails: skipped (--no-thumbs)'
    : `thumbnails: ${written} written, ${skipped} already present` +
        (removed ? ` — ${removed} R2 key(s) invalidated` : '')
);
