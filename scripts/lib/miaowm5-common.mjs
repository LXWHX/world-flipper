// Shared helpers for the miaowm5 pipeline (scripts/fetch-miaowm5.mjs).
//
// worldflipper.miaowm5.com is an open-source Svelte SPA (github.com/miaowm5/wf-encyclopedia)
// whose data all lives as structured JSON on public CDNs, keyed by the game's internal
// `devName` — the same key Character Assets/roster.json uses. So there's no HTML scraping
// here: we fetch the same JSON the site does and decode it with ports of the site's own
// parsing logic (see the block comments on each function for which upstream file it mirrors).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;

// CDN names mirror the upstream bundle's `cdn`/`cdn2`/`cdn3` keys, NOT the repo's .env
// ordering (the deployed bundle maps them differently — these values are read off the
// deployed bundle, so keep the mapping and the alias names together).
export const CDN_A = 'https://worldflipper-cdn4.miaowm5.com/'; // bundle `cdn`  — character/story atlas (emotion art)
export const CDN_B = 'https://worldflipper-cdn.miaowm5.com/'; // bundle `cdn2` — pixel.json + pixel_normal/special atlases
export const CDN_C = 'https://worldflipper-cdn2.miaowm5.com/'; // bundle `cdn3` — orderedmap/* tables + common/voiceLine

export const ORDEREDMAP = `${CDN_C}orderedmap/`;

const CACHE_DIR = path.resolve('scripts/.miaowm5-cache');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) wf-museum-archive/1.0 (personal fan-site data collection)';
const DELAY_MS = 300;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A URL's path becomes its on-disk cache path, so cache entries stay greppable/inspectable.
// Windows forbids \ / : * ? " < > | in path segments; the CDN paths only ever contain ':'
// (from the scheme) and '?' in practice, but scrub the whole set to be safe.
function cachePathForUrl(url, ext) {
  const u = new URL(url);
  const segments = `${u.host}${u.pathname}`
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[\\/:*?"<>|]/g, '_'));
  const file = segments.pop();
  return path.join(CACHE_DIR, ...segments, ext && !file.endsWith(ext) ? `${file}${ext}` : file);
}

async function fetchWithRetry(url, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await sleep(DELAY_MS);
      return buf;
    } catch (err) {
      lastErr = err;
      await sleep(DELAY_MS);
    }
  }
  throw lastErr;
}

// Disk-cache-first fetch. The cache is the resume mechanism for the whole pipeline: a full
// run pulls ~500 characters' worth of JSON + atlas PNGs, and re-runs should be cheap.
export async function cachedFetchBuffer(url) {
  const dest = cachePathForUrl(url);
  if (existsSync(dest)) return readFileSync(dest);
  const buf = await fetchWithRetry(url);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return buf;
}

export async function cachedFetchJson(url) {
  const buf = await cachedFetchBuffer(url);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new Error(`Bad JSON from ${url}: ${err.message}`);
  }
}

// Scenario/encyclopedia text stores newlines as the two literal characters \ and n.
export function decodeScenarioText(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\\n/g, '\n');
}

// The 11 battle voice lines. The bilibili wiki records these with placeholder Chinese labels
// ("技能准备完毕") rather than transcripts, so they map deterministically onto miaowm5's
// voiceLine keys, which DO carry the Japanese line. Non-battle lines have real Chinese text
// and no counterpart here.
export const BATTLE_VOICE_MAP = {
  技能准备完毕: 'battle/skill_ready',
  技能发动1: 'battle/skill_0',
  技能发动2: 'battle/skill_1',
  战斗开始1: 'battle/battle_start_0',
  战斗开始2: 'battle/battle_start_1',
  胜利1: 'battle/win_0',
  胜利2: 'battle/win_1',
  强化弹射1: 'battle/power_flip_0',
  强化弹射2: 'battle/power_flip_1',
  落下1: 'battle/outhole_0',
  落下2: 'battle/outhole_1',
};

// ---------------------------------------------------------------------------
// RGBA canvas helpers (a tiny stand-in for the browser <canvas> the upstream code uses)
// ---------------------------------------------------------------------------

export function createRgba(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

// Source-over blit of a w×h region of `src` at (dx, dy) in `dst`, clipped to dst's bounds.
export function blit(dst, src, sx, sy, w, h, dx, dy) {
  for (let y = 0; y < h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.h) continue;
    const syy = sy + y;
    if (syy < 0 || syy >= src.h) continue;
    for (let x = 0; x < w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.w) continue;
      const sxx = sx + x;
      if (sxx < 0 || sxx >= src.w) continue;
      const si = (syy * src.w + sxx) * 4;
      const a = src.data[si + 3];
      if (a === 0) continue;
      const di = (ty * dst.w + tx) * 4;
      if (a === 255) {
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = 255;
      } else {
        const sa = a / 255;
        const da = dst.data[di + 3] / 255;
        const oa = sa + da * (1 - sa);
        for (let c = 0; c < 3; c++) {
          dst.data[di + c] = Math.round(
            (src.data[si + c] * sa + dst.data[di + c] * da * (1 - sa)) / (oa || 1)
          );
        }
        dst.data[di + 3] = Math.round(oa * 255);
      }
    }
  }
}

// Rotate -90° (counter-clockwise), matching the upstream canvas transform used for
// TexturePacker `rotated` frames: translate(0, height) then rotate(-PI/2).
export function rotateCCW(src) {
  const out = createRgba(src.h, src.w);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const si = (y * src.w + x) * 4;
      const dx = y;
      const dy = src.w - 1 - x;
      const di = (dy * out.w + dx) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

export function scaleNearest(src, factor) {
  const out = createRgba(src.w * factor, src.h * factor);
  for (let y = 0; y < out.h; y++) {
    const sy = (y / factor) | 0;
    for (let x = 0; x < out.w; x++) {
      const sx = (x / factor) | 0;
      const si = (sy * src.w + sx) * 4;
      const di = (y * out.w + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

export function decodePng(buf) {
  const png = PNG.sync.read(buf);
  return { w: png.width, h: png.height, data: new Uint8Array(png.data) };
}

export function encodePng(rgba) {
  const png = new PNG({ width: rgba.w, height: rgba.h });
  png.data = Buffer.from(rgba.data);
  return PNG.sync.write(png);
}

// ---------------------------------------------------------------------------
// Spritesheet (port of src/common/spriteSheet.svelte.js)
// ---------------------------------------------------------------------------

// A decoded atlas page costs ~6MB of RGBA, and `character/story` has ~184 of them, so caching
// every page for the whole run would hold ~1GB. Pages there are per-character (used once and
// never again), while `pixel_normal`'s 14 pages are shared by every character — an LRU this
// size keeps all of the latter resident while letting the former fall out.
const MAX_CACHED_PAGES = 16;

// TexturePacker-style atlas: `<sheet>.json` maps sprite name -> {frame, rotated,
// spriteSourceSize, sourceSize, image}, with the atlas pages living at `<sheet>/<image>`.
// Upstream lowercases every key for case-insensitive lookup; we do the same.
export class Spritesheet {
  constructor(sheetPath, cdnBase) {
    this.sheetPath = sheetPath;
    this.cdnBase = cdnBase;
    this.config = null;
    this.pages = new Map();
  }

  async load() {
    if (this.config) return this.config;
    const raw = await cachedFetchJson(`${this.cdnBase}${this.sheetPath}.json`);
    const pure = {};
    for (const key of Object.keys(raw)) pure[key.toLowerCase()] = raw[key];
    this.config = pure;
    return this.config;
  }

  async page(image) {
    if (this.pages.has(image)) {
      // Refresh recency: Map iterates in insertion order, so re-inserting moves it to the end.
      const hit = this.pages.get(image);
      this.pages.delete(image);
      this.pages.set(image, hit);
      return hit;
    }
    const buf = await cachedFetchBuffer(`${this.cdnBase}${this.sheetPath}/${image}`);
    const rgba = decodePng(buf);
    this.pages.set(image, rgba);
    while (this.pages.size > MAX_CACHED_PAGES) {
      this.pages.delete(this.pages.keys().next().value);
    }
    return rgba;
  }

  has(name) {
    return !!(this.config && this.config[String(name).toLowerCase()]);
  }

  // Returns an RGBA canvas of `sourceSize`, with the packed frame blitted at its
  // `spriteSourceSize` offset (i.e. the sprite's original, un-trimmed footprint).
  async getSprite(name) {
    await this.load();
    const cfg = this.config[String(name).toLowerCase()];
    if (!cfg) return null;
    const page = await this.page(cfg.image);
    let region = createRgba(cfg.frame.w, cfg.frame.h);
    blit(region, page, cfg.frame.x, cfg.frame.y, cfg.frame.w, cfg.frame.h, 0, 0);
    if (cfg.rotated) region = rotateCCW(region);
    const out = createRgba(cfg.sourceSize.w, cfg.sourceSize.h);
    blit(out, region, 0, 0, region.w, region.h, cfg.spriteSourceSize.x, cfg.spriteSourceSize.y);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Pixel animation (port of src/detail/content/loadPixel.svelte.js)
// ---------------------------------------------------------------------------

export const PIXEL_SCALE = 2; // upstream default
export const PIXEL_SPEED_MS = 20; // upstream default: one timeline tick

// Port of upstream createFrame: cuts each frame out of the character's pixel sheet and
// records its draw offset. `offset` is added to frame ids so the special sheet's frames can
// share one list with the normal sheet's (upstream uses 10000).
export function createFrame(frames, sheetRgba, offset = 0) {
  const list = [];
  for (const frame of frames) {
    let canvas = createRgba(frame.w, frame.h);
    blit(canvas, sheetRgba, frame.x, frame.y, frame.w, frame.h, 0, 0);
    if (frame.r) canvas = rotateCCW(canvas);
    const width = frame.r ? frame.h : frame.w;
    const height = frame.r ? frame.w : frame.h;
    list.push([frame.n + offset, canvas, -frame.fx, -frame.fy, width, height]);
  }
  return list;
}

// Port of upstream createTimeline. Two behaviours worth keeping in mind:
//   - the union bbox ignores 1px-wide/tall frames (upstream treats them as placeholders)
//   - `timeline2` is [frameId, durationInTicks]; a frame's duration is how many tick slots
//     it fills, so GIF delay = duration * PIXEL_SPEED_MS.
export function createTimeline(config, imageList) {
  const { begin, end } = config;
  let list = imageList.filter((item) => item[0] >= begin && item[0] <= end);
  if (list.length === 0) {
    const index = imageList.findIndex((item) => item[0] > end);
    if (index >= 0) {
      const item = [...imageList[index]];
      item[0] = end;
      list = [item];
    }
  }
  if (list.length === 0) return null;

  const size = [256, 256, 0, 0];
  const timeline = [];
  const timeline2 = [];
  for (const frame of list) {
    const name = frame[0];
    timeline2.push([name, 0]);
    while (timeline.length <= name - begin) {
      timeline.push(name);
      timeline2[timeline2.length - 1][1] += 1;
    }
    const [x, y, width, height] = [frame[2], frame[3], frame[4], frame[5]];
    if (width !== 1 && height !== 1) {
      if (x < size[0]) size[0] = x;
      if (y < size[1]) size[1] = y;
      if (x + width > size[2]) size[2] = x + width;
      if (y + height > size[3]) size[3] = y + height;
    }
  }
  size[2] -= size[0];
  size[3] -= size[1];
  if (size[2] <= 0 || size[3] <= 0) return null;

  const frames = new Map();
  for (const [name, canvas, x, y] of list) {
    const out = createRgba(size[2], size[3]);
    blit(out, canvas, 0, 0, canvas.w, canvas.h, x - size[0], y - size[1]);
    frames.set(name, out);
  }
  return { name: config.name, width: size[2], height: size[3], timeline2, frames };
}

// ---------------------------------------------------------------------------
// GIF encoding
// ---------------------------------------------------------------------------

const ALPHA_CUTOFF = 128;

// Encodes pixel-art frames losslessly where possible: index 0 is reserved for transparency
// and the remaining palette holds the sprite's exact colours (pixel art is well under 255
// colours in practice), so we avoid the quantiser entirely. Upstream's browser exporter
// instead colour-keys transparency to green (0x00FF01) and flattens partial alpha onto
// white; a real transparent index is cleaner and matches the existing GIFs on disk, which
// carry disposal=2 + a transparent index.
export function encodeGif(frames, outPath) {
  const colorSet = new Map();
  let tooMany = false;
  for (const { rgba } of frames) {
    for (let i = 0; i < rgba.data.length; i += 4) {
      if (rgba.data[i + 3] < ALPHA_CUTOFF) continue;
      const key = (rgba.data[i] << 16) | (rgba.data[i + 1] << 8) | rgba.data[i + 2];
      if (!colorSet.has(key)) {
        colorSet.set(key, [rgba.data[i], rgba.data[i + 1], rgba.data[i + 2]]);
        if (colorSet.size > 255) {
          tooMany = true;
          break;
        }
      }
    }
    if (tooMany) break;
  }

  const gif = GIFEncoder();
  // `quantPalette` deliberately excludes the reserved transparent slot: applyPalette must only
  // ever pick real colours, otherwise an opaque black pixel would map to index 0 and punch a
  // hole in the sprite. Indices from it are shifted by +1 into the final palette.
  let palette;
  let quantPalette = null;
  if (!tooMany) {
    palette = [[0, 0, 0], ...colorSet.values()];
  } else {
    // Fallback for the rare frame set with >255 opaque colours: let gifenc pick a palette,
    // reserving a slot for the transparent index.
    const all = [];
    for (const { rgba } of frames) all.push(rgba.data);
    const merged = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
    let off = 0;
    for (const a of all) {
      merged.set(a, off);
      off += a.length;
    }
    quantPalette = quantize(merged, 255, { format: 'rgba4444' }).slice(0, 255);
    palette = [[0, 0, 0], ...quantPalette];
  }

  const lookup = new Map();
  palette.forEach((c, i) => {
    if (i === 0) return;
    lookup.set((c[0] << 16) | (c[1] << 8) | c[2], i);
  });

  for (const { rgba, delayMs } of frames) {
    const n = rgba.w * rgba.h;
    const index = new Uint8Array(n);
    if (!tooMany) {
      for (let p = 0; p < n; p++) {
        const i = p * 4;
        if (rgba.data[i + 3] < ALPHA_CUTOFF) {
          index[p] = 0;
          continue;
        }
        index[p] = lookup.get((rgba.data[i] << 16) | (rgba.data[i + 1] << 8) | rgba.data[i + 2]) ?? 0;
      }
    } else {
      const mapped = applyPalette(rgba.data, quantPalette, 'rgba4444');
      for (let p = 0; p < n; p++) {
        index[p] = rgba.data[p * 4 + 3] < ALPHA_CUTOFF ? 0 : mapped[p] + 1;
      }
    }
    gif.writeFrame(index, rgba.w, rgba.h, {
      palette,
      delay: delayMs,
      transparent: true,
      transparentIndex: 0,
      dispose: 2,
      repeat: 0,
    });
  }
  gif.finish();
  const bytes = Buffer.from(gif.bytes());
  return writeIfChanged(outPath, bytes);
}

// ---------------------------------------------------------------------------
// Idempotent writes
// ---------------------------------------------------------------------------

// Every write goes through here so re-runs are byte-stable: unchanged files keep their mtime
// and, crucially, stay out of the R2 re-upload set (see invalidateR2 in fetch-miaowm5.mjs).
// Returns true only when the file actually changed on disk.
export function writeIfChanged(filePath, buf) {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath);
    if (existing.equals(buf)) return false;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  return true;
}

// No trailing newline: match-wiki-to-roster.mjs already writes wiki_zh.json/roster.json this
// way, and adding one would rewrite (and re-upload) every existing file on the first run.
export function writeJsonIfChanged(filePath, value) {
  return writeIfChanged(filePath, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}
