// 共享核心：三个资源根、画布尺寸、Supabase 配置、STRINGS 文案表、角色与武器共用的表 —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。

// Points at the Cloudflare R2 public bucket URL (or custom domain) once assets are uploaded there.
// Falls back to the local folder for development on this machine.
const ASSET_BASE = location.protocol === 'file:' || location.hostname === 'localhost'
  ? 'Character Assets'
  : 'https://pub-e1f9dd7473954e4b9b7d20b302cddb4a.r2.dev';

// Visit counters (top status bar). A single Supabase RPC, `record_visit(vid)`, bumps the total
// page-view count, registers this browser's visitor id (a random uuid persisted in localStorage,
// so it's deduped across reloads) and returns { pv, uv }. The anon key is safe to ship: it only
// grants EXECUTE on that one SECURITY DEFINER function — the underlying tables stay behind RLS
// with no policies, so nothing else is readable or writable. Fill these in after creating the
// project + running the SQL in the setup notes; while they hold the placeholder the counters just
// show a dash. See the `record_visit` recording path in componentDidMount.
const SUPABASE_URL = 'https://lgxnpzdzhnfvxmrzgevg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxneG5wemR6aG5mdnhtcnpnZXZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxODczNjUsImV4cCI6MjA5OTc2MzM2NX0.FvC9ttc5rri71_URT-hRk4xG6gG-bTDyJK5g4-HP9k4';
const VISITOR_STORAGE_KEY = 'wf_visitor_id';
// --- Art window for the two horizontal 5-row strips (Units roster, Armaments library) ---------
// Pagination alone was not enough on iOS. `visibleCount`/`armVisibleCount` only grow, and neither
// resets on a tab change, so a user who has scrolled the roster keeps 485 tiles alive — each
// pinning a 212x212 head.png, ~180KB decoded, **~82MB for the set** — and `sc-if` re-creates the
// whole set in a single commit every time the tab is re-entered. Coming back from the Armaments
// library (which has just added 384 icons and its two JSON files, evicting the roster's decoded
// images) put the peak over WebKit's per-tab budget and iOS killed the tab. Android's looser
// limits are why only iOS crashed.
//
// **What is windowed is the artwork, not the tiles.** Every paged-in tile stays mounted at its own
// place in the grid; only the one expensive image inside it (the roster's `head.png`, the weapon's
// icon) is gated on being near the scroll position. Mounting a *slice* of tiles instead was tried
// and is a trap here: `sc-for` keys its children by index (see walkFor in support.js), so a window
// that slides by one column doesn't move any DOM — it rewrites the `src` of all ~105 mounted
// images, turning a flick into hundreds of loads and decodes. Worse, the strip's geometry then
// depends on the window being right, so any disagreement between the window and the real
// scrollLeft paints an empty spacer and the strip appears to never load at all.
//
// Gating art keeps the item->element mapping fixed: scrolling only adds and removes the images
// actually entering and leaving the window, and a wrong window costs nothing but a few missing
// portraits for one frame — the pixel sprite, pedestal, stars and name are always there, because
// all 482 sprites together decode to under 6MB.
// How many strip images may be fetched at once. The strips' tiles carry one image each that is
// unique per item (the roster's head.png, the weapon's icon), and nothing throttled them: opening
// the Armaments library fired 40 requests at once, paging it to 384 peaked at 255, and switching
// back to the roster — which remounts 482 tiles with a portrait and a sprite each — peaked at 354
// (measured over a local HTTP server; `file://` hides this entirely). Desktop shrugs that off. iOS
// does not: hundreds of parallel HTTP/2 streams, each with its buffer and each decoding on
// arrival, is what was killing the renderer, which is why the crash only ever happened while the
// strip was still loading and never once everything was cached.
//
// 16 is picked against the two numbers that actually bound this. The familiar "6 per host" is an
// HTTP/1.1 connection limit (Chrome and Safari both cap at 6) and does not apply here: R2 is
// HTTP/2, so everything shares one connection and the real ceiling is the server's
// SETTINGS_MAX_CONCURRENT_STREAMS, which RFC 7540 says should be at least 100. The other number is
// this site's own: the renderer died somewhere in the 255-354 range measured above. 16 sits a full
// order of magnitude below that while roughly halving the time to fill a 60-tile batch — the point
// is the ceiling, not the exact number.
// Note the pixel sprite (neutral.gif) deliberately does NOT go through this gate: a tile without it
// looks broken, and all 482 sprites decode to under 6MB. So the momentary peak is this number plus
// a handful of ungated sprite requests, not this number exactly.
const ART_MAX_INFLIGHT = 16;
// Newly loaded art is shown in batches rather than one re-render per image: renderVals rebuilds
// the whole tree, and 482 individual renders would cost more than the loads.
const ART_BATCH_MS = 120;
const GRID_ROWS = 5;           // grid-template-rows: repeat(5, 116px)
const GRID_COL_PITCH = 98;     // 92px grid-auto-columns + 6px column-gap
const GRID_WINDOW_COLS = 12;   // buffer columns kept loaded on each side of the viewport
const GRID_RECENTER_COLS = 3;  // how far the scroll may drift before the window is recomputed
// The Units grid stands each character's pixel sprite on a pedestal tinted by their attribute
// (the game's own party screen colours its bases too). `top` is the elliptical face the sprite
// stands on, `side` the trapezoid body below it that carries the rarity strip.
const PEDESTAL = {
  Fire: { top: '#FFB877', side: '#D9723A' },
  Water: { top: '#7EC4F5', side: '#3D82C4' },
  Thunder: { top: '#FFD861', side: '#D9A32C' },
  Wind: { top: '#93D18C', side: '#4E9A57' },
  Light: { top: '#F3EBD3', side: '#BFB18C' },
  Dark: { top: '#B6A2DE', side: '#7059A8' }
};
const PEDESTAL_DEFAULT = { top: '#E4E9F0', side: '#A9B3C2' };
// The game's own attribute order (character.json's row[3] index) — it drives both the Units
// grid's sort and the filter's element chips, so the two always agree.
const ELEMENT_ORDER = ['Fire', 'Water', 'Thunder', 'Wind', 'Light', 'Dark'];
// 5★->1★，和上游的排序一致。角色筛选和武器筛选共用这一份（武器筛选的稀有度 chips 就是复用它），
// 所以它在 core 而不在 wf-units.js —— 和 ELEMENT_ORDER / PEDESTAL 同样的理由。
const FILTER_RARITIES = [5, 4, 3, 2, 1];
// Points at the top-level Weapons/ folder locally, and the R2 bucket's Weapons/ prefix live.
// Weapons/ is a sibling of Character Assets/, so it can't ride ASSET_BASE — see upload-to-r2.mjs,
// which ships it under a Weapons/ key prefix that matches the live URL here.
const WEAPON_BASE = location.protocol === 'file:' || location.hostname === 'localhost'
  ? 'Weapons'
  : 'https://pub-e1f9dd7473954e4b9b7d20b302cddb4a.r2.dev/Weapons';
// X/gallery-dl/twitter/world_flipper/ is another sibling of Character Assets/, so like WEAPON_BASE
// this can't ride ASSET_BASE; upload-to-r2.mjs ships that folder under an X/ key prefix matching
// the live URL here, and every path in x_index.json is relative to this base.
//
const X_BASE = location.protocol === 'file:' || location.hostname === 'localhost'
  ? 'X/gallery-dl/twitter/world_flipper'
  : 'https://pub-e1f9dd7473954e4b9b7d20b302cddb4a.r2.dev/X';
const LANG_STORAGE_KEY = 'wf_lang';
const STRINGS = {
  brandMuseum: { en: 'MUSEUM', zh: '博物馆' },
  counterPv: { en: 'Total visits', zh: '总访问量' },
  counterUv: { en: 'Unique visitors', zh: '独立访客' },
  counterFlips: { en: 'Total flips', zh: '总弹弹数' },
  volume: { en: 'Volume', zh: '音量' },
  heroSubtitle: { en: 'MUSEUM & ARCHIVE', zh: '博物馆与档案馆' },
  navNews: { en: 'News', zh: '资讯' },
  navAbout: { en: 'About', zh: '关于' },
  // News (changelog) + About dialogs, opened from the two home-screen tags. The changelog copy
  // itself lives in CHANGELOG (below); these are just the frame chrome. dialogClose is shared.
  newsTitle: { en: 'News', zh: '更新日志' },
  aboutTitle: { en: 'About', zh: '关于本站' },
  aboutIntro: {
    en: 'A fan-made museum & archive for the mobile game World Flipper — its characters, art, story, and music. Not affiliated with the official game.',
    zh: '一个非官方的手游《世界弹射物语》博物馆与档案馆——收录角色、立绘、剧情与音乐。与官方无关。'
  },
  aboutCreditsTitle: { en: 'Credits', zh: '制作鸣谢' },
  creditMe: { en: 'Myself', zh: '我自己' },
  creditClaude: { en: 'Claude Code', zh: 'Claude Code' },
  creditSources: { en: 'Data sources', zh: '数据来源' },
  creditWiki: { en: 'Bilibili World Flipper Wiki', zh: 'bilibili 世界弹射物语 wiki' },
  creditMiao: { en: 'miaowm5 Encyclopedia', zh: 'miaowm5 图鉴' },
  creditWikiGg: { en: 'World Flipper Wiki (wiki.gg)', zh: 'World Flipper Wiki（wiki.gg）' },
  creditCommunity: { en: 'WF EN Story Archive (community)', zh: '英文社区剧情档案表' },
  creditEliya: { en: 'Eliya-bot (Global data)', zh: 'Eliya-bot（国际服数据）' },
  creditNamu: { en: 'namu.wiki (story summaries, machine-translated)', zh: 'namu.wiki（剧情简介，机翻）' },
  creditOfficial: { en: 'Official links', zh: '官方链接' },
  officialSite: { en: 'Official Website', zh: '官方网站' },
  officialTwitter: { en: 'Official X (Twitter)', zh: '官方推特' },
  officialDemo: { en: 'Play Demo', zh: '试玩 Demo' },
  officialBili: { en: 'CN Official Bilibili', zh: '国服官方 B 站' },
  dialogClose: { en: 'Close', zh: '关闭' },
  navStory: { en: 'Story', zh: '剧情' },
  navGallery: { en: 'Gallery', zh: '画廊' },
  // The home screen's centre button opens the Flip deck, not the roster — Units stays reachable
  // from the bottom tab bar and the menu.
  navFlip: { en: 'Flip', zh: '弹弹' },
  navMusic: { en: 'Music', zh: '音乐' },
  tabHome: { en: 'Home', zh: '首页' },
  tabArt: { en: 'Art', zh: '画廊' },
  tabUnits: { en: 'Units', zh: '角色' },
  tabStory: { en: 'Story', zh: '剧情' },
  tabMusic: { en: 'Music', zh: '音乐' },
  tabArms: { en: 'Arms', zh: '武器' },
  tabMenu: { en: 'Menu', zh: '菜单' },
  unitsScreenTitle: { en: 'Characters', zh: '角色' },
  loadingRoster: { en: 'Loading roster…', zh: '角色加载中…' },
  failedToLoadRoster: { en: 'Failed to load roster', zh: '角色加载失败' },
  unitsShownSuffix: { en: ' units shown', zh: ' 个角色' },
  rosterErrorTitle: { en: "Couldn't load roster.json", zh: '无法加载角色数据' },
  rosterErrorHint: {
    en: 'Serve this page over http(s) (e.g. `npx serve` or `python -m http.server`) — opening it as a local file:// URL blocks the fetch.',
    zh: '请通过 http(s) 提供此页面（例如 `npx serve` 或 `python -m http.server`）——以本地 file:// 方式打开会导致请求被阻止。'
  },
  // Units filter. Copy is taken verbatim from miaowm5's own i18n.json (dialog.filterCharacter.*)
  // so the ported dialog reads exactly like theirs. Note four race labels don't match their data
  // key: Element is shown as "Elf", Devil as "Demon", Mystery as "Fairy", Plants as "Plant".
  filterTitle: { en: 'Filter', zh: '筛选' },
  filterName: { en: 'Name', zh: '角色名' },
  filterNameHint: { en: 'Search by character name', zh: '通过角色名搜索' },
  filterRarity: { en: 'Rarity', zh: '稀有度' },
  filterElement: { en: 'Element', zh: '属性' },
  filterGender: { en: 'Gender', zh: '性别' },
  filterRace: { en: 'Race', zh: '种族' },
  filterOk: { en: 'OK', zh: '确定' },
  filterCancel: { en: 'Cancel', zh: '取消' },
  filterNoMatch: { en: 'No characters match this filter', zh: '没有符合条件的角色' },
  filterRarity5: { en: '5', zh: '五' },
  filterRarity4: { en: '4', zh: '四' },
  filterRarity3: { en: '3', zh: '三' },
  filterRarity2: { en: '2', zh: '二' },
  filterRarity1: { en: '1', zh: '一' },
  filterElementFire: { en: 'Fire', zh: '火' },
  filterElementWater: { en: 'Water', zh: '水' },
  filterElementThunder: { en: 'Thunder', zh: '雷' },
  filterElementWind: { en: 'Wind', zh: '风' },
  filterElementLight: { en: 'Light', zh: '光' },
  filterElementDark: { en: 'Dark', zh: '暗' },
  filterGenderFemale: { en: 'Female', zh: '女' },
  filterGenderMale: { en: 'Male', zh: '男' },
  filterGenderOther: { en: 'Other', zh: '其他' },
  filterRaceHuman: { en: 'Human', zh: '人' },
  filterRaceElement: { en: 'Elf', zh: '精灵' },
  filterRaceDevil: { en: 'Demon', zh: '魔' },
  filterRaceBeast: { en: 'Beast', zh: '兽' },
  filterRaceMachine: { en: 'Machine', zh: '机械' },
  filterRaceMystery: { en: 'Fairy', zh: '妖' },
  filterRaceDragon: { en: 'Dragon', zh: '龙' },
  filterRaceUndead: { en: 'Undead', zh: '不死' },
  filterRaceAquatic: { en: 'Aquatic', zh: '水棲' },
  filterRacePlants: { en: 'Plant', zh: '植物' },
  skillBtn: { en: 'Skill', zh: '技能' },
  specialBtn: { en: 'Special', zh: '必杀' },
  overlaySkill: { en: 'SKILL', zh: '技能' },
  overlaySpecial: { en: 'SPECIAL', zh: '必杀' },
  artBase: { en: 'Base', zh: '普通' },
  artAwakened: { en: 'Awakened', zh: '觉醒' },
  trackTheme: { en: 'Theme', zh: '主题曲' },
  trackArrange: { en: 'Arrange', zh: '编曲' },
  langToggle: { en: '中文', zh: 'EN' },
  sectionArtLabel: { en: 'Art Gallery', zh: '画廊' },
  sectionArtDesc: { en: 'Key visuals & chapter orbs from every story', zh: '全部剧情的主视觉图与章节宝珠' },
  sectionUnitsLabel: { en: 'Characters', zh: '角色' },
  sectionUnitsDesc: { en: 'Unit profiles & episodes', zh: '角色资料与剧情' },
  sectionStoryLabel: { en: 'Story Archive', zh: '剧情档案' },
  sectionStoryDesc: { en: 'Main story & event episodes', zh: '主线剧情与活动剧情' },
  sectionMusicLabel: { en: 'Music Room', zh: '音乐室' },
  sectionMusicDesc: { en: 'BGM & soundtrack collection', zh: '游戏原声音乐收藏' },
  sectionArmsLabel: { en: 'Armaments', zh: '武器装备' },
  sectionArmsDesc: { en: 'Weapons & equipment', zh: '武器与装备' },
  // Weapons (the Armaments tab): the 武器库 library grid + 武器详情 detail, fed by Weapons/weapons.json.
  // `arm` prefix throughout (state/handlers/renderVals) so none of it collides with the Units grid.
  weaponsScreenTitle: { en: 'Armaments', zh: '武器库' },
  armShownSuffix: { en: ' weapons shown', zh: ' 件武器' },
  loadingWeapons: { en: 'Loading weapons…', zh: '武器加载中…' },
  weaponsErrorTitle: { en: "Couldn't load weapons.json", zh: '无法加载武器数据' },
  armNoMatch: { en: 'No weapons match this filter', zh: '没有符合条件的武器' },
  armFilterName: { en: 'Name', zh: '武器名' },
  armFilterNameHint: { en: 'Search by weapon name', zh: '通过武器名搜索' },
  armFilterRole: { en: 'Role', zh: '能力' },
  armElementNone: { en: 'None', zh: '无' },
  armStatHp: { en: 'HP', zh: '生命值' },
  armStatAtk: { en: 'ATK', zh: '攻击力' },
  armStatsTitle: { en: 'Stats', zh: '属性' },
  armStatBase: { en: 'Base', zh: '初始' },
  armStatMax: { en: 'Max', zh: '满级' },
  armEffectTitle: { en: 'Effect', zh: '效果' },
  armMaxEffectTitle: { en: 'Max Effect', zh: '最大效果' },
  armAcquireTitle: { en: 'How to obtain', zh: '获取方式' },
  armLoreTitle: { en: 'Lore', zh: '图鉴描述' },
  armMetaRole: { en: 'Role', zh: '能力' },
  armMetaLimit: { en: 'Limit', zh: '限制' },
  armMetaSystem: { en: 'System', zh: '体系' },
  wikiSectionInfo: { en: 'Profile', zh: '基本信息' },
  wikiSectionSkills: { en: 'Skills', zh: '技能' },
  wikiSectionStory: { en: 'Character Story', zh: '角色故事' },
  wikiSectionReview: { en: 'Evaluation', zh: '评价' },
  wikiSectionVoice: { en: 'Voice Lines', zh: '语音' },
  // English character/weapon content from worldflipper.wiki.gg (scrape-wiki-gg-*.mjs). The three
  // wikiEn* labels caption the {{Unit}} template's skill blocks, which have no Chinese equivalent
  // to borrow a caption from. wikiSourceGg is the CC BY-SA attribution shown under English text.
  wikiSectionQuotes: { en: 'Quotes (English)', zh: '英文台词' },
  wikiEnSkill: { en: 'Skill', zh: '必杀技能' },
  wikiEnLeaderTalent: { en: 'Leader Talent', zh: '队长技' },
  wikiEnAbilities: { en: 'Abilities', zh: '能力' },
  wikiSourceGg: { en: 'English text from worldflipper.wiki.gg (CC BY-SA)', zh: '英文资料来自 worldflipper.wiki.gg（CC BY-SA）' },
  // Shown instead of the wiki.gg line when the English text came from the Eliya-bot GL fallback.
  wikiSourceEliya: { en: 'English text from Eliya-bot (Global release data)', zh: '英文资料来自 Eliya-bot（国际服数据）' },
  wikiFieldNickname: { en: 'Nickname', zh: '昵称' },
  wikiFieldType: { en: 'Type', zh: '类型' },
  wikiFieldRole: { en: 'Role', zh: '职责' },
  wikiFieldGender: { en: 'Gender', zh: '性别' },
  wikiFieldRace: { en: 'Race', zh: '种族' },
  wikiFieldCv: { en: 'CV', zh: 'CV' },
  wikiFieldAcquisition: { en: 'Acquisition', zh: '获取方式' },
  wikiSource: { en: 'Source: bilibili biligame Wiki (Chinese)', zh: '资料来源：哔哩哔哩百科（中文 wiki）' },
  wikiNoVoice: { en: 'No voice lines available yet.', zh: '暂无语音数据。' },
  panelProfile: { en: 'Profile', zh: '主界面' },
  panelVoice: { en: 'Voice Lines', zh: '台词' },
  panelStory: { en: 'Character Story', zh: '角色剧情' },
  panelRelated: { en: 'Related & Keywords', zh: '关联角色' },
  storyListTitle: { en: 'Character Story', zh: '角色剧情' },
  storyLoading: { en: 'Loading story…', zh: '剧情加载中…' },
  detailArtLoading: { en: 'Loading art…', zh: '立绘加载中…' },
  storyEmpty: { en: 'No story available yet.', zh: '暂无剧情数据。' },
  storyBack: { en: 'Back', zh: '返回' },
  relatedCharsTitle: { en: 'Related Characters', zh: '关联角色' },
  relatedKeywordsTitle: { en: 'Keywords', zh: '关键词' },
  relatedEmpty: { en: 'No related entries yet.', zh: '暂无关联数据。' },
  emotionsTitle: { en: 'Expressions', zh: '表情' },
  emotionOverlaysTitle: { en: 'Add-ons', zh: '叠加配件' },
  overlaySweat: { en: 'Sweat', zh: '汗' },
  overlayShame: { en: 'Blush', zh: '脸红' },
  overlayCheek: { en: 'Cheeks', zh: '腮红' },
  overlayTear: { en: 'Tears', zh: '眼泪' },
  overlayCostume: { en: 'Costume', zh: '服装' },
  overlayDisguise: { en: 'Disguise', zh: '伪装' },
  overlayEarring: { en: 'Earring', zh: '耳环' },
  overlayGlasses: { en: 'Glasses', zh: '眼镜' },
  overlaySunglass: { en: 'Sunglasses', zh: '墨镜' },
  overlayEffect: { en: 'Effect', zh: '特效' },
  storyBackToList: { en: 'Back to episode list', zh: '返回剧情列表' },
  // Flip (弹弹): the art-voting swipe deck. The card's variant chip reuses artBase/artAwakened
  // above rather than duplicating them — only the bust variant is new here.
  flipScreenTitle: { en: 'Flip', zh: '弹弹' },
  flipLike: { en: 'Like', zh: '喜欢' },
  flipDislike: { en: 'Dislike', zh: '不喜欢' },
  flipSkip: { en: 'Skip', zh: '跳过' },
  flipHint: {
    en: 'Swipe right to like, left to pass, down to skip',
    zh: '右滑喜欢，左滑不喜欢，往下滑跳过'
  },
  flipTapHint: { en: 'Tap the art for details', zh: '点击立绘查看详情' },
  flipVoteHint: { en: 'VOTE', zh: '投票' },
  flipLoading: { en: 'Shuffling the deck…', zh: '正在洗牌…' },
  flipDone: { en: "That's every illustration", zh: '所有立绘都看完了' },
  flipReshuffle: { en: 'Shuffle again', zh: '再来一轮' },
  flipProgressSuffix: { en: ' left', zh: ' 张待看' },
  flipVariantBust: { en: 'Bust', zh: '半身' },
  // Story archive (the Story tab: main/event/collab story browser)
  arcLoadingIndex: { en: 'Loading stories…', zh: '剧情加载中…' },
  arcIndexError: { en: 'Failed to load stories', zh: '剧情加载失败' },
  arcNoStories: { en: 'No stories match this filter', zh: '没有符合条件的剧情' },
  arcFilterAll: { en: 'All', zh: '全部' },
  arcFilterMain: { en: 'Main', zh: '主线' },
  arcFilterEvent: { en: 'Event', zh: '活动' },
  arcFilterCollab: { en: 'Collab', zh: '联动' },
  arcTabInfo: { en: 'Info', zh: '情报' },
  arcTabStory: { en: 'Episodes', zh: '剧情' },
  arcTabGallery: { en: 'Gallery', zh: '画廊' },
  arcTabBgm: { en: 'Music', zh: '音乐' },
  arcInfoTitle: { en: 'Info', zh: '情报' },
  arcSummaryNotice: { en: 'Auto-translated plot summary, adapted from namu.wiki (CC BY-NC-SA) — may contain errors.', zh: '以下简介为机器翻译，改编自 namu.wiki（CC BY-NC-SA），可能有误。' },
  arcEpisodesTitle: { en: 'Episodes', zh: '剧情' },
  arcGalleryTitle: { en: 'Gallery', zh: '画廊' },
  arcBgmTitle: { en: 'Music', zh: '相关音乐' },
  arcLoadingDetail: { en: 'Loading…', zh: '加载中…' },
  arcLoadingEpisode: { en: 'Loading episode…', zh: '剧情加载中…' },
  arcNoEpisodes: { en: 'No episodes available yet.', zh: '暂无剧情数据。' },
  arcBackToStories: { en: 'Stories', zh: '剧情列表' },
  // Art tab (the gallery wall). The category chips reuse arcFilterAll/Main/Event/Collab above —
  // it's the same ARC_CATEGORIES table.
  galLoading: { en: 'Loading gallery…', zh: '画廊加载中…' },
  galLoadError: { en: 'Failed to load the gallery index.', zh: '画廊索引加载失败。' },
  galEmpty: { en: 'No artwork in this category.', zh: '该分类暂无插画。' },
  galCount: { en: '{n} images', zh: '{n} 张' },
  galOrbLabel: { en: 'Chapter Orb', zh: '章节宝珠' },
  // The Art tab's source toggle and the official X media wall. Nothing here is content — the
  // archive has no captions, titles or tags at all (see X_BASE) — so it's all chrome. The filter
  // dialog reuses filterTitle/filterOk/filterCancel; year chips are labelled with the bare year.
  galSourceStory: { en: 'Story Art', zh: '剧情画廊' },
  galSourceX: { en: 'Official X', zh: '官方推特' },
  twtTypeimage: { en: 'Images', zh: '图片' },
  twtTypevideo: { en: 'Video', zh: '视频' },
  twtFilterYear: { en: 'Year', zh: '年份' },
  twtFilterType: { en: 'Type', zh: '类型' },
  twtLoading: { en: 'Loading media…', zh: '媒体加载中…' },
  twtLoadError: { en: 'Failed to load the media index.', zh: '媒体索引加载失败。' },
  twtEmpty: { en: 'Nothing matches this filter.', zh: '该筛选暂无内容。' },
  twtCount: { en: '{n} posts', zh: '{n} 条' },
  twtOpenOnX: { en: 'View on X →', zh: '在 X 查看 →' },
  twtSource: { en: 'Official posts from @world_flipper on X', zh: '来自 X 官方账号 @world_flipper' },
  // Community playthrough videos (the Google Sheet the fetch:community-en pipeline reads). They
  // stand in for the stories nobody has transcribed, so the copy has to be honest about what the
  // link is: someone else's recording, on YouTube, sometimes without English.
  videosTitle: { en: 'Watch in English', zh: '英文实况' },
  videoBy: { en: 'Playthrough by {by}', zh: '实况录像：{by}' },
  videoWatch: { en: 'Playthrough on YouTube', zh: 'YouTube 实况录像' },
  videoRaw: { en: 'no English subtitles', zh: '无英文字幕' },
  videoSourceCommunity: {
    en: 'Video links from the community story archive sheet',
    zh: '视频链接来自社区剧情整理表格'
  },
  roomSectionChar: { en: 'Character Themes', zh: '角色主题曲' },
  roomSectionWorld: { en: 'World & Events', zh: '世界原声' },
  roomSearchHint: { en: 'Search music…', zh: '搜索音乐…' },
  roomLoading: { en: 'Loading music…', zh: '音乐加载中…' },
  roomLoadError: { en: 'Failed to load the music index.', zh: '音乐索引加载失败。' },
  roomNoResults: { en: 'No matching tracks.', zh: '没有符合条件的曲目。' },
  roomBack: { en: 'Music Room', zh: '音乐室' },
  roomTracksSuffix: { en: ' tracks', zh: ' 首' },
  roomModeOrder: { en: 'In order', zh: '顺序' },
  roomModeShuffle: { en: 'Shuffle', zh: '随机' },
  roomModeRepeat: { en: 'Repeat one', zh: '单曲循环' },
  roomUpNextLabel: { en: 'Up next', zh: '即将播放' },
  roomUpNextEmpty: { en: 'Nothing queued next', zh: '没有更多歌曲' },
  roomPlaylistLabel: { en: 'Play all', zh: '播放全部' },
  roomPlaylistChar: { en: 'Characters', zh: '人物音乐' },
  roomPlaylistWorld: { en: 'World', zh: '世界音乐' },
  roomPlaylistAll: { en: 'Everything', zh: '全部' },
  actionIntoCoffin: { en: 'Down', zh: '倒下' },
  actionGhostRaise: { en: 'Ghost', zh: '化灵' },
  actionGhostNeutral: { en: 'Spirit', zh: '灵体' },
  actionRevive: { en: 'Revive', zh: '复活' },
  miaowm5Source: {
    en: 'Story / expressions / pixel data: worldflipper.miaowm5.com',
    zh: '剧情 / 表情 / 像素数据来源：worldflipper.miaowm5.com'
  }
};
// Name-plate colour for dialogue rows whose source doesn't give one. The Chinese scripts carry a
// per-speaker colour from the game's own data; wiki.gg's {{DU}} only sets one for the occasional
// unnamed speaker, and the plate's text is white — so an empty value would render invisible.
const DIALOG_PLATE_DEFAULT = '#8A93A5';
// The whole app is authored against a fixed 430x860 reference canvas (matches the
// $preview size above) — fixed-pixel buttons, clip-path shapes and the roster grid all
// assume that canvas. Rather than reflowing each element per device, the canvas is
// scaled uniformly to fit whatever viewport it's actually shown in (see cardScaleTransform
// below), the same way a fixed-resolution game screen fits itself to the window.
const DESIGN_W = 430;
const DESIGN_H = 860;
// Width gate on filling the viewport: at or below this, the card is the whole app and the grey
// field around it carries nothing. Above it (desktop, tablet) the field is the point, so the card
// stays a floating card. 540 sits above every phone's portrait width and below a tablet's. Width is
// only half the gate — see the aspect check in computeLayout, which is what excludes landscape.
const FILL_MAX_W = 540;

// Reads the *layout* viewport (`innerWidth`/`innerHeight`), never `visualViewport`. The visual
// viewport is the part the user is actually looking at, so it shrinks as they pinch-zoom in — and
// feeding that back into the canvas scale made the app shrink its content away from the gesture
// while re-rendering the entire tree on every frame of it, which is what killed the tab. The layout
// viewport is immune to zoom and still tracks what we do care about: rotation and the mobile URL
// bar collapsing. Pinch zoom is refused outright now (see the viewport meta), but these two stay
// independent regardless.
function computeLayout() {
  const vw = window.innerWidth || DESIGN_W;
  const vh = window.innerHeight || DESIGN_H;
  // Fill: match the width exactly and let the card's height run to the viewport's. The card is a
  // flex column, so its `flex: 1` screen area absorbs any height *beyond* the design's 860 — but
  // it can't give any back, because the content inside is fixed-height and clips rather than
  // reflows (the roster grid is `repeat(5, 116px)` in an `overflow-y: hidden` scroller). So fill
  // only when the viewport is at least as tall-aspect as the design; that's every phone still
  // shipping (390x844 -> 931 design px of height), while the short SE-class ones and anything in
  // landscape fall back to the letterboxed card rather than lose two rows of the grid.
  const fillScale = vw / DESIGN_W;
  if (vw <= FILL_MAX_W && vh / fillScale >= DESIGN_H) return { scale: fillScale, fill: true };
  return { scale: Math.min(fillScale, vh / DESIGN_H, 1), fill: false };
}

