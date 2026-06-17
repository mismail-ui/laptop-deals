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

const data = {
  updated: new Date().toISOString().replace("T"," ").slice(0,16) + " UTC",
  uk: await buildRegion("uk"),
  us: await buildRegion("us")
};
writeFileSync("deals.json", JSON.stringify(data, null, 2));
console.log(`Wrote deals.json — UK: ${data.uk.length}, US: ${data.us.length} deals.`);
