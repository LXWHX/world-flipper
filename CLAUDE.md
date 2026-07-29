# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A single-page fan site ("World Flipper Museum & Archive") for browsing the mobile game World
Flipper's characters, art, story, and music. No build step, no bundler, no tests — static HTML/JS
served as-is (works via `file://` for local dev). To sanity-check a change, open `index.html` in a
browser.

## Data pipelines (dev-only scripts)

抓取/生成管线的细节全部在 **`PIPELINES.md`** —— 动 `scripts/` 下的任何脚本、或改动
`Character Assets/` / `Weapons/` 的产物格式之前，先读那份文件。下面只是索引。

| 管线 | 命令 | 主要产物 |
| --- | --- | --- |
| bilibili wiki（中文文本） | `scrape:wiki-zh` + `match:wiki-zh` | `rarityN/<devName>/wiki_zh.json`、`voice/` |
| weapons（中文武器） | `scrape:weapons` | `Weapons/weapons.json`、`Weapons/icons/` |
| wiki.gg（英文） | `scrape:wiki-en` / `scrape:weapons-en` / `scrape:stories-en` | `wiki_en.json`、`story_en.json`、`Weapons/weapons_en.json`、`story/en/` |
| community sheet（英文名/视频） | `fetch:community-en` | `units_en.json`、`story/community_en.json` |
| eliya-bot GL（英文技能，补 bustOnly） | `fetch:eliya-gl` | `rarityN/<devName>/eliya_en.json`（60 个 `wiki_en.json` 缺失的角色） |
| namu.wiki（英文剧情简介，机翻） | `scrape:namu-en` | `story/en/summary_en.json`（主线 6-10 章 + 19 个活动的 info 面板简介） |
| miaowm5（美术 + 结构化数据） | `fetch:miaowm5` | 立绘/表情/像素 GIF、`head.png`、`story_heads/`、`icons/`、`wiki_zh.json` 的自有键 |
| main story（剧情 + BGM） | `fetch:story` | `story/`（约 970MB，其中约 900MB 是 BGM） |
| music index（本地派生，无网络） | `build:music-index` | `story/music_index.json`（每次 `fetch:story` 后必须重跑） |
| gallery index（本地派生，无网络） | `build:gallery-index` | `story/gallery_index.json` + `story/thumbs/`（同上，每次 `fetch:story` 后必须重跑） |
| X media index（本地派生，无网络） | `build:x-index` | `X/gallery-dl/twitter/world_flipper/x_index.json` + `thumbs/`（官方推特存档；抓取由独立的 `gallery-dl` 完成，本仓库只做索引） |

三条跨管线铁律（细节见 `PIPELINES.md`）：写入一律走 `writeIfChanged`/`writeJsonIfChanged`，
空跑零 diff；合成图片（`head.png`、`story_heads/`、`icons/`）存在即跳过，**改合成逻辑必须先删旧文件**；
文件重写时其 key 会从 `scripts/.r2-upload-manifest.json` 移除以触发 R2 重传。

## Commands

- `npm run upload:assets` — uploads `Character Assets/` to Cloudflare R2 (`wf-assets`) via
  `scripts/upload-to-r2.mjs`. Needs `npx wrangler login` once (or `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID`). Ships only `roster.json`, `story_heads.json`, `units_en.json`,
  `rarityN/`, `story_heads/`, `story/` (see `INCLUDE_TOP_LEVEL`/`INCLUDE_DIR_PREFIX`) **plus the top-level
  `Weapons/` folder under a `Weapons/` key prefix** (matching the front-end's `WEAPON_BASE`);
  dev-only files are excluded. Resumes via `scripts/.r2-upload-manifest.json`; `--force` re-uploads
  everything. **`Weapons/` has no include list** — the whole folder ships — so anything dev-only
  written in there must be `_`-prefixed, which the collector skips explicitly. (`Character Assets/`
  needs no such rule: its top level is an allow-list, so a stray file there is ignored by default.)
  It also ships **`X/gallery-dl/twitter/world_flipper/` under an `X/` key prefix** (matching
  `X_BASE`) — note the collect root is that deep folder, **not `X/`**, because `X/x.com_cookies.txt`
  is a live session cookie jar and `X/gallery-dl.exe` is a binary; see the upload-boundary note in
  `PIPELINES.md` before touching those rules. `--dry-run` prints the pending keys and total size
  without uploading. `SHORT_CACHE_KEYS` (`roster.json`, `X/x_index.json`) are the keys rewritten in
  place: 5-minute TTL and always re-uploaded, since the manifest is path-keyed.
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
scroll batch via `handleRosterScroll`). `goDetail(c)` opens the per-character detail view. What is
paged in is not what has its portrait loaded — see "Strip art window" below before touching either
strip's grid, its scroll handler or `restoreUnitsScroll`.

**Every tab now has a real screen.** The `isSection` under-construction placeholder (and its
`underConstruction*` / `backToHome` / `imageSlotPlaceholder` strings, the `sectionSlotId` val and
the `wfFloat` keyframe) was deleted when the art tab shipped its gallery wall — `art` was its last
consumer. `sections`/`sectionLabel`/`sectionDesc`/`sectionColor` stay: the real screens use them
for their banners. `image-slot.js` now has no `<image-slot>` in the template at all; the tag stays
because it's authoring-tool scaffold, inert at runtime.

The home screen's centre red button opens **`flip`**, not `units` — Units keeps its bottom-tab-bar
button and its menu entry, which is the only reason repointing it strands nothing.

#### Armaments tab (武器库 / 武器详情) — the weapon library

A port of the Units grid/filter over `Weapons/weapons.json` (see the weapons pipeline in `PIPELINES.md`).
Everything is **`arm`-prefixed** (state/handlers/`renderVals` keys) so none of it collides with the
Units roster/filter — same discipline the story archive's `arc` and Flip's `flip` prefixes exist
for; note `isArms`/`goArms`/`arms` (the section identifiers) predate this and mean the tab itself.

- **`state.armDetail` is the navigation:** null = the 武器库 library grid, set = a 武器详情 page.
  `go('arms')` resets it to null (so the nav button always lands on the library) and calls
  `loadWeapons()` (fetch-once, guarded by `armLoaded`/`armLoading`).
- **The library mirrors the Units screen** exactly: the same banner, the same horizontal
  `repeat(5, 116px)` grid + pedestal tile (weapon icon on an element-tinted `PEDESTAL` with the
  rarity stars, element badge top-right), `ROSTER_BATCH` pagination via `handleArmScroll`, and the
  round filter button. `filteredWeapons()` is the single source for both `renderVals` and pagination
  (like `filteredRoster()`), and its icons are gated by the same art window the roster's portraits
  use (see "Strip art window") — this library is the other half of the iOS memory peak that fix
  exists for.
- **The filter dialog is a port of the Units filter** with three groups — rarity, element (the six
  elements + a 无/`None` chip), and **role (能力)**. Role chips are derived from the loaded data
  (a weapon's `role` can be comma-joined, split by `armRoleTokens`), not a hardcoded table.
  `armFilter` applied / `armDraftFilter` working copy, same OR-within/AND-across + draft/commit
  semantics as the Units filter (`cloneArmFilter`).
- **The detail is a plain screen, not the character sheet's draggable bottom sheet** — weapons are
  simpler. It's transparent (no own `.wf-circle` — it lets the screen area's shared circle through)
  with a big icon hero on the pedestal, then white cards for 属性 (base vs 满级 HP/ATK), 效果 +
  最大效果, 获取方式, and the 图鉴描述 flavor, each gated on the field being present (orbs have no
  base stats). Back = `closeArmDetail()`.
- **Weapon names are per-weapon bilingual, not per-language.** The CN source gives every weapon a
  `nameZh`; `weapons_en.json` adds `nameEn` for the 316 of 384 the wiki.gg matcher resolved (see
  the wiki.gg pipeline in `PIPELINES.md`), merged onto the record by `href` in `loadWeaponsEn()`. So the tile
  label is `displayName` — English when `state.lang === 'en'` *and* that weapon matched, Chinese
  otherwise — rather than a single language-wide switch. The 能力 filter chips stay Chinese: `role`
  has no English counterpart in `{{Armament}}`, so `armRoleTokens` has nothing to localize with.
  Icons are self-hosted under `WEAPON_BASE` (`Weapons/` locally, the R2 `Weapons/` prefix live —
  see Asset loading below).

#### Story tab (the story archive)

A port of miaowm5's `/story`, fed by the main-story pipeline in `PIPELINES.md`. Everything is `arc`-prefixed
(state, handlers, `renderVals` keys) so none of it collides with the **character sheet's own story
panel**, which is a different feature — read the prefix before assuming which one a key belongs to.

- **Navigation** is state, not a router: `arcStory` null = the banner list, set = the detail;
  `arcTab` (`info|story|gallery|bgm`) picks the panel; `arcEpisodeIndex` non-null = the reader
  rather than the episode list. Back goes reader → episodes → detail → list.
- **Three lazy fetch tiers**, each cached and each guarded against navigating away mid-flight:
  `story/index.json` once on first `go('story')`, `story/detail/<slug>.json` per story
  (`arcDetailCache`), one episode file per episode (`arcEpisodeCache`). Episode dialogue is the
  bulk of the data, so it never loads until an episode is actually opened.
- **In English there are two more, both English-only** (`loadArcEn`, `loadArcEnDetail`):
  `story/en/index.json` + `story/community_en.json` together with the index, and
  `story/en/<slug>.json` when a story with a script opens (`arcEnCache`). The per-story fetch is
  gated on the index's `episodeCount` — 29 of the 42 have no script, and asking would be 29
  guaranteed 404s. `arcTitleFor()` resolves a title wiki.gg → community sheet → Chinese.
- **English episodes replace the Chinese list wholesale**, the same rule the character sheet's
  story panel follows (`arcEnEpisodes()` is the switch). They carry their dialogue inline, so
  `openArcEpisode` is pure state in English — nothing to fetch. `toggleLang` closes an open reader
  in both readers, because an episode index means a different episode in each language.
- **Community playthrough links render under the episode list**, not behind a tab: for most
  stories they're the only English there is. The same rows appear in the character sheet's story
  panel, which is why `showStoryList`/`showStoryEmpty` count videos as content.
- `DIALOG_PLATE_DEFAULT` exists because the name plate's text is white and English lines usually
  have no colour: the Chinese scripts carry a per-speaker colour from the game's data, `{{DU}}`
  only sets one for the odd unnamed speaker, and an empty `background:` renders invisible.
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
- **BGM plays through the Music Room engine**, exactly like the character detail page's theme pills
  (see `detailCharQueue`): `arcBgmQueue()` turns `arcDetail.bgm` into a room queue and the BGM rows
  call `roomToggleTrack`, so a track becomes `'room'`-owned — it surfaces the floating mini-player,
  keeps playing across tab/story navigation, and gains seek/prev/next/volume/auto-advance. Rows read
  their playing state from the shared `roomIsPlaying(url)` helper. (The old `'story'` `audioOwner`
  value and the `arcBgmPlaying`/`arcBgmIndex` state are retired; `go()`/`goDetail()`/`closeArcStory()`
  no longer stop it, since room audio deliberately rides across tabs.)
- The category chip row (全部/主线/活动/联动) filters on the `category` the pipeline stamps;
  single-select, `all` inert. `ARC_CATEGORIES` is the table.

#### Art tab (画廊) — two gallery walls behind a source toggle

The tab hosts **two independent walls**, picked by `state.galSource` (`'story' | 'x'`) through the
pill toggle above the chip row: the story-illustration wall below (64 items, `gal`-prefixed) and the
official-Twitter archive (1429 items, `twt`-prefixed, its own section further down). They take turns
owning `#gallery-scroll` the way the story tab's two views share `#story-scroll`, and each keeps its
own filter, count and viewer — the X set outnumbers the story set 22 to 1, so a single merged wall
would bury the story art. `galPack()` is the masonry packer both share.

##### The story wall

Every story illustration the site ships, on one filterable two-column masonry wall: the **52
gallery images plus the 12 chapter orbs**, 64 in total (per-category image counts, not story
counts: main 23 / event 35 / collab 6). Not banners, not headers, not character art. It exists
because the same images are otherwise reachable only one story at a time through the story
archive's own gallery panel, and 22 of the 28 stories with a gallery have exactly one image.

- **Everything is `gal`-prefixed, and this is the load-bearing rule of the whole feature.**
  `artIndex`, `toggleArt`, `showArtToggle`, `artToggleLabel` and `detailArt*` mean the *detail
  hero's awaken toggle*; `loadArtStats`/`flipStats` mean *Flip voting*. An unprefixed `art*` name
  in a feature about art would silently rewire one of them — the same hazard `arc`, `flip`, `arm`
  and `room` exist for. `isArt`/`goArt`/`sections.art` keep their names because they're the tab's
  navigation, not this feature (the `isArms`/`goArms` carve-out again).
- **`story/gallery_index.json` exists for two reasons, and the second is the real one**: the data
  lives only in the 42 `story/detail/*.json` files (872 KB to render 64 tiles), and those files
  **carry no pixel dimensions at all**. The packer needs `w`/`h` before the first paint. See the
  gallery-index pipeline in `PIPELINES.md`.
- **The masonry is packed in `renderVals`, not by CSS.** `column-count: 2` fills *column-wise*
  (1…n down the left, then the rest down the right), so on a scrolling wall you pass the whole
  first half before reaching item 2's neighbour; `column-fill: auto` fixes the order but needs a
  fixed container height, which a filtered list doesn't have. With w/h known it's arithmetic:
  430 − 14px padding each side = 402 inner, minus the 8px gutter, halved → **197px columns**;
  `tileH = round(197 * h / w)`; each image goes to the shorter column, ties left so the reading
  order runs left, right, left, right. Balance lands within ~2% on all four filters. Each tile's
  `aspect-ratio: w / h` reserves its exact box on the first frame, so nothing reflows as images
  land.
- **The caption is an overlay, not a block under the image** — a below-image caption's height
  depends on how the story title wraps, which would make `tileH` an estimate and drift the two
  columns apart. It's a single ellipsised line on a bottom gradient.
- **Tiles show 440px webp thumbnails (~2.3 MB for the wall); the viewer shows the original.** The
  64 sources total 55 MB, several over 3 MB each, against a 197px column — full resolution is only
  ever paid one deliberate tap at a time.
- `galFiltered()` is the single source for `renderVals` and for any future pagination (the
  `filteredRoster()`/`filteredWeapons()` discipline). **64 tiles needs no pagination**; revisit
  past ~200. The chip row reuses `ARC_CATEGORIES` and its four labels verbatim — no new strings.
- **`galViewer` is an index into the *filtered* list**, which is why `setGalCategory` clears it:
  the same index means a different image once the category changes.
- The viewer follows the dialog convention (z-index 100, backdrop click closes, `stopDialogClick`
  on the panels) with **one deliberate deviation: a dark backdrop**, because the dialogs'
  `rgba(255,255,255,0.5)` washes out full-bleed artwork. No `.wf-circle`, for the reason the two
  art stages have none. Prev/next wrap at both ends, like `roomStep`.
- **The swipe commits nothing until pointerup.** It follows the `sheetPointerDown` convention
  (window listeners, deltas ÷ `state.scale`, `touch-action: none`) but records `startX` in a local
  and ignores every move event, so the drag causes **zero** renders — sidestepping the
  every-render-rebuilds-the-roster problem that forced the Flip deck's drag into rAF-coalescing.
- **English**: captions and the viewer title resolve through `this.arcTitleFor()` — promoted from
  a `renderVals`-local closure to a class method so both features share it; it takes anything with
  `slug` + `title`, which is why the index stores both rather than a pre-resolved title. `go('art')`
  and `toggleLang()` call `loadArcEn()` (gated on `lang === 'en'`, idempotent, free in Chinese).
  **Orb `name`/`desc` stay Chinese in English mode** — no source has an English orb, it's the
  site's per-field fallback, and the story archive's own gallery panel already renders them that
  way. The `galOrbLabel` badge is localized, so an English reader is still told what the thing is.

#### Art tab, second source (官方推特) — the X media wall

Every image and video the game's official Twitter/X account posted, 2019-11 to 2024-03: **1429
files, 1343 images + 86 videos, ~540 MB**, self-hosted on R2 under an `X/` key prefix (`X_BASE`, the
third sibling-folder switch after `ASSET_BASE` and `WEAPON_BASE`). Fed by `x_index.json` — see the
X-media pipeline in `PIPELINES.md`, and **read its upload-boundary note before touching the collect
roots**, because a live cookie jar lives two levels above the shipped folder.

- **Everything is `twt`-prefixed**, for the reason the `gal` block above gives — `art*` was already
  taken twice over — and a bare `x*` would read as the `x-dc` runtime. `galSource`/`galPack` keep
  the `gal` prefix because they belong to the tab, not to this wall.
- **The archive has no captions, titles, alt text or tags** — a filename is the whole record. So the
  tile caption is the post date, and **year + media type are the only two filter axes that exist**.
  Don't design UI that assumes more metadata without re-scraping first.
- **The filter is the Units/Armaments dialog, not a chip row**: round 38px button with a count
  badge, `twtFilter`/`twtDraftFilter` draft-commit pair, `cloneTwtFilter` copying the group arrays,
  OR within a group and AND across, empty group inert. **Year chips are derived from the loaded
  data** (the `armRoleChips` rule), so a re-scrape that adds a year just works. `applyTwtFilter`
  resets `twtVisibleCount`, `twtWinTop`, `twtViewer` *and* `#gallery-scroll`'s `scrollTop` — all
  four describe the previous result set.
- The `year` is stamped onto each row **in `loadXIndex`**, the way `loadWeapons` stamps `roleTokens`.
  Deriving it in `renderVals` would be 1429 `Date` constructions on every render of any tab.
- **Pagination alone is not enough, and `artSrc` does not save you** — it bounds request
  *concurrency*, not *residency*. `twtVisibleCount` only grows and `loading="lazy"` only defers the
  *first* load (it never unloads), so scrolling the wall would otherwise leave every thumbnail it
  ever paged in attached to its tile. The fix is the vertical analogue of `gridWindow`: `galPack`
  hands each tile its top offset `y`, and only tiles within `TWT_WIN_PX` of `twtWinTop` get a real
  URL. **Measured in headless Edge after scrolling the whole wall: 1429 tiles mounted, 57 holding
  an image, 1372 loaded-then-released (`naturalWidth === 0`).**
- **Size the risk honestly.** The 1429 thumbnails are **36.9 MB encoded** and **575 MB decoded** at
  `w*h*4` (mean 412 KB each — 1402 of the 1429 are landscape 16:9, so a portrait-shaped estimate
  overstates this ~2.6x). Decoded is a *ceiling*, not an expectation: engines discard decoded data
  for offscreen images on their own, so the un-windowed cost is somewhere in that range rather than
  at the top of it. It still clears the 82 MB roster peak that actually killed iOS tabs, which is
  why the window is here — but don't quote the ceiling as the expected number.
- Videos contribute nothing to the wall: tiles carry webp posters, and exactly one `<video>` exists
  at a time, in the viewer.
- Out-of-window tiles get `src=""`. `img.src` then *reflects* the document URL, but the HTML spec
  special-cases an empty `src` to skip fetching — verified: one document entry in the resource
  timeline (the navigation), not one per tile. It is also what `artSrc` already does on both strips.
- **`handleGalScroll` must NOT divide `scrollTop` by `state.scale`.** That convention belongs to
  *pointer* coordinates (the sheet and Flip drags), which arrive in screen px. `scrollTop` is a
  layout metric in the element's own box and a CSS transform doesn't touch layout, so it already is
  the design px `galPack` works in. Dividing put the window ~17% past the real position, which at
  the foot of a 79,576px wall missed the end by ~13,600px and left every tile there art-less — it
  looked like the wall simply stopped loading. This was a live bug, caught by the measurement above.
- Shortest-column packing is **prefix-stable** — placing `items[0..N)` is exactly the first N
  placements of packing the whole list — so paging in another batch never re-flows what's on screen.
- **Do not put `content-visibility: auto` on these tiles.** It needs a fixed
  `contain-intrinsic-size` and every tile here is a different height.
- **The viewer is its own block, not a retrofit of the gallery viewer** — it switches between an
  `<img>` and the file's first `<video>`, and carries a date + permalink instead of orb flavour
  text. Three traps: **boolean DOM attributes must arrive as truthy strings** (`twtVideoControls:
  'controls'`) because `compileAttr` passes a bare `controls` through as `""`, which React drops,
  and `{{ true }}` is a path lookup for a key named `true`; **`stopTwtVideo()` runs synchronously
  before every state change that moves off a video** (step, close, source switch, filter apply,
  leaving the tab) because the element is reused and a new `src` alone leaves the old clip audible;
  and **the swipe bails on videos**, or a horizontal drag would step the viewer instead of scrubbing
  the native seek bar. The video is tap-to-play, never autoplaying and never muted — which is also
  the only thing iOS permits for anything with audio.
- Attribution is kept in two places, matching the site's wiki.gg/namu convention: the per-item
  `在 X 查看` permalink (rebuilt from the filename's tweet id) and the `twtSource` credit line.
- **English**: only chrome is localized, plus the viewer's long date (`twtDateLong`). There is no
  content to translate. Tile captions stay ISO `YYYY-MM-DD` in both languages.

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

#### Music Room (the music tab)

A player over the two music libraries the site already ships: the roster's `music` mp3s
(character themes, ~150 characters, `head.png` as row art) and the world/event BGM albums in
`story/music_index.json` (see the music-index pipeline in `PIPELINES.md`; one album per story, the story
banner as cover). Two views — the library (section chips 角色主题曲/世界原声 + search + lists) and
an open album — plus a now-playing bar with play/pause, prev/next, seek, a play-mode toggle, an
up-arrow that toggles an **up-next popup** (`toggleRoomQueue`/`roomQueueOpen`, the next ≤10 queue
tracks in order — tap one to jump), a click-toggled vertical **volume slider** with a draggable
knob (`roomVolumeDown`/`toggleRoomVol`/`roomVolOpen` — the speaker button toggles the popup; no
`:hover` rule, since it would pin the popup open under the cursor and block the close click;
persisted to `wf_volume` and applied to the shared `this.audio`, so it carries across every player)
and queue auto-advance. Everything is
`room`-prefixed: `music*` is the character sheet's theme pills and `arc*` the story archive, same
hazard the Flip section describes.

**The character detail page's theme pills and the story archive's BGM both feed this same engine.**
`detailCharQueue()` turns the selected character's `music` into a room queue (the `roomAllCharTracks`
shape) and `arcBgmQueue()` does the same for the opened story's `arcDetail.bgm`; both sets of rows
call `roomToggleTrack` — so a track gains seek/prev/next/volume/auto-advance, surfaces the floating
mini-player, and keeps playing across tab/character/story navigation. There is no longer a
detail-owned or story-owned player: leaving the detail tab only stops the voice lines, and leaving
the story tab stops nothing. (The old `toggleMusicTrack`, the `'detail'`/`'story'` `audioOwner`
values, and the `arcBgmPlaying`/`arcBgmIndex` state are retired; `musicIndex`/`musicPlaying` remain
as harmless vestigial state.)

- **`audioOwner` is the coexistence rule.** The shared `this.audio` has one owner at a time
  (`null | 'room'` in practice — the field still accepts `'detail'`/`'story'` but nothing claims
  those anymore — an instance field, every mutation paired with a setState of the owner's own
  playing flag, which is what renderVals reads). A feature stops the audio only if it owns it;
  starting playback anywhere claims ownership and clears the other flags. That is what lets room
  playback deliberately keep playing across tabs: `go()`, `goDetail()` and `closeArcStory()` check
  the owner before `stopMusic()`, the `ended` listener routes to `roomAdvance()` when the room owns
  it, and `roomToggleTrack` re-sets `src` whenever it *wasn't* the last owner — its `sameTrack` url
  check can't see that the element holds someone else's track. (Character themes and story BGM are
  both `'room'`-owned now via `detailCharQueue`/`arcBgmQueue`; voice lines play on a separate
  `voiceAudio`.)
- **`roomQueue` is whatever list the tapped track belonged to** — a character's tracks, an album,
  a search result's owning album, or a whole-library playlist (see below) — so auto-advance
  continues through what the user was looking at. It persists across tabs; the full now-playing bar
  (music tab only) picks it back up, and its play button re-claims a stolen audio by replaying the
  current entry from 0:00 (losing the paused position to a theme-pill detour is the accepted
  trade).
- **Off the music tab, a compact draggable mini-player** (`悬浮窗`) carries a short title +
  play/next, so room playback stays controllable while you browse (`roomMiniOn` = queue loaded,
  not on `music`, menu closed). It's **draggable** via `roomMiniDown` (the sheetPointerDown
  convention — window listeners, deltas ÷ `state.scale`, `touch-action: none`), and a press that
  never moves is a **tap → `go('music')`**; the play/next buttons `stopPropagation` on pointerdown
  (`roomMiniBtnStop`) so they don't start a drag, and the title block is `pointer-events: none` so
  the whole body is one drag surface. Drop it against either side edge and it **collapses to an
  arrow tab** (`roomMiniCollapsed` + `roomMiniSide`) that taps back open (`expandRoomMini`).
  Position is `roomMiniPos` `{x,y}` in **design px** (null = the default bottom-right anchor,
  rendered via `right/bottom` rather than `left/top`); the drag clamps to the screen area measured
  off `el.offsetParent` (untransformed layout px = design px). It sits at `z-index: 45` so it rides
  **over the detail sheet** (z 9/10) — deliberately shown on `detail` now, unlike the first cut —
  and is hidden under the menu overlay (40) only because `roomMiniOn` drops it while `menuOpen`. It
  shows **no progress bar on purpose**: `timeupdate` is gated to `tab === 'music'`, so `roomPos` is
  stale off-tab and a live bar would freeze (relaxing that gate would re-render the whole tree every
  second for the mini alone).
- **Play mode** (`roomMode`, cycled by the bar's mode pill through `ROOM_MODES` = order → shuffle
  → repeat) only changes what happens next, never the current track: `roomAdvance` (the `ended`
  route) does repeat = replay, shuffle = a random other position (`roomRandomPos`), order = next or
  stop at the end; the manual prev/next (`roomStep`) always moves — forward-in-shuffle jumps
  random, otherwise it **wraps** either end (changed from the old clamp-and-replay).
- **Whole-library playlists** (`playRoomLibrary('char'|'world'|'all')`, the library's 播放全部 row)
  build one big queue from `roomAllCharTracks()` / `roomAllWorldTracks()` and start it (shuffle
  mode starts at a random index). World/all need `roomAlbums` loaded — that only fetches when the
  world section is opened, so the handler kicks `loadRoomAlbums()` and, for a `world`-only request,
  bails until it lands (an `all` request still starts the character half immediately).
- **The `timeupdate` setState is floored to whole seconds *and* gated to `tab === 'music'`** —
  renderVals rebuilds the roster tiles on every render, so an ungated 4Hz tick would re-render
  the tree for nobody. `roomPlay` sets `audioOwner` *before* `audio.src`, or the new track's
  `durationchange` is dropped by its own guard. Seeking is a ratio along the bar
  (`(clientX − rect.left) / rect.width`): the canvas scale multiplies both terms and cancels, so
  unlike the sheet/flip drags there is **no** `/state.scale` here.
- World search flattens to cross-album track rows (capped at 60) — being able to search 708
  tracks without loading anything is the reason `music_index.json` exists instead of lazily
  reading the 42 detail files. Track titles are prettified filenames (`roomTrackTitle`); the data
  has nothing better. An album-title match surfaces that album's whole track list.
- The library and album views take turns owning `#music-scroll` (they never coexist), the same
  arrangement as the story tab's two `#story-scroll` views. The library view-models only build in
  renderVals while the tab is showing — the character list walks the whole roster, which is more
  than the always-built arc lists do.

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

#### Strip art window (Units roster + Armaments library)

Both strips are the same 5-row, 92px-column, 6px-gap grid, so `gridWindow()` / `gridWinCol()` /
`updateGridWindow()` serve both, keyed by `state.unitsWinCol` / `state.armWinCol`. **This is a
crash fix, not a polish pass.** Pagination only ever grows (`visibleCount` / `armVisibleCount`
reset on a filter, never on a tab change), so a user who had scrolled the roster kept all 485
tiles alive — each pinning a 212x212 `head.png`, ~180KB decoded, **~82MB for the set** — and
`sc-if` re-created the whole set in one commit on every re-entry. Coming back from the Armaments
library (which had just added 384 icons and its two JSON files, evicting the roster's decoded
images) put the peak over WebKit's per-tab budget and iOS killed the tab; Android's looser limits
are why only iOS crashed.

**What is windowed is the artwork, not the tiles.** Every paged-in tile renders at its own place in
the grid; only the one expensive image inside it is gated — `c.showHead` on the roster portrait,
`w.showIcon` on the weapon icon. Measured in headless Edge: loaded portraits drop from 482 to ~145
(~82MB → ~26MB) with all 482 tiles still mounted.

- **Mounting a slice of tiles instead is a trap, and it was tried first — don't re-try it.**
  `sc-for` keys its children by index (`walkFor` in `support.js`), so a window that slides by one
  column moves no DOM: it rewrites the `src` of every mounted image, turning one flick into
  hundreds of loads and decodes. It also makes the strip's geometry depend on the window (spacer
  divs standing in for the absent columns), so any disagreement between the window and the real
  `scrollLeft` paints an empty spacer and the strip looks like it never loads. Both were live bugs
  in the shipped version of that approach.
- **Gating art keeps the item→element mapping fixed**, so scrolling only adds and removes the
  images actually entering and leaving the window, and a wrong window costs a few missing
  portraits for a frame — nothing else. The pixel sprite, pedestal, stars and name are
  unconditional, because all 482 sprites together decode to under 6MB.
- **`gridWindow` takes the *paginated* count, not the filtered total** — an item that hasn't been
  paged in has no column and can't be in the window.
- Three things keep the window near the scroll position: `updateGridWindow` on scroll (with a
  `GRID_RECENTER_COLS` drift tolerance — each change loads whatever art enters, so the buffer is
  what stops a flick from requesting the whole roster), `syncGridWindow` inside
  `restoreUnitsScroll` (adopting whatever `scrollLeft` the element actually accepted), and
  `healStripWindows()` in `componentDidUpdate` as the backstop for a remount nobody reported. The
  backstop only fires when the viewport is fully outside the buffer, so ordinary drift never
  re-renders through it.
- **The Armaments strip restores its scroll the same way the roster does**: `armsScrollLeft` is
  recorded in `handleArmScroll` and re-applied by `restoreArmsScroll()` (the `restoreUnitsScroll`
  double-rAF + retry + `syncGridWindow` shape) from `closeArmDetail()` and `go('arms')` — the strip
  unmounts whenever a weapon detail opens or the tab is left, so it would otherwise come back at 0.
  `applyArmFilter` zeroes both `armsScrollLeft` and `#arms-scroll` itself (plus `armWinCol`), since
  the old position belongs to the previous result set.
- The strips are the only lists that need this: the gallery wall is 64 tiles (and already serves
  440px thumbnails) and the story/music lists are text.
- **`.wf-tile` carries `content-visibility: auto`** on both strips' tiles, which is what lets the
  engine skip layout, paint and rasterization for tiles scrolled out of view while they stay in
  the DOM — so scrollWidth, scroll positions and the item→element mapping are all untouched. Its
  `contain-intrinsic-size: 92px 116px` must keep matching the real tile box (92px column, 100px
  art + 3px gap + ~13px label) or the grid shifts as tiles enter and leave; verified by the strips'
  scrollWidth being unchanged (9524 units / 7564 arms).

#### Strip art loader (what actually fixed the iOS crash)

The crash was never the total decoded size — it was **request concurrency while the strips load**,
which is why it only ever happened mid-load and never once everything was cached. Nothing throttled
the tiles' images: measured over a local HTTP server (`file://` hides this entirely), opening the
Armaments library fired **40** parallel image requests, paging it to 384 peaked at **255**, and
switching back to the roster — 482 tiles with a portrait and a sprite each — peaked at **354**.
Desktop absorbs that; iOS killed the renderer (white screen / self-reload, on both Chrome and Quark,
which are both WebKit). With the loader the same three points measured 16 / 16 / 10 while
`ART_MAX_INFLIGHT` was 8; it is 16 now, so the ceiling is about double that — still an order of
magnitude under the range that killed the renderer.

- **A tile never gets a `src` the browser hasn't already fetched.** `renderVals` asks for a URL via
  `artSrc()`, which returns the URL once loaded and `''` until then, recording it in `artWanted`.
  `pumpArt()` (called from `componentDidUpdate`, so it works off a committed render, never from
  inside `renderVals`) fetches through plain `new Image()`, at most `ART_MAX_INFLIGHT` at a time.
  By the time the real `<img>` receives the URL it is served from cache.
- **`ART_MAX_INFLIGHT` is bounded by this site's own measurement, not by "6 per host".** That 6 is
  an HTTP/1.1 *connection* limit and doesn't apply — R2 is HTTP/2, so everything shares one
  connection and the real ceiling is the server's `SETTINGS_MAX_CONCURRENT_STREAMS` (RFC 7540 says
  ≥100). The number that matters is the 255-354 range above. The **pixel sprite is deliberately not
  gated** (a tile without it looks broken, and all 482 sprites decode to under 6MB), so the peak is
  the constant plus a few ungated sprite requests.
- **The queue is rebuilt from every render in on-screen order**, so scrolling away from a batch
  de-prioritizes it instead of leaving the gate working through art nobody is looking at.
- Loads are published in batches (`ART_BATCH_MS`, one `artVersion` bump), because `renderVals`
  rebuilds the whole tree and 482 individual re-renders would cost more than the fetches.
- **`upload-to-r2.mjs` now sets `Cache-Control`** (`immutable` for the per-character/per-hash
  assets, 5 minutes for `roster.json`, which is re-uploaded every run). Without it R2 serves no
  caching hint at all, so the burst is paid on every visit and one `<img>` can even fetch the same
  file twice. Existing objects only pick it up when re-uploaded.

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

- **profile** — GIF stage, Skill/Special buttons + `extraActionButtons` pills, theme-music pills
  (below the GIF buttons, above expressions — they play through the Music Room engine, not a
  detail-owned player; see `detailCharQueue` and the Music Room section), expression viewer
  (`hasEmotions`), and wiki text sections gated by `hasWikiInfoRows` /
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
only `roster.json`, `story_heads.json`, `units_en.json`, `rarityN/*`, `story_heads/*`, and
`story/*` reach R2 — any new asset type must be added to `upload-to-r2.mjs`'s include rules or it
silently never ships.
Every path inside `story/index.json`, `story/detail/*.json` and `story/gallery_index.json` is
stored relative to `Character Assets/` (i.e. it mirrors the R2 key), so `ASSET_BASE + '/' + p`
resolves on both branches with no per-branch special-casing. `story/gallery_index.json` and the
`story/thumbs/` art the Art tab reads ride the existing `story/` include prefix — no
`upload-to-r2.mjs` change was needed for them.

**`WEAPON_BASE` is the parallel switch for the weapons library**, defined right next to
`ASSET_BASE`: `file://`/`localhost` → local `Weapons/`; else → the same R2 root with a `/Weapons`
suffix. It can't ride `ASSET_BASE` because `Weapons/` is a **sibling** of `Character Assets/`, not
under it — `upload-to-r2.mjs` collects that top-level folder separately and uploads it under a
`Weapons/` key prefix that matches this. `weapons.json` stores icon paths relative to `WEAPON_BASE`
(`icons/<hash>.png`), same as the story paths mirror their R2 key.

**`X_BASE` is the third such switch**, for the Art tab's X media wall: `file://`/`localhost` →
local `X/gallery-dl/twitter/world_flipper`; else → the same R2 root with an `/X` suffix. Same
reasoning as `WEAPON_BASE` — `X/` is another sibling of `Character Assets/` — and `x_index.json`
stores `file`/`thumb` relative to it. **The local path is deliberately the deep folder**: the
collect root in `upload-to-r2.mjs` matches it, which is what keeps `X/x.com_cookies.txt` (a live
session cookie jar) and `X/gallery-dl.exe` structurally unreachable. `X/` is gitignored in full.

`roster.json` entries carry `devName`, `enName`, `jpName`, `rarity`, `attribute`, `thumb`,
optional `music` (mp3 filenames, ~150 characters), `hasHead` (the `head.png` URL is derived from
`thumb`'s path, not stored), `race`/`gender`, and — for wiki-matched characters —
`zhName`/`hasWiki`/`voiceCount`; `--new-chars` entries carry `bustOnly: true` instead (see the miaowm5 pipeline in `PIPELINES.md`).
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

- `supabase-visit-counter.sql` → `record_visit(vid)`. Two of the three top-right pills
  (`icons/Mana.png` = total page views, `icons/Lodestar_Bead.png` = unique visitors). `recordVisit()` fires once in
  `componentDidMount`; the RPC bumps PV, upserts the visitor id and returns `{pv, uv}`, which
  `renderVals` formats into `pvCount`/`uvCount` (a dash until it resolves). **No IP is ever read**
  (a browser can't, and it'd miscount shared/rotating IPs anyway).
- `supabase-art-votes.sql` → `vote_art(vid, akey, v)` + `art_stats_all(vid)`, backing the Flip tab
  (see above). `art_stats_all` returns **every** artwork's counts in one ~35KB call, cached in
  `state.flipStats` and shared by the deck and the detail hero — per-key reads would leave the pill
  blank under the user's thumb on every swipe. Two tables: per-visitor vote rows plus a
  denormalized aggregate that only `vote_art` writes, in one transaction under a row lock, so they
  can't drift. Note the RPC parameter is `akey`, not `art_key` — a parameter sharing a column's
  name makes every unqualified reference in the body ambiguous. **The third top-bar pill
  (`icons/Exp_point.png`) reuses this data**: `renderVals`' `flipTotal` sums
  Σ(`likes+dislikes+skips`) over `state.flipStats` — no new RPC — and `loadArtStats()` is kicked in
  `componentDidMount` (idempotent) so the pill populates on load without a second call.

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
