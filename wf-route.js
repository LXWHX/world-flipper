// 深链接（hash 路由）、文档标题、返回键 / Esc / 方向键 —— 见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。
//
// 本文件没有自己的屏幕，所以**没有** xVals(ctx)，renderVals 里也没有它的一行；它只挂在
// componentDidMount（装监听、吃首屏 hash）和 componentDidUpdate（兑现待定路由、写 URL、写标题）
// 这两个已有的生命周期钩子上。前缀纪律：方法与实例字段一律 route*，唯一的例外是 pendingRoute。
//
// --- 为什么是 hash 而不是 history.pushState -----------------------------------------------------
// 本仓库的本地开发就是 file://（ASSET_BASE 的第一个分支），而 file:// 文档的 origin 是 null，
// Chrome 在这种文档里调用 pushState 会抛 SecurityError。hash 没有这个限制，改 hash 一样进历史栈，
// 返回键因此白拿。boot() 会重新 fetch(location.href)（support.js:159），但 fragment 不参与请求，
// 所以带 hash 打开页面对它毫无影响。
//
// --- 为什么不去改那十几个导航函数 ---------------------------------------------------------------
// URL 是**从 state 推出来的**（routeHashFromState + syncRoute 挂在 componentDidUpdate 上），不是
// 由导航函数各自写的。go() / goDetail() / backFromDetail() / goArmDetail() / closeArmDetail() /
// openArcStory() / closeArcStory() / openArcEpisode() / closeArcEpisode() 全部原样未动，URL 自己
// 跟上——包括 related chip 那条 detail→detail 的路径，逐个改入口一定会漏掉它。
// 代价：站内的返回按钮也会**新增**一条历史记录（它是一次正向的 state 变化，本文件无从分辨它
// "其实是后退"）。于是浏览器返回会回到刚离开的详情页。这是有意接受的：URL 历史 = 浏览记录。

// 能直接做 hash 的 tab。'detail' 不在其中：详情页的规范形式是 char/<devName>。
const ROUTE_TABS = ['home', 'units', 'arms', 'story', 'art', 'music', 'flip'];

const WF_ROUTE = {

  // --- URL 与 state 的互相翻译 -----------------------------------------------------------------

  // 当前 state 的规范 hash（不带 '#'，各段未编码）。刻意不进 URL 的：筛选条件、sheetPanel、
  // arcTab，以及画廊两个 viewer 的下标——viewer 存的是 filtered 数组的下标，换个筛选就指向别的
  // 图，要做单图分享得先把它改成按 id（gallery 的 slug / X 的 file）反查。
  routeHashFromState() {
    const s = this.state;
    if (s.tab === 'detail') return s.selectedChar ? 'char/' + s.selectedChar.devName : 'units';
    if (s.tab === 'arms' && s.armDetail) return 'arms/' + s.armDetail.slug;
    if (s.tab === 'story' && s.arcStory) {
      return 'story/' + s.arcStory.slug
        + (s.arcEpisodeIndex !== null ? '/' + s.arcEpisodeIndex : '');
    }
    return s.tab;
  },

  // 地址栏里的 hash，逐段解码。武器 slug 和部分剧情 slug 是中文，浏览器序列化 URL 时会把它们
  // 百分号编码，所以比较一律在解码后的形式上做，写入时再逐段编码。
  routeCurrentHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return '';
    return raw.split('/').map(p => { try { return decodeURIComponent(p); } catch (e) { return p; } }).join('/');
  },

  // 解码后的 hash -> 路由对象。认不出来的返回 null（调用方会退回首页并 replace 掉 URL）。
  routeParse(decoded) {
    const parts = String(decoded || '').split('/').filter(Boolean);
    if (!parts.length) return { kind: 'tab', tab: 'home' };
    const head = parts[0];
    if (head === 'char') return parts[1] ? { kind: 'char', id: parts[1] } : { kind: 'tab', tab: 'units' };
    if (head === 'arms' && parts[1]) return { kind: 'arms', id: parts[1] };
    if (head === 'story' && parts[1]) {
      const ep = (parts[2] != null && /^\d+$/.test(parts[2])) ? parseInt(parts[2], 10) : null;
      return { kind: 'story', id: parts[1], ep: ep };
    }
    if (ROUTE_TABS.indexOf(head) !== -1) return { kind: 'tab', tab: head };
    return null;
  },

  // 写地址栏。routeLastWritten 记下我们自己写进去的值，好让随之而来的 hashchange 认出"这是自己
  // 的回声"而不是用户按了返回——比用定时器清一个 suppress 标志确定得多。
  routeWrite(decoded, replace) {
    const enc = decoded.split('/').map(encodeURIComponent).join('/');
    this.routeLastWritten = decoded;
    try {
      if (replace) location.replace(location.href.split('#')[0] + '#' + enc);
      else location.hash = enc;
    } catch (e) { /* 极少数环境禁掉了 URL 改写；深链接失效，页面照常 */ }
  },

  // --- 读入：应用一条路由，数据没到就挂起 ------------------------------------------------------

  // 冷启动落在 #char/fire_dragon 时 roster.json 还在路上，所以应用不了的路由先存进 pendingRoute，
  // 由 componentDidUpdate 里的 drainPendingRoute 在数据到齐后兑现。判"还没到"和判"根本没有"必须
  // 分开：前者继续等，后者立刻降级，否则一个拼错的 slug 会永远挂着。
  routeApply(route) {
    this.pendingRoute = null;
    if (!route) { this.routeFallback('home'); return; }
    const s = this.state;

    if (route.kind === 'char') {
      const c = this.rosterByDev.get(route.id);
      if (c) {
        if (!(s.tab === 'detail' && s.selectedChar && s.selectedChar.devName === route.id)) this.goDetail(c);
        return;
      }
      if (s.rosterLoading) { this.pendingRoute = route; return; }
      this.routeFallback('units');
      return;
    }

    if (route.kind === 'arms') {
      // go('arms') 顺带做了 loadWeapons()，并且会清掉可能残留的 armDetail。
      if (s.tab !== 'arms') this.go('arms');
      const w = (s.armWeapons || []).find(x => x.slug === route.id);
      if (w) {
        if (!s.armDetail || s.armDetail.slug !== route.id) this.goArmDetail(w);
        return;
      }
      if (!s.armLoaded) { this.pendingRoute = route; return; }
      this.routeFallback('arms');
      return;
    }

    if (route.kind === 'story') {
      // go('story') 顺带做了 loadArcIndex() + loadArcEn()。
      if (s.tab !== 'story') this.go('story');
      if (!s.arcIndex) { this.pendingRoute = route; return; }
      const st = s.arcIndex.find(x => x.slug === route.id);
      if (!st) { this.routeFallback('story'); return; }
      if (!s.arcStory || s.arcStory.slug !== route.id) {
        this.openArcStory(st);
        // 话数要等 story/detail/<slug>.json（英文则是 arcEnDetail）到了才开得了。
        if (route.ep !== null) this.pendingRoute = route;
        return;
      }
      if (route.ep === null) {
        if (s.arcEpisodeIndex !== null) this.closeArcEpisode();
        return;
      }
      if (s.arcEpisodeIndex === route.ep) return;
      const episodes = this.arcEnEpisodes() || (s.arcDetail && s.arcDetail.episodes);
      if (!episodes) {
        // 还在拉就继续等；拉回来是空的就放弃话数、把人留在剧情页（openArcEpisode 也会拒绝越界的
        // 下标，那种情况同样只是停在剧情页）。
        this.pendingRoute = s.arcDetailLoading ? route : null;
        return;
      }
      // 阅读器是 arcShowReader 渲染的，而它同时要求 arcTab === 'story'（wf-story.js:309）——从界面
      // 里打开话数必然是从话数列表点进去的，那时 arcTab 早就是 'story' 了，深链接却不是：
      // openArcStory 会按 defaultArcTab 把有简介的剧情落在 'info' 上。只设 arcEpisodeIndex 的话
      // state 全对、屏幕上却还是情报页。
      if (this.state.arcTab !== 'story') this.setArcTab('story');
      this.openArcEpisode(route.ep);
      return;
    }

    // 纯 tab。从详情页离开时要顺手清掉 selectedChar —— backFromDetail 就是这么做的。
    const tab = route.tab;
    if (s.tab === 'story' && s.arcStory && tab === 'story') { this.closeArcStory(); return; }
    if (s.tab !== tab) this.go(tab);
    if (s.tab === 'detail') this.setState({ selectedChar: null });
  },

  // id 认不出来（角色改了名、slug 拼错、别人手改的链接）时的降级：静默回到该 tab 的列表页，把
  // URL replace 掉（不留一条通向死链的历史记录），不弹任何错误。
  routeFallback(tab) {
    const wasDetail = this.state.tab === 'detail';
    if (this.state.tab !== tab) this.go(tab);
    if (wasDetail) this.setState({ selectedChar: null });
    this.routeWrite(tab, true);
  },

  drainPendingRoute() {
    if (this.pendingRoute) this.routeApply(this.pendingRoute);
  },

  // --- 写出：state -> URL ----------------------------------------------------------------------

  syncRoute() {
    // 还在兑现一条待定路由时，URL 已经是目标、state 还没跟上，这时候同步会把 URL 打回去。
    if (this.pendingRoute) return;
    const want = this.routeHashFromState();
    const cur = this.routeCurrentHash();
    if (cur === want) return;
    // 首屏没有 hash 时不要凭空补一个 '#home' 出来。
    if (want === 'home' && cur === '') return;
    this.routeWrite(want, false);
  },

  // --- 文档标题 -------------------------------------------------------------------------------

  // index.html 的 <title> 只是兜底（首屏、以及抓取器看到的那一份）。这里按当前屏改写它，只在字符
  // 串真的变了才赋值 —— componentDidUpdate 在播放时每秒都会跑好几遍。
  syncDocumentTitle() {
    const s = this.state;
    const brand = this.t('routeBrand');
    let title = brand;
    if (s.tab === 'detail' && s.selectedChar) {
      const c = s.selectedChar;
      title = ((s.lang === 'zh' && c.zhName) ? c.zhName : (c.enName || c.zhName || c.devName)) + ' · ' + brand;
    } else if (s.tab === 'arms' && s.armDetail) {
      const w = s.armDetail;
      const name = (s.lang === 'en' && w.en && w.en.name) ? w.en.name : w.nameZh;
      title = name + ' · ' + brand;
    } else if (s.tab === 'story' && s.arcStory) {
      title = this.arcTitleFor(s.arcStory) + ' · ' + brand;
    } else if (s.tab === 'flip') {
      // `sections` 是五个有横幅的屏幕，弹弹不在其中（它是首页那颗红按钮开的），所以它的名字得
      // 单独取——不补这一条，弹弹页的标签页就只剩一个光秃秃的站名。
      title = this.t('flipScreenTitle') + ' · ' + brand;
    } else if (s.tab !== 'home') {
      const sec = this.sections[s.tab];
      if (sec) title = sec.label + ' · ' + brand;
    }
    if (title !== this.routeLastTitle) {
      this.routeLastTitle = title;
      document.title = title;
    }
  },

  // --- 浮层：返回键与 Esc 该先关掉谁 ------------------------------------------------------------

  // 自上而下的浮层优先级。这些层**不进 URL**（它们不值得分享，也不该占历史记录），所以返回键要
  // 靠这张表拦一道：有浮层开着就先关最上面那层，把 hash 写回原值。
  routeOverlays() {
    const s = this.state;
    return [
      [s.galViewer !== null, () => this.closeGalViewer()],
      // closeTwtViewer 里有 stopTwtVideo()，绕过它会留下一个在别的屏幕后面继续出声的 <video>。
      [s.twtViewer !== null, () => this.closeTwtViewer()],
      [s.overlayOpen, () => this.setState({ overlayOpen: false, overlayGif: null })],
      [s.filterOpen, () => this.closeFilter()],
      [s.armFilterOpen, () => this.closeArmFilter()],
      [s.twtFilterOpen, () => this.closeTwtFilter()],
      [s.roomQueueOpen, () => this.setState({ roomQueueOpen: false })],
      [s.roomVolOpen, () => this.setState({ roomVolOpen: false })],
      [s.menuOpen, () => this.setState({ menuOpen: false })],
      [s.newsOpen, () => this.setState({ newsOpen: false, dialogGifs: [] })],
      [s.aboutOpen, () => this.setState({ aboutOpen: false, dialogGifs: [] })]
    ];
  },

  routeCloseTopOverlay() {
    const hit = this.routeOverlays().find(l => l[0]);
    if (!hit) return false;
    hit[1]();
    return true;
  },

  // --- 事件 -----------------------------------------------------------------------------------

  routeOnHashChange() {
    const cur = this.routeCurrentHash();
    if (cur === this.routeLastWritten) return; // 自己刚写进去的，不是用户按了返回
    if (this.routeCloseTopOverlay()) {
      // 返回键先用来关浮层。把 hash 写回来，于是"再按一次返回"才真的离开这一屏。
      this.routeWrite(this.routeHashFromState(), false);
      return;
    }
    this.routeApply(this.routeParse(cur));
  },

  routeOnKeyDown(e) {
    // 输入框里按方向键是移动光标，Esc 是清空/取消，都不该被劫走（筛选和音乐室都有输入框）。
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) return;

    if (e.key === 'Escape') {
      if (this.routeCloseTopOverlay()) { e.preventDefault(); return; }
      // 没有浮层可关，就按屏幕自己的返回语义退一层（和各屏左上角的返回按钮同一批函数）。
      const s = this.state;
      if (s.tab === 'detail') { this.backFromDetail(); e.preventDefault(); return; }
      if (s.tab === 'arms' && s.armDetail) { this.closeArmDetail(); e.preventDefault(); return; }
      if (s.tab === 'story' && s.arcEpisodeIndex !== null) { this.closeArcEpisode(); e.preventDefault(); return; }
      if (s.tab === 'story' && s.arcStory) { this.closeArcStory(); e.preventDefault(); return; }
      return;
    }

    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const delta = e.key === 'ArrowLeft' ? -1 : 1;
    const s = this.state;
    // 桌面端的顺手收益：画廊两面墙的大图和详情页的表情，触摸端本来就能滑，键盘也接上。
    if (s.galViewer !== null) { this.galViewerStep(delta); e.preventDefault(); return; }
    if (s.twtViewer !== null) { this.twtViewerStep(delta); e.preventDefault(); return; }
    if (s.tab === 'detail' && s.sheetPanel === 'profile') { this.emotionStep(delta); }
  },

  // componentDidMount 调一次：装监听 + 吃掉首屏 hash。
  routeInstall() {
    this.pendingRoute = null;
    this.routeLastWritten = null;
    this.routeLastTitle = '';
    window.addEventListener('hashchange', () => this.routeOnHashChange());
    // 只改 fragment 的同文档导航发的是 hashchange；popstate 一并挂上是零成本的保险。
    window.addEventListener('popstate', () => this.routeOnHashChange());
    window.addEventListener('keydown', (e) => this.routeOnKeyDown(e));
    const cur = this.routeCurrentHash();
    if (cur) this.routeApply(this.routeParse(cur));
  }
};
