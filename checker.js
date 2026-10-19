// Pokemon TCG AU Stock Watcher.
// - NEW LISTINGS: alerts on any new Pokemon sealed product at any tracked
//   store, whatever the set is called (so brand-new sets are caught the
//   moment a store lists them, without needing the set name first).
// - BACK IN STOCK: alerts for items from sets in config.json "activeSets",
//   plus any item this bot first saw within the last HOT_DAYS days.
// - No price-drop alerts. Singles, graded cards, events/tickets, other
//   trading card games and accessories are filtered out.
// Checks all targets in PARALLEL - each target is a different website.

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// Playwright is optional – only loaded when a target needs it
let playwright = null;
try {
  playwright = require("playwright");
} catch (e) {
  console.warn("Playwright not installed – hard sites will fall back to normal fetch");
}

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const ALERTS_LOG_PATH = path.join(__dirname, "docs", "alerts-log.json");
const MAX_LOG_ENTRIES = 300;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TEST_ALERT = process.env.TEST_ALERT === "true";
const BURST_MODE = process.env.BURST_MODE === "true";
const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT !== "false"; // default on if installed

const QUIET_HOUR_START_UTC = Number(process.env.QUIET_HOUR_START_UTC ?? 14);
const QUIET_HOUR_END_UTC = Number(process.env.QUIET_HOUR_END_UTC ?? 21);

const COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_DELAY_MS = 3000;

const POSITIVE_SIGNALS = [
  "add to cart", "add to bag", "buy now", "add to basket", "in stock",
  "add to trolley", "available for delivery", "available online", "ready to ship",
  "click and collect", "pick up in store", "available in store"
];

const NEGATIVE_SIGNALS = [
  "sold out", "notify me", "out of stock", "coming soon", "unavailable",
  "no delivery options", "no in-store options", "currently unavailable",
  "email when available", "notify when available", "join waitlist",
  "pre-order only", "not available", "temporarily unavailable", "backorder"
];

const PRIORITY_KEYWORDS = [
  "elite trainer box",
  "elite trainer",
  "etb",
  "booster box",
  "ultra-premium",
  "ultra premium",
  "ultra premium collection",
  "upc",
];

// Instead of listing every known sealed-product name (fragile - misses
// future product types), this detects what looks like a SINGLE CARD and
// excludes only those. Singles reliably have a card number like "025/030"
// or mention a grading service - sealed product never does, regardless of
// what new box/tin/case name gets invented for a future set.
const SINGLE_CARD_EXCLUDE_PATTERNS = [
  // Card numbers: 025/030, GG21/GG70, TG03/TG30, SWSH176/307, etc.
  /(?:^|[^A-Za-z0-9])[A-Z]{0,4}\d{1,3}\s*\/\s*[A-Z]{0,4}\d{1,3}(?!\d)/i,
  // Promo / set codes without slash: SM195, XY28, SWSH176, SVP085, BW45, HGSS12
  /\b(swsh|svp|smp|xyp|bwp|hgss|dpp|sm|xy|bw|dp|pl|sv|sv\d?[a-z]?-?p|xy-?p|sm-?p)\s*-?\s*\d{1,3}\b/i,
  // Any standalone "promo" (covers "XY PROMO", "POKEMON PROMO HOLO", "BLACK STAR PROMOS")
  /\bpromos?\b/i,
  /\bblack\s*star\s*promo/i,
  /\bpsa\b/i,
  /\bbgs\b/i,
  /\bcgc\b/i,
  /\bsingle card\b/i,
  /\bsingles\b/i,
  /\b\d{1,3}\s+promo\b/i,
  /\b(reverse holo|full art|alt art|illustration rare|special illustration|secret rare)\b/i,
  /\bsingle pack\b/i,
  // Energy cards
  /\b(basic|special|double|holo)?\s*(fighting|fire|water|grass|lightning|psychic|darkness|metal|fairy|dragon|colorless)\s+energy\b/i,
  /\benergy\s*-\s*\d{1,3}\b/i,
  /\benergy\s+\d{1,3}\b/i,
  // Generic single-card style: "Card Name - 123 (123)" or "Card Name - 006 (6)"
  /\s-\s*\d{1,3}\s*\(\d{1,3}\)\s*$/,
  // Condition grades typical of singles listings (not sealed product)
  /\b(nm\/m|nm-mt|near mint|lightly played|moderately played|heavily played)\b/i,
  /\b(trainer gallery|galarian gallery|crown zenith gallery)\b/i,
  /\bholo\s+(nm\/m|lp|mp|hp|dmg)\b/i,
  // Trailing condition codes: "HOLO LP", "HOLO HP", " PROMO MP"
  /\b(holo\s+)?(lp|mp|hp|dmg|nm)\s*$/i,
  // EX/GX/V/VMAX single with set code pattern e.g. "CHARIZARD GX - SM195"
  /\b(ex|gx|v|vmax|vstar)\b.*\b(sm|xy|swsh|bw|sv)\s*-?\s*\d{2,3}\b/i,
];

// Store-card naming: "POKEMON Magikarp - ME: 30th Celebration Classic Collection (30C)"
// is one card named after its set. If the text before " - ME:" has no sealed
// product word, it is a single card.
// Note: bare "binder" is NOT included — empty binders/accessories are not sealed.
// Official "Binder Collection" products still match via "collection".
const SEALED_WORDS = /\b(box|bundle|pack|packs|tin|tins|collection|display|case|blister|deck|set|trainer|booster|premium|pouch|chest|stacking)\b/i;
function looksLikeSetNamedCard(name) {
  const m = name.match(/^(.*?)\s+-\s*ME:\s/i);
  return !!m && !SEALED_WORDS.test(m[1]);
}

// "Bundle" alone (e.g. "Pokémon TCG - Bundle - M6a 30th Celebration - EN") is
// a loose set of cards, not a sealed Booster Bundle.
function isCardBundle(name) {
  if (!/\bbundle\b/i.test(name)) return false;
  return !/booster\s+bundle|bundle\s+(box|display|case)|\bdisplay\b|\bcase\b|elite trainer|\betb\b/i.test(name);
}

// Only English and Japanese product is wanted (Chinese/KR/etc excluded).
const OTHER_LANGUAGE_PATTERN = /\b(chinese|simplified|traditional|korean|thai|indonesian|german|french|italian|spanish|portuguese|s-chinese|t-chinese)\b|[\[(]\s*(cn|zh|kr|th|id|de|fr|it|es|pt)\s*[\])]|\s-\s(cn|kr|th)\s*$/i;

function isJapaneseProduct(name) {
  // Broad detection: language tags, set codes, and common JP naming
  return (
    /\b(japanese|\bjp\b|\[jp\]|\(jp\)|jpn)\b/i.test(name) ||
    /\s-\s*jp\s*$/i.test(name) ||
    /[\[(]\s*jp\s*[\])]/i.test(name) ||
    /\b(s-chinese|chinese)\b/i.test(name) === false && /\b(sv\d+[a-z]?|m\d+[a-z]?)\b.*\b(jp|japanese)\b/i.test(name)
  );
}

// Japanese sealed product — AU specialty "fair buy" references (AUD).
// These are lower than English RRP because JP is import-priced, not
// official AU RRP. First match wins. Keep extensive so alerts are
// trustworthy at a glance for every common sealed type.
const JP_PRICE_CAPS = [
  // Cases / master cases
  { pattern: "\\b(master\\s*)?case\\b", max: 900 },
  // Booster boxes & displays
  { pattern: "\\b(display|booster\\s*box|bb)\\b", max: 160 },
  // Ultra / premium high-end
  { pattern: "ultra[- ]premium|\\bupc\\b", max: 180 },
  { pattern: "special\\s*collection|premium\\s*collection", max: 90 },
  // Trainer products
  { pattern: "elite\\s*trainer|\\betb\\b", max: 85 },
  { pattern: "trainer\\s*box|trainer'?s?\\s*toolkit", max: 70 },
  // Build & Battle / VSTAR / League decks
  { pattern: "build\\s*&\\s*battle|build\\s*and\\s*battle", max: 45 },
  { pattern: "league\\s*battle\\s*deck|vstar\\s*league|battle\\s*deck", max: 45 },
  { pattern: "\\btheme\\s*deck\\b|\\bcombat\\s*deck\\b", max: 35 },
  // Bundles
  { pattern: "\\bbooster\\s*bundle\\b", max: 42 },
  { pattern: "\\bbundle\\b", max: 40 },
  // Tins
  { pattern: "mini\\s*tin|tin\\s*display", max: 55 },
  { pattern: "\\btin\\b", max: 35 },
  // Blisters / packs
  { pattern: "3\\s*-?\\s*pack|triple\\s*pack|3pack", max: 22 },
  { pattern: "2\\s*-?\\s*pack|double\\s*pack|2pack", max: 16 },
  { pattern: "checklane|\\bblister\\b", max: 12 },
  { pattern: "sleeved\\s*booster|\\bbooster\\s*pack\\b|\\bpack\\b", max: 8 },
  // Collections & miscellaneous sealed
  { pattern: "illustration\\s*collection|poster\\s*collection|binder\\s*collection", max: 55 },
  { pattern: "tech\\s*sticker| techn?ical\\s*sticker", max: 40 },
  { pattern: "collection", max: 70 },
  { pattern: "\\bdeck\\b", max: 40 },
  { pattern: "\\bchest\\b|\\bcollapse\\b|\\bstacking\\b", max: 80 },
  { pattern: "\\balbum\\b|\\bbinder\\b", max: 35 },
];
const JP_DEFAULT_PRICE_CAP = 55;

// Retail filter: each product type has a reference retail price (AUD). An
// item is alerted if its price is within retail + TOLERANCE (default 30%);
// items between retail and that limit get a "% over retail" tag. Anything
// above the limit is treated as reseller pricing and ignored. First match
// wins. Change the tolerance with "priceTolerance": 0.5 in config.json (0 =
// retail only), extend with "priceCaps": [{"pattern": "...", "max": 123}],
// or set "noPriceCap": true to switch the filter off.
// Approximate Australian RRP reference prices (AUD). First match wins.
// These are used both for the "(RRP ~$X)" note and to filter out
// heavily overpriced reseller listings.
const DEFAULT_PRICE_CAPS = [
  { pattern: "\\b(master\\s*)?case\\b", max: 1600 },      // Booster box case (~6 boxes)
  { pattern: "\\b(display|booster\\s*box)\\b", max: 250 }, // Standard EN booster box
  { pattern: "ultra[- ]premium|\\bupc\\b", max: 280 },    // UPC
  { pattern: "elite\\s*trainer|\\betb\\b", max: 110 },    // ETB
  { pattern: "trainer\\s*box|trainer'?s?\\s*toolkit", max: 90 },
  { pattern: "build\\s*&\\s*battle|build\\s*and\\s*battle", max: 55 },
  { pattern: "league\\s*battle\\s*deck|vstar\\s*league|battle\\s*deck", max: 50 },
  { pattern: "\\btheme\\s*deck\\b", max: 35 },
  { pattern: "\\bbooster\\s*bundle\\b", max: 55 },
  { pattern: "\\bbundle\\b", max: 55 },
  { pattern: "mini\\s*tin|tin\\s*display", max: 70 },
  { pattern: "\\btin\\b", max: 45 },
  { pattern: "3\\s*-?\\s*pack|triple\\s*pack", max: 25 },
  { pattern: "2\\s*-?\\s*pack|2pk|double\\s*pack|enhanced\\s*2", max: 20 },
  { pattern: "checklane|\\bblister\\b", max: 15 },
  { pattern: "sleeved\\s*booster|\\bbooster\\s*pack\\b|\\bpack\\b", max: 8 },
  { pattern: "illustration\\s*collection|poster\\s*collection|binder\\s*collection", max: 70 },
  { pattern: "premium\\s*collection|special\\s*collection", max: 100 },
  { pattern: "collection", max: 90 },
  { pattern: "\\bposter\\b|\\balbum\\b|\\bbinder\\b", max: 40 },
  { pattern: "\\bdeck\\b", max: 50 },
];
const DEFAULT_PRICE_CAP = 80; // safer default for unknown sealed product types
const DEFAULT_PRICE_TOLERANCE = 0.15; // max 15% over reference retail by default
let activePriceCaps = DEFAULT_PRICE_CAPS;
let priceTolerance = DEFAULT_PRICE_TOLERANCE;
let priceCapsDisabled = false;

// ---- Monthly retail-price self-check -------------------------------------
// Every run, each sealed Pokemon item seen (price known) is sampled. Once a
// month the bot takes the low-end price (30th percentile, so reseller
// markups don't drag it up) per product type across all stores, nudges the
// reference retail price toward it (max 20% change, rounded to $5), and
// tells you on Telegram what changed.
const CALIB_DAYS = 30;
const CALIB_MIN_SAMPLES = 15;
const CALIB_MAX_STEP = 0.2;
let priceSamples = [];

function recordPriceSample(name, priceStr) {
  const price = parsePrice(priceStr);
  if (price !== null && price > 0) priceSamples.push({ name, price });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function computeCalibration(samples, caps) {
  const changes = [];
  const buckets = caps.map(() => []);
  for (const smp of samples) {
    const i = caps.findIndex((c) => new RegExp(c.pattern, "i").test(smp.name));
    if (i === -1) continue;
    const ref = caps[i].max;
    if (smp.price >= ref * 0.4 && smp.price <= ref * 3) buckets[i].push(smp.price);
  }
  caps.forEach((cap, i) => {
    const prices = buckets[i].sort((a, b) => a - b);
    if (prices.length < CALIB_MIN_SAMPLES) return;
    const target = percentile(prices, 0.3);
    const lo = cap.max * (1 - CALIB_MAX_STEP);
    const hi = cap.max * (1 + CALIB_MAX_STEP);
    const stepped = Math.min(hi, Math.max(lo, target));
    const next = Math.max(5, Math.round(stepped / 5) * 5);
    if (next !== cap.max) changes.push({ pattern: cap.pattern, from: cap.max, to: next, samples: prices.length });
  });
  return changes;
}

const CAP_LABELS = {
  "\\bcase\\b": "Case",
  "\\b(display|booster box)\\b": "Booster box/display",
  "ultra[- ]premium": "Ultra-Premium",
  "elite trainer|\\betb\\b": "ETB",
  "build\\s*&\\s*battle|build and battle": "Build & Battle",
  "\\bbooster bundle\\b|\\bbundle\\b": "Booster bundle",
  "\\btin\\b": "Tin",
  "checklane|\\bblister\\b": "Checklane/blister",
  "\\bbooster pack\\b|\\bpack\\b": "Single pack",
  "collection|premium collection": "Collection",
};

async function maybeCalibratePrices(state, config) {
  const now = Date.now();
  const last = state.priceCalib && Date.parse(state.priceCalib.last);
  if (!last || isNaN(last)) {
    state.priceCalib = { last: new Date(now).toISOString() }; // start the 30-day clock
    return;
  }
  if (now - last < CALIB_DAYS * 24 * 60 * 60 * 1000) return;
  if (config && config.autoCalibratePrices === false) return;
  const changes = computeCalibration(priceSamples, activePriceCaps.filter((c) => CAP_LABELS[c.pattern]));
  state.priceRefs = state.priceRefs || {};
  for (const ch of changes) state.priceRefs[ch.pattern] = ch.to;
  state.priceCalib = { last: new Date(now).toISOString() };
  setPriceCaps(config, state);
  const lines = changes.map((c) => `• ${CAP_LABELS[c.pattern]}: $${c.from} → $${c.to} (${c.samples} prices)`);
  const msg = changes.length
    ? `📊 <b>Monthly retail price check</b>\nAdjusted reference prices from what stores are charging:\n${lines.join("\n")}\n\nTolerance still applies on top. Tell Claude if any look wrong.`
    : "📊 <b>Monthly retail price check</b>\nReference retail prices still look right - no changes.";
  await sendTelegram(msg);
}

function setPriceCaps(config, state) {
  const custom = Array.isArray(config && config.priceCaps) ? config.priceCaps : null;
  const learned = (state && state.priceRefs) || {};
  const base = DEFAULT_PRICE_CAPS.map((c) => ({ pattern: c.pattern, max: typeof learned[c.pattern] === "number" ? learned[c.pattern] : c.max }));
  activePriceCaps = custom && custom.length ? custom.concat(base) : base;
  const tol = config && Number(config.priceTolerance);
  priceTolerance = config && config.priceTolerance !== undefined && !isNaN(tol) && tol >= 0 ? tol : DEFAULT_PRICE_TOLERANCE;
  priceCapsDisabled = !!(config && config.noPriceCap);
}

function retailRef(name) {
  const caps = isJapaneseProduct(name) ? JP_PRICE_CAPS : activePriceCaps;
  const fallback = isJapaneseProduct(name) ? JP_DEFAULT_PRICE_CAP : DEFAULT_PRICE_CAP;
  for (const cap of caps) {
    if (new RegExp(cap.pattern, "i").test(name)) return cap.max;
  }
  return fallback;
}

function isOverRetailPrice(name, priceStr) {
  const price = parsePrice(priceStr);
  if (price === null) return false;
  return price > retailRef(name) * (1 + priceTolerance);
}

// "(+20% over retail)" for items above the reference price but within tolerance.
function overRetailNote(name, priceStr) {
  const price = parsePrice(priceStr);
  if (price === null || priceCapsDisabled) return "";
  const ref = retailRef(name);
  return price > ref ? ` (~+${Math.round((price / ref - 1) * 100)}% over retail)` : "";
}

// Other trading card games - a store-wide feed will contain these, and a
// title like "Gundam ... Friday 30th October" must never count as Pokemon.
const OTHER_TCG_PATTERN = new RegExp(
  "\\b(" +
    [
      "gundam", "yu-?gi-?oh", "yugioh", "magic: the gathering", "magic the gathering", "\\bmtg\\b",
      "one piece", "lorcana", "digimon", "dragon ball", "flesh and blood", "weiss",
      "union arena", "cardfight", "vanguard", "star wars unlimited", "riftbound",
      "metazoo", "naruto", "battle spirits", "final fantasy", "grand archive",
      "force of will", "shadowverse", "hololive", "duel masters", "bakugan",
      // Non-Pokemon card products that leak from pop-culture stores
      "harry potter", "panini", "topps", "upper deck", "sports cards?", "nba cards?",
      "soccer cards?", "afl cards?", "nrl cards?", "cricket cards?",
      "disney lorcana", "marvel", "fleer", "donruss",
    ].join("|") +
    ")\\b",
  "i"
);

// Events/tickets, accessories/merch, and non-TCG products (video games etc.)
const NON_PRODUCT_PATTERNS = [
  /\b(event|tournament|ticket|tickets|admission|entry fee|membership|gift card|gift voucher|voucher)\b/i,
  /\b(plush|plushie|squishmallow|funko|pop!\s*vinyl|vinyl\s*figure|figure|statue|t-?shirt|hoodie|apparel|sleeves?|toploader|top loader|playmat|play mat|deck box|deck shield|portfolio|pocket binder|card binder|mystery|keychain|pin\s*badge|badge|sticker|poster\s*only)\b/i,
  // Empty binders / binder accessories (not sealed "Binder Collection" product)
  /\baccessories\b/i,
  /\bcollector'?s?\s*binder\b/i,
  /\bultra\s*pro\b.*\bbinder\b|\bbinder\b.*\bultra\s*pro\b/i,
  /\bbinder\s*(accessories|pages|sheets)\b/i,
  // Video games / consoles / retro systems
  /\b(xbox|playstation|nintendo\s*switch|\bswitch\b|steam\s*deck|call\s*of\s*duty|modern\s*warfare|fortnite|minecraft|roblox)\b/i,
  /\b(ps5|ps4|series\s*x|series\s*s|xbox\s*one)\b/i,
  /\b(evercade|neogeo|neo-geo|tomb\s*raider|arcade\s*collection)\b/i,
  // Deposit listings are NOT fully orderable product (even real Pokemon at $10 deposit)
  /\(\s*deposit\s*\)|\bdeposit\s*only\b|\bpreorder\s*deposit\b|\bdeposit\b.*\bpre-?order\b|\bpre-?order\b.*\bdeposit\b/i,
  /\bbuy\s*\d+\s*get\s*\d+/i,
  // Board games / other hobbies
  /\b(board\s*game|lego\b|warhammer|model\s*kit)\b/i,
];

// Deposit / token preorder prices (e.g. $10 for an ETB) are not real stock drops.
function isDepositOrTokenPrice(name, priceStr) {
  const price = parsePrice(priceStr);
  if (price === null) return false;
  const n = String(name || "");
  // Explicit deposit marker
  if (/\bdeposit\b/i.test(n)) return true;
  // Preorder at a token price far below normal retail for that product type
  if (/\bpre-?order\b/i.test(n) && price > 0 && price < 20) return true;
  return false;
}

// Items this bot first saw within this many days stay "hot" for back-in-stock
// alerts, so a brand-new set is covered without editing any config.
const HOT_DAYS = 45;
const MAX_SHOPIFY_PAGES = 4; // 250 products per page
// Bumped whenever tracking rules change, so the first run after an update
// quietly rebuilds each store's baseline instead of alerting on everything.
// Bump when filter rules change so stores quietly re-baseline (no spam alert).
const TRACKING_MODE = "v3-sealed-positive";
const MAX_KNOWN = 3000;

const PRODUCT_LINK_PATTERNS = [/\/products\//i, /\/product\//i, /\/product-page\//i, /\/dp\//i, /\/p\//i];
const MAX_ITEMS_PER_ALERT = 8;

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

function getKeywords(target, config) {
  const raw = target.keyword || config.activeSets;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((k) => k.trim().toLowerCase()).filter(Boolean);
}

function matchesKeywords(text, keywords) {
  if (keywords.length === 0) return true;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

let includeLoosePacks = false;
const trackedSnapshot = []; // products seen this run (Shopify stores), for the daily summary
// One loose "Booster Pack" (singular). Multi-packs, blisters, bundles and boxes
// have other words or a plural "packs" and are unaffected.
function isLoosePack(name) {
  return /\bbooster pack\b/i.test(name) && !/\b(blister|bundle|box|display|tin|collection|case|\d+\s*-?\s*packs?)\b/i.test(name);
}

// Sealed product = looks like TCG sealed product (positive match on product type)
// AND does not look like a single/promo/loose pack. Positive match is critical:
// without it, random store junk (games, apparel) that isn't a "single card"
// would pass through on Pokemon-scoped pages.
function isSealedProduct(name) {
  if (!name) return false;
  if (!includeLoosePacks && isLoosePack(name)) return false;
  if (looksLikeSetNamedCard(name) || isCardBundle(name)) return false;
  if (SINGLE_CARD_EXCLUDE_PATTERNS.some((p) => p.test(name))) return false;
  // Must contain a sealed-product type word
  if (!SEALED_WORDS.test(name)) return false;
  return true;
}

function isPokemonText(text) {
  return /pok[e\u00e9]mon|pokebox/i.test(String(text || "").normalize("NFC"));
}

// A target is "Pokemon scoped" when its URL is a Pokemon-specific page or
// collection (so titles without the word Pokemon, e.g. "Mega Charizard X ex
// Ultra-Premium Collection", still count). Store-wide feeds are not scoped,
// so each item must itself say Pokemon. Override with "pokemonOnly" in config.
function isPokemonScoped(target) {
  if (typeof target.pokemonOnly === "boolean") return target.pokemonOnly;
  return isPokemonText(target.url);
}

// searchText = everything we know about the item (title, vendor, type, tags).
function isTrackableItem(item, scoped) {
  const name = item.name || "";
  // On non-Pokemon feeds, the item itself must mention Pokemon.
  // On Pokemon-scoped feeds, still drop non-TCG junk (games, merch) via patterns below.
  if (!scoped && !isPokemonText(`${item.searchText || ""} ${name} ${item.url || ""}`)) return false;
  if (OTHER_TCG_PATTERN.test(name)) return false;
  if (OTHER_LANGUAGE_PATTERN.test(name)) return false;
  if (NON_PRODUCT_PATTERNS.some((p) => p.test(name))) return false;
  if (!isSealedProduct(name)) return false;
  if (item.price && parsePrice(item.price) === 0) return false; // "$0.00" = hidden/placeholder listing
  if (isDepositOrTokenPrice(name, item.price)) return false; // $10 deposit preorders etc.
  recordPriceSample(name, item.price);
  if (!priceCapsDisabled && isOverRetailPrice(name, item.price)) return false;
  return true;
}

function isHotItem(name, firstSeen, keywords, now = Date.now()) {
  if (keywords.length > 0 && matchesKeywords(name, keywords)) return true;
  if (!firstSeen) return false;
  const seenMs = Date.parse(firstSeen);
  return !isNaN(seenMs) && now - seenMs < HOT_DAYS * 24 * 60 * 60 * 1000;
}

function isPriorityItem(name) {
  const lower = name.toLowerCase();
  return PRIORITY_KEYWORDS.some((k) => lower.includes(k));
}

// ---- Compact Telegram formatting -----------------------------------------
function escHtml(t) {
  return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanStoreName(name) {
  return String(name || "")
    .replace(/\s*\((confirmed[^)]*|new listings?)\)/gi, "")
    .replace(/\s+-\s+(pokemon|pok\u00e9mon)(\s+tcg)?(\s+collection)?\s*$/i, "")
    .trim();
}

function cleanItemName(name) {
  return String(name || "")
    .replace(/^\s*(pok[e\u00e9]mon\s+tcg\s*[-:|]\s*|pok[e\u00e9]mon\s*[-:|]\s*|pok[e\u00e9]mon\s+)/i, "")
    .replace(/\s*[|-]\s*pok[e\u00e9]mon( tcg)?( australia)?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// One short line: tappable name, bold price, tiny notes.
function formatItemHtml(item, note) {
  const fire = isPriorityItem(item.name) ? "🔥 " : "";
  const jp = isJapaneseProduct(item.name) ? "🇯🇵 " : "";
  const label = escHtml(cleanItemName(item.name));
  const link = item.url ? `<a href="${escHtml(item.url)}">${label}</a>` : label;
  const price = item.price ? ` — <b>${escHtml(item.price)}</b>` : "";
  const ref = retailRef(item.name);
  const retailNote = ref
    ? ` <i>(${isJapaneseProduct(item.name) ? "JP ref" : "RRP"} ~$${ref})</i>`
    : "";
  const over = overRetailNote(item.name, item.price).replace(/\(~?\+(\d+)% over retail\)/, " 📈+$1%");
  return `${fire}${jp}${link}${price}${retailNote}${over}${note ? ` ${note}` : ""}`;
}

// Alerts found during a run are collected here and sent as at most TWO
// messages: a normal (notifying) one for high-priority items - ETBs, booster
// boxes, Ultra-Premium, anything from a watched set - and a silent one for
// everything else (or none, with "lowPriorityAlerts": "off" in config.json).
const alertQueue = {
  loud: { restock: new Map(), fresh: new Map() },
  quiet: { restock: new Map(), fresh: new Map() },
};
let loudKeywords = [];
let lowPriorityMode = "silent";

function setAlertSettings(config) {
  loudKeywords = (Array.isArray(config && config.activeSets) ? config.activeSets : [])
    .concat(Array.isArray(config && config.priorityKeywords) ? config.priorityKeywords : [])
    .map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  lowPriorityMode = config && config.lowPriorityAlerts === "off" ? "off" : "silent";
  includeLoosePacks = !!(config && config.includeLoosePacks);
}

function isLoudItem(item) {
  const lower = String(item.name || "").toLowerCase();
  if (isPriorityItem(item.name)) return true;
  if (/\b(booster box|display|elite trainer|etb|ultra[- ]premium)\b/.test(lower)) return true;
  return loudKeywords.some((k) => lower.includes(k));
}

function queueAlert(kind, storeName, items, noteFn) {
  const store = cleanStoreName(storeName);
  for (const it of items) {
    const bucket = alertQueue[isLoudItem(it) ? "loud" : "quiet"][kind];
    if (!bucket.has(store)) bucket.set(store, []);
    bucket.get(store).push(formatItemHtml(it, noteFn ? noteFn(it) : ""));
  }
}

function buildAlertMessages(tier = "loud") {
  const sections = [
    ["restock", "\ud83d\udea8 <b>BACK IN STOCK</b>"],
    ["fresh", "\ud83c\udd95 <b>NEW LISTINGS</b>"],
  ];
  const blocks = [];
  for (const [kind, header] of sections) {
    const bucket = alertQueue[tier][kind];
    if (!bucket.size) continue;
    blocks.push(tier === "quiet" ? header.replace("<b>", "<b>(other) ") : header);
    for (const [store, lines] of bucket) {
      const shown = lines.slice(0, MAX_ITEMS_PER_ALERT);
      const more = lines.length > shown.length ? `\n<i>+${lines.length - shown.length} more at this store</i>` : "";
      blocks.push(`<b>${escHtml(store)}</b>\n${shown.join("\n")}${more}`);
    }
  }
  const messages = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && (cur + "\n\n" + b).length > 3800) { messages.push(cur); cur = b; }
    else cur = cur ? cur + "\n\n" + b : b;
  }
  if (cur) messages.push(cur);
  return messages;
}

async function flushAlerts() {
  const loud = buildAlertMessages("loud");
  const quiet = lowPriorityMode === "off" ? [] : buildAlertMessages("quiet");
  for (const tier of ["loud", "quiet"]) for (const k of ["restock", "fresh"]) alertQueue[tier][k].clear();
  for (const m of loud) await sendTelegram(m, false);
  for (const m of quiet) await sendTelegram(m, true);
  return loud.length + quiet.length;
}

function formatItemLine(item) {
  const tag = isPriorityItem(item.name) ? "🔥 " : "";
  return `${tag}• ${item.name}${item.price ? ` — ${item.price}` : ""}${overRetailNote(item.name, item.price)}`;
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

function isQuietHoursNow() {
  const hour = new Date().getUTCHours();
  if (QUIET_HOUR_START_UTC <= QUIET_HOUR_END_UTC) {
    return hour >= QUIET_HOUR_START_UTC && hour < QUIET_HOUR_END_UTC;
  }
  return hour >= QUIET_HOUR_START_UTC || hour < QUIET_HOUR_END_UTC;
}

async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (err) {
    console.log(`Retrying ${label} after error: ${err.message}`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return await fn();
  }
}

async function fetchHtmlNormal(url) {
  return withRetry(async () => {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Ch-Ua": '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });

    if (res.status === 403 || res.status === 429) {
      throw new Error(`Blocked (${res.status}) for ${url}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }, url);
}

async function fetchHtmlPlaywright(url) {
  if (!playwright) throw new Error("Playwright not available");

  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--window-size=1366,768",
      "--disable-extensions",
      "--disable-plugins-discovery",
      "--disable-background-networking",
      // Avoid HTTP2 protocol errors on some AU retail CDNs (e.g. Big W)
      "--disable-http2",
      "--disable-features=Http2ServerPush,UseChromeOSDirectVideoDecoder",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-AU",
      timezoneId: "Australia/Sydney",
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    // Stronger stealth
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "languages", { get: () => ["en-AU", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

    const page = await context.newPage();
    // Prefer fast partial loads — full "load" often hangs on big retail CDNs
    // from datacenter IPs (e.g. Big W). commit/domcontentloaded is enough
    // to grab HTML for stock checks.
    let lastErr;
    for (const waitUntil of ["commit", "domcontentloaded"]) {
      try {
        await page.goto(url, { waitUntil, timeout: 25000 });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;

    await page.waitForTimeout(2500);
    // Try to dismiss common cookie / challenge overlays if present
    try {
      await page.click('button:has-text("Accept"), button:has-text("I agree"), button:has-text("Got it")', { timeout: 1500 });
    } catch (_) {}
    await page.waitForTimeout(800);
    const html = await page.content();
    await context.close();
    return html;
  } finally {
    await browser.close();
  }
}

async function fetchHtml(url, usePlaywright = false) {
  if (usePlaywright && playwright && USE_PLAYWRIGHT) {
    try {
      return await fetchHtmlPlaywright(url);
    } catch (err) {
      console.warn(`Playwright failed for ${url}: ${err.message} – falling back to normal fetch`);
      return await fetchHtmlNormal(url);
    }
  }
  return await fetchHtmlNormal(url);
}

// Pure mapping function pulled out of fetchShopifyProducts specifically so
// the self-test below can exercise it with fake data, no network needed.
// Price shown is the cheapest variant you can actually buy right now (or the
// cheapest overall if everything is sold out).
function mapShopifyProducts(products, origin) {
  return products.map((p) => {
    const variants = p.variants || [];
    const available = variants.some((v) => v.available);
    // Prefer available variants; use the lowest *available* price (real sell price).
    // Shopify v.price is always the current selling price (not compare-at).
    const pool = available ? variants.filter((v) => v.available) : variants;
    const prices = pool
      .map((v) => parseFloat(v.price))
      .filter((n) => !isNaN(n) && n > 0);
    const price = prices.length ? Math.min(...prices) : null;
    const tags = Array.isArray(p.tags) ? p.tags.join(" ") : String(p.tags || "");
    return {
      handle: p.handle,
      name: p.title,
      url: `${origin}/products/${p.handle}`,
      available,
      price: price !== null ? `$${price.toFixed(2)}` : "",
      searchText: [p.title, p.vendor, p.product_type, tags, p.handle].filter(Boolean).join(" "),
    };
  });
}

// Shopify returns only 30 products unless asked for more, so request 250 per
// page and read up to MAX_SHOPIFY_PAGES pages.
async function fetchShopifyProducts(jsonUrl) {
  const origin = new URL(jsonUrl).origin;
  const all = [];
  for (let page = 1; page <= MAX_SHOPIFY_PAGES; page++) {
    const u = new URL(jsonUrl);
    u.searchParams.set("limit", "250");
    u.searchParams.set("page", String(page));
    const data = await withRetry(async () => {
      const res = await fetch(u.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "application/json",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${u.toString()}`);
      return res.json();
    }, u.toString());
    const batch = data.products || [];
    all.push(...batch);
    if (batch.length < 250) break;
  }
  return mapShopifyProducts(all, origin);
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

function classifyProductPage(text) {
  const lower = text.toLowerCase();
  const hasPositive = POSITIVE_SIGNALS.some((s) => lower.includes(s));
  const hasNegative = NEGATIVE_SIGNALS.some((s) => lower.includes(s));

  // Prefer clear positive signals when both appear (common on some retailers)
  if (hasPositive && !hasNegative) return "AVAILABLE";
  if (hasPositive && hasNegative) {
    // If "add to cart" style language is present, treat as available
    if (/\b(add to cart|add to bag|buy now|add to trolley)\b/.test(lower)) {
      return "AVAILABLE";
    }
  }
  if (hasNegative) return "UNAVAILABLE";
  return "UNKNOWN";
}

// Lightweight nearby signal detection for postcode-based pages.
// Looks for store/availability language that often appears when in-store stock is shown.
function detectNearbySignals(html, postcode) {
  const text = htmlToText(html).toLowerCase();
  const pc = String(postcode || "").toLowerCase();
  const signals = [];

  if (pc && text.includes(pc)) signals.push(`postcode ${postcode} mentioned`);
  if (/\b(in stock|available|limited stock)\b/.test(text) && /\b(store|click.?and.?collect|pick.?up|collect)\b/.test(text)) {
    signals.push("in-store / click & collect availability language found");
  }
  if (/\b(geelong|waurn ponds|belmont|corio|newtown|highton)\b/.test(text)) {
    signals.push("Geelong-area store name detected");
  }
  return signals;
}

// Pull a likely product price from text, ignoring "Save $10" / discount chips.
function extractBestPrice(text) {
  if (!text) return "";
  const cleaned = String(text).replace(/\s+/g, " ");
  // Drop "Save $X" / "Was $X" noise so the first remaining $ is more likely the sell price
  const withoutSave = cleaned
    .replace(/save\s*\$\s?[\d,]+(?:\.\d{2})?/gi, " ")
    .replace(/was\s*\$\s?[\d,]+(?:\.\d{2})?/gi, " ")
    .replace(/from\s*\$\s?[\d,]+(?:\.\d{2})?/gi, " ");
  const matches = withoutSave.match(/\$\s?[\d,]+(?:\.\d{2})?/g) || [];
  const nums = matches
    .map((m) => parseFloat(m.replace(/[^\d.]/g, "")))
    .filter((n) => !isNaN(n) && n >= 1 && n < 5000);
  if (!nums.length) return "";
  // Prefer the lowest plausible sell price (sale price is usually listed first or lower)
  // but if we see two prices close together (sale + RRP), take the lower one.
  const sorted = [...nums].sort((a, b) => a - b);
  const best = sorted[0];
  return `$${best.toFixed(2)}`;
}

function extractProductLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const seen = new Map();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!PRODUCT_LINK_PATTERNS.some((p) => p.test(href))) return;

    let absUrl;
    try {
      absUrl = new URL(href, baseUrl).toString().split("#")[0];
    } catch (e) {
      return;
    }
    if (seen.has(absUrl)) return;

    let rawName = $(el).text().replace(/\s+/g, " ").trim();
    if (!rawName) rawName = $(el).find("img").attr("alt") || "";
    if (!rawName) rawName = $(el).attr("title") || "";
    if (!rawName) return;
    // Keep rawName (with any embedded $) for price parsing; clean name for display
    const name = rawName.replace(/\$\s?[\d,]+(?:\.\d{2})?/g, " ").replace(/\s+/g, " ").trim() || rawName;
    if (!name) return;

    let container = $(el).closest(
      "li, article, .product, .product-card, .product-item, .grid-item, .card, div"
    ).first();
    if (!container.length) container = $(el).parent();

    // Prefer dedicated price nodes over raw card text
    let price = "";
    if (container.length) {
      const priceEl = container.find(
        ".price, .product-price, .money, [data-price], .price__regular, .price-item, .current-price, .sale-price"
      ).first();
      if (priceEl.length) {
        price = extractBestPrice(priceEl.text());
      }
      if (!price) {
        price = extractBestPrice(container.text());
      }
    }
    // Fall back to price embedded in the link text itself
    if (!price) {
      price = extractBestPrice(rawName);
    }

    seen.set(absUrl, { url: absUrl, name: name.slice(0, 120), price });
  });

  return Array.from(seen.values());
}

function logAlert(message) {
  try {
    fs.mkdirSync(path.dirname(ALERTS_LOG_PATH), { recursive: true });
    let log = [];
    try {
      log = JSON.parse(fs.readFileSync(ALERTS_LOG_PATH, "utf8"));
    } catch (e) {
      log = [];
    }
    log.push({ timestamp: new Date().toISOString(), message });
    if (log.length > MAX_LOG_ENTRIES) {
      log = log.slice(log.length - MAX_LOG_ENTRIES);
    }
    fs.writeFileSync(ALERTS_LOG_PATH, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error("Failed to write alert log (non-fatal):", err.message);
  }
}

async function sendTelegram(message, silent = false) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[no telegram configured] would have sent:\n" + message);
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: !!silent,
    }),
  });
  if (!res.ok) {
    console.error("Telegram send failed:", await res.text());
    return false;
  }
  console.log("Telegram message sent OK.");
  logAlert(message);
  return true;
}

function isOnCooldown(state, itemKey) {
  const cooldowns = state._cooldowns || {};
  const last = cooldowns[itemKey];
  return last && Date.now() - last < COOLDOWN_MS;
}

function markCooldown(state, itemKey) {
  if (!state._cooldowns) state._cooldowns = {};
  state._cooldowns[itemKey] = Date.now();
}

async function checkTarget(target, state, config, healthReport) {
  const prev = state[target.name] || {};
  let html;
  const needsPlaywright = !!(target.playwright || target.hard);
  try {
    html = await fetchHtml(target.url, needsPlaywright);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes("Blocked")) {
      console.warn(`Blocked by anti-bot: ${target.name}`);
      healthReport.blocked = healthReport.blocked || [];
      healthReport.blocked.push(target.name);
    } else {
      console.error(`Failed to fetch ${target.name}:`, msg);
      healthReport.failed.push(target.name);
    }
    return prev;
  }
  healthReport.ok.push(target.name);

  // Nearby signal check (postcode 3216 / Geelong area)
  if (target.nearby && config && config.nearby && config.nearby.enabled) {
    const postcode = config.nearby.postcode || "3216";
    const signals = detectNearbySignals(html, postcode);
    const nearKey = `${target.name}::nearby`;
    const prevSignals = (prev.nearbySignals || []).join("|");
    const newSignals = signals.join("|");
    if (signals.length && newSignals !== prevSignals && !isOnCooldown(state, nearKey)) {
      await sendTelegram(
        `📍 <b>NEARBY SIGNAL</b> (${postcode})\n${target.name}\n${signals.map((s) => `• ${s}`).join("\n")}\n${target.url}\n<i>Open the page and enter your postcode to confirm store stock.</i>`
      );
      markCooldown(state, nearKey);
    }
    // store for next comparison
    prev.nearbySignals = signals;
  }

  if (target.type === "product") {
    // A "product" target is a single, pre-selected page (already known to
    // be sealed product), so the sealed-product filter doesn't apply here.
    const text = htmlToText(html);
    const status = classifyProductPage(text);
    const itemKey = `${target.name}::product`;
    if (
      prev.status &&
      prev.status !== "AVAILABLE" &&
      status === "AVAILABLE" &&
      !isOnCooldown(state, itemKey)
    ) {
      await sendTelegram(
        `🚨 <b>STOCK ALERT</b>\n${target.name}\nLooks like it just became orderable!\n${target.url}\n<i>Check the page for current price vs typical retail.</i>`
      );
      markCooldown(state, itemKey);
    }
    return { status, checkedAt: new Date().toISOString(), nearbySignals: prev.nearbySignals || [] };
  }

  const keywords = getKeywords(target, config);
  const scoped = isPokemonScoped(target);
  const allItems = extractProductLinks(html, target.url);

  if (allItems.length > 0) {
    const relevant = allItems.filter((item) => isTrackableItem(item, scoped));
    const relevantUrls = relevant.map((i) => i.url);
    const isFirstRun = !prev.itemUrls || prev.mode !== TRACKING_MODE;
    const known = new Set(prev.knownUrls || prev.itemUrls || []);

    if (!isFirstRun) {
      const newItems = relevant.filter(
        (i) => !known.has(i.url) && !isOnCooldown(state, `${target.name}::${i.url}`)
      );
      if (newItems.length > 0) {
        queueAlert("fresh", target.name, newItems);
        newItems.forEach((i) => markCooldown(state, `${target.name}::${i.url}`));
      }
    }

    relevantUrls.forEach((u) => known.add(u));
    return {
      mode: TRACKING_MODE,
      itemUrls: relevantUrls,
      knownUrls: Array.from(known).slice(-MAX_KNOWN),
      checkedAt: new Date().toISOString(),
    };
  }

  const text = htmlToText(html);
  const hash = simpleHash(text);
  // "Page changed" fallback alerts are off by default (too noisy on hard sites).
  // Set "pageChangeAlerts": true in config.json to re-enable them.
  const pageChangeAlerts = !!(config && config.pageChangeAlerts);
  if (pageChangeAlerts && prev.hash && prev.hash !== hash && (!isQuietHoursNow() || BURST_MODE)) {
    const mentionsKeyword = matchesKeywords(text, keywords);
    if (mentionsKeyword || keywords.length === 0) {
      await sendTelegram(`🔔 <b>Page changed</b>\n${escHtml(cleanStoreName(target.name))}\nWorth a look: <a href="${escHtml(target.url)}">open page</a>`);
    }
  }
  return { hash, checkedAt: new Date().toISOString() };
}

// Kmart (and some Wesfarmers search) via public Constructor.io API —
// bypasses the bot wall that blocks Playwright/fetch on kmart.com.au HTML.
const CONSTRUCTOR_KEY = "key_GZTqlLr41FS2p7AY";
async function fetchConstructorProducts(query, shopFilter, opts = {}) {
  const params = new URLSearchParams({
    key: CONSTRUCTOR_KEY,
    num_results_per_page: "40",
    "filters[Brand]": "Pokemon",
  });
  if (shopFilter) params.set("filters[Shops]", shopFilter);
  const url = `https://ac.cnstrc.com/search/${encodeURIComponent(query)}?${params}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Constructor HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.response && data.response.results) || [];
  // Prefer state-level signal for nearby (Geelong = VIC). Constructor exposes
  // stateOOS: if VIC is listed, that state is treated as out of stock.
  // This is the best free proxy for "stock near me" without the blocked GraphQL API.
  const preferState = (opts.state || "VIC").toUpperCase();
  const nearbyOnly = !!opts.nearbyOnly;

  return results.map((r) => {
    const d = r.data || {};
    const priceNum = typeof d.price === "number" ? d.price : parseFloat(d.price);
    const price = !isNaN(priceNum) ? `$${priceNum.toFixed(2)}` : null;
    const path = d.url || d.uri || "";
    const fullUrl = path.startsWith("http") ? path : `https://www.kmart.com.au${path}`;
    const national = d.nationalInventory === true || d.isPreOrderActive === true;
    const stateOOS = d.stateOOS && typeof d.stateOOS === "object" ? d.stateOOS : {};
    const stateMarkedOOS = Object.prototype.hasOwnProperty.call(stateOOS, preferState);
    // Nearby-friendly: national stock AND this state not flagged OOS
    const inState = national && !stateMarkedOOS;
    const available = nearbyOnly ? inState : national;
    return {
      name: r.value || path,
      url: fullUrl,
      handle: String(d.id || path),
      price,
      available,
      national,
      inState,
      state: preferState,
      searchText: `${r.value || ""} Pokemon ${d.MerchClassName || ""}`,
    };
  });
}

async function checkConstructorTarget(target, state, config, healthReport) {
  const prev = state[target.name] || {};
  let fetched;
  try {
    const nearbyCfg = (config && config.nearby) || {};
    const preferState = target.state || nearbyCfg.state || "VIC";
    // Kmart: default to nearby-only (VIC not in stateOOS) so in-store-only
    // national listings don't spam when your state has nothing.
    const nearbyOnly = target.nearbyOnly !== undefined
      ? !!target.nearbyOnly
      : (target.shop === "Kmart" || /kmart/i.test(target.name || ""));
    fetched = await fetchConstructorProducts(target.query || "pokemon tcg", target.shop || "Kmart", {
      state: preferState,
      nearbyOnly,
    });
  } catch (err) {
    console.error(`Failed to fetch ${target.name}:`, err.message);
    healthReport.failed.push(target.name);
    return prev;
  }
  healthReport.ok.push(target.name);

  const keywords = getKeywords(target, config);
  const scoped = true; // Constructor query is already Pokemon-scoped
  const relevant = fetched.filter((p) => isTrackableItem(p, scoped));
  relevant.forEach((p) => trackedSnapshot.push({ name: p.name, available: !!p.available }));
  const prevByHandle = new Map((prev.products || []).map((p) => [p.handle, p]));
  const known = new Set(prev.knownHandles || (prev.products || []).map((p) => p.handle));
  const isFirstRun = !prev.products || prev.mode !== TRACKING_MODE;
  const nowIso = new Date().toISOString();

  if (!isFirstRun) {
    const newItems = relevant.filter(
      (p) =>
        p.available &&
        !known.has(p.handle) &&
        !isOnCooldown(state, `${target.name}::${p.handle}::new`)
    );
    const restocked = relevant.filter((p) => {
      const old = prevByHandle.get(p.handle);
      if (!old || old.available || !p.available) return false;
      if (!isHotItem(p.name, old.firstSeen, keywords)) return false;
      return !isOnCooldown(state, `${target.name}::${p.handle}::stock`);
    });
    if (newItems.length > 0) {
      queueAlert("fresh", target.name, newItems);
      newItems.forEach((p) => markCooldown(state, `${target.name}::${p.handle}::new`));
      if (target.nearby && config && config.nearby && config.nearby.enabled) {
        await maybeSendNearbyConstructorAlert(target, newItems, config, state);
      }
    }
    if (restocked.length > 0) {
      queueAlert("restock", target.name, restocked);
      restocked.forEach((p) => markCooldown(state, `${target.name}::${p.handle}::stock`));
      if (target.nearby && config && config.nearby && config.nearby.enabled) {
        await maybeSendNearbyConstructorAlert(target, restocked, config, state);
      }
    }
  }

  const saved = relevant.map((p) => {
    const old = prevByHandle.get(p.handle);
    let firstSeen = old && old.firstSeen;
    if (!firstSeen && !isFirstRun && !known.has(p.handle)) firstSeen = nowIso;
    const rec = { handle: p.handle, available: p.available, price: p.price };
    if (firstSeen) rec.firstSeen = firstSeen;
    return rec;
  });
  relevant.forEach((p) => known.add(p.handle));

  return {
    mode: TRACKING_MODE,
    products: saved,
    knownHandles: Array.from(known).slice(-MAX_KNOWN),
    checkedAt: nowIso,
  };
}

async function maybeSendNearbyConstructorAlert(target, items, config, state) {
  const postcode = (config.nearby && config.nearby.postcode) || "3216";
  const storesMap = (config.nearby && config.nearby.stores) || {};
  const shop = target.shop || "Kmart";
  const localStores = storesMap[shop] || [];
  if (!localStores.length || !items.length) return;

  const nearKey = `${target.name}::nearby-batch`;
  if (isOnCooldown(state, nearKey)) return;

  const lines = items.slice(0, 5).map((i) => {
    const price = i.price ? ` — ${i.price}` : "";
    return `• <a href="${escHtml(i.url)}">${escHtml(cleanItemName(i.name))}</a>${price}`;
  });
  const storeLines = localStores.map((s) => `• ${escHtml(s)}`).join("\n");

  await sendTelegram(
    `📍 <b>NEARBY CHECK</b> (${postcode})\n` +
      `${escHtml(shop)} has orderable sealed stock online.\n` +
      `Local stores to check:\n${storeLines}\n\n` +
      `${lines.join("\n")}\n\n` +
      `<i>Online stock ≠ guaranteed in every store. Call or check click &amp; collect before driving.</i>`
  );
  markCooldown(state, nearKey);
}

async function checkShopifyTarget(target, state, config, healthReport) {
  const prev = state[target.name] || {};
  let fetched;
  try {
    fetched = await fetchShopifyProducts(target.url);
  } catch (err) {
    console.error(`Failed to fetch ${target.name}:`, err.message);
    healthReport.failed.push(target.name);
    return prev;
  }
  healthReport.ok.push(target.name);

  const keywords = getKeywords(target, config);
  const scoped = isPokemonScoped(target);
  const relevant = fetched.filter((p) => isTrackableItem(p, scoped));
  relevant.forEach((p) => trackedSnapshot.push({ name: p.name, available: !!p.available }));
  const prevByHandle = new Map((prev.products || []).map((p) => [p.handle, p]));
  const known = new Set(prev.knownHandles || (prev.products || []).map((p) => p.handle));
  const isFirstRun = !prev.products || prev.mode !== TRACKING_MODE;
  const nowIso = new Date().toISOString();

  if (!isFirstRun) {
    // NEW LISTINGS: only alert when the product is actually orderable right now.
    // Items that appear as "not yet orderable" are still tracked in state so
    // that when they later become available we fire a BACK IN STOCK alert.
    const newItems = relevant.filter(
      (p) =>
        p.available &&
        !known.has(p.handle) &&
        !isOnCooldown(state, `${target.name}::${p.handle}::new`)
    );
    // Restocks: was unavailable → now available (for hot/watched items).
    const restocked = relevant.filter((p) => {
      const old = prevByHandle.get(p.handle);
      if (!old || old.available || !p.available) return false;
      if (!isHotItem(p.name, old.firstSeen, keywords)) return false;
      return !isOnCooldown(state, `${target.name}::${p.handle}::stock`);
    });

    if (newItems.length > 0) {
      queueAlert("fresh", target.name, newItems);
      newItems.forEach((p) => markCooldown(state, `${target.name}::${p.handle}::new`));
    }

    if (restocked.length > 0) {
      queueAlert("restock", target.name, restocked);
      restocked.forEach((p) => markCooldown(state, `${target.name}::${p.handle}::stock`));
    }
  }

  const saved = relevant.map((p) => {
    const old = prevByHandle.get(p.handle);
    let firstSeen = old && old.firstSeen;
    if (!firstSeen && !isFirstRun && !known.has(p.handle)) firstSeen = nowIso;
    const rec = { handle: p.handle, available: p.available, price: p.price };
    if (firstSeen) rec.firstSeen = firstSeen;
    return rec;
  });
  relevant.forEach((p) => known.add(p.handle));

  return {
    mode: TRACKING_MODE,
    products: saved,
    knownHandles: Array.from(known).slice(-MAX_KNOWN),
    checkedAt: nowIso,
  };
}

async function checkNewSets(state, config, healthReport) {
  const KEY = "_setWatch";
  const prev = state[KEY] || {};
  const isFirstRun = !prev.knownSetIds;

  let sets;
  try {
    const res = await fetch("https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=20", {
      headers: {
        "User-Agent": "PokemonStockBot/1.1 (personal stock watcher)",
        "Accept": "application/json",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sets = data.data || [];
    if (!sets.length) throw new Error("Empty sets response");
  } catch (err) {
    // Non-critical — stock alerts still work without set announcements
    console.warn("Set-watch check failed (skipping):", err.message);
    healthReport.ok.push("Set-announcement watcher (skipped)");
    return false;
  }
  healthReport.ok.push("Set-announcement watcher");

  const knownIds = new Set(prev.knownSetIds || []);
  const newSets = sets.filter((s) => !knownIds.has(s.id));
  let configChanged = false;

  if (!isFirstRun && newSets.length > 0) {
    const lines = newSets
      .slice(0, MAX_ITEMS_PER_ALERT)
      .map((s) => `• ${s.name} (${s.series}) — release ${s.releaseDate}`)
      .join("\n");

    if (!Array.isArray(config.activeSets)) config.activeSets = [];
    const existingLower = config.activeSets.map((k) => k.toLowerCase());
    const added = [];
    for (const s of newSets) {
      if (!existingLower.includes(s.name.toLowerCase())) {
        config.activeSets.push(s.name);
        existingLower.push(s.name.toLowerCase());
        added.push(s.name);
        configChanged = true;
      }
    }

    const addedNote = added.length
      ? `\n\n✅ Automatically added to activeSets - now tracking ${added.length > 1 ? "these sets" : "this set"} across all retailers.`
      : `\n\n(Already in activeSets - no change needed.)`;

    await sendTelegram(`📣 <b>New Pokémon TCG set announced</b>\n\n${lines}${addedNote}`);
  }

  state[KEY] = {
    knownSetIds: sets.map((s) => s.id),
    checkedAt: new Date().toISOString(),
  };

  return configChanged;
}

// ---- Self-test: exercises every pure function with known fake inputs, no
// network calls, every single run. ----
function assertEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function runSelfTest() {
  const results = [];

  results.push({ name: "parsePrice handles plain price", pass: assertEqual(parsePrice("$54.00"), 54) });
  results.push({ name: "parsePrice handles comma thousands", pass: assertEqual(parsePrice("$1,234.50"), 1234.5) });
  results.push({ name: "isPriorityItem flags Elite Trainer Box", pass: assertEqual(isPriorityItem("Pokemon Elite Trainer Box"), true) });
  results.push({ name: "isPriorityItem ignores normal item", pass: assertEqual(isPriorityItem("Booster Pack"), false) });
  results.push({ name: "isSealedProduct accepts Elite Trainer Box", pass: assertEqual(isSealedProduct("30th Celebration Elite Trainer Box"), true) });
  results.push({ name: "isSealedProduct rejects a single card", pass: assertEqual(isSealedProduct("Pikachu 025/030 30th Celebration"), false) });
  results.push({ name: "isSealedProduct accepts a never-seen-before future product type", pass: assertEqual(isSealedProduct("Mega Evolution Trainer's Cache Box"), true) });
  results.push({ name: "isSealedProduct rejects a graded single", pass: assertEqual(isSealedProduct("PSA 10 Charizard Base Set"), false) });
  results.push({ name: "formatItemLine adds priority tag", pass: formatItemLine({ name: "Ultra-Premium Collection", price: "$99.99" }).includes("🔥") });
  results.push({ name: "matchesKeywords finds a match", pass: assertEqual(matchesKeywords("Pokemon 30th Celebration ETB", ["30th"]), true) });
  results.push({ name: "matchesKeywords correctly rejects non-match", pass: assertEqual(matchesKeywords("Random unrelated product", ["30th"]), false) });
  results.push({ name: "classifyProductPage detects AVAILABLE", pass: assertEqual(classifyProductPage("Add to Cart Buy Now"), "AVAILABLE") });
  results.push({ name: "classifyProductPage detects UNAVAILABLE", pass: assertEqual(classifyProductPage("Sold Out - Notify Me"), "UNAVAILABLE") });
  results.push({
    name: "extractProductLinks parses a sample product link",
    pass: (() => {
      const sampleHtml = "<html><body><a href='/products/test-etb'>Test ETB $54.00</a></body></html>";
      const items = extractProductLinks(sampleHtml, "https://example.com");
      const ok1 = items.length === 1 && items[0].url === "https://example.com/products/test-etb" && items[0].price === "$54.00";
      // Must ignore "Save $10" and pick the real sale price
      const saleHtml = "<html><body><div class='card'><a href='/products/sale-item'>Blister</a><span class='price'>Save $10.00 $50.00 $60.00</span></div></body></html>";
      const saleItems = extractProductLinks(saleHtml, "https://example.com");
      const ok2 = saleItems.length === 1 && saleItems[0].price === "$50.00";
      return ok1 && ok2;
    })(),
  });
  results.push({
    name: "mapShopifyProducts parses a sample product",
    pass: (() => {
      const sample = [{ handle: "test-etb", title: "Test ETB", variants: [{ available: true, price: "54.00" }] }];
      const mapped = mapShopifyProducts(sample, "https://example.com");
      return mapped.length === 1 && mapped[0].url === "https://example.com/products/test-etb" && mapped[0].available === true && mapped[0].price === "$54.00";
    })(),
  });
  results.push({
    name: "Gundam event with '30th' in the title is rejected in a store-wide feed",
    pass: assertEqual(isTrackableItem({ name: "Raptor Games - GUNDAM CARD GAME Stardust Trails GD06 Release Event - Friday 30th October 7pm", url: "https://x.com/products/g", searchText: "Gundam Raptor Games" }, false), false),
  });
  results.push({
    name: "Pokemon sealed box is accepted in a store-wide feed (via vendor/tags)",
    pass: assertEqual(isTrackableItem({ name: "Mega Evolution Chaos Rising Booster Box", url: "https://x.com/products/b", searchText: "Mega Evolution Chaos Rising Booster Box Pokemon" }, false), true),
  });
  results.push({
    name: "Non-Pokemon item is rejected in a store-wide feed",
    pass: assertEqual(isTrackableItem({ name: "Lego Star Wars Set", url: "https://x.com/products/l", searchText: "Lego" }, false), false),
  });
  results.push({
    name: "Pokemon-scoped collection accepts a title without the word Pokemon",
    pass: assertEqual(isTrackableItem({ name: "Mega Charizard X ex Ultra-Premium Collection", url: "https://x.com/products/c", searchText: "" }, true), true),
  });
  results.push({
    name: "Pokemon event ticket is rejected even in a Pokemon collection",
    pass: assertEqual(isTrackableItem({ name: "Pokemon League Event Ticket - Friday 30th October", url: "https://x.com/products/t", searchText: "" }, true), false),
  });
  results.push({
    name: "Price calibration nudges the reference, clamped to 20%, and ignores thin data",
    pass: (() => {
      const caps = [{ pattern: "\\bbundle\\b", max: 60 }];
      const mk = (n, pr) => Array.from({ length: n }, () => ({ name: "X Booster Bundle", price: pr }));
      const down = computeCalibration(mk(20, 45), caps); // 45 -> clamped to 48
      const thin = computeCalibration(mk(5, 45), caps);
      const same = computeCalibration(mk(20, 60), caps);
      return down.length === 1 && down[0].to === 50 && thin.length === 0 && same.length === 0;
    })(),
  });
  results.push({
    name: "Screenshot cases: set-named single, card bundle, single pack, Chinese are rejected",
    pass: (() => {
      const t = (name, price) => isTrackableItem({ name, price, url: "", searchText: "" }, true);
      return t("POKEMON Magikarp - ME: 30th Celebration Classic Collection (30C)", "$142.00") === false &&
        t("Pokémon TCG - Bundle - M6a 30th Celebration - EN", "$10.49") === false &&
        t("[Single Pack] Pokémon TCG - M6a - 30th Anniversary - JP", "$18.89") === false &&
        t("Pokémon TCG - 30th Anniversary Celebration - First Partner Illustration Series 1 - Chinese", "$26.24") === false &&
        t("Pokemon TCG: 30th Celebration Booster Box (S-Chinese)", "$150.00") === false &&
        // JP booster box ref ~$160; $220 is over +15% → reject
        t("Pokemon TCG MEGA - M6a - 30th Celebration Booster Box - JP", "$220.00") === false &&
        t("Pokemon TCG MEGA - M6a - 30th Celebration Booster Box - JP", "$155.00") === true &&
        t("Pokémon TCG: Shrouded Fable Booster Bundle", "$55.00") === true &&
        t("Pokemon TCG: ME: Ascended Heroes Elite Trainer Box", "$99.00") === true &&
        t("Pokemon TCG: Mega Evolution Booster Bundle Display (6 bundles)", "$270.00") === true &&
        t("Pokemon 30th Celebration Knock Out Collection - Pokemon TCG", "$59.95") === true &&
        // JP box $175 is within ~$160 + 15%
        t("Pokemon Japanese: Abyss Eye Booster Box [M5]", "$175.00") === true &&
        t("Basic Fighting Energy - 006 (6)", "$1.00") === false;
    })(),
  });
  results.push({
    name: "Alerts are compact, grouped by store, with tappable names and no raw URLs",
    pass: (() => {
      for (const t of ["loud", "quiet"]) for (const k of ["restock", "fresh"]) alertQueue[t][k].clear();
      setAlertSettings({ activeSets: ["30th"], priorityKeywords: ["kangaskhan"] });
      queueAlert("restock", "Light of Cards (confirmed Shopify)", [
        { name: "Pok\u00e9mon TCG - Mega Kangaskhan ex Box", price: "$104.99", url: "https://x.com/products/k" },
        { name: "Pok\u00e9mon TCG - Mega Lucario Ex Premium Figure Collection", price: "$146.99", url: "https://x.com/products/l" },
      ]);
      queueAlert("fresh", "GD Games - Pokemon (confirmed Shopify)", [
        { name: "Pokemon 30th Celebration Knock Out Collection - Pokemon TCG", price: "$59.95", url: "https://x.com/products/ko" },
      ], () => "");
      queueAlert("fresh", "Drop Store", [{ name: "Shrouded Fable Booster Bundle", price: "$55.00", url: "https://x.com/products/b" }]);
      const msgs = buildAlertMessages("loud");
      const quietMsgs = buildAlertMessages("quiet");
      for (const t of ["loud", "quiet"]) for (const k of ["restock", "fresh"]) alertQueue[t][k].clear();
      setAlertSettings({});
      const m = msgs[0] || "";
      if (quietMsgs.length !== 1 || !quietMsgs[0].includes("Drop Store") || m.includes("Drop Store")) return false;
      return msgs.length === 1 && m.includes('<a href="https://x.com/products/k">Mega Kangaskhan ex Box</a>') &&
        m.includes("<b>Light of Cards</b>") && m.includes("<b>GD Games</b>") && !m.includes("confirmed Shopify") &&
        m.indexOf("BACK IN STOCK") < m.indexOf("NEW LISTINGS") && !/\n\s*https?:\/\//.test(m);
    })(),
  });
  results.push({
    name: "Round-2 screenshot cases: SWSH promo card, $0 listing, loose pack",
    pass: (() => {
      const t = (name, price) => isTrackableItem({ name, price, url: "", searchText: "" }, true);
      return t("POKEMON TCG - Hoopa V SWSH176/307 SWSH Sword & Shield Promo Cards - Promo", "$0.00") === false &&
        t("POKEMON TCG - Hoopa V SWSH176/307 SWSH Sword & Shield Promo Cards - Promo", "$4.00") === false &&
        t("Pokemon 30th Celebration  Booster Pack - Japanese", "$22.00") === false &&
        t("Pokemon TCG: 30th Celebration Mini Tin", "$45.00") === true &&
        t("Pokemon TCG: Mega Evolution 3 Pack Blister", "$12.00") === true &&
        // JP booster box ref ~$160; $250 is well over → reject
        t("Pokemon 30th Celebration  Booster Box - Japanese", "$250.00") === false &&
        t("Pokemon 30th Celebration  Booster Box - Japanese", "$150.00") === true &&
        t("Pokemon TCG: Mega Evolution Booster Bundle", "$0.00") === false;
    })(),
  });
  results.push({
    name: "Heartbeat tracking summary lists watched sets with listing and in-stock counts",
    pass: (() => {
      const out = buildTrackingSummary({ activeSets: ["30th"], targets: [1, 2] }, [
        { name: "30th Celebration ETB", available: true }, { name: "30th Celebration Box", available: false }, { name: "Surging Sparks ETB", available: true },
      ]);
      return out.includes("Watched sets:</b> 30th") && out.includes("30th: 2 listings, 1 in stock") && out.includes("Scanning") && out.includes("2 sources");
    })(),
  });
  results.push({
    name: "Alert settings from config are applied (priorityKeywords, loose packs)",
    pass: (() => {
      setAlertSettings({ activeSets: [], priorityKeywords: ["zzz"], includeLoosePacks: true });
      // Pack RRP ~$8; use $8 so price filter doesn't reject under +15% tolerance
      const ok = isLoudItem({ name: "ZZZ thing" }) && isTrackableItem({ name: "Pokemon Booster Pack", price: "$8.00", url: "", searchText: "" }, true) === true;
      setAlertSettings({});
      return ok && isTrackableItem({ name: "Pokemon Booster Pack", price: "$8.00", url: "", searchText: "" }, true) === false;
    })(),
  });
  results.push({
    name: "Promo singles are rejected (incl. [Sealed] promo card)",
    pass: assertEqual(isTrackableItem({ name: "Pokémon TCG - Articuno - 097 Promo - 30th Celebration", price: "$2.69", url: "", searchText: "" }, true), false) &&
      assertEqual(isTrackableItem({ name: "[Sealed] Pokémon TCG - Nidorina - 101 Promo - 30th Celebration", price: "$29.99", url: "", searchText: "" }, true), false) &&
      assertEqual(isTrackableItem({ name: "CHARIZARD GX - SM195 SUN & MOON PROMO POKEMON PROMO HOLO HP", price: "$16.99", url: "", searchText: "" }, true), false) &&
      assertEqual(isTrackableItem({ name: "MEWTWO 3 WIZARDS BLACK STAR PROMOS POKEMON PROMO MP", price: "$25.99", url: "", searchText: "" }, true), false) &&
      assertEqual(isTrackableItem({ name: "VENUSAUR EX XY28 XY PROMO POKEMON PROMO HOLO LP", price: "$7.99", url: "", searchText: "" }, true), false) &&
      assertEqual(isTrackableItem({ name: "PIKACHU 4 WIZARDS BLACK STAR PROMOS POKEMON PROMO HP", price: "$19.99", url: "", searchText: "" }, true), false),
  });
  results.push({
    name: "Non-TCG junk on Pokemon-scoped pages is rejected",
    pass: (() => {
      const t = (name, price) => isTrackableItem({ name, price, url: "", searchText: "" }, true);
      return t("(deposit) Call of Duty: Modern Warfare 4 XBOX Series X PREORDER", "$10.00") === false &&
        t("The Witch's Bakery PlayStation 5", "$59.95") === false &&
        t("Pokemon Pikachu Plush 20cm", "$29.95") === false &&
        t("Pokemon TCG Sleeves Charizard", "$12.00") === false &&
        t("Random Anime Figure Statue", "$40.00") === false &&
        t("( deposit) Buy 10 Get 1 FREE Harry Potter - TC - Always Panini Booster Pop Culture PREORDER", "$3.00") === false &&
        t("SPECIAL OFFER Harry Potter - TC - Always Panini Premium Booster", "$19.95") === false &&
        t("Evercade - Tomb Raider Collection 2", "$49.95") === false &&
        t("( deposit) Pokemon - TCG - Mega Greninja ex League Battle Deck Pokemon PREORDER", "$10.00") === false &&
        t("TCG - ULTRA PRO Mega Charizard X & Mega Charizard Y Binder Accessories", "$32.00") === false &&
        t("Celebrations First Partner Collector's Binder", "$45.00") === false &&
        t("Pokemon TCG: Celebrations Binder Collection", "$39.95") === true &&
        t("Pokemon TCG: Shrouded Fable Booster Bundle", "$55.00") === true &&
        t("Pokemon TCG: Elite Trainer Box", "$99.00") === true;
    })(),
  });
  results.push({
    name: "Reseller-priced sealed items are rejected, retail ones kept",
    pass: assertEqual(isTrackableItem({ name: "Shrouded Fable Booster Bundle | Pokemon TCG", price: "$189.95", url: "", searchText: "" }, true), false) &&
      assertEqual(isTrackableItem({ name: "Shrouded Fable Booster Bundle | Pokemon TCG", price: "$49.95", url: "", searchText: "" }, true), true) &&
      assertEqual(isTrackableItem({ name: "30th Celebration Elite Trainer Box", price: "$99.95", url: "", searchText: "" }, true), true) &&
      assertEqual(isTrackableItem({ name: "30th Celebration Elite Trainer Box", price: "$249.00", url: "", searchText: "" }, true), false) &&
      // Bundle RRP ~$55, +15% cap ≈ $63 — $60 is allowed, $80 is not
      assertEqual(isTrackableItem({ name: "Shrouded Fable Booster Bundle", price: "$60.00", url: "", searchText: "" }, true), true) &&
      assertEqual(isTrackableItem({ name: "Shrouded Fable Booster Bundle", price: "$80.00", url: "", searchText: "" }, true), false) &&
      assertEqual(overRetailNote("Booster Bundle", "$60.00"), " (~+9% over retail)") &&
      assertEqual(overRetailNote("Booster Bundle", "$55.00"), ""),
  });
  results.push({
    name: "Real sealed products still pass (Knock Out Collection, UPC, case)",
    pass: assertEqual(isTrackableItem({ name: "Pokemon 30th Celebration Knock Out Collection - Pokemon TCG", price: "$59.95", url: "", searchText: "" }, true), true) &&
      assertEqual(isTrackableItem({ name: "Mega Charizard X ex Ultra-Premium Collection", price: "$199.95", url: "", searchText: "" }, true), true) &&
      assertEqual(isTrackableItem({ name: "Pokemon Booster Bundle Display (6 bundles)", price: "$270.00", url: "", searchText: "" }, true), true),
  });
  results.push({
    name: "isPokemonScoped detects a Pokemon collection URL",
    pass: assertEqual(isPokemonScoped({ url: "https://x.com/collections/pokemon-tcg/products.json" }), true) && assertEqual(isPokemonScoped({ url: "https://x.com/products.json" }), false),
  });
  results.push({
    name: "isHotItem: watched set, recent discovery, and old item",
    pass: (() => {
      const now = Date.parse("2026-10-03T00:00:00Z");
      return (
        isHotItem("30th Celebration ETB", undefined, ["30th"], now) === true &&
        isHotItem("Brand New Set ETB", "2026-09-20T00:00:00Z", ["30th"], now) === true &&
        isHotItem("Old Set ETB", "2026-06-01T00:00:00Z", ["30th"], now) === false &&
        isHotItem("Old Set ETB", undefined, ["30th"], now) === false
      );
    })(),
  });
  results.push({
    name: "mapShopifyProducts shows the cheapest in-stock variant price",
    pass: (() => {
      const sample = [{ handle: "x", title: "X", variants: [{ available: false, price: "10.00" }, { available: true, price: "50.00" }] }];
      return mapShopifyProducts(sample, "https://example.com")[0].price === "$50.00";
    })(),
  });
  results.push({
    name: "cooldown logic marks and detects correctly",
    pass: (() => {
      const scratchState = {};
      if (isOnCooldown(scratchState, "test-item")) return false;
      markCooldown(scratchState, "test-item");
      return isOnCooldown(scratchState, "test-item") === true;
    })(),
  });

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  return { passed, total: results.length, failed };
}

function buildTrackingSummary(config, snapshot) {
  const sets = (Array.isArray(config.activeSets) ? config.activeSets : []).filter(Boolean);
  const lines = [];
  lines.push(sets.length
    ? `\ud83c\udfaf <b>Watched sets:</b> ${sets.map(escHtml).join(", ")}`
    : "\ud83c\udfaf <b>Watched sets:</b> none yet");
  lines.push("<i>New sets are added automatically when announced.</i>");
  let counted = 0;
  const seen = new Set();
  for (const set of sets) {
    const k = set.toLowerCase();
    const hits = snapshot.filter((p) => p.name.toLowerCase().includes(k));
    hits.forEach((p) => seen.add(p));
    counted += hits.length;
    lines.push(`\u2022 ${escHtml(set)}: ${hits.length} listings, ${hits.filter((p) => p.available).length} in stock now`);
  }
  const other = snapshot.filter((p) => !seen.has(p));
  // Snapshot counts are health metrics only (not a browsable catalogue).
  lines.push(`\u2022 Scanning ${snapshot.length} sealed listings this run (${snapshot.filter((p) => p.available).length} currently orderable)`);
  lines.push(`\ud83c\udfea ${(config.targets || []).length} sources \u00b7 retail filter +${Math.round(priceTolerance * 100)}% \u00b7 ${lowPriorityMode === "off" ? "priority alerts only" : "other alerts silent"}`);
  return lines.join("\n");
}

async function maybeSendHeartbeat(state, healthReport, config) {
  const KEY = "_heartbeat";
  const today = new Date().toISOString().slice(0, 10);
  const prev = state[KEY] || {};
  if (prev.lastSentDate === today) return;

  const okCount = healthReport.ok.length;
  const failCount = (healthReport.failed || []).length;
  const blockedCount = (healthReport.blocked || []).length;

  let detail = "";
  if (blockedCount) {
    detail += `\n\n🚫 Blocked by anti-bot (${blockedCount}):\n` + healthReport.blocked.map((n) => `• ${n}`).join("\n");
  }
  if (failCount) {
    detail += `\n\n⚠️ Other failures (${failCount}):\n` + healthReport.failed.map((n) => `• ${n}`).join("\n");
  }

  const selfTest = runSelfTest();
  setAlertSettings(config || {}); // the self-test resets these; restore real settings
  setPriceCaps(config || {}, state);
  const selfTestLine =
    selfTest.passed === selfTest.total
      ? `🧪 Self-test: ${selfTest.passed}/${selfTest.total} checks passed - all bot logic working correctly.`
      : `⚠️ Self-test: ${selfTest.passed}/${selfTest.total} checks passed.\nFailed: ${selfTest.failed.map((f) => f.name).join(", ")}`;

  await sendTelegram(
    `✅ <b>Daily heartbeat</b>\nBot is alive and running.\n${okCount} source(s) reachable, ${blockedCount} blocked, ${failCount} other failures.${detail}\n\n${buildTrackingSummary(config || {}, trackedSnapshot)}\n\n${selfTestLine}\n\nNo separate message means nothing new to report today.`
  );

  state[KEY] = { lastSentDate: today };
}

async function main() {
  if (TEST_ALERT) {
    console.log("TEST_ALERT mode: sending a one-off test message only.");
    const ok = await sendTelegram(
      "🧪 <b>Test alert</b>\nIf this reached Telegram, the pipeline works end-to-end."
    );
    console.log(ok ? "Test message sent successfully." : "Test message FAILED to send - check your secrets.");
    return;
  }

  const config = loadJson(CONFIG_PATH, { targets: [], activeSets: [] });
  const state = loadJson(STATE_PATH, {});
  setPriceCaps(config, state);
  setAlertSettings(config);
  const healthReport = { ok: [], failed: [], blocked: [] };

  // Check every target in PARALLEL - each is a different website, so no
  // single site receives more than one request per run. This is what makes
  // running more often actually affordable, since total run time is now
  // bound by the slowest single site, not the sum of all of them.
  await Promise.all(
    config.targets.map(async (target) => {
      console.log(`Checking: ${target.name}`);
      if (target.type === "shopify") {
        state[target.name] = await checkShopifyTarget(target, state, config, healthReport);
      } else if (target.type === "constructor") {
        state[target.name] = await checkConstructorTarget(target, state, config, healthReport);
      } else {
        state[target.name] = await checkTarget(target, state, config, healthReport);
      }
    })
  );

  const sentCount = await flushAlerts();
  console.log(`Alert messages sent this run: ${sentCount}`);

  console.log("Checking for newly announced sets...");
  const configChanged = await checkNewSets(state, config, healthReport);
  if (configChanged) {
    console.log("New set(s) added to activeSets - saving config.json.");
    saveJson(CONFIG_PATH, config);
  }

  console.log("Checking whether the monthly retail-price check is due...");
  await maybeCalibratePrices(state, config);

  console.log("Checking whether a daily heartbeat is due...");
  await maybeSendHeartbeat(state, healthReport, config);

  saveJson(STATE_PATH, state);
  console.log(`Done. Reachable: ${healthReport.ok.length}, Failed: ${healthReport.failed.length}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runSelfTest, computeCalibration, isTrackableItem, isHotItem, isPokemonScoped, isSealedProduct,
  mapShopifyProducts, checkShopifyTarget, checkTarget, TRACKING_MODE,
};
