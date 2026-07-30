// 画廊（gal*）+ 官方推特墙（twt*）：Art 标签页的两面墙，见 ARCHITECTURE.md 的 Art tab 一节 —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。

// --- The official X (Twitter) media wall (画廊's second source) --------------------------------
// Everything for this feature is `twt`-prefixed, for the reason the gal block states: `gal*` is
// the story wall, `art*` is already the detail hero's awaken toggle and the Flip voting feature,
// and a bare `x*` would read as the x-dc runtime.
const TWT_STATUS_URL = 'https://x.com/world_flipper/status/';
const TWT_BATCH = 60;
// The wall's art window, in design px: how far above and below the viewport a tile's thumbnail is
// worth holding. See the strip art window above — same problem, vertical. Pagination alone is not
// enough here: `twtVisibleCount` only grows and `loading="lazy"` only defers the *first* load
// (it never unloads), so scrolling the whole 1429-tile wall would otherwise leave every thumbnail
// it ever paged in attached to its tile — 36.9MB encoded, up to 575MB decoded, for the session.
const TWT_WIN_PX = 1600;
// Re-window only after this much scroll — each change loads whatever art enters the window, so
// this is what stops a flick from requesting the whole wall (GRID_RECENTER_COLS' job on the strips).
const TWT_WIN_DRIFT = 400;
const GAL_SOURCES = ['story', 'x'];
// The archive carries no captions, titles or tags — gallery-dl wrote no sidecars, so a file's name
// is the whole record (see build-x-index.mjs). Year and media type are the only two axes the data
// can support, and they are this filter's two groups. Years are derived from the loaded data
// rather than hardcoded, the way the weapon filter's 能力 chips are.
const EMPTY_TWT_FILTER = { year: [], type: [] };
function cloneTwtFilter(f) {
  return { year: f.year.slice(), type: f.type.slice() };
}
const TWT_TYPES = ['image', 'video'];
function twtDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function twtDateLong(ts, lang) {
  const d = new Date(ts);
  return lang === 'zh'
    ? d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// 挂到 Component.prototype 上（见 index.html 里 class 声明之后的 Object.assign）。
const WF_ART = {
  loadGalleryIndex() {
    if (this.state.galIndex !== null || this.state.galLoading) return;
    this.setState({ galLoading: true });
    fetch(ASSET_BASE + '/story/gallery_index.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(data => this.setState({ galIndex: (data && data.images) || [], galLoading: false }))
      .catch(err => {
        console.error('[art] failed to load story/gallery_index.json', err);
        this.setState({ galIndex: false, galLoading: false });
      });
  },
  // The single source for renderVals and for anything paginating later — the same discipline
  // filteredRoster()/filteredWeapons() keep. 64 images needs no pagination; revisit past ~200.
  galFiltered() {
    const all = this.state.galIndex || [];
    const cat = this.state.galCategory;
    return cat === 'all' ? all : all.filter(im => im.category === cat);
  },
  // galViewer is an index into the *filtered* list, so it has to be cleared here: the same index
  // means a different image once the category changes.
  setGalCategory(category) {
    this.setState({ galCategory: category, galViewer: null });
    this.scrollGalTop();
  },
  scrollGalTop() {
    requestAnimationFrame(() => {
      const el = document.getElementById('gallery-scroll');
      if (el) el.scrollTop = 0;
    });
  },
  // The two-column masonry both walls use. Packed here rather than by CSS: `column-count: 2` fills
  // column-wise (1..n down the left, then the rest down the right), so on a scrolling wall you pass
  // the whole first half before reaching item 2's neighbour; `column-fill: auto` fixes the order but
  // needs a fixed container height, which a filtered list doesn't have. Since both indexes carry
  // every image's w/h, packing is pure arithmetic: no measuring, no reflow, and each tile's
  // aspect-ratio reserves its exact box on the first frame.
  //
  //   430 canvas - 14px padding each side = 402 inner; minus the 8px gutter, halved -> 197px.
  //
  // Shortest-column packing is prefix-stable — placing items[0..N) is exactly the first N placements
  // of packing the whole list, because each decision depends only on the items before it — so paging
  // another batch into the X wall never re-flows anything already on screen. `makeTile` gets the
  // tile's top offset and height in design px, which is what that wall's art window reads.
  galPack(items, makeTile) {
    const COL_W = 197, GAP = 8;
    const cols = [{ h: 0, tiles: [] }, { h: 0, tiles: [] }];
    items.forEach((im, i) => {
      // Exact, because the caption is an overlay rather than a block below the image — a wrapping
      // title would turn this into an estimate and drift the two columns apart.
      const tileH = Math.round(COL_W * im.h / im.w);
      // Ties go left, so the reading order runs left, right, left, right.
      const col = cols[0].h <= cols[1].h ? cols[0] : cols[1];
      col.tiles.push(makeTile(im, i, col.h, tileH));
      col.h += tileH + GAP;
    });
    return cols;
  },
  openGalViewer(i) { this.setState({ galViewer: i }); },
  closeGalViewer() { this.setState({ galViewer: null }); },
  // Wraps at both ends, like roomStep's manual prev/next.
  galViewerStep(delta) {
    const n = this.galFiltered().length;
    if (!n) return;
    this.setState(s => ({ galViewer: ((s.galViewer + delta) % n + n) % n }));
  },
  // Swipe between images. Follows the sheetPointerDown convention (window listeners so the gesture
  // survives leaving the element, deltas divided by state.scale because the whole 430px canvas is
  // CSS-scaled) with one deliberate simplification: nothing is committed until pointerup, so the
  // drag causes zero renders. renderVals rebuilds the roster tiles and story lists on every render,
  // which is what forced the Flip deck's drag into rAF-coalescing — this one sidesteps it entirely.
  galViewerDown(e) {
    const startX = e.clientX, startY = e.clientY;
    const up = (ev) => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const dx = (ev.clientX - startX) / this.state.scale;
      const dy = (ev.clientY - startY) / this.state.scale;
      if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
      this.galViewerStep(dx < 0 ? 1 : -1);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  },
  loadXIndex() {
    if (this.state.twtIndex !== null || this.state.twtLoading) return;
    this.setState({ twtLoading: true });
    fetch(X_BASE + '/x_index.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(data => {
        const media = (data && data.media) || [];
        // Stamp the year once, here, the way loadWeapons stamps roleTokens: the filter chips need a
        // plain comparable string, and deriving it in renderVals would be 1429 Date constructions
        // on every render of any tab.
        for (const m of media) m.year = String(new Date(m.ts).getFullYear());
        this.setState({ twtIndex: media, twtLoading: false });
      })
      .catch(err => {
        console.error('[art] failed to load x_index.json', err);
        this.setState({ twtIndex: false, twtLoading: false });
      });
  },
  // The single source for renderVals, pagination and the viewer — filteredRoster()/filteredWeapons()
  // discipline. OR within a group, AND across groups, an empty group inert.
  twtFiltered() {
    const all = this.state.twtIndex || [];
    const f = this.state.twtFilter;
    if (!f.year.length && !f.type.length) return all;
    return all.filter(m =>
      (!f.year.length || f.year.includes(m.year)) &&
      (!f.type.length || f.type.includes(m.video ? 'video' : 'image')));
  },
  // Both walls share #gallery-scroll, and a viewer index points into whichever filtered list it was
  // opened from — so switching source clears both and starts at the top.
  setGalSource(src) {
    if (this.state.galSource === src) return;
    this.stopTwtVideo();
    this.setState({ galSource: src, galViewer: null, twtViewer: null });
    if (src === 'x') this.loadXIndex();
    this.scrollGalTop();
  },
  // The vertical counterpart of handleRosterScroll: page in another batch near the end, and move
  // the art window with the scroll. Both setStates are guarded — an unguarded one here would
  // re-render the whole tree on every scroll event. No-ops on the story wall (64 tiles, no window).
  handleGalScroll(e) {
    if (this.state.galSource !== 'x') return;
    const el = e.currentTarget;
    // No `/ state.scale` here, unlike the sheet and Flip drags: those divide *pointer* coordinates,
    // which arrive in screen px. scrollTop is a layout metric in the element's own box, and a CSS
    // transform doesn't touch layout — so it is already the design px galPack works in. Dividing
    // put the window ~17% past the real position, which at the foot of a 79,576px wall missed the
    // end by ~13,600px and left every tile there without art.
    const top = el.scrollTop;
    if (Math.abs(top - this.state.twtWinTop) > TWT_WIN_DRIFT) this.setState({ twtWinTop: top });
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 600) return;
    const total = this.twtFiltered().length;
    if (this.state.twtVisibleCount >= total) return;
    this.setState(s => ({ twtVisibleCount: Math.min(total, s.twtVisibleCount + TWT_BATCH) }));
  },
  openTwtViewer(i) { this.setState({ twtViewer: i }); },
  closeTwtViewer() { this.stopTwtVideo(); this.setState({ twtViewer: null }); },
  // The <video> element is a single node inside an sc-if, not a keyed list item, so it is reused
  // across an index change: handing it a new src alone leaves the old clip playing for a beat and,
  // on iOS, audible. Detach synchronously, before the state change that swaps the item.
  stopTwtVideo() {
    const v = document.getElementById('twt-video');
    if (!v) return;
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
  },
  twtViewerStep(delta) {
    const n = this.twtFiltered().length;
    if (!n) return;
    this.stopTwtVideo();
    this.setState(s => ({ twtViewer: ((s.twtViewer + delta) % n + n) % n }));
  },
  // galViewerDown's zero-render swipe, with one addition: on a video it does nothing, because a
  // horizontal drag there belongs to the native seek bar. The ‹ › buttons still move.
  twtViewerDown(e) {
    const cur = this.twtFiltered()[this.state.twtViewer];
    if (cur && cur.video) return;
    const startX = e.clientX, startY = e.clientY;
    const up = (ev) => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const dx = (ev.clientX - startX) / this.state.scale;
      const dy = (ev.clientY - startY) / this.state.scale;
      if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
      this.twtViewerStep(dx < 0 ? 1 : -1);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  },
  // X media filter dialog — the Units/Armaments filter's draft/commit semantics on twtFilter.
  openTwtFilter() {
    this.setState(s => ({ twtFilterOpen: true, twtDraftFilter: cloneTwtFilter(s.twtFilter) }));
  },
  closeTwtFilter() { this.setState({ twtFilterOpen: false }); },
  applyTwtFilter() {
    this.stopTwtVideo();
    this.setState(s => ({
      twtFilterOpen: false, twtFilter: cloneTwtFilter(s.twtDraftFilter),
      // All three describe the previous result set: the page count, the window position, and an
      // index that now means a different item (applyArmFilter resets its strip the same way).
      twtVisibleCount: TWT_BATCH, twtWinTop: 0, twtViewer: null
    }));
    const el = document.getElementById('gallery-scroll');
    if (el) el.scrollTop = 0;
  },
  toggleTwtFilterChip(group, value) {
    this.setState(s => {
      const draft = cloneTwtFilter(s.twtDraftFilter);
      const i = draft[group].indexOf(value);
      if (i === -1) draft[group].push(value); else draft[group].splice(i, 1);
      return { twtDraftFilter: draft };
    });
  },

  // renderVals 的本页分段：计算段 + vals 字面量段，逐字搬自 index.html。
  // 只吃 ctx 里的共享量（tab, sec），其余一律走 this —— 见 CLAUDE.md 的文件地图。
  artVals(ctx) {
    const { tab, sec } = ctx;
    // --- Art tab: the gallery wall --------------------------------------------------------------
    // Two-column masonry, packed here rather than by CSS. `column-count: 2` fills column-wise
    // (1..n down the left, then the rest down the right), which on a scrolling wall means you pass
    // the whole first half before reaching item 2's neighbour; `column-fill: auto` would fix the
    // order but needs a fixed container height, which a filtered list doesn't have. Since
    // gallery_index.json carries every image's w/h, packing is pure arithmetic: no measuring, no
    // reflow, and each tile's aspect-ratio reserves its exact box on the first frame.
    //
    //   430 canvas - 14px padding each side = 402 inner; minus the 8px gutter, halved -> 197px.
    const galOnTab = tab === 'art';
    const galShowStory = galOnTab && this.state.galSource === 'story';
    const galImages = this.galFiltered();
    const galViewerImage = (this.state.galViewer !== null && galImages[this.state.galViewer]) || null;
    let galColumns = [{ h: 0, tiles: [] }, { h: 0, tiles: [] }];
    if (galShowStory) {
      galColumns = this.galPack(galImages, (im, i) => ({
        thumbUrl: ASSET_BASE + '/' + (im.thumb || im.path),
        w: im.w,
        h: im.h,
        alt: im.title,
        caption: this.arcTitleFor(im),
        isOrb: im.type === 'orb',
        onClick: () => this.openGalViewer(i)
      }));
    }

    // --- Art tab: the official X media wall -----------------------------------------------------
    // The same packer over 1429 items instead of 64, so it also needs pagination and — the part
    // pagination alone doesn't solve — an art window. twtVisibleCount only ever grows, so without
    // one, scrolling the wall would leave every thumbnail it ever paged in attached to its tile
    // (36.9MB encoded, up to 575MB decoded), the way the roster's 485 portraits used to kill iOS
    // tabs. See TWT_WIN_PX for how much of that ceiling an engine actually holds.
    const twtShowX = galOnTab && this.state.galSource === 'x';
    const twtItems = twtShowX ? this.twtFiltered() : [];
    const twtViewerItem = (this.state.twtViewer !== null && twtItems[this.state.twtViewer]) || null;
    let twtColumns = [{ h: 0, tiles: [] }, { h: 0, tiles: [] }];
    if (twtShowX) {
      const winTop = this.state.twtWinTop;
      twtColumns = this.galPack(twtItems.slice(0, this.state.twtVisibleCount), (m, i, y, tileH) => {
        // Every paged-in tile still renders in its own place; only the one expensive image inside
        // it is gated on being near the scroll position — the strip art window's rule, vertical.
        // artSrc then gates concurrency on top, so a flick can't burst hundreds of requests.
        const inWin = y < winTop + TWT_WIN_PX && (y + tileH) > winTop - TWT_WIN_PX;
        return {
          thumbUrl: this.artSrc(inWin ? X_BASE + '/' + m.thumb : ''),
          w: m.w,
          h: m.h,
          alt: twtDate(m.ts),
          caption: twtDate(m.ts),
          isVideo: !!m.video,
          onClick: () => this.openTwtViewer(i)
        };
      });
    }
    const twtDraft = this.state.twtDraftFilter;
    const twtChip = (group, value, label) => ({
      label,
      chipBg: twtDraft[group].includes(value) ? '#FFCF8F' : '#FAFAFA',
      onToggle: () => this.toggleTwtFilterChip(group, value)
    });
    // Years come from the loaded data, not a table, so a re-scrape that adds a new year just works
    // — the same rule the weapon filter's 能力 chips follow. Newest first, matching the wall's sort.
    const twtYearChips = twtShowX
      ? [...new Set((this.state.twtIndex || []).map(m => m.year))].sort((a, b) => b.localeCompare(a))
          .map(y => twtChip('year', y, y))
      : [];
    const twtTypeChips = twtShowX ? TWT_TYPES.map(t => twtChip('type', t, this.t('twtType' + t))) : [];
    const twtFilterCount = this.state.twtFilter.year.length + this.state.twtFilter.type.length;
    return {
      // --- Art tab: the gallery wall ------------------------------------------------------------
      // Everything is `gal`-prefixed; see the state block for why. The view-models below only build
      // while the tab is showing — renderVals runs on every render regardless of tab, and packing
      // 64 tiles for nobody is the same waste the Music Room library views already guard against.
      isArt: tab === 'art',
      galCategoryChips: galOnTab ? ARC_CATEGORIES.map(c => ({
        label: this.t(c.labelKey),
        bg: this.state.galCategory === c.id ? '#ffcf8f' : '#FAFAFA',
        onClick: () => this.setGalCategory(c.id)
      })) : [],
      galColumns: galColumns,
      galCountText: this.t('galCount').replace('{n}', String(galImages.length)),
      galOrbLabel: this.t('galOrbLabel'),
      galShowLoading: this.state.galLoading,
      galShowError: this.state.galIndex === false,
      galShowEmpty: !this.state.galLoading && Array.isArray(this.state.galIndex) && galImages.length === 0,
      galLoadingText: this.t('galLoading'),
      galLoadingWave: this.loadingWave('galLoading'),
      galErrorText: this.t('galLoadError'),
      galEmptyText: this.t('galEmpty'),

      galViewerOpen: !!galViewerImage,
      galViewerUrl: galViewerImage ? ASSET_BASE + '/' + galViewerImage.path : '',
      galViewerAlt: galViewerImage ? this.arcTitleFor(galViewerImage) : '',
      galViewerTitle: galViewerImage ? this.arcTitleFor(galViewerImage) : '',
      galViewerCounter: galViewerImage ? (this.state.galViewer + 1) + ' / ' + galImages.length : '',
      galViewerHasOrb: !!(galViewerImage && galViewerImage.name),
      galViewerName: (galViewerImage && galViewerImage.name) || '',
      galViewerDesc: (galViewerImage && galViewerImage.desc) || '',
      closeGalViewer: () => this.closeGalViewer(),
      galViewerPrev: () => this.galViewerStep(-1),
      galViewerNext: () => this.galViewerStep(1),
      galViewerDown: (e) => this.galViewerDown(e),

      // --- Art tab: the source toggle and the official X media wall -----------------------------
      // `twt`-prefixed; see X_BASE. The two walls take turns owning #gallery-scroll, the way the
      // story tab's two views do, so only one set of columns is ever non-empty.
      galSourceChips: galOnTab ? GAL_SOURCES.map(id => ({
        label: this.t(id === 'story' ? 'galSourceStory' : 'galSourceX'),
        bg: this.state.galSource === id ? (sec ? sec.color : '#F0526E') : '#FFFFFF',
        color: this.state.galSource === id ? '#FFFFFF' : '#8A93A5',
        onClick: () => this.setGalSource(id)
      })) : [],
      galShowStory: galShowStory,
      galShowX: twtShowX,
      handleGalScroll: (e) => this.handleGalScroll(e),

      twtColumns: twtColumns,
      twtCountText: this.t('twtCount').replace('{n}', String(twtItems.length)),
      twtSourceText: this.t('twtSource'),
      twtShowLoading: this.state.twtLoading,
      twtShowError: this.state.twtIndex === false,
      twtShowEmpty: !this.state.twtLoading && Array.isArray(this.state.twtIndex) && twtItems.length === 0,
      twtLoadingText: this.t('twtLoading'),
      twtLoadingWave: this.loadingWave('twtLoading'),
      twtErrorText: this.t('twtLoadError'),
      twtEmptyText: this.t('twtEmpty'),

      // Filter dialog (the Units/Armaments port): applied count on the button, draft chips inside.
      twtFilterOpen: this.state.twtFilterOpen,
      twtFilterCount: twtFilterCount,
      hasTwtFilterCount: twtFilterCount > 0,
      twtYearChips: twtYearChips,
      twtTypeChips: twtTypeChips,
      twtFilterYearTitle: this.t('twtFilterYear'),
      twtFilterTypeTitle: this.t('twtFilterType'),
      openTwtFilter: () => this.openTwtFilter(),
      closeTwtFilter: () => this.closeTwtFilter(),
      applyTwtFilter: () => this.applyTwtFilter(),

      twtViewerOpen: !!twtViewerItem,
      twtViewerIsVideo: !!(twtViewerItem && twtViewerItem.video),
      twtViewerIsImage: !!(twtViewerItem && !twtViewerItem.video),
      twtViewerUrl: twtViewerItem ? X_BASE + '/' + twtViewerItem.file : '',
      twtViewerPoster: twtViewerItem ? X_BASE + '/' + twtViewerItem.thumb : '',
      twtViewerAlt: twtViewerItem ? twtDate(twtViewerItem.ts) : '',
      twtViewerDate: twtViewerItem ? twtDateLong(twtViewerItem.ts, this.state.lang) : '',
      // The tweet id is the filename's first field — derived for the one open item, not stored.
      twtViewerLink: twtViewerItem ? TWT_STATUS_URL + twtViewerItem.file.split('_')[0] : '',
      twtViewerLinkText: this.t('twtOpenOnX'),
      twtViewerCounter: twtViewerItem ? (this.state.twtViewer + 1) + ' / ' + twtItems.length : '',
      // Boolean DOM attributes have to arrive as truthy *strings*: the template compiler hands a
      // bare `controls` through as "", which React drops as falsy, and `{{ true }}` is a path
      // lookup for a key named "true", not a literal. Hence these two.
      twtVideoControls: 'controls',
      twtVideoPlaysInline: 'true',
      closeTwtViewer: () => this.closeTwtViewer(),
      twtViewerPrev: () => this.twtViewerStep(-1),
      twtViewerNext: () => this.twtViewerStep(1),
      twtViewerDown: (e) => this.twtViewerDown(e),
    };
  },};
