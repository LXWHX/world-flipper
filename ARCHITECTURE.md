# ARCHITECTURE.md

前端各屏 / UI 子系统的深水区细节。动任何 tab、过滤对话框、播放器、滚动条带、缩放或背景之前，
先读对应小节。运行时核心约定（`x-dc` 模板、文件地图、`renderVals` 规则）、资产加载与跨屏铁律在
`CLAUDE.md`；数据管线在 `PIPELINES.md`。

## Backgrounds: the magic circle

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

## The fixed canvas: scaling and zoom

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


## 各 tab 屏幕

导航模型（单 Component、`state.tab` 驱动 `<sc-if>`、无 router）见 `CLAUDE.md` 的
"Single component, tab-based navigation"。以下按 tab 分节。

### Armaments tab (武器库 / 武器详情) — the weapon library

代码在 `wf-arms.js`（见 `CLAUDE.md` 的文件地图）。

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
  base stats). Back = `closeArmDetail()`. Its four card headings are the `.wf-sec-title` treatment
  (see "Section headings") — this screen is where that look was first used; 最大效果 is a
  sub-heading and deliberately stays plain.
- **Weapon names are per-weapon bilingual, not per-language.** The CN source gives every weapon a
  `nameZh`; `weapons_en.json` adds `nameEn` for the 316 of 384 the wiki.gg matcher resolved (see
  the wiki.gg pipeline in `PIPELINES.md`), merged onto the record by `href` in `loadWeaponsEn()`. So the tile
  label is `displayName` — English when `state.lang === 'en'` *and* that weapon matched, Chinese
  otherwise — rather than a single language-wide switch. The 能力 filter chips stay Chinese: `role`
  has no English counterpart in `{{Armament}}`, so `armRoleTokens` has nothing to localize with.
  Icons are self-hosted under `WEAPON_BASE` (`Weapons/` locally, the R2 `Weapons/` prefix live —
  see Asset loading in `CLAUDE.md`).

### Story tab (the story archive)

代码在 `wf-story.js`（见 `CLAUDE.md` 的文件地图）。

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

### Art tab (画廊) — two gallery walls behind a source toggle

代码在 `wf-art.js`（见 `CLAUDE.md` 的文件地图）。

The tab hosts **two independent walls**, picked by `state.galSource` (`'story' | 'x'`) through the
pill toggle above the chip row: the story-illustration wall below (64 items, `gal`-prefixed) and the
official-Twitter archive (1429 items, `twt`-prefixed, its own section further down). They take turns
owning `#gallery-scroll` the way the story tab's two views share `#story-scroll`, and each keeps its
own filter, count and viewer — the X set outnumbers the story set 22 to 1, so a single merged wall
would bury the story art. `galPack()` is the masonry packer both share.

#### The story wall

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

### Art tab, second source (官方推特) — the X media wall

代码在 `wf-art.js`（见 `CLAUDE.md` 的文件地图）。

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

### Flip tab (弹弹) — art voting

代码在 `wf-flip.js`（见 `CLAUDE.md` 的文件地图）。

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

### Music Room (the music tab)

代码在 `wf-music.js`（见 `CLAUDE.md` 的文件地图）。

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

### Units filter

代码在 `wf-units.js`（见 `CLAUDE.md` 的文件地图）。

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

### Units grid tile

代码在 `wf-units.js`（图块本身在 `index.html` 的模板里）（见 `CLAUDE.md` 的文件地图）。

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

### Strip art window (Units roster + Armaments library)

代码在 `wf-units.js`（见 `CLAUDE.md` 的文件地图）。

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

### Strip art loader (what actually fixed the iOS crash)

代码在 `wf-units.js`（见 `CLAUDE.md` 的文件地图）。

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

### Character detail bottom sheet

代码在 `wf-detail.js`（见 `CLAUDE.md` 的文件地图）。

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

Every block heading across those four panels is the shared `.wf-sec-title` (see "Section headings"),
matching the weapon detail; the two headings that sit *inside* a block — Add-ons under the expression
viewer, Quotes under the voice list — stay plain on purpose, and that difference is what keeps them
from reading as sections of their own.

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

### Emotion layers (faces vs. overlays)

代码在 `wf-detail.js`（见 `CLAUDE.md` 的文件地图）。

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


### Loading placeholder (`.wf-loading`)

CSS 和 `loadingWave()` 都在 `index.html`（前者在 `<helmet>`，后者和 `t`/`sections` 一起是共享
方法）；九处调用点分散在各 `wf-*.js` 的 `xVals` 里。

All twelve "still loading" spots across the app render the same thing: Alk's pixel walk sprite
bobbing over the localized loading text, whose glyphs ripple one after another. The placeholder
sits **where the content will be** (in the strip, in the scroll area, in the panel) — there is no
full-screen overlay and no persistent corner indicator, so a screen that already has content on it
never gets covered.

Nine wait on a `fetch`: `loadingRoster` (`wf-chrome.js`), `storyLoading` (`wf-detail.js`),
`flipLoading` (`wf-flip.js`), `arcLoadingIndex`/`arcLoadingDetail`/`arcLoadingEpisode`
(`wf-story.js`), `galLoading`/`twtLoading` (`wf-art.js`), `roomLoading` (`wf-music.js`). Three more
wait on an **image** — the detail sheet's big art, all three sharing one `detailArtLoading` string
because only one is ever on screen at a time (see below). Each `xVals` slice pairs its existing
`*LoadingText` key (still used, for the sprite's `alt`) with a `*LoadingWave` key.
`index.html:256`'s `unitsStatusText` is **not** one of them — that's the Units banner's subtitle,
not a placeholder, and it stays plain text.

#### The detail sheet's three (`heroSrc`)

The full shot averages **0.5 MB** and an emotion/bust base **337 KB**, and until this existed the
sheet simply opened on an empty box while they came down. They go through `heroSrc()` in
`index.html`, which is `artSrc` for one or two images at a time: same "hand back the URL only once
`new Image()` has it" trick, same `heroWanted` rebuild per render, pumped from the same
`componentDidUpdate` — but **no concurrency ceiling and its own queue**. Sharing `artWanted` would
have been a priority inversion: `unitsVals` keeps enqueueing the roster window's tiles even while
the sheet is open, so the one image the user is looking at could queue behind a screenful of 40px
portraits in the 16-slot gate.

**Only the base layers are gated.** The faces and overlays stacked on top average **22 KB** against
a base's 337 KB and swap on every ‹ › tap, so gating those would flash a spinner on every press
over art that is already on screen. But they are *hidden* while their base loads
(`hasEmotionFront`/`hasBustFront`/`emotionOverlayLayers` all `&&` the base's resolved src) —
otherwise the light face lands first and hangs in mid-air over the placeholder.

Not extended to the roster/armaments strip tiles, and deliberately: a `.wf-loading` per tile is
dozens of GIFs decoding at once in the art window, which is the load `artSrc` exists to prevent.
The tile-scale answer is the static `background: #F0F3F7` the portrait slot already carries.

Why it looks the way it does:

- **The GIF lives in `icons/`, as a copy of `Character Assets/rarity4/alk/walk_front.gif`.** That
  duplication is the point: `Character Assets/` is gitignored and served from R2 in production
  (`ASSET_BASE`), so sourcing the spinner from there would make the spinner itself wait on the
  network round trip it exists to cover — it would appear *after* the thing it is meant to cover
  for. `icons/` is tracked and same-origin. The original stays where it is; the detail sheet still
  reads it. It's 4.2 KB, so the copy costs nothing.
- **The 5-line markup is repeated at all nine sites.** The template has no partial mechanism:
  `<Foo/>` resolves through `fetch` (`support.js:1442`), which `file://` blocks. So everything
  visual lives in the `wf-loading*` CSS classes and each site carries only structure — the same
  trade-off the two gallery walls already make with their tile markup.
- **The ripple needs one `<span>` per glyph**, produced by `<sc-for>` over `loadingWave(key)`'s
  `{ c, d }` rows, with `d` interpolated into `animation-delay`. `loadingWave` rewrites `…` to
  three dots so the ellipsis ripples instead of bobbing as one lump, and the spans are
  `white-space: pre` so the spaces between words keep their width once each character is its own
  element.
- **Two modifier classes** for the two sites that aren't plain in-flow blocks: `wf-loading-wide`
  (the roster strip is a flex row — without `width: 100%` the placeholder collapses to the
  sprite's width at the far left) and `wf-loading-overlay` (the flip deck's placeholder fills an
  absolutely-positioned box).
- **Not a real pixel font.** `.wf-loading-text` is a monospace stack plus uppercase, weight 900 and
  wide tracking; a genuine dot-matrix face would mean shipping a woff2 and clearing its license.
  The rounded body font trails the stack so hanzi land on it rather than a system substitute.
- `prefers-reduced-motion` stops the bob and the ripple. The sprite's own frame animation is baked
  into the GIF and can't be stopped from CSS.


### Section headings (`.wf-sec-title`)

CSS 在 `index.html` 的 `<helmet>`（紧接 `wf-loading*` 那组）；调用点在模板里，21 处。

One heading treatment for every content block in the app: a **centred dark title flanked by the
game UI's own pair of flourishes**. Markup is one line —

```html
<div class="wf-sec-title"><span>{{ someTitleLabel }}</span></div>
```

- **The two rails are `::before`/`::after`**, each `flex: 1; height: 14px` with the art anchored
  *inward* (`background-position: right` on the left rail, `left` on the right). So the flourish
  always hugs the title and the surplus width is left blank rather than tiling, and the centring
  comes from the two rails rather than `text-align`. That also means a heading costs one line of
  markup instead of the three sibling divs this used to be spelled out as.
- **Two pre-mirrored PNGs, no `scaleX(-1)`**: `icons/title_border_{left,right}.png` (upstream's
  sprite names are documented in `PIPELINES.md`). They stay in `icons/` for the same reason the
  loading GIF does — `Character Assets/` is served from R2 in production, and a heading flourish
  should not wait on a network round trip.
- **`margin-bottom: 8px` is the class default**; the weapon detail's four cards override it inline
  (12px on the stats card, 10px on the rest) to keep their original in-card rhythm. Inline wins over
  the class, so an override is just a `style` attribute.
- **A sub-heading *inside* a section deliberately gets no rails** and keeps the old small-grey style
  (`font-size: 12px; weight 900; #8A93A5; letter-spacing: 0.5px`). Three of them: 最大效果 (inside
  the weapon 效果 card), 叠加配件/Add-ons (inside the detail sheet's expression block) and Quotes
  (inside its voice list). **That contrast is the only thing carrying the hierarchy** — the sections
  have no card borders of their own to do it, so promoting one of those three to rails flattens its
  parent section into a sibling.
- **Consumers**: the weapon detail (4), the character detail sheet (10 — expressions, 情报, 技能,
  故事, 评价, voice, episode list, videos, related characters, keywords) and the story archive (7 —
  情报, 关联角色, 关键词, 剧集, 视频, 画廊, BGM). All of their labels were already `this.t(...)`
  values in `wf-detail.js` / `wf-story.js` / `wf-arms.js`, so this is CSS-only: no `xVals` key
  changed, none was added.
- **13 inline copies predate the class** — the Units / Armaments / X-wall filter dialogs and the
  News and About dialogs (`index.html` 425-566, 1986-2026, 2088-2103 territory). Same look, still
  spelled out as three divs. Migrating them is mechanical and safe, just not something any change
  has needed yet; if you touch one of those dialogs, collapse it on the way past.


## Supabase (visit counters + art votes)

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


## Routing & document head

代码在 `wf-route.js`（见 `CLAUDE.md` 的文件地图），加上 `index.html` 真实 `<head>` 里的静态标签
和 `scripts/build-social-card.mjs` 合成的两张图。

站点原本没有任何身份：`<title>` 一个都没有，没有 favicon，没有 `og:`，也没有深链接——485 个角色、
384 件武器、42 段剧情一条都发不出去，而安卓的实体返回键会直接退站。这一节记的就是补上这些之后
的形状，以及三个必须知道的坑。

### 路由表

| hash | 状态 |
| --- | --- |
| 空 / `#home` | `tab: 'home'` |
| `#units` `#arms` `#story` `#art` `#music` `#flip` | `tab` |
| `#char/<devName>` | `tab: 'detail'` + `selectedChar` |
| `#arms/<slug>` | `tab: 'arms'` + `armDetail` |
| `#story/<slug>` / `#story/<slug>/<n>` | `tab: 'story'` + `arcStory`（+ `arcEpisodeIndex`） |

id 一律取稳定键：`devName`（roster 主键）、weapon `slug`、story `slug`。刻意**不进 URL** 的是筛选
条件、`sheetPanel`、`arcTab`，以及画廊两个 viewer 的下标——`galViewer`/`twtViewer` 存的是
**filtered 数组的下标**，换个筛选就指向另一张图。要做单图分享，得先把它们改成按 id 反查
（gallery 用 `slug`，X 用 `file`，两者都稳定），那是另一件事。

### 三个坑

1. **`file://` 下 `pushState` 抛 SecurityError。** 本地开发就是 `file://`（`ASSET_BASE` 的第一个
   分支），而 `file://` 文档的 origin 是 `null`，Chrome 拒绝在这种文档里 `pushState`。所以整套
   路由只用 hash：前进 `location.hash = …`（自动进历史栈，返回键白拿），首屏归一化和降级用
   `location.replace(href.split('#')[0] + '#' + …)`（只改 fragment 是同文档导航，不会重载）。
   `boot()` 会重新 `fetch(location.href)`（`support.js:159`），但 fragment 不参与请求，所以带
   hash 打开页面对它没有影响。
2. **`<helmet>` 里的 `{{ }}` 不会被插值。** helmet 认 META/LINK/SCRIPT（`support.js:1337`），但它
   `compile()` 返回的函数**忽略 `_vals`、直接用模板里的原始 `textContent`**
   （`support.js:1322-1358`）。所以 `<title>{{ x }}</title>` 放 helmet 里只会得到字面量。静态标签
   因此写在真实 `<head>`（那里是安全的：`parseDcText` 只找模板块的起始标记和最后一个结束标记，
   `support.js:38`），动态标题走 `syncDocumentTitle()` 直接改 `document.title`。
3. **深链接打开一个屏幕 ≠ 那个屏幕会显示。** 剧情阅读器踩过：`openArcEpisode(n)` 把
   `arcEpisodeIndex` 设对了，但渲染它的 `arcShowReader` 还要 `arcTab === 'story'`
   （`wf-story.js:309`）——从界面点进话数必然是从话数列表来的，`arcTab` 早就对了；深链接却是
   `openArcStory` 按 `defaultArcTab` 落在 `'info'` 上。表现是 state 全对、屏幕上还是情报页，
   DOM 与不带话数的链接**逐字节相同**。修法是 `routeApply` 里补一句 `setArcTab('story')`。

### 形状：URL 从 state 推出来

`syncRoute()` 挂在 `componentDidUpdate` 上，由 `routeHashFromState()` 算出目标 hash，和地址栏不同
才写。**十几个导航入口一个都没改**——`go` / `goDetail` / `backFromDetail` / `goArmDetail` /
`closeArmDetail` / `openArcStory` / `closeArcStory` / `openArcEpisode` / `closeArcEpisode` 全部
原样，URL 自己跟上，包括 related chip 那条 detail→detail 的路径（逐个改入口一定会漏掉它）。

**代价是站内的返回按钮也会新增一条历史记录**：它是一次正向的 state 变化，本文件无从分辨"其实
是后退"。于是浏览器返回会回到刚离开的详情页。这是有意接受的：URL 历史 = 浏览记录。

写 URL 时 `routeLastWritten` 记下写进去的值，随之而来的 `hashchange` 靠它认出"这是自己的回声"
——比用定时器清一个 suppress 标志确定得多。中文 slug（武器全是）在序列化时会被百分号编码，所以
**比较一律在逐段解码后的形式上做，写入时再逐段编码**。

### 延迟兑现：`pendingRoute`

冷启动落在 `#char/fire_dragon` 时 `roster.json` 还在路上。应用不了的路由存进 `this.pendingRoute`，
由 `componentDidUpdate` 里的 `drainPendingRoute()` 在数据到齐后兑现，兑现走的是现成的函数
（`goDetail` / `goArmDetail` / `openArcStory`），所以 `hasSpecial` 探测、双立绘预载、
`detailReturnTab` 一概照旧。三条链各自等各自的数据：`rosterByDev`（`index.html` 的 roster
`.then` 里填）、`armWeapons`（`go('arms')` 顺带 `loadWeapons()`）、`arcIndex`（`go('story')` 顺带
`loadArcIndex()`），话数还要再等 `arcDetail`。

**判"还没到"和判"根本没有"必须分开**：前者继续挂着，后者立刻降级——否则一个拼错的 slug 会永远
挂在那里，而 `syncRoute` 在 `pendingRoute` 非空时是 no-op（那时 URL 是目标、state 还没跟上），
于是 URL 也永远同步不了。降级 = 静默回到该 tab 的列表页 + `replace` 掉 URL（不留一条通向死链的
历史记录），不弹任何错误。

### 返回键 / Esc / 方向键

hash 里有的层（tab / 详情 / 武器详情 / 剧情 / 话数）由历史栈天然处理。hash 里**没有**的浮层由
`routeOverlays()` 那张自上而下的优先级表兜住：大图 viewer → 动作 GIF 叠层 → 三个筛选弹窗 →
播放队列 / 音量 → 菜单 / 资讯 / 关于。`hashchange` 先问这张表，有浮层就关掉最上面那层并把 hash
写回原值（于是"再按一次返回"才真的离开这一屏）；Esc 用同一张表，没有浮层可关时按屏幕自己的返回
语义退一层。注意 `closeTwtViewer()` 里有 `stopTwtVideo()`，绕过它会留下一个在别的屏幕后面继续
出声的 `<video>`。

方向键是顺手的桌面收益：画廊两面墙的大图（`galViewerStep`/`twtViewerStep`）和详情页表情
（`emotionStep`）——触摸端本来就能滑，键盘接上而已。输入框（筛选、音乐室搜索）里的按键一概不劫。

### 社交卡片与 favicon

`scripts/build-social-card.mjs`（`npm run build:social-card`）本地合成 `icons/social-card.png`
（1200x630，og:image）和 `icons/favicon.png`（180x180，同时作 apple-touch-icon）。两张都在
`icons/` 下，由站点自身提供，**不走 R2**——和 `alk_walk.gif` 必须留在 `icons/` 同理，所以
`upload-to-r2.mjs` 无需改动。

存在的理由是一个陷阱：**`icons/Site-logo.png` 是一个改名成 `.png` 的 WebP**（魔数
`RIFF....WEBP`）。浏览器 `<img>` 会嗅探格式所以站内一直正常，但 og:image 必须是真 PNG/JPEG，X 的
抓取器不收 WebP。favicon 取的是 logo 里"WORLD"那个 O 中的世界球（`SPHERE` 那几个坐标是照着图量
的，换 logo 就得重量），因为整幅字标在 16px 下是一团糊。卡片上的文字由 librsvg 走系统字体栅格
化，CJK 副标题因此依赖本机装了中文字体；输出是提交进 git 的，所以这对一个 dev-only 脚本可以
接受——但副标题要是变成豆腐块，原因就在这里。合成图片遵守管线铁律：存在即跳过，**改合成逻辑要
先删旧文件**（或 `--force`），写入走 `writeIfChanged`，空跑零 diff。

og 里的地址必须是**绝对 URL**（`https://wf.joeli.site/…`）：抓取器不执行 JS，也不认相对路径，所以
这里不能复用 `ASSET_BASE` 那套 `file://` 分支判断。**每个角色各自的 og 卡片做不到**——静态托管
没有服务端渲染，要么预生成 485 个 HTML，要么放弃；现在是一张站点级的卡片。
