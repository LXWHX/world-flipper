// 武器库 / 武器详情（arm*）：见 CLAUDE.md 的 Armaments tab 一节 —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。

// --- Weapons (武器库 / 武器详情, the Armaments tab) -----------------------------------------
// Weapons carry a named element (the site's ELEMENT_ORDER) plus a non-elemental 'None' bucket —
// the filter's element chips run those seven. Rarity chips reuse FILTER_RARITIES; the third axis
// is the weapon's 能力/role, whose chips are derived from the data (roles can be comma-joined).
const ARM_ELEMENTS = [...ELEMENT_ORDER, 'None'];
const EMPTY_ARM_FILTER = { text: '', rarity: [], element: [], role: [] };
function cloneArmFilter(f) {
  return { text: f.text, rarity: f.rarity.slice(), element: f.element.slice(), role: f.role.slice() };
}
// A weapon's 能力 cell can list several roles ("生存,辅助"); split on comma / Chinese comma / slash
// so each becomes its own filter token.
function armRoleTokens(role) {
  return (role || '').split(/[,，、/]/).map(s => s.trim()).filter(Boolean);
}


// 挂到 Component.prototype 上（见 index.html 里 class 声明之后的 Object.assign）。
const WF_ARMS = {
  restoreArmsScroll(tries = 3) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById('arms-scroll');
        if (!el) { if (tries > 0) this.restoreArmsScroll(tries - 1); return; }
        el.scrollLeft = this.armsScrollLeft;
        this.syncGridWindow(el.scrollLeft, 'armWinCol');
      });
    });
  },
  loadWeapons() {
    if (this.state.armLoaded || this.state.armLoading) return;
    this.setState({ armLoading: true, armError: null });
    fetch(WEAPON_BASE + '/weapons.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching weapons.json'); return r.json(); })
      .then(data => {
        const weapons = (data.weapons || []).map(w => {
          const ped = PEDESTAL[w.element] || PEDESTAL_DEFAULT;
          const elementIndex = ELEMENT_ORDER.indexOf(w.element); // -1 for the non-elemental 'None'
          return {
            ...w,
            iconUrl: WEAPON_BASE + '/' + w.icon,
            // Shared UI art served with the site (not under WEAPON_BASE), same as the Units grid.
            rarityUrl: 'icons/rarity_' + w.rarity + '.png',
            rarityLabel: w.rarity + '★',
            elementIndex,
            elementIconUrl: elementIndex >= 0 ? 'icons/element_' + elementIndex + '.png' : '',
            roleTokens: armRoleTokens(w.role),
            pedestalTop: ped.top,
            pedestalSide: ped.side
          };
        })
        // Rarest first, then site element order (None last), then name — matches the scraper's order.
        .sort((a, b) =>
          b.rarity - a.rarity ||
          ARM_ELEMENTS.indexOf(a.element) - ARM_ELEMENTS.indexOf(b.element) ||
          a.nameZh.localeCompare(b.nameZh, 'zh'));
        this.setState({ armWeapons: weapons, armLoading: false, armLoaded: true });
        this.loadWeaponsEn();
      })
      .catch(err => {
        console.error('[arms] failed to load weapons.json', err);
        this.setState({ armLoading: false, armError: String(err && err.message || err) });
      });
  },
  // The English armament sidecar (scripts/scrape-wiki-gg-weapons.mjs), merged onto the loaded
  // records by `href` — the same merge key weapons.json itself uses. It's a sidecar rather than
  // extra columns on weapons.json because the two files come from different scrapers; see that
  // script's header. Only fetched in English, and only once. 316 of 384 weapons have an entry;
  // the rest keep showing Chinese, which is what armName()/armText() fall back to anyway.
  loadWeaponsEn() {
    if (this.state.lang !== 'en' || this.state.armEnLoaded || this.armEnPending) return;
    this.armEnPending = true;
    fetch(WEAPON_BASE + '/weapons_en.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(data => {
        this.armEnPending = false;
        const byHref = new Map(((data && data.weapons) || []).map(w => [w.href, w]));
        this.setState(s => ({
          armEnLoaded: true,
          armWeapons: s.armWeapons.map(w => (byHref.has(w.href) ? { ...w, en: byHref.get(w.href) } : w))
        }));
      });
  },
  // Single source for both renderVals and handleArmScroll, so pagination counts matches (see
  // filteredRoster). Empty group = inert; OR within a group, AND across groups.
  filteredWeapons() {
    const f = this.state.armFilter;
    return this.state.armWeapons.filter(w => this.matchesArmFilter(w, f));
  },
  matchesArmFilter(w, f) {
    if (f.rarity.length && !f.rarity.includes(w.rarity)) return false;
    if (f.element.length && !f.element.includes(w.element)) return false;
    // A weapon can list several roles ("生存,辅助") — match any of the picked ones.
    if (f.role.length && !w.roleTokens.some(r => f.role.includes(r))) return false;
    if (f.text) {
      const hay = [w.nameZh, w.altName].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(f.text.trim().toLowerCase())) return false;
    }
    return true;
  },
  handleArmScroll(e) {
    const el = e.currentTarget;
    this.armsScrollLeft = el.scrollLeft;
    this.updateGridWindow(el.scrollLeft, 'armWinCol');
    if (el.scrollLeft + el.clientWidth < el.scrollWidth - 500) return;
    const total = this.filteredWeapons().length;
    this.setState(s => ({ armVisibleCount: Math.min(total, s.armVisibleCount + ROSTER_BATCH) }));
  },
  goArmDetail(w) { this.setState({ armDetail: w }); },
  // The library strip unmounts while a weapon detail is open, so it comes back scrolled to 0 —
  // put the user back where they were, the way the Units grid does (see restoreArmsScroll).
  closeArmDetail() { this.setState({ armDetail: null }); this.restoreArmsScroll(); },
  // Weapon filter dialog — same draft/commit + toggle semantics as the Units filter, on armFilter.
  openArmFilter() {
    this.setState(s => ({ armFilterOpen: true, armDraftFilter: cloneArmFilter(s.armFilter) }));
  },
  closeArmFilter() { this.setState({ armFilterOpen: false }); },
  applyArmFilter() {
    this.setState(s => ({
      armFilterOpen: false, armFilter: cloneArmFilter(s.armDraftFilter),
      armVisibleCount: ROSTER_BATCH, armWinCol: 0
    }));
    // The old position belongs to the previous result set — drop it, or leaving and coming back
    // would restore a scrollLeft the new, shorter strip can't support.
    this.armsScrollLeft = 0;
    const el = document.getElementById('arms-scroll');
    if (el) el.scrollLeft = 0;
  },
  toggleArmFilterChip(group, value) {
    this.setState(s => {
      const draft = cloneArmFilter(s.armDraftFilter);
      const i = draft[group].indexOf(value);
      if (i === -1) draft[group].push(value); else draft[group].splice(i, 1);
      return { armDraftFilter: draft };
    });
  },
  setArmFilterText(e) {
    const text = e.target.value;
    this.setState(s => ({ armDraftFilter: { ...cloneArmFilter(s.armDraftFilter), text } }));
  },

  // renderVals 的本页分段：计算段 + vals 字面量段，逐字搬自 index.html。
  // 只吃 ctx 里的共享量（tab），其余一律走 this —— 见 CLAUDE.md 的文件地图。
  armsVals(ctx) {
    const { tab } = ctx;
    // --- Weapons (武器库 / 武器详情) — the same grid/filter shape as the roster above ---
    const isArms = tab === 'arms';
    const armDetail = this.state.armDetail;
    // The English sidecar (weapons_en.json), merged onto the record by href in loadWeaponsEn.
    // Only 316 of 384 weapons have one, and it never carries stats — those are language-neutral
    // numbers that come from the Chinese record either way. Falls back field by field.
    const armEn = (this.state.lang === 'en' && armDetail && armDetail.en) || null;
    const armDetailEffect = (armEn && armEn.baseSkillDetail) || (armDetail && armDetail.effect) || '';
    const armDetailMaxEffect = (armEn && armEn.maxSkillDetail) || (armDetail && armDetail.maxEffect) || '';
    const armDetailAcquire = (armEn && armEn.obtain) || (armDetail && armDetail.acquisition) || '';
    const armDetailFlavor = (armEn && armEn.description) || (armDetail && armDetail.flavor) || '';
    const armWeaponsAll = this.filteredWeapons();
    // Weapons have a Chinese name always and an English one only where the wiki.gg sidecar
    // matched (316 of 384), so the tile label is per-weapon rather than per-language.
    const armLangEn = this.state.lang === 'en';
    const armPaged = armWeaponsAll.slice(0, this.state.armVisibleCount);
    // Same art window as the roster strip above — this library is the other half of the iOS memory
    // peak (384 icons), and it lays out identically, so it uses the same helper.
    const armWin = this.gridWindow(armPaged.length, this.state.armWinCol);
    const armVisible = armPaged.map((w, i) => {
      const iconSrc = this.artSrc(i >= armWin.start && i < armWin.end ? w.iconUrl : '');
      return {
        ...w,
        iconSrc,
        showIcon: !!iconSrc,
        displayName: (armLangEn && w.en && w.en.nameEn) || w.nameZh,
        hasElement: !!w.elementIconUrl,
        onSelect: () => this.goArmDetail(w)
      };
    });
    const armStatusText = this.state.armLoading
      ? this.t('loadingWeapons')
      : this.state.armError
        ? this.t('weaponsErrorTitle')
        : armPaged.length + ' / ' + armWeaponsAll.length + this.t('armShownSuffix');
    const armDraft = this.state.armDraftFilter;
    const armChip = (group, value, label, iconUrl) => ({
      label, iconUrl: iconUrl || '', hasIcon: !!iconUrl,
      chipBg: armDraft[group].includes(value) ? '#FFCF8F' : '#FAFAFA',
      onToggle: () => this.toggleArmFilterChip(group, value)
    });
    const armRarityChips = FILTER_RARITIES.map(r =>
      armChip('rarity', r, this.t('filterRarity' + r), 'icons/rarity_' + r + '.png'));
    const armElementChips = ARM_ELEMENTS.map(name =>
      armChip('element', name,
        name === 'None' ? this.t('armElementNone') : this.t('filterElement' + name),
        name === 'None' ? '' : 'icons/element_' + ELEMENT_ORDER.indexOf(name) + '.png'));
    // Role chips are derived from the loaded data (roles can be comma-joined) — no hardcoded table.
    const armRoleChips = [...new Set(this.state.armWeapons.flatMap(w => w.roleTokens))]
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .map(r => armChip('role', r, r));
    const armF = this.state.armFilter;
    const armFilterCount = armF.rarity.length + armF.element.length + armF.role.length + (armF.text ? 1 : 0);
    return {
      // --- Weapons (武器库 / 武器详情, the Armaments tab) ---
      showArmLibrary: isArms && !armDetail,
      showArmDetail: isArms && !!armDetail,
      weaponsScreenTitle: this.t('weaponsScreenTitle'),
      armStatusText: armStatusText,
      showArmLoading: this.state.armLoading && this.state.armWeapons.length === 0,
      showArmError: !!this.state.armError,
      armError: this.state.armError,
      showArmGrid: !this.state.armError && armPaged.length > 0,
      showArmEmpty: this.state.armLoaded && !this.state.armError && armWeaponsAll.length === 0,
      visibleArmWeapons: armVisible,
      armNoMatchText: this.t('armNoMatch'),
      handleArmScroll: (e) => this.handleArmScroll(e),
      showArmFilterButton: this.state.armLoaded && !this.state.armError,
      hasArmFilterCount: armFilterCount > 0,
      armFilterCount: armFilterCount,
      // Weapon filter dialog
      armFilterOpen: this.state.armFilterOpen,
      armFilterNameValue: armDraft.text,
      armFilterNameTitle: this.t('armFilterName'),
      armFilterNameHint: this.t('armFilterNameHint'),
      armFilterRoleTitle: this.t('armFilterRole'),
      armRarityChips: armRarityChips,
      armElementChips: armElementChips,
      armRoleChips: armRoleChips,
      openArmFilter: () => this.openArmFilter(),
      closeArmFilter: () => this.closeArmFilter(),
      applyArmFilter: () => this.applyArmFilter(),
      setArmFilterText: (e) => this.setArmFilterText(e),
      // Weapon detail (armDetail set = the 武器详情 screen)
      closeArmDetail: () => this.closeArmDetail(),
      armDetailName: armDetail ? ((armEn && armEn.nameEn) || armDetail.nameZh) : '',
      armDetailAlt: armDetail ? (armDetail.altName || '') : '',
      armDetailHasAlt: !!(armDetail && armDetail.altName),
      armDetailIconUrl: armDetail ? armDetail.iconUrl : '',
      armDetailRarityUrl: armDetail ? armDetail.rarityUrl : '',
      armDetailRarityLabel: armDetail ? armDetail.rarityLabel : '',
      armDetailPedestalTop: armDetail ? armDetail.pedestalTop : '#E4E9F0',
      armDetailPedestalSide: armDetail ? armDetail.pedestalSide : '#A9B3C2',
      armDetailHasElement: !!(armDetail && armDetail.elementIconUrl),
      armDetailElementIconUrl: armDetail && armDetail.elementIconUrl ? armDetail.elementIconUrl : '',
      armDetailElementLabel: armDetail ? (armDetail.element === 'None' ? this.t('armElementNone') : this.t('filterElement' + armDetail.element)) : '',
      armDetailMetaText: armDetail ? [armDetail.role, armDetail.limit, armDetail.system].filter(Boolean).join('  ·  ') : '',
      armDetailHasMeta: !!(armDetail && (armDetail.role || armDetail.limit || armDetail.system)),
      armStatsTitleText: this.t('armStatsTitle'),
      armStatHpText: this.t('armStatHp'),
      armStatAtkText: this.t('armStatAtk'),
      armStatBaseText: this.t('armStatBase'),
      armStatMaxText: this.t('armStatMax'),
      armDetailHasBase: !!(armDetail && (armDetail.baseHp != null || armDetail.baseAtk != null)),
      armDetailBaseHp: armDetail && armDetail.baseHp != null ? String(armDetail.baseHp) : '—',
      armDetailBaseAtk: armDetail && armDetail.baseAtk != null ? String(armDetail.baseAtk) : '—',
      armDetailMaxHp: armDetail && armDetail.maxHp != null ? String(armDetail.maxHp) : '—',
      armDetailMaxAtk: armDetail && armDetail.maxAtk != null ? String(armDetail.maxAtk) : '—',
      armEffectTitleText: this.t('armEffectTitle'),
      armMaxEffectTitleText: this.t('armMaxEffectTitle'),
      armAcquireTitleText: this.t('armAcquireTitle'),
      armLoreTitleText: this.t('armLoreTitle'),
      armDetailHasEffect: !!armDetailEffect,
      armDetailEffect: armDetailEffect,
      armDetailHasMaxEffect: !!armDetailMaxEffect,
      armDetailMaxEffect: armDetailMaxEffect,
      // The card shows when either effect exists (orbs carry only a max effect); the max-effect
      // block only gets its divider/spacing when a base effect sits above it.
      armDetailHasAnyEffect: !!(armDetailEffect || armDetailMaxEffect),
      armMaxEffectBlockStyle: armDetailEffect ? 'margin-top: 12px; padding-top: 10px; border-top: 1px dashed #E3E9F0;' : '',
      armDetailHasAcquire: !!armDetailAcquire,
      armDetailAcquire: armDetailAcquire,
      armDetailHasFlavor: !!armDetailFlavor,
      armDetailFlavor: armDetailFlavor,
      // Attribution for the English armament text, shown only when some is actually on screen.
      // (wikiSourceGgText itself is defined once, up with the character-sheet bindings.)
      showArmSourceGg: !!armEn,
    };
  },};
