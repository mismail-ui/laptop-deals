// buyback.mjs — finds public LinkedIn posts from organisations that want redundant IT
// equipment collected, disposed of or sold (UK first, then Europe) and writes buyback.json for the "Buyback / surplus" tab.
//
// It never contacts LinkedIn. Discovery goes through a web-search API, using
// whichever ONE of these keys is set (checked in this order):
//   SERPAPI_KEY     Google results via serpapi.com  (best LinkedIn coverage)
//   TAVILY_API_KEY  tavily.com
//   BRAVE_API_KEY   Brave Search API
//
//   node scripts/buyback.mjs          search + rewrite buyback.json
//   node scripts/buyback.mjs --add    add one post from a GitHub issue form
//                                     (reads GITHUB_EVENT_PATH) to buyback-manual.json
// No dependencies. Node 18+.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const AUTO_FILE = "buyback.json";
const MANUAL_FILE = "buyback-manual.json";
const MAX_AGE_DAYS = 45;      // drop search-found posts older than this
const MANUAL_AGE_DAYS = 90;   // drop hand-added posts older than this
const MAX_ITEMS = 80;
const DAY = 86400000;

// Rotated a few per run so a small monthly search quota covers all of them.
// Mostly posts asking for someone to take redundant kit away, plus stock for sale.
// Every block of four is three UK queries and one Europe query.
// q = operator form (Google / Brave); plain = natural-language form (Tavily).
export const QUERIES = [
  { q: 'site:linkedin.com/posts "looking for recommendations" ("IT equipment" OR laptops) (disposal OR recycling) UK', plain: "looking for recommendations IT equipment disposal recycling UK" },
  { q: 'site:linkedin.com/posts ("dispose of" OR "disposal of") ("old laptops" OR "redundant IT" OR "IT equipment") (recommend OR recommendations) UK', plain: "need to dispose of redundant IT equipment old laptops recommendations UK" },
  { q: 'site:linkedin.com/posts "IT equipment" (collected OR collection) (recycling OR disposal) "can anyone recommend"', plain: "can anyone recommend IT equipment collection recycling disposal UK" },
  { q: 'site:linkedin.com/posts "IT equipment" (disposal OR recycling) (recommendations OR "looking for") (Ireland OR Netherlands OR Germany OR Europe)', plain: "looking for IT equipment disposal recycling provider Ireland Netherlands Germany Europe" },
  { q: 'site:linkedin.com/posts ITAD (recommend OR recommendations OR "looking for") (provider OR company) UK', plain: "looking for ITAD provider recommendations UK" },
  { q: 'site:linkedin.com/posts "old laptops" ("get rid of" OR recycle OR sell OR donate) (anyone OR recommend) UK', plain: "old laptops to get rid of recycle sell anyone recommend UK" },
  { q: 'site:linkedin.com/posts WEEE "IT equipment" "looking for" (provider OR company OR recommendations)', plain: "looking for WEEE IT equipment disposal provider recommendations" },
  { q: 'site:linkedin.com/posts ("hard drive destruction" OR "data destruction" OR "IT disposal") "looking for" (provider OR recommendations) (Ireland OR EU OR Europe)', plain: "looking for hard drive destruction IT disposal provider Ireland Europe" },
  { q: 'site:linkedin.com/posts ("office clearance" OR "office closure" OR "office move") (laptops OR monitors OR "IT equipment") (sell OR disposal OR recycle) UK', plain: "office clearance closure laptops monitors IT equipment to sell or dispose UK" },
  { q: 'site:linkedin.com/posts laptops "for sale" (surplus OR "job lot" OR "ex-corporate" OR redundant) UK', plain: "surplus redundant ex-corporate laptops for sale job lot UK" },
  { q: 'site:linkedin.com/posts "IT equipment" ("for sale" OR surplus OR clearance) UK', plain: "IT equipment for sale surplus clearance UK" },
  { q: 'site:linkedin.com/posts ("off-lease" OR "ex-lease" OR surplus) laptops ("for sale" OR available) (Europe OR EU OR Netherlands OR Germany)', plain: "off-lease ex-lease surplus laptops for sale Europe Netherlands Germany" }
];

// ---------- search providers ----------

async function getJson(url, init){
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(new URL(url).host + " -> HTTP " + res.status + " " + (await res.text()).slice(0, 160));
  return res.json();
}

export const PROVIDERS = {
  serpapi: {
    env: "SERPAPI_KEY", perRun: 4,   // 4 x 2 runs/day ≈ 240 searches/month
    async search(query, key){
      const u = new URL("https://serpapi.com/search.json");
      for (const [k, v] of Object.entries({ engine: "google", q: query.q, gl: "uk", hl: "en", num: "20", tbs: "qdr:m", api_key: key })) u.searchParams.set(k, v);
      const j = await getJson(u.href);
      return (j.organic_results || []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet }));
    }
  },
  tavily: {
    env: "TAVILY_API_KEY", perRun: 8,
    async search(query, key){
      const j = await getJson("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({ query: query.plain + " LinkedIn post", include_domains: ["linkedin.com"], max_results: 20, time_range: "month", search_depth: "basic" })
      });
      return (j.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }));
    }
  },
  brave: {
    env: "BRAVE_API_KEY", perRun: 8,
    async search(query, key){
      const u = new URL("https://api.search.brave.com/res/v1/web/search");
      for (const [k, v] of Object.entries({ q: query.q, country: "GB", count: "20", freshness: "pm" })) u.searchParams.set(k, v);
      const j = await getJson(u.href, { headers: { accept: "application/json", "x-subscription-token": key } });
      return ((j.web && j.web.results) || []).map(r => ({ title: r.title, url: r.url, snippet: r.description }));
    }
  }
};

export function pickProvider(env = process.env){
  for (const [name, p] of Object.entries(PROVIDERS)) if (env[p.env]) return { name, key: env[p.env], ...p };
  return null;
}

// Which queries this run uses: a window that advances every 12 hours.
export function queriesForRun(perRun, now = Date.now()){
  const slot = Math.floor(now / (12 * 3600 * 1000));
  const out = [];
  for (let i = 0; i < Math.min(perRun, QUERIES.length); i++) out.push(QUERIES[(slot * perRun + i) % QUERIES.length]);
  return out;
}

// ---------- understanding a post ----------

const EQUIP_RE = /\b(laptops?|notebooks?|desktops?|workstations?|servers?|monitors?|macbooks?|imacs?|thinkpads?|elitebooks?|latitudes?|optiplex|chromebooks?|ipads?|iphones?|tablets?|smartphones?|thin clients?|docking stations?|it (?:equipment|assets?|hardware|kit|stock))\b/i;
const INTENT_RE = /\b(dispos\w+|recycl\w+|collect(?:ed|ion)|recommend\w*|weee|get rid of|clearance|for sale|available|in stock|stock (?:list|offer)|surplus|buy[\s-]?back|clearance|job lots?|wholesale|redundant|ex[\s-](?:corporate|lease|business|rental)|off[\s-]lease|end[\s-]of[\s-]lease|decommission\w*|trade (?:only|price|stock)|bulk|pallets?|units|qty|moq|offers? (?:invited|welcome)|we (?:buy|sell|have)|selling|wanted|wtb|wts|looking to (?:buy|sell|purchase|source))\b/i;
const NOISE_RE = /\b(we(?:'|’)?re hiring|we are hiring|now hiring|job (?:opening|vacancy|opportunity)|vacancy|apply now|webinar|podcast|giveaway)\b/i;
// Someone asking for help getting rid of kit — the posts worth replying to.
const SEEK_RE = /\b(looking for (?:recommendations?|a\b|an\b|someone|companies|providers?|suppliers?)|looking to (?:connect|dispose|sell|get rid|recycle|clear|offload)|(?:can|could) anyone recommend|any(?:one)? recommend\w*|recommendations? (?:please|needed|wanted|welcome|for)|does anyone (?:know|want|need)|needs? (?:to be )?(?:collected|disposed|recycled|cleared|gone|a new home)|need to (?:dispose|get rid|recycle|clear|sell)|(?:trying|want|wanting) to get rid of|free to (?:a good home|collect|anyone))\b/i;
const DISPOSE_RE = /\b(dispos\w+|recycl\w+|collect(?:ed|ion)|get rid|clear(?:ance|ed|ing)?|decommission\w*|redundant|old|surplus|end[\s-]of[\s-]life|weee|itad|sell)\b/i;
const BUYER_RE = /\b(wanted|wtb|we (?:buy|purchase|collect|recycle|offer)|looking to (?:buy|purchase|source)|buy[\s-]?back|sell (?:us|your|to us)|we(?:'|’)ll buy|we pay|our (?:service|team)s?|book a collection|get in touch)\b/i;
const SELLER_RE = /\b(for sale|wts|available|in stock|stock (?:list|offer)|clearance|job lots?|surplus|offers? (?:invited|welcome)|we have|selling|wholesale)\b/i;

const UK_RE = /\b(uk|u\.k\.|united kingdom|great britain|britain|england|scotland|wales|northern ireland|london|manchester|birmingham|leeds|glasgow|edinburgh|liverpool|bristol|sheffield|newcastle|nottingham|leicester|cardiff|belfast|coventry|milton keynes|southampton|essex|yorkshire|midlands|slough|luton|bradford)\b|£|\bGBP\b/i;
const EU_RE = /\b(europe(?:an)?|emea|germany|deutschland|netherlands|holland|france|spain|italy|poland|belgium|ireland|dublin|sweden|denmark|norway|finland|austria|switzerland|portugal|czech(?:ia| republic)?|romania|hungary|amsterdam|rotterdam|berlin|hamburg|munich|paris|madrid|milan|warsaw|brussels)\b|€|\bEUR?\b/;
const ELSEWHERE_RE = /\b(usa|u\.s\.a?\.?|united states|canada|india|dubai|uae|pakistan|nigeria|australia|china|hong kong|singapore|texas|california|florida|new york|mumbai|delhi|bangalore|lagos|karachi|nairobi)\b|\$|₹|\b(?:AED|USD|INR)\b/i;
const EU_HOSTS = new Set(["nl","de","fr","ie","es","it","pl","be","se","dk","no","fi","at","ch","pt","cz","ro","hu"]);

const BRAND_RE = /\b(dell(?: latitude| optiplex| precision| xps)?(?: \d{4})?|hp(?: elitebook| probook| elitedesk| prodesk| zbook)?(?: \d{3,4}(?: g\d{1,2})?)?|lenovo(?: thinkpad| thinkcentre| ideapad)?(?: [a-z]\d{2,3}[a-z]?)?|thinkpad(?: [a-z]\d{2,3}[a-z]?)?|elitebook(?: \d{3,4}(?: g\d{1,2})?)?|latitude(?: \d{4})?|optiplex(?: \d{4})?|macbook(?: pro| air)?|imac|ipad(?: pro| air)?|iphone(?: \d{1,2})?|surface(?: pro| laptop)?(?: \d{1,2})?|acer|asus|fujitsu|toshiba|dynabook|samsung|cisco|chromebooks?)\b/gi;

export function clean(s){
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
}

// LinkedIn post ids are time-based: the top 41 bits are the post's Unix time in ms.
export function postIdFromUrl(url){
  const m = String(url).match(/(?:activity|ugcPost|share)[-:](\d{19})/i);
  return m ? m[1] : null;
}
export function postDate(id){
  if (!id) return null;
  const ms = Number(BigInt(id) >> 22n);
  return (ms > Date.UTC(2015, 0, 1) && ms < Date.now() + DAY) ? ms : null;
}

// Only LinkedIn post URLs are accepted; the query string (tracking) is dropped.
export function canonicalLink(url){
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (u.hostname === "lnkd.in") return u.origin + u.pathname;
  if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
  if (!/^\/(posts|feed\/update|pulse)\//.test(u.pathname)) return null;
  return "https://www.linkedin.com" + u.pathname;
}

// Search titles look like "Jane Doe on LinkedIn: 500 laptops… | 12 comments".
// Keep the post text, drop the person's name and the LinkedIn boilerplate.
export function stripAuthor(title){
  let t = clean(title)
    .replace(/\s*[|\-–]\s*LinkedIn\s*$/i, "")
    .replace(/\s*\|\s*\d+\s+comments?\s*$/i, "")
    .replace(/^.{1,80}? (?:on LinkedIn|posted on LinkedIn)\s*[:|\-–]?\s*/i, "")
    .replace(/^.{1,80}?(?:'s|’s|s') Post\s*$/i, "")
    .replace(/^.{1,80}? posted on the topic\b.*$/i, "");
  return t.trim();
}

export function regionOf(text, host = ""){
  const sub = host.split(".")[0];
  if (UK_RE.test(text) || sub === "uk") return "UK";
  if (EU_RE.test(text) || EU_HOSTS.has(sub)) return "Europe";
  if (ELSEWHERE_RE.test(text)) return null;       // clearly somewhere else
  return "Unspecified";
}

export function kindOf(text){
  if (SEEK_RE.test(text) && DISPOSE_RE.test(text)) return "Needs disposal";
  if (BUYER_RE.test(text)) return "ITAD / buyer advert";
  if (SELLER_RE.test(text)) return "For sale";
  return "Other";
}

export function quantityOf(text){
  let best = null;
  const re = /(?<![£€$.\d])(\d{1,3}(?:,\d{3})+|\d{1,6})\+?\s?(?:x\b|×|units?\b|pcs\b|pieces\b|laptops?\b|notebooks?\b|desktops?\b|monitors?\b|servers?\b|macbooks?\b|tablets?\b|pallets?\b)/gi;
  for (const m of text.matchAll(re)){
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    if (n >= 2 && n <= 1000000 && !(n >= 1990 && n <= 2035) && (best === null || n > best)) best = n;
  }
  const q = text.match(/\b(?:qty|quantity)\s*[:\-]?\s*(\d{1,3}(?:,\d{3})+|\d{1,6})/i);
  if (q){ const n = parseInt(q[1].replace(/,/g, ""), 10); if (n >= 2 && (best === null || n > best)) best = n; }
  return best;
}

export function modelsOf(text){
  const seen = new Map();
  for (const m of text.matchAll(BRAND_RE)){
    const v = m[0].replace(/\s+/g, " ").trim();
    const k = v.toLowerCase();
    // keep the most specific mention: "Dell Latitude 5420" beats "Dell"
    if ([...seen.keys()].some(o => o.startsWith(k))) continue;
    for (const o of [...seen.keys()]) if (k.startsWith(o)) seen.delete(o);
    seen.set(k, v);
  }
  return [...seen.values()].slice(0, 4);
}

export function priceOf(text){
  const m = text.match(/[£€]\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:each|ea\b|per unit|\/\s?unit|\+\s?vat))?/i);
  return m ? m[0].replace(/\s+/g, " ") : null;
}

function cut(s, n){ return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

// Turn one search hit (or hand-added post) into a card, or null if it isn't relevant.
// onReject(reason) is called when a hit is dropped, so the run log shows why.
export function toItem({ title, url, snippet }, { now = Date.now(), manual = false, location = "", onReject = () => {} } = {}){
  const no = reason => { onReject(reason); return null; };
  const link = canonicalLink(url);
  if (!link) return no("not a post link");
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const body = clean(snippet);
  const head = stripAuthor(title);
  const text = (head + " " + body + " " + clean(location)).trim();

  const pid = postIdFromUrl(link);
  const posted = postDate(pid);
  if (!manual){
    if (!EQUIP_RE.test(text)) return no("no equipment mentioned");
    if (!INTENT_RE.test(text)) return no("no disposal/sale wording");
    if (NOISE_RE.test(text)) return no("job advert or event");
    if (posted && now - posted > MAX_AGE_DAYS * DAY) return no("older than " + MAX_AGE_DAYS + " days (" + new Date(posted).toISOString().slice(0, 10) + ")");
  }
  const region = regionOf(text, host) || (manual ? "Unspecified" : null);
  if (!region) return no("outside UK/Europe");

  const firstSentence = (body.match(/^.{20,110}?[.!?](?=\s|$)/) || [])[0];
  const headline = cut(head.length >= 15 ? head : (firstSentence || body || "LinkedIn post"), 110);
  return {
    id: pid || createHash("sha1").update(link).digest("hex").slice(0, 16),
    headline,
    snippet: cut(body, 320),
    kind: kindOf(text),
    region,
    qty: quantityOf(text),
    models: modelsOf(text),
    price: priceOf(text),
    posted: posted ? new Date(posted).toISOString().slice(0, 10) : null,
    firstSeen: new Date(now).toISOString().slice(0, 10),
    source: manual ? "manual" : "search",
    link
  };
}

// Keep previously found posts until they age out; newest first.
export function mergeItems(existing, fresh, { now = Date.now(), maxAgeDays = MAX_AGE_DAYS } = {}){
  const byId = new Map();
  for (const it of existing || []) if (it && it.id) byId.set(it.id, it);
  for (const it of fresh) byId.set(it.id, { ...it, firstSeen: (byId.get(it.id) || it).firstSeen });
  const when = it => Date.parse(it.posted || it.firstSeen) || 0;
  return [...byId.values()]
    .filter(it => now - when(it) <= maxAgeDays * DAY)
    .sort((a, b) => when(b) - when(a))
    .slice(0, MAX_ITEMS);
}

function readJson(file, fallback){
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

// ---------- search mode ----------

async function runSearch(){
  const prev = readJson(AUTO_FILE, { items: [] });
  const provider = pickProvider();
  if (!provider){
    console.log("No search key set (SERPAPI_KEY / TAVILY_API_KEY / BRAVE_API_KEY) — skipping LinkedIn post discovery.");
    if (!existsSync(AUTO_FILE)) writeFileSync(AUTO_FILE, JSON.stringify({ updated: null, status: "no-key", provider: null, items: [] }, null, 2) + "\n");
    return;
  }
  const fresh = [];
  let failed = 0;
  const queries = queriesForRun(provider.perRun);
  for (const query of queries){
    try {
      const hits = await provider.search(query, provider.key);
      const kept = [];
      for (const h of hits){
        const item = toItem(h, { onReject: why => {
          let where = ""; try { where = new URL(h.url).pathname.split("/")[1] || ""; } catch {}
          console.log(`  skip — ${why} — /${where}/ — ${stripAuthor(h.title).slice(0, 70)}`);
        } });
        if (item) kept.push(item);
      }
      console.log(`${provider.name}: ${hits.length} results, ${kept.length} relevant — ${query.plain}`);
      fresh.push(...kept);
    } catch (e){
      failed++;
      console.error("search failed:", String(e.message).replace(provider.key, "***"));
    }
    await new Promise(r => setTimeout(r, 400));
  }
  if (failed === queries.length){
    // Every query failed (bad key, quota used up, outage): keep what we had and fail the run so it is noticed.
    console.error("All searches failed — buyback.json left unchanged.");
    process.exitCode = 1;
    return;
  }
  const items = mergeItems(prev.items, fresh);
  writeFileSync(AUTO_FILE, JSON.stringify({ updated: stamp(), status: "ok", provider: provider.name, items }, null, 2) + "\n");
  console.log(`Wrote ${AUTO_FILE} — ${items.length} posts (${fresh.length} matched this run).`);
}

// ---------- add-from-issue mode ----------

// GitHub issue forms render as "### Label\n\nvalue" blocks.
export function parseIssueForm(body){
  const out = {};
  for (const part of String(body || "").split(/^### /m).slice(1)){
    const nl = part.indexOf("\n");
    const label = (nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase();
    const value = nl < 0 ? "" : part.slice(nl + 1).trim();
    out[label] = value === "_No response_" ? "" : value;
  }
  return out;
}

function runAdd(){
  const event = readJson(process.env.GITHUB_EVENT_PATH || "", null);
  if (!event || !event.issue) throw new Error("No issue found in GITHUB_EVENT_PATH.");
  const form = parseIssueForm(event.issue.body);
  const url = form["post link"] || "";
  const text = form["post text"] || "";
  if (!canonicalLink(url)) throw new Error("That doesn't look like a LinkedIn post link. Use the post's ⋯ menu → “Copy link to post”.");
  const firstLine = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) || "";
  const item = toItem({ title: firstLine, url, snippet: text }, { manual: true, location: form["location"] || "" });
  const prev = readJson(MANUAL_FILE, { items: [] });
  const items = mergeItems(prev.items, [item], { maxAgeDays: MANUAL_AGE_DAYS });
  writeFileSync(MANUAL_FILE, JSON.stringify({ updated: stamp(), items }, null, 2) + "\n");
  console.log(`Added post ${item.id} — ${items.length} hand-added posts in ${MANUAL_FILE}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  try {
    if (process.argv.includes("--add")) runAdd();
    else await runSearch();
  } catch (e){
    console.error(e.message);
    process.exitCode = 1;
  }
}
