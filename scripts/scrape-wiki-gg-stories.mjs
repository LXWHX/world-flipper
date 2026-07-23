// The English half of the Story tab: main-quest and event episode scripts from
// worldflipper.wiki.gg.
//
// `wikigg-gaps.md` recorded "0 main-quest episodes" for this source. That was wrong — the search
// it was based on looked for `{{SL|` on /Stories subpages, and the main story doesn't live there.
// It lives on `Story Quests/World N: <name>/<Episode>` pages built on `{{Story pages}}`, whose
// `Script=` parameter holds the same `{{SL|...}}` lines the character stories use. The reliable way
// to find every one of them is `list=embeddedin` on the template itself, which is what this does:
// 131 pages, 60 main-quest episodes across Worlds 1-5 plus 71 event episodes across 10 events.
//
// Same rules as the other wiki.gg scripts (see CLAUDE.md): the Action API only, never HTML; raw
// wikitext 50 titles per request; responses cached in the shared `scripts/.wikigg-cache/`;
// byte-stable writes; R2 invalidation per rewritten key. Output lives in its own directory
// (`Character Assets/story/en/`) and is owned exclusively by this script — nothing here touches
// `story/index.json`, `story/detail/*.json` or the episode files the miaowm5 pipeline writes.

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  WIKIGG_BASE,
  apiCall,
  fetchWikitext,
  findTemplate,
  findTemplates,
  makeR2Invalidator,
  stripWikiMarkup,
  writeJsonIfChanged,
  writeIfChanged,
} from './lib/wikigg-common.mjs';

const ASSETS_DIR = path.resolve('Character Assets');
const STORY_DIR = path.join(ASSETS_DIR, 'story');
const OUT_DIR = path.join(STORY_DIR, 'en');
const REPORT_PATH = path.join(ASSETS_DIR, '_wikigg_stories_report.md');

// ---------------------------------------------------------------------------
// Page -> slug map
// ---------------------------------------------------------------------------
//
// The two sides share no key: our slugs come from the game's own eventID (see the main-story
// pipeline) and wiki.gg titles the story the way the global release did. There are only ~20 of
// them, so this is a hand-written table verified against the Chinese title of each story — the
// same "refuse to guess" posture the unit and weapon matchers take. A parent page missing from
// this table is reported, not silently dropped.
const STORY_PAGES = {
  // Main quest. Worlds 6-10 have a chapter page (so we get the English chapter name) but no
  // episode subpages — global's wiki simply never transcribed them.
  'Story Quests/World 1: Garden of the Sprites': 'main_chapter_1', // 精灵的乐园
  'Story Quests/World 2: Kingdom of Sand': 'main_chapter_2', // 沙尘的王国
  'Story Quests/World 3: Endless Blue': 'main_chapter_3', // 大海的尽头
  'Story Quests/World 4: Fang Canyon': 'main_chapter_4', // 獠牙的战场
  'Story Quests/World 5: Mecha Metropolis': 'main_chapter_5', // 机人的行星
  'Story Quests/World 6: Yamato': 'main_chapter_6', // 大和之都
  'Story Quests/World 7: The Wastelands': 'main_chapter_7', // 衰亡的箱庭
  'Story Quests/World 8: Realm of Ruin': 'main_chapter_8', // 荒芜的帝国
  'Story Quests/World 9: The Shifting City': 'main_chapter_9', // 摇曳的都市
  "Story Quests/World 10: Origin's End": 'main_chapter_10', // 终局的始原
  // Events.
  'The Poppet Princess': 'event_fake_princess', // 虚假的人偶公主
  'Legacy of the Deep Event': 'event_summer2020', // 大海的遗产
  "Valentine's Festival Event": 'event_valentine20', // 激斗！情人节盛典攻防战！！
  'Oath to the Dawn Event': 'event_desert_kingdom', // 共誓黎明
  "A Hero's Beginning Event": 'event_cyberpunk02', // HERO:BEGINNING
  'The Yokai Encyclopedia: The Art of Change Event': 'event_ev_yokai_emaki001', // 妖怪图鉴编纂记
  'The Descension: Cross Blue Event': 'event_Gcollab', // Cross Blue
  'The Descension: Not Today, Romero Event': 'extra_adv_100001', // 阻止暴走的罗梅罗
  'The Descension Wanderers from Another World Event': 'extra_adv_100002', // 异界漂泊谭
};

// Parent pages we know about and deliberately don't map: a global-only story with no Chinese
// counterpart on our side. Listed so the report can separate "unknown" from "known-absent".
const NO_COUNTERPART = new Set(['The Descension of the Seafang Serpent Event']);

const STORY_TEMPLATE = 'Template:Story pages';

// ---------------------------------------------------------------------------
// Script parsing
// ---------------------------------------------------------------------------

// A speaker cell is one of: plain text, {{DU|Name}}, {{DU|Name|rrggbb}} (the wiki's own name-plate
// colour, used for unnamed speakers like ???), or {{DUL|Name}} (the linked variant). Reading it as
// plain wikitext would leave the braces in the name, so unwrap the template first.
function parseSpeaker(cell) {
  const raw = String(cell || '').trim();
  const tpl = findTemplates(raw, null).find((t) => /^dul?$/i.test(t.name));
  if (!tpl) return { speaker: stripWikiMarkup(raw), color: '' };
  const [name = '', colour = ''] = tpl.positional;
  const hex = colour.trim().replace(/^#/, '');
  return {
    speaker: stripWikiMarkup(name),
    color: /^[0-9a-f]{3,8}$/i.test(hex) ? `#${hex}` : '',
  };
}

// `Script=` is a flat run of {{SL|speaker|line}} and {{SN|stage direction}} calls. They have to be
// read in one ordered pass rather than two findTemplates sweeps, or the narration would all pile up
// at the end of the episode instead of sitting between the lines it interrupts.
function parseScript(script) {
  if (!script) return [];
  const lines = [];
  for (const tpl of findTemplates(script, null)) {
    const name = tpl.name.toLowerCase();
    if (name === 'sl') {
      const [speakerCell = '', ...rest] = tpl.positional;
      const text = stripWikiMarkup(rest.join('|'));
      if (!text) continue;
      const { speaker, color } = parseSpeaker(speakerCell);
      lines.push(color ? { speaker, color, text } : { speaker, text });
    } else if (name === 'sn') {
      // Stage direction — no speaker, same shape as the Chinese reader's narration rows.
      const text = stripWikiMarkup(tpl.positional.join('|'));
      if (text) lines.push({ speaker: '', text });
    }
  }
  return lines;
}

// Episode order comes from the parent page's own quest tables, which link each episode as
// `[[/Name | Story]]`. Alphabetical page order is meaningless here ("Vengeance" before "Into the
// Ruins"), and the API gives no other ordering.
function episodeOrder(parentText) {
  const order = [];
  const seen = new Set();
  for (const m of String(parentText || '').matchAll(/\[\[\/([^\]|#]+)[|\]]/g)) {
    const name = m[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  return order;
}

// wikigg-common's pageUrl() percent-encodes the whole title, which is fine for unit pages but
// turns a subpage into `Story_Quests%2FWorld_1%3A_...`. Both forms resolve, but these URLs are
// shown to readers as the CC BY-SA credit link, so encode per path segment and leave the colon —
// what the wiki's own links look like.
function storyPageUrl(title) {
  const encoded = title
    .replace(/ /g, '_')
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/');
  return `${WIKIGG_BASE}/wiki/${encoded}`;
}

// The English display title of a story. Chapter pages are already titled the way the game titles
// them ("World 1: Garden of the Sprites"); event pages carry a trailing " Event" that reads as
// wiki bookkeeping rather than part of the name.
function displayTitle(parent) {
  return parent.replace(/^Story Quests\//, '').replace(/ Event$/, '').trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { force: false, only: null, limit: 0 };
  for (const arg of argv) {
    if (arg === '--force') opts.force = true;
    else if (arg.startsWith('--only=')) opts.only = new Set(arg.slice(7).split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg.startsWith('--limit=')) opts.limit = Number(arg.slice(8)) || 0;
  }
  return opts;
}

// Every article transcluding {{Story pages}}. This is the enumeration that matters: a title-prefix
// listing would miss any event whose pages don't share a prefix, and a category listing would miss
// pages nobody categorised.
async function listStoryPages(opts) {
  const titles = [];
  let cont = {};
  for (let guard = 0; guard < 50; guard++) {
    const json = await apiCall(
      {
        action: 'query',
        list: 'embeddedin',
        eititle: STORY_TEMPLATE,
        eilimit: '500',
        einamespace: '0',
        ...cont,
      },
      opts
    );
    for (const p of json.query?.embeddedin || []) titles.push(p.title);
    if (!json.continue) break;
    cont = json.continue;
  }
  return titles;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fetchOpts = { force: opts.force };

  console.log('[stories-en] listing pages that transclude {{Story pages}} ...');
  const pages = await listStoryPages(fetchOpts);
  console.log(`[stories-en] ${pages.length} episode pages`);

  // Group by parent page, which is the story. Split on the LAST '/': main-quest episodes are two
  // levels deep (`Story Quests/World 1: .../The Journey Begins`), so splitting on the first would
  // collapse every chapter into one bogus "Story Quests" story.
  const byParent = new Map();
  for (const title of pages) {
    const slash = title.lastIndexOf('/');
    if (slash < 0) continue; // a parent page transcluding the template itself; no episode of its own
    const parent = title.slice(0, slash);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(title);
  }
  // The chapter pages of Worlds 6-10 have no episodes but do carry the English chapter name, which
  // the Story tab wants for its list. Seed them so they reach the index with an empty episode list.
  for (const parent of Object.keys(STORY_PAGES)) if (!byParent.has(parent)) byParent.set(parent, []);

  const unknown = [];
  let targets = [];
  for (const [parent, episodes] of byParent) {
    const slug = STORY_PAGES[parent];
    if (!slug) {
      if (!NO_COUNTERPART.has(parent)) unknown.push(parent);
      continue;
    }
    if (opts.only && !opts.only.has(slug)) continue;
    targets.push({ parent, slug, episodes });
  }
  targets.sort((a, b) => a.parent.localeCompare(b.parent));
  if (opts.limit) targets = targets.slice(0, opts.limit);

  // One batched wikitext pull for parents + episodes, rather than per-story round trips.
  const wantTitles = [...targets.map((t) => t.parent), ...targets.flatMap((t) => t.episodes)];
  console.log(`[stories-en] fetching wikitext for ${wantTitles.length} pages ...`);
  const text = await fetchWikitext(wantTitles, fetchOpts);

  const r2 = makeR2Invalidator();
  const index = {};
  const rows = [];
  let wrote = 0;

  for (const { parent, slug, episodes } of targets) {
    const parentText = text.get(parent) || '';
    const order = episodeOrder(parentText);
    const rank = new Map(order.map((name, i) => [name, i]));
    const ordered = episodes.slice().sort((a, b) => {
      const an = a.slice(parent.length + 1);
      const bn = b.slice(parent.length + 1);
      // Anything the parent page doesn't link goes to the end, in title order, rather than being
      // dropped — an untabled episode is still readable content.
      const ar = rank.has(an) ? rank.get(an) : Number.MAX_SAFE_INTEGER;
      const br = rank.has(bn) ? rank.get(bn) : Number.MAX_SAFE_INTEGER;
      return ar - br || an.localeCompare(bn);
    });

    const parsed = [];
    for (const title of ordered) {
      const wikitext = text.get(title);
      if (!wikitext) continue;
      const tpl = findTemplate(wikitext, 'Story pages');
      if (!tpl) continue;
      const name = stripWikiMarkup(tpl.params.Story || title.slice(parent.length + 1));
      const summary = stripWikiMarkup(tpl.params.Summary || '');
      const lines = parseScript(tpl.params.Script || '');
      const episode = { name, sourceUrl: storyPageUrl(title) };
      if (summary) episode.summary = summary;
      if (lines.length) episode.lines = lines;
      parsed.push(episode);
    }

    const title = displayTitle(parent);
    const sourceUrl = storyPageUrl(parent);
    const payload = { source: WIKIGG_BASE, slug, title, sourceUrl, episodes: parsed };
    const file = path.join(OUT_DIR, `${slug}.json`);
    if (writeJsonIfChanged(file, payload)) {
      wrote++;
      r2.add(`story/en/${slug}.json`);
    }

    const withText = parsed.filter((e) => e.lines && e.lines.length).length;
    index[slug] = { title, sourceUrl, episodeCount: withText };
    rows.push({ slug, parent, title, episodes: parsed.length, withText });
  }

  // The index is what the Story tab fetches in English: story titles for the list, plus the count
  // that tells it whether opening a story is worth a second fetch. Keys are sorted so the file is
  // byte-stable regardless of the order the API returned pages in.
  const sortedIndex = {};
  for (const slug of Object.keys(index).sort()) sortedIndex[slug] = index[slug];
  // A partial run (--only/--limit) must not drop the stories it didn't visit.
  if (opts.only || opts.limit) {
    const file = path.join(OUT_DIR, 'index.json');
    if (existsSync(file)) {
      try {
        const prev = JSON.parse(readFileSync(file, 'utf8'));
        for (const [slug, entry] of Object.entries(prev.stories || {})) {
          if (!(slug in sortedIndex)) sortedIndex[slug] = entry;
        }
      } catch {
        // A corrupt index is simply rewritten from this run.
      }
    }
  }
  const indexPayload = {
    source: WIKIGG_BASE,
    stories: Object.fromEntries(Object.keys(sortedIndex).sort().map((k) => [k, sortedIndex[k]])),
  };
  if (writeJsonIfChanged(path.join(OUT_DIR, 'index.json'), indexPayload)) {
    wrote++;
    r2.add('story/en/index.json');
  }

  // Report: what matched, what didn't, and how the English episode counts compare with ours. The
  // counts differing is expected (different source, different episode split) — it's there so a
  // wildly wrong mapping shows up as an obvious mismatch.
  let cnCounts = new Map();
  try {
    const cn = JSON.parse(readFileSync(path.join(STORY_DIR, 'index.json'), 'utf8'));
    cnCounts = new Map((cn.stories || []).map((s) => [s.slug, s]));
  } catch {
    // The Chinese index is optional here — the report just loses a column.
  }
  const lines = [
    '# wiki.gg story pages — matching report',
    '',
    'Generated by `npm run scrape:stories-en`. Regenerate rather than editing by hand.',
    '',
    `- ${pages.length} pages transclude \`{{Story pages}}\``,
    `- ${rows.length} of our stories matched (${rows.filter((r) => r.withText).length} with dialogue)`,
    '',
    '## Matched',
    '',
    '| slug | wiki.gg page | English title | EN episodes | with script | CN episodes |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => {
      const cn = cnCounts.get(r.slug);
      return `| \`${r.slug}\` | ${r.parent} | ${r.title} | ${r.episodes} | ${r.withText} | ${cn ? cn.episodeCount : '—'} |`;
    }),
    '',
    '## wiki.gg stories with no counterpart on our side',
    '',
    ...[...NO_COUNTERPART].map((p) => `- ${p}`),
    '',
    '## Unmapped wiki.gg parents (add to STORY_PAGES if one of ours)',
    '',
    ...(unknown.length ? unknown.sort().map((p) => `- ${p}`) : ['- (none)']),
    '',
  ];
  writeIfChanged(REPORT_PATH, Buffer.from(lines.join('\n'), 'utf8'));

  const invalidated = r2.flush();
  console.log(
    `[stories-en] ${rows.length} stories, ${rows.reduce((n, r) => n + r.withText, 0)} episodes with dialogue; ` +
      `${wrote} file(s) written, ${invalidated} R2 key(s) invalidated`
  );
  if (unknown.length) console.log(`[stories-en] ${unknown.length} unmapped parent page(s) — see ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('[stories-en] failed:', err);
  process.exit(1);
});
