// 剧情档案（arc*）：见 CLAUDE.md 的 Story tab 一节。注意与角色详情自己的剧情面板是两个功能 —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。

// The Story tab's category filter. Every story in story/index.json carries a `category` stamped
// by fetch-main-story.mjs: main = the numbered chapters + prologue, collab = the tie-in events,
// event = everything else. Single-select; 'all' is the inert default.
const ARC_CATEGORIES = [
  { id: 'all', labelKey: 'arcFilterAll' },
  { id: 'main', labelKey: 'arcFilterMain' },
  { id: 'event', labelKey: 'arcFilterEvent' },
  { id: 'collab', labelKey: 'arcFilterCollab' }
];

// 挂到 Component.prototype 上（见 index.html 里 class 声明之后的 Object.assign）。
const WF_STORY = {
  // The Story tab's English sidecars, both small and both fetched once: wiki.gg's episode scripts
  // index and the community sheet's titles/videos. They cover different stories on purpose —
  // wiki.gg has scripts for 13, the sheet has a video for nearly all 42 — so neither replaces the
  // other and the render prefers whichever it has.
  loadArcEn() {
    if (this.state.lang !== 'en' || this.state.arcEnIndex !== null || this.arcEnIndexPending) return;
    this.arcEnIndexPending = true;
    Promise.all([
      fetch(ASSET_BASE + '/story/en/index.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch(ASSET_BASE + '/story/community_en.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch(ASSET_BASE + '/story/en/summary_en.json').then(r => (r.ok ? r.json() : null)).catch(() => null)
    ]).then(([en, community, summary]) => {
      this.arcEnIndexPending = false;
      this.setState({
        arcEnIndex: (en && en.stories) || false,
        arcCommunity: (community && community.stories) || false,
        arcSummaryEn: (summary && summary.stories) || false
      });
      // A story may already be open (language toggled mid-read).
      if (this.state.arcStory) this.loadArcEnDetail(this.state.arcStory.slug);
    });
  },
  // wiki.gg's episode scripts for one story. Only fetched when the index says that story has any —
  // 29 of the 42 have none, and asking for them would be 29 guaranteed 404s.
  loadArcEnDetail(slug) {
    if (this.state.lang !== 'en') return;
    const index = this.state.arcEnIndex;
    const entry = index && index[slug];
    if (!entry || !entry.episodeCount) {
      if (this.state.arcEnDetail !== false) this.setState({ arcEnDetail: false });
      return;
    }
    const cached = this.arcEnCache.get(slug);
    if (cached) { this.setState({ arcEnDetail: cached }); return; }
    fetch(ASSET_BASE + '/story/en/' + slug + '.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(data => {
        if (data) this.arcEnCache.set(slug, data);
        // The user may have navigated to another story while this was in flight.
        if (!this.state.arcStory || this.state.arcStory.slug !== slug) return;
        this.setState({ arcEnDetail: data || false });
      });
  },
  // English story titles come from two sources that cover different halves of the archive:
  // wiki.gg has the ten main chapters and the nine events it transcribed, the community sheet has
  // an English name for every event. Falls back to the Chinese title, story by story. Takes
  // anything carrying `slug` + `title`, which is why the gallery index stores both rather than a
  // pre-resolved title — the Art tab's wall resolves its captions through here too.
  arcTitleFor(story) {
    if (!story) return '';
    const en = (this.state.lang === 'en' && this.state.arcEnIndex) || null;
    const community = (this.state.lang === 'en' && this.state.arcCommunity) || null;
    const enEntry = en && en[story.slug];
    const communityEntry = community && community[story.slug];
    return (enEntry && enEntry.title) || (communityEntry && communityEntry.title) || story.title;
  },
  loadArcIndex() {
    if (this.state.arcIndex || this.state.arcIndexLoading) return;
    this.setState({ arcIndexLoading: true, arcIndexError: null });
    fetch(ASSET_BASE + '/story/index.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(data => this.setState({ arcIndex: (data && data.stories) || [], arcIndexLoading: false }))
      .catch(err => {
        console.error('[story] failed to load story/index.json', err);
        this.setState({ arcIndexLoading: false, arcIndexError: String(err && err.message || err) });
      });
  },
  setArcCategory(category) { this.setState({ arcCategory: category }); this.scrollArcTop(); },
  // Extra/collab stories carry no encyclopedia info blocks, so they have no info tab and open
  // straight on the episode list — the same fallback upstream's tab logic makes.
  defaultArcTab(detail) { return (detail && detail.desc && detail.desc.length) ? 'info' : 'story'; },
  openArcStory(story) {
    const cached = this.arcDetailCache.get(story.slug);
    this.setState({
      arcStory: story,
      arcDetail: cached || null,
      arcDetailLoading: !cached,
      arcTab: this.defaultArcTab(cached),
      arcEnDetail: null,
      arcEpisodeIndex: null, arcEpisode: null
    });
    this.scrollArcTop();
    this.loadArcEnDetail(story.slug);
    if (cached) return;
    fetch(ASSET_BASE + '/story/detail/' + story.slug + '.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(data => {
        if (!this.state.arcStory || this.state.arcStory.slug !== story.slug) return;
        if (data) this.arcDetailCache.set(story.slug, data);
        this.setState({ arcDetail: data, arcDetailLoading: false, arcTab: this.defaultArcTab(data) });
      });
  },
  closeArcStory() {
    // The BGM plays through the room engine now, so returning to the story list keeps it going in
    // the floating mini-player — same as leaving the tab entirely.
    this.setState({
      arcStory: null, arcDetail: null, arcEnDetail: null, arcEpisodeIndex: null, arcEpisode: null
    });
    this.scrollArcTop();
  },
  setArcTab(tab) { this.setState({ arcTab: tab }); this.scrollArcTop(); },
  // wiki.gg's episodes for the open story, or null when there are none (or we're in Chinese).
  // They replace the Chinese episode list wholesale rather than merging into it — the same rule
  // the character sheet's story panel follows, for the same reason: different source, different
  // episode split, so index i means a different episode in each.
  arcEnEpisodes() {
    const detail = this.state.lang === 'en' ? this.state.arcEnDetail : null;
    const episodes = detail && detail.episodes;
    return (episodes && episodes.length) ? episodes : null;
  },
  openArcEpisode(i) {
    // English episodes carry their dialogue inline (the whole story is one file), so there's
    // nothing to fetch — opening one is pure state.
    const enEpisodes = this.arcEnEpisodes();
    if (enEpisodes) {
      if (!enEpisodes[i]) return;
      this.setState({ arcEpisodeIndex: i, arcEpisode: null, arcEpisodeLoading: false });
      this.scrollArcTop();
      return;
    }
    const detail = this.state.arcDetail;
    const ep = detail && detail.episodes && detail.episodes[i];
    if (!ep) return;
    const cached = this.arcEpisodeCache.get(ep.file);
    this.setState({ arcEpisodeIndex: i, arcEpisode: cached || null, arcEpisodeLoading: !cached });
    this.scrollArcTop();
    if (cached) return;
    fetch(ASSET_BASE + '/' + ep.file)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(data => {
        if (this.state.arcEpisodeIndex !== i) return;
        if (data) this.arcEpisodeCache.set(ep.file, data);
        this.setState({ arcEpisode: data || { dialogs: [] }, arcEpisodeLoading: false });
      });
  },
  closeArcEpisode() { this.setState({ arcEpisodeIndex: null, arcEpisode: null }); this.scrollArcTop(); },
  // The story archive's BGM tracks play through the Music Room engine, same as the character
  // detail page's theme pills (see detailCharQueue): a story's bgm list becomes a room queue, so
  // tapping a track surfaces the floating mini-player, keeps playing across tab navigation, and
  // gains seek/prev/next/volume/auto-advance for free. Entries match the room queue shape.
  arcBgmQueue() {
    const detail = this.state.arcDetail;
    const bgm = (detail && detail.bgm) || [];
    const sub = this.state.arcStory ? this.state.arcStory.title : this.t('arcBgmTitle');
    return bgm.map(tr => ({ url: ASSET_BASE + '/' + tr.file, label: tr.name, sub }));
  },
  toggleArcBgm(i) { this.roomToggleTrack(this.arcBgmQueue(), i); },
  // Switching story/tab/episode swaps the scroller's content while its offset stays put, which
  // would drop you into the middle of the next view — same reset as scrollSheetBodyTop.
  scrollArcTop() {
    requestAnimationFrame(() => {
      const el = document.getElementById('story-scroll');
      if (el) el.scrollTop = 0;
    });
  },

  // renderVals 的本页分段：计算段 + vals 字面量段，逐字搬自 index.html。
  // 只吃 ctx 里的共享量（accent），其余一律走 this —— 见 CLAUDE.md 的文件地图。
  storyVals(ctx) {
    const { accent } = ctx;
    // --- Story archive -----------------------------------------------------------------------
    // The list is filtered by the single-select category chip row; 'all' is inert. Stories whose
    // banner sprite the atlas didn't have render as a text tile instead (as upstream does).
    const arcCategory = this.state.arcCategory;
    // Title resolution (wiki.gg -> community sheet -> Chinese) lives in this.arcTitleFor, which the
    // Art tab's gallery wall shares. The community map is still needed here for the video rows.
    const arcCommunityMap = (this.state.lang === 'en' && this.state.arcCommunity) || null;
    const arcStoryItems = (this.state.arcIndex || [])
      .filter(s => arcCategory === 'all' || s.category === arcCategory)
      .map(s => ({
        title: this.arcTitleFor(s),
        hasBanner: !!s.banner,
        noBanner: !s.banner,
        bannerUrl: s.banner ? ASSET_BASE + '/' + s.banner : '',
        onClick: () => this.openArcStory(s)
      }));
    const arcCategoryChips = ARC_CATEGORIES.map(c => ({
      label: this.t(c.labelKey),
      // #ffcf8f is upstream's own active-chip colour, same as the Units filter's chips.
      bg: arcCategory === c.id ? '#ffcf8f' : '#FAFAFA',
      onClick: () => this.setArcCategory(c.id)
    }));

    const arcStory = this.state.arcStory;
    const arcDetail = this.state.arcDetail;
    const arcTab = this.state.arcTab;
    const arcInReader = this.state.arcEpisodeIndex !== null;
    // Machine-translated plot summary (namu.wiki) for the info panel, English only. When present it
    // replaces the Chinese `desc` there — the one English text some stories have — and shows an
    // "auto-translated" notice above it. Never touches the episode reader (namu has no dialogue).
    const arcSummaryMap = (this.state.lang === 'en' && this.state.arcSummaryEn) || null;
    const arcSummaryEntry = (arcSummaryMap && arcStory) ? arcSummaryMap[arcStory.slug] : null;
    const arcInfoDesc = (arcSummaryEntry && arcSummaryEntry.desc && arcSummaryEntry.desc.length)
      ? arcSummaryEntry.desc
      : ((arcDetail && arcDetail.desc) || []);
    // Community playthrough recordings for the open story. They're the only English there is for
    // the 29 stories nobody has transcribed, so they show whether or not a script exists.
    const arcCommunityEntry = (arcCommunityMap && arcStory) ? arcCommunityMap[arcStory.slug] : null;
    const arcVideoRows = ((arcCommunityEntry && arcCommunityEntry.videos) || []).map((v, i) => ({
      label: v.by ? this.t('videoBy').replace('{by}', v.by) : this.t('videoWatch'),
      raw: !!v.raw,
      url: v.url,
      onClick: () => window.open(v.url, '_blank', 'noopener')
    }));
    const arcEnEpisodes = this.arcEnEpisodes();
    const arcEpisodes = arcEnEpisodes
      ? arcEnEpisodes.map(ep => ({ title: ep.name || '', desc: ep.summary || '' }))
      : ((arcDetail && arcDetail.episodes) || []);
    const arcOpenedEpisode = arcInReader ? arcEpisodes[this.state.arcEpisodeIndex] : null;
    const arcRelated = (arcDetail && arcDetail.related) || null;
    // Same resolution as the character sheet's related panel: a chip that lands on a roster
    // character navigates into their detail view; anything else keeps a dimmed placeholder tile.
    const arcRelatedChars = (arcRelated && arcRelated.characters ? arcRelated.characters : []).map(rc => {
      const target = rc.devName ? this.rosterByDev.get(rc.devName) : null;
      return {
        name: (this.state.lang === 'zh' || !target) ? rc.zhName : (target.enName || rc.zhName),
        thumbUrl: target ? (target.headUrl || target.thumbUrl) : '',
        hasThumb: !!target,
        noThumb: !target,
        opacity: target ? 1 : 0.55,
        cursor: target ? 'pointer' : 'default',
        onClick: () => { if (target) this.goDetail(target); }
      };
    });
    const arcRelatedKeywords = (arcRelated && arcRelated.keywords ? arcRelated.keywords : []).map(k => ({
      title: k.title, desc: k.desc || ''
    }));
    // The reader has no "viewed character", so unlike the character sheet's dialogue rows every
    // speaker resolves to a portrait; `marker` rows (BGM change points) are data-only for now.
    // wiki.gg's scripts are speaker+line pairs with no speakerDev, so those rows get the plain
    // name plate rather than a portrait — the honest degradation, same as the character sheet's
    // English stories. The plate keeps a neutral colour: {{DU}} only carries one for the odd
    // unnamed speaker, and an empty `background:` would leave white text on nothing.
    const arcDialogRows = (arcEnEpisodes && arcInReader)
      ? ((arcEnEpisodes[this.state.arcEpisodeIndex] || {}).lines || []).map(l => ({
        speaker: l.speaker || '',
        color: l.color || DIALOG_PLATE_DEFAULT,
        text: l.text,
        hasAvatar: false,
        headUrl: ''
      }))
      : ((this.state.arcEpisode && this.state.arcEpisode.dialogs) || [])
        .filter(d => !d.marker)
        .map(d => {
          const headUrl = this.headUrlForSpeaker(d.speakerDev);
          return { speaker: d.speaker, color: d.color, text: d.text, hasAvatar: !!headUrl, headUrl };
        });
    const arcTabBg = id => (arcTab === id ? accent : '#F0F3F7');
    return {
      // Story archive: list view
      arcShowList: !arcStory,
      arcShowDetail: !!arcStory,
      arcIndexLoading: this.state.arcIndexLoading,
      arcIndexError: !!this.state.arcIndexError,
      arcLoadingIndexText: this.t('arcLoadingIndex'),
      arcIndexErrorText: this.t('arcIndexError'),
      arcStoryItems: arcStoryItems,
      arcCategoryChips: arcCategoryChips,
      arcNoStories: !this.state.arcIndexLoading && !this.state.arcIndexError && !!this.state.arcIndex && arcStoryItems.length === 0,
      arcNoStoriesText: this.t('arcNoStories'),

      // Story archive: detail header + tab switcher
      arcTitle: this.arcTitleFor(arcStory),
      arcHeaderUrl: (arcDetail && arcDetail.header) ? 'url("' + ASSET_BASE + '/' + arcDetail.header + '")' : 'none',
      arcBackToStoriesLabel: this.t('arcBackToStories'),
      arcBackToStoriesBtn: () => this.closeArcStory(),
      arcHasInfoTab: !!((arcDetail && arcDetail.desc && arcDetail.desc.length) || (arcSummaryEntry && arcSummaryEntry.desc && arcSummaryEntry.desc.length)),
      arcHasGalleryTab: !!(arcDetail && (arcDetail.orb || (arcDetail.gallery && arcDetail.gallery.length))),
      arcHasBgmTab: !!(arcDetail && arcDetail.bgm && arcDetail.bgm.length),
      arcTabInfoBg: arcTabBg('info'),
      arcTabStoryBg: arcTabBg('story'),
      arcTabGalleryBg: arcTabBg('gallery'),
      arcTabBgmBg: arcTabBg('bgm'),
      arcTabInfoLabel: this.t('arcTabInfo'),
      arcTabStoryLabel: this.t('arcTabStory'),
      arcTabGalleryLabel: this.t('arcTabGallery'),
      arcTabBgmLabel: this.t('arcTabBgm'),
      setArcInfoTab: () => this.setArcTab('info'),
      setArcStoryTab: () => this.setArcTab('story'),
      setArcGalleryTab: () => this.setArcTab('gallery'),
      setArcBgmTab: () => this.setArcTab('bgm'),
      arcDetailLoading: this.state.arcDetailLoading,
      arcLoadingDetailText: this.t('arcLoadingDetail'),

      // Story archive: panels
      arcShowInfo: !!arcDetail && arcTab === 'info',
      arcShowEpisodes: !!arcDetail && arcTab === 'story' && !arcInReader,
      arcShowReader: !!arcDetail && arcTab === 'story' && arcInReader,
      arcShowGallery: !!arcDetail && arcTab === 'gallery',
      arcShowBgm: !!arcDetail && arcTab === 'bgm',
      arcInfoTitleLabel: this.t('arcInfoTitle'),
      arcInfoBlocks: arcInfoDesc.map(text => ({ text })),
      arcShowSummaryNotice: !!(arcSummaryEntry && arcSummaryEntry.desc && arcSummaryEntry.desc.length),
      arcSummaryNoticeText: this.t('arcSummaryNotice'),
      arcRelatedChars: arcRelatedChars,
      arcHasRelatedChars: arcRelatedChars.length > 0,
      arcRelatedKeywords: arcRelatedKeywords,
      arcHasRelatedKeywords: arcRelatedKeywords.length > 0,
      arcEpisodesTitleLabel: this.t('arcEpisodesTitle'),
      arcEpisodeItems: arcEpisodes.map((ep, i) => ({
        title: ep.title, desc: ep.desc || '', onClick: () => this.openArcEpisode(i)
      })),
      arcHasEpisodes: arcEpisodes.length > 0,
      arcHasNoEpisodes: !!arcDetail && arcEpisodes.length === 0,
      arcNoEpisodesText: this.t('arcNoEpisodes'),
      // The English extras under the episode list: wiki.gg's CC BY-SA credit when the scripts
      // above came from there, then the community playthrough links (which exist for far more
      // stories than the scripts do, so they're gated separately).
      arcShowWikiSourceGg: !!arcEnEpisodes,
      arcHasVideos: arcVideoRows.length > 0,
      arcVideoRows: arcVideoRows,
      videosTitleLabel: this.t('videosTitle'),
      videoRawLabel: this.t('videoRaw'),
      videoSourceCommunityText: this.t('videoSourceCommunity'),
      arcEpisodeLoading: this.state.arcEpisodeLoading,
      arcLoadingEpisodeText: this.t('arcLoadingEpisode'),
      arcReaderTitle: arcOpenedEpisode ? arcOpenedEpisode.title : '',
      arcDialogRows: arcDialogRows,
      arcBackToEpisodesBtn: () => this.closeArcEpisode(),
      arcBackLabel: this.t('storyBack'),
      arcBackToEpisodesLabel: this.t('storyBackToList'),
      arcGalleryTitleLabel: this.t('arcGalleryTitle'),
      arcHasOrb: !!(arcDetail && arcDetail.orb),
      arcOrbUrl: (arcDetail && arcDetail.orb) ? ASSET_BASE + '/' + arcDetail.orb.file : '',
      arcOrbName: (arcDetail && arcDetail.orb) ? arcDetail.orb.name : '',
      arcOrbDesc: (arcDetail && arcDetail.orb) ? arcDetail.orb.desc : '',
      arcGalleryImages: ((arcDetail && arcDetail.gallery) || []).map(p => ({ url: ASSET_BASE + '/' + p })),
      arcHasGalleryImages: !!(arcDetail && arcDetail.gallery && arcDetail.gallery.length),
      arcBgmTitleLabel: this.t('arcBgmTitle'),
      arcBgmTracks: (() => {
        // Play through the room engine: rows reflect room playback state and share the queue with
        // the floating mini-player, so the track keeps going as you leave the story archive.
        const q = this.arcBgmQueue();
        return q.map((tr, i) => ({
          label: (this.roomIsPlaying(tr.url) ? '❚❚  ' : '▶  ') + tr.label,
          bg: this.roomIsPlaying(tr.url) ? accent : '#F7F9FC',
          onClick: () => this.roomToggleTrack(q, i)
        }));
      })(),
    };
  },};
