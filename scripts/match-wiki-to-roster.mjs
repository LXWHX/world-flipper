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
import { writeJsonIfChanged } from './lib/miaowm5-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const CACHE_DIR = path.resolve('scripts/.wiki-scrape-cache');
const ROSTER_PATH = path.join(ASSETS_DIR, 'roster.json');
const REPORT_PATH = path.join(ASSETS_DIR, '_unmatched_wiki_report.md');
const R2_MANIFEST_PATH = path.resolve('scripts/.r2-upload-manifest.json');
const DELAY_MS = 500;

const FORCE = process.argv.includes('--force');

// Wiki pages the jpName join cannot reach, keyed by the page's own Chinese title. Three causes,
// all of them upstream spelling rather than anything this script can infer:
//   - the wiki's jpName column disagrees with the game's kana (テルナ vs. the roster's テレナ)
//   - the column holds Chinese instead of Japanese (星川莉莉 for 星川 リリィ)
//   - the character's enName carries a non-costume parenthetical ("Lav / Love (The Skyscraper)"),
//     which makes the variant heuristic below file every candidate as a variant and give up.
// Verified one by one against the page's element/rarity; keep that bar before adding a row.
const MANUAL_MATCHES = {
  威弗: 'anger_investigator',
  希尔狄嘉德: 'estateguild_leader',
  琳卡莉娜: 'scissor_ratgirl',
  特尔娜: 'electro_girl',
  星川莉莉: 'hoshikawa_ririi',
  拉芙: 'touyakiren_ceo',
  // The same problem one layer down, for the zhName fallback: miaowm5 and the bilibili wiki
  // transliterate the same name differently (阿库娅/阿克娅, 塔娜奇艾拉/塔娜奇埃拉), or miaowm5
  // never translated it at all (ユノ, アスタ, ノエル・シルヴァ). Each row below is the only
  // roster entry of that name whose rarity *and* element match the page.
  卡西瓦卢斯: 'octcyborg_lady',
  因维特拉: 'hero_mechanic',
  埃尔梅丽莎: 'marching_rival',
  塔娜奇艾拉: 'evilloli_master',
  江诗: 'jiangshi_girl',
  泽利米尔: 'pirates_of_fear',
  由诺: 'yuno',
  '诺艾尔·希尔巴': 'noelle_silva',
  达克妮斯: 'darkness',
  阿库娅: 'aqua',
  阿斯塔: 'asta',
  // These two are costume pages for characters whose only roster entry is the miaowm5 one, so the
  // costume identity can't be corroborated beyond the matching rarity/element — but the page is
  // certainly *about* this character, and no other page documents them.
  '希尔克哈蕾(新年)': 'heavenly_four',
  'K·约翰逊(流星祭)': 'pbc_ceo_playable',
};

// "帕尔菲(泳装)" -> "帕尔菲". Both the wiki's page titles and (after a match writes the wiki
// spelling back) the roster's own zhName carry these event/costume qualifiers.
function stripQualifier(name) {
  return name.replace(/[(（][^)）]*[)）]\s*$/, '');
}

// The bilibili wiki writes the element as "风属性"; roster.json carries the site's own English
// spelling. Only used to corroborate a zhName match, never to make one.
const ATTRIBUTE_ZH_TO_EN = {
  火属性: 'Fire', 水属性: 'Water', 雷属性: 'Thunder',
  风属性: 'Wind', 光属性: 'Light', 暗属性: 'Dark',
};

// Second join, for the 108 `bustOnly` characters. They come from miaowm5, which is a Chinese
// source: they carry a `zhName` but **no `jpName`**, so the primary join above cannot see them at
// all — and the bilibili wiki does document many of them. Matching on the Chinese name alone
// would be reckless (costume variants share their base character's zhName, and one page's costume
// is not another's), so a candidate only counts when the page's own rarity *and* element agree and
// exactly one candidate survives. That gate is what rejects e.g. 蒂妮(沙漠) → the Valentine 蒂妮.
function matchByZhName(page, byZhName) {
  const candidates = byZhName.get(stripQualifier(page.chineseNameFromList || '')) || [];
  const fit = candidates.filter(
    (c) =>
      c.rarity === page.basicInfo?.rarity &&
      c.attribute === ATTRIBUTE_ZH_TO_EN[page.basicInfo?.attribute]
  );
  return fit.length === 1 ? fit[0] : null;
}

// Same contract as fetch-miaowm5.mjs: a file we actually rewrote has to leave the path-keyed
// upload manifest, or upload-to-r2.mjs will skip it forever.
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

  // Only bustOnly entries are eligible for the zhName fallback: everything else already has a
  // jpName for the primary join, and letting the fallback reach them would let a costume page
  // re-claim a base character the join had deliberately given to someone else.
  // Keyed on the name with any trailing "(泳装)" stripped, on both sides of the join. A match
  // stamps the wiki's own spelling onto the roster entry — including that qualifier — so indexing
  // the raw zhName would make the second run miss what the first one matched.
  const byZhName = new Map();
  for (const c of roster.characters) {
    if (!c.bustOnly || !c.zhName) continue;
    const key = stripQualifier(c.zhName);
    if (!byZhName.has(key)) byZhName.set(key, []);
    byZhName.get(key).push(c);
  }

  const matchedRosterDevNames = new Set();
  const unmatchedWiki = [];
  const ambiguousWiki = [];
  const displacedWiki = [];
  let processed = 0;
  let failures = 0;

  const rosterByDev = new Map(roster.characters.map((c) => [c.devName, c]));

  // normalizeJpName drops a trailing "（流星祭）", so a costume page whose costume has no roster
  // entry of its own normalizes onto the base character and — when that base is the only
  // candidate, which skips the disambiguation below — used to overwrite the base character's
  // file. Base pages therefore go first, and the guard further down refuses the second write.
  const pageIsVariant = (p) => /[(（][^)）]*[)）]\s*$/.test(p.chineseNameFromList || '');
  const ordered = [...cached].sort((a, b) => Number(pageIsVariant(a)) - Number(pageIsVariant(b)));

  for (const page of ordered) {
    const forced = MANUAL_MATCHES[page.chineseNameFromList];
    const jp = normalizeJpName(page.basicInfo?.japaneseName);
    const candidates = forced
      ? [rosterByDev.get(forced)].filter(Boolean)
      : (jp && rosterByJp.get(jp)) || [];
    let roosterChar = candidates[0] || matchByZhName(page, byZhName);
    if (!roosterChar) {
      unmatchedWiki.push(page);
      continue;
    }
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

    if (matchedRosterDevNames.has(roosterChar.devName)) {
      // Another page already claimed this roster entry. One character's folder can only hold one
      // wiki_zh.json, and the first writer is the better match (base before variant, above) — but
      // a displaced costume page is exactly the case the zhName fallback exists for: the costume
      // usually does have its own roster entry, just a miaowm5-sourced one with no jpName.
      const alt = matchByZhName(page, byZhName);
      if (!alt || matchedRosterDevNames.has(alt.devName)) {
        displacedWiki.push({ page, devName: roosterChar.devName });
        continue;
      }
      roosterChar = alt;
    }

    // `thumb` is the usual way to the character's folder, but a few entries have no neutral.gif
    // and so no thumb — they still have a rarityN/<devName>/ folder (full-shot art, music) that
    // wiki_zh.json belongs in, and skipping them cost three characters their Chinese data.
    const charDir = roosterChar.thumb
      ? path.join(ASSETS_DIR, path.dirname(roosterChar.thumb))
      : path.join(ASSETS_DIR, `rarity${roosterChar.rarity}`, roosterChar.devName);
    if (!existsSync(charDir)) {
      unmatchedWiki.push(page);
      continue;
    }

    matchedRosterDevNames.add(roosterChar.devName);
    const voiceDir = path.join(charDir, 'voice');

    try {
      const voiceWithFiles = page.voice.length ? await downloadVoiceLines(page.voice, voiceDir) : [];
      // wiki_zh.json is co-owned: these seven keys are this pipeline's, and fetch-miaowm5.mjs
      // adds its own (info/related/emotions/pixelActions/storyCount/miaowm5Meta) to the same
      // file. Merging onto what is already there is what keeps a re-run from wiping the emotion
      // and pixel manifests the detail page renders from.
      const wikiPath = path.join(charDir, 'wiki_zh.json');
      const existing = existsSync(wikiPath) ? JSON.parse(readFileSync(wikiPath, 'utf8')) : {};
      // `voice` is the one shared key: the entries are this pipeline's, but fetch-miaowm5.mjs
      // stamps `textJp` (the Japanese battle line) onto them in place. Rebuilding the array from
      // the cache therefore has to carry those over, or every re-run silently drops them.
      const textJpByKey = new Map(
        (existing.voice || [])
          .filter((v) => v.textJp)
          .map((v) => [`${v.context} ${v.text}`, v.textJp])
      );
      const voiceMerged = voiceWithFiles.map((v) => {
        const textJp = textJpByKey.get(`${v.context} ${v.text}`);
        return textJp ? { ...v, textJp } : v;
      });
      const wikiZh = {
        ...existing,
        sourceUrl: page.sourceUrl,
        basicInfo: page.basicInfo,
        stats: page.stats,
        skills: page.skills,
        story: page.story,
        review: page.review,
        voice: voiceMerged,
      };
      if (writeJsonIfChanged(wikiPath, wikiZh)) invalidateR2(wikiPath);
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

  writeJsonIfChanged(ROSTER_PATH, roster);

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
    `## Wiki pages skipped — their roster entry was already claimed (${displacedWiki.length})`,
    '',
    '(Usually a costume/event variant the roster has no separate entry for.)',
    '',
    ...displacedWiki.map(({ page, devName }) => `- ${page.chineseNameFromList} — would have overwritten ${devName} — ${page.sourceUrl}`),
    '',
    `## roster.json characters with no wiki match (${unmatchedRoster.length})`,
    '',
    ...unmatchedRoster.map((c) => `- ${c.devName} — enName "${c.enName}" — jpName "${c.jpName}"`),
    '',
  ].join('\n');
  writeFileSync(REPORT_PATH, report);

  const freed = flushR2Invalidations();
  console.log(
    `Done. ${processed} matched, ${failures} failure(s), ${unmatchedWiki.length} unmatched wiki pages, ${displacedWiki.length} skipped as already-claimed, ${unmatchedRoster.length} roster entries without wiki data${freed ? `, ${freed} key(s) queued for R2 re-upload` : ''}. See ${path.relative(process.cwd(), REPORT_PATH)}.`
  );
  process.exit(failures > 0 ? 1 : 0);
}

main();
