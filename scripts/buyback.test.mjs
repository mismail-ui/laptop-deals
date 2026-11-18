// Run: node --test scripts/buyback.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { toItem, stripAuthor, canonicalLink, postDate, kindOf, regionOf, quantityOf, modelsOf, priceOf, mergeItems, parseIssueForm, queriesForRun, pickProvider, PROVIDERS, QUERIES, notifyTelegram, telegramText } from "./buyback.mjs";

const DAY = 86400000;
const idFor = ms => String(BigInt(ms) << 22n).padStart(19, "0");
const NOW = Date.UTC(2026, 10, 18);
const recentUrl = `https://www.linkedin.com/posts/someone-123_it-disposal-activity-${idFor(NOW - 2 * DAY)}-AbCd?utm_source=share`;

const LEAD = "Looking for recommendations – IT Equipment Disposal & Recycling. I'm looking to connect with companies specialising in the secure disposal of redundant IT equipment. We have a quantity of equipment that needs to be collected, including laptops and other IT hardware, in line with UK WEEE regulations.";

test("a disposal request becomes a UK lead with no author name", () => {
  const it = toItem({ title: "Jane Example on LinkedIn: Looking for recommendations – IT Equipment Disposal | 26 comments", url: recentUrl, snippet: LEAD }, { now: NOW });
  assert.equal(it.kind, "Needs disposal");
  assert.equal(it.region, "UK");
  assert.equal(it.posted, new Date(NOW - 2 * DAY).toISOString().slice(0, 10));
  assert.ok(!/Jane/.test(JSON.stringify({ ...it, link: "" })));
  assert.ok(!it.link.includes("utm_source"));
});

test("kinds", () => {
  assert.equal(kindOf("We buy your redundant laptops – book a collection today"), "ITAD / buyer advert");
  assert.equal(kindOf("500 x Dell Latitude 5420 for sale, grade A"), "For sale");
  assert.equal(kindOf("Can anyone recommend a company to recycle old laptops?"), "Needs disposal");
});

test("irrelevant, stale, non-LinkedIn and far-away posts are dropped", () => {
  const stale = `https://www.linkedin.com/posts/x_y-activity-${idFor(NOW - 90 * DAY)}-AbCd`;
  assert.equal(toItem({ title: "", url: recentUrl, snippet: "Licences and certifications in IT recycling and disposal, UK" }, { now: NOW }), null);
  assert.equal(toItem({ title: "", url: recentUrl, snippet: "Great day at the conference with the team!" }, { now: NOW }), null);
  assert.equal(toItem({ title: "", url: stale, snippet: LEAD }, { now: NOW }), null);
  assert.equal(toItem({ title: "", url: "https://example.com/posts/x", snippet: LEAD }, { now: NOW }), null);
  assert.equal(toItem({ title: "", url: recentUrl, snippet: "200 laptops for sale in Dubai, $150 each" }, { now: NOW }), null);
  assert.equal(toItem({ title: "", url: recentUrl, snippet: "We're hiring an ITAD sales exec – laptops for sale experience needed, UK" }, { now: NOW }), null);
});

test("links", () => {
  assert.equal(canonicalLink("https://uk.linkedin.com/posts/a_b-activity-1?x=1"), "https://www.linkedin.com/posts/a_b-activity-1");
  assert.equal(canonicalLink("javascript:alert(1)"), null);
  assert.equal(canonicalLink("https://evil-linkedin.com/posts/a"), null);
  assert.equal(canonicalLink("https://www.linkedin.com/in/someone"), null);
  assert.equal(postDate("123"), null);
  assert.equal(canonicalLink("https://www.google.com/goto?url=" + encodeURIComponent("https://uk.linkedin.com/posts/a_b-activity-1?x=1") + "&sa=U"), "https://www.linkedin.com/posts/a_b-activity-1");
  assert.equal(canonicalLink("https://www.google.com/goto?url=" + encodeURIComponent("https://www.gumtree.com/for-sale")), null);
});

test("titles lose the poster's name", () => {
  assert.equal(stripAuthor("Jane Example on LinkedIn: 300 laptops available | 12 comments"), "300 laptops available");
  assert.equal(stripAuthor("Jane Example's Post - LinkedIn"), "");
});

test("extraction", () => {
  assert.equal(regionOf("stock in Rotterdam, €120 each"), "Europe");
  assert.equal(regionOf("collection from Northern Ireland"), "UK");
  assert.equal(regionOf("laptops available"), "Unspecified");
  assert.equal(quantityOf("We have 1,200 units and 40 monitors, £95 each"), 1200);
  assert.equal(quantityOf("Qty: 350 from 2024 laptops refresh"), 350);
  assert.deepEqual(modelsOf("Dell, Dell Latitude 5420 and HP EliteBook 840 G8 plus MacBook Pro"), ["Dell Latitude 5420", "HP EliteBook 840 G8", "MacBook Pro"]);
  assert.equal(priceOf("only £95 each ex VAT"), "£95 each");
});

test("merge keeps first-seen date, dedupes and expires", () => {
  const a = { id: "1", posted: "2026-11-10", firstSeen: "2026-11-11" };
  const out = mergeItems([a, { id: "old", posted: "2026-08-01", firstSeen: "2026-08-01" }], [{ id: "1", posted: "2026-11-10", firstSeen: "2026-11-18" }, { id: "2", posted: "2026-11-17", firstSeen: "2026-11-18" }], { now: NOW });
  assert.deepEqual(out.map(i => i.id), ["2", "1"]);
  assert.equal(out[1].firstSeen, "2026-11-11");
});

test("issue form parsing", () => {
  const f = parseIssueForm("### Post link\n\nhttps://www.linkedin.com/posts/a\n\n### Post text\n\nline one\n\nline two\n\n### Location\n\n_No response_");
  assert.equal(f["post link"], "https://www.linkedin.com/posts/a");
  assert.equal(f["post text"], "line one\n\nline two");
  assert.equal(f["location"], "");
});

test("query rotation covers every query and provider choice follows the key", () => {
  const seen = new Set();
  for (let s = 0; s < 6; s++) queriesForRun(4, s * 12 * 3600 * 1000).forEach(q => seen.add(q.q));
  assert.equal(seen.size, QUERIES.length);
  assert.equal(pickProvider({}), null);
  assert.equal(pickProvider({ TAVILY_API_KEY: "k" }).name, "tavily");
});

test("each provider maps its response shape to title/url/snippet", async () => {
  const shapes = {
    serpapi: { organic_results: [{ title: "T", link: "U", snippet: "S" }] },
    tavily: { results: [{ title: "T", url: "U", content: "S" }] },
    brave: { web: { results: [{ title: "T", url: "U", description: "S" }] } }
  };
  const real = globalThis.fetch;
  try {
    for (const [name, body] of Object.entries(shapes)){
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      assert.deepEqual(await PROVIDERS[name].search(QUERIES[0], "k"), [{ title: "T", url: "U", snippet: "S" }]);
    }
  } finally { globalThis.fetch = real; }
});

test("telegram: only real leads are sent, and nothing without a token", async () => {
  const items = [
    { id: "1", kind: "Needs disposal", region: "UK", headline: "Old laptops need collecting", qty: 40, models: [], link: "https://www.linkedin.com/posts/a" },
    { id: "2", kind: "ITAD / buyer advert", region: "UK", headline: "We buy laptops", link: "https://www.linkedin.com/posts/b" }
  ];
  assert.equal(telegramText(items[0]), "♻️ Needs disposal · UK\nOld laptops need collecting\nQty: 40\nhttps://www.linkedin.com/posts/a");
  const real = globalThis.fetch; const calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return new Response("{}", { status: 200 }); };
    assert.equal(await notifyTelegram(items, {}), 0);
    assert.equal(await notifyTelegram(items, { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42" }), 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://api.telegram.org/botT/sendMessage");
    assert.equal(calls[0][1].chat_id, "42");
  } finally { globalThis.fetch = real; }
});
