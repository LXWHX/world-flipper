// Phase 2 of the wiki-integration pipeline: matches the raw pages scraped by
// scripts/scrape-wiki-zh.mjs (in scripts/.wiki-scrape-cache/) against
// Character Assets/roster.json by Japanese name, then for each match:
//   - writes Character Assets/rarityN/<devName>/wiki_zh.json (text data only)
//   - downloads the character's voice lines into .../voice/*.mp3 and rewrites
//     wiki_zh.json's voice[].file to the local filename (no more third-party URLs)
//   - stamps roster.json with lightweight `hasWiki`/`voiceCount`/`zhName` fields
// Unmatched wiki pages / roster entries are written to
// Character Assets/_unmatched_wiki_report.md for manual follow-up.
//
// Usage:
//   node scripts/match-wiki-to-roster.mjs              match + download only what's missing
//   node scripts/match-wiki-to-roster.mjs --force       re-download voice mp3s that already exist

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { politeFetch, normalizeJpName, safeFileNameFromUrl } from './lib/wiki-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const CACHE_DIR = path.resolve('scripts/.wiki-scrape-cache');
const ROSTER_PATH = path.join(ASSETS_DIR, 'roster.json');
const REPORT_PATH = path.join(ASSETS_DIR, '_unmatched_wiki_report.md');
const DELAY_MS = 500;

const FORCE = process.argv.includes('--force');

function loadCache() {
  return readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(CACHE_DIR, f), 'utf8')));
}

async function downloadVoiceLines(voice, voiceDir) {
  mkdirSync(voiceDir, { recursive: true });
  const withFiles = [];
  for (const line of voice) {
    const fileName = safeFileNameFromUrl(line.mp3Url);
    const dest = path.join(voiceDir, fileName);
    if (FORCE || !existsSync(dest)) {
      const res = await fetch(line.mp3Url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${line.mp3Url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(dest, buf);
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    withFiles.push({ context: line.context, text: line.text, file: fileName });
  }
  return withFiles;
}

async function main() {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8'));
  const cached = loadCache();

  // Event/costume variants (enName "Marina (Summer)") often share their base character's exact
  // jpName ("マリーナ"), so jpName alone doesn't uniquely identify a roster entry — group by
  // jpName instead of overwriting, and disambiguate per wiki page below.
  const rosterByJp = new Map();
  for (const c of roster.characters) {
    const key = normalizeJpName(c.jpName);
    if (!rosterByJp.has(key)) rosterByJp.set(key, []);
    rosterByJp.get(key).push(c);
  }

  const matchedRosterDevNames = new Set();
  const unmatchedWiki = [];
  const ambiguousWiki = [];
  let processed = 0;
  let failures = 0;

  for (const page of cached) {
    const jp = normalizeJpName(page.basicInfo?.japaneseName);
    const candidates = (jp && rosterByJp.get(jp)) || [];
    if (candidates.length === 0) {
      unmatchedWiki.push(page);
      continue;
    }

    let roosterChar = candidates[0];
    if (candidates.length > 1) {
      // Disambiguate base vs. variant by whether the wiki page's own title carries a
      // "(variant)" qualifier, matched against whether the roster enName does too.
      const variantMatch = (page.chineseNameFromList || '').match(/[(（]([^)）]+)[)）]/);
      const pageHasVariant = !!variantMatch;
      const withVariant = candidates.filter((c) => /\(/.test(c.enName));
      const withoutVariant = candidates.filter((c) => !/\(/.test(c.enName));
      let pool = pageHasVariant ? withVariant : withoutVariant;
      if (pool.length > 1 && variantMatch) {
        // Multiple event/costume variants share this jpName (e.g. a character with both a
        // Summer and an Anniversary costume) — narrow further using the devName suffix code
        // each event/costume convention uses (see Character Assets/roster.json devNames).
        const keywordToCode = {
          泳装: 'smr', 周年: 'anv', 圣诞: 'xm', 万圣: 'hw', 新年: 'ny',
          情人节: 'vt', 白情: 'wt', 浴衣: 'smr', 礼服: 'anv', 沙漠: 'dst', 百兽: 'proud'
        };
        const code = keywordToCode[variantMatch[1]];
        if (code) {
          const narrowed = pool.filter((c) => c.devName.includes(code));
          if (narrowed.length === 1) pool = narrowed;
        }
      }
      if (pool.length === 1) {
        roosterChar = pool[0];
      } else {
        ambiguousWiki.push({ page, candidates });
        continue;
      }
    }

    if (!roosterChar.thumb) {
      // A handful of roster entries have no `thumb` yet (art not fetched from the game for
      // that character) and so have no rarityN/<devName>/ folder to write wiki_zh.json into.
      unmatchedWiki.push(page);
      continue;
    }

    matchedRosterDevNames.add(roosterChar.devName);
    const charDir = path.join(ASSETS_DIR, path.dirname(roosterChar.thumb));
    const voiceDir = path.join(charDir, 'voice');

    try {
      const voiceWithFiles = page.voice.length ? await downloadVoiceLines(page.voice, voiceDir) : [];
      const wikiZh = {
        sourceUrl: page.sourceUrl,
        basicInfo: page.basicInfo,
        stats: page.stats,
        skills: page.skills,
        story: page.story,
        review: page.review,
        voice: voiceWithFiles,
      };
      writeFileSync(path.join(charDir, 'wiki_zh.json'), JSON.stringify(wikiZh, null, 2));
      roosterChar.hasWiki = true;
      roosterChar.voiceCount = voiceWithFiles.length;
      if (page.basicInfo?.chineseName) roosterChar.zhName = page.basicInfo.chineseName;
      processed++;
      console.log(`[${processed}] ok   ${roosterChar.devName} (${page.chineseNameFromList})`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${roosterChar.devName} (${page.chineseNameFromList}): ${err.message}`);
    }
  }

  const unmatchedRoster = roster.characters.filter((c) => !matchedRosterDevNames.has(c.devName));

  writeFileSync(ROSTER_PATH, JSON.stringify(roster, null, 2));

  const report = [
    '# Unmatched wiki data report',
    '',
    `Generated ${new Date().toISOString()}`,
    '',
    `## Wiki pages with no roster.json match (${unmatchedWiki.length})`,
    '',
    ...unmatchedWiki.map(
      (p) => `- ${p.chineseNameFromList} — jpName "${p.basicInfo?.japaneseName || '(none)'}" — ${p.sourceUrl}`
    ),
    '',
    `## Ambiguous wiki pages — same jpName matches multiple roster variants (${ambiguousWiki.length})`,
    '',
    ...ambiguousWiki.map(
      ({ page, candidates }) =>
        `- ${page.chineseNameFromList} (${page.sourceUrl}) could be: ${candidates.map((c) => `${c.devName} (${c.enName})`).join(', ')}`
    ),
    '',
    `## roster.json characters with no wiki match (${unmatchedRoster.length})`,
    '',
    ...unmatchedRoster.map((c) => `- ${c.devName} — enName "${c.enName}" — jpName "${c.jpName}"`),
    '',
  ].join('\n');
  writeFileSync(REPORT_PATH, report);

  console.log(
    `Done. ${processed} matched, ${failures} failure(s), ${unmatchedWiki.length} unmatched wiki pages, ${unmatchedRoster.length} roster entries without wiki data. See ${path.relative(process.cwd(), REPORT_PATH)}.`
  );
  process.exit(failures > 0 ? 1 : 0);
}

main();
