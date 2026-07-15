# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page fan site ("World Flipper Museum & Archive") for browsing the mobile game World Flipper's
characters, art, story, and music. There is no build step, no bundler, and no test suite — it's static
HTML/JS served as-is (works directly via `file://` for local dev).

## Wiki data pipeline (bilibili biligame Chinese wiki)

`Character Assets/rarityN/<devName>/wiki_zh.json` (+ sibling `voice/*.mp3`) holds text data
(basic info, skills, story, evaluation, voice lines) scraped from `wiki.biligame.com`. Dev-only,
three-step pipeline: `npm run scrape:wiki-zh` (`scripts/scrape-wiki-zh.mjs` + shared parsing in
`scripts/lib/wiki-common.mjs`) crawls the wiki into `scripts/.wiki-scrape-cache/` (gitignored,
resumable); `npm run match:wiki-zh` (`scripts/match-wiki-to-roster.mjs`) matches pages to
`roster.json` by `jpName`, downloads voice mp3s, writes `wiki_zh.json`, and stamps
`hasWiki`/`voiceCount`/`zhName` (from the wiki's `basicInfo.chineseName`) on `roster.json`
(unmatched/ambiguous cases go to `Character Assets/_unmatched_wiki_report.md`); `index.html`'s
`goDetail(c)` lazily fetches `wiki_zh.json` per character (not folded into the eager `roster.json`
load) and renders it inline in the character detail sheet, below the Skill/Special GIF-preview
buttons (see "Character detail bottom sheet" below), reusing the music-player pattern for voice
playback. A future English wiki source can follow the same shape, matched by `enName` into a
parallel `wiki_en.json`.

## miaowm5 data pipeline (worldflipper.miaowm5.com)

Second data source, layered on top of the bilibili data. worldflipper.miaowm5.com is an open-source
Svelte SPA (github.com/miaowm5/wf-encyclopedia) that serves all its data as structured JSON from
public CDNs, keyed by the game's internal `devName` — the same key `roster.json` uses, so matching is
exact and needs no fuzzy `jpName` logic. There is **no HTML scraping**: `scripts/fetch-miaowm5.mjs`
fetches the same JSON the site does and decodes it with ports of the site's own parsing logic
(`scripts/lib/miaowm5-common.mjs`). When changing a decoder, check it against the upstream source
rather than reverse-engineering the raw columns.

`npm run fetch:miaowm5` (flags: `--force`, `--limit=N`, `--only=devName,...`) is dev-only and
resumable: every HTTP response is disk-cached under `scripts/.miaowm5-cache/` (gitignored) keyed by
URL path, and per-character progress lands in `scripts/.miaowm5-manifest.json`. A cold full run takes
~60 min (it decodes ~180 atlas pages and encodes ~1400 GIFs) and needs ~1.2GB of cache on disk; a
no-op re-run takes seconds, because every step checks for its output file before decoding anything.

**Three ID spaces — the main trap.** `devName` is the roster/folder key (and the key for
`character.json`/`pixel.json`); `gameId` keys `character_text`/`character_quest` and is what
`encyclopedia[5]` points at; `storyId` (= `character.json`'s `[8]`) keys `story_character` and the
pixel atlases. `storyId` usually equals `devName`, but not always — never assume.

**Owned-keys contract.** The pipeline owns exactly `info`, `related`, `emotions`, `pixelActions`,
`storyCount`, `miaowm5Meta` and `voice[].textJp` inside `wiki_zh.json`, and never touches the
bilibili-owned keys. It merges into the existing file (creating a minimal skeleton with empty
bilibili fields for the ~6 roster characters the bilibili pipeline never matched, so the front-end
needs no special-casing), and deletes any key whose value comes out empty. All writes go through
`writeIfChanged`/`writeJsonIfChanged`, so a re-run is byte-stable and produces zero diff — keep it
that way. That's also why `story_zh.json`'s `generatedAt` is preserved unless the payload actually
changes, and why nothing carries a per-run `fetchedAt`: a fresh timestamp every run would rewrite
~370 files and force a full R2 re-upload.

What it produces per character, beyond the `wiki_zh.json` keys:
- `story_zh.json` — full dialogue for every character episode (speaker, name-plate colour, emotion,
  text). Much bigger than the other files, so `index.html` only fetches it when the story panel is
  opened (`loadStory()`), not in `goDetail()`.
- `emotion/*.png` — expression art as two 570x690 layers (`base_N.png` body + `<i>_<name>.png` face)
  that the front-end stacks, rather than one flattened composite per expression.
- missing pixel `*.gif` — the site already ships 5 actions + `special`; miaowm5's pixel timeline
  usually also has `into_coffin`/`ghost_raise`/`ghost_neutral`/`revive` (and a few characters have
  many more). `pixelActions` lists what the folder actually holds, so the UI never links a missing
  file. Existing GIFs are left alone: they were exported from an older revision of the upstream
  pixel data, so regenerating them would change timings for no benefit.

Because any rewritten file must be re-uploaded, the script drops that file's key from
`scripts/.r2-upload-manifest.json` (which `upload-to-r2.mjs` uses to skip already-uploaded paths)
instead of teaching that script about content hashes. `Character Assets/_miaowm5_report.md` lists
roster characters absent from miaowm5's data.

## Commands

- `npm run upload:assets` — uploads `Character Assets/` to the Cloudflare R2 bucket (`wf-assets`) via
  `scripts/upload-to-r2.mjs`. Requires `npx wrangler login` once (or `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` env vars). Only ships `roster.json` and `rarityN/` folders — dev-only files
  (`*.ps1`, `*_log.txt`, `metadata.json`, `_unmatched_music/`, reports) are intentionally excluded, see
  `INCLUDE_TOP_LEVEL`/`INCLUDE_DIR_PREFIX` in that script. Uploads resume via
  `scripts/.r2-upload-manifest.json`; pass `--force` to re-upload everything.
- No lint/test/build commands exist. To sanity-check a change, open `index.html` directly in a browser.

## Architecture

### The `x-dc` template + `DCLogic` component pattern

`index.html` is not plain HTML — it's authored for a small proprietary runtime ("omelette"/`dc-runtime`),
whose compiled output is `support.js` (see its header: **generated from `dc-runtime/src/*.ts`, do not hand-edit**
— the source project isn't part of this repo). The pattern:

- Everything inside `<x-dc>...</x-dc>` is the view template. It's plain HTML/SVG with a small binding
  syntax layered on top:
  - `{{ expr }}` interpolates a value from the component's render output (e.g. `background: {{ tabBgUnits }}`).
  - `<sc-if value="{{ isHome }}" hint-placeholder-val="{{ true }}">` is conditional rendering; the
    `hint-placeholder-val` is only an editor/preview hint, not runtime logic.
  - `onClick="{{ handlerName }}"`, `style-hover="..."`, `style-active="..."` bind events/pseudostates.
- The `<script type="text/x-dc" data-dc-script data-props="{...}">` block at the bottom of `index.html`
  is real JS: a single `class Component extends DCLogic` with `state`, lifecycle methods
  (`componentDidMount`), event handlers, and a `renderVals()` method that returns the flat object of
  everything the template's `{{ }}` bindings reference. **All view logic lives in `renderVals()`** — if
  you need a new template binding, add it to the object this method returns.
  - `data-props` (HTML-entity-encoded JSON) declares the component's editable props (`accent`,
    `showCounters`, etc.) with editor metadata (`editor`, `default`, `options`, `section`) — this is
    metadata for whatever design tool authored this file, and also defines `this.props` defaults.
- `image-slot.js` defines a `<image-slot>` web component for drag-and-drop image placeholders in that
  same design-tool environment; it's read-only/inert outside that tool (see the file's header doc
  comment) and isn't part of this site's actual runtime behavior — currently only referenced for its
  script tag, not used in the visible UI.

**Do not hand-edit `support.js`** — regenerate it from the `dc-runtime` project if it ever needs to change.
Treat `image-slot.js` similarly (scaffold file, not meant for feature edits).

### Single component, tab-based navigation

There's one `Component` instance for the whole app. `this.state.tab` (`'home' | 'units' | 'story' | 'music'
| 'arms' | 'art' | 'detail'`) drives which `<sc-if>` block is visible — there's no router. `go(tab)` switches
tabs; `this.sections` holds per-tab label/description/color metadata.

The **Characters (`units`)** tab is the most complex: it fetches `roster.json` once
(`componentDidMount`), paginates it client-side (`ROSTER_BATCH` = 60 per scroll-triggered batch via
`handleRosterScroll`), and `goDetail(c)` navigates to a per-character `detail` view that probes for an
optional `special.gif` asset and drives GIF/PNG art switching, a draggable bottom sheet
(`sheetPointerDown`, snapping between `SHEET_EXPANDED_Y`/`MID`/`COLLAPSED`), and skill/special overlay
toggles.

#### Character detail bottom sheet

The sheet (`SHEET_HEIGHT` = 620px) is split into two parts: a fixed, non-scrolling top strip (drag
handle + name/star row) that carries the `onPointerDown="{{ sheetPointerDown }}"` drag behavior, and
a `flex: 1; overflow-y: auto` body below it holding everything else — the platform GIF stage,
Skill/Special preview buttons, theme music pills, and the wiki data sections (profile/skills/
story/evaluation), gated individually by `hasWikiInfoRows` / `hasWikiSkills` / `hasWikiStory` /
`hasWikiReview`. Splitting the drag handle from the scrollable body matters: `touch-action: none`
only applies to the handle strip, so native touch scrolling still works inside the body. Dragging
still snaps between three `sheetY` offsets (`SHEET_EXPANDED_Y` / `MID` / `COLLAPSED`), but at any
snap point the body's own scroll — not the drag gesture — is what reveals content past the visible
height.

**Panel switcher row.** A row of four round icon buttons (`icons/small-{profile,speaker,story-book,
book}.png`) floats above the sheet's top-right corner as a sibling of the sheet `<div>` (not nested
inside it), sharing the sheet's `sheetTransform`/`sheetTransition` so it visually tracks the sheet
while dragging without being part of its flex layout or scroll area. `state.sheetPanel`
(`'profile' | 'voice' | 'story' | 'related'`, via `setSheetPanel()`) toggles which body content
renders — one `sc-if`-gated block per panel:

- **profile** (small-profile) — `showProfilePanel`: the stage, Skill/Special buttons plus the
  `extraActionButtons` pills for miaowm5's extra pixel actions, theme music pills, the expression
  viewer (`hasEmotions`, stacked 570x690 layers with prev/next — see "Emotion layers" below), and
  the wiki text sections
  (gated individually by `hasWikiInfoRows` / `hasWikiSkills` / `hasWikiStory` / `hasWikiReview`).
  The encyclopedia `info` blocks render under the character-story intro, so `hasWikiStory` also
  accounts for them — a character with no bilibili story can still have info.
- **voice** (small-speaker) — `showVoicePanel`: the voice-line list, with each battle line's
  Japanese `textJp` as grey sub-text, and an empty-state fallback (`hasNoVoiceTracks`).
- **story** (small-story-book) — `showStoryPanel`: episode list → full dialogue, with
  `storyIndex` deciding which (`showStoryList` / `showStoryDetail` / `showStoryEmpty`). This is the
  only panel that lazy-fetches (`loadStory()`, once per character, guarded against the user
  navigating away mid-flight).
- **related** (small-book) — `showRelatedPanel`: related-character chips (clicking one calls
  `goDetail` via the `rosterByDev` map; entries with no roster match get a placeholder tile) and
  keyword cards.

Emotion art only renders for the character being viewed and only for expressions the pipeline
exported, so story dialogue from other speakers falls back to a plain name plate.

#### Emotion layers (faces vs. overlays)

The game composites an expression as a **comma-separated layer stack**: `story_zh.json`'s `emotion`
is e.g. `"normal,sweat"` — the `normal` face, then the `sweat` overlay on top, both over the shared
`base_N.png` body. Roughly 7% of dialogue lines carry an overlay, so anything resolving `emotion` as
a single name silently loses their art; `renderVals()`'s `resolveEmotionStack()` splits on the comma
and draws every front in order (`sd.emotionFronts`).

Overlay sprites are partial art (a blush, a sweat drop, glasses, an earring) with no features of
their own, so `isEmotionOverlay()` splits `emotions[]` into two groups: faces feed the prev/next
cycler, overlays render as the "Add-ons" toggle chips (`state.emotionOverlays`) that stack onto the
current face. **The classification is derived from the game's own data, not from the sprite art** —
every token seen in a trailing position across all `story_zh.json` files is an overlay, and they all
share the roots in `EMOTION_OVERLAY_ROOTS`. Two traps if you touch this:

- Sprite size does *not* identify an overlay. `shame` is a blush for every character, but for many
  it covers as much of the canvas as their face art does, so a coverage heuristic misclassifies it.
- The root rule over-reaches: `tear_b`/`tear_c` are whole faces despite the `tear` root, so
  `EMOTION_FACE_NAMES` pins them back. Check trailing-token usage before adding a root.

Overlays are offered only when they share the current face's `base`, since mirrored art ships each
one twice (`shame` on base_0, `shame_right` on base_1). Toggles are therefore keyed on the
un-mirrored name (`emotionOverlayKey()`) so flipping to the mirrored face keeps the accessory on;
distinct variants (`effect_rose` vs `effect_kirakira`, `shame` vs `shame_joy`) stay separate keys,
and where a root has several variants the chips fall back to raw names to stay distinguishable.

### UI localization (`STRINGS` table)

The site's UI chrome (nav labels, tab bar, buttons, status/error text, section titles) is bilingual
(English/Chinese). All of it is hardcoded in the `<script data-dc-script>` block, not in the template:

- `STRINGS` is a flat `{ key: { en: '...', zh: '...' } }` table defined above the `Component` class.
- `state.lang` (`'en' | 'zh'`) is read from/written to `localStorage` (`wf_lang`) via `loadLang()`/`toggleLang()`.
- `this.t(key)` looks up `STRINGS[key][this.state.lang]` (falls back to `en`). Every template string goes
  through `renderVals()` calling `t()` — **there is no hardcoded user-facing text left in the `<x-dc>` template**,
  so any new UI copy must be added as a `STRINGS` entry + a `renderVals()` binding, not typed directly into markup.
- `this.sections` (per-tab label/desc/color) is a getter, not a static field, so it re-resolves through `t()`
  on every render as the language changes.
- Character-facing *content* mostly stays outside this table — it's per-character data, not UI chrome.
  The one exception so far is the display name: `roster.json` entries with wiki data carry a `zhName`
  (see below), and both the Units grid and the detail screen pick `zhName` over `enName` when
  `state.lang === 'zh'` (falling back to `enName` for the ~9 characters with no wiki match). Any future
  per-language content field (skill/quote text, etc.) should follow the same flat suffix convention
  rather than nesting, to stay consistent with the existing `enName`/`jpName`/`zhName` fields.

### Asset loading: local vs. R2

`ASSET_BASE` in the component script switches based on how the page is served:
- `file://` or `localhost` → reads directly from the local `Character Assets/` folder.
- anything else (real deployment) → reads from the public Cloudflare R2 bucket URL.

This means asset-loading code paths differ between local testing and production — when changing how
character assets are referenced, check both branches. `Character Assets/`, `WF OST/`, and `node_modules/`
are all gitignored (large binary asset trees); only `roster.json` + `rarityN/*` get uploaded to R2, so any
new asset type added under `Character Assets/` needs to be added to `upload-to-r2.mjs`'s include rules
too, or it will silently never reach production.

`Character Assets/roster.json` is the character index driving the Units tab: each entry has `devName`,
`enName`, `jpName`, `rarity`, `attribute`, `thumb`, an optional `music` array (mp3 filenames, only
present for the ~150 characters with matched BGM), and — for the ~368 characters matched by the wiki
pipeline — `zhName`/`hasWiki`/`voiceCount` stamped by `scripts/match-wiki-to-roster.mjs`. Per-character
folders (`rarityN/<devName>/`) hold the
actual art/GIFs (`neutral.gif`, `full_shot_1440_1920_{0,1}.png`, `walk_front.gif`, `kachidoki.gif`,
`walk_back.gif`, optional `special.gif`, `skill_ready.gif`, plus any extra pixel actions generated by
the miaowm5 pipeline such as `into_coffin.gif`/`ghost_raise.gif`/`ghost_neutral.gif`/`revive.gif`),
an optional `music/` subfolder holding those mp3s, and — from the two data pipelines —
`wiki_zh.json`, `voice/*.mp3`, `story_zh.json` and `emotion/*.png`. The detail view plays music via a
persistent `this.audio = new Audio()` instance
(`toggleMusicTrack`/`stopMusic` in the component script), rendered as pill buttons next to Skill/Special
when `music.length > 0`.
