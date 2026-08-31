'use strict';

const QUERY = new URLSearchParams(location.search);
const LOCAL_TEST = QUERY.get('test') === '1';

const DEFAULT_CONFIG = {
  feeds: [],
  max_items_per_feed: 5,
  max_total_items: 12,
  rotation_seconds: 12,
  refresh_minutes: 15,
  sort_order: 'newest',
  layout: 'split',
  show_source: true,
  show_date: true,
  show_title: true,
  show_description: true,
  show_category: false,
  show_image: true,
  show_qr: true,
  article_image_fallback: true,
  description_max_chars: 1500,
  date_format: 'date',
  background_color: '#eef3f7',
  surface_color: '#ffffff',
  text_color: '#1a2433',
  muted_color: '#5a6b7b',
  accent_color: '#00549f',
  image_fit: 'cover'
};

let config = structuredCloneSafe(DEFAULT_CONFIG);
let items = [];
let currentIndex = 0;
let rotationTimer = null;
let refreshTimer = null;
let progressFrame = null;
let startedAt = 0;
let isActive = false;
let initialized = false;
let loadGeneration = 0;
let loadPromise = null;

const el = {};

document.addEventListener('DOMContentLoaded', async () => {
  el.slide = document.getElementById('slide');
  el.media = document.getElementById('media');
  el.image = document.getElementById('image');
  el.headerTitle = document.getElementById('headerTitle');
  el.source = document.getElementById('source');
  el.category = document.getElementById('category');
  el.date = document.getElementById('date');
  el.title = document.getElementById('title');
  el.description = document.getElementById('description');
  el.descriptionViewport = document.getElementById('descriptionViewport');
  el.progressBar = document.getElementById('progressBar');
  el.status = document.getElementById('status');
  el.statusTitle = document.getElementById('statusTitle');
  el.statusText = document.getElementById('statusText');
  el.qrBox = document.getElementById('qrBox');
  el.qrImage = document.getElementById('qrImage');

  if (LOCAL_TEST) {
    init_widget(await loadLocalTestConfig());
    start_widget();
  }
});

async function loadLocalTestConfig() {
  try {
    const response = await fetch('local-config.json', { cache: 'no-store' });
    if (response.ok) return await response.json();
  } catch (_) { /* use public defaults */ }
  return DEFAULT_CONFIG;
}

function init_widget(userConfig) {
  initialized = true;
  config = mergeConfig(DEFAULT_CONFIG, userConfig || {});
  normalizeConfig(config);
  applyTheme();
  loadFeeds();
}

function start_widget() {
  isActive = true;
  if (!initialized) {
    config = structuredCloneSafe(DEFAULT_CONFIG);
    normalizeConfig(config);
    applyTheme();
  }
  if (!items.length) loadFeeds();
  startRefreshTimer();
  restartRotation();
}

function stop_widget() {
  isActive = false;
  clearTimers();
}

function loadFeeds() {
  if (!loadPromise) {
    loadPromise = performLoadFeeds().finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

async function performLoadFeeds() {
  const generation = ++loadGeneration;
  el.slide?.classList.add('is-loading');
  hideStatus();

  const feeds = (config.feeds || []).filter(f => f && f.enabled !== false && String(f.url || '').trim());
  if (!feeds.length) {
    items = [];
    clearTimers();
    showEmpty();
    return;
  }

  const results = await Promise.all(feeds.map((feed, feedIndex) => loadSingleFeed(feed, feedIndex)));
  if (generation !== loadGeneration) return;

  const errors = [];
  let merged = [];
  for (const result of results) {
    if (result.error) errors.push(`${result.label}: ${result.error}`);
    merged.push(...result.items);
  }

  if (config.sort_order === 'newest') {
    merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  } else {
    merged.sort((a, b) => (a.feedIndex - b.feedIndex) || (a.itemIndex - b.itemIndex));
  }
  merged = merged.slice(0, clampInt(config.max_total_items, 1, 100, 12));

  const needsArticleImages = merged.some(item => (item.feed.image_source || 'auto').toLowerCase() === 'article');
  if (config.show_image && (config.article_image_fallback || needsArticleImages)) {
    await enrichMissingImages(merged, generation);
    if (generation !== loadGeneration) return;
  }

  items = merged;
  currentIndex = Math.min(currentIndex, Math.max(0, items.length - 1));
  el.slide?.classList.remove('is-loading');

  if (!items.length) {
    clearTimers();
    showEmpty();
    if (errors.length) console.warn('RSS feed errors:', errors);
    return;
  }

  renderItem(items[currentIndex], false);
  restartRotation();

  if (errors.length) console.warn('RSS feed errors:', errors);
}

async function loadSingleFeed(rawFeed, feedIndex) {
  const feed = normalizeFeed(rawFeed);
  const label = feed.label || hostnameFromUrl(feed.url) || `Feed ${feedIndex + 1}`;
  try {
    const xmlText = await fetchDecodedText(feed.url, 15000);
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const parserError = doc.querySelector('parsererror');
    if (parserError) throw new Error('XML konnte nicht geparst werden');

    const channelTitle = directChildText(doc.querySelector('channel'), 'title') || label;
    const itemNodes = Array.from(doc.getElementsByTagName('item'));
    const nodes = itemNodes.length ? itemNodes : Array.from(doc.getElementsByTagNameNS('*', 'entry'));
    const maxItems = clampInt(config.max_items_per_feed, 1, 50, 5);
    const parsed = nodes
      .map((node, itemIndex) => parseItem(node, feed, feedIndex, itemIndex, channelTitle))
      .filter(Boolean)
      .filter(item => isWithinMaxAge(item, feed.max_age_days))
      .slice(0, maxItems);

    return { label, items: parsed, error: null };
  } catch (err) {
    return { label, items: [], error: humanError(err) };
  }
}

function parseItem(node, feed, feedIndex, itemIndex, channelTitle) {
  const title = childTextByLocalName(node, 'title');
  const link = itemLink(node);
  const pubDate = childTextByLocalName(node, 'pubDate')
    || childTextByLocalName(node, 'date')
    || childTextByLocalName(node, 'published')
    || childTextByLocalName(node, 'updated');
  const descriptionHtml = childTextByLocalName(node, 'description') || childTextByLocalName(node, 'summary');
  const contentHtml = childTextByLocalName(node, 'encoded');
  const author = childTextByLocalName(node, 'creator') || childTextByLocalName(node, 'author');
  const categories = childrenTextByLocalName(node, 'category');

  const profile = detectProfile(feed, channelTitle, link, contentHtml);
  const description = chooseDescription({ feed, profile, descriptionHtml, contentHtml, title });
  const image = chooseFeedImage({ node, feed, profile, descriptionHtml, contentHtml, link });
  const dateObj = parseDateSafe(pubDate);

  if (!title && !description) return null;

  return {
    title: cleanText(title),
    link: cleanText(link),
    date: dateObj,
    timestamp: dateObj ? dateObj.getTime() : 0,
    description: truncate(cleanText(description), clampInt(config.description_max_chars, 40, 3000, 1500)),
    image,
    source: feed.label || channelTitle || hostnameFromUrl(feed.url),
    heading: feed.heading || '',
    category: categories[0] || '',
    categories,
    author,
    profile,
    feed,
    feedIndex,
    itemIndex
  };
}

function chooseDescription({ feed, profile, descriptionHtml, contentHtml, title }) {
  const source = (feed.text_source || 'auto').toLowerCase();
  const selector = String(feed.text_selector || '').trim();

  if (source === 'description') return extractTextFromHtml(descriptionHtml, selector);
  if (source === 'content') return extractTextFromHtml(contentHtml, selector, profile === 'wordpress');

  if (profile === 'rwth') return extractTextFromHtml(descriptionHtml, selector);
  if (profile === 'wordpress') {
    const rich = extractTextFromHtml(contentHtml, selector || 'strong', true);
    if (rich && !looksLikeBoilerplate(rich, title)) return rich;
    return extractMeaningfulParagraph(contentHtml, title);
  }

  const desc = extractTextFromHtml(descriptionHtml, selector);
  if (desc && !looksLikeBoilerplate(desc, title)) return desc;
  const rich = extractTextFromHtml(contentHtml, selector, false);
  if (rich && !looksLikeBoilerplate(rich, title)) return rich;
  return extractMeaningfulParagraph(contentHtml || descriptionHtml, title);
}

function chooseFeedImage({ node, feed, descriptionHtml, contentHtml, link }) {
  const mode = (feed.image_source || 'auto').toLowerCase();
  const selector = String(feed.image_selector || '').trim();
  if (mode === 'none') return '';

  if (mode === 'description') return imageFromHtml(descriptionHtml, selector, link);
  if (mode === 'content') return imageFromHtml(contentHtml, selector, link);
  if (mode === 'feed') return imageFromRssNode(node, link);
  if (mode === 'article') return '';

  return imageFromRssNode(node, link)
    || imageFromHtml(contentHtml, selector, link)
    || imageFromHtml(descriptionHtml, selector, link)
    || '';
}

async function enrichMissingImages(list, generation) {
  const targets = list.filter(item => {
    const mode = (item.feed.image_source || 'auto').toLowerCase();
    return !item.image && item.link && mode !== 'none' && (mode === 'article' || config.article_image_fallback);
  });
  const concurrency = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      if (generation !== loadGeneration) return;
      try {
        item.image = await fetchArticleImage(item.link, item.feed.image_selector || '');
      } catch (_) { /* optional */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
}

async function fetchArticleImage(url, selector) {
  const htmlText = await fetchDecodedText(url, 10000);
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  let candidate = '';

  if (selector) {
    const selected = safeQuerySelector(doc, selector);
    if (selected) candidate = imageUrlFromElement(selected);
  }
  candidate = candidate
    || doc.querySelector('meta[property="og:image"]')?.getAttribute('content')
    || doc.querySelector('meta[property="og:image:url"]')?.getAttribute('content')
    || doc.querySelector('meta[property="og:image:secure_url"]')?.getAttribute('content')
    || doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content')
    || doc.querySelector('link[rel="image_src"]')?.getAttribute('href')
    || imageUrlFromElement(doc.querySelector('main img'))
    || imageUrlFromElement(doc.querySelector('article img'))
    || '';

  return absolutizeUrl(candidate, url);
}

function extractTextFromHtml(htmlString, selector = '', preferStrong = false) {
  if (!htmlString) return '';
  const doc = new DOMParser().parseFromString(String(htmlString), 'text/html');
  doc.querySelectorAll('script,style,noscript,svg').forEach(n => n.remove());

  if (selector) {
    const selected = safeQuerySelector(doc, selector);
    if (selected) return cleanText(selected.textContent);
  }

  if (preferStrong) {
    const strongs = Array.from(doc.querySelectorAll('strong'));
    const strong = strongs.find(n => cleanText(n.textContent).length >= 50);
    if (strong) return cleanText(strong.textContent);
  }
  return cleanText(doc.body?.textContent || htmlString);
}

function extractMeaningfulParagraph(htmlString, title = '') {
  if (!htmlString) return '';
  const doc = new DOMParser().parseFromString(String(htmlString), 'text/html');
  const candidates = [
    ...doc.querySelectorAll('strong'),
    ...doc.querySelectorAll('.et_pb_text_inner p'),
    ...doc.querySelectorAll('p')
  ];
  for (const node of candidates) {
    const text = cleanText(node.textContent);
    if (text.length >= 60 && text.length <= 1400 && !looksLikeBoilerplate(text, title)) return text;
  }
  return '';
}

function looksLikeBoilerplate(text, title = '') {
  const t = cleanText(text).toLowerCase();
  const ttl = cleanText(title).toLowerCase();
  if (!t) return true;
  if (t.includes('erschien zuerst auf')) return true;
  if (t.startsWith('der beitrag ') && ttl && t.includes(ttl.slice(0, Math.min(40, ttl.length)))) return true;
  if (t === ttl) return true;
  return false;
}

function imageFromRssNode(node, baseUrl) {
  const all = Array.from(node.getElementsByTagName('*'));
  for (const n of all) {
    const local = (n.localName || n.nodeName || '').toLowerCase();
    if (local === 'content' || local === 'thumbnail') {
      const url = n.getAttribute?.('url') || n.getAttribute?.('href');
      const type = n.getAttribute?.('type') || '';
      const medium = n.getAttribute?.('medium') || '';
      if (url && (!type || type.startsWith('image/') || medium === 'image' || looksLikeImageUrl(url))) {
        return absolutizeUrl(url, baseUrl);
      }
    }
    if (local === 'enclosure') {
      const url = n.getAttribute?.('url') || n.getAttribute?.('href');
      const type = n.getAttribute?.('type') || '';
      if (url && (type.startsWith('image/') || (!type && looksLikeImageUrl(url)))) {
        return absolutizeUrl(url, baseUrl);
      }
    }
    if (local === 'image') {
      const url = n.getAttribute?.('href') || n.getAttribute?.('url') || cleanText(n.textContent);
      if (url) return absolutizeUrl(url, baseUrl);
    }
    if (local === 'link') {
      const rel = (n.getAttribute?.('rel') || '').toLowerCase();
      const type = (n.getAttribute?.('type') || '').toLowerCase();
      const url = n.getAttribute?.('href') || '';
      if (url && (rel === 'enclosure' || rel === 'image') && (type.startsWith('image/') || looksLikeImageUrl(url))) {
        return absolutizeUrl(url, baseUrl);
      }
    }
  }
  return '';
}

function imageFromHtml(htmlString, selector = '', baseUrl = '') {
  if (!htmlString) return '';
  const doc = new DOMParser().parseFromString(String(htmlString), 'text/html');
  let node = null;
  if (selector) node = safeQuerySelector(doc, selector);
  if (!node) node = doc.querySelector('img');
  if (!node) return '';
  const src = imageUrlFromElement(node);
  return absolutizeUrl(src, baseUrl);
}

function imageUrlFromElement(node) {
  if (!node) return '';
  const direct = node.getAttribute?.('src')
    || node.getAttribute?.('data-src')
    || node.getAttribute?.('data-lazy-src')
    || node.getAttribute?.('data-original')
    || node.getAttribute?.('data-url')
    || node.getAttribute?.('content')
    || node.getAttribute?.('href')
    || '';
  if (direct && !/^data:image\/gif/i.test(direct)) return direct;

  const srcset = node.getAttribute?.('srcset') || node.getAttribute?.('data-srcset') || '';
  if (!srcset) return direct;
  const candidates = srcset.split(',').map(part => {
    const match = part.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);
    return match ? { url: match[1], size: Number(match[2]) || 1 } : null;
  }).filter(Boolean);
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0]?.url || direct;
}

function looksLikeImageUrl(value) {
  const url = String(value || '').split(/[?#]/, 1)[0];
  return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(url)
    || /(?:image|img|photo|thumbnail|featured)/i.test(String(value || ''));
}

function renderItem(item, animate = true) {
  if (!item) return;
  hideStatus();

  const doRender = () => {
    document.body.classList.toggle('no-image', !config.show_image || !item.image);

    const headerText = item.heading || item.source || 'RSS';
    el.headerTitle.textContent = headerText;

    el.source.hidden = true;
    el.source.textContent = item.source || '';

    el.category.hidden = !config.show_category || !item.category;
    el.category.textContent = item.category || '';

    el.date.hidden = !config.show_date || !item.date;
    el.date.textContent = item.date ? formatDate(item.date, config.date_format) : '';

    el.title.hidden = !config.show_title || !item.title;
    el.title.textContent = item.title || '';
    el.title.classList.remove('is-long-title');

    el.description.hidden = !config.show_description || !item.description;
    el.description.textContent = item.description || '';
    el.descriptionViewport.hidden = el.description.hidden;
    setupDescriptionScroll();

    renderQr(item);

    if (config.show_image && item.image) {
      el.media.classList.remove('has-image');
      el.image.alt = item.title || '';
      el.image.onload = () => el.media.classList.add('has-image');
      el.image.onerror = () => el.media.classList.remove('has-image');
      el.image.src = localAssetUrl(item.image);
      if (el.image.complete && el.image.naturalWidth) el.media.classList.add('has-image');
    } else {
      el.image.removeAttribute('src');
      el.media.classList.remove('has-image');
    }

    el.slide.classList.remove('is-transitioning');
    startProgress();
  };

  if (animate) {
    el.slide.classList.add('is-transitioning');
    setTimeout(doRender, 320);
  } else {
    doRender();
  }
}

function setupDescriptionScroll() {
  if (!el.description || !el.descriptionViewport || el.description.hidden) return;
  el.description.classList.remove('is-scrolling');
  el.description.style.removeProperty('--scroll-distance');
  el.description.style.removeProperty('--scroll-duration');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const distance = Math.ceil(el.description.scrollHeight - el.descriptionViewport.clientHeight);
    if (distance <= 2) return;
    el.description.style.setProperty('--scroll-distance', `${distance}px`);
    el.description.style.setProperty('--scroll-duration', `${Math.max(10, distance / 18).toFixed(1)}s`);
    el.description.classList.add('is-scrolling');
  }));
}

function localAssetUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return LOCAL_TEST && /^https?:\/\//i.test(value)
    ? `/proxy?url=${encodeURIComponent(value)}`
    : value;
}

function renderQr(item) {
  if (!el.qrBox || !el.qrImage) return;
  const shouldShow = !!(config.show_qr && item?.link);
  el.qrBox.hidden = !shouldShow;
  if (!shouldShow) {
    el.qrBox.removeAttribute('href');
    el.qrImage.removeAttribute('src');
    return;
  }
  const size = 112;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=0&data=${encodeURIComponent(item.link)}`;
  el.qrBox.href = item.link;
  el.qrImage.src = qrUrl;
}

function nextItem() {
  if (!items.length) return;
  currentIndex = (currentIndex + 1) % items.length;
  renderItem(items[currentIndex], true);
}

function restartRotation() {
  if (rotationTimer) clearInterval(rotationTimer);
  cancelAnimationFrame(progressFrame);
  if (!isActive || items.length <= 1) {
    if (items.length) startProgress(false);
    return;
  }
  const ms = clampInt(config.rotation_seconds, 3, 600, 12) * 1000;
  rotationTimer = setInterval(nextItem, ms);
  startProgress();
}

function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (!isActive) return;
  const ms = clampInt(config.refresh_minutes, 1, 1440, 15) * 60 * 1000;
  refreshTimer = setInterval(loadFeeds, ms);
}

function startProgress(animate = true) {
  cancelAnimationFrame(progressFrame);
  if (!el.progressBar) return;
  if (!animate || !isActive || items.length <= 1) {
    el.progressBar.style.width = '0%';
    return;
  }
  const duration = clampInt(config.rotation_seconds, 3, 600, 12) * 1000;
  startedAt = performance.now();
  const frame = now => {
    const pct = Math.min(100, ((now - startedAt) / duration) * 100);
    el.progressBar.style.width = `${pct}%`;
    if (pct < 100 && isActive) progressFrame = requestAnimationFrame(frame);
  };
  progressFrame = requestAnimationFrame(frame);
}

function clearTimers() {
  if (rotationTimer) clearInterval(rotationTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  cancelAnimationFrame(progressFrame);
  rotationTimer = refreshTimer = progressFrame = null;
}

function applyTheme() {
  const root = document.documentElement;
  root.style.setProperty('--bg', normalizeColor(config.background_color, DEFAULT_CONFIG.background_color));
  root.style.setProperty('--surface', normalizeColor(config.surface_color, DEFAULT_CONFIG.surface_color));
  root.style.setProperty('--text', normalizeColor(config.text_color, DEFAULT_CONFIG.text_color));
  root.style.setProperty('--muted', normalizeColor(config.muted_color, DEFAULT_CONFIG.muted_color));
  root.style.setProperty('--accent', normalizeColor(config.accent_color, DEFAULT_CONFIG.accent_color));
  document.body.classList.remove('layout-split', 'layout-text', 'layout-overlay');
  document.body.classList.add(`layout-${['split','text','overlay'].includes(config.layout) ? config.layout : 'split'}`);
  if (el.image) el.image.style.objectFit = config.image_fit === 'contain' ? 'contain' : 'cover';
}

function showEmpty() {
  document.body.classList.add('is-empty');
  if (el.status) el.status.hidden = true;
  if (el.slide) el.slide.hidden = true;
}

function hideStatus() {
  document.body.classList.remove('is-empty');
  if (!el.status) return;
  el.status.hidden = true;
  if (el.slide) el.slide.hidden = false;
}

async function fetchDecodedText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestUrl = LOCAL_TEST && /^https?:\/\//i.test(String(url || ''))
      ? `/proxy?url=${encodeURIComponent(url)}`
      : url;
    const response = await fetch(requestUrl, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || '';
    const charsetMatch = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
    const hinted = charsetMatch?.[1];
    return decodeBuffer(buffer, hinted);
  } finally {
    clearTimeout(timer);
  }
}

function decodeBuffer(buffer, hintedCharset) {
  const labels = [];
  if (hintedCharset) labels.push(hintedCharset);
  labels.push('utf-8', 'windows-1252');
  for (const label of [...new Set(labels)]) {
    try {
      return new TextDecoder(label, { fatal: label.toLowerCase() === 'utf-8' }).decode(buffer);
    } catch (_) { /* next */ }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

function detectProfile(feed, channelTitle, link, contentHtml) {
  const explicit = normalizeProfile(feed.profile);
  if (explicit !== 'auto') return explicit;
  const hay = `${feed.url} ${channelTitle} ${link}`.toLowerCase();
  if (hay.includes('wp-content') || /\/feed(?:\/|$|\?)/i.test(feed.url) || (contentHtml && /(?:wp-|et_pb_)/i.test(contentHtml))) return 'wordpress';
  if (hay.includes('rwth-aachen.de')) return 'rwth';
  return 'standard';
}

function normalizeProfile(value) {
  const profile = String(value || 'auto').toLowerCase();
  return ['auto', 'rwth', 'wordpress', 'standard'].includes(profile) ? profile : 'auto';
}

function normalizeFeed(feed) {
  return {
    enabled: feed.enabled !== false,
    label: String(feed.label || '').trim(),
    heading: String(feed.heading || '').trim(),
    url: String(feed.url || '').trim(),
    profile: normalizeProfile(feed.profile),
    max_age_days: clampInt(feed.max_age_days, 0, 3650, 0),
    text_source: String(feed.text_source || 'auto').toLowerCase(),
    text_selector: String(feed.text_selector || '').trim(),
    image_source: String(feed.image_source || 'auto').toLowerCase(),
    image_selector: String(feed.image_selector || '').trim()
  };
}

function normalizeConfig(c) {
  if (!Array.isArray(c.feeds)) c.feeds = structuredCloneSafe(DEFAULT_CONFIG.feeds);
  c.feeds = c.feeds.map(normalizeFeed);
  c.layout = String(c.layout || 'split').toLowerCase();
  c.sort_order = String(c.sort_order || 'newest').toLowerCase();
  c.date_format = String(c.date_format || 'date').toLowerCase();
  c.image_fit = String(c.image_fit || 'cover').toLowerCase();
}

function mergeConfig(base, extra) {
  const out = structuredCloneSafe(base);
  if (!extra || typeof extra !== 'object') return out;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function childTextByLocalName(parent, localName) {
  if (!parent) return '';
  for (const child of Array.from(parent.children || [])) {
    if ((child.localName || child.nodeName).toLowerCase() === localName.toLowerCase()) return child.textContent || '';
  }
  for (const child of Array.from(parent.getElementsByTagName('*'))) {
    if ((child.localName || child.nodeName).toLowerCase() === localName.toLowerCase()) return child.textContent || '';
  }
  return '';
}

function childrenTextByLocalName(parent, localName) {
  const out = [];
  for (const child of Array.from(parent.children || [])) {
    if ((child.localName || child.nodeName).toLowerCase() === localName.toLowerCase()) {
      const value = cleanText(child.textContent);
      if (value) out.push(value);
    }
  }
  return out;
}

function directChildText(parent, name) {
  if (!parent) return '';
  const lower = name.toLowerCase();
  const node = Array.from(parent.children || []).find(n => (n.localName || n.nodeName).toLowerCase() === lower);
  return node?.textContent || '';
}

function itemLink(node) {
  if (!node) return '';
  const links = Array.from(node.children || []).filter(child => {
    return (child.localName || child.nodeName || '').toLowerCase() === 'link';
  });
  const preferred = links.find(link => {
    const rel = (link.getAttribute?.('rel') || 'alternate').toLowerCase();
    return rel === 'alternate';
  }) || links[0];
  return cleanText(preferred?.getAttribute?.('href') || preferred?.textContent || childTextByLocalName(node, 'guid'));
}

function safeQuerySelector(root, selector) {
  try { return root.querySelector(selector); }
  catch (_) { return null; }
}

function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > maxChars * .75 ? lastSpace : maxChars).trim()}…`;
}

function parseDateSafe(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinMaxAge(item, maxAgeDays) {
  const days = clampInt(maxAgeDays, 0, 3650, 0);
  if (days <= 0) return true;
  if (!item.date || !Number.isFinite(item.timestamp) || item.timestamp <= 0) return false;
  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  return item.timestamp >= Date.now() - maxAgeMs;
}

function formatDate(date, mode) {
  const options = mode === 'datetime'
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' };
  try { return new Intl.DateTimeFormat('de-DE', options).format(date); }
  catch (_) { return date.toLocaleDateString(); }
}

function absolutizeUrl(url, baseUrl) {
  const value = String(url || '').trim();
  if (!value) return '';
  try { return new URL(value, baseUrl || location.href).href; }
  catch (_) { return value; }
}

function hostnameFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return ''; }
}

function normalizeColor(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) return `#${v}`;
  return v;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function humanError(err) {
  if (err?.name === 'AbortError') return 'Zeitüberschreitung beim Abruf';
  return err?.message || String(err);
}

window.init_widget = init_widget;
window.start_widget = start_widget;
window.stop_widget = stop_widget;
