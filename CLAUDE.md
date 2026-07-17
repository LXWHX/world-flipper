# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A single-page fan site ("World Flipper Museum & Archive") for browsing the mobile game World
Flipper's characters, art, story, and music. No build step, no bundler, no tests — static HTML/JS
served as-is (works via `file://` for local dev). To sanity-check a change, open `index.html` in a
browser.

## Data pipelines (dev-only scripts)

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

### bilibili wiki pipeline (wiki.biligame.com)

`rarityN/<devName>/wiki_zh.json` + `voice/*.mp3` hold scraped text (basic info, skills, story,
evaluation, voice lines). Two steps: `npm run scrape:wiki-zh` (`scripts/scrape-wiki-zh.mjs`,
shared parsing in `scripts/lib/wiki-common.mjs`) crawls into `scripts/.wiki-scrape-cache/`
(gitignored, resumable); `npm run match:wiki-zh` (`scripts/match-wiki-to-roster.mjs`) matches
pages to `roster.json` by `jpName`, downloads voice mp3s, writes `wiki_zh.json`, and stamps
`hasWiki`/`voiceCount`/`zhName` on the roster (unmatched cases →
`Character Assets/_unmatched_wiki_report.md`). A future English source can follow the same shape,
matched by `enName` into `wiki_en.json`.

### miaowm5 pipeline (worldflipper.miaowm5.com)

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
`enName || zhName || devName`. Three Black Clover collab characters have Japanese-script `zhName`s
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

### main-story pipeline (`scripts/fetch-main-story.mjs`)

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

## Commands

- `npm run upload:assets` — uploads `Character Assets/` to Cloudflare R2 (`wf-assets`) via
  `scripts/upload-to-r2.mjs`. Needs `npx wrangler login` once (or `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID`). Ships only `roster.json`, `story_heads.json`, `rarityN/`,
  `story_heads/`, `story/` (see `INCLUDE_TOP_LEVEL`/`INCLUDE_DIR_PREFIX`); dev-only files are excluded.
  Resumes via `scripts/.r2-upload-manifest.json`; `--force` re-uploads everything.
- No lint/test/build commands exist.

## Architecture

### The `x-dc` template + `DCLogic` component pattern

`index.html` is authored for a small proprietary runtime ("omelette"/`dc-runtime`) whose compiled
output is `support.js` — **do not hand-edit `support.js`** (generated from `dc-runtime/src/*.ts`,
source not in this repo). `image-slot.js` is likewise scaffold for the authoring tool, inert at
runtime — not for feature edits.

- `<x-dc>...</x-dc>` is the view template: HTML/SVG plus `{{ expr }}` interpolation,
  `<sc-if value="{{ cond }}">` conditionals (`hint-placeholder-val` is an editor hint, not logic),
  and `onClick="{{ handler }}"` / `style-hover` / `style-active` bindings.
- The `<script type="text/x-dc" data-dc-script data-props="{...}">` block is real JS: one
  `class Component extends DCLogic` with `state`, `componentDidMount`, handlers, and
  `renderVals()` returning the flat object every `{{ }}` binding reads. **All view logic lives in
  `renderVals()`** — a new template binding means a new key in that object. `data-props`
  (entity-encoded JSON) is design-tool metadata and defines `this.props` defaults.

### Backgrounds: the magic circle

The backdrop is a port of miaowm5's `ui/magicCircle.svelte` — `icons/circle.png` on a 25s linear
spin over flat `#EAEAEA`. It replaced **every** blue surface and every transparency checkerboard
the site used to have; don't bring those back. CSS lives in the `<helmet>` block as `.wf-circle`
plus the `.wf-circle-dialog` variant (smaller, 60% opacity, lower). Three hosts: the card's screen
area (backdrop), the detail drawer, the filter dialog. The two art stages (GIF stage, expression
viewer) deliberately have none and stay flat `#F4F6F9`. If you touch this:

- **`z-index: -1` on `.wf-circle` is load-bearing** (upstream's value): above the host's
  background, behind its in-flow content. Every host needs its own stacking context
  (`position: relative; z-index: 0` or an existing z-index) or the circle vanishes behind the
  host — plus `overflow: hidden` to crop the circle's bottom half.
- **The translate is repeated inside both keyframes** — animating `rotate()` alone drops the
  centering and flings the circle off-screen. The two variants can't share a keyframe (50% vs 60%
  resting translate).
- The backdrop hangs off the screen area, not the card, so the opaque tab bar can't cover it.
- Visibility gaps are inherent: home island art and the detail hero cover it; the drawer's circle
  only surfaces at the expanded snap point.

### The fixed canvas: scaling and zoom

The whole app is authored against a fixed **430x860** reference canvas (`DESIGN_W`/`DESIGN_H`) —
fixed-pixel buttons, `clip-path` shapes and the roster grid all assume it. Rather than reflow per
device, `computeLayout()` scales the canvas uniformly to fit, the way a fixed-resolution game screen
fits itself to a window. Two modes:

- **fill** (phones: `vw <= 540` and the viewport at least as tall-aspect as the design) — `scale =
  vw/DESIGN_W`, card height `calc(100dvh / scale)`, no shadow. Edge to edge, no grey field.
- **card** (desktop, tablet, landscape, short SE-class phones) — the original contain fit,
  `min(vw/DESIGN_W, vh/DESIGN_H, 1)` at the design's 860px, floating on the grey field.

Traps:

- **Never read `visualViewport` here.** It's the *visual* viewport, so it shrinks as the user
  pinch-zooms in. Feeding it into the scale made the canvas shrink content away from the gesture
  while re-rendering the whole tree on every frame of it — that's what crashed mobile tabs. Use
  `innerWidth`/`innerHeight` (the layout viewport): immune to zoom, still tracks rotation and the
  URL bar. The resize handler is rAF-coalesced for the same reason — one re-render per frame.
- **fill can only ever make the card taller than 860, never shorter.** The card is a flex column
  whose `flex: 1` screen area absorbs extra height, but the content inside is fixed-height and
  clips rather than reflows (the roster grid is `repeat(5, 116px)` in an `overflow-y: hidden`
  scroller). That's the whole reason fill is gated on aspect rather than just width — a 375x667
  SE would fill to 765 design px of height and lose two rows.
- **Browser zoom is refused outright**, since it has nothing useful to do to a scaled canvas.
  `user-scalable=no, maximum-scale=1` covers Chrome/Android; iOS Safari ignores both, so the body's
  `touch-action: pan-x pan-y` and the `gesturestart`/`gesturechange`/`gestureend` preventDefault in
  `componentDidMount` are what actually refuse the pinch there. The body is `position: fixed` +
  `overflow: hidden` so the page itself can never scroll or rubber-band — every scroller in the app
  is an inner element.
- **`viewport-fit=cover` is deliberately absent.** With the canvas going edge to edge, covering the
  display would push the top bar under the notch and the tab bar under the home indicator. Without
  it the viewport *is* the safe area, which is exactly what fill should fill — no `env()` math,
  which wouldn't survive the canvas scale anyway.

### Single component, tab-based navigation

One `Component` instance; `state.tab` (`'home' | 'units' | 'story' | 'flip' | 'music' | 'arms' |
'art' | 'detail'`) drives `<sc-if>` visibility — no router. `go(tab)` switches; `this.sections`
holds per-tab metadata.

The **Units** tab fetches `roster.json` once (`componentDidMount`), **sorts** it (rarity desc,
then attribute in `ELEMENT_ORDER` = Fire/Water/Thunder/Wind/Light/Dark, then `devName` — the
file's own order is just append history), and paginates client-side (`ROSTER_BATCH` = 60 per
scroll batch via `handleRosterScroll`). `goDetail(c)` opens the per-character detail view.

`isSection` is the under-construction placeholder that still backs art/music/arms; `units`,
`detail`, `story` and `flip` are excluded from it because they have real screens.

The home screen's centre red button opens **`flip`**, not `units` — Units keeps its bottom-tab-bar
button and its menu entry, which is the only reason repointing it strands nothing.

#### Story tab (the story archive)

A port of miaowm5's `/story`, fed by the main-story pipeline above. Everything is `arc`-prefixed
(state, handlers, `renderVals` keys) so none of it collides with the **character sheet's own story
panel**, which is a different feature — read the prefix before assuming which one a key belongs to.

- **Navigation** is state, not a router: `arcStory` null = the banner list, set = the detail;
  `arcTab` (`info|story|gallery|bgm`) picks the panel; `arcEpisodeIndex` non-null = the reader
  rather than the episode list. Back goes reader → episodes → detail → list.
- **Three lazy fetch tiers**, each cached and each guarded against navigating away mid-flight:
  `story/index.json` once on first `go('story')`, `story/detail/<slug>.json` per story
  (`arcDetailCache`), one episode file per episode (`arcEpisodeCache`). Episode dialogue is the
  bulk of the data, so it never loads until an episode is actually opened.
- **Tab icons are the committed `icons/small-*.png`** (profile → info, story-book → episodes, book
  → gallery, speaker → BGM), *not* upstream's atlas sprites — a deliberate choice. Tabs render
  conditionally: no info tab without `desc` (extras), no gallery without orb/images, no BGM without
  tracks.
- **The reader has no "viewed character"**, so unlike the character sheet's dialogue rows every
  speaker resolves through `headUrlForSpeaker()` (roster `head.png` → `story_heads/` → plain name
  plate) and no emotion art is used. Both readers share that helper. The avatar is a rounded square,
  not a circle — `head.png`'s corner badge would be clipped.
- `{marker:'bgm'}` rows are filtered out of the reader (data-only for now, kept for a future
  "now playing" feature).
- **BGM plays through the same single `this.audio`** as the character theme pills, so the two can
  never overlap — which is why `go()`, `goDetail()` and `closeArcStory()` all stop it and clear
  `arcBgmPlaying`, and the `ended` handler clears both playing flags.
- The category chip row (全部/主线/活动/联动) filters on the `category` the pipeline stamps;
  single-select, `all` inert. `ARC_CATEGORIES` is the table.

#### Flip tab (弹弹) — art voting

A Tinder-style swipe deck over every illustration in the game: right = like, left = dislike, down =
skip, tap = open that character's sheet. All three are counted per illustration and shown on the
deck and on the detail hero. Backed by Supabase (`supabase-art-votes.sql`), not by any pipeline —
it reuses art that already ships.

- **The `flip` prefix is not decoration.** `artIndex`, `isArt`, `goArt`, `toggleArt`,
  `showArtToggle` and `artToggleLabel` all already exist and mean either the Art tab or the detail
  hero's awaken toggle. An unprefixed name in a feature *about* art voting would silently rewire
  one of them — same hazard the story archive's `arc` prefix exists for. The detail page's pills
  use `detailArt*`.
- **Every illustration is its own artwork**, keyed `art_key` = `<devName>:<variant>`, variant ∈
  `0` (base) | `1` (awakened) | `bust`. Base and awakened vote separately, so the detail pills
  track `state.artIndex` and swap when you hit the awaken toggle.
- **Deck size 855**, and the derivation matters because it's easy to get wrong: 485 roster entries
  − 3 with `thumb: null` (the front-end filters those before the deck ever sees them) − 108
  `bustOnly` = **374** base cards; **373** of those have awakened art; + **108** bust cards.
- **`NO_AWAKENED_ART`** is the 374-vs-373 difference: `ruin_girl_smr21` is the sole character with
  `full_shot_1440_1920_0.png` and no `_1`. `roster.json` has no field for it and the deck is built
  synchronously from the roster alone, so it's a front-end constant. It belongs beside `hasHead` as
  a roster stamp — promote it and delete the constant *if* the pipeline is ever re-run for another
  reason, but it isn't worth a re-run plus an R2 re-upload on its own.
- **bustOnly cards ride the same lazy `wiki_zh.json` fetch** the detail hero does (that file is
  where the `emotions[]` layer filenames live), cached per character in `flipEmotionCache` and
  never blocking — the card paints with the pixel `neutral.gif` it already has and swaps to the
  stacked bust when the fetch lands. The cache's in-flight `null` marker is load-bearing: without
  it every render during the fetch fires another one.
- `this.flipDeck` is an **instance field**, not state — 855 objects don't belong in a `setState`
  payload; `flipDeckVersion`/`flipWikiVersion` are what tell `renderVals` it moved. `go('flip')`
  can beat the roster fetch home, so `ensureFlipDeck()` is called from **both** and whichever runs
  second builds the deck.
- The gesture is the second consumer of the `sheetPointerDown` pattern (see the bottom sheet
  below) — **deltas divided by `state.scale`**, `touch-action: none` on the card. It additionally
  rAF-coalesces its `setState`, because `renderVals` rebuilds the roster tiles and story lists on
  every render regardless of tab and a card drag is much longer than a sheet drag. It does *not*
  need `handleUnitsWheel`'s document-level listener — that exists only for `preventDefault` on
  wheel.
- **The card swap has no entrance animation, by design, and that takes work.** The card element is
  *reused* across the swap, so left alone its transform would animate from the fly-out position
  back to centre — the next card would slide in from off screen, when it's already on screen
  underneath. `flipSnap` suppresses the transition for one frame and lands the card on the peek's
  exact transform; `flipRising` then covers the frames after, where it rises off the peek into
  place (`FLIP_RISE_MS`, shorter than `FLIP_FLY_MS` — a 10px rise paced like a 620px fly-out feels
  like a stall). Two traps: the flag is cleared on a **double** rAF, because with one rAF both DOM
  writes can land before a single style recalc and the browser animates the very thing the flag
  exists to prevent; and the peek's transform is built from `FLIP_PEEK_Y`/`FLIP_PEEK_SCALE` in the
  same **translate-then-scale order** as the live card's, because the swap frame stacks them
  pixel-for-pixel and any mismatch shows up as a jump.
- Each drag stamp (♥/✕/↓) sits **opposite** the direction it commits — right-swipe puts ♥ on the
  left, down-swipe puts ↓ on top — so the stamp trails the card off screen instead of leading it
  out of view.
- The deck is **shuffled per session and never filters out already-voted cards** — votes are
  changeable, so hiding them would make a vote unreachable to change. End of deck offers a reshuffle.
- Votes are **optimistic locally** (`-1` from the old bucket, `+1` to the new) so the count is
  right before the card finishes flying out. Re-voting the same way nets to zero, which matches
  `vote_art`'s own `if prev is distinct from v` no-op — the two sides agree by construction.
- **The detail page is display-only.** Voting happens on the Flip screen.
- Tapping a card opens the character sheet, and **Back returns to the deck on the same card** —
  `state.detailReturnTab`, set by `goDetail` from whichever tab you came in on (`backFromDetail`
  used to hardcode `units`). The deck position needs no saving or restoring: `flipDeck` is an
  instance field and `flipIndex` is plain state, so nothing resets and nothing is rebuilt. Note a
  related-character chip navigates detail → detail, so `goDetail` keeps the existing
  `detailReturnTab` in that case rather than recording `'detail'`; everything that isn't Flip still
  goes back to the Units grid.

#### Units filter

A port of miaowm5's `dialog/filterCharacter.svelte` (round `icons/filer.jpg` button, top-left).
Five groups — name, rarity, element, gender, race — OR within a group, AND across groups, empty
group inert ("nothing picked" = "show everything"). Notes:

- Upstream's rarity-"Other" and element-"Other" NPC chips are deliberately dropped — this roster
  is characters only, they'd match nothing.
- Rarity chips are stars-only (no number label); the label survives as the `img`'s `alt`, which is
  what a screen reader/test should select on (the grid tile uses a different alt format, `5★`).
- Chip `box-shadow: 1px 1px 5px rgba(0,0,0,0.3)` isn't arbitrary: upstream's chips are `<button>`s
  shadowed by its `reset.css`; ours are `<div>`s, so without it a `#fafafa` chip vanishes into the
  `#fafafa` dialog.
- Four race labels differ from their data key (upstream's own i18n, copied verbatim): `Element`→
  "Elf", `Devil`→"Demon", `Mystery`→"Fairy", `Plants`→"Plant". `FILTER_RACES` values stay the raw
  tokens because that's what `race` holds.
- `state.filter` is applied; `state.draftFilter` is the dialog's working copy (OK commits, Cancel
  discards). `cloneFilter()` copies the group arrays — a shallow spread would let the draft mutate
  the applied filter.
- `filteredRoster()` is the single source for both `renderVals` and `handleRosterScroll`, so
  pagination counts matches. Applying a filter resets `visibleCount`.
- The button (38px circle at 4,66) is wedged into the only free gap between the banner icon
  (ends y=68) and the first tile (starts y=101, portrait from x=38). Moving or growing it collides.

#### Units grid tile

Note `backFromDetail()` returns to `state.detailReturnTab` (Units or Flip), not unconditionally to
Units — see the Flip section above.

Mimics the game's party screen in an 82x100 box: framed `head.png` on top, pixel `neutral.gif` on
a pedestal built from two CSS shapes (elliptical top face + `clip-path` trapezoid body) tinted by
attribute via `PEDESTAL`, with `icons/rarity_{N}.png` centred on the body. Coupled numbers:

- The sprite's `bottom` puts its feet on the ellipse's centre line — resize the pedestal and the
  offset must move too.
- Stars are sized by height so width follows rarity (33px at 5★). They must fit the trapezoid's
  narrow bottom edge (~37px at the current 52px width / `14%/86%` clip) — 5★ overhangs first.
- Row height (116px) is tuned against the scroller's 622px with ~10px slack; growing the tile
  means shrinking something else.

#### Character detail bottom sheet

The sheet (`SHEET_HEIGHT` = 620px) splits into a fixed top strip (drag handle + name/star row,
carrying `sheetPointerDown` and `touch-action: none`) and a `flex: 1; overflow-y: auto` body —
that split is what keeps native touch scrolling working in the body. Dragging snaps between
`SHEET_EXPANDED_Y`/`MID`/`COLLAPSED`; past the visible height, the body's own scroll reveals
content.

`sheetPointerDown` is now the reference for a **convention rather than a one-off** — the Flip
deck's `flipPointerDown` follows it. Window-level `pointermove`/`pointerup` (so the gesture
survives the pointer leaving the element), **deltas divided by `state.scale`** (the whole 430px
canvas is CSS-scaled, so raw client px drift from the finger), `touch-action: none` on the drag
surface, and `dragging ? 'none' : 'transform …'` for the transition.

**Panel switcher.** Four round icon buttons float above the sheet's top-right corner as a
*sibling* of the sheet div, sharing `sheetTransform`/`sheetTransition` so they track the drag
without joining its layout. `state.sheetPanel` (via `setSheetPanel()`) picks the body content:

- **profile** — GIF stage, Skill/Special buttons + `extraActionButtons` pills, theme-music pills,
  expression viewer (`hasEmotions`), and wiki text sections gated by `hasWikiInfoRows` /
  `hasWikiSkills` / `hasWikiStory` / `hasWikiReview` (encyclopedia `info` renders under the story
  intro, so `hasWikiStory` accounts for it too).
- **voice** — voice-line list with Japanese `textJp` sub-text; `hasNoVoiceTracks` empty state.
- **story** — episode list → dialogue (`storyIndex` picks `showStoryList` / `showStoryDetail` /
  `showStoryEmpty`). The only lazy-fetching panel (`loadStory()`, once per character, guarded
  against navigating away mid-flight).
- **related** — related-character chips (click → `goDetail` via `rosterByDev`; no roster match
  gets a placeholder tile) and keyword cards.

**Story dialogue avatars** resolve in three tiers: (1) the viewed character speaks in their own
expression art (keyed on exported `emotions[]`); (2) other roster speakers use their `head.png`
via `rosterByDev` — `speakerDev` is a `storyId` but agrees with `devName` for all 485 entries;
(3) story-only NPCs use `story_heads/` via the `this.storyHeads` map from `story_heads.json`
(fetched once in `componentDidMount`, independent of the roster; the front-end trusts the manifest,
never the bare path). Anything left keeps the plain name plate. The avatar box is a rounded square,
not a circle — a circle would clip `head.png`'s corner badge.

**Hero art.** Normally `full_shot_1440_1920_{0,1}.png` with the awaken toggle. `bustOnly`
characters get the stacked 570x690 bust (`showBustHero`, `normal` face) with the toggle hidden
(`showArtToggle`). The bust rides the lazy `wiki_zh.json` fetch, so the hero paints a beat late.

#### Emotion layers (faces vs. overlays)

`story_zh.json`'s `emotion` is a **comma-separated layer stack** (e.g. `"normal,sweat"` — face,
then overlay, over the shared `base_N.png`). ~7% of lines carry an overlay, so resolving `emotion`
as a single name silently loses their art; `resolveEmotionStack()` splits and draws every front in
order. `isEmotionOverlay()` splits `emotions[]` into faces (the prev/next cycler) and overlays
(the "Add-ons" toggle chips, `state.emotionOverlays`). **Classification comes from the game's own
data, not sprite art**: every token seen trailing in any `story_zh.json` is an overlay, sharing
the roots in `EMOTION_OVERLAY_ROOTS`. Traps:

- Sprite size does *not* identify an overlay (`shame` can cover as much canvas as a face).
- The root rule over-reaches: `tear_b`/`tear_c` are whole faces; `EMOTION_FACE_NAMES` pins them
  back. Check trailing-token usage before adding a root.

Overlays are offered only when they share the current face's `base` (mirrored art ships each
twice, e.g. `shame` on base_0 / `shame_right` on base_1); toggles key on the un-mirrored name
(`emotionOverlayKey()`) so flipping faces keeps the accessory on, while distinct variants stay
separate keys.

### UI localization (`STRINGS` table)

UI chrome is bilingual (en/zh), all in the `data-dc-script` block: `STRINGS` is a flat
`{ key: { en, zh } }` table; `state.lang` persists to `localStorage` (`wf_lang`) via
`loadLang()`/`toggleLang()`; `this.t(key)` resolves (falls back to `en`). **No hardcoded
user-facing text remains in the `<x-dc>` template** — new UI copy means a `STRINGS` entry + a
`renderVals()` binding. `this.sections` is a getter so it re-resolves through `t()` per render.
Character *content* stays outside the table; the one exception is the display name (`zhName` over
`enName` when `state.lang === 'zh'`). Future per-language content fields should follow the flat
suffix convention (`enName`/`jpName`/`zhName`), not nesting.

### Asset loading: local vs. R2

`ASSET_BASE` switches on how the page is served: `file://`/`localhost` → local
`Character Assets/`; anything else → the public Cloudflare R2 bucket. **Check both branches when
changing asset references.** `Character Assets/`, `WF OST/`, and `node_modules/` are gitignored;
only `roster.json`, `story_heads.json`, `rarityN/*`, `story_heads/*`, and `story/*` reach R2 — any
new asset type must be added to `upload-to-r2.mjs`'s include rules or it silently never ships.
Every path inside `story/index.json` and `story/detail/*.json` is stored relative to
`Character Assets/` (i.e. it mirrors the R2 key), so `ASSET_BASE + '/' + p` resolves on both
branches with no per-branch special-casing.

`roster.json` entries carry `devName`, `enName`, `jpName`, `rarity`, `attribute`, `thumb`,
optional `music` (mp3 filenames, ~150 characters), `hasHead` (the `head.png` URL is derived from
`thumb`'s path, not stored), `race`/`gender`, and — for wiki-matched characters —
`zhName`/`hasWiki`/`voiceCount`; `--new-chars` entries carry `bustOnly: true` instead (see above).
Per-character folders (`rarityN/<devName>/`) hold the GIFs/art, optional `music/`, and the
pipeline outputs (`wiki_zh.json`, `voice/`, `story_zh.json`, `emotion/`). Music plays through one
persistent `this.audio = new Audio()` (`toggleMusicTrack`/`stopMusic`), rendered as pill buttons
when `music.length > 0`.

### Supabase (visit counters + art votes)

Two features, one project, one anon key, one set of helpers — and **nothing to do with R2**: no
Supabase path ever touches `Character Assets/` or the upload pipeline. Config lives in
`SUPABASE_URL`/`SUPABASE_ANON_KEY` next to `ASSET_BASE`. There is no supabase-js dependency; every
call is a raw `fetch` POST to `/rest/v1/rpc/<name>` through `supabaseRpc()`.

Each feature has its own run-once setup file, and both take the **same security posture**: tables
with RLS enabled and **zero policies** (so nothing is directly readable or writable), and the anon
role granted EXECUTE on only the SECURITY DEFINER functions, each pinned with
`set search_path = public`. That is the whole reason the anon key is safe to ship.

- `supabase-visit-counter.sql` → `record_visit(vid)`. The two top-right pills (`icons/Mana.png` =
  total page views, `icons/Lodestar_Bead.png` = unique visitors). `recordVisit()` fires once in
  `componentDidMount`; the RPC bumps PV, upserts the visitor id and returns `{pv, uv}`, which
  `renderVals` formats into `pvCount`/`uvCount` (a dash until it resolves). **No IP is ever read**
  (a browser can't, and it'd miscount shared/rotating IPs anyway).
- `supabase-art-votes.sql` → `vote_art(vid, akey, v)` + `art_stats_all(vid)`, backing the Flip tab
  (see above). `art_stats_all` returns **every** artwork's counts in one ~35KB call, cached in
  `state.flipStats` and shared by the deck and the detail hero — per-key reads would leave the pill
  blank under the user's thumb on every swipe. Two tables: per-visitor vote rows plus a
  denormalized aggregate that only `vote_art` writes, in one transaction under a row lock, so they
  can't drift. Note the RPC parameter is `akey`, not `art_key` — a parameter sharing a column's
  name makes every unqualified reference in the body ambiguous.

**Shared helpers**: `visitorId()` (the memoized `wf_visitor_id` uuid — both features key on the
same id, which is what makes reloads dedupe to one visitor and one vote per artwork stick),
`supabaseRpc()`, `supabaseConfigured()` (false while `SUPABASE_URL` holds its `YOUR_PROJECT`
placeholder, so the site works un-wired — pills just show a dash), and `supabaseWritable()`.

**Reads and writes are deliberately asymmetric on local dev**: `supabaseWritable()` is false on
`file://`/`localhost` so dev reloads never inflate PV and test swipes never reach the live vote
counts — but **reads aren't gated**, because seeing the real numbers locally is harmless and is
what makes the Flip deck developable at all. To exercise voting end-to-end you have to serve the
page from a non-localhost origin.

**Threat model, stated once**: the anon key is in the page, so anyone can POST `vote_art` with a
fabricated `vid`. These counts are a for-fun signal, not a poll. That's the exposure
`record_visit` already carried; the `(visitor_id, art_key)` primary key still caps one row per
claimed identity.
