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
(`'profile' | 'voice'`, via `setSheetPanel()`) toggles which body content renders: `showProfilePanel`
gates the stage/skill-buttons/music/wiki-info-skills-story-evaluation content (the small-profile
icon), and `showVoicePanel` gates a separate voice-lines list — moved out of the wiki block into its
own panel — with an empty-state fallback (`hasNoVoiceTracks`) when a character has no `wiki_zh.json`
voice data (the small-speaker icon). The story-book and book icons are wired to no-op handlers and
rendered at reduced opacity — reserved for a future character-story panel and a future
related-characters/keywords panel, following the same `sheetPanel` + gated-render pattern.

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
`walk_back.gif`, optional `special.gif`, `skill_ready.gif`) plus an optional `music/` subfolder holding
those mp3s. The detail view plays them via a persistent `this.audio = new Audio()` instance
(`toggleMusicTrack`/`stopMusic` in the component script), rendered as pill buttons next to Skill/Special
when `music.length > 0`.
