// 音乐室（room*）：播放引擎 + 悬浮迷你播放器，见 CLAUDE.md 的 Music Room 一节 —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。

// Music playback volume (0..1), persisted client-side like the language. Applied to the single
// shared this.audio, so it carries across character-theme / story-BGM / Music-Room playback.
const VOLUME_STORAGE_KEY = 'wf_volume';
// The Music Room's two libraries: character theme tracks (the roster's `music` arrays) and the
// world/event BGM albums (story/music_index.json, one album per story). The room can't use the
// global `accent` (that's the Units orange), so its section colour doubles as its accent.
const MUSIC_ACCENT = '#A66FE0';
const ROOM_SECTIONS = [
  { id: 'char', labelKey: 'roomSectionChar' },
  { id: 'world', labelKey: 'roomSectionWorld' }
];
// Now-playing modes, cycled by the bar's mode button. Order matters — cycleRoomMode steps through
// this list. `order` plays through and stops; `shuffle` picks a random next; `repeat` loops one.
const ROOM_MODES = ['order', 'shuffle', 'repeat'];
const ROOM_MODE_LABEL = { order: 'roomModeOrder', shuffle: 'roomModeShuffle', repeat: 'roomModeRepeat' };
const ROOM_MODE_GLYPH = { order: '→', shuffle: '⇄', repeat: '↻' };

// 挂到 Component.prototype 上（见 index.html 里 class 声明之后的 Object.assign）。
const WF_MUSIC = {
  loadVolume() {
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_STORAGE_KEY));
      if (isFinite(v) && v >= 0 && v <= 1) return v;
    } catch (e) {}
    return 1;
  },
  nudgeRoomPaint(id) {
    const el = document.getElementById(id);
    const flag = '_painted_' + id;
    if (!el) { this[flag] = false; return; }   // gone → re-arm for its next appearance
    if (this[flag]) return;                     // already nudged since it appeared
    this[flag] = true;
    requestAnimationFrame(() => {
      const e = document.getElementById(id);
      if (!e) { this[flag] = false; return; }
      // Detach from the render tree and force a synchronous reflow, then reattach: WebKit rebuilds
      // and re-rasters the subtree, so the freshly-inserted layer actually paints. Same frame, so
      // the browser never paints the removed state — no flicker. Restore the prior display value
      // (not ''), since these carry an inline `display` (flex) we'd otherwise clear.
      const prev = e.style.display;
      e.style.display = 'none';
      void e.offsetHeight;
      e.style.display = prev;
    });
  },
  trackLabel(fileName, trackNumber) {
    // Suffixes like "_hw23"/"_smr21" are internal event codes, not meaningful to
    // players, so tracks are just numbered — except "arrange", which is worth calling out.
    if (/arrange/i.test(fileName)) return this.t('trackArrange');
    return trackNumber === 1 ? this.t('trackTheme') : this.t('trackTheme') + ' ' + trackNumber;
  },
  stopMusic() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.removeAttribute('src');
    this.audioOwner = null;
  },
  loadRoomAlbums() {
    if (this.state.roomAlbums || this.state.roomAlbumsLoading) return;
    this.setState({ roomAlbumsLoading: true, roomAlbumsError: null });
    fetch(ASSET_BASE + '/story/music_index.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(data => this.setState({ roomAlbums: (data && data.albums) || [], roomAlbumsLoading: false }))
      .catch(err => {
        console.error('[music] failed to load story/music_index.json', err);
        this.setState({ roomAlbumsLoading: false, roomAlbumsError: String(err && err.message || err) });
      });
  },
  setRoomSection(id) { this.setState({ roomSection: id }); this.scrollRoomTop(); },
  setRoomSearch(e) {
    const roomSearch = e.target.value;
    this.setState({ roomSearch });
    this.scrollRoomTop();
  },
  openRoomAlbum(album) { this.setState({ roomOpenAlbum: album }); this.scrollRoomTop(); },
  closeRoomAlbum() { this.setState({ roomOpenAlbum: null }); this.scrollRoomTop(); },
  // Same content-swap reset as scrollArcTop; the library and the album view take turns owning the
  // #music-scroll id (they never coexist), exactly like the story tab's two #story-scroll views.
  scrollRoomTop() {
    requestAnimationFrame(() => {
      const el = document.getElementById('music-scroll');
      if (el) el.scrollTop = 0;
    });
  },
  // BGM filenames are the only name the data has (`light_field_normal` — see build-music-index);
  // language-neutral prettifying, so no STRINGS involvement.
  roomTrackTitle(name) {
    return name.split('_').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  },
  roomAlbumQueue(album) {
    return album.tracks.map(t => ({
      url: ASSET_BASE + '/' + t.file,
      label: this.roomTrackTitle(t.name),
      sub: album.title
    }));
  },
  roomFmtTime(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); },

  // 某个 url 是不是「正在播放的那一条」。原本是 renderVals 里的一个局部闭包，但音乐室、剧情档案的
  // BGM 行、角色详情的主题曲药丸三处都要读它，而这三处现在分属三个文件 —— 所以提升成方法（和
  // arcTitleFor 当初从闭包提升成方法是同一个理由）。当前曲目完全由 this.state 推出，所以提升是
  // 逐字等价的，没有任何行为变化。
  roomIsPlaying(url) {
    const cur = this.state.roomQueue[this.state.roomQueuePos] || null;
    return this.state.roomPlaying && !!cur && cur.url === url;
  },
  roomPlay(queue, pos) {
    const tr = queue[pos];
    if (!tr) return;
    // Owner before src: setting src fires durationchange for the new track, and the listener
    // drops it unless the room already owns the audio.
    this.audioOwner = 'room';
    this.audio.src = tr.url;
    this.audio.play().catch(() => {});
    this.setState({
      roomQueue: queue, roomQueuePos: pos, roomPlaying: true, roomPos: 0, roomDur: 0,
      musicPlaying: false
    });
  },
  // Drag the floating mini-player. Follows the sheetPointerDown convention — window-level pointer
  // listeners so the drag survives the pointer leaving the element, deltas divided by state.scale
  // (the whole canvas is CSS-scaled), touch-action:none on the widget. A press that never moves is
  // a tap → open the Music Room; dropping it against either side edge collapses it to an arrow tab.
  roomMiniDown(e) {
    e.preventDefault();
    const el = document.getElementById('room-mini');
    const parent = el && el.offsetParent;
    if (!el || !parent) return;
    const scale = this.state.scale || 1;
    const maxX = Math.max(0, parent.clientWidth - el.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - el.offsetHeight);
    const start = this.state.roomMiniPos || { x: maxX - 10, y: maxY - 10 };
    const sx = e.clientX, sy = e.clientY;
    let curX = start.x, curY = start.y, moved = false, raf = 0;
    const onMove = (ev) => {
      curX = Math.max(0, Math.min(maxX, start.x + (ev.clientX - sx) / scale));
      curY = Math.max(0, Math.min(maxY, start.y + (ev.clientY - sy) / scale));
      if (!moved && Math.abs(curX - start.x) + Math.abs(curY - start.y) > 4) moved = true;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.setState({ roomMiniPos: { x: curX, y: curY }, roomMiniDragging: true });
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!moved) { this.setState({ roomMiniDragging: false }); this.go('music'); return; }
      const EDGE = 20;
      if (curX <= EDGE) this.setState({ roomMiniCollapsed: true, roomMiniSide: 'left', roomMiniPos: { x: 0, y: curY }, roomMiniDragging: false });
      else if (curX >= maxX - EDGE) this.setState({ roomMiniCollapsed: true, roomMiniSide: 'right', roomMiniPos: { x: maxX, y: curY }, roomMiniDragging: false });
      else this.setState({ roomMiniPos: { x: curX, y: curY }, roomMiniDragging: false });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  },
  expandRoomMini(e) {
    if (e) e.stopPropagation();
    this.setState({ roomMiniCollapsed: false });
  },
  // Cycle order → shuffle → repeat. Only the auto-advance rule changes; the current track keeps
  // playing.
  cycleRoomMode() {
    const i = ROOM_MODES.indexOf(this.state.roomMode);
    this.setState({ roomMode: ROOM_MODES[(i + 1) % ROOM_MODES.length] });
  },
  // A random queue position other than the one playing (unless the queue has a single track).
  roomRandomPos() {
    const n = this.state.roomQueue.length;
    if (n <= 1) return this.state.roomQueuePos;
    let p;
    do { p = Math.floor(Math.random() * n); } while (p === this.state.roomQueuePos);
    return p;
  },
  // Build a queue from a whole library and start it: 'char' = every roster character's theme
  // tracks, 'world' = every album's tracks, 'all' = both. World/all need the album index loaded
  // (only fetched once the world section is opened), so kick that off and bail if it isn't ready.
  playRoomLibrary(kind) {
    const q = [];
    if (kind === 'char' || kind === 'all') q.push(...this.roomAllCharTracks());
    if (kind === 'world' || kind === 'all') {
      if (!this.state.roomAlbums) { this.loadRoomAlbums(); if (kind === 'world') return; }
      else q.push(...this.roomAllWorldTracks());
    }
    if (!q.length) return;
    this.roomPlay(q, this.state.roomMode === 'shuffle' ? Math.floor(Math.random() * q.length) : 0);
  },
  roomAllCharTracks() {
    const out = [];
    for (const c of this.state.roster) {
      if (!c.music.length) continue;
      const name = (this.state.lang === 'zh' && c.zhName) ? c.zhName : c.enName;
      const folderUrl = c.thumbUrl.slice(0, c.thumbUrl.lastIndexOf('/'));
      c.music.forEach((f, i) => out.push({
        url: folderUrl + '/music/' + f, label: this.trackLabel(f, i + 1), sub: name
      }));
    }
    return out;
  },
  roomAllWorldTracks() {
    const out = [];
    for (const a of (this.state.roomAlbums || [])) out.push(...this.roomAlbumQueue(a));
    return out;
  },
  roomToggleTrack(queue, pos) {
    const tr = queue[pos];
    if (!tr) return;
    const current = this.state.roomQueue[this.state.roomQueuePos];
    if (this.audioOwner === 'room' && current && current.url === tr.url) {
      if (this.state.roomPlaying) {
        this.audio.pause();
        this.setState({ roomPlaying: false });
        return;
      }
      // Resuming adopts the tapped row's queue — same track, but auto-advance should continue
      // through the list the user is looking at now.
      this.audio.play().catch(() => {});
      this.setState({ roomQueue: queue, roomQueuePos: pos, roomPlaying: true });
      return;
    }
    this.roomPlay(queue, pos);
  },
  // The now-playing bar's button. If another feature took the audio since (or a reload left the
  // element empty), re-claim by replaying the current queue entry from the top — simplest rule,
  // and losing the paused position to a theme-pill detour is a fair trade.
  roomTogglePlay() {
    const current = this.state.roomQueue[this.state.roomQueuePos];
    if (!current) return;
    if (this.audioOwner !== 'room') { this.roomPlay(this.state.roomQueue, this.state.roomQueuePos); return; }
    if (this.state.roomPlaying) {
      this.audio.pause();
      this.setState({ roomPlaying: false });
      return;
    }
    this.audio.play().catch(() => {});
    this.setState({ roomPlaying: true });
  },
  // The bar's prev/next buttons. Manual, so they always move (unlike auto-advance, which can stop):
  // a forward step in shuffle mode jumps to a random track, otherwise it wraps around either end.
  roomStep(delta) {
    const queue = this.state.roomQueue;
    if (!queue.length) return;
    if (delta > 0 && this.state.roomMode === 'shuffle') { this.roomPlay(queue, this.roomRandomPos()); return; }
    const n = queue.length;
    this.roomPlay(queue, (this.state.roomQueuePos + delta + n) % n);
  },
  // Auto-advance when a track ends (routed here from the shared audio's `ended` listener while the
  // room owns it). repeat = replay the same track; shuffle = a random other track; order = the next
  // track, or stop at the end of the queue.
  roomAdvance() {
    const queue = this.state.roomQueue;
    if (!queue.length) return;
    if (this.state.roomMode === 'repeat') { this.roomPlay(queue, this.state.roomQueuePos); return; }
    if (this.state.roomMode === 'shuffle') { this.roomPlay(queue, this.roomRandomPos()); return; }
    const next = this.state.roomQueuePos + 1;
    if (next < queue.length) { this.roomPlay(queue, next); return; }
    this.setState({ roomPlaying: false, roomPos: 0 });
  },
  // Seek by tap or scrub. Third consumer of the sheetPointerDown convention's window-level
  // listeners — but NOT of its scale division: a seek is a *ratio* along the bar, and the canvas
  // scale multiplies clientX offset and rect.width alike, so it cancels.
  roomSeekDown(e) {
    if (this.audioOwner !== 'room') return;
    const duration = this.audio.duration;
    if (!isFinite(duration) || !duration) return;
    e.preventDefault();
    const bar = e.currentTarget;
    const seekTo = clientX => {
      const rect = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      this.audio.currentTime = frac * duration;
      const pos = Math.floor(this.audio.currentTime);
      if (pos !== this.state.roomPos) this.setState({ roomPos: pos });
    };
    seekTo(e.clientX);
    const onMove = ev => seekTo(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  },
  // Vertical volume slider. Same ratio-along-the-bar trick as roomSeekDown (the canvas scale
  // multiplies the clientY offset and rect.height alike, so it cancels — no /state.scale), but
  // vertical and inverted so up = louder. Volume lives on the shared this.audio, so setting it here
  // carries into character-theme and story-BGM playback too. Persist on release, not per move.
  roomVolumeDown(e) {
    e.preventDefault();
    const bar = e.currentTarget;
    const setFrom = clientY => {
      const rect = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
      this.audio.volume = frac;
      if (frac !== this.state.roomVolume) this.setState({ roomVolume: frac });
    };
    setFrom(e.clientY);
    const onMove = ev => setFrom(ev.clientY);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      try { localStorage.setItem(VOLUME_STORAGE_KEY, String(this.state.roomVolume)); } catch (err) {}
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  },
  // Touch has no hover, so tapping the speaker button pins the slider open (CSS :hover covers the
  // desktop case via the inline opacity/visibility base this flag drives).
  toggleRoomVol() {
    this.setState(s => ({ roomVolOpen: !s.roomVolOpen }));
  },
  // The up-arrow above the now-playing bar toggles a preview of the upcoming queue tracks.
  toggleRoomQueue() {
    this.setState(s => ({ roomQueueOpen: !s.roomQueueOpen }));
  },

  // renderVals 的本页分段：计算段 + vals 字面量段，逐字搬自 index.html。
  // 只吃 ctx 里的共享量（tab），其余一律走 this —— 见 CLAUDE.md 的文件地图。
  musicVals(ctx) {
    const { tab } = ctx;
    // --- Music Room ---------------------------------------------------------------------------
    // The list view-models only build while the tab is showing: unlike the arc block's fixed 42
    // stories this walks the whole roster, and renderVals runs on every render regardless of tab.
    // The now-playing keys below are always live — they're cheap strings, and the queue persists
    // across tabs by design.
    const roomOnTab = tab === 'music';
    const roomAlbum = this.state.roomOpenAlbum;
    const roomAlbums = this.state.roomAlbums || [];
    const roomSearchText = this.state.roomSearch.trim().toLowerCase();
    const roomCurrent = this.state.roomQueue[this.state.roomQueuePos] || null;
    // 本段内的调用点原样保留；真正的判断在下面的 roomIsPlaying 方法里 —— 剧情档案的 BGM 行和角色
    // 详情的主题曲药丸也要用它（它们的 vals 分段在别的文件里），所以它不能只是这里的一个闭包。
    const roomIsPlaying = url => this.roomIsPlaying(url);
    // Floating mini-player visibility + its dragged position (see the roomMini* bindings below).
    const roomMiniOn = this.state.roomQueue.length > 0 && tab !== 'music' && !this.state.menuOpen;
    const roomMiniPos = this.state.roomMiniPos;
    // Up-next preview: the coming tracks in queue order (wrapping), capped at 10. Shown in order
    // even under shuffle — a best-effort peek, not a promise of the shuffle sequence.
    const roomUpNext = [];
    {
      const q = this.state.roomQueue, n = q.length;
      for (let k = 1; k <= 10 && k < n; k++) {
        const idx = (this.state.roomQueuePos + k) % n, t = q[idx];
        roomUpNext.push({ label: t.label, sub: t.sub, bg: '#F0F3F7', onClick: () => this.roomPlay(this.state.roomQueue, idx) });
      }
    }
    const roomCharRows = roomOnTab ? this.state.roster
      .filter(c => c.music.length && (!roomSearchText ||
        [c.enName, c.zhName, c.jpName, c.devName].filter(Boolean).join(' ').toLowerCase().includes(roomSearchText)))
      .map(c => {
        const name = (this.state.lang === 'zh' && c.zhName) ? c.zhName : c.enName;
        const folderUrl = c.thumbUrl.slice(0, c.thumbUrl.lastIndexOf('/'));
        const queue = c.music.map((f, i) => ({
          url: folderUrl + '/music/' + f, label: this.trackLabel(f, i + 1), sub: name
        }));
        return {
          headUrl: c.headUrl || c.thumbUrl,
          name,
          pills: queue.map((tr, i) => ({
            label: (roomIsPlaying(tr.url) ? '❚❚ ' : '▶ ') + tr.label,
            bg: roomIsPlaying(tr.url) ? MUSIC_ACCENT : '#F0F3F7',
            color: roomIsPlaying(tr.url) ? '#FFFFFF' : '#3E4450',
            onClick: () => this.roomToggleTrack(queue, i)
          }))
        };
      }) : [];
    const roomAlbumItems = (roomOnTab && !roomAlbum && !roomSearchText) ? roomAlbums.map(a => ({
      title: a.title,
      hasBanner: !!a.banner,
      noBanner: !a.banner,
      bannerUrl: a.banner ? ASSET_BASE + '/' + a.banner : '',
      countText: a.tracks.length + this.t('roomTracksSuffix'),
      onClick: () => this.openRoomAlbum(a)
    })) : [];
    // Search in the world section flattens to cross-album track rows (the index is what makes
    // that possible without loading anything). Album-title matches surface the whole album.
    const roomTrackResults = [];
    if (roomOnTab && !roomAlbum && roomSearchText && this.state.roomSection === 'world') {
      outer: for (const a of roomAlbums) {
        const albumHit = a.title.toLowerCase().includes(roomSearchText);
        for (let i = 0; i < a.tracks.length; i++) {
          const t = a.tracks[i];
          if (!albumHit && !t.name.toLowerCase().replace(/_/g, ' ').includes(roomSearchText.replace(/_/g, ' '))) continue;
          roomTrackResults.push({
            label: (roomIsPlaying(ASSET_BASE + '/' + t.file) ? '❚❚  ' : '▶  ') + this.roomTrackTitle(t.name),
            sub: a.title,
            bg: roomIsPlaying(ASSET_BASE + '/' + t.file) ? MUSIC_ACCENT : '#F7F9FC',
            color: roomIsPlaying(ASSET_BASE + '/' + t.file) ? '#FFFFFF' : '#3E4450',
            onClick: () => this.roomToggleTrack(this.roomAlbumQueue(a), i)
          });
          if (roomTrackResults.length >= 60) break outer;
        }
      }
    }
    const roomAlbumTracks = (roomOnTab && roomAlbum) ? this.roomAlbumQueue(roomAlbum).map((tr, i, queue) => ({
      label: (roomIsPlaying(tr.url) ? '❚❚  ' : '▶  ') + tr.label,
      bg: roomIsPlaying(tr.url) ? MUSIC_ACCENT : '#F7F9FC',
      color: roomIsPlaying(tr.url) ? '#FFFFFF' : '#3E4450',
      onClick: () => this.roomToggleTrack(queue, i)
    })) : [];
    return {
      // Music Room: library view (section chips + search + the two lists)
      isMusic: roomOnTab,
      roomShowMain: !roomAlbum,
      roomShowAlbum: !!roomAlbum,
      roomSectionChips: ROOM_SECTIONS.map(sn => ({
        label: this.t(sn.labelKey),
        // The music tint of the arc chips' #ffcf8f active state.
        bg: this.state.roomSection === sn.id ? '#E8D9F8' : '#FAFAFA',
        onClick: () => this.setRoomSection(sn.id)
      })),
      roomSearchValue: this.state.roomSearch,
      roomSearchHint: this.t('roomSearchHint'),
      setRoomSearch: (e) => this.setRoomSearch(e),
      roomShowChars: this.state.roomSection === 'char',
      roomCharRows: roomCharRows,
      roomShowWorld: this.state.roomSection === 'world',
      roomAlbumsLoading: this.state.roomAlbumsLoading,
      roomAlbumsError: !!this.state.roomAlbumsError,
      roomLoadingText: this.t('roomLoading'),
      roomErrorText: this.t('roomLoadError'),
      roomShowAlbumGrid: !roomSearchText,
      roomAlbumItems: roomAlbumItems,
      roomShowTrackResults: !!roomSearchText,
      roomTrackResults: roomTrackResults,
      roomNoResults: roomOnTab && !roomAlbum && !!roomSearchText && (
        this.state.roomSection === 'char'
          ? roomCharRows.length === 0
          : (!!this.state.roomAlbums && roomTrackResults.length === 0)),
      roomNoResultsText: this.t('roomNoResults'),

      // Music Room: album view
      roomAlbumTitle: roomAlbum ? roomAlbum.title : '',
      roomAlbumBannerCss: (roomAlbum && roomAlbum.banner) ? 'url("' + ASSET_BASE + '/' + roomAlbum.banner + '")' : 'none',
      roomBackLabel: this.t('roomBack'),
      roomBackBtn: () => this.closeRoomAlbum(),
      roomAlbumTracks: roomAlbumTracks,

      // Music Room: now-playing bar (queue survives tab switches, so these stay live)
      roomBarVisible: this.state.roomQueue.length > 0,
      roomNowTitle: roomCurrent ? roomCurrent.label : '',
      roomNowSub: roomCurrent ? roomCurrent.sub : '',
      roomPlayGlyph: this.state.roomPlaying ? '❚❚' : '▶',
      roomProgressPct: this.state.roomDur
        ? Math.min(100, this.state.roomPos / this.state.roomDur * 100) + '%'
        : '0%',
      roomTimeText: this.roomFmtTime(this.state.roomPos) + ' / ' + this.roomFmtTime(this.state.roomDur),
      roomTogglePlay: () => this.roomTogglePlay(),
      roomPrev: () => this.roomStep(-1),
      roomNext: () => this.roomStep(1),
      roomSeekDown: (e) => this.roomSeekDown(e),
      // Play mode (顺序/随机/单曲循环) — a glyph + label pill that cycles on tap.
      roomModeGlyph: ROOM_MODE_GLYPH[this.state.roomMode],
      roomModeLabel: this.t(ROOM_MODE_LABEL[this.state.roomMode]),
      cycleRoomMode: () => this.cycleRoomMode(),
      // Volume slider (hover-expanding vertical bar; tap-toggles on touch).
      roomVolumePct: Math.round(this.state.roomVolume * 100) + '%',
      roomVolPopOpacity: this.state.roomVolOpen ? '1' : '0',
      roomVolPopVis: this.state.roomVolOpen ? 'visible' : 'hidden',
      roomVolumeDown: (e) => this.roomVolumeDown(e),
      toggleRoomVol: () => this.toggleRoomVol(),
      volumeLabel: this.t('volume'),
      // Up-next popup (the up-arrow above the now-playing bar)
      toggleRoomQueue: () => this.toggleRoomQueue(),
      roomUpNext,
      roomUpNextEmpty: roomUpNext.length === 0,
      roomUpNextLabel: this.t('roomUpNextLabel'),
      roomUpNextEmptyText: this.t('roomUpNextEmpty'),
      roomQueueOpacity: this.state.roomQueueOpen ? '1' : '0',
      roomQueueVis: this.state.roomQueueOpen ? 'visible' : 'hidden',
      roomQueueArrowRot: this.state.roomQueueOpen ? 'rotate(180deg)' : 'rotate(0deg)',

      // Music Room: "play all" playlist builders (library view)
      roomPlaylistLabel: this.t('roomPlaylistLabel'),
      roomPlaylistChar: this.t('roomPlaylistChar'),
      roomPlaylistWorld: this.t('roomPlaylistWorld'),
      roomPlaylistAll: this.t('roomPlaylistAll'),
      roomPlayChar: () => this.playRoomLibrary('char'),
      roomPlayWorld: () => this.playRoomLibrary('world'),
      roomPlayAll: () => this.playRoomLibrary('all'),

      // Floating mini-player: draggable now-playing controls, shown off the music tab whenever a
      // queue is loaded. Tap = open the Music Room, drag = reposition, drop against a side edge =
      // collapse to an arrow tab. Hidden while the menu is open (which sits above it).
      roomMiniExpanded: roomMiniOn && !this.state.roomMiniCollapsed,
      roomMiniArrowShow: roomMiniOn && this.state.roomMiniCollapsed,
      roomMiniPosStyle: roomMiniPos
        ? 'left: ' + roomMiniPos.x + 'px; top: ' + roomMiniPos.y + 'px;'
        : 'right: 10px; bottom: 10px;',
      roomMiniTransition: this.state.roomMiniDragging ? 'none' : 'left 0.16s ease, top 0.16s ease',
      roomMiniArrowStyle: (this.state.roomMiniSide === 'left'
        ? 'left: 0; border-radius: 0 12px 12px 0;'
        : 'right: 0; border-radius: 12px 0 0 12px;')
        + (roomMiniPos ? ' top: ' + roomMiniPos.y + 'px;' : ' bottom: 90px;'),
      roomMiniArrowGlyph: this.state.roomMiniSide === 'left' ? '›' : '‹',
      roomMiniDown: (e) => this.roomMiniDown(e),
      roomMiniBtnStop: (e) => e.stopPropagation(),
      expandRoomMini: (e) => this.expandRoomMini(e),
    };
  },};
