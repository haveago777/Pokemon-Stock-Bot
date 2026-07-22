# Pokemon TCG 30th Celebration - AU Stock Watcher

Checks a list of Australian retailer pages every 10 minutes and pings you on
Telegram when a product looks like it's become orderable, or when a watched
page changes.

Runs entirely on GitHub's free Actions minutes - no server, no hosting cost,
nothing running on your own phone or PC.

## 1. Create a Telegram bot (2 minutes)

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts.
2. It gives you a **bot token** like `123456:ABC-DEF...`. Save it.
3. Send your new bot any message (e.g. "hi") so it knows who you are.
4. Visit this URL in your browser (replace the token):
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
5. Find `"chat":{"id":123456789,...}` in the response - that number is your **chat ID**.

## 2. Put this project on GitHub

1. Create a new **private** GitHub repo.
2. Upload all these files (or `git init` + push from this folder).

## 3. Add your secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**

- `TELEGRAM_BOT_TOKEN` = the token from BotFather
- `TELEGRAM_CHAT_ID` = the chat ID you found above

## 4. Turn it on

- Go to the **Actions** tab, enable workflows if prompted.
- Click **Watch Pokemon TCG Stock → Run workflow** to test it once manually.
- After that it runs automatically every 10 minutes.

## What's new: listing detection + set announcements

The bot now does three things instead of one:

1. **Product pages** (JB Hi-Fi's two listed items) — same as before: alerts
   when "Add to Cart" replaces "Sold Out"/"Notify Me".
2. **Category/search pages** — now actually reads out the individual product
   listings on the page (name, link, price where findable) and alerts you
   only on genuinely **new** listings, not just "the page looks different."
   Only listings matching the `"keyword"` field are considered — so a new
   Squishmallow on Collectible Madness won't ping you, but a new "30th"
   product will. `"keyword"` can be a single word, or several separated by
   commas (e.g. `"30th, Celebration, Mega"`) to watch for more than one set
   at once.
   - If a site's product links don't match any recognised pattern, it
     automatically falls back to the old "page changed" alert instead.
3. **New set announcements** — separately, once a run, it checks the public
   Pokémon TCG set list and pings you the moment a brand-new set (not yet in
   its records) appears, with the set name and release date. This means you
   find out about new sets without watching for announcements yourself.

## Retailers currently watched

Big W, Kmart, Target, JB Hi-Fi, EB Games, ZiNG Pop Culture, Pokémon Center
Australia, Good Games, Kollecter, TCGroup AU, Collectible Madness, and Amazon
AU (flagged separately below).

A couple of notes on these:
- **Amazon AU** is included but is the least reliable entry - Amazon actively
  blocks automated requests, so expect this one to fail or return errors more
  often than the others. It's not worth relying on alone.
- **Collectible Madness** prices looked reasonable when checked, but it's a
  mixed marketplace store (also sells other TCGs, toys, etc.) rather than a
  single-brand official retailer - worth glancing at yourself if you want to
  confirm it's pricing at or near RRP before trusting its alerts.
- Grailborne was deliberately left out - it was flagged as pricing well above
  retail rather than selling at RRP.

## 5. Edit `config.json` as real product pages appear

Right now most retailers only have search/category pages or placeholder
listings up (preorders for 30th Celebration haven't opened yet as of writing).
As soon as you spot a real product URL (e.g. an actual preorder page), add it
to `config.json` as a `"type": "product"` entry - that gives you the sharpest,
most reliable alert (it looks for "Add to Cart" appearing).

`"type": "page"` entries (search/category pages) are a broader net - they'll
ping you on *any* change to the page, so expect a few noisy/false alerts from
those. Tighten the `"keyword"` field to cut down noise.

## Notes on etiquette

- The 10-minute interval and 2-second gap between requests per run are
  deliberately conservative - this is meant to check pages the way a person
  refreshing a tab would, not hammer a retailer's servers.
- This only reads public pages - it doesn't attempt to bypass any bot
  protection, log in, or automate checkout. You still add to cart and pay
  yourself, manually, when you get the alert.
- If a retailer's page returns errors repeatedly, best to loosen the interval
  or drop that target rather than push through it.
