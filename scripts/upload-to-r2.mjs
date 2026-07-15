// Uploads the site's Character Assets to a Cloudflare R2 bucket via `wrangler r2 object put`.
// Requires: `npm install` once, then `npx wrangler login` (or set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID).
//
// Usage:
//   node scripts/upload-to-r2.mjs                 upload everything that isn't already recorded as uploaded
//   node scripts/upload-to-r2.mjs --force          re-upload everything, ignoring the resume manifest

import { spawn } from 'node:child_process';
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---- fill this in once the bucket exists ----
const BUCKET = 'wf-assets';
// public URL: https://pub-e1f9dd7473954e4b9b7d20b302cddb4a.r2.dev
// ----------------------------------------------

const SOURCE_DIR = path.resolve('Character Assets');
const MANIFEST_PATH = path.resolve('scripts/.r2-upload-manifest.json');
// Each upload spawns its own `wrangler` process, so throughput is dominated by process
// startup rather than bandwidth — the workers spend most of their time waiting. 8 keeps the
// ~8k-file emotion/story asset push to roughly an hour instead of ~4.
const CONCURRENCY = 8;
const FORCE = process.argv.includes('--force');
const WRANGLER_BIN = path.resolve(
  'node_modules/.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
);

// Only ship what the site actually needs: the roster.json index plus every rarityN/ folder.
// Dev-only files (fetch/*.ps1, *_log.txt, metadata.json, unmatched_music_report.md, _unmatched_music/) are skipped.
const INCLUDE_TOP_LEVEL = new Set(['roster.json']);
const INCLUDE_DIR_PREFIX = /^rarity\d+$/;

function collectFiles(dir, baseDir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, baseDir, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function buildFileList() {
  const files = [];

  for (const name of INCLUDE_TOP_LEVEL) {
    const p = path.join(SOURCE_DIR, name);
    if (existsSync(p)) files.push(p);
  }

  for (const entry of readdirSync(SOURCE_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && INCLUDE_DIR_PREFIX.test(entry.name)) {
      collectFiles(path.join(SOURCE_DIR, entry.name), SOURCE_DIR, files);
    }
  }

  return files.map((abs) => ({
    abs,
    key: path.relative(SOURCE_DIR, abs).split(path.sep).join('/'),
  }));
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

function quoteArg(a) {
  return `"${String(a).replace(/"/g, '""')}"`;
}

function uploadOne({ abs, key }) {
  return new Promise((resolve, reject) => {
    const args = ['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', abs, '--remote'];
    const isWin = process.platform === 'win32';
    const child = spawn(
      isWin ? quoteArg(WRANGLER_BIN) : WRANGLER_BIN,
      isWin ? args.map(quoteArg) : args,
      { stdio: ['ignore', 'pipe', 'pipe'], shell: isWin }
    );
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`exit ${code} for ${key}\n${output.slice(-500)}`))
    );
    child.on('error', reject);
  });
}

async function main() {
  if (BUCKET === 'CHANGE_ME') {
    console.error('Edit scripts/upload-to-r2.mjs and set BUCKET to your R2 bucket name first.');
    process.exit(1);
  }

  const files = buildFileList();
  const done = loadManifest();
  // roster.json is small and changes often (character/music data edits) without its filename
  // ever changing, so the path-keyed manifest would otherwise skip real content changes forever.
  const pending = files.filter((f) => f.key === 'roster.json' || !done.has(f.key));

  console.log(`${files.length} files total, ${pending.length} pending (${done.size} already uploaded).`);

  let cursor = 0;
  let failures = 0;

  async function worker() {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      const idx = cursor;
      try {
        await uploadOne(item);
        done.add(item.key);
        if (idx % 20 === 0) saveManifest(done);
        console.log(`[${idx}/${pending.length}] ok  ${item.key}`);
      } catch (err) {
        failures++;
        console.error(`[${idx}/${pending.length}] FAIL ${item.key}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveManifest(done);

  console.log(`Done. ${failures} failure(s). Re-run the same command to retry failures/resume.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
