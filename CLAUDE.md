# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page fan site ("World Flipper Museum & Archive") for browsing the mobile game World Flipper's
characters, art, story, and music. There is no build step, no bundler, and no test suite — it's static
HTML/JS served as-is (works directly via `file://` for local dev).

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
- Character-facing *content* (names, and any future skill/quote data) is intentionally **not** yet part of this
  table — `roster.json` only has `enName`/`jpName` today. If/when a `zhName` or per-language skill/quote fields
  are added (see `Character Assets/roster.json` below), follow the same flat suffix convention rather than
  nesting, to stay consistent with the existing `enName`/`jpName` fields.

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
`enName`, `jpName`, `rarity`, `attribute`, `thumb`, and an optional `music` array (mp3 filenames, only
present for the ~150 characters with matched BGM). Per-character folders (`rarityN/<devName>/`) hold the
actual art/GIFs (`neutral.gif`, `full_shot_1440_1920_{0,1}.png`, `walk_front.gif`, `kachidoki.gif`,
`walk_back.gif`, optional `special.gif`, `skill_ready.gif`) plus an optional `music/` subfolder holding
those mp3s. The detail view plays them via a persistent `this.audio = new Audio()` instance
(`toggleMusicTrack`/`stopMusic` in the component script), rendered as pill buttons next to Skill/Special
when `music.length > 0`.
