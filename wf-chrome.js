// 站点外壳：更新日志 / News+About 弹窗 / 访问计数器 / 首页与菜单 / 底部 tab 栏 —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。

// Site changelog, shown in the News dialog. Hand-maintained (the site is static — no build step
// and no runtime git), seeded from `git log`. Newest date first; each date carries bilingual
// bullet lines curated to user-facing milestones (dev-pipeline commits are intentionally omitted).
// Add a new group at the top when you ship something worth announcing.
const CHANGELOG = [
  { date: '2026-07-30', items: [
      { en: 'Every screen that keeps you waiting now says so: Alk walks in place above a line of loading text wherever something is still on its way — the roster, the story archive, the gallery, the X wall, the Music Room, and every panel in between.', zh: '所有需要等待的地方现在都有了明确提示：凡有内容仍在加载，阿尔克便会在「加载中」字样上方原地行走——角色栏、故事档案、画廊、推特墙、音乐室，以及其间的各个面板。' },
      { en: 'Character art no longer opens on a blank space. The full illustration is the largest image on the site, and the detail page used to sit empty until it arrived; now it shows the same indicator while it loads. The expression viewer does too.', zh: '角色立绘不再「先空一片」。立绘是全站体积最大的图片，此前详情页会一直留白至其加载完成；现在同样会显示加载提示，表情预览框亦然。' },
  ]},
  { date: '2026-07-29', items: [
      { en: 'The Art Gallery has a second wall: every image and video the official @world_flipper account posted on X, from November 2019 to March 2024 — 1,429 pieces in all (1,343 images and 86 videos), newest first. Switch between it and the story illustrations at the top of the page.', zh: '「画廊」页新增第二面墙：官方推特 @world_flipper 自 2019 年 11 月至 2024 年 3 月发布的全部图片与视频，共 1429 条（1343 张图片、86 段视频），按时间由新到旧排列。可在页面顶部与「剧情画廊」相互切换。' },
      { en: 'That wall filters by year and by images or video. Tap any piece to see it at full size or play it, and every one links back to the original post.', zh: '该墙可按年份与「图片 / 视频」筛选；点击任意一条即可查看原图或播放视频，每条均可跳转至原推文。' },
      { en: 'The character and weapon lists load about twice as fast. Yesterday’s crash fix was deliberately cautious about how many images it fetched at once; now that the cause is confirmed, the limit has been raised to a level still far below what the page can take.', zh: '角色栏与武器栏的加载速度提升约一倍。昨日修复崩溃时对同时加载的图片数量取值偏保守，现已确认成因，遂将上限调高——距离页面的承受极限仍有很大余量。' },
      { en: 'Behind the scenes, the site’s code moved from one 6,000-line file to one file per page. Nothing here looks or behaves any differently — this entry is for whoever maintains it.', zh: '幕后：站点代码由单一的 6000 行文件改为按页面拆分，每页一个文件。页面的外观与行为均无任何变化——这一条是写给维护者的。' },
  ]},
  { date: '2026-07-28', items: [
      { en: 'Fixed the crash while the character and weapon lists were still loading. They used to fire hundreds of image requests at once — 255 when paging through the Armaments library, 354 when switching back to the roster — which is what killed the page on iOS; now they fetch a few at a time. Portraits and icons are also only loaded around your scroll position. Scrolling, filters and your place in the list are unchanged.', zh: '修复角色栏与武器栏「加载过程中」的崩溃。此前它们会一次性发出数百个图片请求（翻完武器库峰值 255 个，切回角色栏 354 个），这正是 iOS 上页面被强制重载的原因；现在改为少量并发逐批加载，且只加载滚动位置附近的头像与图标。滚动、筛选与浏览位置均与此前一致。' },
      { en: 'The Art Gallery tab is open: all 64 story illustrations — 52 key visuals plus the 12 chapter orbs — on one wall, filterable by main story / event / collab.', zh: '「画廊」页正式开放：全部 64 张剧情插画（52 张主视觉图与 12 张章节宝珠）汇集于一面墙，可按主线 / 活动 / 联动筛选。' },
      { en: 'Tap any piece to view it full-screen at full resolution, and swipe to move through the wall.', zh: '点击任意作品即可全屏查看原图，左右滑动浏览下一张。' },
  ]},
  { date: '2026-07-27', items: [
      { en: 'The Story archive’s Info tab now reads in English for the chapters that have no English script — main story Worlds 6-10 and 19 events — with plot summaries machine-translated from namu.wiki (marked as auto-translated).', zh: '故事档案「情报」页现可用英文阅读此前无英文剧本的章节——主线世界 6–10 及 19 个活动——剧情简介机翻自 namu.wiki（页内标注为机翻）。' },
      { en: 'Added English skills, leader buffs and abilities for 60 more characters — the roster additions that no wiki documents — sourced from the Eliya-bot Global database.', zh: '为另外 60 名角色补上英文技能、队长技与能力（这些是各大 wiki 均未收录的新增角色），资料来自 Eliya-bot 国际服数据库。' },
  ]},
  { date: '2026-07-23', items: [
      { en: 'Added English character data from worldflipper.wiki.gg — profile, skills, abilities, stories and quotes for 369 characters.', zh: '接入 worldflipper.wiki.gg 英文角色资料：369 名角色的简介、技能、能力、故事与台词。' },
      { en: 'Added English weapon names and effects for 316 of the 384 armaments.', zh: '新增 384 件武器中 316 件的英文名称与效果说明。' },
      { en: 'Content now follows the EN/ZH toggle, falling back to Chinese where no English exists.', zh: '内容区跟随中英切换，缺少英文时回落中文。' },
      { en: 'The Story archive now reads in English: full scripts for main story Worlds 1-5 and nine events, 119 episodes in all.', zh: '故事档案支持英文阅读：主线世界 1–5 与九个活动的完整剧本，共 119 话。' },
      { en: 'English story titles for 39 of the 42 stories, and community playthrough links for the ones with no English script.', zh: '42 个剧情中 39 个补上英文标题；暂无英文剧本的剧情附社区实况录像链接。' },
      { en: 'Every character but one now has an English name — including the 108 that no wiki documents — plus their English epithet and a playthrough of their episode.', zh: '除一名角色外全员补齐英文名（含 108 名各大 wiki 均无收录的角色），并新增英文称号与角色剧情实况链接。' },
  ]},
  { date: '2026-07-22', items: [
      { en: 'Music player: the volume slider now has a draggable knob, and its popup toggles closed on a second tap.', zh: '音乐播放器：音量滑块新增可拖动的按钮，再次点击音量键即可关闭音量条。' },
      { en: 'Added an up-arrow above the player that previews the next tracks in the queue.', zh: '播放器上方新增向上箭头，可预览队列中即将播放的歌曲。' },
  ]},
  { date: '2026-07-21', items: [
      { en: 'Added the Armaments library — browse all 384 weapons with a filter, search, and detail pages.', zh: '新增武器库：浏览全部 384 件武器，支持筛选、搜索与武器详情页。' },
      { en: 'Added News and About pages; removed the redundant bottom-bar menu.', zh: '新增资讯与关于页面，并移除多余的底部菜单。' },
      { en: 'Reworked the top status bar — logo, white rounded bar, lighter counter pills.', zh: '重做顶部状态栏：logo、白色圆角栏、更轻盈的计数胶囊。' },
      { en: 'Added a volume slider and a total-flips counter; story BGM now plays through the Music Room.', zh: '新增音量滑块与「总弹弹数」；故事 BGM 接入音乐室引擎。' },
  ]},
  { date: '2026-07-20', items: [
      { en: 'Added the Music Room — a player over character themes and world/event BGM.', zh: '新增音乐室：播放角色主题曲与世界/活动原声。' },
      { en: 'Play modes, playlists, and a draggable floating mini-player.', zh: '新增播放模式、播放列表与可拖动的悬浮播放器。' },
  ]},
  { date: '2026-07-17', items: [
      { en: 'Added Flip (弹弹) — a swipe deck for voting on every illustration.', zh: '新增「弹弹」：为每张立绘投票的滑动卡组。' },
      { en: 'Added the Story archive — a main / event / collab story browser.', zh: '新增故事档案：主线 / 活动 / 联动剧情浏览。' },
      { en: 'Fixed a mobile crash from pinch-zoom and filled the viewport on phones.', zh: '修复移动端捏合缩放导致的崩溃，并在手机上铺满视口。' },
  ]},
  { date: '2026-07-16', items: [
      { en: 'Added 108 characters from miaowm5 — the roster reaches 485.', zh: '新增 108 名角色，角色总数达到 485。' },
      { en: 'Added the Armaments tab and a Units filter; adopted the magic-circle backdrop.', zh: '新增武器栏与角色筛选，采用魔法阵背景。' },
      { en: 'Wired the top-bar counters to Supabase (visits + unique visitors).', zh: '顶部计数接入 Supabase（访问量与独立访客）。' },
  ]},
  { date: '2026-07-15', items: [
      { en: 'Added the miaowm5 data pipeline — story, expressions, and pixel actions.', zh: '接入 miaowm5 数据：剧情、表情与像素动作。' },
      { en: 'Split emotion art into faces plus toggleable overlays.', zh: '将表情拆分为脸部与可叠加的附加层。' },
  ]},
  { date: '2026-07-14', items: [
      { en: 'Added the detail panel switcher (profile / voice).', zh: '新增详情面板切换（资料 / 语音）。' },
      { en: 'Added the bilibili wiki data pipeline (scrape + match to roster).', zh: '接入 bilibili wiki 数据（抓取并匹配角色）。' },
  ]},
  { date: '2026-07-13', items: [
      { en: 'Added the EN/ZH bilingual UI toggle and mobile screen adaption.', zh: '新增中英双语界面切换与手机屏幕适配。' },
      { en: 'Added character theme music playback on the detail page.', zh: '在详情页新增角色主题曲播放。' },
  ]},
  { date: '2026-07-08', items: [
      { en: 'World Flipper Museum & Archive goes live.', zh: '《世界弹射物语》博物馆与档案馆上线。' },
  ]},
];

// Pick up to 4 random character pixel sprites (roster `thumbUrl`s) to decorate a dialog. The
// sprites are GIFs that animate themselves; positioning keeps them clear of the text.
function pickDialogGifs(roster) {
  if (!roster || !roster.length) return [];
  const pool = roster.slice();
  const out = [];
  for (let i = 0; i < 4 && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].thumbUrl);
  }
  return out;
}

// 挂到 Component.prototype 上（见 index.html 里 class 声明之后的 Object.assign）。
const WF_CHROME = {
  // A stable per-browser id, memoized. Reloads then count as one unique visitor, and one vote per
  // artwork keys on exactly this id. Falls back to an ephemeral id if localStorage is unavailable
  // (private mode) — that visit still counts toward PV, and its votes still land, just not durably.
  visitorId() {
    if (this._vid) return this._vid;
    try {
      let vid = localStorage.getItem(VISITOR_STORAGE_KEY) || '';
      if (!vid) {
        vid = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        localStorage.setItem(VISITOR_STORAGE_KEY, vid);
      }
      this._vid = vid;
    } catch (e) {
      this._vid = 'anon-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }
    return this._vid;
  },
  // False while SUPABASE_URL still holds its placeholder, so the site works before it's wired up
  // (the counters show a dash; the vote pills show one too).
  supabaseConfigured() {
    return !!SUPABASE_URL && SUPABASE_URL.indexOf('YOUR_PROJECT') === -1;
  },
  // Reads and writes are deliberately asymmetric on local dev. Writes (visit counts, votes) are
  // suppressed on file:// and localhost so reloads and test swipes never touch the live numbers;
  // reads aren't, because seeing the real counts locally is harmless and is what makes the Flip
  // deck developable at all.
  supabaseWritable() {
    return this.supabaseConfigured()
      && location.protocol !== 'file:' && location.hostname !== 'localhost';
  },
  supabaseRpc(name, body) {
    return fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  },
  // Bump the total page-view count and register this browser as a visitor (deduped via the
  // visitorId uuid), then show both numbers in the top bar. Fires once per page load.
  recordVisit() {
    if (!this.supabaseWritable()) return;
    this.supabaseRpc('record_visit', { vid: this.visitorId() }).then(data => {
      const row = Array.isArray(data) ? data[0] : data;
      // A failed call leaves the counters on their dash placeholder.
      if (row && row.pv != null) this.setState({ pv: Number(row.pv), uv: Number(row.uv) });
    });
  },

  // renderVals 的外壳分段：画布缩放、顶栏计数器、区块标题、导航与菜单、News/About 弹窗，
  // 以及底部 tab 栏。它在原来的 vals 字面量里是分开的两段（中间夹着角色/武器/详情的键），
  // 这里合并成一段 —— 整个 vals 没有重复键，所以键序不影响结果。
  chromeVals(ctx) {
    const { tab, accent, sec } = ctx;
    const menuOrder = ['units', 'arms', 'story', 'art', 'music'];
    const vals = {
      cardScaleTransform: 'scale(' + this.state.scale + ')',
      // Filling means the card's height is the viewport's, expressed in design px so the scale
      // above lands it back on exactly 100dvh. Stating it in CSS rather than JS px keeps it correct
      // *through* a URL-bar collapse instead of a frame behind one, and matches how the page field
      // above already sizes itself. The vh line is the fallback for browsers without dvh.
      cardHeightCss: this.state.fill
        ? 'height: calc(100vh / ' + this.state.scale + '); height: calc(100dvh / ' + this.state.scale + ');'
        : 'height: ' + DESIGN_H + 'px;',
      cardShadow: this.state.fill ? 'none' : '0 0 40px rgba(0, 0, 0, 0.3)',
      isHome: tab === 'home',
      isUnits: tab === 'units',
      isDetail: tab === 'detail',
      isStory: tab === 'story',





      menuOpen: this.state.menuOpen,
      showCounters: this.props.showCounters ?? true,
      // Visit counters: total page views (left, Mana) and unique visitors (right, Lodestar Bead).
      // A dash until the Supabase RPC resolves — and permanently a dash on local dev, where we
      // don't count. The tooltip spells out what each number is (also bilingual).
      pvCount: this.state.pv == null ? '—' : this.state.pv.toLocaleString('en-US'),
      uvCount: this.state.uv == null ? '—' : this.state.uv.toLocaleString('en-US'),
      pvTitle: this.t('counterPv'),
      uvTitle: this.t('counterUv'),
      // Community total votes cast across every illustration (likes + dislikes + skips), summed from
      // the flipStats map Flip already loads — no extra DB call, and it ticks up live as votes land.
      flipTotal: (() => {
        const s = this.state.flipStats;
        if (!s) return '—';
        let n = 0;
        for (const k in s) n += (s[k].likes || 0) + (s[k].dislikes || 0) + (s[k].skips || 0);
        return n.toLocaleString('en-US');
      })(),
      flipTotalTitle: this.t('counterFlips'),
      langToggleLabel: this.t('langToggle'),
      toggleLang: () => this.toggleLang(),
      brandMuseumLabel: this.t('brandMuseum'),
      heroSubtitle: this.t('heroSubtitle'),
      navNewsLabel: this.t('navNews'),
      navAboutLabel: this.t('navAbout'),
      // News / About dialogs.
      newsOpen: this.state.newsOpen,
      aboutOpen: this.state.aboutOpen,
      newsTitleText: this.t('newsTitle'),
      aboutTitleText: this.t('aboutTitle'),
      aboutIntroText: this.t('aboutIntro'),
      aboutCreditsTitleText: this.t('aboutCreditsTitle'),
      creditMeText: this.t('creditMe'),
      creditClaudeText: this.t('creditClaude'),
      creditSourcesText: this.t('creditSources'),
      creditWikiText: this.t('creditWiki'),
      creditMiaoText: this.t('creditMiao'),
      creditWikiGgText: this.t('creditWikiGg'),
      creditCommunityText: this.t('creditCommunity'),
      creditEliyaText: this.t('creditEliya'),
      creditNamuText: this.t('creditNamu'),
      creditOfficialText: this.t('creditOfficial'),
      officialSiteText: this.t('officialSite'),
      officialTwitterText: this.t('officialTwitter'),
      officialDemoText: this.t('officialDemo'),
      officialBiliText: this.t('officialBili'),
      dialogCloseText: this.t('dialogClose'),
      // Flattened to a single list (date headers + bullet lines) so the template uses one sc-for
      // with an sc-if per row — the verified pattern — rather than a nested sc-for.
      newsRows: CHANGELOG.flatMap(g => [
        { isDate: true, isLine: false, text: g.date },
        ...g.items.map(it => ({ isDate: false, isLine: true, text: it[this.state.lang] || it.en }))
      ]),
      // Decorative sprites, one per corner (top-left, top-right, bottom-left, bottom-right).
      dialogGifItems: (this.state.dialogGifs || []).slice(0, 4).map((url, i) => ({
        url,
        pos: ['top: 5px; left: 5px;', 'top: 5px; right: 5px;', 'bottom: 5px; left: 5px;', 'bottom: 5px; right: 5px;'][i]
      })),
      navStoryLabel: this.t('navStory'),
      navGalleryLabel: this.t('navGallery'),
      navMusicLabel: this.t('navMusic'),
      unitsScreenTitle: this.t('unitsScreenTitle'),
      loadingRosterText: this.t('loadingRoster'),
      loadingRosterWave: this.loadingWave('loadingRoster'),
      rosterErrorTitle: this.t('rosterErrorTitle'),
      rosterErrorHint: this.t('rosterErrorHint'),
      skillBtnLabel: this.t('skillBtn'),
      specialBtnLabel: this.t('specialBtn'),
      tabHomeLabel: this.t('tabHome'),
      tabArtLabel: this.t('tabArt'),
      tabUnitsLabel: this.t('tabUnits'),
      tabStoryLabel: this.t('tabStory'),
      tabMusicLabel: this.t('tabMusic'),
      tabArmsLabel: this.t('tabArms'),
      tabMenuLabel: this.t('tabMenu'),
      sectionLabel: sec ? sec.label : '',
      sectionDesc: sec ? sec.desc : '',
      sectionColor: sec ? sec.color : '#3E4450',
      // Swallows clicks inside the dialog so they don't reach the backdrop's close handler.
      // 各个弹窗（筛选、武器筛选、推特筛选、News/About、查看器）共用这一个绑定，所以它在外壳这段。
      stopDialogClick: (e) => e.stopPropagation(),
      goHome: () => this.go('home'),
      goArt: () => this.go('art'),
      goUnits: () => this.go('units'),
      goStory: () => this.go('story'),
      goMusic: () => this.go('music'),
      goArms: () => this.go('arms'),
      toggleMenu: () => this.setState(s => ({ menuOpen: !s.menuOpen })),
      closeMenu: () => this.setState({ menuOpen: false }),
      // News / About dialogs. Opening seeds a fresh set of decorative sprites (picked once, so
      // they don't reshuffle every render); closing clears them.
      openNews:  () => this.setState(s => ({ newsOpen: true, dialogGifs: pickDialogGifs(s.roster) })),
      closeNews: () => this.setState({ newsOpen: false, dialogGifs: [] }),
      openAbout:  () => this.setState(s => ({ aboutOpen: true, dialogGifs: pickDialogGifs(s.roster) })),
      closeAbout: () => this.setState({ aboutOpen: false, dialogGifs: [] }),
      menuItems: menuOrder.map(id => ({
        isUnits: id === 'units',
        isArms:  id === 'arms',
        isStory: id === 'story',
        isArt:   id === 'art',
        isMusic: id === 'music',
        label: this.sections[id].label,
        sub: this.sections[id].desc,
        color: this.sections[id].color,
        onClick: (e) => { e.stopPropagation(); this.go(id); }
      }))
    };
    // 底部 tab 栏的高亮：七个按钮同一套规则，所以用循环写键而不是逐个列出。
    ['Home', 'Art', 'Units', 'Story', 'Music', 'Arms', 'Menu'].forEach(name => {
      const id = name.toLowerCase();
      const active = id === 'menu' ? this.state.menuOpen : (id === 'units' ? (tab === 'units' || tab === 'detail') : tab === id);
      vals['tabBg' + name] = active ? accent : 'transparent';
      vals['tabCol' + name] = active ? '#FFFFFF' : '#8A93A5';
    });
    return vals;
  },};
