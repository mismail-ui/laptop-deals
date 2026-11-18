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

## IT disposal leads tab (LinkedIn posts)

The **♻️ IT disposal leads** tab lists public LinkedIn posts from organisations
in the UK and Europe that want redundant IT equipment collected, disposed of or
sold (plus traders listing surplus stock).

It does **not** log in to or scrape LinkedIn. Twice a day
`.github/workflows/buyback.yml` runs `scripts/buyback.mjs`, which asks a
web-search API for matching public posts and writes `buyback.json`. Cards show
the post text, type, region, and any quantity / models / price it can pick out,
with a link to the post. The poster's name is not shown.

**To switch it on**, add ONE search key as a repository secret
(repo → Settings → Secrets and variables → Actions → New repository secret):

| Secret name | Service | Notes |
|---|---|---|
| `SERPAPI_KEY` | serpapi.com | Google results — best coverage of LinkedIn posts. Small free monthly allowance; the job is sized to about 240 searches a month. |
| `TAVILY_API_KEY` | tavily.com | Free monthly allowance, no card needed. |
| `BRAVE_API_KEY` | Brave Search API | Monthly credit; needs a card on file. |

Check the provider's current free allowance before signing up — they change.
Then run **Actions → Find IT disposal leads → Run workflow** once.

**Limits:** search engines only index public posts, often a day or more late,
and miss many. For anything you spot in your own feed, use **+ Add a post
you've seen** on the tab: it opens a short GitHub form (link + pasted text), and
`.github/workflows/add-post.yml` adds it to `buyback-manual.json`. Only the repo
owner / collaborators can add posts. The repo is public, so what you paste is too.

## Run locally (optional)

```
node scripts/refresh.mjs   # writes deals.json
SERPAPI_KEY=... node scripts/buyback.mjs   # writes buyback.json (optional)
node --test scripts/buyback.test.mjs       # tests for the leads finder
# then open index.html via a local server, e.g.:
npx serve .
```
