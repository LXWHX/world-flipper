// The community English sheet: names the wikis don't have, and playthrough videos for the stories
// nobody has transcribed.
//
// Source: a public Google Sheet run by the English-speaking World Flipper community to organise
// uploading every story to YouTube. Five tabs, pulled through the CSV export endpoint (no API key,
// no auth — `/export?format=csv&gid=N`):
//
//   gid 0           character episodes, global units      -> per-character video links
//   gid 1087332562  the unit table                        -> EN Title / EN Name / JP Name / devName
//   gid 407898665   main story chapters                   -> per-chapter video links
//   gid 1660336789  event stories                         -> per-event video links
//   gid 914957196   character episodes, CN/JP-only units  -> the 108 bustOnly half of the roster
//
// Why it is worth a pipeline of its own: **the unit tab carries `devName`** ("Dev Nicknames"), the
// same key roster.json uses, so 432 of 485 characters match exactly with no name matching at all —
// including 60 `bustOnly` characters that have no English name anywhere else. That is the gap
// `wikigg-gaps.md` §1 called "needs a different source entirely". The remaining 52 come from the
// CN-only tab, which has no devName column, via a hand-verified title->devName table below.
//
// Everything here is *supplementary*: it never overwrites wiki text. Output is two new files owned
// exclusively by this script (`units_en.json`, `story/community_en.json`); the wiki.gg and miaowm5
// pipelines are untouched. Same byte-stable write + R2 invalidation rules as every other script.

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { politeFetch } from './lib/wiki-common.mjs';
import { makeR2Invalidator, writeIfChanged, writeJsonIfChanged } from './lib/wikigg-common.mjs';

const SHEET_ID = '1cjrja_U6biwyST_pX9yN6Y0pEpwOoB5QuVzRlevaTNE';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const CACHE_DIR = path.resolve('scripts/.community-en-cache');

const ASSETS_DIR = path.resolve('Character Assets');
const UNITS_OUT = path.join(ASSETS_DIR, 'units_en.json');
const STORY_OUT = path.join(ASSETS_DIR, 'story', 'community_en.json');
const REPORT_PATH = path.join(ASSETS_DIR, '_community_en_report.md');

const TABS = {
  charEpisodes: '0',
  units: '1087332562',
  mainStory: '407898665',
  events: '1660336789',
  cnOnlyEpisodes: '914957196',
};

// ---------------------------------------------------------------------------
// Story slugs
// ---------------------------------------------------------------------------

// The main-story tab's Chapter column, mapped onto our slugs. (That tab also has a stray trailing
// column of event ids pasted in from the event tab — World 1 is not `advent_event_001`. Ignored.)
const MAIN_SLUGS = {
  Prologue: 'prologue',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`World ${i + 1}`, `main_chapter_${i + 1}`])),
};

// The event tab's last column holds the game's own eventID, which is *nearly* our slug but not
// quite: ours came from the CN encyclopedia (`event_halloween2020`), theirs from the global client
// (`hw20`). Hand-mapped, each verified against the Chinese title of the story.
const EVENT_SLUGS = {
  xm19: 'event_christmas19', // 圣夜的骚乱者
  ny20: 'event_newyear20', // 新春贺岁弹弹弹
  valen_20: 'event_valentine20', // 激斗！情人节盛典攻防战！！
  cyberpunk01: 'event_cyberpunk01', // 幻彩摩天楼
  dollprincess01: 'event_fake_princess', // 虚假的人偶公主
  smr20: 'event_summer2020', // 大海的遗产
  yokai_emaki_01: 'event_ev_yokai_emaki001', // 妖怪图鉴编纂记
  hw20: 'event_halloween2020', // 降临讨伐 为你奏响的镇魂歌
  '1anv': 'event_1stanv', // 祈愿吧，光之继承者们
  deset_bonds_01: 'event_desert_kingdom', // 共誓黎明
  cyberpunk02_hero: 'event_cyberpunk02', // HERO:BEGINNING
  smr21: 'event_summer2021', // 热情的爱河★漂流者
  crown_beasts: 'event_crown_beasts', // 百兽王冠
  '2anv': 'event_anv2', // 前进吧，暗之梦旅人们。
  advent_event_004: 'event_elements', // 美食冒险者
  gcollabo: 'event_Gcollab', // Cross Blue
  valen_22: 'event_valentine22', // 胆怯PureYells！
  '2halfanv': 'event_2halfanv', // 交织未来的世界之歌
  ucollabo: 'event_advent_u_collabo_event', // 摇曳彼方的新大门
  smr22: 'event_summer_2022', // 碧蓝晴空微笑
  anv3: 'event_anv3', // 悠久王道，继承之骑士道
  boss_epuration: 'event_boss_epuration', // 歼灭者讨伐战
  '3halfanv': 'event_anv3half', // Ceremony
  zcollabo: 'extra_adv_100001', // 阻止暴走的罗梅罗
  rcollabo: 'extra_adv_100002', // 异界漂泊谭
  vcollabo_towa: 'extra_single_300001', // 斗和キセキ联动
};

// Three collab rows in the event tab carry no eventID at all, so they key off the Event Name.
const EVENT_SLUGS_BY_NAME = {
  'Haruhi Collab': 'extra_adv_100006', // 凉宫春日的跳跃
  'Konosuba Collab': 'extra_adv_300000', // 为奇迹的邂逅献上祝福！
  'BlackClover Collab': 'extra_adv_300001', // 不諦の魔道士
};

// Sheet rows for stories we don't have (the six Descension serpent events).
const STORY_ROWS_WITHOUT_SLUG = new Set([
  'advent_event_001', 'advent_event_002', 'advent_event_003',
  'advent_event_005', 'advent_event_007', 'advent_event_008',
]);

// ---------------------------------------------------------------------------
// CN-only characters
// ---------------------------------------------------------------------------

// The CN-only episode tab has no devName column, so these 52 are matched by hand — keyed on the
// tab's "TL Title" (its epithet), which unlike the unit name is unique across the whole sheet.
// Every pair was checked three ways: the roster `zhName` transliterates to the sheet's unit name
// (露涅塔 = Runetta, 卡西瓦尔斯 = Käsivars, 画狂老人Z = Old Man Zigza), the element matches, and
// the rarity matches. The script asserts the element/rarity half of that on every run.
const CN_ONLY_DEVNAMES = {
  'Arrogant Hero': 'suzumiya_haruhi',
  'Obsessed with Explosion Magic': 'megumin',
  'Newbie Adventurer of Fire': 'flame_blessgirl',
  'Pure and Lovely Kitten': 'catbaby_psychicer',
  'One Who Opened the Gate of Summer': 'summoner_little_smr23',
  'Passionate Proposal Suit': 'wirfled_playable',
  'Flame Dragon King': 'fire_dragon_zenith',
  'Silent Alien': 'nagato_yuki',
  'Goddess of the Axis Order': 'aqua',
  'Youngest Daughter of the Royal House of Silva': 'noelle_silva',
  'Adventurer of Empathetic Horns': 'vesta_caster',
  'Kowloon Gangster': 'amulet_bosslady',
  'Dragon Shadow On Summer Days': 'psychic_projection_smr23',
  'Bride of Possibilities': 'psycho_reaper_meteor23',
  'Canopy Bearer': 'guild_front_girl_playable',
  'Spirit of Blessing': 'dryad_hw23',
  'Cage Liberator': 'octcyborg_lady',
  'Inverted White Girl': 'dark_psygirl_vt23',
  'The Haughty Gentleman Negotiator': 'blade_dancer_wt23',
  'Psychic of Cutting Edge': 'psychic_katana',
  'Naked Lion': 'lion_boy_smr23',
  'Powerful Winged Shooter': 'starbreak_hunter_meteor23',
  'Codename: Shinigami': 'artificialeye_sniper',
  'Guardian of Courage': 'light_adventurer_4anv',
  'Wind-wielding Genius Mage': 'yuno',
  'Off-Shot Gravure': 'heavenly_two_vt23',
  'Psychic of Freedom': 'psychic_gal',
  'The Free Black Wolf Knight': 'black_wolf_knight_wt23',
  'The Man Who Knew the Afterwards': 'psychic_taichi',
  'Gravity Girlfriend': 'psychic_yamikawa_smr23',
  'Gale Fighter': 'combat_animal_meteor23',
  'Painting Enthusiast Crossing the Otherworldly': 'mob_jiguza_playable',
  // The sheet qualifies her "(Meteor)" and the devName says 4anv, but 希尔媞 is the only Silty in
  // the roster and element + rarity agree, so the pair is unambiguous.
  'Sword Saint of Stars': 'wind_spgirl_4anv',
  'SOS Brigade Mascot': 'asahina_mikuru',
  'Masochistic Crusader': 'darkness',
  'The Inheritor Dragon of Affection': 'golden_dragon_jr',
  "The Spirit Jewel's Resident Spirit": 'magatama_spirit',
  'Traveler of A Kindred Journey': 'nova_4anv',
  'Mage Without Magic': 'asta',
  'Master of Chaos': 'evilloli_master',
  'False Priest of Midnight': 'impostor_priest',
  'Starless Light': 'priest_prince_playable',
  'Psychic of Teleportation': 'psychic_teleport_playable',
  'Talkactive Ex-Intelligence Agent': 'blindfold_agent',
  'Traveler Embracing Dreams': 'stella_copy_4anv',
  'SOS Brigade Regular Human Representative': 'kyon',
  'Cowardly Ghost Exterminator': 'jiangshi_girl',
  'Dreaming Princess of Love': 'sleep_puppy_vt23',
  'Hero Mechanic': 'hero_mechanic',
  'Smiling Bard': 'koizumi_ituki',
  'Otherworldly Strategist': 'kazuma',
  'The Abyss Dragon of Connected Thoughts': 'darkness_dragon',
};

// The sheet writes the element in Chinese; roster.json uses the English token.
const ELEMENTS = { 火: 'Fire', 水: 'Water', 雷: 'Thunder', 風: 'Wind', 风: 'Wind', 光: 'Light', 闇: 'Dark', 暗: 'Dark' };

// ---------------------------------------------------------------------------
// Fetch + CSV
// ---------------------------------------------------------------------------

async function fetchTab(gid, { force = false } = {}) {
  const file = path.join(CACHE_DIR, `${gid}.csv`);
  if (!force && existsSync(file)) return readFileSync(file, 'utf8');
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const text = await politeFetch(url, { delayMs: 500, retries: 3 });
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, text, 'utf8');
  return text;
}

// A real CSV reader, not a split(','): several event names contain commas ("Blue Skies, Sunny
// Smiles") and one credit cell contains a newline inside its quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Unit names in the episode tabs carry footnote asterisks the unit tab doesn't have.
const cleanName = (s) => clean(s).replace(/\*+$/, '').trim();
const titleKey = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

// A row's video links. Each tab lays them out as repeating (recorder, publisher, url) triples; the
// credit shown on the site is the publisher, since that's whose channel the link opens.
function videosFrom(row, triples) {
  const out = [];
  for (const [byIdx, publishIdx, urlIdx, extra] of triples) {
    const raw = clean(row[urlIdx]);
    const url = (raw.match(/https?:\/\/\S+/) || [])[0];
    if (!url) continue;
    const by = clean(row[publishIdx]) || clean(row[byIdx]);
    const entry = { url };
    if (by && by !== 'N/A') entry.by = by;
    if (extra && extra.raw) entry.raw = true; // untranslated JP/KR footage
    if (out.some((v) => v.url === url)) continue;
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const force = process.argv.includes('--force');
  const roster = JSON.parse(readFileSync(path.join(ASSETS_DIR, 'roster.json'), 'utf8'));
  const rosterList = roster.characters || [];
  const byDev = new Map(rosterList.map((c) => [c.devName, c]));

  const [unitRows, epRows, cnRows, mainRows, eventRows] = await Promise.all([
    fetchTab(TABS.units, { force }).then(parseCsv),
    fetchTab(TABS.charEpisodes, { force }).then(parseCsv),
    fetchTab(TABS.cnOnlyEpisodes, { force }).then(parseCsv),
    fetchTab(TABS.mainStory, { force }).then(parseCsv),
    fetchTab(TABS.events, { force }).then(parseCsv),
  ]);

  const warnings = [];

  // --- units -------------------------------------------------------------------------------
  // EN Title, EN Name, JP Name, Attribute, Role, Stance, Race, Gender, Dev Nicknames
  const units = new Map(); // devName -> record
  const byTitle = new Map(); // EN Title -> devName, the join key for the episode tabs
  const unmatchedUnits = [];
  for (const row of unitRows.slice(1)) {
    const dev = clean(row[8]);
    if (!dev) continue;
    const character = byDev.get(dev);
    if (!character) { unmatchedUnits.push(`${clean(row[1])} (${dev})`); continue; }
    const record = { name: cleanName(row[1]), title: clean(row[0]) };
    const jp = clean(row[2]);
    if (jp) record.jpName = jp;
    units.set(dev, record);
    // Titles are unique across the 432 rows; a collision would silently mis-key an episode row.
    const key = titleKey(row[0]);
    if (byTitle.has(key)) warnings.push(`duplicate EN Title "${clean(row[0])}" (${byTitle.get(key)} / ${dev})`);
    byTitle.set(key, dev);
  }

  // --- character episode videos -------------------------------------------------------------
  // Joined on EN Title rather than the unit name: three units share a name with their own
  // alt ("Liam", "Hartlief"), and one episode row spells a name differently from the unit tab
  // ("Ernest" for Ornesto). Titles are unique and agree across tabs.
  const unmatchedEpisodes = [];
  let videoCount = 0;
  for (const row of epRows.slice(3)) {
    const title = clean(row[3]);
    if (!title) continue;
    const dev = byTitle.get(titleKey(title));
    if (!dev) { unmatchedEpisodes.push(`${title} / ${cleanName(row[4])}`); continue; }
    const videos = videosFrom(row, [[5, 6, 7], [8, 9, 10]]);
    if (videos.length) { units.get(dev).videos = videos; videoCount += videos.length; }
  }

  // The CN/JP-only tab: no devName column, so it goes through the hand-verified table. Its two
  // link columns are "untranslated" (raw JP/KR footage) and "translated".
  const unmatchedCnOnly = [];
  for (const row of cnRows.slice(3)) {
    const title = clean(row[3]);
    if (!title) continue;
    const dev = CN_ONLY_DEVNAMES[title];
    if (!dev) { unmatchedCnOnly.push(`${title} / ${cleanName(row[4])}`); continue; }
    const character = byDev.get(dev);
    if (!character) { unmatchedCnOnly.push(`${title} -> ${dev} (not in roster)`); continue; }
    // Guard the hand-written table: a mis-typed devName would otherwise quietly attach one
    // character's English name to another.
    const element = ELEMENTS[clean(row[2])];
    if (element && character.attribute !== element) {
      warnings.push(`element mismatch for "${title}" -> ${dev}: sheet ${element}, roster ${character.attribute}`);
      continue;
    }
    const record = units.get(dev) || {};
    record.name = record.name || cleanName(row[4]).replace(/\s*\([^)]*Collab\)\s*$/i, '');
    record.title = record.title || title;
    const videos = videosFrom(row, [[5, 5, 6, { raw: true }], [7, 7, 8]]);
    if (videos.length) { record.videos = videos; videoCount += videos.length; }
    units.set(dev, record);
  }

  // --- story videos ------------------------------------------------------------------------
  const stories = new Map(); // slug -> { title, videos }
  const unmatchedStories = [];

  for (const row of mainRows.slice(3)) {
    const chapter = clean(row[3]);
    if (!chapter) continue;
    const slug = MAIN_SLUGS[chapter];
    if (!slug) { unmatchedStories.push(`main: ${chapter}`); continue; }
    const videos = videosFrom(row, [[4, 4, 5], [6, 6, 7]]);
    // The main tab has no English chapter names (just "World 3"), so it contributes videos only —
    // the titles come from wiki.gg's own chapter pages (see scrape-wiki-gg-stories.mjs).
    if (videos.length) stories.set(slug, { videos });
  }

  for (const row of eventRows.slice(3)) {
    const name = clean(row[2]);
    if (!name) continue;
    const id = clean(row[12]);
    if (STORY_ROWS_WITHOUT_SLUG.has(id)) continue;
    const slug = EVENT_SLUGS[id] || EVENT_SLUGS_BY_NAME[name];
    if (!slug) { unmatchedStories.push(`event: ${name}${id ? ` (${id})` : ''}`); continue; }
    const entry = stories.get(slug) || {};
    entry.title = name;
    const videos = videosFrom(row, [[3, 4, 5], [6, 7, 8], [9, 10, 11]]);
    if (videos.length) entry.videos = videos;
    stories.set(slug, entry);
  }

  // --- write -------------------------------------------------------------------------------
  const r2 = makeR2Invalidator();
  let wrote = 0;

  const unitsPayload = {
    source: SHEET_URL,
    characters: Object.fromEntries([...units.keys()].sort().map((dev) => [dev, units.get(dev)])),
  };
  if (writeJsonIfChanged(UNITS_OUT, unitsPayload)) { wrote++; r2.add('units_en.json'); }

  const storyPayload = {
    source: SHEET_URL,
    stories: Object.fromEntries([...stories.keys()].sort().map((slug) => [slug, stories.get(slug)])),
  };
  if (writeJsonIfChanged(STORY_OUT, storyPayload)) { wrote++; r2.add('story/community_en.json'); }

  const namedInRoster = rosterList.filter((c) => c.enName).length;
  const nowNamed = rosterList.filter((c) => c.enName || units.has(c.devName)).length;
  const stillUnnamed = rosterList.filter((c) => !c.enName && !units.has(c.devName));

  const report = [
    '# Community English sheet — import report',
    '',
    'Generated by `npm run fetch:community-en`. Regenerate rather than editing by hand.',
    '',
    `Source: ${SHEET_URL}`,
    '',
    `- ${units.size} of ${rosterList.length} roster characters have a sheet record`,
    `- English names: ${namedInRoster} from roster.json -> **${nowNamed}** with the sheet merged in`,
    `- ${videoCount} character-episode video links`,
    `- ${stories.size} stories with an English title and/or video links`,
    '',
    '## Roster characters still with no English name',
    '',
    ...(stillUnnamed.length
      ? stillUnnamed.map((c) => `- \`${c.devName}\` — ${c.zhName || '(no zhName)'}`)
      : ['- (none)']),
    '',
    '## Sheet rows with no roster match',
    '',
    '### unit tab',
    '',
    ...(unmatchedUnits.length ? unmatchedUnits.map((s) => `- ${s}`) : ['- (none)']),
    '',
    '### character episodes (global)',
    '',
    ...(unmatchedEpisodes.length ? unmatchedEpisodes.map((s) => `- ${s}`) : ['- (none)']),
    '',
    '### character episodes (CN/JP-only)',
    '',
    ...(unmatchedCnOnly.length ? unmatchedCnOnly.map((s) => `- ${s}`) : ['- (none)']),
    '',
    '### stories',
    '',
    ...(unmatchedStories.length ? unmatchedStories.map((s) => `- ${s}`) : ['- (none)']),
    '',
    '## Warnings',
    '',
    ...(warnings.length ? warnings.map((s) => `- ${s}`) : ['- (none)']),
    '',
  ];
  writeIfChanged(REPORT_PATH, Buffer.from(report.join('\n'), 'utf8'));

  const invalidated = r2.flush();
  console.log(
    `[community-en] ${units.size} units (${nowNamed}/${rosterList.length} named), ${videoCount} character videos, ` +
      `${stories.size} stories; ${wrote} file(s) written, ${invalidated} R2 key(s) invalidated`
  );
  for (const w of warnings) console.warn(`[community-en] ${w}`);
  if (stillUnnamed.length) console.log(`[community-en] ${stillUnnamed.length} character(s) still unnamed — see ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('[community-en] failed:', err);
  process.exit(1);
});
