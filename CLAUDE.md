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

各屏 / 各 UI 子系统的深水区细节在 **`ARCHITECTURE.md`**（索引见下面"各屏与子系统"一节）；
这里只保留运行时核心约定。

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

### File map: `index.html` + the `wf-*.js` page files

The page logic is split one file per tab. `index.html` keeps only what the runtime forces it to
keep, plus the shared shell:

| 文件 | 内容 |
| --- | --- |
| `index.html` | the template, the `class Component` shell (`state` + instance fields), the shared methods (`t`/`toggleLang`/`sections`/`go`/`componentDidMount`/`componentDidUpdate`/`updateScale`/`headUrlForSpeaker`), and the `renderVals()` aggregate |
| `wf-core.js` | `ASSET_BASE`/`WEAPON_BASE`/`X_BASE`, `DESIGN_W`/`DESIGN_H`/`computeLayout`, Supabase config, `STRINGS`, and the tables more than one page reads (`ELEMENT_ORDER`, `PEDESTAL`, `FILTER_RARITIES`, `GRID_*`, `ART_*`, `DIALOG_PLATE_DEFAULT`) |
| `wf-units.js` | roster, the five filter groups, and the strip art window + loader (`artSrc`/`pumpArt`/`gridWindow` — Armaments and the X wall call into these) |
| `wf-detail.js` | the bottom sheet, panel switcher, emotion layers, character story, voice |
| `wf-arms.js` | 武器库 / 武器详情 (`arm*`) |
| `wf-story.js` | the story archive (`arc*`) |
| `wf-art.js` | the gallery wall (`gal*`) + the official X wall (`twt*`) |
| `wf-music.js` | Music Room + the floating mini-player (`room*`), and the shared audio engine |
| `wf-flip.js` | 弹弹 art voting (`flip*`) |
| `wf-chrome.js` | changelog, News/About, visit counters, home/menu, the bottom tab bar |
| `wf-route.js` | hash 深链接、`document.title`、返回键 / Esc / 方向键（`route*`；没有屏幕，所以没有 `xVals`） |

How it holds together, and why it has to be this shape:

- **The template and the `class Component` declaration cannot leave `index.html`.**
  `parseDcDocument` (`support.js:24`) reads the template block's `innerHTML` and the
  `data-dc-script` block's `textContent` — an external `src=` script has empty `textContent`. The
  runtime's own sibling-component mechanism (`<Foo/>` → `fetch('./Foo.dc.html')`, `support.js:1442`)
  is not an option either: `fetch` is blocked on `file://`.
- **The `wf-*.js` are plain classic scripts, loaded in `<head>` before `support.js`.** A top-level
  `const` there lands in the global lexical environment, and the `data-dc-script` body is evaluated
  by `new Function` in global scope (`support.js:743`) — so both sides see each other with no
  prefixing. `wf-core.js` must stay first (`ARM_ELEMENTS` reads `ELEMENT_ORDER` at load time).
- **Methods are attached with `Object.assign(Component.prototype, WF_…)`** after the class. No
  method uses `super`, so this is verbatim. One difference: methods attached this way are
  *enumerable*, class-body methods are not — nothing does `for…in` over an instance today.
- **Each page owns its constants**, next to the methods that use them — only genuinely shared
  tables go in `wf-core.js`. A page whose constant turns out to be shared moves it to core
  (that's how `FILTER_RARITIES` got there: the weapon filter reuses the Units rarity chips).
- **`renderVals()` is an aggregate of per-page `xVals(ctx)` slices.** `ctx` is `{ tab, accent, sec }`
  — the only locals that were ever shared across sections; everything else a slice needs it
  re-derives from `this`. **A shared `renderVals` closure has to be promoted to a real method**
  before its section moves out (`roomIsPlaying` was; `arcTitleFor` already had been).
- **The slice call order in `renderVals` is load-bearing**: `this.artWanted = []` runs once before
  them all, and `unitsVals` → `armsVals` → `artVals` is the order the three `artSrc` call sites
  enqueue in, which *is* the strip art loading priority. Key order is not load-bearing (verified: no
  duplicate keys across the whole `vals`), but evaluation order is.
- **Never write the template block's literal opening tag in an HTML comment in `index.html`.**
  `boot()` re-fetches the page and finds the template with a *regex* (`support.js:39`), which does
  not know about comments — a stray one swallows the `<head>` scripts into the template. This was a
  live bug during the split.
- **Adding a page** = a new `wf-*.js` + its `xVals(ctx)` + one line in `renderVals` + one
  `<script>` tag + one name in the `Object.assign`. **A new page also means a new hash route** —
  `wf-route.js` derives the URL from `state`, so a tab it doesn't know about still gets `#<tab>`,
  but anything selectable inside it (an id worth linking to) needs a line in `routeHashFromState`
  and a branch in `routeApply`. See "Routing & document head" in `ARCHITECTURE.md`.
- **`wf-route.js` is the one file with no screen**: no `xVals`, no `renderVals` line. It hangs off
  `componentDidMount` (`routeInstall`) and `componentDidUpdate` (`drainPendingRoute` → `syncRoute`
  → `syncDocumentTitle`) instead.
- **Cost accepted:** code outside the `data-dc-script` block is invisible to the omelette design
  tool. The tool's source isn't in this repo and the site is hand-maintained, so this is fine — but
  it does mean the split is one-way as far as that tool is concerned.

### Single component, tab-based navigation

One `Component` instance; `state.tab` (`'home' | 'units' | 'story' | 'flip' | 'music' | 'arms' |
'art' | 'detail'`) drives `<sc-if>` visibility — no router. `go(tab)` switches; `this.sections`
holds per-tab metadata.

The **Units** tab fetches `roster.json` once (`componentDidMount`), **sorts** it (rarity desc,
then attribute in `ELEMENT_ORDER` = Fire/Water/Thunder/Wind/Light/Dark, then `devName` — the
file's own order is just append history), and paginates client-side (`ROSTER_BATCH` = 60 per
scroll batch via `handleRosterScroll`). `goDetail(c)` opens the per-character detail view. What is
paged in is not what has its portrait loaded — see "Strip art window" in `ARCHITECTURE.md` before touching either
strip's grid, its scroll handler or `restoreUnitsScroll`.

**Every tab now has a real screen.** The `isSection` under-construction placeholder (and its
`underConstruction*` / `backToHome` / `imageSlotPlaceholder` strings, the `sectionSlotId` val and
the `wfFloat` keyframe) was deleted when the art tab shipped its gallery wall — `art` was its last
consumer. `sections`/`sectionLabel`/`sectionDesc`/`sectionColor` stay: the real screens use them
for their banners. `image-slot.js` now has no `<image-slot>` in the template at all; the tag stays
because it's authoring-tool scaffold, inert at runtime.

The home screen's centre red button opens **`flip`**, not `units` — Units keeps its bottom-tab-bar
button and its menu entry, which is the only reason repointing it strands nothing.

### 各屏与子系统的深水区 → `ARCHITECTURE.md`

每个 tab 和每个 UI 子系统的完整文档都在 **`ARCHITECTURE.md`** —— 动下表任何一块之前，先读
那份文件的对应小节。这里只留索引和跨屏铁律。

| `ARCHITECTURE.md` 小节 | 代码位置 |
| --- | --- |
| Backgrounds: the magic circle | `index.html` `<helmet>` 的 `.wf-circle` CSS |
| The fixed canvas: scaling and zoom（430x860 画布、fill/card、禁用缩放） | `wf-core.js` `computeLayout` + `index.html` `updateScale` |
| Armaments tab（武器库 / 武器详情） | `wf-arms.js` |
| Story tab（剧情档案） | `wf-story.js` |
| Art tab（画廊：story wall + 官方推特 X wall） | `wf-art.js` |
| Flip tab（弹弹 art voting） | `wf-flip.js` |
| Music Room + 悬浮 mini-player + 共享音频引擎 | `wf-music.js` |
| Units filter / Units grid tile | `wf-units.js`（图块模板在 `index.html`） |
| Strip art window / Strip art loader（iOS 崩溃修复，两条条带共用） | `wf-units.js` |
| Character detail bottom sheet（面板切换、剧情头像、hero 图） | `wf-detail.js` |
| Emotion layers（脸 vs. 叠加层） | `wf-detail.js` |
| Loading placeholder（`.wf-loading`：Alk 行走 GIF + 逐字波浪文案，全站十二处；含详情页大图的 `heroSrc`） | CSS、`loadingWave()`、`heroSrc()` 在 `index.html`，调用点在各 `wf-*.js` |
| Section headings（`.wf-sec-title`：居中标题 + 左右花纹 rail，全站二十一处） | `index.html` `<helmet>` 的 `.wf-sec-title` CSS，调用点在模板里 |
| Supabase（访问计数 + 投票，与 R2 无关） | 配置在 `wf-core.js`，helpers 在 `wf-chrome.js`，投票在 `wf-flip.js`；`supabase-*.sql` |
| Routing & document head（hash 深链接、标题、返回键 / Esc / 方向键、og 卡片） | `wf-route.js` + `index.html` 真实 `<head>` + `scripts/build-social-card.mjs` |

跨屏铁律（出处和细节都在 `ARCHITECTURE.md` 对应小节）：

- **前缀纪律。** 每个 feature 的 state/handlers/`renderVals` 键都带自己的前缀：`arc`（剧情
  档案）、`arm`（武器库）、`gal`/`twt`（画廊两面墙）、`flip`（投票）、`room`（音乐室）。裸的
  `art*`/`music*`/`story*` 早已有主（详情页觉醒切换 / 角色主题 pills / 角色故事面板），新
  feature 一律起新前缀；只有 tab 导航标识（`isArms`/`goArt`/`sections.*`）例外。
- **指针 delta 除以 `state.scale`，布局量不除。** 拖拽（sheet/flip/mini-player）的 delta 是
  屏幕 px，必须 `/state.scale`；`scrollTop`/`scrollLeft` 是元素自身盒内的布局量、seek 条是
  比例，都不除——除了就是 X 墙窗口差 17% 的那个线上 bug。
- **`filteredX()` 单一来源 + draft/commit。** 过滤结果由一个函数（`filteredRoster` /
  `filteredWeapons` / `galFiltered`）同时喂 `renderVals` 和分页；应用过滤要重置
  visibleCount、scrollTop 和窗口列。过滤对话框一律 draft/commit 双份（`cloneFilter` 拷贝
  组数组），组内 OR、组间 AND、空组失效。
- **一个共享 `this.audio`，`audioOwner` 决定谁能停它。** 房间播放故意跨 tab 存活，停音频前
  先查 owner；角色主题和剧情 BGM 都通过 `detailCharQueue`/`arcBgmQueue` 走音乐室引擎。
- **几百张图的列表必须走 `artSrc` 并发闸门 + 艺术窗口**（只给窗口内的 tile 真实 URL，窗口
  外 `src=""`）。直接给长列表塞 src 就是 iOS 杀 tab 的那一类 bug。
- **加载占位统一走 `.wf-loading` 三件套**：`index.html` 的共享方法 `loadingWave(key)` +
  `<helmet>` 里的 `wf-loading*` CSS 类 + `icons/alk_walk.gif`。新屏别再自己写一行灰字；
  模板没有 partial 机制，那 5 行标记本来就是逐处重复的，视觉细节一律留在 CSS 类里。
  **GIF 必须留在 `icons/`**（详见 `ARCHITECTURE.md` 的 "Loading placeholder"）。
- **板块标题统一走 `.wf-sec-title`**（`<div class="wf-sec-title"><span>{{ label }}</span></div>`，
  两条花纹 rail 是伪元素）；别再内联那三行 div。**区块内部的子标题一律不加花纹**，保持原来的
  小灰字（最大效果 / 叠加配件 / Quotes）—— 这些板块没有自己的边框，层级全靠这个差别撑着。
  两张 PNG 同样必须留在 `icons/`（详见 `ARCHITECTURE.md` 的 "Section headings"）。
- **等图片而不是等 fetch 的占位走 `heroSrc`，不要走 `artSrc`。** `artSrc` 那条队列有 16 并发
  上限，而 `unitsVals` 即使在详情页打开时也照常给条带的图入队 —— 大图挤进去就会排在一屏
  40px 头像后面。`heroSrc` 是同样的机制但独立队列、不设闸门，只适合同时一两张的大图。
- **URL 由 state 推出来，导航函数一概不碰 URL。** `syncRoute` 挂在 `componentDidUpdate` 上，从
  `routeHashFromState()` 算出 hash 再写；`go`/`goDetail`/`goArmDetail`/`openArcStory` 等十几个
  入口全部保持原样。**新增一处可深链接的选中态，改的是 `routeHashFromState` 和 `routeApply`，
  不是那些导航函数。** 只用 hash、不用 `pushState`：本地开发是 `file://`，那里 `pushState` 抛
  SecurityError。
- **深链接打开一个屏幕，不等于那个屏幕会显示。** 屏幕内的次级状态（`arcTab` 之流）是从界面路径
  里顺带设好的，深链接没走那条路径。剧情阅读器就踩过：`arcEpisodeIndex` 设对了，但
  `arcShowReader` 还要 `arcTab === 'story'`，于是 state 全对、屏幕上还是情报页（`wf-route.js`
  里 `setArcTab('story')` 那几行）。新增深链接目标时，先确认渲染它的那个 val 还依赖什么。

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
pipeline outputs (`wiki_zh.json`, `voice/`, `story_zh.json`, `emotion/`). Music plays through the shared
Music Room engine (`detailCharQueue` → `roomToggleTrack`; see `ARCHITECTURE.md`), rendered as pill buttons
when `music.length > 0`.

