// Scrapes the bilibili biligame World Flipper wiki (中文 wiki) character pages into a local
// cache. This is Phase 1 of the wiki-integration pipeline — raw, unmatched data only.
// Phase 2 (scripts/match-wiki-to-roster.mjs) matches these against Character Assets/roster.json
// by Japanese name and writes the per-character files the site actually reads.
//
// Usage:
//   node scripts/scrape-wiki-zh.mjs                scrape everything not already cached
//   node scripts/scrape-wiki-zh.mjs --force        ignore the manifest, re-scrape everything
//   node scripts/scrape-wiki-zh.mjs --limit=5       only scrape the first N characters (debugging)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadHtml,
  politeFetch,
  findSections,
  parseBasicInfoTable,
  parseStatsTable,
  parseSkillTables,
  parseStoryTables,
  parseEvaluationTable,
  parseVoiceTable,
} from './lib/wiki-common.mjs';

const WIKI_BASE = 'https://wiki.biligame.com';
const LIST_URL = `${WIKI_BASE}/worldflipper/%E8%A7%92%E8%89%B2`;
const CACHE_DIR = path.resolve('scripts/.wiki-scrape-cache');
const MANIFEST_PATH = path.resolve('scripts/.wiki-scrape-manifest.json');
const DELAY_MS = 1000;

const FORCE = process.argv.includes('--force');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

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

async function fetchCharacterList() {
  const html = await politeFetch(LIST_URL, { delayMs: DELAY_MS });
  const $ = loadHtml(html);
  const seen = new Map(); // href -> chineseName
  $('div.unit-icon a[href^="/worldflipper/"]').each((_, a) => {
    const href = $(a).attr('href');
    const title = $(a).attr('title') || $(a).text().trim();
    if (href && title && !seen.has(href)) seen.set(href, title);
  });
  return [...seen.entries()].map(([href, chineseName]) => ({
    href,
    url: WIKI_BASE + href,
    chineseName,
  }));
}

function parseCharacterPage(html) {
  const $ = loadHtml(html);
  const sections = findSections($);

  const basicInfoTable = sections.get('基本信息')?.find((el) => el.is('table'));
  const statsTable = sections.get('属性')?.find((el) => el.is('table'));
  const skillTables = (sections.get('技能') || []).filter((el) => el.is('table')).map((el) => el[0]);
  const evaluationTable = sections.get('评价')?.find((el) => el.is('table'));
  const voiceTables = (sections.get('语音') || []).filter((el) => el.is('table'));

  return {
    basicInfo: basicInfoTable ? parseBasicInfoTable($, basicInfoTable) : {},
    stats: statsTable ? parseStatsTable($, statsTable) : {},
    skills: skillTables.length ? parseSkillTables($, skillTables) : [],
    story: parseStoryTables($, sections.get('角色故事') || []),
    review: evaluationTable ? parseEvaluationTable($, evaluationTable) : '',
    voice: voiceTables.flatMap((table) => parseVoiceTable($, table)),
  };
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  console.log('Fetching character list...');
  const characters = await fetchCharacterList();
  console.log(`Found ${characters.length} character links.`);

  const done = loadManifest();
  const targets = characters.slice(0, LIMIT).filter((c) => FORCE || !done.has(c.href));
  console.log(`${targets.length} pending (${done.size} already cached).`);

  let failures = 0;
  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    const cacheFile = path.join(CACHE_DIR, `${encodeURIComponent(c.chineseName)}.json`);
    try {
      const html = await politeFetch(c.url, { delayMs: DELAY_MS });
      const parsed = parseCharacterPage(html);
      const record = {
        sourceUrl: c.url,
        chineseNameFromList: c.chineseName,
        scrapedAt: new Date().toISOString(),
        ...parsed,
      };
      writeFileSync(cacheFile, JSON.stringify(record, null, 2));
      done.add(c.href);
      if ((i + 1) % 10 === 0) saveManifest(done);
      console.log(`[${i + 1}/${targets.length}] ok   ${c.chineseName}`);
    } catch (err) {
      failures++;
      console.error(`[${i + 1}/${targets.length}] FAIL ${c.chineseName}: ${err.message}`);
    }
  }

  saveManifest(done);
  console.log(`Done. ${failures} failure(s). Re-run to retry failures/resume remaining characters.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
