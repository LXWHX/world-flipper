# English data gaps (updated 2026-07-23, after the community-sheet + story passes)

What the English pipelines could **not** fill in, and where to look next.

Regenerate the raw lists any time — they're derived, not hand-kept:

```
npm run scrape:wiki-en       # -> Character Assets/_wikigg_unmatched_report.md
npm run scrape:weapons-en    # -> Weapons/_wikigg_unmatched_report.md
npm run scrape:stories-en    # -> Character Assets/_wikigg_stories_report.md
npm run fetch:community-en   # -> Character Assets/_community_en_report.md
```

Those reports hold the full name lists. This document is the interpretation: which gaps are real,
which are fixable here, and which need an outside source.

---

## Summary

| Area | Covered | Gap |
| --- | --- | --- |
| Character English names (of 485 roster entries) | **484** | 1 |
| Character wiki text (of 377 with a roster `enName`) | 369 | 8 |
| Character stories (episode scripts) | 291 pages | ~86 characters |
| Character episode playthrough videos | 484 | — |
| Character quote lines | 38 pages | ~331 characters have none |
| Weapons (of 384) | 316 | 68 |
| **Main/event story scripts** (of our 42 stories) | **13** | 29 |
| **Story English titles** (of our 42) | **39** | 3 |
| Story playthrough videos (of our 42) | **40** | 2 |

---

## What closed since the first pass

**§1 (the 108 `bustOnly` characters) is closed.** The community story-archive spreadsheet has a
unit tab carrying `devName`, so 432 of 485 matched exactly; the remaining 52 came from its CN-only
tab through a hand-verified table. Only `flame_witch` (夏可缇) has no English name anywhere — it is
simply absent from the sheet. See the community-sheet pipeline in CLAUDE.md.

**§5's headline claim was wrong.** wiki.gg *does* have English main-story scripts. The earlier
search looked for `{{SL|` on `/Stories` subpages; the main story lives on
`Story Quests/World N: <name>/<Episode>` pages using `{{Story pages}}`. `list=embeddedin` on
`Template:Story pages` finds all 131 of them: Worlds 1-5 in full, plus 9 events. The "~60 event
pages we're not using" in the old note were in fact the main-quest pages.

**"Ernest" is not a missing character.** The community sheet pairs that name with `Ornesto`
(`long_hair_swordsman`), which we have. §3's list is one shorter than it looked.

---

## 1. Main story Worlds 6-12 — no English script anywhere

wiki.gg has a chapter page for Worlds 6-10 (so the English chapter names are ours: Yamato, The
Wastelands, Realm of Ruin, The Shifting City, Origin's End) but no episode subpages. Worlds 11-12
have no page at all — global never reached them.

Counted in episodes: our main story is 205 episodes (prologue included); the chapters wiki.gg
covers account for 74 of them, so **131 main-story episodes have no English text**. Every chapter
does have a **community playthrough video**, which is what the Story tab links instead.

**Where to look next:** a full English main story almost certainly requires datamined global client
files, not a wiki. Worlds 6-10 could also be transcribed onto wiki.gg by anyone willing — the
pipeline would pick them up on the next run with no code change.

## 2. Events with no English script — 21 of 29

wiki.gg has pages for 9 of our 29 event/collab stories, but only **8 carry dialogue**: Poppet
Princess, Legacy of the Deep, Valentine's Festival, Oath to the Dawn, A Hero's Beginning, Cross
Blue, Not Today Romero, Wanderers from Another World. The Yokai Encyclopedia's 11 pages have
summaries and an empty `Script=` — episode names and summaries render, dialogue doesn't. The other
20 have an English title and a playthrough video from the sheet, and nothing else.

`STORY_PAGES` in `scripts/scrape-wiki-gg-stories.mjs` is where a newly transcribed event goes; the
report cross-checks episode counts against `story/index.json`, which is how a wrong pairing shows.

## 3. Three stories with no English title, two with no video

No English title: **`prologue`, `main_chapter_11`, `main_chapter_12`**. wiki.gg has no page for
any of them, and the sheet's main-story tab labels its rows "Prologue" / "World 11" / "World 12" —
positions, not titles — so there is nothing to show but the Chinese title. All three do have a
video. (Worlds 11-12 would gain a title the moment wiki.gg gets a chapter page; the pipeline reads
chapter pages even when they have no episodes, which is how Worlds 6-10 have English names.)

No video: **`extra_adv_100006`** (凉宫春日的跳跃) and **`extra_adv_300001`** (不諦の魔道士) — the
Haruhi and Black Clover collabs, unclaimed rows on the sheet. Those two plus `extra_adv_300000`
(Konosuba, which does have a translated video) carry no eventID at all on the sheet and are mapped
by event name in `EVENT_SLUGS_BY_NAME`.

## 4. Eight named characters with no wiki.gg page

**Five are genuinely absent** — the Melancholy of Haruhi Suzumiya collab (`suzumiya_haruhi`,
`nagato_yuki`, `asahina_mikuru`, `kyon`, `koizumi_ituki`). Global never ran that collab, so there
is no page to match; they do now have English names and epithets from the sheet.

**Three are probably name drift, not absence.** Each has a plausible counterpart in the orphan list
at matching rarity + element, and slipped through both matcher tiers only because their
`wiki_zh.json` carries no stat table for the stats tier to key on:

| roster | `enName` | rarity/element | likely wiki.gg page | confidence |
| --- | --- | --- | --- | --- |
| `estateguild_leader` | Hildegard | 5★ Dark | **Hildegarde** | near-certain (same name) |
| `scissor_ratgirl` | Rinkarina | 4★ Thunder | Karina | plausible, unverified |
| `anger_investigator` | Waif | 5★ Fire | Weihu | plausible, unverified |

To act on any of these, add the pair to `TITLE_OVERRIDES` in `scripts/scrape-wiki-gg-units.mjs`
and re-run.

⚠️ **`estateguild_leader` is deliberately not in the override table.** It's one of the three roster
entries with `thumb: null` — no character folder to write into, and the front-end filters it out of
every grid. Matching it raises the reported count without producing a file or changing anything on
screen. Only add it if those `thumb: null` entries ever get folders.

## 5. Six wiki.gg characters not in our roster

`Elmara`, `Faroa`, `Mayuzuki`, `Quinvere`, `Ruelle`, plus the three candidates above. These are the
reverse gap: global-release characters our CN-sourced roster doesn't have. Adding them would mean
art and pixel assets we don't have, so this is a much bigger job than text. (`Units` also appears
in the category but is a navigation page, not a character.)

## 6. Weapons — 68 of 384

**51 have no English match** (no wiki.gg page with those stats). Most are presumably CN-only
armaments. Listed in full in `Weapons/_wikigg_unmatched_report.md`.

**17 were refused as ambiguous** — several wiki.gg pages share an identical stat line and the
effect-number fingerprint didn't single one out. **These are the cheapest wins available**, because
many are obvious on inspection. Three patterns in the current list:

- **Identical strings.** `WBR-01` → `WBR-01`. Free.
- **Literal translations.** 镇压 → Suppression, 双牙项链 → Crossed Fang Necklace,
  海姆达尔之剑 → Heimdall's Sword, 古王之枪 → Spear of the Ancient King.
- **Phonetic transliterations.** 布里欧纳克 → Brionac, 哈尼霍普隆 → Hanihoplon.

A small override table keyed by `href` (mirroring `TITLE_OVERRIDES`) would clear most of the 17 in
one pass. Deliberately not guessed automatically — a wrong weapon name is worse than a missing one.

**28 wiki.gg armament pages have no CN counterpart** — the reverse gap, global-only weapons.

## 7. Smaller gaps

- **Voice lines: only 38 of 369 matched characters have a `/Quotes` page.** The rest keep Chinese
  voice text. Thin upstream coverage, not a matching failure — nothing to fix on our side.
- **`nickname` and `type`** have no `{{Unit}}` equivalent. The character's **epithet** now comes
  from the community sheet instead (shown under the name in English); `type` is still Chinese-only.
- **Weapon role/limit/system (能力/限制/体系)** have no English counterpart in `{{Armament}}`, so
  the Armaments filter chips stay Chinese.
- **`flame_witch` (夏可缇)** — the one roster character with no English name from any source.

---

## Matching notes for whoever picks this up

The lesson from these passes, in case a third source is added: **do not assume names match.**

1. **A shared internal id beats everything.** The community sheet was worth a pipeline purely
   because one column holds `devName`; that single fact matched 432 characters and closed the
   largest gap in this document. Look for the id column before writing any matcher.
2. **Numbers cross language barriers; names don't.** Max HP + max ATK + rarity + element matched
   189 characters whose names disagreed completely, and matched weapons across two sources that
   share no name at all.
3. **Effect text is a usable fingerprint.** Stripping everything but the digits out of a skill
   description ("own ATK +160%" → `160`) survives translation and broke 48 of 64 weapon
   stat-collisions.
4. **An epithet is a better join key than a name.** Character names repeat across alts (two Liams,
   two Hartliefs); the 432 epithets in the sheet are unique.
5. **Systematic drift is a rule, not a table.** roster `(Christmas)` = wiki `(Holiday)`, every
   `(Anniversary)` = `(Flipperversary)`. Check for equivalents in any new source before
   hand-writing overrides.
6. **Refuse ambiguous matches.** Every scraper leaves a collision unmatched and reports it rather
   than guessing. Keep that — the reports are only useful because they're trustworthy.
7. **Enumerate by transclusion, not by title prefix.** `list=embeddedin` on the template is what
   found the main story that a title search had missed for a whole pass.
