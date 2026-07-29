// 弹弹（flip*）：美术投票滑牌，见 CLAUDE.md 的 Flip tab 一节 —— 从 index.html 拆出，见 CLAUDE.md 的文件地图。
// 这是一个普通的 classic script：顶层 const 进全局词法环境，data-dc-script 正文（走
// new Function，见 support.js:743）在全局作用域下求值，所以调用点不需要任何前缀。

// --- Flip (弹弹): the art-voting swipe deck ------------------------------------------------
// The one character whose folder has full_shot_1440_1920_0.png but no _1: of the 374 characters
// with full-shot art, 373 have the awakened variant and this is the difference. roster.json has no
// field recording it and the deck is built synchronously from the roster alone, so the exception
// lives here. It belongs beside `hasHead` as a roster stamp, but that costs a fetch-miaowm5.mjs
// change, a pipeline re-run, a roster.json rewrite and an R2 re-upload for one boolean on one of
// 485 rows — do it if the pipeline is ever re-run for another reason, and delete this then.
const NO_AWAKENED_ART = new Set(['ruin_girl_smr21']);
// Swipe thresholds in design px (deltas are divided by the canvas scale first — see
// flipPointerDown), against a 380px-wide card: about a quarter of the card's width commits.
const FLIP_THRESHOLD_X = 90;
const FLIP_THRESHOLD_Y = 110;
const FLIP_FLY_MS = 260;
// Where the next card sits in the stack, behind the live one. The live card borrows these for the
// swap frame so it lands exactly on the peek before rising out of it — the two must agree, and the
// transform order (translate then scale) has to match the peek's for the same reason.
const FLIP_PEEK_Y = 10;
const FLIP_PEEK_SCALE = 0.95;
const FLIP_RISE_MS = 170;

// 挂到 Component.prototype 上（见 index.html 里 class 声明之后的 Object.assign）。
const WF_FLIP = {
  buildFlipDeck() {
    const cards = [];
    for (const c of this.state.roster) {
      // Same derivation goDetail uses — the roster stores the thumb URL, and every other asset in
      // the character's folder hangs off its directory.
      const folderUrl = c.thumbUrl.slice(0, c.thumbUrl.lastIndexOf('/'));
      const base = { dev: c.devName, char: c, folderUrl };
      if (c.bustOnly) {
        cards.push({ ...base, key: c.devName + ':bust', variant: 'bust', url: '' });
      } else {
        cards.push({ ...base, key: c.devName + ':0', variant: '0', url: folderUrl + '/full_shot_1440_1920_0.png' });
        if (!NO_AWAKENED_ART.has(c.devName)) {
          cards.push({ ...base, key: c.devName + ':1', variant: '1', url: folderUrl + '/full_shot_1440_1920_1.png' });
        }
      }
    }
    // Fisher-Yates. The roster arrives sorted rarity-desc then element, which is exactly the order
    // a shuffle has to destroy — otherwise the first hundred swipes are all 5* Fire.
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = cards[i]; cards[i] = cards[j]; cards[j] = t;
    }
    return cards;
  },
  // go('flip') can fire before roster.json resolves, so this is called from both there and the
  // roster fetch's own .then — whichever happens second builds the deck. Until then the screen
  // shows its loading state.
  ensureFlipDeck() {
    if (this.flipDeck || !this.state.roster.length) return;
    this.flipDeck = this.buildFlipDeck();
    this.setState(s => ({ flipDeckVersion: s.flipDeckVersion + 1, flipIndex: 0 }));
    this.prefetchFlip();
  },
  reshuffleFlipDeck() {
    this.flipDeck = this.buildFlipDeck();
    this.setState(s => ({ flipDeckVersion: s.flipDeckVersion + 1, flipIndex: 0, flipFlying: null, flipDX: 0, flipDY: 0 }));
    this.prefetchFlip();
  },
  flipTopCard() {
    return (this.flipDeck && this.flipDeck[this.state.flipIndex]) || null;
  },
  // bustOnly characters have no full shot — their hero is the same stacked body+face art the
  // detail page and expression viewer use, and those layer filenames only exist inside the
  // per-character wiki_zh.json. Fetched once per character and never blocking: the card paints
  // immediately with the pixel neutral.gif it already has from the roster, then swaps to the bust
  // when this lands.
  ensureFlipBust(card) {
    if (!card || card.variant !== 'bust') return;
    // absent = never asked; null = in flight (without this marker, three renders during the fetch
    // would fire three fetches); array = done.
    if (this.flipEmotionCache.has(card.dev)) return;
    this.flipEmotionCache.set(card.dev, null);
    fetch(card.folderUrl + '/wiki_zh.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(data => {
        this.flipEmotionCache.set(card.dev, (data && data.emotions) || []);
        if (this.state.tab === 'flip') this.setState(s => ({ flipWikiVersion: s.flipWikiVersion + 1 }));
      });
  },
  // Warm the top card and the two behind it: the full shots so a swipe reveals painted art rather
  // than a white box, the busts so their wiki_zh.json is usually already home. Mirrors goDetail's
  // preload of both full shots.
  prefetchFlip() {
    if (!this.flipDeck) return;
    const end = Math.min(this.state.flipIndex + 3, this.flipDeck.length);
    for (let i = this.state.flipIndex; i < end; i++) {
      const card = this.flipDeck[i];
      if (card.url) new Image().src = card.url;
      else this.ensureFlipBust(card);
    }
  },
  // Modelled on sheetPointerDown: window-level pointermove/pointerup so the gesture survives the
  // pointer leaving the card, and every delta divided by the canvas scale because the whole 430px
  // card is CSS-transform-scaled to the viewport — raw client px would drift from the finger by
  // whatever the scale is. The card carries `touch-action: none`, which is what actually stops the
  // browser claiming the gesture; preventDefault here is belt-and-braces, as on the sheet's handle.
  flipPointerDown(e) {
    if (this.state.flipFlying) return; // a card already on its way out ignores input
    if (!this.flipTopCard()) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const scale = this.state.scale || 1;
    let dx = 0, dy = 0, moved = false;

    const onMove = (ev) => {
      dx = (ev.clientX - startX) / scale;
      dy = (ev.clientY - startY) / scale;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      // Coalesced to one setState per frame, the same guard the resize handler uses: renderVals
      // rebuilds the roster tiles and the story-archive lists on every render regardless of tab,
      // and a full-screen card drag is long enough for a raw per-pointermove setState to redo all
      // of that several times a frame.
      if (this.flipDragRaf) return;
      this.flipDragRaf = requestAnimationFrame(() => {
        this.flipDragRaf = 0;
        this.setState({ flipDX: dx, flipDY: dy, flipDragging: true });
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (this.flipDragRaf) { cancelAnimationFrame(this.flipDragRaf); this.flipDragRaf = 0; }

      // A press that never moved is a tap: open this character's sheet.
      if (!moved) {
        this.setState({ flipDX: 0, flipDY: 0, flipDragging: false });
        this.flipOpenDetail();
        return;
      }
      // Down = skip, but only when it clearly dominates — a lazy diagonal should still read as a
      // like/dislike, which is what a thumb actually produces.
      if (dy > FLIP_THRESHOLD_Y && dy > Math.abs(dx) * 1.2) return this.flipCommit('skip');
      if (dx > FLIP_THRESHOLD_X) return this.flipCommit('like');
      if (dx < -FLIP_THRESHOLD_X) return this.flipCommit('dislike');
      this.setState({ flipDX: 0, flipDY: 0, flipDragging: false }); // under threshold: snap back
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  },
  flipCommit(kind) {
    const card = this.flipTopCard();
    if (!card || this.state.flipFlying) return;
    this.setState({ flipFlying: kind, flipDragging: false });
    this.sendArtVote(card.key, kind);
    this.flipFlyTimer = setTimeout(() => {
      this.flipFlyTimer = 0;
      // flipSnap drops the (reused) card element onto the peek's exact transform with no
      // transition, so the next card is just there rather than flying in from where this one left.
      this.setState(s => ({
        flipIndex: s.flipIndex + 1, flipFlying: null, flipDX: 0, flipDY: 0,
        flipSnap: true, flipRising: true
      }));
      // Double rAF, not single: the transition can only be restored once the browser has actually
      // painted the card on the peek. With one rAF both DOM writes can land before a single style
      // recalc, and the browser would then see transform 620->0 with the transition still live and
      // animate exactly what flipSnap exists to prevent. (Same reason restoreUnitsScroll doubles.)
      this.flipSnapRaf = requestAnimationFrame(() => {
        this.flipSnapRaf = requestAnimationFrame(() => {
          this.flipSnapRaf = 0;
          // Transition back on, transform back to rest: this is the float-up.
          this.setState({ flipSnap: false });
          this.flipRiseTimer = setTimeout(() => {
            this.flipRiseTimer = 0;
            this.setState({ flipRising: false });
          }, FLIP_RISE_MS);
        });
      });
      this.prefetchFlip();
    }, FLIP_FLY_MS);
  },
  clearFlipTimers() {
    if (this.flipFlyTimer) { clearTimeout(this.flipFlyTimer); this.flipFlyTimer = 0; }
    if (this.flipDragRaf) { cancelAnimationFrame(this.flipDragRaf); this.flipDragRaf = 0; }
    // Leaving mid-swap would otherwise strand flipSnap true, and the next card you ever drag
    // wouldn't animate; a stranded flipRising would pace the next fly-out like a float-up.
    if (this.flipSnapRaf) { cancelAnimationFrame(this.flipSnapRaf); this.flipSnapRaf = 0; }
    if (this.flipRiseTimer) { clearTimeout(this.flipRiseTimer); this.flipRiseTimer = 0; }
    this.setState({
      flipFlying: null, flipDX: 0, flipDY: 0, flipDragging: false,
      flipSnap: false, flipRising: false
    });
  },
  flipOpenDetail() {
    const card = this.flipTopCard();
    if (!card) return;
    // goDetail sets tab directly rather than going through go(), so it doesn't get go()'s
    // fly-out cleanup for free.
    this.clearFlipTimers();
    this.goDetail(card.char);
  },
  // Every artwork's counts plus this visitor's own votes, in one call, once. ~855 rows / ~35KB —
  // per-key reads would leave the count pill blank under the user's thumb on every swipe. Kicked
  // from both go('flip') and goDetail, since the detail hero's pills work without ever opening
  // Flip.
  loadArtStats() {
    if (this.state.flipStats || this.state.flipStatsLoading) return;
    if (!this.supabaseConfigured()) { this.setState({ flipStats: {} }); return; }
    this.setState({ flipStatsLoading: true });
    this.supabaseRpc('art_stats_all', { vid: this.visitorId() }).then(rows => {
      const map = {};
      (Array.isArray(rows) ? rows : []).forEach(r => {
        map[r.art_key] = {
          likes: Number(r.likes) || 0,
          dislikes: Number(r.dislikes) || 0,
          skips: Number(r.skips) || 0,
          my_vote: r.my_vote == null ? null : Number(r.my_vote)
        };
      });
      this.setState({ flipStats: map, flipStatsLoading: false });
    });
  },
  sendArtVote(artKey, kind) {
    const v = kind === 'like' ? 1 : kind === 'dislike' ? -1 : 0;
    const bucket = f => (f === 1 ? 'likes' : f === -1 ? 'dislikes' : 'skips');

    // Move the count locally first, so the pill is already right when the card flies out — the
    // round-trip is far slower than the 260ms animation, and the server's answer overwrites this
    // when it lands. Re-voting the same way is -1 then +1 on the same bucket = no change, which
    // matches vote_art's own `if prev is distinct from v` no-op: the two sides agree by
    // construction.
    this.setState(s => {
      const stats = { ...(s.flipStats || {}) };
      const cur = stats[artKey] || { likes: 0, dislikes: 0, skips: 0, my_vote: null };
      const next = { ...cur };
      if (cur.my_vote != null) next[bucket(cur.my_vote)] = Math.max(0, next[bucket(cur.my_vote)] - 1);
      next[bucket(v)] = next[bucket(v)] + 1;
      next.my_vote = v;
      stats[artKey] = next;
      return { flipStats: stats };
    });

    if (!this.supabaseWritable()) return;
    this.supabaseRpc('vote_art', { vid: this.visitorId(), akey: artKey, v: v }).then(data => {
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.likes == null) return; // failed call: the optimistic value stands
      this.setState(s => ({ flipStats: { ...(s.flipStats || {}), [artKey]: {
        likes: Number(row.likes), dislikes: Number(row.dislikes), skips: Number(row.skips),
        my_vote: row.my_vote == null ? null : Number(row.my_vote)
      } } }));
    });
  },

  // renderVals 的本页分段：计算段 + vals 字面量段，逐字搬自 index.html。
  // 只吃 ctx 里的共享量（tab, accent），其余一律走 this —— 见 CLAUDE.md 的文件地图。
  flipVals(ctx) {
    const { tab, accent } = ctx;
    // --- Flip (弹弹) --------------------------------------------------------------------------
    const flipCard = this.flipDeck ? (this.flipDeck[this.state.flipIndex] || null) : null;
    const flipNext = this.flipDeck ? (this.flipDeck[this.state.flipIndex + 1] || null) : null;
    const flipDeckLen = this.flipDeck ? this.flipDeck.length : 0;
    // Same resolution the detail hero uses for bustOnly characters, against the deck's own rolling
    // cache rather than state.wikiData. Until the fetch lands the card shows the pixel sprite.
    const flipEmotions = flipCard ? this.flipEmotionCache.get(flipCard.dev) : undefined;
    const flipFace = (flipCard && flipCard.variant === 'bust' && Array.isArray(flipEmotions))
      ? ((flipEmotions.filter(e => !isEmotionOverlay(e.name)).find(e => e.name === 'normal'))
         || flipEmotions.filter(e => !isEmotionOverlay(e.name))[0] || null)
      : null;
    const flipEmotionDir = flipCard ? flipCard.folderUrl + '/emotion/' : '';
    const flipShowBust = !!flipFace;
    const flipHasElement = !!(flipCard && flipCard.char.elementIndex >= 0);
    const flipStat = (flipCard && this.state.flipStats) ? this.state.flipStats[flipCard.key] : null;
    const flipMyVote = flipStat ? flipStat.my_vote : null;
    // A dash until art_stats_all resolves, matching the top bar's pv/uv convention.
    const flipNum = k => (this.state.flipStats && flipCard)
      ? String(flipStat ? flipStat[k] : 0)
      : '—';

    const fly = this.state.flipFlying;
    let flipTX = this.state.flipDX, flipTY = this.state.flipDY;
    let flipRot = this.state.flipDX / 18, flipOp = 1, flipScale = 1;
    if (fly === 'like') { flipTX = 620; flipTY = 0; flipRot = 24; flipOp = 0; }
    if (fly === 'dislike') { flipTX = -620; flipTY = 0; flipRot = -24; flipOp = 0; }
    if (fly === 'skip') { flipTX = 0; flipTY = 900; flipRot = 0; flipOp = 0; }
    // The swap frame (transition suppressed): sit exactly on top of the peek card, matching its
    // transform. The card that just left is gone, and the incoming one is pixel-for-pixel where it
    // already appeared to be — nothing moves. Clearing flipSnap next frame then restores the
    // transition and this returns to scale 1 at y 0, which is the whole float-up: the card rises
    // into place out of the stack instead of popping to full size.
    if (this.state.flipSnap) { flipTX = 0; flipTY = FLIP_PEEK_Y; flipRot = 0; flipOp = 1; flipScale = FLIP_PEEK_SCALE; }
    const clamp01 = n => Math.max(0, Math.min(1, n));
    return {
      // Flip (弹弹): the art-voting deck.
      isFlip: tab === 'flip',
      flipScreenTitle: this.t('flipScreenTitle'),
      flipHintText: this.t('flipHint'),
      flipTapHintText: this.t('flipTapHint'),
      flipVoteHint: this.t('flipVoteHint'),
      flipLoadingText: this.t('flipLoading'),
      flipDoneText: this.t('flipDone'),
      flipReshuffleText: this.t('flipReshuffle'),
      // Three states, exactly one true: still waiting on the roster, out of cards, or a live card.
      flipLoading: !this.flipDeck,
      flipDone: !!this.flipDeck && !flipCard,
      flipHasCard: !!flipCard,
      flipProgressText: flipCard ? (flipDeckLen - this.state.flipIndex) + this.t('flipProgressSuffix') : '',
      flipCardName: flipCard
        ? ((this.state.lang === 'zh' && flipCard.char.zhName) ? flipCard.char.zhName : flipCard.char.enName)
        : '',
      flipCardRarityUrl: flipCard ? flipCard.char.rarityUrl : '',
      flipCardRarityLabel: flipCard ? flipCard.char.rarityLabel : '',
      // Shared UI art served with the site, so it isn't under ASSET_BASE. Guarded on the index
      // rather than assumed: elementIndex is an ELEMENT_ORDER.indexOf, so an unknown attribute
      // would be -1 and would otherwise build icons/element_-1.png.
      flipCardHasElement: flipHasElement,
      flipCardElementUrl: flipHasElement ? 'icons/element_' + flipCard.char.elementIndex + '.png' : '',
      flipCardElementLabel: flipHasElement ? this.t('filterElement' + ELEMENT_ORDER[flipCard.char.elementIndex]) : '',
      flipCardVariantLabel: flipCard
        ? (flipCard.variant === 'bust' ? this.t('flipVariantBust')
           : flipCard.variant === '1' ? this.t('artAwakened') : this.t('artBase'))
        : '',
      // A bust card paints with the pixel sprite it already has, then swaps to the stacked bust
      // once ensureFlipBust's wiki_zh.json fetch lands.
      flipShowFullShot: !!(flipCard && flipCard.url),
      flipFullShotUrl: flipCard ? flipCard.url : '',
      flipShowBust: flipShowBust,
      flipHasBustBase: !!(flipFace && flipFace.base),
      flipBustBaseUrl: flipFace && flipFace.base ? flipEmotionDir + flipFace.base : '',
      flipHasBustFront: !!(flipFace && flipFace.front),
      flipBustFrontUrl: flipFace && flipFace.front ? flipEmotionDir + flipFace.front : '',
      flipShowBustFallback: !!(flipCard && flipCard.variant === 'bust' && !flipShowBust),
      flipBustFallbackUrl: flipCard ? flipCard.char.thumbUrl : '',
      flipCardTransform: 'translate(' + flipTX + 'px, ' + flipTY + 'px) rotate(' + flipRot + 'deg) scale(' + flipScale + ')',
      // Same idiom as sheetTransition: no transition while the finger owns it, an eased one
      // otherwise — plus flipSnap, the one frame that drops the next card onto the peek without
      // animating it (see the state field). The frame after that is the float-up, and it gets its
      // own shorter duration: a 10px rise paced like a 620px fly-out would feel like a stall.
      flipCardTransition: (this.state.flipDragging || this.state.flipSnap)
        ? 'none'
        : this.state.flipRising
          ? 'transform ' + FLIP_RISE_MS + 'ms ease-out, opacity ' + FLIP_RISE_MS + 'ms ease-out'
          : 'transform ' + FLIP_FLY_MS + 'ms ease-out, opacity ' + FLIP_FLY_MS + 'ms ease-out',
      flipCardOpacity: flipOp,
      flipLikeBadgeOpacity: clamp01(this.state.flipDX / FLIP_THRESHOLD_X),
      flipDislikeBadgeOpacity: clamp01(-this.state.flipDX / FLIP_THRESHOLD_X),
      flipSkipBadgeOpacity: clamp01(this.state.flipDY / FLIP_THRESHOLD_Y),
      // The card behind, revealed as the top one leaves. Static — two cards in the DOM, never more.
      // Built from the same constants the swap frame uses, so the two can't drift apart.
      flipHasNext: !!(flipNext && flipNext.url),
      flipNextFullShotUrl: flipNext ? flipNext.url : '',
      flipPeekTransform: 'translate(0px, ' + FLIP_PEEK_Y + 'px) rotate(0deg) scale(' + FLIP_PEEK_SCALE + ')',
      flipLikeCount: flipNum('likes'),
      flipDislikeCount: flipNum('dislikes'),
      flipSkipCount: flipNum('skips'),
      flipLikeTitle: this.t('flipLike'),
      flipDislikeTitle: this.t('flipDislike'),
      flipSkipTitle: this.t('flipSkip'),
      // The fallback buttons double as the "what did I pick" indicator, using the same
      // accent-vs-#F0F3F7 pair the music and action pills use.
      flipLikeBtnBg: flipMyVote === 1 ? accent : '#FFFFFF',
      flipLikeBtnColor: flipMyVote === 1 ? '#FFFFFF' : '#F0526E',
      flipDislikeBtnBg: flipMyVote === -1 ? accent : '#FFFFFF',
      flipDislikeBtnColor: flipMyVote === -1 ? '#FFFFFF' : '#8A93A5',
      flipSkipBtnBg: flipMyVote === 0 ? accent : '#FFFFFF',
      flipSkipBtnColor: flipMyVote === 0 ? '#FFFFFF' : '#8A93A5',
      flipPointerDown: (e) => this.flipPointerDown(e),
      flipVoteLike: () => this.flipCommit('like'),
      flipVoteDislike: () => this.flipCommit('dislike'),
      flipVoteSkip: () => this.flipCommit('skip'),
      flipOpenDetail: () => this.flipOpenDetail(),
      flipReshuffle: () => this.reshuffleFlipDeck(),
      goFlip: () => this.go('flip'),
      navFlipLabel: this.t('navFlip'),
    };
  },};
