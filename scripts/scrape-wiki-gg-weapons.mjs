// Pulls the English armament data from worldflipper.wiki.gg into Weapons/weapons_en.json — a
// sidecar to the Chinese Weapons/weapons.json the Armaments tab already reads.
//
// Sidecar rather than extra keys on weapons.json: that file is rewritten wholesale by
// scrape-weapons.mjs, so sharing it would mean inventing an owned-keys contract between two
// scrapers (the trap the miaowm5/bilibili split already documents). A separate file keyed by the
// same `href` merge-key costs the front-end one extra one-time fetch and nothing else.
//
// MATCHING: the two sources share no key at all — biligame has only Chinese names, wiki.gg only
// English ones. So weapons are matched on the numbers the game itself defines:
// rarity + element + base HP/ATK + max HP/ATK. Verified by hand: 捕食者 (Fire 5★ 440/112 → 660/168)
// resolves to "Predator". Ambiguous keys are refused rather than guessed.
//
// Usage:
//   node scripts/scrape-wiki-gg-weapons.mjs           everything (uses the disk cache)
//   node scripts/scrape-wiki-gg-weapons.mjs --force   ignore the cache, re-fetch

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  categoryMembers,
  fetchWikitext,
  findTemplate,
  makeR2Invalidator,
  pageUrl,
  pruneEmpty,
  stripWikiMarkup,
  writeIfChanged,
  writeJsonIfChanged,
} from './lib/wikigg-common.mjs';

const WEAPONS_DIR = path.resolve('Weapons');
const SRC_JSON = path.join(WEAPONS_DIR, 'weapons.json');
const OUT_JSON = path.join(WEAPONS_DIR, 'weapons_en.json');
const REPORT_PATH = path.join(WEAPONS_DIR, '_wikigg_unmatched_report.md');

const FORCE = process.argv.includes('--force');
const opts = { force: FORCE };

// Two naming differences to fold away before the element can be part of a key:
//   - wiki.gg writes thunder both ways (Category:Thunder Armaments and Category:Lightning Units
//     both exist upstream); the site's own ELEMENT_ORDER uses Thunder.
//   - the non-elemental bucket is "All" on wiki.gg (77 pages) and "None" in weapons.json (84).
//     There is no "none" on the wiki side at all — they are the same bucket under two names.
const normElement = (e) => {
  const v = String(e || '').trim().toLowerCase().replace('lightning', 'thunder');
  if (!v || v === '-' || v === 'all') return 'none';
  return v;
};

const num = (v) => {
  const m = String(v ?? '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// A blank value or the "-" placeholder the {{Armament}} template uses for "no awakening" is not
// a value.
function text(params, key) {
  const v = stripWikiMarkup(params?.[key]);
  return !v || v === '-' ? '' : v;
}

const statKey = (rarity, element, baseHp, baseAtk, maxHp, maxAtk) =>
  [num(rarity), normElement(element), num(baseHp), num(baseAtk), num(maxHp), num(maxAtk)].join('|');

// Orbs (宝珠) ship with max stats only — no base row on either wiki (CLAUDE.md records this for the
// Chinese side). They get a second, shorter key so they can still be matched.
const maxOnlyKey = (rarity, element, maxHp, maxAtk) =>
  [num(rarity), normElement(element), num(maxHp), num(maxAtk)].join('|');

// Tiebreaker for weapons that share an identical stat line (whole families do). The effect text is
// in different languages, but the NUMBERS in it are the game's own and survive translation:
// "自身攻击+160%" and "own ATK +160%" both fingerprint to "160". Sorted so clause order doesn't
// matter. Resolves 48 of the 64 collisions; the rest stay refused.
const effectFingerprint = (s) =>
  (String(s || '').match(/\d+(\.\d+)?/g) || []).sort().join(',');

function addTo(map, key, value) {
  if (key.includes('null|null')) return; // not enough numbers to identify anything
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

async function main() {
  if (!existsSync(SRC_JSON)) {
    console.error('Weapons/weapons.json not found — run `npm run scrape:weapons` first.');
    process.exit(1);
  }
  const source = JSON.parse(readFileSync(SRC_JSON, 'utf8')).weapons || [];

  console.log('Fetching armament list...');
  const titles = await categoryMembers('Armaments', opts);
  console.log(`  ${titles.length} armament pages.`);
  const pages = await fetchWikitext(titles, opts);

  // ---- index the wiki side --------------------------------------------------------------
  const byFull = new Map();
  const byMaxOnly = new Map();
  const parsed = new Map();
  const fingerprints = new Map();
  const nonWeaponPages = [];

  for (const title of titles) {
    const tpl = findTemplate(pages.get(title) || '', 'Armament');
    if (!tpl) {
      nonWeaponPages.push(title);
      continue;
    }
    const p = tpl.params;
    parsed.set(title, p);
    fingerprints.set(title, effectFingerprint(stripWikiMarkup(p.maxSkillDetail)));
    addTo(byFull, statKey(p.rarity, p.element, p.baseHP, p.baseAttack, p.maxHP, p.maxAttack), title);
    addTo(byMaxOnly, maxOnlyKey(p.rarity, p.element, p.maxHP, p.maxAttack), title);
  }

  // ---- match ----------------------------------------------------------------------------
  const records = [];
  const unmatched = [];
  const ambiguous = [];
  const used = new Set();

  for (const w of source) {
    const full = statKey(w.rarity, w.element, w.baseHp, w.baseAtk, w.maxHp, w.maxAtk);
    let hits = byFull.get(full);
    let via = 'stats';
    // Orbs carry no base row, so fall back to the max-only key for them.
    if ((!hits || hits.length !== 1) && w.baseHp == null && w.baseAtk == null) {
      hits = byMaxOnly.get(maxOnlyKey(w.rarity, w.element, w.maxHp, w.maxAtk));
      via = 'max-only';
    }
    if (!hits) {
      unmatched.push({ w, why: 'no page with these stats' });
      continue;
    }
    if (hits.length > 1) {
      // Whole weapon families share a stat line. Break the tie on the effect text's numbers,
      // which cross the language gap; if that doesn't single one out, refuse rather than guess —
      // a wrong weapon name is worse than a missing one.
      const fp = effectFingerprint(w.maxEffect);
      const narrowed = fp ? hits.filter((t) => fingerprints.get(t) === fp) : [];
      if (narrowed.length !== 1) {
        ambiguous.push({ w, hits });
        continue;
      }
      hits = narrowed;
      via = `${via}+effect`;
    }
    const title = hits[0];
    if (used.has(title)) {
      ambiguous.push({ w, hits: [title], why: 'page already claimed by another weapon' });
      continue;
    }
    used.add(title);
    const p = parsed.get(title);
    records.push(
      pruneEmpty({
        href: w.href, // the merge key weapons.json already uses
        nameEn: title,
        description: text(p, 'description'),
        obtain: text(p, 'obtain'),
        releaseDate: text(p, 'releaseDate'),
        baseSkillDetail: text(p, 'baseSkillDetail'),
        maxSkillDetail: text(p, 'maxSkillDetail'),
        abilityCoreDetail: text(p, 'abilityCoreDetail'),
        awakenLevelThree: text(p, 'awakenLevelThree'),
        awakenLevelFive: text(p, 'awakenLevelFive'),
        matchedVia: via,
        sourceUrl: pageUrl(title),
      })
    );
  }

  const orphanPages = titles.filter((t) => !used.has(t) && !nonWeaponPages.includes(t));

  // Stable order so the file is diff-friendly regardless of scrape order.
  records.sort((a, b) => a.href.localeCompare(b.href));

  const r2 = makeR2Invalidator();
  if (writeJsonIfChanged(OUT_JSON, { weapons: records })) {
    r2.add('Weapons/weapons_en.json'); // uploader's key prefix for the top-level Weapons/ folder
  }

  // ---- report ---------------------------------------------------------------------------
  const lines = [
    '# wiki.gg (English) armaments — unmatched report',
    '',
    'Generated by `npm run scrape:weapons-en`. Regenerate rather than editing by hand.',
    '',
    `Matched ${records.length} of ${source.length} Chinese weapons against ${titles.length} wiki.gg pages.`,
    'Matching is on rarity + element + base/max HP/ATK, since the two sources share no name.',
    '',
    `## Chinese weapons with no English match (${unmatched.length})`,
    '',
    'Expected for anything the global release never shipped.',
    '',
    ...(unmatched.length
      ? unmatched.map(
          ({ w }) =>
            `- ${w.nameZh} — ${w.rarity}★ ${w.element} ${w.baseHp ?? '-'}/${w.baseAtk ?? '-'} → ${w.maxHp ?? '-'}/${w.maxAtk ?? '-'}`
        )
      : ['_None._']),
    '',
    `## Refused as ambiguous (${ambiguous.length})`,
    '',
    'Several wiki.gg pages share these exact stats, so no match is safe. Resolve by hand if it',
    'matters — add a third dimension (obtain/releaseDate) to the key, or an override table.',
    '',
    ...(ambiguous.length
      ? ambiguous.map(
          ({ w, hits, why }) =>
            `- ${w.nameZh} (${w.rarity}★ ${w.element}) → ${hits.join(' / ')}${why ? ` — ${why}` : ''}`
        )
      : ['_None._']),
    '',
    `## wiki.gg armament pages with no Chinese counterpart (${orphanPages.length})`,
    '',
    ...(orphanPages.length ? orphanPages.map((t) => `- ${t}`) : ['_None._']),
    '',
    `## Pages in Category:Armaments with no {{Armament}} template (${nonWeaponPages.length})`,
    '',
    ...(nonWeaponPages.length ? nonWeaponPages.map((t) => `- ${t}`) : ['_None._']),
    '',
  ];
  writeIfChanged(REPORT_PATH, Buffer.from(lines.join('\n'), 'utf8'));

  const removed = r2.flush();
  console.log(
    `Done. ${records.length}/${source.length} matched, ${unmatched.length} unmatched, ` +
      `${ambiguous.length} ambiguous, ${orphanPages.length} orphan page(s). ` +
      `${removed} R2 key(s) invalidated.`
  );
}

main();
