# Laptop Deals Tracker — always-on (free)

A self-updating page of the best new-laptop deals in the UK (£) and US ($).
It refreshes **hourly on its own** — no laptop or app needed — by pulling free
community deal feeds (hotukdeals, dealnews, Slickdeals) and republishing.

**Cost: £0.** No API keys. Runs on free GitHub Actions + free Vercel hosting.

## How it works

```
GitHub Actions (hourly cron)
   └─ runs scripts/refresh.mjs
        └─ fetches RSS feeds → filters to NEW laptops → writes deals.json
   └─ commits deals.json
        └─ Vercel auto-deploys → your public link updates
```

`index.html` loads `deals.json` in the browser, so only the data file changes
each hour. Cards show price, discount, store, category and any specs the feed
exposes (CPU / RAM / storage / screen / GPU), with a link straight to the deal.

## One-time setup (~10 min)

1. **Create a free GitHub account** (if you don't have one) at github.com.
2. **Make a new repository** — e.g. `laptop-deals`. Public is fine.
3. **Upload these files** keeping the folder structure:
   ```
   index.html
   deals.json
   scripts/refresh.mjs
   .github/workflows/refresh.yml
   ```
   (You can drag-and-drop them in GitHub's "Add file → Upload files".)
   You can delete the leftover `public/` folder if present — it's not used.
4. **Turn on Actions:** repo → **Actions** tab → enable workflows. Then open
   "Refresh laptop deals" → **Run workflow** once to confirm it works.
5. **Connect Vercel:** vercel.com → **Add New → Project → Import** your GitHub
   repo. Framework preset: **Other**. No build command. Deploy.
6. Done. Vercel gives you a link (e.g. `laptop-deals.vercel.app`) — share it.
   From now on every hourly commit auto-deploys, so the link stays current.

## Notes

- GitHub's scheduled runs can be delayed a few minutes under load, and Actions
  pause if the repo has **no activity for 60 days** — just open it occasionally,
  or click "Run workflow" to wake it.
- Feeds give reliable price/discount/link; full specs are best-effort from the
  deal title. To guarantee full specs on every card, see the upgrade below.

## Optional upgrade — full specs on every card

Add a small step that asks Claude (Haiku 4.5 — the cheapest model, ~$0.15–0.25
/day at hourly) to fill missing CPU/RAM/storage/screen from each deal title.
Discovery stays free via RSS; only spec-filling uses the API. Ask and this can
be wired in: it reads an `ANTHROPIC_API_KEY` GitHub secret and enriches
`deals.json` before commit.

## Run locally (optional)

```
node scripts/refresh.mjs   # writes deals.json
# then open index.html via a local server, e.g.:
npx serve .
```
