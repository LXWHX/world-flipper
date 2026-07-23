# English data gaps after the wiki.gg pass (2026-07-23)

What the `worldflipper.wiki.gg` pipeline could **not** fill in, and where to look next. Written as
a worklist for finding a second English source.

Regenerate the raw lists any time — they're derived, not hand-kept:

```
npm run scrape:wiki-en      # -> Character Assets/_wikigg_unmatched_report.md
npm run scrape:weapons-en   # -> Weapons/_wikigg_unmatched_report.md
```

Those two reports hold the full name lists. This document is the interpretation: which gaps are
real, which are fixable here, and which need an outside source.

---

## Summary

| Area | Covered | Gap |
| --- | --- | --- |
| Characters (of 377 with an `enName`) | **369** | 8 |
| Characters with no `enName` at all (`bustOnly`) | 0 | **108** |
| Weapons (of 384) | **316** | 68 |
| Character stories (episode scripts) | 291 pages | — |
| Character quote lines | 38 pages | ~331 characters have none |
| Main-story episode scripts | **0** | all 42 stories |

---

## 1. The 108 `bustOnly` characters — needs a different source entirely

**The single biggest gap, and wiki.gg cannot help with it.** These are CN/JP-only characters that
the global release never shipped; wiki.gg documents the global release, so there are no pages to
match. They have no `enName` or `jpName` in `roster.json` either — only `zhName` from miaowm5.

Full list: the last section of `Character Assets/_wikigg_unmatched_report.md`.

**Where to look next:**
- A Japanese source would at least give `jpName` for the JP-released subset, which is a better
  matching key than `zhName` and might unlock an English fan translation later.
- `roster.json` has no `jpName` for these, so any new source has to match on `devName` (miaowm5's
  key) or `zhName`. `devName` is the strong one — it's the game's internal id, so any datamined
  source will share it.
- Three of them have Japanese-script `zhName`s (Black Clover collab) because the CN game data left
  them untranslated — those will look like false positives in a JP source. Expected.

## 2. Eight named characters with no wiki.gg page

**Five are genuinely absent** — the Melancholy of Haruhi Suzumiya collab (`suzumiya_haruhi`,
`nagato_yuki`, `asahina_mikuru`, `kyon`, `koizumi_ituki`). Global never ran that collab. A JP
source is the only realistic option, since the collab did run in Japan.

**Three are probably name drift, not absence.** Each has a plausible counterpart sitting in the
orphan list at matching rarity + element. They slipped through both matcher tiers only because
their `wiki_zh.json` carries no stat table for the stats tier to key on:

| roster | `enName` | rarity/element | likely wiki.gg page | confidence |
| --- | --- | --- | --- | --- |
| `estateguild_leader` | Hildegard | 5★ Dark | **Hildegarde** | near-certain (same name) |
| `scissor_ratgirl` | Rinkarina | 4★ Thunder | Karina | plausible, unverified |
| `anger_investigator` | Waif | 5★ Fire | Weihu | plausible, unverified |

To act on any of these, add the pair to `TITLE_OVERRIDES` in
`scripts/scrape-wiki-gg-units.mjs` and re-run.

⚠️ **`estateguild_leader` is deliberately not in the override table.** It's one of the three roster
entries with `thumb: null` — no character folder to write into, and the front-end filters it out of
every grid. Matching it raises the reported count without producing a file or changing anything on
screen. Only add it if those `thumb: null` entries ever get folders.

## 3. Nine wiki.gg characters not in our roster

`Elmara`, `Ernest`, `Faroa`, `Mayuzuki`, `Quinvere`, `Ruelle` — plus the three candidates above.
These are the reverse gap: global-release characters our CN-sourced roster doesn't have. Adding
them would mean art and pixel assets we don't have, so this is a much bigger job than text.
(`Units` also appears in the category but is a navigation page, not a character.)

## 4. Weapons — 68 of 384

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

## 5. Story — the largest structural gap

**wiki.gg has no English script for any main-story episode.** Our pipeline has 42 stories and
~18,500 dialogue lines; the English side has:

- 291 **character** story pages (fully covered — these shipped in this pass)
- ~60 **event** episode pages across only ~8 events
- **0** main-quest episodes

Verified with `insource:"SL|"` excluding `/Stories` — 60 total hits. This is why the story board
was left out of this pass.

**Where to look next:** the ~60 event pages are real content we're not using. They'd need a slug
mapping from wiki.gg event titles to our `eventID`-based slugs, which share no key — probably a
hand-written table, since there are only ~8 events. That's a contained, worthwhile follow-up. Full
main-story English text almost certainly requires datamined global game files, not a wiki.

## 6. Smaller gaps

- **Voice lines: only 38 of 369 matched characters have a `/Quotes` page.** The rest keep Chinese
  voice text. This is thin upstream coverage, not a matching failure — nothing to fix on our side.
- **`nickname` and `type`** have no `{{Unit}}` equivalent, so they stay Chinese in English mode.
  Only exists in Chinese; would need a different source.
- **Weapon role/limit/system (能力/限制/体系)** have no English counterpart in `{{Armament}}`, so
  the Armaments filter chips stay Chinese.

---

## Matching notes for whoever picks this up

The lesson from this pass, in case a second source is added: **do not assume names match.**
`roster.json`'s `enName` looked like it would equal wiki.gg's page titles and only did for 166 of
377. What actually worked:

1. **Numbers cross language barriers; names don't.** Max HP + max ATK + rarity + element matched
   189 characters whose names disagreed completely. The same trick matched weapons across two
   sources that share no name at all.
2. **Effect text is a usable fingerprint.** Stripping everything but the digits out of a skill
   description ("own ATK +160%" → `160`) survives translation and broke 48 of 64 weapon
   stat-collisions.
3. **Systematic drift is a rule, not a table.** roster `(Christmas)` = wiki `(Holiday)`, and every
   `(Anniversary)` = `(Flipperversary)`. Worth checking for equivalents in any new source before
   hand-writing overrides.
4. **Refuse ambiguous matches.** Both scrapers leave a collision unmatched and report it rather
   than guessing. Keep that — the reports above are only useful because they're trustworthy.
