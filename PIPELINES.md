# PIPELINES.md

`scripts/*.mjs` 的抓取/生成管线细节。改任何 `scripts/` 下的脚本、或改动
`Character Assets/` / `Weapons/` 的产物格式前，先读这份文件。前端与架构说明在 `CLAUDE.md`。

## 通用规则

Two sources feed `Character Assets/`: the bilibili wiki (text) and miaowm5 (art + extra data —
both the per-character pipeline and the main-story pipeline). Rules that apply across all of them:

- **Byte-stability.** All writes go through `writeIfChanged`/`writeJsonIfChanged`; a no-op re-run
  produces zero diff. Nothing carries a per-run timestamp (`story_zh.json`'s `generatedAt` is
  preserved unless the payload changes) — a fresh timestamp would rewrite ~370 files and force a
  full R2 re-upload. Keep it that way. (A default run after `--new-chars` legitimately rewriting
  `related` chips in existing `wiki_zh.json` files is a real content change, not churn — don't
  suppress it.)
- **Skip-if-exists fast paths.** Composited images (`head.png`, `story_heads/`, `icons/`) are
  skipped when the output file exists — **changing a composite means deleting the old files
  first**. Don't reach for `--force`, which also regenerates every pixel GIF.
- **R2 invalidation.** When a file is rewritten, its key is dropped from
  `scripts/.r2-upload-manifest.json` so `upload-to-r2.mjs` re-uploads it (the manifest is
  path-based, not content-hashed).

## bilibili wiki pipeline (wiki.biligame.com)

`rarityN/<devName>/wiki_zh.json` + `voice/*.mp3` hold scraped text (basic info, skills, story,
evaluation, voice lines). Two steps: `npm run scrape:wiki-zh` (`scripts/scrape-wiki-zh.mjs`,
shared parsing in `scripts/lib/wiki-common.mjs`) crawls into `scripts/.wiki-scrape-cache/`
(gitignored, resumable); `npm run match:wiki-zh` (`scripts/match-wiki-to-roster.mjs`) matches
pages to `roster.json` by `jpName`, downloads voice mp3s, writes `wiki_zh.json`, and stamps
`hasWiki`/`voiceCount`/`zhName` on the roster (unmatched cases →
`Character Assets/_unmatched_wiki_report.md`). The English counterpart now exists as
`wiki_en.json` — see the wiki.gg pipeline below. It does **not** match by `enName` the way this
note once assumed it would; that only works for 166 of 377.

## weapons pipeline (wiki.biligame.com/worldflipper/装备)

`npm run scrape:weapons` (`scripts/scrape-weapons.mjs`, flags `--force`/`--limit=N`) scrapes the
bilibili wiki's equipment (装备) into the **top-level `Weapons/` folder** (a sibling of
`Character Assets/`, not under it — see `upload:assets` in `CLAUDE.md`), feeding the Armaments tab's 武器库
library + 武器详情 detail. Same source, HTTP-manners, disk-cache resume
(`scripts/.weapons-scrape-cache/`, gitignored) and byte-stable `writeIfChanged` rules as the
character wiki pipeline; reuses `scripts/lib/wiki-common.mjs`. Current scrape: 384 weapons.

- **The list page carries rarity + element in a CSS class.** Each tile is a
  `div.unit-icon unit-icon-{rarity}-{element}` (element ∈ `fire|water|thunder|wind|light|dark|none`,
  mapped onto the site's `ELEMENT_ORDER` + a non-elemental `None` bucket) — so the grid's rarity and
  element come straight off the list, no per-page parse. The icon `<img>` src is upgraded from its
  `/thumb/…/NNpx-` thumbnail to the original; the patchwiki `<hash>` becomes the icon filename
  (`Weapons/icons/<hash>.png`, skip-if-exists), stable and CJK-free.
- **The detail page is one `table.wikitable`** (bespoke `模板:装备图鉴展示`, not the character
  pages' `mw-headline`/section layout). Its caption holds name/alt/rarity/element + a `<p>` flavor
  line; body rows are label→value (`能力`/`限制`/`体系` → role/limit/system, `获取方式`,
  `效果`/`最大效果`), with `初始`/`满级` header rows switching the HP/ATK phase between base and
  max. Parsing anchors on the label text, so a missing field degrades gracefully — e.g. 宝珠 (orb)
  entries legitimately have only max stats + `最大效果`, no base row.
- **biligame answers a bot-shaped request with HTTP 567.** The scraper sends a clean browser UA +
  `Accept`/`Accept-Language`/`Referer` (via `politeFetch`'s `headers` option) and backs off on
  retry; that's what turns it back into a 200.
- **`Weapons/weapons.json`** is the index the front-end reads (`WEAPON_BASE + '/weapons.json'`):
  one lean record per weapon (`href` merge-key, `nameZh`, `rarity`, `element`, `role`/`limit`/
  `system`, `icon`, base/max `hp`/`atk`, `effect`/`maxEffect`, `flavor`, `acquisition` — empty/null
  fields pruned). Partial `--limit` runs merge into the existing file rather than dropping entries.

## wiki.gg pipeline (worldflipper.wiki.gg) — the English text

The English half of the character sheet and the weapon library. Two scripts, one shared lib
(`scripts/lib/wikigg-common.mjs`), same byte-stable/`invalidateR2`/disk-cache rules as everything
above (cache: `scripts/.wikigg-cache/`, gitignored). Output files are **new and exclusively owned**
— nothing here ever touches `wiki_zh.json`, `weapons.json` or `roster.json`, so the three existing
pipelines are unaffected and no owned-keys contract had to be extended.

- **It has a real API — do not scrape HTML.** `api.php` is a full public MediaWiki 1.43 Action API.
  Content lives in flat template parameters, fetched as raw wikitext **50 titles per request**
  (`prop=revisions&rvslots=main`); all 379 unit pages cost ~8 calls. No Cargo/SMW, so the templates
  are the schema: `{{Unit}}`, `{{Unit story page}}` (+`{{SL|speaker|line}}`), `{{Unit Quotes}}`,
  `{{Armament}}`.
- **The template parser must balance braces, not regex.** `episodeNScript` holds dozens of nested
  `{{SL|…}}` calls whose pipes are not parameter separators. `findTemplates` splits on `|`/`=` only
  at depth 0 — and deliberately **descends into non-matching templates**, since `{{Unit Quote}}`
  is nested inside a `{{Unit Quotes}}` wrapper.

**Characters** (`npm run scrape:wiki-en`, `--force`/`--limit=N`/`--only=devName,…`) writes
`rarityN/<devName>/wiki_en.json` (profile, stats, skill, leader talent, abilities, episode
names+summaries, quotes) and `story_en.json` (the dialogue, split off for the same reason
`story_zh.json` is: the front-end only fetches it when the story panel opens).

- **Matching is the hard part — three tiers, currently 369/377.** `enName` looks like it should
  equal the page title, and for Alice it does, but **only 166 of 377 match that way**. Tier 2 is
  the winner (189): `rarity + element + maxHP + maxAttack`, with the max stats read out of the
  character's own `wiki_zh.json` — the numbers are the game's, so they cross the language gap when
  every name differs. Tier 3 is a 14-entry `TITLE_OVERRIDES` table for the rest.
- Two systematic name drifts are rules, not exceptions: roster `(Christmas)` = wiki `(Holiday)`,
  and every `(Anniversary)` = `(Flipperversary)`. roster also writes ambiguous romanizations as
  `"Ecrire / Écrire (Summer)"` — one name, two spellings, so each half is recombined with the
  qualifier before lookup.
- **The 108 `bustOnly` characters have no English anywhere** — they're CN-only and wiki.gg
  documents the global release. Expected, reported separately, and they fall back to Chinese.
  The 5 Haruhi Suzumiya collab characters are genuinely absent for the same reason.
- `_wikigg_unmatched_report.md` lists both sides. Cross-check a roster miss against the orphan
  list before believing a character is absent — a counterpart under a different romanization
  belongs in `TITLE_OVERRIDES`.

**Weapons** (`npm run scrape:weapons-en`) writes **`Weapons/weapons_en.json`**, a sidecar keyed by
the same `href` merge-key, *not* extra columns on `weapons.json` (that file is rewritten wholesale
by `scrape-weapons.mjs`; sharing it would mean inventing a second owned-keys contract). 316/384.

- The two sources share **no name at all**, so the key is `rarity + element + base/max HP/ATK`.
  Verified by hand: 捕食者 (Fire 5★ 440/112 → 660/168) = **Predator**.
- **wiki.gg calls the non-elemental bucket `All`; `weapons.json` calls it `None`.** There is no
  `none` upstream — same bucket, two names. Missing this costs ~60 matches on its own. (Thunder is
  likewise spelled `Lightning` in places.)
- Whole weapon families share an identical stat line, so ~64 keys collide. The tiebreaker is the
  **numbers inside the effect text**, which survive translation ("自身攻击+160%" and "own ATK +160%"
  both fingerprint to `160`); that resolves 48. The remaining collisions are **refused, not
  guessed** — a wrong weapon name is worse than a missing one.
- Orbs have no base row on either side (as with the CN scraper), so they fall back to a
  max-stats-only key.

**Main + event stories** (`npm run scrape:stories-en`, `scripts/scrape-wiki-gg-stories.mjs`) writes
`Character Assets/story/en/<slug>.json` + `story/en/index.json`, feeding the **Story tab** in
English. 19 stories, 119 episodes with dialogue.

- **This source does have the main story** — an earlier note in `wikigg-gaps.md` said it had none.
  The scripts aren't on `/Stories` subpages; they're on `Story Quests/World N: <name>/<Episode>`
  and `<Event> Event/<Episode>` pages built on `{{Story pages}}` (`Story`/`Summary`/`Script`).
  Enumerate them with **`list=embeddedin` on `Template:Story pages`** — 131 pages, the only listing
  that finds every event without knowing its title. Coverage is Worlds 1-5 (Worlds 6-10 have a
  chapter page, so an English *title* but no episodes) plus 9 events.
- **Speakers are wrapped**: `{{SL|{{DU|Alk}}|line}}`, sometimes `{{DU|???|a32535}}` (a name-plate
  colour) or `{{DUL|…}}`. `parseSLLines` in `wikigg-common.mjs` doesn't unwrap those, so this
  script has its own `parseSpeaker`/`parseScript` — which also has to read `{{SL}}` and `{{SN}}`
  (stage directions) in **one ordered pass**, or the narration all piles up at the end.
- **Episode order comes from the parent page's quest tables** (`[[/Name | Story]]` links, in
  order). The API's page order is alphabetical, which is meaningless here.
- Slugs are a hand table (`STORY_PAGES`) — ours come from the CN encyclopedia's eventID, theirs
  from the global release's own naming, and they share no key. The report cross-checks each pair's
  episode count against `story/index.json`, which is what makes a mis-mapping obvious.

**Front-end.** English is preferred when `state.lang === 'en'` and falls back to Chinese
**field by field** — a character can have an English profile but no English stories, and many do.
`wiki_en.json`/`story_en.json`/`weapons_en.json`/`story/en/*` are fetched **only in English** (so a
zh session pays nothing), which is why `toggleLang()` has to kick the loaders for whatever is already
open. `null` = not fetched, `false` = fetched and absent. Two deliberate asymmetries:

- **English quotes are a separate group in the voice panel, not a relabelling of the mp3 rows.**
  They carry no audio and don't correspond one-to-one, so overwriting `voice[].text` would pair
  the wrong line with the clip that plays.
- **English story episodes replace the Chinese list wholesale** rather than merging: different
  source, different episode count, and an index means different things in each. wiki.gg scripts
  have no `speakerDev`, so those speakers get the plain name plate (no portrait, no emotion art).
- `nickname` and `type` have no `{{Unit}}` equivalent and stay Chinese in English mode — the
  per-field fallback working as designed, since the data only exists in Chinese.
- wiki.gg is **CC BY-SA**: every record carries `sourceUrl`, and a credit line (`wikiSourceGg`)
  renders under the English text on the character sheet, the weapon detail and the Story tab's
  episode list.

## community sheet pipeline (a public Google Sheet)

`npm run fetch:community-en` (`scripts/fetch-community-en.mjs`, flag `--force`) reads the
English-speaking community's story-archive spreadsheet — five tabs pulled straight through the CSV
export endpoint (`/export?format=csv&gid=N`, no auth), cached in `scripts/.community-en-cache/`
(gitignored). It writes two files it owns outright, `Character Assets/units_en.json` and
`Character Assets/story/community_en.json`, plus `_community_en_report.md`. Nothing else is touched.

- **The unit tab carries `devName`** (its "Dev Nicknames" column) — the same key `roster.json`
  uses, so 432 of 485 characters match exactly with no name matching at all. That is the whole
  reason this source is worth a pipeline: it closes the gap `wikigg-gaps.md` §1 called "needs a
  different source entirely". **Every character now has an English name except `flame_witch`.**
- The other 52 are on a separate CN/JP-only tab with **no devName column**, so they go through the
  hand-verified `CN_ONLY_DEVNAMES` table, keyed on the tab's epithet ("TL Title" — unique, unlike
  the unit name). Each pair was checked by transliterating the roster `zhName` (露涅塔 = Runetta,
  卡西瓦尔斯 = Käsivars, 画狂老人Z = Old Man Zigza); the script re-checks element and rarity on
  every run and **skips + warns** rather than mis-attaching a name.
- **The character-episode tabs join on the epithet, not the unit name.** Three units share a name
  with their own alt (two Liams, two Hartliefs) and one row spells a name differently from the unit
  tab ("Ernest" for Ornesto — so that's *not* a missing character, as §3 of the gaps doc assumed).
  Epithets are unique across all 432 rows.
- Event rows key off the game's own eventID in the last column, which is *near* our slug but not
  equal (`hw20` vs our `event_halloween2020`) — hence `EVENT_SLUGS`. Three collabs have no id at
  all and key off the event name. The main-story tab's trailing id column is a stray paste from the
  event tab (World 1 is not `advent_event_001`) and is ignored.
- What it actually provides: **English names/epithets/jpName** for the whole roster, **a YouTube
  playthrough link per character episode** (484) and **per story** (42 of 42, the only English that
  exists for the 29 stories nobody transcribed), and an English title for every event. It does
  **not** provide main-chapter titles — the tab only says "World 3" — those come from wiki.gg.
- Links are other people's recordings, so the UI credits the uploader and marks the JP/KR ones
  (`raw: true`) as having no English subtitles. `units_en.json` is in `upload-to-r2.mjs`'s
  `INCLUDE_TOP_LEVEL`; `story/community_en.json` ships under the `story/` prefix already.

## Eliya-bot GL pipeline (eliya-bot.herokuapp.com) — English skill text for the bustOnly gap

`npm run fetch:eliya-gl` (`scripts/fetch-eliya-gl.mjs`, flags `--refresh`/`--only=`/`--limit=`) fills
the one hole wiki.gg left in the character sheet: the **60 `bustOnly` characters** have an English
*name* (from the community sheet) but no English **skill / leader buff / abilities** text anywhere.
Eliya-bot's Global (GL) collection tracker has exactly that, keyed by **`DevNicknames` = our
`devName`** — an exact join, no name-matching. It writes `rarityN/<devName>/eliya_en.json`, a
sidecar in the **same shape the front-end reads from `wiki_en.json`** (`info`/`stats`/`skill`/
`leaderTalent`/`abilities`, plus a `source: 'eliya'` marker), so no new render path is needed —
`loadWikiEn()` tries `wiki_en.json` first and falls back to this. `rarityN/*` ships to R2 wholesale,
so no `upload-to-r2.mjs` change was needed. Same byte-stable `writeIfChanged`/`invalidateR2` rules
as everything above; report is `_eliya_gl_report.md`.

- **The data arrives over socket.io, not a static file.** The committed `datagl/chars.json` in
  `github.com/poswords/EliyaBot` is base stats only; the English text is merged in at runtime from a
  Google Sheet and served over the `chars` socket event (EIO=4) after the client emits
  `connected` with `'gl'`. The script connects with `socket.io-client`, captures that event, and
  caches the raw array under `scripts/.eliya-cache/` (gitignored) so re-runs are offline and
  byte-stable. Eliya packs a bracketed label onto its strings (`"[Winged Inferno]\nVagner"`,
  `"[Prominence Blaze]\ndetail"`) — `splitLabel` peels the epithet / skill name off the body.
- **It writes only where `wiki_en.json` is absent** (60 files; the 369 wiki.gg matches are skipped
  as redundant, and a stale sidecar next to a now-present `wiki_en.json` is deleted). `description`,
  `va` and `class` are left empty on purpose — Eliya has no blurb / voice actor and its Role
  vocabulary (Sword/Fist/…) isn't wiki.gg's class names, so those rows fall back to Chinese.
- **The 3 name-drift characters wiki.gg missed are moot here.** Eliya confirms them
  (`estateguild_leader`=Hildegarde, `anger_investigator`=Weihu, `scissor_ratgirl`=Karina), but all
  three are `thumb:null` — no folder, filtered out of every grid — so there is nowhere to write and
  nothing on screen. The remaining 53 roster characters (incl. `flame_witch`) aren't in the GL data
  at all (CN-only / never globally released), so they stay Chinese-only for skill text.
- Eliya is not CC BY-SA wiki.gg, so the character sheet's English credit switches on the
  `source: 'eliya'` marker (`wikiEnSourceText` / `wikiSourceEliya`); the Story tab's wiki.gg credit
  is unaffected.

## namu.wiki summary pipeline (en.namu.wiki) — machine-translated plot summaries

`npm run scrape:namu-en` (`scripts/scrape-namu-summaries.mjs`) fills the Story tab's **info panel**
(`arcDetail.desc`) — which shows only Chinese in English mode — with English plot summaries for the
main-story chapters that have **no English episode script anywhere** (wiki.gg stops at World 5). It
writes one owned file, `Character Assets/story/en/summary_en.json` (`{stories:{slug:{desc[],
sourceUrl}}}`), read by `loadArcEn()`; the front-end prefers it over the Chinese `desc` and shows a
one-line "auto-translated, may contain errors" notice above it (`arcSummaryNotice`).

- **This is summaries, NOT scripts.** namu carries a prose recap ("the story if you skip it"), one
  paragraph per in-game episode, with **no speaker-by-speaker dialogue** — so it does not touch the
  episode reader and does not close `wikigg-gaps.md` §1/§2 (those want line-by-line scripts).
  Current output: **24 stories** — main-story **Chapters 6-10** plus **19 events**. Chapter scope is
  deliberate (Worlds 1-5 already have full wiki.gg episodes, a bare summary would be a downgrade; and
  namu's article stops at Chapter 10 — Korean/global never reached Worlds 11-12). Events are matched
  by a hand-verified `EVENT_TITLE_MAP` (namu's MT event name → our eventID slug, checked against the
  zh + English titles); the genuinely ambiguous ones (`Black Lightning's Waste Dragon`, bare
  `advent subjugation`, `betrothal to you`) and the events newer than namu's page are **reported, not
  guessed**, and two namu sections that are empty upstream drop out on their own.
- **Double machine-translated + CC BY-NC-SA.** The text is JP game → Korean namu → English MT proxy,
  and namu.wiki is CC BY-**NC**-SA (an NC clause, stricter than wiki.gg's CC BY-SA) — both facts are
  stamped in the output (`machineTranslated`, `license`) and surfaced in that UI notice; each record
  keeps its `sourceUrl`.
- **Fetch is decoupled from parse, because namu is often unreachable.** From a mainland-China
  network the TLS handshake is frequently reset; `politeFetch`'s retries usually get through
  eventually, and the raw HTML caches under `scripts/.namu-cache/` (gitignored) so re-runs are
  offline and byte-stable. If the live fetch can't connect at all, drop a browser-saved copy of the
  page at the cache path the report prints and re-run — the parser reads cache identically.
- **Parsing survives namu's hashed classes.** Section `<h#>` headings carry an outline number
  ("2.7. Chapter 6 …"); each chapter's recap is the sibling `<div>`(s) up to the next heading
  (`$(h).nextUntil('h1..h6')`). `cleanSummary` strips namu's fold/unfold toggle labels
  ("[ View skip content ]") and escaped `<img>` markup, then splits the recap into one paragraph per
  in-game episode (`"1-1 <title>- <body>"`). Same byte-stable `writeJsonIfChanged` / R2-invalidation
  rules as the other pipelines; report is `_namu_summary_report.md`. `summary_en.json` ships to R2
  under the existing `story/` include prefix — no `upload-to-r2.mjs` change needed.

## miaowm5 pipeline (worldflipper.miaowm5.com)

miaowm5 is an open-source Svelte SPA (github.com/miaowm5/wf-encyclopedia) serving structured JSON
from public CDNs, keyed by `devName` — the same key `roster.json` uses, so matching is exact.
**No HTML scraping**: `scripts/fetch-miaowm5.mjs` fetches the site's own JSON and decodes it with
ports of the site's parsing logic (`scripts/lib/miaowm5-common.mjs` for CDNs/atlas/canvas helpers,
`scripts/lib/miaowm5-story.mjs` for the story decoders shared with the main-story pipeline). When
changing a decoder, check it against the upstream source, not the raw columns.

Four CDN hosts, and the alias names deliberately don't match the host numbers (that mapping is read
off the deployed bundle, so keep the names and values together in `miaowm5-common.mjs`): `CDN_A` =
cdn4 host (`res/*` atlases, `ui/`, header backgrounds), `CDN_B` = cdn host (pixel/head atlases,
`orb/`, `gallery/`), `CDN_C` = cdn2 host (`orderedmap/*` tables — `ORDEREDMAP`), `CDN_D` = cdn3 host
(`filelist.json` + the BGM mp3s it lists).

`npm run fetch:miaowm5` (flags: `--force`, `--limit=N`, `--only=devName,...`, `--new-chars`) is
resumable: HTTP responses cache under `scripts/.miaowm5-cache/` (gitignored), per-character
progress in `scripts/.miaowm5-manifest.json`. Cold full run ~60 min / ~1.2GB cache; a no-op re-run
takes seconds. `Character Assets/_miaowm5_report.md` lists roster characters missing from miaowm5.

**Three ID spaces — the main trap.** `devName` keys the roster/folders and
`character.json`/`pixel.json`; `gameId` keys `character_text`/`character_quest` (what
`encyclopedia[5]` points at); `storyId` (`character.json`'s `[8]`) keys `story_character` and the
pixel atlases. `storyId` usually equals `devName` but not always — never assume. (`head.png`'s
atlas is keyed by `devName`, upstream's own choice, not an inconsistency to "fix".)

**Owned-keys contract.** Inside `wiki_zh.json` the pipeline owns exactly `info`, `related`,
`emotions`, `pixelActions`, `storyCount`, `miaowm5Meta`, `voice[].textJp` — never the
bilibili-owned keys. It merges into the existing file (creating a skeleton with empty bilibili
fields for the ~6 characters bilibili never matched) and deletes keys that come out empty.

**`--new-chars` (roster-producing mode).** Default runs iterate `roster.json`; `--new-chars`
iterates `character.json` to bootstrap unknown characters — creates `rarityN/<devName>/`, runs the
same steps, appends a roster entry (`rarity` = row[2], `attribute` = row[3] via
Fire/Water/Thunder/Wind/Light/Dark). Only adds characters with **both** a pixel timeline and
`story_character` bust art, and skips the `700xxx` `gameId` block (engine-internal stubs/variants).
Idempotent — once in the roster, no longer "new". This yielded 108 characters; roster is 485.

**`bustOnly` characters.** Those 108 have no 1440x1920 full illustration anywhere — only the
570x690 story bust — so they carry `bustOnly: true` and the detail page uses the stacked bust as
hero art with the awaken toggle hidden. They also have **no `enName`/`jpName`** (miaowm5 is a
Chinese source) — only `zhName` from `character_text[gameId][0]`; the front-end falls back
`enName || zhName || devName`. (The community-sheet pipeline now supplies an English name and a
`jpName` for all but one of them, patched onto the roster entries at load time by `loadUnitsEn` —
`hasEnName` is what marks who may be renamed, since the fallback above already filled `enName`.) Three Black Clover collab characters have Japanese-script `zhName`s
because the game's own CN data left them untranslated.

**Per-character outputs** (beyond the `wiki_zh.json` keys):

- `story_zh.json` — full dialogue per episode (speaker, name-plate colour, emotion, text). Big, so
  the front-end fetches it only when the story panel opens (`loadStory()`), not in `goDetail()`.
- `emotion/*.png` — expression art as two 570x690 layers (`base_N.png` body + `<i>_<name>.png`
  face) that the front-end stacks.
- `head.png` — 212x212 framed portrait, a port of upstream's `headIcon.svelte` canvas composite
  with its exact offsets: portrait scaled to 184x184 at (14,14) inside `character_face_frame`,
  element badge scaled 61→48 at (154,10) in the frame's notch. Element index is `character.json`
  row[3], `0..5 → red/blue/yellow/green/white/black` — same order as `ATTRIBUTES`. No element →
  `character_face_empty_frame` (un-notched, no badge). Upstream also stamps a rarity strip at
  (0,177); **we deliberately skip it** — the Units grid draws rarity on the pedestal instead.
  The roster carries `hasHead` because partial runs may lack the file; callers fall back to the
  pixel `neutral.gif` rather than trusting the path.
- `story_heads/<devName>.png` + `story_heads.json` manifest (flat `devName → path` map) — the same
  framed portrait for story-only NPCs (Light, Stella, guild staff, bosses) who speak but aren't
  playable (~42 of them). `buildStoryHeads` runs after the per-character loop and scans every
  `story_zh.json` **off disk** for `speakerDev`s, so `--only`/`--limit` never shrinks the manifest.
  NPCs have no `character.json` row → element `-1` → un-notched empty frame. Unlike `icons/`,
  these live under `Character Assets/` and **do** go to R2 (in `upload-to-r2.mjs`'s include lists).
- missing pixel `*.gif` — extra actions beyond the shipped five + `special`
  (`into_coffin`/`ghost_raise`/`ghost_neutral`/`revive`, etc.). **`special` is a special case**:
  its frames live in a second atlas (`pixel_special`) and `pixel.json`'s timeline never references
  them; upstream synthesizes the entry with a 10000 frame-id offset and `buildPixelGifs` mirrors
  that. Characters below 4★ have no special frames — ~92 legitimately lack `special.gif`, that's
  the game's data. `pixelActions` lists what the folder actually holds so the UI never links a
  missing file. **Existing GIFs are left alone** — they came from an older upstream data revision;
  regenerating would change timings for no benefit.
- roster stamps: `race` (an array — can be `["Human","Beast"]`, row[4]) and `gender` (row[7]),
  driving the Units filter only. `gender` stays raw (`Male`/`Female`/`Unknown`/one-off `Ririi`);
  the front-end folds non-Male/Female into `Other`, as upstream does. Three entries with
  `thumb: null` are skipped by every mode and filtered out of the grid.

**`icons/*.png`** — the one output outside `Character Assets/`: shared UI chrome, committed to
git, served with the site, **never touched by the R2 pipeline** (don't call `invalidateR2` on
them; it resolves paths relative to `Character Assets/`). Same delete-before-regenerating rule.

- `rarity_{1..5}.png` — the game's rarity stars, drawn on grid pedestals and beside the detail
  name. Exported **without** upstream's dark background plate (deliberate — it muddied the
  pedestal's attribute colour). Art is a fixed 27px tall but widens with star count (29→128px), so
  the front-end sizes by height and lets width follow. The 5★ cyan accents are the game's art.
- `element_{0..5}.png` / `race_<Race>.png` (`buildFilterIcons`) — filter-chip badges, named by the
  *data* value (row[3] index, row[4] token) so the front-end builds paths straight from roster
  fields. Race chips use the sheet's `_medium2` variants, matching upstream's filter.
- `title_border_{left,right}.png` — section-heading flourishes. Upstream's sprite names are
  `wf_ui_flipper_border_left` and plain `wf_ui_flipper_border` (the right one) — renamed to spare
  the next reader that trap.
- `circle.png` — the magic-circle backdrop, written by `buildMagicCircle`: a standalone file on
  `CDN_A` (`ui/circle.png`), copied byte-for-byte, no atlas decoding.

## main-story pipeline (`scripts/fetch-main-story.mjs`)

`npm run fetch:story` (flags: `--force`, `--limit=N`, `--only=slug,...`, `--skip-bgm`) is the same
source and the same rules as above, but iterates **stories** rather than characters, so it's a
separate script with no per-target resume manifest — the disk cache + skip-if-exists are the resume
mechanism. It writes everything under `Character Assets/story/` (all of it ships to R2) and drives
the Story tab. Current scrape: 42 stories, ~18.5k dialogue lines, 708 BGM mp3s — **~970MB total,
~900MB of it BGM**, which is what `--skip-bgm` exists for (a metadata-only iteration takes ~1 min
against a warm cache; the mp3 pull is the slow part and the R2 storage cost).

Everything it needs is keyed off two tables: `encyclopedia.json` (story entries: `[4]` = 3 main /
4 event / 5 prologue, `[13]` picks the event's quest bucket, `[12]`/`[14]` the storyID, `[16]` the
header art, `[1]` the eventID) and `quest/normal_quest.json` (the episode list, `{title:[0],
desc:[1], path:[4]}`). Traps worth knowing:

- **`extra_quest.json` stories are a second list.** Upstream's /story page = encyclopedia stories
  (key order) **then** `advent_event_quest` **then** `story_event_single_quest`; it doesn't dedupe.
  Extras carry no encyclopedia info blocks, so they have **no info tab** and open on the episode
  list — that's upstream's own behaviour, not a gap. Their slugs are `extra_adv_<id>` /
  `extra_single_<id>`; encyclopedia stories use their `eventID` as the slug.
- **Episodes are stored per quest bucket, not per story** (`story/episodes/<qkey>/<id>/<n>.json`,
  `qkey` ∈ `main_quest|event_world|event_single|event_adv`), because an encyclopedia event and its
  extra-quest twin resolve to the same bucket+id and should share one set of files.
- **Prologue is the scenario decoder's special case.** `main_chapter_00` files store *one row per
  index key* instead of an array of rows; `buildStoryDialogs`'s `opts.special` wraps them (upstream
  does the same via `parse(config[path], true)`). Miss it and the prologue silently decodes empty.
  Both that flag and `opts.captureBgm` default **off** so the character pipeline's existing
  `story_zh.json` files stay byte-identical.
- **`equipment.json` is not double-wrapped** like `encyclopedia` — its value *is* the row array, so
  the chapter orb card is `equipment[100000+chapter][<firstIdx>]`, name `[1]` / desc `[5]`. Indexing
  one level deeper silently yields single characters of the first column.
- **BGM buckets** (ported from upstream's `music_list` handler): world tracks group by their top
  folder (`world_grass`), event tracks by `event/<id>/` (advent by the *third* segment). A story's
  tracks = `bgmRule.story[eventID] || [eventID]`, resolved against `world[ids[0]]` for main/prologue
  and concatenated `event[id]` for events. mp3 URL = `CDN_D + <filelist path>`.
- `bgmRule.json` / `extraGallery.json` are **fetched from the upstream repo** at scrape time
  (raw.githubusercontent, through the disk cache) rather than vendored — they gain entries with
  every new event.
- `category` (`main`/`event`/`collab`) is stamped per story for the Story tab's filter: main +
  prologue → `main`, eventID matching `/collabo?/i` → `collab`, else `event`. Verified against live
  data (all 8 collabs match, no regular event does); `CATEGORY_OVERRIDES` in the script is the
  escape hatch if a future event misclassifies.
- **Story-only NPC portraits are shared with the character pipeline.** `buildStoryHeads` /
  `collectStorySpeakers` live in `scripts/lib/miaowm5-story.mjs` and scan **both**
  `rarityN/*/story_zh.json` and `story/episodes/**/*.json` off disk, so whichever pipeline runs last
  writes the union and neither shrinks `story_heads.json` (61 NPCs currently). ~13% of story lines
  are spoken by devs with no sprite in the `head` atlas (`alk_smr21`, `stella_copy_name`, …) — the
  game's own data; they keep a plain name plate.

## music index (`scripts/build-music-index.mjs`)

`npm run build:music-index` derives `Character Assets/story/music_index.json` — the Music Room's
world-music album list (one album per story in `index.json` order: slug/title/category/banner plus
the detail's `bgm` copied verbatim; empty-bgm and missing-detail stories skipped) — from
`story/index.json` + `story/detail/*.json`. Local files only, no network; **re-run it after any
`fetch:story` run** or the index goes stale. Same byte-stable write + R2-manifest invalidation
rules as the fetchers, and the `story/` include prefix ships it to R2 automatically. The one
duplicated track (the anniversary countdown, in 5 albums) is legitimate album membership, not a
bug to dedupe.

## gallery index (`scripts/build-gallery-index.mjs`)

`npm run build:gallery-index` derives `Character Assets/story/gallery_index.json` + the
thumbnails under `story/thumbs/` — the Art tab's gallery wall — from `story/index.json` +
`story/detail/*.json`. Local files only, no network; **re-run it after any `fetch:story` run**
or the wall goes stale. The `story/` include prefix ships both to R2 automatically, so
`upload-to-r2.mjs` needs no change.

Output is a **flat** array of 64 rows (52 gallery images + 12 chapter orbs), in `index.json`
story order, each story's orb first and then its `gallery[]`:

```jsonc
{ "slug": "main_chapter_3", "title": "…", "category": "main", "kind": "main",
  "type": "gallery",                            // "gallery" | "orb"
  "path":  "story/gallery/main_chapter_3/0.png",
  "thumb": "story/thumbs/gallery/main_chapter_3/0.webp",
  "w": 1356, "h": 1920,
  "name": "…", "desc": "…" }                    // orb rows only; omitted, not nulled, otherwise
```

- **`w`/`h` are the whole point.** The front-end packs the wall into two masonry columns
  arithmetically and needs the dimensions before the first paint; nothing in the detail files
  carries them. (That the detail files are also 872 KB for 64 tiles is the lesser reason.)
- **Gallery order comes from the detail file's `gallery` array, never `readdir`** — a directory
  listing sorts lexicographically, so `event_1stanv` would come out `0, 1, 10, 2, 3, …`.
- `.jfif` files are plain JPEG (sharp reads them directly), and none of the 64 carry EXIF
  orientation, so there's no auto-orient step.
- Titles are stored in **Chinese**; the front-end resolves English through `arcTitleFor` at render
  time, which is why each row keeps `slug` *and* `title`. Orb `name`/`desc` exist only in Chinese —
  no source has an English orb.
- **Thumbnails are 440px webp q78** (~2.3 MB for all 64, against 55 MB of sources) and follow the
  composited-image rule: **present means done**, so a re-run writes nothing. **Changing the width
  or quality therefore means deleting `story/thumbs/` first**, or passing `--force`.
- Missing source files are warned and dropped from the index, not fatal; a missing detail file
  warns and skips the story. `writeJsonIfChanged` + `invalidateR2` on the JSON and on every
  thumbnail actually written, so a dry re-run is a zero-diff no-op.
- Flags: `--force` (regenerate existing thumbnails), `--no-thumbs` (index only).
- `sharp` is a declared devDependency for this script (it reads the dimensions and writes the
  thumbnails). It was already on disk as a transitive dep of wrangler; relying on that would have
  broken on the next `npm install`.


## X media index (`scripts/build-x-index.mjs`)

`npm run build:x-index` derives `X/gallery-dl/twitter/world_flipper/x_index.json` + the thumbnails
under `thumbs/` — the Art tab's **second** gallery wall, the official @world_flipper archive — from
the media files `gallery-dl` already downloaded. Local files only, no network.

**This pipeline has no scraper half in this repo.** The 1429 files were fetched with the standalone
`gallery-dl` binary and are just present on disk; re-scraping is a manual step, and re-running this
script afterwards indexes whatever is there.

```jsonc
{ "source": "x.com/world_flipper", "account": "world_flipper", "media": [
  { "file": "1765663775401836851_1.jpg", "thumb": "thumbs/1765663775401836851_1.webp",
    "w": 1447, "h": 2048, "ts": 1709750400000 },
  { "file": "1697085863463932311_1.mp4", "thumb": "thumbs/1697085863463932311_1.webp",
    "w": 1280, "h": 720, "ts": 1692787200000, "video": true }   // omitted, not nulled, on images
]}
```

- **A file's name is the entire record.** `gallery-dl` wrote no JSON sidecars, so there are no
  captions, titles, alt text or tags anywhere — only what `<tweetId>_<n>.<ext>` encodes. The
  snowflake id gives the post time (`Number((BigInt(id) >> 22n) + 1288834974657n)`) and the
  permalink; that is why the wall's tiles are captioned with a date and why the filter offers
  **year and media type** and nothing else. Don't go looking for a richer source: there isn't one
  short of re-scraping with metadata enabled.
- **One row per file, not per tweet** — the masonry packs files, and 70 tweets carry 2-4 images.
  `_1..._4` is the part number; the front-end derives the tweet id back out for the permalink.
- Sorted **`ts` descending, then part ascending**, at build time, so the front-end never sorts 1429
  rows and a multi-image tweet's parts stay adjacent and in posting order.
- **`w`/`h` are the whole point**, exactly as for the gallery index: the packer needs them before
  the first paint.
- **Videos are measured off their poster frame, and there is deliberately no `ffprobe`.**
  `ffprobe`'s `stream=width,height` is pre-rotation and ignores the `rotate` side data, so a rotated
  clip would get transposed `w`/`h` and a wrong-shaped tile; `ffmpeg` auto-rotates on decode, so
  decoding one frame and handing it to `sharp` is both correct and one subprocess fewer. The frame
  is taken at **1s, falling back to 0** — frame 0 of a promo clip is very often a black fade-in, and
  a black poster is indistinguishable from a broken tile.
- **Thumbnails are 440px webp q78**, same as the gallery index, and follow the composited-image
  rule: **present means done**. Changing width/quality means deleting `thumbs/` first, or `--force`.
- Unmeasurable files are warned and dropped rather than shipped — a `w` or `h` of 0 would make the
  packer divide by zero and hand the wall an `Infinity` column height.
- Flags: `--force`, `--no-thumbs`, `--limit=N` (dev; suppresses the index write), `--videos-only`
  (re-do just the 86 poster extractions; also suppresses the index write, since a video-only pass
  would otherwise drop every image row).
- **`invalidateR2` here keys on `'X/' + relative(X_DIR, …)`, not on `Character Assets/`.** Copying
  `build-gallery-index.mjs`'s version verbatim computes keys that match nothing in the manifest, so
  the re-upload silently never happens.
- `ffmpeg-static` is a declared devDependency for this script (~80 MB platform binary on install);
  `sharp` does the images and the resizing.

### Upload boundary (this one is a security boundary)

`upload-to-r2.mjs` collects **`X/gallery-dl/twitter/world_flipper/`**, not `X/`, and ships it under
an `X/` key prefix matching the front-end's `X_BASE`. The root is deep on purpose:
**`X/x.com_cookies.txt` is a live x.com session cookie jar** and `X/gallery-dl.exe` is a 24 MB
binary, both three levels above the collect root and therefore unreachable by construction. The
`_`-prefix rule that keeps `Weapons/`'s dev-only reports out would **not** have excluded either.
Two more locks back it up: an extension allow-list on this collector, and an assertion over the
whole file list that refuses any executable- or credential-shaped key from any collector. `X/` is
also gitignored in full.

`X/x_index.json` is rewritten in place under a stable key, so — like `roster.json` — it is in
`SHORT_CACHE_KEYS`: a 5-minute TTL and always re-uploaded, since the path-keyed manifest would
otherwise skip real content changes forever.
