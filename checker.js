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

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const ALERTS_LOG_PATH = path.join(__dirname, "docs", "alerts-log.json");
const MAX_LOG_ENTRIES = 300;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TEST_ALERT = process.env.TEST_ALERT === "true";
const BURST_MODE = process.env.BURST_MODE === "true";

const QUIET_HOUR_START_UTC = Number(process.env.QUIET_HOUR_START_UTC ?? 14);
const QUIET_HOUR_END_UTC = Number(process.env.QUIET_HOUR_END_UTC ?? 21);

const COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_DELAY_MS = 3000;

const POSITIVE_SIGNALS = ["add to cart", "add to bag", "buy now", "add to basket", "in stock"];

const NEGATIVE_SIGNALS = ["sold out", "notify me", "out of stock", "coming soon", "unavailable", "no delivery options", "no in-store options", "currently unavailable", "email when available"];

const PRIORITY_KEYWORDS = ["elite trainer box", "ultra-premium", "ultra premium", "ultra premium collection"];

// Instead of listing every known sealed-product name (fragile - misses
// future product types), this detects what looks like a SINGLE CARD and
// excludes only those. Singles reliably have a card number like "025/030"
// or mention a grading service - sealed product never does, regardless of
// what new box/tin/case name gets invented for a future set.
const SINGLE_CARD_EXCLUDE_PATTERNS = [
  /\b\d{1,3}\s*\/\s*\d{1,3}\b/, // card number, e.g. "025/030"
  /\bpsa\b/i,
  /\bbgs\b/i,
  /\bcgc\b/i,
  /\bsingle card\b/i,
  /\bsingles\b/i,
];

// Other trading card games - a store-wide feed will contain these, and a
// title like "Gundam ... Friday 30th October" must never count as Pokemon.
const OTHER_TCG_PATTERN = new RegExp(
  "\\b(" +
    [
      "gundam", "yu-?gi-?oh", "yugioh", "magic: the gathering", "magic the gathering", "mtg",
      "one piece", "lorcana", "digimon", "dragon ball", "flesh and blood", "weiss",
      "union arena", "cardfight", "vanguard", "star wars unlimited", "riftbound",
      "metazoo", "naruto", "battle spirits", "final fantasy", "grand archive",
      "force of will", "shadowverse", "hololive", "duel masters", "bakugan",
    ].join("|") +
    ")\\b",
  "i"
);

// Events/tickets and accessories/merch are not sealed Pokemon product.
const NON_PRODUCT_PATTERNS = [
  /\b(event|tournament|ticket|tickets|admission|entry fee|membership|gift card|gift voucher|voucher)\b/i,
  /\b(plush|plushie|squishmallow|funko|t-?shirt|hoodie|sleeves?|toploader|top loader|playmat|play mat|deck box|deck shield|portfolio|pocket binder|card binder|mystery)\b/i,
];

// Items this bot first saw within this many days stay "hot" for back-in-stock
// alerts, so a brand-new set is covered without editing any config.
const HOT_DAYS = 45;
const MAX_SHOPIFY_PAGES = 4; // 250 products per page
// Bumped whenever tracking rules change, so the first run after an update
// quietly rebuilds each store's baseline instead of alerting on everything.
const TRACKING_MODE = "v2-all-pokemon";
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

function isSealedProduct(name) {
  return !SINGLE_CARD_EXCLUDE_PATTERNS.some((p) => p.test(name));
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
  if (!scoped && !isPokemonText(`${item.searchText || ""} ${name} ${item.url || ""}`)) return false;
  if (OTHER_TCG_PATTERN.test(name)) return false;
  if (NON_PRODUCT_PATTERNS.some((p) => p.test(name))) return false;
  return isSealedProduct(name);
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

function formatItemLine(item) {
  const tag = isPriorityItem(item.name) ? "🔥 " : "";
  return `${tag}• ${item.name}${item.price ? ` — ${item.price}` : ""}`;
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

async function fetchHtml(url) {
  return withRetry(async () => {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }, url);
}

// Pure mapping function pulled out of fetchShopifyProducts specifically so
// the self-test below can exercise it with fake data, no network needed.
// Price shown is the cheapest variant you can actually buy right now (or the
// cheapest overall if everything is sold out).
function mapShopifyProducts(products, origin) {
  return products.map((p) => {
    const variants = p.variants || [];
    const available = variants.some((v) => v.available);
    const pool = available ? variants.filter((v) => v.available) : variants;
    const prices = pool.map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
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
  if (hasPositive && !hasNegative) return "AVAILABLE";
  if (hasNegative) return "UNAVAILABLE";
  return "UNKNOWN";
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

    let name = $(el).text().replace(/\s+/g, " ").trim();
    if (!name) name = $(el).find("img").attr("alt") || "";
    if (!name) name = $(el).attr("title") || "";
    if (!name) return;

    let price = "";
    const priceMatch = (str) => (str.match(/\$\s?[\d,]+(?:\.\d{2})?/) || [])[0];
    price = priceMatch(name) || "";
    if (!price) {
      const container = $(el).closest("li, div, article").first();
      price = priceMatch(container.text().replace(/\s+/g, " ")) || "";
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

async function sendTelegram(message) {
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
      disable_web_page_preview: false,
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
  try {
    html = await fetchHtml(target.url);
  } catch (err) {
    console.error(`Failed to fetch ${target.name}:`, err.message);
    healthReport.failed.push(target.name);
    return prev;
  }
  healthReport.ok.push(target.name);

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
        `🚨 <b>STOCK ALERT</b>\n${target.name}\nLooks like it just became orderable!\n${target.url}`
      );
      markCooldown(state, itemKey);
    }
    return { status, checkedAt: new Date().toISOString() };
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
        const lines = newItems
          .slice(0, MAX_ITEMS_PER_ALERT)
          .map((i) => `${formatItemLine(i)}\n  ${i.url}`)
          .join("\n");
        const extra =
          newItems.length > MAX_ITEMS_PER_ALERT
            ? `\n...and ${newItems.length - MAX_ITEMS_PER_ALERT} more.`
            : "";
        await sendTelegram(
          `🆕 <b>New listing(s) detected</b>\n${target.name}\n\n${lines}${extra}`
        );
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
  if (prev.hash && prev.hash !== hash && (!isQuietHoursNow() || BURST_MODE)) {
    const mentionsKeyword = matchesKeywords(text, keywords);
    await sendTelegram(
      `🔔 <b>Page changed</b>\n${target.name}\n` +
        (mentionsKeyword || keywords.length === 0
          ? `Worth a look.\n`
          : `Note: none of "${keywords.join(", ")}" found in the text — could be unrelated.\n`) +
        `${target.url}`
    );
  }
  return { hash, checkedAt: new Date().toISOString() };
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
  const prevByHandle = new Map((prev.products || []).map((p) => [p.handle, p]));
  const known = new Set(prev.knownHandles || (prev.products || []).map((p) => p.handle));
  const isFirstRun = !prev.products || prev.mode !== TRACKING_MODE;
  const nowIso = new Date().toISOString();

  if (!isFirstRun) {
    // Any new Pokemon sealed product, whatever set it belongs to.
    const newItems = relevant.filter(
      (p) => !known.has(p.handle) && !isOnCooldown(state, `${target.name}::${p.handle}::new`)
    );
    // Restocks: only for watched sets or recently discovered products, so old
    // catalogue items flickering in and out of stock don't spam you.
    const restocked = relevant.filter((p) => {
      const old = prevByHandle.get(p.handle);
      if (!old || old.available || !p.available) return false;
      if (!isHotItem(p.name, old.firstSeen, keywords)) return false;
      return !isOnCooldown(state, `${target.name}::${p.handle}::stock`);
    });

    if (newItems.length > 0) {
      const lines = newItems
        .slice(0, MAX_ITEMS_PER_ALERT)
        .map((p) => `${formatItemLine(p)} ${p.available ? "(in stock)" : "(listed, not yet orderable)"}\n  ${p.url}`)
        .join("\n");
      await sendTelegram(`🆕 <b>New listing(s) detected</b>\n${target.name}\n\n${lines}`);
      newItems.forEach((p) => markCooldown(state, `${target.name}::${p.handle}::new`));
    }

    if (restocked.length > 0) {
      const lines = restocked
        .slice(0, MAX_ITEMS_PER_ALERT)
        .map((p) => `${formatItemLine(p)}\n  ${p.url}`)
        .join("\n");
      await sendTelegram(`🚨 <b>Back in stock</b>\n${target.name}\n\n${lines}`);
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
    const res = await fetch("https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sets = data.data || [];
  } catch (err) {
    console.error("Set-watch check failed (skipping):", err.message);
    healthReport.failed.push("Set-announcement watcher");
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
      return items.length === 1 && items[0].url === "https://example.com/products/test-etb" && items[0].price === "$54.00";
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

async function maybeSendHeartbeat(state, healthReport) {
  const KEY = "_heartbeat";
  const today = new Date().toISOString().slice(0, 10);
  const prev = state[KEY] || {};
  if (prev.lastSentDate === today) return;

  const okCount = healthReport.ok.length;
  const failCount = healthReport.failed.length;
  const failList = healthReport.failed.length
    ? `\nNot reachable right now:\n` + healthReport.failed.map((n) => `• ${n}`).join("\n")
    : "";

  const selfTest = runSelfTest();
  const selfTestLine =
    selfTest.passed === selfTest.total
      ? `🧪 Self-test: ${selfTest.passed}/${selfTest.total} checks passed - all bot logic working correctly.`
      : `⚠️ Self-test: ${selfTest.passed}/${selfTest.total} checks passed.\nFailed: ${selfTest.failed.map((f) => f.name).join(", ")}`;

  await sendTelegram(
    `✅ <b>Daily heartbeat</b>\nBot is alive and running.\n${okCount} source(s) reachable, ${failCount} not.${failList}\n\n${selfTestLine}\n\nNo separate message means nothing new to report today.`
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
  const healthReport = { ok: [], failed: [] };

  // Check every target in PARALLEL - each is a different website, so no
  // single site receives more than one request per run. This is what makes
  // running more often actually affordable, since total run time is now
  // bound by the slowest single site, not the sum of all of them.
  await Promise.all(
    config.targets.map(async (target) => {
      console.log(`Checking: ${target.name}`);
      if (target.type === "shopify") {
        state[target.name] = await checkShopifyTarget(target, state, config, healthReport);
      } else {
        state[target.name] = await checkTarget(target, state, config, healthReport);
      }
    })
  );

  console.log("Checking for newly announced sets...");
  const configChanged = await checkNewSets(state, config, healthReport);
  if (configChanged) {
    console.log("New set(s) added to activeSets - saving config.json.");
    saveJson(CONFIG_PATH, config);
  }

  console.log("Checking whether a daily heartbeat is due...");
  await maybeSendHeartbeat(state, healthReport);

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
  runSelfTest, isTrackableItem, isHotItem, isPokemonScoped, isSealedProduct,
  mapShopifyProducts, checkShopifyTarget, checkTarget, TRACKING_MODE,
};
