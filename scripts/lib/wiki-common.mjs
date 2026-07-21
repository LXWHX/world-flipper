// Shared helpers for scraping the bilibili biligame World Flipper wiki (and, later, other
// wiki sources following the same shape). Kept provider-agnostic where possible so a future
// English-wiki scraper can reuse the HTTP/manifest/table-walking helpers.

import { load } from 'cheerio';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) wf-museum-archive-scraper/1.0 (personal fan-site data collection)';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polite fetch: single in-flight request per caller, small delay after every request (even
// failures) so retries don't hammer the server, a couple of retries for transient network blips.
export async function politeFetch(url, { delayMs = 1000, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      await sleep(delayMs);
      return text;
    } catch (err) {
      lastErr = err;
      // Back off on retry — biligame answers a bare/bot-looking request with HTTP 567, and a
      // longer pause plus the browser-like headers callers pass is what clears it.
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

export function loadHtml(html) {
  return load(html);
}

// MediaWiki gives every <h2> section an id; when a section title repeats later in the same
// page (e.g. a mobile-only duplicate of "评价"/"角色故事"/"语音" appears before the desktop
// version), the second one gets an auto-suffixed id like "评价_2". We want the *last* (most
// complete/desktop) occurrence of each logical section, so walk in document order and let
// later matches overwrite earlier ones.
export function findSections($) {
  const sections = new Map(); // baseName -> [siblings until next h2]
  const headings = $('h2').has('span.mw-headline').toArray();

  headings.forEach((h2, i) => {
    const id = $(h2).find('span.mw-headline').attr('id') || '';
    const base = id.replace(/_\d+$/, '');
    if (!base) return;
    const els = [];
    let node = $(h2).next();
    const stopAt = headings[i + 1];
    while (node.length && (!stopAt || node[0] !== stopAt)) {
      els.push(node);
      node = node.next();
    }
    sections.set(base, els); // later heading with same base overwrites earlier one
  });

  return sections;
}

const NBSP_RE = new RegExp(String.fromCharCode(160), 'g');

// `.bili-tt`/`.dashed-bold` wrapper spans come in two flavors: (a) an icon with no visible text
// (e.g. an attribute icon) whose only label lives in a `.tt-child` (CSS `display:none`) span, or
// (b) a visible abbreviation like "PF"/"Combo" followed by a `.tt-child` holding its whole
// glossary definition. For (a) we want the hidden label (it's the only text there is); for (b)
// the definition is noise that would otherwise duplicate a paragraph every time the abbreviation
// appears, so we drop it and keep the visible abbreviation.
function stripTooltips($, clone) {
  clone.find('.bili-tt, .dashed-bold').each((_, span) => {
    const $span = $(span);
    const tip = $span.find('.tt-child').first();
    const tipText = tip.length ? tip.text().trim() : '';
    const visible = $span.clone();
    visible.find('.tt-child').remove();
    const visibleText = visible.text().trim();
    if (visibleText) {
      $span.find('.tt-child').remove();
    } else if (tipText) {
      $span.text(tipText.split('\n')[0]);
    }
  });
  return clone;
}

// Renders a cell's text the way a reader would see it: <br> becomes a newline, tooltip spans
// are resolved via stripTooltips, and everything else collapses to its visible text.
export function cellText($, el) {
  const clone = stripTooltips($, $(el).clone());
  clone.find('br').replaceWith('\n');
  const tmp = load(`<div>${clone.html() || ''}</div>`);
  return tmp('div')
    .text()
    .replace(NBSP_RE, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function parseBasicInfoTable($, table) {
  const info = {};
  const FIELD_MAP = {
    中文名: 'chineseName',
    日文名: 'japaneseName',
    昵称: 'nickname',
    稀有度: 'rarity',
    类型: 'type',
    属性: 'attribute',
    职责: 'role',
    性别: 'gender',
    种族: 'race',
    CV: 'cv',
    获取方式: 'acquisition',
  };
  $(table)
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr).children('th, td').toArray();
      for (let i = 0; i < cells.length; i += 2) {
        const th = cells[i];
        const td = cells[i + 1];
        if (!th || !td || th.tagName !== 'th') continue;
        const label = cellText($, th).trim();
        const key = FIELD_MAP[label];
        if (!key) continue;
        if (key === 'rarity') {
          const alt = $(td).find('img').attr('alt') || '';
          const m = alt.match(/(\d+)/);
          info.rarity = m ? Number(m[1]) : cellText($, td);
        } else {
          info[key] = cellText($, td);
        }
      }
    });
  return info;
}

export function parseStatsTable($, table) {
  const rows = {};
  $(table)
    .find('tr')
    .each((_, tr) => {
      const th = $(tr).find('th').first();
      const tds = $(tr).find('td').toArray();
      if (!th.length || !tds.length) return;
      const label = cellText($, th[0]);
      rows[label] = tds.map((td) => cellText($, td));
    });
  return rows;
}

// "技能" section: a sequence of <table class="wikitable"> (必杀技能/队长技) plus one
// <table class="unit-table"> (能力, numbered passives). Each table's <caption> names the group.
export function parseSkillTables($, tables) {
  const groups = [];
  for (const table of tables) {
    const caption = cellText($, $(table).find('caption').first());
    const entries = [];
    let current = null;
    $(table)
      .find('> tbody > tr')
      .each((_, tr) => {
        const th = $(tr).children('th');
        const td = $(tr).children('td');
        if (th.length && !td.length) {
          if (current) entries.push(current);
          current = { name: cellText($, th[0]), text: '' };
        } else if (td.length) {
          const text = cellText($, td[0]);
          if (!current) current = { name: '', text: '' };
          current.text = current.text ? `${current.text}\n${text}` : text;
        }
      });
    if (current) entries.push(current);
    groups.push({ caption, entries });
  }
  return groups;
}

// "角色故事" section: one or more <table class="wikitable mw-collapsible"> each holding a
// single story ("故事一"/"故事二"/...), plus an optional lead <p> shown before the first table.
export function parseStoryTables($, els) {
  const stories = [];
  let intro = '';
  for (const el of els) {
    if (el.is('p') && stories.length === 0) {
      const t = cellText($, el);
      if (t) intro = intro ? `${intro}\n${t}` : t;
    } else if (el.is('table')) {
      const title = cellText($, el.find('th').first());
      const body = cellText($, el.find('td').first());
      stories.push({ title, text: body });
    }
  }
  return { intro, stories };
}

export function parseEvaluationTable($, table) {
  const paragraphs = [];
  $(table)
    .find('> tbody > tr')
    .each((_, tr) => {
      const td = $(tr).children('td');
      if (td.length) paragraphs.push(cellText($, td[0]));
    });
  return paragraphs.join('\n').trim();
}

// "语音" section: one <table> per (base or awakened) form. Inside, <th>-only rows are context
// labels ("日常"/"加入"/"战斗"/...) that apply to every line until the next <th> row. Each <td>
// can hold several lines; a line's text is whatever text/inline-markup precedes its
// <div class="audio-wrapper"><audio src="..."></audio></div>, regardless of intervening <br>.
export function parseVoiceTable($, table) {
  const lines = [];
  let context = '';
  $(table)
    .find('> tbody > tr')
    .each((_, tr) => {
      const th = $(tr).children('th');
      const td = $(tr).children('td');
      if (th.length && !td.length) {
        context = cellText($, th[0]);
        return;
      }
      if (!td.length) return;
      let buffer = '';
      $(td[0])
        .contents()
        .each((__, node) => {
          if (node.type === 'tag' && node.name === 'div' && $(node).hasClass('audio-wrapper')) {
            const mp3Url = $(node).find('audio').attr('src') || '';
            const text = buffer.replace(NBSP_RE, ' ').trim();
            if (mp3Url) lines.push({ context, text, mp3Url });
            buffer = '';
          } else if (node.type === 'tag' && node.name === 'br') {
            buffer += '\n';
          } else if (node.type === 'tag' && node.name === 'script') {
            // html5media loader tag injected next to each <audio>; not content.
          } else if (node.type === 'tag') {
            const clone = stripTooltips($, $(node).clone());
            buffer += load(`<div>${clone.toString()}</div>`)('div').text();
          } else {
            buffer += node.data || '';
          }
        });
    });
  return lines;
}

// Normalizes a Japanese name for matching against roster.json's `jpName`: trims whitespace,
// converts full-width ASCII/space to half-width, and drops a trailing "(variant)" qualifier
// bilibili sometimes appends that roster.json's jpName doesn't carry.
export function normalizeJpName(name) {
  if (!name) return '';
  return name
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[（(][^）)]*[）)]$/, '')
    .trim();
}

export function safeFileNameFromUrl(url) {
  const name = decodeURIComponent(url.split('/').pop());
  return name.replace(/[\\/:*?"<>|]/g, '_');
}
