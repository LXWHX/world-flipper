// Pulls the English character data from worldflipper.wiki.gg into
// Character Assets/rarityN/<devName>/wiki_en.json + story_en.json.
//
// Three page families feed this (see CLAUDE.md's wiki.gg section):
//   Category:Units             -> {{Unit}}            profile, stats, skill, leader talent, abilities
//   Category:Unit story pages  -> {{Unit story page}}  episode names/summaries + {{SL}} dialogue
//   Category:Unit Quote Pages  -> {{Unit Quotes}}      English voice-line text (no audio)
//
// MATCHING IS THE HARD PART. roster.json's `enName` comes from a different source than wiki.gg's
// page titles, and the two disagree far more than they look like they will ("Alice" matches, but
// only 166 of 377 do). Three tiers, in order — see the constants below for the details:
//   1. name    — normalized title, with the systematic qualifier drift aliased and "A / B"
//                alternative romanizations split apart.
//   2. stats   — rarity + element + max HP + max ATK, read out of the character's own
//                wiki_zh.json. Same trick the weapons matcher uses: the numbers are the game's,
//                so they cross the language gap even when every name differs. Unique keys only.
//   3. overrides — a small hand-checked table for the leftovers, where the romanizations differ
//                *and* the stats drifted between the CN and global builds.
// The 108 `bustOnly` characters are CN-only and have no page here at all — that is the data, not a
// bug; they are listed separately in the report and keep falling back to Chinese in the UI.
//
// Usage:
//   node scripts/scrape-wiki-gg-units.mjs                     everything (uses the disk cache)
//   node scripts/scrape-wiki-gg-units.mjs --force             ignore the cache, re-fetch
//   node scripts/scrape-wiki-gg-units.mjs --limit=5           only the first N matches (debugging)
//   node scripts/scrape-wiki-gg-units.mjs --only=alice,alk    only these devNames

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  categoryMembers,
  fetchWikitext,
  findTemplate,
  findTemplates,
  makeR2Invalidator,
  pageUrl,
  parseSLLines,
  pruneEmpty,
  stripWikiMarkup,
  writeIfChanged,
  writeJsonIfChanged,
} from './lib/wikigg-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const ROSTER_PATH = path.join(ASSETS_DIR, 'roster.json');
const REPORT_PATH = path.join(ASSETS_DIR, '_wikigg_unmatched_report.md');

const FORCE = process.argv.includes('--force');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',').map((s) => s.trim())) : null;

const opts = { force: FORCE };

// Index key: case-, accent- and punctuation-insensitive. roster.json spells a few names with
// accents/typographic quotes where the wiki uses plain ASCII (and vice versa).
function normTitle(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// The global build renamed the recurring seasonal qualifiers wholesale, so this is a rule rather
// than a per-character exception: roster "(Christmas)" is the wiki's "(Holiday)", and every
// anniversary variant became a "Flipperversary" one.
const QUALIFIER_ALIASES = {
  christmas: 'holiday',
  anniversary: 'flipperversary',
  'half anniversary': 'half flipperversary',
};

// Leftovers that BOTH the name tier and the stats tier miss — the romanization differs and the
// CN/global stat lines drifted apart. Hand-checked one by one against the wiki. This is the same
// escape-hatch pattern CATEGORY_OVERRIDES uses in fetch-main-story.mjs; entries only ever need
// adding, never maintaining, since both sides are frozen history.
const TITLE_OVERRIDES = {
  fire_dragon: 'Vagner',
  devil_leader: 'Adjudicus',
  shapely_soldier: 'Levy',
  psychic_tomboygirl: 'Rinne Hikawa', // roster stores this one surname-first
  hero_girl: 'Nate',
  electro_girl: 'Telluna',
  sea_violent: 'Diletta',
  stella_2anv: 'Stella (Driven by Dreams, Guided Through Darkness)',
  touyakiren_ceo: 'Love',
  towa_namakubi: 'C F Kiseki',
  towa_vtuber: 'Towa Kiseki',
  slango_red: 'Red Blobble',
  wind_oracle_1anv: 'Phiria (Flipperversary)',
  dimension_witch_ny22: 'Belsidia (New Year)',
  // NOT listed here on purpose: estateguild_leader ("Hildegard") is almost certainly the wiki's
  // "Hildegarde" (same name, same 5★ Dark), but it is one of the three roster entries with
  // `thumb: null` — no folder to write into and filtered out of the grid — so matching it would
  // raise the reported count without producing a file. See wikigg-gaps.md.
};

// Every spelling of `enName` worth trying against the wiki's titles. roster.json writes genuinely
// ambiguous romanizations as "Ecrire / Écrire (Summer)" — one name, two spellings, so each half
// gets recombined with the qualifier rather than searched as-is.
function titleVariants(enName) {
  const out = new Set();
  const m = enName.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const base = m ? m[1] : enName;
  const qualifier = m ? m[2] : null;
  const bases = base.split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  const qualifiers = qualifier === null
    ? [null]
    : [qualifier, QUALIFIER_ALIASES[qualifier.toLowerCase()]].filter(Boolean);
  for (const b of bases) {
    for (const q of qualifiers) out.add(normTitle(q ? `${b} (${q})` : b));
  }
  return [...out];
}

// The character's own max HP / max ATK as the bilibili pipeline recorded them. `stats` rows are
// [base, max] pairs, so the max is the last cell.
function maxStatsFromWikiZh(absDir) {
  const file = path.join(absDir, 'wiki_zh.json');
  if (!existsSync(file)) return null;
  try {
    const stats = JSON.parse(readFileSync(file, 'utf8')).stats || {};
    const hp = stats['生命值']?.slice(-1)[0];
    const atk = stats['攻击力']?.slice(-1)[0];
    if (hp == null || atk == null) return null;
    return { hp: String(hp).trim(), atk: String(atk).trim() };
  } catch {
    return null;
  }
}

// wiki.gg spells the thunder element both ways (Category:Thunder Units and Category:Lightning
// Units both exist); the site's own ELEMENT_ORDER uses Thunder.
const normElement = (e) => String(e || '').trim().toLowerCase().replace('lightning', 'thunder');

const num = (v) => {
  const m = String(v ?? '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// A wiki parameter that's blank, absent, or the "-" placeholder the armament/unit templates use
// for "no value" is simply not a value.
function text(params, key) {
  const v = stripWikiMarkup(params?.[key]);
  return !v || v === '-' ? '' : v;
}

function buildUnit(title, wikitext) {
  const tpl = findTemplate(wikitext, 'Unit');
  if (!tpl) return null;
  const p = tpl.params;

  const abilities = [];
  for (let i = 1; i <= 12; i++) {
    const a = text(p, `ability${i}`);
    if (a) abilities.push(a);
  }

  return pruneEmpty({
    sourceUrl: pageUrl(title),
    info: {
      name: text(p, 'name'),
      title: text(p, 'title'),
      description: text(p, 'description'),
      va: text(p, 'va'),
      class: text(p, 'class'),
      race: text(p, 'race'),
      gender: text(p, 'gender'),
      obtain: text(p, 'obtain'),
      releaseDate: text(p, 'releaseDate'),
    },
    stats: {
      rarity: num(p.rarity),
      element: text(p, 'element'),
      maxHP: num(p.maxHP),
      maxAttack: num(p.maxAttack),
      power: num(p.power),
      hit: num(p.hit),
    },
    skill: {
      name: text(p, 'skillName'),
      detail: text(p, 'maxSkillDetail'),
      gauge: num(p.maxSkillGauge),
    },
    leaderTalent: {
      name: text(p, 'leaderTalentName'),
      detail: text(p, 'maxLeaderTalentDetail'),
    },
    abilities,
  });
}

// {{Unit story page}} numbers its parameters episode1Name/episode1Summary/episode1Script, ...
// Returns the shared episode list; the caller splits it into the light half (wiki_en.json) and the
// heavy dialogue half (story_en.json, lazily fetched by the front-end).
function buildStories(wikitext) {
  const tpl = findTemplate(wikitext, 'Unit story page');
  if (!tpl) return [];
  const episodes = [];
  for (let i = 1; i <= 12; i++) {
    const name = text(tpl.params, `episode${i}Name`);
    const summary = text(tpl.params, `episode${i}Summary`);
    const lines = parseSLLines(tpl.params[`episode${i}Script`]);
    if (!name && !summary && !lines.length) continue;
    episodes.push({ name, summary, lines });
  }
  return episodes;
}

function buildQuotes(wikitext) {
  return findTemplates(wikitext, 'Unit Quote')
    .map((t) => ({ type: text(t.params, 'quoteType'), text: text(t.params, 'quoteText') }))
    .filter((q) => q.text);
}

async function main() {
  if (!existsSync(ROSTER_PATH)) {
    console.error('Character Assets/roster.json not found.');
    process.exit(1);
  }
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')).characters || [];

  console.log('Fetching category listings...');
  const [unitTitles, storyTitles, quoteTitles] = await Promise.all([
    categoryMembers('Units', opts),
    categoryMembers('Unit story pages', opts),
    categoryMembers('Unit Quote Pages', opts),
  ]);
  console.log(
    `  ${unitTitles.length} units, ${storyTitles.length} story pages, ${quoteTitles.length} quote pages.`
  );

  const hasStory = new Set(storyTitles.map(normTitle));
  const hasQuotes = new Set(quoteTitles.map(normTitle));

  // Every unit page's wikitext up front — the stats tier needs to read {{Unit}} for all of them
  // before it can match anything, and at 50 titles per request that is only ~8 calls.
  const unitPages = await fetchWikitext(unitTitles, opts);

  const unitByNorm = new Map();
  const byStatKey = new Map();
  const nonCharacterPages = []; // e.g. "Units", a navigation page that sits in the category
  for (const title of unitTitles) {
    const tpl = findTemplate(unitPages.get(title) || '', 'Unit');
    if (!tpl) {
      nonCharacterPages.push(title);
      continue;
    }
    unitByNorm.set(normTitle(title), title);
    const key = [
      tpl.params.rarity,
      normElement(tpl.params.element),
      tpl.params.maxHP,
      tpl.params.maxAttack,
    ].join('|');
    if (!byStatKey.has(key)) byStatKey.set(key, []);
    byStatKey.get(key).push(title);
  }

  // ---- match roster -> wiki title -------------------------------------------------------
  const matches = [];
  const noEnName = [];
  const unmatched = [];
  const usedTitles = new Set();
  const tierCount = { name: 0, stats: 0, override: 0 };

  for (const c of roster) {
    if (!c.enName) {
      noEnName.push(c);
      continue;
    }
    let title = null;
    let tier = null;

    for (const v of titleVariants(c.enName)) {
      if (unitByNorm.has(v)) {
        title = unitByNorm.get(v);
        tier = 'name';
        break;
      }
    }

    if (!title && c.thumb) {
      const stats = maxStatsFromWikiZh(path.join(ASSETS_DIR, path.dirname(c.thumb)));
      if (stats) {
        const hits = byStatKey.get(
          [c.rarity, normElement(c.attribute), stats.hp, stats.atk].join('|')
        );
        // Ambiguous keys are refused outright — a wrong match is worse than a missing one.
        if (hits && hits.length === 1) {
          title = hits[0];
          tier = 'stats';
        }
      }
    }

    if (!title && TITLE_OVERRIDES[c.devName]) {
      const t = unitByNorm.get(normTitle(TITLE_OVERRIDES[c.devName]));
      if (t) {
        title = t;
        tier = 'override';
      }
    }

    if (!title) {
      unmatched.push(c);
      continue;
    }
    usedTitles.add(title);
    tierCount[tier]++;
    if (ONLY && !ONLY.has(c.devName)) continue;
    matches.push({ char: c, title });
  }
  const orphanPages = unitTitles.filter(
    (t) => !usedTitles.has(t) && !nonCharacterPages.includes(t)
  );
  console.log(
    `  matched by name: ${tierCount.name}, by stats: ${tierCount.stats}, by override: ${tierCount.override}`
  );

  const targets = matches.slice(0, LIMIT);
  console.log(
    `Matched ${matches.length}/${roster.filter((c) => c.enName).length} named characters; ` +
      `scraping ${targets.length}.`
  );

  // ---- fetch the subpages ---------------------------------------------------------------
  // The {{Unit}} pages themselves are already in `unitPages` (the matcher needed them all).
  // Only request the /Stories and /Quotes subpages the category listings say actually exist.
  const storyWanted = targets.filter((t) => hasStory.has(normTitle(`${t.title}/Stories`)));
  const quoteWanted = targets.filter((t) => hasQuotes.has(normTitle(`${t.title}/Quotes`)));
  console.log(`  ${storyWanted.length} with stories, ${quoteWanted.length} with quotes.`);
  const storyPages = await fetchWikitext(storyWanted.map((t) => `${t.title}/Stories`), opts);
  const quotePages = await fetchWikitext(quoteWanted.map((t) => `${t.title}/Quotes`), opts);

  // ---- write ----------------------------------------------------------------------------
  const r2 = makeR2Invalidator();
  let wrote = 0;
  let noTemplate = 0;
  let storyCount = 0;
  let quoteCount = 0;

  for (const { char, title } of targets) {
    // The folder is derivable from `thumb` (rarityN/<devName>/neutral.gif) exactly as the
    // front-end derives head.png from it — no separate path field on the roster.
    if (!char.thumb) continue;
    const dir = path.dirname(char.thumb);
    const absDir = path.join(ASSETS_DIR, dir);

    const wikitext = unitPages.get(title);
    const record = wikitext ? buildUnit(title, wikitext) : null;
    if (!record) {
      noTemplate++;
      console.error(`  ! no {{Unit}} template on "${title}" (${char.devName})`);
      continue;
    }

    const episodes = buildStories(storyPages.get(`${title}/Stories`) || '');
    if (episodes.length) {
      storyCount++;
      // Titles + summaries are small and the detail page shows them immediately, so they ride
      // wiki_en.json; the dialogue is the bulk and goes in the lazily-fetched story_en.json.
      record.stories = episodes.map(({ name, summary }) => pruneEmpty({ name, summary }));
      const storyDest = path.join(absDir, 'story_en.json');
      if (writeJsonIfChanged(storyDest, { sourceUrl: pageUrl(`${title}/Stories`), episodes })) {
        r2.add(`${dir}/story_en.json`);
      }
    }

    const quotes = buildQuotes(quotePages.get(`${title}/Quotes`) || '');
    if (quotes.length) {
      quoteCount++;
      record.quotes = quotes;
    }

    const dest = path.join(absDir, 'wiki_en.json');
    if (writeJsonIfChanged(dest, record)) {
      r2.add(`${dir}/wiki_en.json`);
      wrote++;
    }
  }

  // ---- report ---------------------------------------------------------------------------
  // Only rewrite the report on a full run; a --only/--limit run would otherwise shrink it to
  // whatever subset was inspected.
  if (!ONLY && LIMIT === Infinity) {
    const lines = [
      '# wiki.gg (English) — unmatched report',
      '',
      'Generated by `npm run scrape:wiki-en`. Regenerate rather than editing by hand.',
      '',
      `Matched ${tierCount.name + tierCount.stats + tierCount.override} of ` +
        `${roster.filter((c) => c.enName).length} named characters ` +
        `(${tierCount.name} by name, ${tierCount.stats} by stats, ${tierCount.override} by override).`,
      '',
      `## Roster entries with an \`enName\` but no wiki.gg page (${unmatched.length})`,
      '',
      'Cross-check these against the orphan list below before assuming a character is absent:',
      'if a plausible counterpart is sitting there under a different romanization, add the pair to',
      '`TITLE_OVERRIDES` in `scripts/scrape-wiki-gg-units.mjs`. Characters the global release never',
      'got (the Haruhi Suzumiya collab, for one) legitimately have no page and belong here.',
      '',
      ...(unmatched.length
        ? unmatched.map((c) => `- \`${c.devName}\` — ${c.enName}`)
        : ['_None._']),
      '',
      `## wiki.gg unit pages with no roster entry (${orphanPages.length})`,
      '',
      ...(orphanPages.length ? orphanPages.map((t) => `- ${t}`) : ['_None._']),
      '',
      `## Pages in Category:Units with no {{Unit}} template (${nonCharacterPages.length})`,
      '',
      'Navigation/index pages that share the category. Skipped, not an error.',
      '',
      ...(nonCharacterPages.length ? nonCharacterPages.map((t) => `- ${t}`) : ['_None._']),
      '',
      `## Roster entries with no \`enName\` — expected, not a gap (${noEnName.length})`,
      '',
      'These are the `bustOnly` CN-only characters. worldflipper.wiki.gg documents the global',
      'release, so they have no page there and no English text exists for them anywhere.',
      'They fall back to Chinese in the UI by design.',
      '',
      ...noEnName.map((c) => `- \`${c.devName}\` — ${c.zhName || '(no zhName)'}`),
      '',
    ];
    if (writeIfChanged(REPORT_PATH, Buffer.from(lines.join('\n'), 'utf8'))) {
      console.log('Wrote _wikigg_unmatched_report.md');
    }
  }

  const removed = r2.flush();
  console.log(
    `Done. ${wrote} wiki_en.json written/updated (${storyCount} with stories, ${quoteCount} with quotes). ` +
      `${removed} R2 key(s) invalidated.`
  );
  // A matched page that turned out to have no {{Unit}} template means the matcher pointed at
  // something that isn't a character — worth failing the run over.
  process.exit(noTemplate > 0 ? 1 : 0);
}

main();
