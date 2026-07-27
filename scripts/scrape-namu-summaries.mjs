// Machine-translated plot summaries for the Story tab's info panel, from en.namu.wiki.
//
// WHY THIS EXISTS (and what it deliberately is NOT): `wikigg-gaps.md` records that the main story
// Worlds 6-12 and ~21 events have no English *episode script* anywhere. namu.wiki does NOT close
// that gap — it carries prose *plot summaries* ("the recap if you skip the story"), one paragraph
// block per world/chapter, with no speaker-by-speaker dialogue. So this pipeline fills the one place
// a summary fits: the Story tab's info panel (`arcDetail.desc`), which today shows only Chinese text
// in English mode. It never touches the episode reader.
//
// TWO CAVEATS baked into the output and surfaced in the UI:
//   * The text is DOUBLE machine-translated (JP game -> Korean namu -> English MT proxy). The
//     front-end shows an "auto-translated, may contain errors" notice above it (`arcSummaryNotice`).
//   * namu.wiki is CC BY-NC-SA (an NC clause, stricter than the site's CC BY-SA wiki.gg sources) —
//     credited in that same notice line. Each record also carries its `sourceUrl`.
//
// FETCH REALITY: namu.wiki is frequently unreachable from mainland-China networks (the TLS handshake
// is reset). This script therefore DECOUPLES fetch from parse: it tries a live fetch first (which
// works from a network that can reach namu, e.g. behind a VPN), but if that fails it parses a
// MANUALLY-SAVED page dropped into the disk cache. Because the Worlds 6-12 summaries all live on a
// single near-static article, a one-time manual save is an acceptable fallback, not a blocker.
//
//   Manual fallback: open the source URL in a browser that can reach namu, save the page as HTML,
//   and drop it at  scripts/.namu-cache/<cacheKey>.html  (the path each SOURCE prints on a miss).
//
// Same conventions as the other pipelines (see PIPELINES.md): disk cache under scripts/.namu-cache/
// (gitignored, so re-runs are offline + byte-stable), byte-stable writes via writeJsonIfChanged,
// R2 invalidation per rewritten key. Output file (story/en/summary_en.json) is owned exclusively by
// this script — nothing else reads or writes it.

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { load } from 'cheerio';
import { politeFetch } from './lib/wiki-common.mjs';
import { writeJsonIfChanged, makeR2Invalidator, stripWikiMarkup } from './lib/wikigg-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const OUT_PATH = path.join(ASSETS_DIR, 'story', 'en', 'summary_en.json');
const REPORT_PATH = path.join(ASSETS_DIR, '_namu_summary_report.md');
const CACHE_DIR = path.resolve('scripts', '.namu-cache');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
  'Referer': 'https://en.namu.wiki/',
};

// ---------------------------------------------------------------------------
// Sources: one namu article -> many of our story slugs.
// ---------------------------------------------------------------------------
//
// The main-story article is a single page whose per-chapter sections map onto our `main_chapter_N`
// slugs. `sectionSlug(heading)` decides which slug a heading belongs to (or null to skip). Events
// live on their own namu pages and can be added here later — the table is extensible, and any
// section that resolves to no slug is REPORTED, not guessed (the same posture as STORY_PAGES in
// scrape-wiki-gg-stories.mjs).
// Event/collab sections. namu's article carries an event recap too, but the two sides share no key
// — namu's are machine-translated names, ours are the game's eventID slugs — so this is a
// hand-verified table (the same "refuse to guess" posture as STORY_PAGES / the community sheet's
// EVENT_SLUGS). Keys are the namu heading NORMALIZED by `normHeading` (outline number + footnote
// markers stripped, lowercased, whitespace collapsed); the comment is the zh title / English title
// each was checked against. Headings not in this table are reported, not guessed — that covers the
// advent/boss events namu lists without a clear counterpart (e.g. "Black Lightning's Waste Dragon")
// and the events newer than namu's page (halloween2020, anv3, boss_epuration, the Haruhi/Konosuba/
// Black Clover collabs). Two namu sections ("Cowardly Pure Yells!", "A song … future") are present
// but empty upstream, so they yield no paragraphs and drop out on their own.
const EVENT_TITLE_MAP = {
  "christmas eve's rogue": 'event_christmas19',            // 圣夜的骚乱者 / Violent Night, Holy Night
  'spring new year flipper': 'event_newyear20',            // 新春贺岁弹弹弹 / New Year's 2020
  'miracle golden head': 'extra_single_300001',            // 斗和キセキ联动 / The Miraculous Golden Head
  "jangryeol! valentine's festival battle": 'event_valentine20', // 激斗！情人节盛典攻防战 / Valentine's 2020
  'shining skyscraper': 'event_cyberpunk01',               // 幻彩摩天楼 / Neon Skyline
  'false doll princess': 'event_fake_princess',            // 虚假的人偶公主 / The Poppet Princess
  'advent subjugation gourmet adventurer': 'event_elements', // 美食冒险者 / Epicurean Adventurer
  'heritage of the ocean': 'event_summer2020',             // 大海的遗产 / Legacy of the Deep
  'advent subjugation stop the runaway romero!': 'extra_adv_100001', // 阻止暴走的罗梅罗 / Not Today, Romero
  'yokai encyclopedia compiler': 'event_ev_yokai_emaki001', // 妖怪图鉴编纂记 / The Yokai Encyclopedia
  'hope, heirs of light.': 'event_1stanv',                 // 祈愿吧，光之继承者们 / Driven by Hope, Guided by Light
  'advent subjugation wandering tale of the other world': 'extra_adv_100002', // 异界漂泊谭 / Wanderers from Another World
  'swear together': 'event_desert_kingdom',                // 共誓黎明 / Oath to the Dawn
  'advent subjugation cross blue': 'event_Gcollab',        // Cross Blue / CrossBlue
  'hero:beginning': 'event_cyberpunk02',                   // HERO:BEGINNING / A Hero's Beginning
  'passionate love drifters': 'event_summer2021',          // 热情的爱河★漂流者 / Love Adrift
  'crown of beasts': 'event_crown_beasts',                 // 百兽王冠 / Crown of the Beast King
  'go ahead, dark dreamers.': 'event_anv2',                // 前进吧，暗之梦旅人们 / Driven by Dreams, Guided through Darkness
  'cowardly pure yells!': 'event_valentine22',             // 胆怯PureYells / Confessions of a Coward
  'a song from the world that leads to the future': 'event_2halfanv', // 交织未来的世界之歌 / A Song for the Future
  'blue sunny smile': 'event_summer_2022',                 // 碧蓝晴空微笑 / Blue Skies, Sunny Smiles
};

// namu prefixes every heading with its own outline number ("2.7. Chapter 6 …", "3.8. false doll
// princess") and the odd footnote marker; normalize both away before matching.
function normHeading(heading) {
  return heading
    .replace(/^[0-9]+(?:\.[0-9]+)*\.?\s*/, '') // outline number
    .replace(/\[[^\]]*\]/g, '')                // footnote markers like [5]
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const SOURCES = [
  {
    cacheKey: 'main_story',
    url: 'https://en.namu.wiki/w/%EC%9B%94%EB%93%9C%20%ED%94%8C%EB%A6%AC%ED%8D%BC/%EC%8A%A4%ED%86%A0%EB%A6%AC',
    // Chapters 6-10 by number, then events via the hand table above. Chapter scope is deliberate:
    // Worlds 1-5 already have full English episode scripts from wiki.gg (a bare summary would be a
    // downgrade), and namu's article simply stops at Chapter 10 — global/Korean never reached 11-12.
    sectionSlug(heading) {
      const key = normHeading(heading);
      const m = key.match(/^(?:chapter|world|제)\s*0*(\d{1,2})/);
      if (m) {
        const n = parseInt(m[1], 10);
        return (n >= 6 && n <= 10) ? `main_chapter_${n}` : null;
      }
      return EVENT_TITLE_MAP[key] || null;
    },
  },
];

const SOURCE_LICENSE = 'CC BY-NC-SA 2.0 KR (namu.wiki)';

// ---------------------------------------------------------------------------
// HTML fetch (live, cached) with a manual-save fallback.
// ---------------------------------------------------------------------------

function cachePath(cacheKey) {
  return path.join(CACHE_DIR, `${cacheKey}.html`);
}

// Returns the page HTML, or null if it can neither be fetched nor found in the cache.
async function getHtml(source) {
  const cp = cachePath(source.cacheKey);
  if (existsSync(cp)) {
    return readFileSync(cp, 'utf8');
  }
  try {
    const html = await politeFetch(source.url, { delayMs: 1500, retries: 3, headers: BROWSER_HEADERS });
    if (html && html.length > 500) {
      if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cp, html, 'utf8');
      return html;
    }
  } catch (err) {
    console.warn(`  live fetch failed for ${source.cacheKey}: ${err.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse: each chapter heading owns the block(s) between it and the next heading.
// ---------------------------------------------------------------------------
//
// namu's section headings are <h#> nodes carrying the outline number; the summary for a section sits
// in the sibling <div>(s) that follow, up to the next heading. `$(h).nextUntil('h1..h6')` captures
// exactly that span, whatever the (hashed) class names are, so it works the same on a browser-saved
// copy. `extractParagraphs` then takes one paragraph per <li> (namu's per-episode unit); the text
// still carries namu's chrome — toggle labels ("[ View skip content ]"), footnote markers, escaped
// <img> markup — which `cleanText` strips.
function cleanText(raw) {
  return raw
    .replace(/<[^>]*>/g, ' ')             // escaped image/markup that survived into the text
    .replace(/\[\s*view[^\]]*\]/gi, ' ')  // namu's fold/unfold toggle labels
    .replace(/\[\d+\]/g, '')              // footnote markers
    .replace(/\s+/g, ' ')
    .trim();
}

function extractParagraphs($, span) {
  // Each in-game episode is a <li> (a <strong> title + a '- <body>' div), so one paragraph per <li>
  // splits both the chapters ('1-1 White Snow- ...') and the events ('unknown castle in the forest-
  // ...'), where events carry no numeric marker to regex on. Sections with no <li> list fall back to
  // a flattened split on the numeric episode marker.
  const items = span.find('li');
  if (items.length) {
    const out = [];
    items.each((_, li) => {
      const t = stripWikiMarkup(cleanText($(li).text()));
      if (t.length >= 12) out.push(t);
    });
    if (out.length) return out;
  }
  const s = cleanText(span.text()).replace(/\s*(?=\b\d{1,2}-\d{1,2}\s+\S)/g, '\n');
  return s.split(/\n+/).map(x => stripWikiMarkup(x).trim()).filter(x => x.length >= 12);
}

function parseSummaries(html, source) {
  const $ = load(html);
  const bySlug = new Map();   // slug -> [paragraph, ...]
  const seenHeadings = [];    // for the report

  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const slug = source.sectionSlug(text);
    seenHeadings.push({ text, slug });
    if (!slug) return;
    const paras = extractParagraphs($, $(el).nextUntil('h1,h2,h3,h4,h5,h6'));
    if (paras.length && !bySlug.has(slug)) bySlug.set(slug, paras);
  });

  return { bySlug, seenHeadings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const stories = {};
  const reportLines = [];
  const unmappedHeadings = [];
  let sourcesResolved = 0;

  for (const source of SOURCES) {
    const html = await getHtml(source);
    if (!html) {
      reportLines.push(
        `- **${source.cacheKey}**: unreachable and not cached. Save the page from a browser that ` +
        `can reach namu and drop it at \`${path.relative(process.cwd(), cachePath(source.cacheKey))}\`, ` +
        `then re-run.\n  Source: ${source.url}`
      );
      continue;
    }
    sourcesResolved++;
    const { bySlug, seenHeadings } = parseSummaries(html, source);
    for (const [slug, paras] of bySlug) {
      if (!paras.length) continue;
      stories[slug] = { desc: paras, sourceUrl: source.url };
    }
    for (const h of seenHeadings) {
      if (!h.slug) unmappedHeadings.push(`${source.cacheKey}: ${h.text}`);
    }
  }

  // --- Write output (byte-stable) ---
  const r2 = makeR2Invalidator();
  const slugs = Object.keys(stories).sort();
  const payload = {
    source: 'en.namu.wiki',
    license: SOURCE_LICENSE,
    machineTranslated: true,
    stories,
  };
  let invalidated = 0;
  if (slugs.length) {
    if (writeJsonIfChanged(OUT_PATH, payload)) r2.add('story/en/summary_en.json');
  }
  invalidated = r2.flush();

  // --- Report ---
  const report = [
    '# namu.wiki summary report',
    '',
    `Sources resolved: ${sourcesResolved}/${SOURCES.length}. Stories written: ${slugs.length}.`,
    '',
    slugs.length ? '## Written' : '## Nothing written',
    ...slugs.map(s => `- \`${s}\` — ${stories[s].desc.length} paragraph(s)`),
    '',
    '## Unmapped headings (reported, not written)',
    unmappedHeadings.length ? unmappedHeadings.map(h => `- ${h}`).join('\n') : '_none_',
    '',
    reportLines.length ? '## Sources needing a manual save' : '',
    reportLines.join('\n'),
  ].join('\n');
  writeFileSync(REPORT_PATH, report, 'utf8');

  console.log(`Wrote ${slugs.length} stories to ${path.relative(process.cwd(), OUT_PATH)} (${invalidated} R2 key(s) invalidated)`);
  console.log(`Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
  if (!sourcesResolved) {
    console.log('\nNo source HTML available. See the report for the manual-save path.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
