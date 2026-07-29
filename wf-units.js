// 角色名册 + 五组筛选 + 两条 strip 的美术窗口与加载闸（武器库和 X 墙也调用这里的 artSrc/gridWindow） —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。

const ROSTER_BATCH = 60;
// The Units filter, ported from miaowm5's dialog/filterCharacter.svelte. Its rarity chips run
// 5*->1* and its element chips follow ELEMENT_ORDER, both matching upstream's own ordering.
//
// Upstream also offers a rarity "Other" (its NPC bucket, rarity 0) and an element "Other" (-1).
// Both are dropped here: this site's roster is characters only — every one of the 485 has a
// rarity of 1-5 and an element of 0-5 — so those two chips could only ever match nothing.
const FILTER_GENDERS = ['Female', 'Male', 'Other'];
const FILTER_RACES = ['Human', 'Element', 'Devil', 'Beast', 'Machine', 'Mystery', 'Dragon', 'Undead', 'Aquatic', 'Plants'];
const EMPTY_FILTER = { text: '', rarity: [], element: [], gender: [], race: [] };
// The group arrays have to be copied too — a shallow spread would let the dialog's draft mutate
// the applied filter's arrays in place, so Cancel wouldn't actually cancel.
function cloneFilter(f) {
  return {
    text: f.text,
    rarity: f.rarity.slice(),
    element: f.element.slice(),
    gender: f.gender.slice(),
    race: f.race.slice()
  };
}

// 挂到 Component.prototype 上（见 index.html 里 class 声明之后的 Object.assign）。
const WF_UNITS = {
  restoreUnitsScroll(tries = 3) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById('units-scroll');
        // Retry while the element is still unmounted, then point the art window at whatever
        // scrollLeft the element actually accepted, so the loaded portraits are the ones the user
        // is about to look at rather than the ones they left.
        if (!el) { if (tries > 0) this.restoreUnitsScroll(tries - 1); return; }
        el.scrollLeft = this.unitsScrollLeft;
        this.syncGridWindow(el.scrollLeft, 'unitsWinCol');
      });
    });
  },
  artSrc(url) {
    if (!url) return '';
    if (this.artLoaded.has(url)) return url;
    this.artWanted.push(url);
    return '';
  },
  // Called after a commit, never during renderVals: the queue is rebuilt from whatever the last
  // render actually asked for, so scrolling away from a batch de-prioritizes it instead of leaving
  // the gate working through art nobody is looking at any more.
  pumpArt() {
    for (const url of this.artWanted) {
      if (this.artInflight.size >= ART_MAX_INFLIGHT) break;
      if (this.artLoaded.has(url) || this.artInflight.has(url)) continue;
      this.artInflight.add(url);
      const img = new Image();
      const done = () => {
        this.artInflight.delete(url);
        this.artLoaded.add(url);
        this.scheduleArtRender();
        this.pumpArt();
      };
      // An error is "done" too: retrying a 404 forever would hold a slot hostage.
      img.onload = done;
      img.onerror = done;
      img.src = url;
    }
  },
  scheduleArtRender() {
    if (this.artRenderTimer) return;
    this.artRenderTimer = setTimeout(() => {
      this.artRenderTimer = 0;
      this.setState(s => ({ artVersion: s.artVersion + 1 }));
    }, ART_BATCH_MS);
  },
  gridWinCol(scrollLeft) {
    return Math.max(0, Math.floor(scrollLeft / GRID_COL_PITCH) - GRID_WINDOW_COLS);
  },
  // `total` is the paginated item count (visibleCount / armVisibleCount) — an item that hasn't
  // been paged in has no column and so can't be in the window.
  gridWindow(total, winCol) {
    const totalCols = Math.ceil(total / GRID_ROWS);
    // Viewport's worth of columns plus the buffer on both sides.
    const spanCols = Math.ceil(DESIGN_W / GRID_COL_PITCH) + GRID_WINDOW_COLS * 2;
    const from = Math.max(0, Math.min(winCol, totalCols - spanCols));
    const to = Math.min(totalCols, from + spanCols);
    return { start: from * GRID_ROWS, end: to * GRID_ROWS };
  },
  // Recompute only once the scroll has drifted a few columns rather than on every scroll event:
  // each change loads the art entering the window, so the buffer is what keeps a flick from
  // requesting the whole roster.
  updateGridWindow(scrollLeft, key) {
    const want = this.gridWinCol(scrollLeft);
    if (Math.abs(want - this.state[key]) < GRID_RECENTER_COLS) return;
    this.setState({ [key]: want });
  },
  // Same thing without the drift tolerance, for the one caller that knows the window is out of
  // step with the strip rather than merely drifting (the scroll restore).
  syncGridWindow(scrollLeft, key) {
    const want = this.gridWinCol(scrollLeft);
    if (want !== this.state[key]) this.setState({ [key]: want });
  },
  // Backstop, run after every render. A strip only reports its position through onScroll, so a
  // remount that lands on a scrollLeft nobody told us about (the restore missing its frame, the
  // browser clamping the position when a filter shrinks the list) would leave the loaded art a
  // screen or more away from what's on show. Gated on the viewport being fully outside the buffer,
  // so the deliberate few-column drift the scroll handler allows never re-renders through here.
  healStripWindows() {
    for (const [id, key] of [['units-scroll', 'unitsWinCol'], ['arms-scroll', 'armWinCol']]) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (Math.abs(this.gridWinCol(el.scrollLeft) - this.state[key]) <= GRID_WINDOW_COLS) continue;
      this.syncGridWindow(el.scrollLeft, key);
    }
  },
  handleUnitsWheel(e) {
    // Both the Units roster and the Armaments library are horizontal strips (#units-scroll /
    // #arms-scroll); the same deltaY→scrollLeft translation drives both.
    if (this.state.tab !== 'units' && this.state.tab !== 'arms') return;
    const el = e.target && e.target.closest ? e.target.closest('#units-scroll, #arms-scroll') : null;
    if (!el) return;
    // Trackpads and tilt wheels send real horizontal intent as deltaX — leave those native.
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const step = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
    el.scrollLeft += e.deltaY * step;
    e.preventDefault();
  },
  openFilter() {
    // Re-seed the draft from the applied filter so a cancelled edit leaves no trace.
    this.setState(s => ({ filterOpen: true, draftFilter: cloneFilter(s.filter) }));
  },
  closeFilter() {
    this.setState({ filterOpen: false });
  },
  applyFilter() {
    // Snap back to the first batch: the old visibleCount belongs to the previous result set,
    // and keeping it would show a scroll position the new, shorter list can't support.
    this.setState(s => ({
      filterOpen: false,
      filter: cloneFilter(s.draftFilter),
      visibleCount: ROSTER_BATCH,
      // The window belongs to the old result set too — a filter that leaves 8 matches has no
      // column 30 to be scrolled to.
      unitsWinCol: 0
    }));
    this.unitsScrollLeft = 0;
    this.restoreUnitsScroll();
  },
  toggleFilterChip(group, value) {
    this.setState(s => {
      const draft = cloneFilter(s.draftFilter);
      const i = draft[group].indexOf(value);
      if (i === -1) draft[group].push(value);
      else draft[group].splice(i, 1);
      return { draftFilter: draft };
    });
  },
  setFilterText(e) {
    const text = e.target.value;
    this.setState(s => ({ draftFilter: { ...cloneFilter(s.draftFilter), text } }));
  },
  // The grid's real source list — renderVals paints it and handleRosterScroll paginates it, so
  // both have to agree on the count or scrolling would keep paging past the last match.
  filteredRoster() {
    const f = this.state.filter;
    return this.state.roster.filter(c => this.matchesFilter(c, f));
  },
  matchesFilter(c, f) {
    if (f.rarity.length && !f.rarity.includes(c.rarity)) return false;
    if (f.element.length && !f.element.includes(c.elementIndex)) return false;
    if (f.gender.length && !f.gender.includes(c.gender)) return false;
    // A character can hold several races ("Human,Beast"), so this is "any of the picked ones".
    if (f.race.length && !c.race.some(r => f.race.includes(r))) return false;
    if (f.text) {
      // Upstream searches its two name fields; ours are up to three, and which one is on screen
      // depends on state.lang — so match against all of them and let either script work.
      const hay = [c.enName, c.zhName, c.jpName].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(f.text.trim().toLowerCase())) return false;
    }
    return true;
  },
  handleRosterScroll(e) {
    const el = e.currentTarget;
    this.unitsScrollLeft = el.scrollLeft;
    this.updateGridWindow(el.scrollLeft, 'unitsWinCol');
    if (el.scrollLeft + el.clientWidth < el.scrollWidth - 500) return;
    const total = this.filteredRoster().length;
    this.setState(s => ({ visibleCount: Math.min(total, s.visibleCount + ROSTER_BATCH) }));
  },
  // The community sheet's unit records: English names for the 108 miaowm5-only characters that no
  // wiki documents, their epithets, and a playthrough video per character episode. English only,
  // fetched once, and non-critical — a failure just leaves the Chinese fallbacks in place.
  loadUnitsEn() {
    if (this.state.lang !== 'en' || this.unitsEn || this.unitsEnPending) return;
    this.unitsEnPending = true;
    fetch(ASSET_BASE + '/units_en.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(data => {
        this.unitsEnPending = false;
        this.unitsEn = (data && data.characters) || {};
        // Patch in the names the roster genuinely lacks. `hasEnName` is what says who those are:
        // the roster mapping already fell back to zhName, so the field itself can't tell us.
        let patched = 0;
        for (const c of this.state.roster || []) {
          const rec = this.unitsEn[c.devName];
          if (!rec || !rec.name || c.hasEnName) continue;
          c.enName = rec.name;
          c.hasEnName = true;
          patched++;
        }
        // The roster array is mutated in place (rosterByDev holds the same objects), so nothing
        // downstream needs rebuilding — but renderVals has to be told to run again.
        this.setState({ unitsEnVersion: (this.state.unitsEnVersion || 0) + 1 });
      });
  },

  // renderVals 的本页分段：计算段 + vals 字面量段，逐字搬自 index.html。
  // 只吃 ctx 里的共享量（sec），其余一律走 this —— 见 CLAUDE.md 的文件地图。
  unitsVals(ctx) {
    const { sec } = ctx;
    // The filter narrows the roster before pagination, so `visibleCount` counts matches rather
    // than raw entries — otherwise a narrow filter would page through mostly-hidden batches.
    const filter = this.state.filter;
    const roster = this.filteredRoster();
    const pagedRoster = roster.slice(0, this.state.visibleCount);
    // Every paged-in tile renders; its two images are gated twice over — on the art window (see
    // gridWindow), so only tiles near the scroll position ask for art at all, and then on the
    // loader (see artSrc), so at most ART_MAX_INFLIGHT of those are being fetched at any moment.
    // The pedestal, stars and name are unconditional, so a tile always occupies its box.
    // Every render rebuilds the wanted-art queue in on-screen order (see pumpArt).
    // 注意 artWanted 的清空不在这里，而在 renderVals 里 —— 它必须在所有分段之前只做一次。
    const unitsWin = this.gridWindow(pagedRoster.length, this.state.unitsWinCol);
    const visibleRoster = pagedRoster.map((c, i) => {
      const inWin = i >= unitsWin.start && i < unitsWin.end;
      // Both of the tile's own images go through the gate: 482 tiles carry a portrait and a
      // sprite each, and it was the two together that peaked at 354 parallel requests.
      const headSrc = this.artSrc(c.hasHead && inWin ? c.headUrl : '');
      const thumbSrc = this.artSrc(inWin ? c.thumbUrl : '');
      return {
        ...c,
        headSrc, thumbSrc,
        showHead: !!headSrc,
        showThumb: !!thumbSrc,
        displayName: (this.state.lang === 'zh' && c.zhName) ? c.zhName : c.enName,
        hasMusic: !!(c.music && c.music.length),
        onSelect: () => this.goDetail(c)
      };
    });
    const unitsStatusText = this.state.rosterLoading
      ? this.t('loadingRoster')
      : this.state.rosterError
        ? this.t('failedToLoadRoster')
        : pagedRoster.length + ' / ' + roster.length + this.t('unitsShownSuffix');

    // Chip lists for the filter dialog. Each carries its own label, icon and active flag, so the
    // template stays a plain sc-for with no lookups of its own.
    const draft = this.state.draftFilter;
    const chip = (group, value, labelKey, iconUrl) => ({
      label: this.t(labelKey),
      iconUrl: iconUrl || '',
      hasIcon: !!iconUrl,
      // #ffcf8f is upstream's own `.choice.active` colour.
      chipBg: draft[group].includes(value) ? '#FFCF8F' : '#FAFAFA',
      onToggle: () => this.toggleFilterChip(group, value)
    });
    const rarityChips = FILTER_RARITIES.map(r =>
      chip('rarity', r, 'filterRarity' + r, 'icons/rarity_' + r + '.png'));
    const elementChips = ELEMENT_ORDER.map((name, i) =>
      chip('element', i, 'filterElement' + name, 'icons/element_' + i + '.png'));
    const genderChips = FILTER_GENDERS.map(g => chip('gender', g, 'filterGender' + g));
    const raceChips = FILTER_RACES.map(r =>
      chip('race', r, 'filterRace' + r, 'icons/race_' + r + '.png'));
    // A badge on the button, so an active filter is visible without opening the dialog.
    const filterCount =
      filter.rarity.length + filter.element.length + filter.gender.length + filter.race.length +
      (filter.text ? 1 : 0);
    return {
      rosterLoading: this.state.rosterLoading,
      rosterError: this.state.rosterError,
      showRosterGrid: !this.state.rosterLoading && !this.state.rosterError && roster.length > 0,
      showRosterEmpty: !this.state.rosterLoading && !this.state.rosterError && roster.length === 0,
      visibleRoster: visibleRoster,
      unitsStatusText: unitsStatusText,
      handleRosterScroll: (e) => this.handleRosterScroll(e),
      // --- Units filter ---
      showFilterButton: !this.state.rosterLoading && !this.state.rosterError,
      filterOpen: this.state.filterOpen,
      hasFilterCount: filterCount > 0,
      filterCount: filterCount,
      filterTitleText: this.t('filterTitle'),
      filterNameTitle: this.t('filterName'),
      filterNameHint: this.t('filterNameHint'),
      filterNameValue: draft.text,
      filterRarityTitle: this.t('filterRarity'),
      filterElementTitle: this.t('filterElement'),
      filterGenderTitle: this.t('filterGender'),
      filterRaceTitle: this.t('filterRace'),
      filterOkText: this.t('filterOk'),
      filterCancelText: this.t('filterCancel'),
      filterNoMatchText: this.t('filterNoMatch'),
      rarityChips: rarityChips,
      elementChips: elementChips,
      genderChips: genderChips,
      raceChips: raceChips,
      openFilter: () => this.openFilter(),
      closeFilter: () => this.closeFilter(),
      applyFilter: () => this.applyFilter(),
      setFilterText: (e) => this.setFilterText(e),
    };
  },};
