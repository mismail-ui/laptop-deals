// refresh.mjs — pulls laptop deals from free community RSS feeds and writes public/deals.json.
// No dependencies, no API key. Run: node scripts/refresh.mjs   (Node 18+)
// Designed to run hourly via GitHub Actions.

import { writeFileSync } from "node:fs";

const FEEDS = {
  // hotukdeals exposes a structured per-tag laptop feed incl. merchant name + price.
  uk: [{ url: "https://www.hotukdeals.com/rss/tag/laptop" }],
  // dealnews has a laptop-category feed; Slickdeals' main feed is keyword-filtered.
  us: [
    { url: "https://www.dealnews.com/c49/Computers/Laptops/?rss=1", retailerHint: "dealnews" },
    { url: "https://feeds.feedburner.com/SlickdealsnetUP",          retailerHint: "Slickdeals" }
  ]
};

const LAPTOP_RE = /\b(laptop|notebook|chromebook|macbook|ultrabook|ideapad|thinkpad|vivobook|zenbook|inspiron|latitude|pavilion|omnibook|omen|victus|aspire|swift|nitro|legion|loq|rog|tuf|yoga|surface laptop|gram|matebook|galaxy book)\b/i;
const EXCLUDE_RE = /\b(case|sleeve|charger|adapter|dock|docking|hub|stand|bag|skin|screen protector|ram kit|battery replacement|keyboard|mouse|monitor|backpack|cooling pad|cooler|tablet|refurb(?:ished)?|renewed|open[\s-]?box|used|pre[\s-]?owned|grade [abc])\b/i;
const US_STORES = ["Best Buy","Walmart","Amazon","Costco","Dell","Lenovo","HP","Newegg","Micro Center","B&H","Target","Woot","Adorama","Acer","ASUS","Samsung","Staples"];

function decode(s){
  return (s||"")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&#0?39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/&pound;/g,"£")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n))
    .replace(/\s+/g," ").trim();
}

function parseItems(xml){
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))){
    const b = m[0];
    const title = decode((b.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]);
    const link  = decode((b.match(/<link>([\s\S]*?)<\/link>/i)||[])[1]);
    if (!title || !link) continue;
    const merchant = (b.match(/<pepper:merchant\b[^>]*\bname="([^"]+)"/i)||[])[1] || null;
    const mprice   = (b.match(/<pepper:merchant\b[^>]*\bprice="([^"]+)"/i)||[])[1] || null;
    items.push({ title, link, merchant, mprice });
  }
  return items;
}

function num(str){
  if (!str) return null;
  const m = String(str).match(/([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g,""));
  return Number.isFinite(n) ? Math.round(n) : null;
}
function priceFromTitle(title, sym){
  const re = sym === "£" ? /£\s?([\d,]+(?:\.\d{1,2})?)/ : /\$\s?([\d,]+(?:\.\d{1,2})?)/;
  return num((title.match(re)||[])[1]);
}
function wasFrom(title, sym){
  const s = sym === "£" ? "£" : "\\$";
  const m = title.match(new RegExp("(?:was|rrp|orig(?:inal)?|down from|reg(?:ularly)?)\\D{0,8}" + s + "\\s?([\\d,]+)", "i"));
  return num((m||[])[1]);
}
function usRetailer(title){
  for (const s of US_STORES) if (new RegExp("\\b"+s.replace(/[&]/g,"\\&")+"\\b","i").test(title)) return s;
  return null;
}

function categorize(t){
  t = t.toLowerCase();
  if (/macbook|mac mini|imac/.test(t)) return "Mac";
  if (/chromebook/.test(t)) return "Chromebook";
  if (/rtx|gtx|gaming|omen|victus|nitro|legion|loq|rog|tuf|alienware/.test(t)) return "Gaming";
  if (/surface|ultrabook|zenbook|yoga|gram|swift|oled/.test(t)) return "Premium / ultrabook";
  return "Windows laptop";
}
function specGuess(t){
  const g = {}; let m;
  if ((m = t.match(/\b(ryzen\s?ai\s?\d\s?\w*|ryzen\s?[3579]\s?\w*|core\s?ultra\s?[3579]\s?\w*|core\s?i[3579][\w-]*|snapdragon\s?x\s?\w*|apple\s?m[1-4]\s?\w*|celeron|pentium)\b/i))) g.cpu = m[1].replace(/\s+/g," ");
  if ((m = t.match(/\b(\d{1,2})\s?gb\b/i))) g.ram = m[1] + "GB";
  if ((m = t.match(/\b(\d{3,4}\s?gb|\d(?:\.\d)?\s?tb)\b/i))) g.storage = m[1].toUpperCase().replace(/\s+/g,"");
  if ((m = t.match(/\b(1[0-9](?:\.\d)?|9(?:\.\d)?)\s?(?:["”]|inch|-inch)\b/i))) g.screen = m[1] + '"';
  if ((m = t.match(/\b(rtx\s?\d{3,4}\w*|gtx\s?\d{3,4}|radeon\s?\w+|iris\s?xe|arc\s?\w*)\b/i))) g.gpu = m[1].toUpperCase().replace(/\s+/g," ");
  return g;
}

async function fetchFeed(url){
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 LaptopDealsBot" }, redirect: "follow" });
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return res.text();
}

async function buildRegion(region){
  const sym = region === "uk" ? "£" : "$";
  const out = [], seen = new Set();
  for (const feed of FEEDS[region]){
    let xml;
    try { xml = await fetchFeed(feed.url); }
    catch (e){ console.error("feed failed:", e.message); continue; }
    for (const it of parseItems(xml)){
      const t = it.title;
      if (!LAPTOP_RE.test(t) || EXCLUDE_RE.test(t)) continue;
      const key = t.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);

      const price = num(it.mprice) ?? priceFromTitle(t, sym);
      const was = wasFrom(t, sym);
      const retailer = it.merchant || (region === "us" ? (usRetailer(t) || feed.retailerHint) : feed.retailerHint);
      const g = specGuess(t);
      let model = t.replace(/\s*\(\d+\s*replies?\)\s*$/i, "").trim();
      if (model.length > 80) model = model.slice(0, 77) + "…";

      out.push({
        model, retailer, price,
        was: (was && price && was > price) ? was : null,
        cat: categorize(t),
        cpu: g.cpu || "—", ram: g.ram || "—", storage: g.storage || "—",
        screen: g.screen || "—", gpu: g.gpu || "—", battery: "—", weight: "—",
        link: it.link,
        note: "From " + retailer + " feed — confirm spec on retailer site"
      });
    }
  }
  out.sort((a,b) => (b.price?1:0) - (a.price?1:0));
  return out.slice(0, 24);
}

// OPTIONAL spec-filler: if ANTHROPIC_API_KEY is set, ask Claude Haiku to infer
// missing CPU/RAM/storage/screen/GPU from each deal's title. Free mode skips this.
async function enrichSpecs(data){
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key){ console.log("No ANTHROPIC_API_KEY set — skipping spec enrichment (free mode)."); return; }
  const all = [...data.uk, ...data.us];
  const targets = all.filter(d => [d.cpu, d.ram, d.storage, d.screen].some(v => v === "—"));
  if (!targets.length){ console.log("Nothing to enrich."); return; }
  const items = targets.map((d, i) => ({ id: i, title: d.model }));
  const prompt =
`You are a laptop hardware expert. For each item below, infer specs from its name/title.
Return ONLY a JSON object mapping each id (as a string) to an object with keys:
cpu, ram, storage, screen, gpu, battery, weight.
Use concise values, e.g. "Intel Core i5-1335U", "16GB", "512GB SSD", "15.6\\" FHD", "RTX 4060", "Up to 8h", "1.7kg".
If a value is not reasonably inferable from the name, use "—". Do NOT fabricate precise battery life or weight unless standard for that exact model.

Items:
${JSON.stringify(items)}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok){ console.error("Enrich API error", res.status, (await res.text()).slice(0,300)); return; }
    const j = await res.json();
    const text = (j.content || []).map(c => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m){ console.error("Enrich: no JSON found in response."); return; }
    const specs = JSON.parse(m[0]);
    let n = 0;
    targets.forEach((d, i) => {
      const s = specs[i] ?? specs[String(i)];
      if (!s) return;
      let touched = false;
      for (const k of ["cpu","ram","storage","screen","gpu","battery","weight"]){
        if ((d[k] === undefined || d[k] === "—") && s[k] && s[k] !== "—"){ d[k] = String(s[k]); touched = true; }
      }
      if (touched) n++;
    });
    console.log(`Enriched ${n} deals via Claude Haiku.`);
  } catch (e){ console.error("Enrich failed:", e.message); }
}

const data = {
  updated: new Date().toISOString().replace("T"," ").slice(0,16) + " UTC",
  uk: await buildRegion("uk"),
  us: await buildRegion("us")
};
await enrichSpecs(data);
writeFileSync("deals.json", JSON.stringify(data, null, 2));
console.log(`Wrote deals.json — UK: ${data.uk.length}, US: ${data.us.length} deals.`);
