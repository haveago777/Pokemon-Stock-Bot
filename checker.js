// Pokemon TCG 30th Celebration - AU stock watcher
// Fetches each target in config.json, works out if something changed,
// and sends a Telegram message when it looks like stock/preorders opened
// or a new matching product listing appears.

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POSITIVE_SIGNALS = [
  "add to cart",
  "add to bag",
  "buy now",
  "add to basket",
  "in stock",
];

const NEGATIVE_SIGNALS = [
  "sold out",
  "notify me",
  "out of stock",
  "coming soon",
  "unavailable",
  "no delivery options",
  "no in-store options",
  "currently unavailable",
  "email when available",
];

// Common product-URL shapes across AU retail platforms.
// Shopify stores (most of the dedicated card shops) use /products/.
// Big W confirmed to use /product/.../p/12345. Others (/p/, /dp/) cover
// Kmart/Target/Amazon-style patterns. If a site matches none of these,
// we fall back to whole-page change detection for it automatically.
const PRODUCT_LINK_PATTERNS = [/\/products\//i, /\/product\//i, /\/dp\//i, /\/p\//i];

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

function getKeywords(target) {
  const raw = target.keyword;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((k) => k.trim().toLowerCase()).filter(Boolean);
}

function matchesKeywords(text, keywords) {
  if (keywords.length === 0) return true;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-AU,en;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
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

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[no telegram configured] would have sent:\n" + message);
    return;
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
  }
}

async function checkTarget(target, state) {
  const prev = state[target.name] || {};
  let html;
  try {
    html = await fetchHtml(target.url);
  } catch (err) {
    console.error(`Failed to fetch ${target.name}:`, err.message);
    return prev;
  }

  if (target.type === "product") {
    const text = htmlToText(html);
    const status = classifyProductPage(text);
    if (prev.status && prev.status !== "AVAILABLE" && status === "AVAILABLE") {
      await sendTelegram(
        `🚨 <b>STOCK ALERT</b>\n${target.name}\nLooks like it just became orderable!\n${target.url}`
      );
    }
    return { status, checkedAt: new Date().toISOString() };
  }

  const keywords = getKeywords(target);
  const allItems = extractProductLinks(html, target.url);

  if (allItems.length > 0) {
    const relevant = allItems.filter(
      (item) => matchesKeywords(item.name, keywords) || matchesKeywords(item.url, keywords)
    );
    const relevantUrls = relevant.map((i) => i.url);
    const prevUrls = new Set(prev.itemUrls || []);
    const isFirstRun = !prev.itemUrls;

    if (!isFirstRun) {
      const newItems = relevant.filter((i) => !prevUrls.has(i.url));
      if (newItems.length > 0) {
        const lines = newItems
          .slice(0, MAX_ITEMS_PER_ALERT)
          .map((i) => `• ${i.name}${i.price ? ` — ${i.price}` : ""}\n  ${i.url}`)
          .join("\n");
        const extra =
          newItems.length > MAX_ITEMS_PER_ALERT
            ? `\n...and ${newItems.length - MAX_ITEMS_PER_ALERT} more.`
            : "";
        await sendTelegram(
          `🆕 <b>New listing(s) detected</b>\n${target.name}\n\n${lines}${extra}`
        );
      }
    }

    return { itemUrls: relevantUrls, checkedAt: new Date().toISOString() };
  }

  const text = htmlToText(html);
  const hash = simpleHash(text);
  if (prev.hash && prev.hash !== hash) {
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

async function checkNewSets(state) {
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
    return;
  }

  const knownIds = new Set(prev.knownSetIds || []);
  const newSets = sets.filter((s) => !knownIds.has(s.id));

  if (!isFirstRun && newSets.length > 0) {
    const lines = newSets
      .slice(0, MAX_ITEMS_PER_ALERT)
      .map((s) => `• ${s.name} (${s.series}) — release ${s.releaseDate}`)
      .join("\n");
    await sendTelegram(`📣 <b>New Pokémon TCG set announced</b>\n\n${lines}`);
  }

  state[KEY] = {
    knownSetIds: sets.map((s) => s.id),
    checkedAt: new Date().toISOString(),
  };
}

async function main() {
  const config = loadJson(CONFIG_PATH, { targets: [] });
  const state = loadJson(STATE_PATH, {});

  for (const target of config.targets) {
    console.log(`Checking: ${target.name}`);
    state[target.name] = await checkTarget(target, state);
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("Checking for newly announced sets...");
  await checkNewSets(state);

  saveJson(STATE_PATH, state);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
