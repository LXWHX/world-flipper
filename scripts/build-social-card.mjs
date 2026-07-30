// Builds the two images the document head points at: the Open Graph / Twitter share card and the
// favicon. Local-only derivation — no network — from art already in the repo.
//
//   node scripts/build-social-card.mjs [--force]
//
// Why this exists at all: `icons/Site-logo.png` is **a WebP file with a .png name** (magic bytes
// `RIFF....WEBP`). Browsers sniff the format so `<img>` renders it fine, but og:image has to be a
// real PNG/JPEG — X's card crawler in particular will not fetch a WebP. So the share card is
// composed here and written as an honest PNG.
//
// Both outputs live in `icons/`, which is served by the site itself (wf.joeli.site), **not R2** —
// same reason `icons/alk_walk.gif` has to stay there. `upload-to-r2.mjs` therefore needs no
// changes, and both files are committed to git.
//
// Composed images follow the pipeline rule for composed art: they're skipped when they already
// exist, so **changing the composition here means deleting the old files first** (or passing
// `--force`). Writes go through `writeIfChanged`, so a re-run is a zero-diff no-op.
//
// Text is rasterised by librsvg through the system font stack, so the CJK subtitle depends on this
// machine having a CJK font (Microsoft YaHei on Windows). That's acceptable for a dev-only script
// whose output is committed — but if the subtitle ever comes out as tofu boxes, that's the cause.

import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import sharp from 'sharp';
import { writeIfChanged } from './lib/wikigg-common.mjs';

const ROOT = path.resolve('.');
const LOGO = path.join(ROOT, 'icons/Site-logo.png');       // 682x430, WebP-in-a-.png, transparent
const BACKDROP = path.join(ROOT, 'menu-img/normal_background.png'); // 700x900, the home art
const CIRCLE = path.join(ROOT, 'icons/circle.png');        // 982x978, the magic-circle backdrop

const CARD_OUT = path.join(ROOT, 'icons/social-card.png');
const FAVICON_OUT = path.join(ROOT, 'icons/favicon.png');

// 1200x630 is the size every crawler wants for a large summary card; anything smaller gets
// downgraded to the little square thumbnail.
const CARD_W = 1200;
const CARD_H = 630;
const FAVICON_SIZE = 180; // also the apple-touch-icon size

// The world sphere inside the O of "WORLD", in the logo's own 682x430 coordinates. It's the one
// part of the wordmark that still reads as something at 16px, so it — not the whole logo — is the
// favicon. Measured by eye against the art; re-measure if the logo file is ever replaced.
const SPHERE = { left: 222, top: 132, width: 86, height: 86 };

const force = process.argv.includes('--force');

async function buildCard() {
  // The home backdrop, cover-cropped to the card and blurred: it's a busy illustration, and the
  // wordmark has to sit on top of it. The white scrim over the top does the rest of the work.
  const bg = await sharp(BACKDROP)
    .resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' })
    .blur(14)
    .toBuffer();

  const scrim = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">` +
    `<rect width="${CARD_W}" height="${CARD_H}" fill="#F7FAFF" opacity="0.62"/></svg>`
  );

  // The magic circle is the site's own backdrop (see ARCHITECTURE.md "Backgrounds"), faint here so
  // the card is recognisably this site and not just the game's key art.
  // `fit: 'inside'` keeps the circle round, so the result is 560 wide but not 560 tall — the
  // dest-in mask has to match whatever came out, not the box that was asked for.
  const circleFit = await sharp(CIRCLE).resize(560, 560, { fit: 'inside' }).png().toBuffer();
  const circleMeta = await sharp(circleFit).metadata();
  const circle = await sharp(circleFit)
    .composite([{
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${circleMeta.width}" height="${circleMeta.height}">` +
        `<rect width="${circleMeta.width}" height="${circleMeta.height}" fill="#fff" opacity="0.80"/></svg>`
      ),
      blend: 'dest-in'
    }])
    .png()
    .toBuffer();

  const logo = await sharp(LOGO).resize({ width: 620, fit: 'inside' }).png().toBuffer();

  // Two lines under the wordmark. The site's own webfont (M PLUS Rounded 1c) isn't installed here
  // and naming it first made librsvg fall through to a *serif*, which reads as a different site
  // entirely — so the stack starts at the system sans instead.
  const caption = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="160">` +
    `<text x="600" y="58" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" ` +
    `font-size="46" font-weight="800" fill="#3E4450" letter-spacing="4">MUSEUM &amp; ARCHIVE</text>` +
    `<text x="600" y="122" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" ` +
    `font-size="38" font-weight="700" fill="#5A6270" opacity="0.9">世界弹射物语 博物馆与档案馆</text>` +
    `</svg>`
  );

  return sharp(bg)
    .composite([
      { input: scrim, top: 0, left: 0 },
      { input: circle, gravity: 'centre' },
      { input: logo, top: 130, left: Math.round((CARD_W - 620) / 2) },
      { input: caption, top: 414, left: 0 }
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function buildFavicon() {
  const sphere = await sharp(LOGO)
    .extract(SPHERE)
    .resize(152, 152, { fit: 'inside', kernel: 'lanczos3' })
    .png()
    .toBuffer();

  // On white rather than transparent: browser tab strips are light or dark depending on the theme,
  // and the mark's own dark blue disappears against a dark strip without a plate behind it.
  return sharp({
    create: {
      width: FAVICON_SIZE, height: FAVICON_SIZE, channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite([{ input: sphere, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function emit(label, outPath, build) {
  if (existsSync(outPath) && !force) {
    console.log(`  ${label}: exists, skipped (delete it or pass --force to recompose)`);
    return;
  }
  if (force && existsSync(outPath)) unlinkSync(outPath);
  const buf = await build();
  const changed = writeIfChanged(outPath, buf);
  console.log(`  ${label}: ${changed ? 'written' : 'unchanged'} -> ${path.relative(ROOT, outPath)}`);
}

async function main() {
  for (const f of [LOGO, BACKDROP, CIRCLE]) {
    if (!existsSync(f)) throw new Error(`missing source art: ${path.relative(ROOT, f)}`);
  }
  console.log('build-social-card:');
  await emit('social card', CARD_OUT, buildCard);
  await emit('favicon', FAVICON_OUT, buildFavicon);
}

main().catch(err => { console.error(err); process.exit(1); });
