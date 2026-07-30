// 角色详情（底部抽屉 / 面板切换 / 表情图层 / 角色剧情 / 语音）：见 ARCHITECTURE.md 的 Character detail bottom sheet 与 Emotion layers 两节 —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。


const PLATFORM_FILES = ['walk_front.gif', 'kachidoki.gif', 'walk_back.gif'];
// The sheet now also hosts the wiki text data inline (scrollable), so it's much taller than the
// old "peek" card — tall enough to show most of a character's info at the expanded snap point,
// with an internal scroll area for whatever doesn't fit (skills/story/voice can run long).
const SHEET_HEIGHT = 620;
const SHEET_EXPANDED_Y = 0;
const SHEET_MID_Y = 390;
const SHEET_COLLAPSED_Y = 560;
// Pixel actions the site has always shipped (rendered by the stage + the Skill/Special
// buttons); anything else in wiki_zh.json's `pixelActions` is an extra the miaowm5 pipeline
// generated and gets its own pill button next to Skill/Special.
const BASE_PIXEL_ACTIONS = ['neutral', 'walk_front', 'walk_back', 'kachidoki', 'skill_ready', 'special'];
const ACTION_LABEL_KEYS = {
  into_coffin: 'actionIntoCoffin',
  ghost_raise: 'actionGhostRaise',
  ghost_neutral: 'actionGhostNeutral',
  revive: 'actionRevive'
};
// Emotion art is authored on a 570x690 canvas (a shared body layer + a per-emotion face
// layer stacked at the same origin), so the on-screen box keeps that exact ratio.
const EMOTION_W = 570;
const EMOTION_H = 690;

// The game composites an expression as a comma-separated layer stack — story_zh.json's
// `emotion` is e.g. "normal,sweat", meaning the `normal` face plus the `sweat` overlay on
// top. Overlay sprites are partial (a blush, a sweat drop, glasses, an earring) and carry no
// features of their own, so they're offered as toggles instead of sitting in the face cycler
// where they'd render as a faceless head.
//
// Classification comes from how the game's own story data uses each name: every token seen in
// a trailing position across all 46k dialogue lines is an overlay, and those all share these
// roots. `tear_b`/`tear_c` match the root rule but the story data only ever uses them as a
// whole face, so they're pinned back to faces — check story usage before adding a root here.
const EMOTION_OVERLAY_ROOTS = [
  'sweat', 'shame', 'tear', 'cheek', 'costume', 'earring', 'megane', 'sunglass',
  'disguise_costume', 'effect'
];
const EMOTION_OVERLAY_RE = new RegExp('^(' + EMOTION_OVERLAY_ROOTS.join('|') + ')(_|$)');
const EMOTION_FACE_NAMES = new Set(['tear_b', 'tear_c']);
function isEmotionOverlay(name) {
  return !EMOTION_FACE_NAMES.has(name) && EMOTION_OVERLAY_RE.test(name);
}
// Overlay names carry per-character variant suffixes (`shame_right`, `sweat_base_0_b`), so
// label them by their root — same idea as ACTION_LABEL_KEYS below.
const EMOTION_OVERLAY_LABEL_KEYS = {
  sweat: 'overlaySweat',
  shame: 'overlayShame',
  cheek: 'overlayCheek',
  tear: 'overlayTear',
  costume: 'overlayCostume',
  disguise_costume: 'overlayDisguise',
  earring: 'overlayEarring',
  megane: 'overlayGlasses',
  sunglass: 'overlaySunglass',
  effect: 'overlayEffect'
};
function emotionOverlayRoot(name) {
  return EMOTION_OVERLAY_ROOTS.find(r => name === r || name.startsWith(r + '_')) || null;
}
// Mirrored art ships the same overlay twice (`shame` on base_0, `shame_right` on base_1), so
// toggles are keyed on the un-mirrored name — flipping to the mirrored face keeps the
// accessory on instead of silently dropping it. Other variants (`effect_rose` vs
// `effect_kirakira`, `shame` vs `shame_joy`) stay distinct keys: they're different art.
function emotionOverlayKey(name) {
  return name.replace(/_right$/, '');
}

// 挂到 Component.prototype 上（见 index.html 里 class 声明之后的 Object.assign）。
const WF_DETAIL = {
  goDetail(c) {
    this.clearAnimTimers();
    // Stops the previous character's voice — but not the Music Room, whose playback (character
    // themes and story-archive BGM alike) rides through detail pages (see audioOwner).
    if (this.audioOwner !== 'room') this.stopMusic();
    this.stopVoice();
    // The hero art's vote pills read the same shared map the Flip deck does, and this screen is
    // reachable without ever opening Flip — so kick the (once-per-session) fetch here too.
    this.loadArtStats();
    const folderUrl = c.thumbUrl.slice(0, c.thumbUrl.lastIndexOf('/'));
    this.setState(s => ({
      tab: 'detail', menuOpen: false,
      // Where Back returns to. A related-character chip navigates detail -> detail, so that case
      // has to keep the original origin rather than answer 'detail'. Everything that isn't the
      // Flip deck goes back to the Units grid, which is what this screen has always done.
      detailReturnTab: s.tab === 'detail' ? s.detailReturnTab : (s.tab === 'flip' ? 'flip' : 'units'),
      selectedChar: { devName: c.devName, enName: c.enName, zhName: c.zhName || '', jpName: c.jpName, rarityUrl: c.rarityUrl, rarityLabel: c.rarityLabel, folderUrl: folderUrl, music: c.music || [], bustOnly: !!c.bustOnly },
      artIndex: 0, hasSpecial: false, overlayOpen: false, overlayGif: null, sheetY: SHEET_MID_Y,
      musicIndex: 0, musicPlaying: false,
      wikiData: null, wikiEnData: null, voiceIndex: 0, voicePlaying: false, sheetPanel: 'profile',
      storyData: null, storyEnData: null, storyLoading: false, storyIndex: null, emotionIndex: 0,
      emotionOverlays: []
    }));
    const probe = new Image();
    probe.onload = () => { if (this.state.selectedChar && this.state.selectedChar.devName === c.devName) this.setState({ hasSpecial: true }); };
    probe.onerror = () => {};
    probe.src = folderUrl + '/special.gif';

    // Preload both base and awakened full shots up front so the awaken toggle is
    // instant instead of popping in a blank/loading image on first switch. bustOnly
    // characters have neither file — their hero art is the story bust in emotion/,
    // which arrives with the wiki_zh.json fetch below.
    if (!c.bustOnly) {
      new Image().src = folderUrl + '/full_shot_1440_1920_0.png';
      new Image().src = folderUrl + '/full_shot_1440_1920_1.png';
    }

    // Wiki text data (基本信息/技能/故事/评价/语音) is a separate, optional per-character
    // file — fetched lazily here rather than folded into roster.json, since most of the
    // 377 roster entries don't have it yet and it can be a few KB of prose per character.
    fetch(folderUrl + '/wiki_zh.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(data => {
        if (this.state.selectedChar && this.state.selectedChar.devName === c.devName) this.setState({ wikiData: data });
      });
    this.loadWikiEn();
  },
  // The English half of the character sheet (scripts/scrape-wiki-gg-units.mjs). Only fetched in
  // English, so a zh-only session never pays for it — which is also why it can't just ride the
  // wiki_zh.json fetch above. Idempotent, and called again from toggleLang() so flipping to
  // English with a sheet already open pulls the file it didn't need a moment ago.
  // 369 of 485 characters have one; the rest (the CN-only bustOnly roster, mainly) 404 and fall
  // back to Chinese, so a null result is cached as a normal outcome rather than retried.
  loadWikiEn() {
    const c = this.state.selectedChar;
    if (!c || this.state.lang !== 'en' || this.state.wikiEnData !== null || this.wikiEnPending === c.devName) return;
    this.wikiEnPending = c.devName;
    fetch(c.folderUrl + '/wiki_en.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      // wiki.gg is primary; the 60 bustOnly characters it can't match fall back to the Eliya-bot
      // GL sidecar (scripts/fetch-eliya-gl.mjs), which carries `source: 'eliya'` and the same
      // info/skill/leaderTalent/abilities shape, so the render path below needs no special case.
      .then(data => data || fetch(c.folderUrl + '/eliya_en.json').then(r => r.ok ? r.json() : null).catch(() => null))
      .then(data => {
        this.wikiEnPending = null;
        // The user may have navigated to another character while this was in flight.
        if (this.state.selectedChar && this.state.selectedChar.devName === c.devName) {
          this.setState({ wikiEnData: data || false }); // false = "checked, nothing there"
        }
      });
  },
  // Back goes wherever you came in from (see detailReturnTab). Routed through go() rather than
  // setting the tab directly, so the leaving-detail cleanup and the per-tab restore work — for
  // 'flip' that's ensureFlipDeck/loadArtStats, both of which no-op on an already-built deck, so
  // you land back on the same card you tapped.
  backFromDetail() {
    this.go(this.state.detailReturnTab === 'flip' ? 'flip' : 'units');
    this.setState({ selectedChar: null });
  },
  // The detail page's theme tracks play through the Music Room engine rather than an old
  // detail-owned play/pause: a character's themes become a room queue, so tapping one starts room
  // playback (surfacing the floating mini-player and keeping it alive across tab/character
  // navigation) and gains seek, prev/next, volume and auto-advance for free. Entries match the
  // shape roomAllCharTracks builds, so the Music Room's own character list stays interchangeable.
  detailCharQueue() {
    const c = this.state.selectedChar;
    if (!c || !c.music || !c.music.length) return [];
    const name = (this.state.lang === 'zh' && c.zhName) ? c.zhName : (c.enName || c.zhName || c.devName);
    return c.music.map((f, i) => ({
      url: c.folderUrl + '/music/' + f,
      label: this.trackLabel(f, i + 1),
      sub: name
    }));
  },
  toggleVoiceTrack(index) {
    const wikiData = this.state.wikiData;
    const selectedChar = this.state.selectedChar;
    if (!wikiData || !selectedChar || !wikiData.voice.length) return;
    const sameTrack = index === this.state.voiceIndex;
    if (sameTrack && this.state.voicePlaying) {
      this.voiceAudio.pause();
      this.setState({ voicePlaying: false });
      return;
    }
    if (!sameTrack) {
      this.voiceAudio.src = selectedChar.folderUrl + '/voice/' + wikiData.voice[index].file;
    }
    this.voiceAudio.play().catch(() => {});
    this.setState({ voiceIndex: index, voicePlaying: true });
  },
  stopVoice() {
    this.voiceAudio.pause();
    this.voiceAudio.currentTime = 0;
    this.voiceAudio.removeAttribute('src');
  },
  toggleArt() { this.setState(s => ({ artIndex: s.artIndex === 0 ? 1 : 0 })); },
  setSheetPanel(panel) {
    // The GIF overlay floats over the whole detail view, not inside the sheet, so it would
    // keep playing on top of the voice/story/related panels — and the buttons that dismiss
    // it only exist in the profile panel, leaving no way to turn it off.
    if (panel !== 'profile') this.clearAnimTimers();
    this.setState({ sheetPanel: panel });
    if (panel === 'story') this.loadStory();
  },
  // story_zh.json is the biggest per-character file by far (full dialogue for every episode),
  // so it's only fetched when the story panel is actually opened, and only once per character.
  loadStory() {
    const selectedChar = this.state.selectedChar;
    if (!selectedChar) return;
    const devName = selectedChar.devName;
    // In English the panel wants story_en.json too. The two are independent files from different
    // sources (miaowm5 vs wiki.gg) with different episode counts, so each gets its own fetch and
    // its own cache slot rather than one replacing the other.
    if (this.state.lang === 'en' && this.state.storyEnData === null && this.storyEnPending !== devName) {
      this.storyEnPending = devName;
      fetch(selectedChar.folderUrl + '/story_en.json')
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
        .then(data => {
          this.storyEnPending = null;
          if (!this.state.selectedChar || this.state.selectedChar.devName !== devName) return;
          this.setState({ storyEnData: data || false }); // false = "checked, nothing there"
        });
    }
    if (this.state.storyData || this.state.storyLoading) return;
    this.setState({ storyLoading: true });
    fetch(selectedChar.folderUrl + '/story_zh.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(data => {
        // The user may have navigated to another character while this was in flight.
        if (!this.state.selectedChar || this.state.selectedChar.devName !== devName) return;
        // Characters with no story have no file at all; cache the empty result so reopening
        // the panel doesn't re-request a known 404 every time.
        this.setState({ storyData: data || { stories: [] }, storyLoading: false });
      });
  },
  // Entering and leaving an episode swaps the sheet body's content while the scroll offset
  // stays put, which would drop you into the middle of the next view — reset it once the
  // swapped content has rendered.
  scrollSheetBodyTop() {
    requestAnimationFrame(() => {
      const el = document.getElementById('sheetBody');
      if (el) el.scrollTop = 0;
    });
  },
  openStory(i) { this.setState({ storyIndex: i }); this.scrollSheetBodyTop(); },
  closeStory() { this.setState({ storyIndex: null }); this.scrollSheetBodyTop(); },
  // The cycler walks faces only; overlays are toggled separately and stack on top.
  emotionFaces() {
    const list = (this.state.wikiData && this.state.wikiData.emotions) || [];
    return list.filter(e => !isEmotionOverlay(e.name));
  },
  emotionStep(delta) {
    const faces = this.emotionFaces();
    if (!faces.length) return;
    this.setState(s => ({ emotionIndex: (s.emotionIndex + delta + faces.length) % faces.length }));
  },
  toggleEmotionOverlay(name) {
    this.setState(s => ({
      emotionOverlays: s.emotionOverlays.includes(name)
        ? s.emotionOverlays.filter(n => n !== name)
        : s.emotionOverlays.concat(name)
    }));
  },
  actionLabel(name) {
    const key = ACTION_LABEL_KEYS[name];
    return key ? this.t(key) : name;
  },
  // Most characters carry one overlay per root, so the root reads best ("Blush"). A few ship
  // several variants of it (`shame_joy`, `shame_lovely`) — there the raw name is the only
  // thing that tells them apart, and the face cycler above already labels itself that way.
  emotionOverlayLabel(name, siblings) {
    const root = emotionOverlayRoot(name);
    const key = EMOTION_OVERLAY_LABEL_KEYS[root];
    if (!key) return name;
    const collides = siblings.filter(n => emotionOverlayRoot(n) === root).length > 1;
    return collides ? name : this.t(key);
  },
  clearAnimTimers() { this.setState({ overlayOpen: false, overlayGif: null }); },
  // Toggles the overlay for any pixel action; showSkill/showSpecial are just the two
  // hard-coded entry points, the extra pipeline-generated actions reuse this directly.
  showAction(name) {
    this.setState(s => s.overlayOpen && s.overlayGif === name
      ? { overlayOpen: false, overlayGif: null }
      : { overlayOpen: true, overlayGif: name });
  },
  showSkill() { this.showAction('skill_ready'); },
  showSpecial() { this.showAction('special'); },
  sheetPointerDown(e) {
    e.preventDefault();
    const startClientY = e.clientY;
    const startSheetY = this.state.sheetY;
    const scale = this.state.scale || 1;
    const onMove = (ev) => {
      const delta = (ev.clientY - startClientY) / scale;
      const ny = Math.max(SHEET_EXPANDED_Y, Math.min(SHEET_COLLAPSED_Y, startSheetY + delta));
      this.setState({ sheetY: ny, sheetDragging: true });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const points = [SHEET_EXPANDED_Y, SHEET_MID_Y, SHEET_COLLAPSED_Y];
      const cur = this.state.sheetY;
      let nearest = points[0], best = Infinity;
      points.forEach(p => { const d = Math.abs(p - cur); if (d < best) { best = d; nearest = p; } });
      this.setState({ sheetY: nearest, sheetDragging: false });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  },

  // renderVals 的本页分段：计算段 + vals 字面量段，逐字搬自 index.html。
  // 只吃 ctx 里的共享量（accent），其余一律走 this —— 见 CLAUDE.md 的文件地图。
  detailVals(ctx) {
    const { accent } = ctx;
    const selectedChar = this.state.selectedChar;
    const sheetY = this.state.sheetY;

    // This character's row in the community sheet (English name/epithet/jpName and a playthrough
    // of their episode). English only, and null until units_en.json lands.
    const charEn = (this.state.lang === 'en' && this.unitsEn && selectedChar)
      ? (this.unitsEn[selectedChar.devName] || null)
      : null;
    const charVideoRows = ((charEn && charEn.videos) || []).map(v => ({
      label: v.by ? this.t('videoBy').replace('{by}', v.by) : this.t('videoWatch'),
      raw: !!v.raw,
      onClick: () => window.open(v.url, '_blank', 'noopener')
    }));

    const wikiData = this.state.wikiData;
    // The English half (scripts/scrape-wiki-gg-units.mjs). `false` means "fetched, doesn't exist",
    // so both that and the un-fetched null collapse to "no English" here. Every binding below
    // reads through `en(...)`, which falls back to Chinese field by field rather than all-or-
    // nothing — a character can have an English profile but no English stories, and often does.
    const wikiEn = (this.state.lang === 'en' && this.state.wikiEnData) || null;
    const en = (enValue, zhValue) => (enValue == null || enValue === '' ? zhValue : enValue);
    const WIKI_FIELD_LABELS = {
      nickname: this.t('wikiFieldNickname'),
      type: this.t('wikiFieldType'),
      role: this.t('wikiFieldRole'),
      gender: this.t('wikiFieldGender'),
      race: this.t('wikiFieldRace'),
      cv: this.t('wikiFieldCv'),
      acquisition: this.t('wikiFieldAcquisition')
    };
    // wiki.gg names the same fields differently and has no nickname/type at all, so the English
    // values are mapped onto the existing rows rather than given rows of their own.
    const enInfo = (wikiEn && wikiEn.info) || null;
    const EN_FIELD_MAP = enInfo
      ? { role: enInfo.class, gender: enInfo.gender, race: enInfo.race, cv: enInfo.va, acquisition: enInfo.obtain }
      : {};
    const wikiInfoRows = (wikiData || enInfo)
      ? Object.keys(WIKI_FIELD_LABELS)
        .map(key => ({
          label: WIKI_FIELD_LABELS[key],
          value: en(EN_FIELD_MAP[key], wikiData ? wikiData.basicInfo[key] : '')
        }))
        .filter(row => row.value)
      : [];
    // In English the {{Unit}} template's skill / leader talent / passive abilities stand in for
    // the Chinese skill tables, laid out as the same caption+entries groups the template expects.
    const enSkillGroups = wikiEn
      ? [
        wikiEn.skill && wikiEn.skill.detail
          ? { caption: this.t('wikiEnSkill'), entries: [{ name: wikiEn.skill.name || '', text: wikiEn.skill.detail }] }
          : null,
        wikiEn.leaderTalent && wikiEn.leaderTalent.detail
          ? { caption: this.t('wikiEnLeaderTalent'), entries: [{ name: wikiEn.leaderTalent.name || '', text: wikiEn.leaderTalent.detail }] }
          : null,
        (wikiEn.abilities || []).length
          ? { caption: this.t('wikiEnAbilities'), entries: wikiEn.abilities.map((a, i) => ({ name: String(i + 1), text: a })) }
          : null
      ].filter(Boolean)
      : [];
    const wikiSkillGroups = enSkillGroups.length
      ? enSkillGroups
      : (wikiData
        ? wikiData.skills.map(g => ({ caption: g.caption, entries: g.entries.map(e => ({ name: e.name, text: e.text })) }))
        : []);
    const voiceTracks = (wikiData && selectedChar)
      ? wikiData.voice.map((line, i) => {
        const playing = this.state.voicePlaying && this.state.voiceIndex === i;
        return {
          context: line.context,
          text: line.text,
          textJp: line.textJp || '',
          hasTextJp: !!line.textJp,
          playing: playing,
          icon: playing ? '⏸' : '▶',
          onClick: () => this.toggleVoiceTrack(i)
        };
      })
      : [];

    // wiki.gg's English quote lines. Text only — no audio ships with them — so they render as a
    // separate group under the playable mp3 rows rather than relabelling them.
    const voiceQuotes = (wikiEn && wikiEn.quotes) ? wikiEn.quotes.map(q => ({ type: q.type || '', text: q.text })) : [];

    // Extra pixel actions the miaowm5 pipeline generated (into_coffin/ghost_raise/...), shown
    // as pills beside Skill/Special. `pixelActions` lists what the folder actually holds, so
    // this never advertises a GIF that isn't there.
    const extraActionButtons = (wikiData && wikiData.pixelActions && selectedChar)
      ? wikiData.pixelActions
        .filter(name => BASE_PIXEL_ACTIONS.indexOf(name) === -1)
        .map(name => {
          const active = this.state.overlayOpen && this.state.overlayGif === name;
          return {
            label: this.actionLabel(name),
            bg: active ? accent : '#F0F3F7',
            color: active ? '#FFFFFF' : '#3E4450',
            onClick: () => this.showAction(name)
          };
        })
      : [];

    const emotions = (wikiData && wikiData.emotions) || [];
    const emotionDir = selectedChar ? selectedChar.folderUrl + '/emotion/' : '';
    const emotionFaces = emotions.filter(e => !isEmotionOverlay(e.name));
    const emotionIndex = emotionFaces.length ? Math.min(this.state.emotionIndex, emotionFaces.length - 1) : 0;
    const emotion = emotionFaces[emotionIndex] || null;
    // An overlay is drawn onto the same body layer as the face it decorates, so a character
    // with mirrored art (base_0 / base_1) ships both a `shame` and a `shame_right`. Offering
    // only the overlays sharing the current face's body keeps the two sets from crossing over.
    const availableOverlays = emotions.filter(e =>
      isEmotionOverlay(e.name) && e.front && (!emotion || e.base === emotion.base));
    const overlayNames = availableOverlays.map(e => e.name);
    const emotionOverlayChips = availableOverlays.map(e => {
      const on = this.state.emotionOverlays.includes(emotionOverlayKey(e.name));
      return {
        label: this.emotionOverlayLabel(e.name, overlayNames),
        bg: on ? accent : '#F0F3F7',
        color: on ? '#FFFFFF' : '#3E4450',
        onClick: () => this.toggleEmotionOverlay(emotionOverlayKey(e.name))
      };
    });
    // Gated on the base further down for the same reason the face is (see hasEmotionFront).
    const emotionOverlayLayers = availableOverlays
      .filter(e => this.state.emotionOverlays.includes(emotionOverlayKey(e.name)))
      .map(e => ({ url: emotionDir + e.front, name: e.name }));

    // Characters that came from miaowm5 alone have no full_shot_1440_1920_* art — that source
    // only ever had the 570x690 story bust, which is what its own site shows too. So the detail
    // hero re-uses the expression viewer's stacked body+face layers, and the awaken toggle (a
    // full-shot-only affordance) is hidden. The bust rides along with wikiData, so the hero
    // simply appears once that fetch lands, rather than needing its own probe.
    const bustOnly = !!(selectedChar && selectedChar.bustOnly);
    const heroFace = bustOnly
      ? (emotionFaces.find(e => e.name === 'normal') || emotionFaces[0] || null)
      : null;

    // The hero's Flip vote counts, read out of the same shared map the deck uses. The key tracks
    // the awaken toggle, because base and awakened are separate artworks with separate votes.
    // A dash until art_stats_all resolves, matching the top bar's pv/uv convention.
    const detailArtKey = selectedChar
      ? selectedChar.devName + ':' + (bustOnly ? 'bust' : this.state.artIndex)
      : '';
    const detailArtStat = (detailArtKey && this.state.flipStats) ? this.state.flipStats[detailArtKey] : null;
    const detailArtNum = k => (this.state.flipStats && selectedChar)
      ? String(detailArtStat ? detailArtStat[k] : 0)
      : '—';

    // The encyclopedia's profile blocks, minus anything the bilibili wiki already says (the
    // pipeline de-dupes those), shown under the character-story intro.
    const wikiInfoBlocks = (wikiData && wikiData.info) || [];

    const related = (wikiData && wikiData.related) || null;
    const relatedChars = (related && related.characters ? related.characters : []).map(rc => {
      const target = rc.devName ? this.rosterByDev.get(rc.devName) : null;
      return {
        name: (this.state.lang === 'zh' || !target) ? rc.zhName : (target.enName || rc.zhName),
        thumbUrl: target ? (target.headUrl || target.thumbUrl) : '',
        hasThumb: !!target,
        // Related entries can point at NPCs and at variants that aren't in our roster, so
        // they have no art to show — keep the tile so the grid stays aligned.
        noThumb: !target,
        opacity: target ? 1 : 0.55,
        cursor: target ? 'pointer' : 'default',
        onClick: () => { if (target) this.goDetail(target); }
      };
    });
    const relatedKeywords = (related && related.keywords ? related.keywords : []).map(k => ({
      title: k.title,
      desc: k.desc || ''
    }));

    const storyData = this.state.storyData;
    // In English the panel is driven by story_en.json instead (wiki.gg's own episode scripts).
    // It's a different source from story_zh.json with its own episode list, so it replaces the
    // list wholesale rather than merging — an episode index means different things in each.
    const storyEn = (this.state.lang === 'en' && this.state.storyEnData) || null;
    const storyEnEpisodes = (storyEn && storyEn.episodes) || [];
    const useStoryEn = storyEnEpisodes.length > 0;
    const stories = useStoryEn
      ? storyEnEpisodes.map(ep => ({ title: ep.name || '', desc: ep.summary || '' }))
      : ((storyData && storyData.stories) || []);
    const storyIndex = this.state.storyIndex;
    const openedStory = (storyIndex !== null && stories[storyIndex]) ? stories[storyIndex] : null;
    const storyList = stories.map((st, i) => ({
      title: st.title,
      desc: st.desc,
      onClick: () => this.openStory(i)
    }));
    // Only the viewed character's own emotion art is available locally, and only for
    // expressions the pipeline actually exported. Everyone else falls back to the framed
    // portrait, and a speaker with neither gets a plain name plate.
    const emotionByName = new Map(emotions.map(e => [e.name, e]));
    // A dialogue line's emotion is a layer stack ("normal,sweat"), so resolve every token and
    // draw the fronts in order over the body layer. Looking the raw string up as a single name
    // would miss the 7% of lines that carry an overlay.
    const resolveEmotionStack = (value) => {
      const parts = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
      const entries = parts.map(p => emotionByName.get(p)).filter(Boolean);
      if (!entries.length) return null;
      const withBase = entries.find(e => e.base);
      return {
        base: withBase ? withBase.base : null,
        fronts: entries.filter(e => e.front).map(e => ({ url: emotionDir + e.front }))
      };
    };
    // wiki.gg's scripts are plain speaker+line pairs: no speakerDev, so no portrait to look up and
    // no emotion art to stack. Those speakers get the plain name plate the Chinese reader already
    // falls back to for anyone without a sprite — the honest degradation, not a missing feature.
    const storyEnDialogs = (useStoryEn && storyIndex !== null && storyEnEpisodes[storyIndex])
      ? (storyEnEpisodes[storyIndex].lines || []).map(l => ({
        speaker: l.speaker || '',
        color: DIALOG_PLATE_DEFAULT,
        text: l.text,
        hasAvatar: false,
        emotionBaseUrl: '',
        hasEmotionBase: false,
        emotionFronts: [],
        hasHeadArt: false,
        headUrl: ''
      }))
      : [];
    const storyDialogs = useStoryEn ? storyEnDialogs : (openedStory ? openedStory.dialogs.map(d => {
      const art = (selectedChar && d.speakerDev === selectedChar.devName && d.emotion)
        ? resolveEmotionStack(d.emotion)
        : null;
      // Everyone but the viewed character falls back to a portrait (see headUrlForSpeaker).
      const headUrl = art ? '' : this.headUrlForSpeaker(d.speakerDev);
      return {
        speaker: d.speaker,
        color: d.color,
        text: d.text,
        hasAvatar: !!art || !!headUrl,
        emotionBaseUrl: art && art.base ? emotionDir + art.base : '',
        hasEmotionBase: !!(art && art.base),
        emotionFronts: art ? art.fronts : [],
        hasHeadArt: !!headUrl,
        headUrl
      };
    }) : []);
    // The sheet's three big images go through heroSrc (not artSrc — see the loader's own comment),
    // so each opens on the shared loading placeholder instead of an empty box. Only the *base*
    // layers are gated: the faces and overlays stacked on top average 22 KB against a base's
    // 337 KB and they swap on every ‹ › tap, so gating those would flash a spinner on every press
    // over art that is already on screen.
    const fullShotSrc = selectedChar
      ? this.heroSrc(selectedChar.folderUrl + '/full_shot_1440_1920_' + this.state.artIndex + '.png')
      : '';
    const bustBaseSrc = heroFace && heroFace.base ? this.heroSrc(emotionDir + heroFace.base) : '';
    const emotionBaseSrc = emotion && emotion.base ? this.heroSrc(emotionDir + emotion.base) : '';
    return {
      detailEnName: selectedChar ? ((this.state.lang === 'zh' && selectedChar.zhName) ? selectedChar.zhName : selectedChar.enName) : '',
      // The 108 miaowm5-only characters have no jpName in the roster; the community sheet does,
      // and a Japanese name reads the same in either UI language, so it fills in unconditionally.
      detailJpName: selectedChar ? (selectedChar.jpName || (charEn && charEn.jpName) || '') : '',
      detailEnTitle: (charEn && charEn.title) || '',
      detailHasEnTitle: !!(charEn && charEn.title),
      charHasVideos: charVideoRows.length > 0,
      charVideoRows: charVideoRows,
      detailRarityUrl: selectedChar ? selectedChar.rarityUrl : '',
      detailRarityLabel: selectedChar ? selectedChar.rarityLabel : '',
      fullShotUrl: fullShotSrc,
      showFullShot: !bustOnly && !!fullShotSrc,
      showFullShotLoading: !bustOnly && !!selectedChar && !fullShotSrc,
      showArtToggle: !bustOnly,
      showBustHero: !!heroFace,
      hasBustBase: !!bustBaseSrc,
      bustBaseUrl: bustBaseSrc,
      showBustBaseLoading: !!(heroFace && heroFace.base) && !bustBaseSrc,
      // The face rides on the body: 22 KB against 337 KB, so it lands first and would otherwise
      // hang in mid-air over the placeholder. It waits for its base.
      hasBustFront: !!(heroFace && heroFace.front) && !!bustBaseSrc,
      bustFrontUrl: heroFace && heroFace.front ? emotionDir + heroFace.front : '',
      // Flip vote counts for whichever illustration the hero is showing (see detailArtStat above).
      detailShowArtCounts: !!selectedChar,
      // Clear of the awaken toggle + its label; bustOnly has neither, so the stack takes their y.
      detailArtCountsTop: bustOnly ? 14 : 82,
      detailArtLikeCount: detailArtNum('likes'),
      detailArtDislikeCount: detailArtNum('dislikes'),
      detailArtSkipCount: detailArtNum('skips'),
      detailArtLikeTitle: this.t('flipLike'),
      detailArtDislikeTitle: this.t('flipDislike'),
      detailArtSkipTitle: this.t('flipSkip'),
      platformUrl0: selectedChar ? (selectedChar.folderUrl + '/' + PLATFORM_FILES[0]) : '',
      platformUrl1: selectedChar ? (selectedChar.folderUrl + '/' + PLATFORM_FILES[1]) : '',
      platformUrl2: selectedChar ? (selectedChar.folderUrl + '/' + PLATFORM_FILES[2]) : '',
      hasSpecial: this.state.hasSpecial,
      hasMusic: !!(selectedChar && selectedChar.music.length),
      musicTracks: (() => {
        // Play through the room engine: the pills reflect room playback state and share the queue
        // with the floating mini-player, so the theme keeps going as you leave the page.
        const q = this.detailCharQueue();
        return q.map((tr, i) => {
          const playing = this.roomIsPlaying(tr.url);
          return {
            label: (playing ? '⏸ ' : '▶ ') + tr.label,
            bg: playing ? accent : '#F0F3F7',
            color: playing ? '#FFFFFF' : '#3E4450',
            onClick: () => this.roomToggleTrack(q, i)
          };
        });
      })(),
      wikiSource: this.t('wikiSource'),
      hasWikiData: !!(wikiData && (wikiData.skills.length || wikiData.story.stories.length || wikiData.review || wikiData.voice.length || Object.keys(wikiData.basicInfo).length || wikiInfoBlocks.length || emotions.length)),
      wikiSectionInfoLabel: this.t('wikiSectionInfo'),
      wikiSectionSkillsLabel: this.t('wikiSectionSkills'),
      wikiSectionStoryLabel: this.t('wikiSectionStory'),
      wikiSectionReviewLabel: this.t('wikiSectionReview'),
      wikiSectionVoiceLabel: this.t('wikiSectionVoice'),
      wikiSectionQuotesLabel: this.t('wikiSectionQuotes'),
      wikiSourceGgText: this.t('wikiSourceGg'),
      // The character sheet's English attribution: wiki.gg for the matched majority, Eliya-bot for
      // the bustOnly fallback (its record carries `source: 'eliya'`). The Story tab's own credit
      // lines below stay wiki.gg — that source has no Eliya equivalent.
      wikiEnSourceText: (wikiEn && wikiEn.source === 'eliya') ? this.t('wikiSourceEliya') : this.t('wikiSourceGg'),
      // Attribution for the wiki.gg text, shown only when some is actually on screen.
      showWikiSourceGg: !!wikiEn || useStoryEn,
      wikiInfoRows: wikiInfoRows,
      hasWikiInfoRows: wikiInfoRows.length > 0,
      wikiSkillGroups: wikiSkillGroups,
      hasWikiSkills: wikiSkillGroups.length > 0,
      // In English the profile blurb stands in for the bilibili story intro, and the wiki.gg
      // episode names + summaries for its story list. Falls through field by field: a character
      // with an English profile but no English stories keeps the Chinese ones.
      wikiStoryIntro: en(enInfo && enInfo.description, wikiData && wikiData.story ? wikiData.story.intro : ''),
      wikiStories: (wikiEn && (wikiEn.stories || []).length)
        ? wikiEn.stories.map(s => ({ title: s.name || '', text: s.summary || '' }))
        : (wikiData && wikiData.story ? wikiData.story.stories : []),
      // Also gates the encyclopedia info blocks, which render in this section — a character
      // with no bilibili wiki story can still have them.
      hasWikiStory: !!(
        (wikiEn && ((enInfo && enInfo.description) || (wikiEn.stories || []).length)) ||
        (wikiData && ((wikiData.story && (wikiData.story.intro || wikiData.story.stories.length)) || wikiInfoBlocks.length))
      ),
      wikiReview: wikiData ? wikiData.review : '',
      hasWikiReview: !!(wikiData && wikiData.review),
      voiceTracks: voiceTracks,
      hasVoiceTracks: voiceTracks.length > 0,
      voiceQuotes: voiceQuotes,
      hasVoiceQuotes: voiceQuotes.length > 0,
      // The empty state is only really empty when neither list has anything.
      hasNoVoiceTracks: voiceTracks.length === 0 && voiceQuotes.length === 0,
      wikiNoVoiceText: this.t('wikiNoVoice'),
      showProfilePanel: this.state.sheetPanel === 'profile',
      showVoicePanel: this.state.sheetPanel === 'voice',
      showStoryPanel: this.state.sheetPanel === 'story',
      showRelatedPanel: this.state.sheetPanel === 'related',
      profilePanelBtnBg: this.state.sheetPanel === 'profile' ? accent : '#F0F3F7',
      voicePanelBtnBg: this.state.sheetPanel === 'voice' ? accent : '#F0F3F7',
      storyPanelBtnBg: this.state.sheetPanel === 'story' ? accent : '#F0F3F7',
      relatedPanelBtnBg: this.state.sheetPanel === 'related' ? accent : '#F0F3F7',
      profilePanelIconOpacity: 1,
      voicePanelIconOpacity: 1,
      storyPanelIconOpacity: 1,
      relatedPanelIconOpacity: 1,
      panelProfileLabel: this.t('panelProfile'),
      panelVoiceLabel: this.t('panelVoice'),
      panelStoryLabel: this.t('panelStory'),
      panelRelatedLabel: this.t('panelRelated'),
      showProfilePanelBtn: () => this.setSheetPanel('profile'),
      showVoicePanelBtn: () => this.setSheetPanel('voice'),
      showStoryPanelBtn: () => this.setSheetPanel('story'),
      showRelatedPanelBtn: () => this.setSheetPanel('related'),
      extraActionButtons: extraActionButtons,
      hasEmotions: emotionFaces.length > 0,
      emotionBaseUrl: emotionBaseSrc,
      hasEmotionBase: !!emotionBaseSrc,
      showEmotionBaseLoading: !!(emotion && emotion.base) && !emotionBaseSrc,
      emotionFrontUrl: emotion && emotion.front ? emotionDir + emotion.front : '',
      // Same as the bust hero: the face waits for the body it sits on, or it floats alone over the
      // placeholder for as long as the base takes.
      hasEmotionFront: !!(emotion && emotion.front) && !!emotionBaseSrc,
      emotionName: emotion ? emotion.name : '',
      emotionCounter: emotionFaces.length ? (emotionIndex + 1) + ' / ' + emotionFaces.length : '',
      emotionRatioPadding: (EMOTION_H / EMOTION_W * 100) + '%',
      emotionsTitleLabel: this.t('emotionsTitle'),
      emotionPrev: () => this.emotionStep(-1),
      emotionNext: () => this.emotionStep(1),
      emotionOverlayChips: emotionOverlayChips,
      hasEmotionOverlays: emotionOverlayChips.length > 0,
      emotionOverlayLayers: emotionBaseSrc ? emotionOverlayLayers : [],
      emotionOverlaysTitleLabel: this.t('emotionOverlaysTitle'),
      wikiInfoBlocks: wikiInfoBlocks,
      hasWikiInfoBlocks: wikiInfoBlocks.length > 0,
      miaowm5SourceLabel: this.t('miaowm5Source'),
      hasMiaowm5Data: !!(wikiData && (wikiData.info || wikiData.emotions || wikiData.related || wikiData.storyCount)),
      storyListTitleLabel: this.t('storyListTitle'),
      storyLoadingText: this.t('storyLoading'),
      storyLoadingWave: this.loadingWave('storyLoading'),
      // One string shared by the sheet's three big-art placeholders (full shot, bust hero,
      // expression viewer) — only one of them is ever on screen at a time.
      detailArtLoadingText: this.t('detailArtLoading'),
      detailArtLoadingWave: this.loadingWave('detailArtLoading'),
      storyEmptyText: this.t('storyEmpty'),
      storyBackLabel: this.t('storyBack'),
      storyBackToListLabel: this.t('storyBackToList'),
      storyLoading: this.state.storyLoading,
      // A character with no episodes can still have a community playthrough, so the list view owns
      // the panel whenever there's either — otherwise the video would be stranded behind the
      // "no stories" placeholder.
      showStoryList: !this.state.storyLoading && storyIndex === null && (stories.length > 0 || charVideoRows.length > 0),
      hasStoryEpisodes: stories.length > 0,
      showStoryDetail: !this.state.storyLoading && !!openedStory,
      showStoryEmpty: !this.state.storyLoading && stories.length === 0 && charVideoRows.length === 0,
      storyList: storyList,
      storyDialogs: storyDialogs,
      storyDetailTitle: openedStory ? openedStory.title : '',
      storyBackBtn: () => this.closeStory(),
      relatedCharsTitleLabel: this.t('relatedCharsTitle'),
      relatedKeywordsTitleLabel: this.t('relatedKeywordsTitle'),
      relatedEmptyText: this.t('relatedEmpty'),
      relatedChars: relatedChars,
      hasRelatedChars: relatedChars.length > 0,
      relatedKeywords: relatedKeywords,
      hasRelatedKeywords: relatedKeywords.length > 0,
      hasNoRelated: relatedChars.length === 0 && relatedKeywords.length === 0,
      overlayOpen: this.state.overlayOpen,
      overlayUrl: (selectedChar && this.state.overlayGif) ? (selectedChar.folderUrl + '/' + this.state.overlayGif + '.gif') : '',
      overlayLabel: this.state.overlayGif === 'special'
        ? this.t('overlaySpecial')
        : this.state.overlayGif === 'skill_ready'
          ? this.t('overlaySkill')
          : this.actionLabel(this.state.overlayGif || ''),
      artToggleLabel: this.state.artIndex === 0 ? this.t('artBase') : this.t('artAwakened'),
      sheetHeight: SHEET_HEIGHT,
      sheetTransform: 'translateY(' + sheetY + 'px)',
      sheetTransition: this.state.sheetDragging ? 'none' : 'transform 0.25s ease',
      skillBtnBg: (this.state.overlayOpen && this.state.overlayGif === 'skill_ready') ? accent : '#F0F3F7',
      skillBtnColor: (this.state.overlayOpen && this.state.overlayGif === 'skill_ready') ? '#FFFFFF' : '#3E4450',
      specialBtnBg: (this.state.overlayOpen && this.state.overlayGif === 'special') ? accent : '#F0F3F7',
      specialBtnColor: (this.state.overlayOpen && this.state.overlayGif === 'special') ? '#FFFFFF' : '#3E4450',
      toggleArt: () => this.toggleArt(),
      showSkill: () => this.showSkill(),
      showSpecial: () => this.showSpecial(),
      backFromDetail: () => this.backFromDetail(),
      sheetPointerDown: (e) => this.sheetPointerDown(e),
    };
  },};
