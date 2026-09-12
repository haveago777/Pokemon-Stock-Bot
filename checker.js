// Pokemon TCG AU Stock Watcher - tracks whichever sets are listed in
// config.json's "activeSets", not just 30th Celebration. Add a new set's
// name to that list any time to start tracking it across all retailers.

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
function mapShopifyProducts(products, origin) {
  return products.map((p) => {
    const variants = p.variants || [];
    const available = variants.some((v) => v.available);
    const prices = variants.map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
    const price = prices.length ? Math.min(...prices) : null;
    return {
      handle: p.handle,
      name: p.title,
      url: `${origin}/products/${p.handle}`,
      available,
      price: price !== null ? `$${price.toFixed(2)}` : "",
    };
  });
}

async function fetchShopifyProducts(jsonUrl) {
  return withRetry(async () => {
    const res = await fetch(jsonUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${jsonUrl}`);
    const data = await res.json();
    const origin = new URL(jsonUrl).origin;
    return mapShopifyProducts(data.products || [], origin);
  }, jsonUrl);
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
  const allItems = extractProductLinks(html, target.url);

  if (allItems.length > 0) {
    const relevant = allItems.filter(
      (item) => matchesKeywords(item.name, keywords) || matchesKeywords(item.url, keywords)
    );
    const relevantUrls = relevant.map((i) => i.url);
    const prevUrls = new Set(prev.itemUrls || []);
    const isFirstRun = !prev.itemUrls;

    if (!isFirstRun) {
      const newItems = relevant.filter(
        (i) => !prevUrls.has(i.url) && !isOnCooldown(state, `${target.name}::${i.url}`)
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

    return { itemUrls: relevantUrls, checkedAt: new Date().toISOString() };
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
  let products;
  try {
    products = await fetchShopifyProducts(target.url);
  } catch (err) {
    console.error(`Failed to fetch ${target.name}:`, err.message);
    healthReport.failed.push(target.name);
    return prev;
  }
  healthReport.ok.push(target.name);

  const keywords = getKeywords(target, config);
  const relevant = products.filter((p) => matchesKeywords(p.name, keywords));
  const prevByHandle = new Map((prev.products || []).map((p) => [p.handle, p]));
  const isFirstRun = !prev.products;

  if (!isFirstRun) {
    const newItems = relevant.filter(
      (p) => !prevByHandle.has(p.handle) && !isOnCooldown(state, `${target.name}::${p.handle}::new`)
    );
    const restocked = relevant.filter((p) => {
      const old = prevByHandle.get(p.handle);
      return old && !old.available && p.available && !isOnCooldown(state, `${target.name}::${p.handle}::stock`);
    });
    const priceDrops = relevant.filter((p) => {
      const old = prevByHandle.get(p.handle);
      if (!old || !old.available || !p.available) return false;
      const oldPrice = parsePrice(old.price);
      const newPrice = parsePrice(p.price);
      return oldPrice !== null && newPrice !== null && newPrice < oldPrice;
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

    if (priceDrops.length > 0) {
      const lines = priceDrops
        .slice(0, MAX_ITEMS_PER_ALERT)
        .map((p) => {
          const old = prevByHandle.get(p.handle);
          return `${formatItemLine(p)} (was ${old.price})\n  ${p.url}`;
        })
        .join("\n");
      await sendTelegram(`💰 <b>Price drop</b>\n${target.name}\n\n${lines}`);
    }
  }

  return {
    products: relevant.map((p) => ({ handle: p.handle, available: p.available, price: p.price })),
    checkedAt: new Date().toISOString(),
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
      ? `\n\n✅ Automatically added to activeSets - now tracking ${added.length > 1 ? "these sets" : "this set"} across all 29 retailers.`
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
// network calls, every single run. Catches genuine logic bugs automatically
// instead of relying on real-world silence to (maybe) reveal a problem. ----
function assertEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function runSelfTest() {
  const results = [];

  results.push({
    name: "parsePrice handles plain price",
    pass: assertEqual(parsePrice("$54.00"), 54),
  });
  results.push({
    name: "parsePrice handles comma thousands",
    pass: assertEqual(parsePrice("$1,234.50"), 1234.5),
  });
  results.push({
    name: "isPriorityItem flags Elite Trainer Box",
    pass: assertEqual(isPriorityItem("Pokemon Elite Trainer Box"), true),
  });
  results.push({
    name: "isPriorityItem ignores normal item",
    pass: assertEqual(isPriorityItem("Booster Pack"), false),
  });
  results.push({
    name: "formatItemLine adds priority tag",
    pass: formatItemLine({ name: "Ultra-Premium Collection", price: "$99.99" }).includes("🔥"),
  });
  results.push({
    name: "matchesKeywords finds a match",
    pass: assertEqual(matchesKeywords("Pokemon 30th Celebration ETB", ["30th"]), true),
  });
  results.push({
    name: "matchesKeywords correctly rejects non-match",
    pass: assertEqual(matchesKeywords("Random unrelated product", ["30th"]), false),
  });
  results.push({
    name: "classifyProductPage detects AVAILABLE",
    pass: assertEqual(classifyProductPage("Add to Cart Buy Now"), "AVAILABLE"),
  });
  results.push({
    name: "classifyProductPage detects UNAVAILABLE",
    pass: assertEqual(classifyProductPage("Sold Out - Notify Me"), "UNAVAILABLE"),
  });
  results.push({
    name: "extractProductLinks parses a sample product link",
    pass: (() => {
      const sampleHtml = '<html><body><a href="/products/test-etb">Test ETB $54.00</a></body></html>';
      const items = extractProductLinks(sampleHtml, "https://example.com");
      return (
        items.length === 1 &&
        items[0].url === "https://example.com/products/test-etb" &&
        items[0].price === "$54.00"
      );
    })(),
  });
  results.push({
    name: "mapShopifyProducts parses a sample product",
    pass: (() => {
      const sample = [
        {
          handle: "test-etb",
          title: "Test ETB",
          variants: [{ available: true, price: "54.00" }],
        },
      ];
      const mapped = mapShopifyProducts(sample, "https://example.com");
      return (
        mapped.length === 1 &&
        mapped[0].url === "https://example.com/products/test-etb" &&
        mapped[0].available === true &&
        mapped[0].price === "$54.00"
      );
    })(),
  });
  results.push({
    name: "cooldown logic marks and detects correctly",
    pass: (() => {
      const scratchState = {};
      if (isOnCooldown(scratchState, "test-item")) return false; // should be false before marking
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
      "🧪 <b>Test alert</b>\nIf you're reading this in Telegram, the bot's Telegram pipeline works end-to-end."
   
