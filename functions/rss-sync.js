const admin = require("firebase-admin");
const cheerio = require("cheerio");
const crypto = require("crypto");

const FEEDS = [
  { name: "A Spor - Süper Lig", url: "https://www.aspor.com.tr/rss/spor-toto-super-lig.xml" },
  { name: "A Spor - Transfer Raporu", url: "https://www.aspor.com.tr/rss/program/transfer-raporu.xml" },
  { name: "Habertürk Spor", url: "https://www.haberturk.com/rss/spor.xml" },
  { name: "TRT Haber Spor", url: "https://www.trthaber.com/spor_articles.rss" },
];

const MAX_ITEMS_PER_FEED = 15;
const MAX_SUMMARY_LENGTH = 350;

function initializeFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT secret bulunamadı.");
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT geçerli JSON değil."); }
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore();
}

function textOf($, node, selectors) {
  for (const selector of selectors) {
    const found = $(node).find(selector).first();
    if (found.length) {
      const value = (found.attr("content") || found.text() || "").trim();
      if (value) return value;
    }
  }
  return "";
}

function firstByLocalName($, node, names) {
  let value = "";
  $(node).find("*").each((_, child) => {
    if (value) return;
    if (names.includes(String(child.name || "").toLowerCase())) {
      value = ($(child).attr("url") || $(child).attr("href") || $(child).text() || "").trim();
    }
  });
  return value;
}

function cleanText(value) {
  return cheerio.load(value || "").text().replace(/\s+/g, " ").trim();
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|source)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return raw.trim(); }
}

function articleId(url) {
  return crypto.createHash("sha256").update(canonicalUrl(url)).digest("hex");
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseFeed(xml, feed) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const nodes = $("item").toArray().length ? $("item").toArray() : $("entry").toArray();

  return nodes.slice(0, MAX_ITEMS_PER_FEED).map((node) => {
    const title = textOf($, node, ["title"]);
    let link = textOf($, node, ["link"]);
    if (!link) link = $(node).find("link").first().attr("href") || "";
    const guid = textOf($, node, ["guid", "id"]);
    const originalUrl = canonicalUrl(link || guid);
    const rawSummary = textOf($, node, ["description", "summary", "content\\:encoded", "content"]);
    const summary = cleanText(rawSummary).slice(0, MAX_SUMMARY_LENGTH);
    const imageUrl = firstByLocalName($, node, ["media:content", "media:thumbnail", "enclosure"]) ||
      ((rawSummary.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || "");
    const publishedRaw = textOf($, node, ["pubdate", "published", "updated", "dc\\:date"]);

    if (!title || !originalUrl || !/^https?:\/\//i.test(originalUrl)) return null;
    return {
      id: articleId(originalUrl),
      title: cleanText(title),
      summary,
      source: feed.name,
      originalUrl,
      imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : "",
      publishedAt: parseDate(publishedRaw),
    };
  }).filter(Boolean);
}

async function fetchFeed(feed) {
  const response = await fetch(feed.url, {
    headers: {
      "User-Agent": "Miclantic-SuperLigLive-RSS/1.0",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(feed.name + ": HTTP " + response.status);
  return parseFeed(await response.text(), feed);
}

async function savePendingArticles(db, articles) {
  let created = 0;
  let duplicates = 0;
  for (let i = 0; i < articles.length; i += 400) {
    const batch = db.batch();
    const chunk = articles.slice(i, i + 400);
    const refs = chunk.map((article) => db.collection("articles").doc(article.id));
    const snapshots = await db.getAll(...refs);

    snapshots.forEach((snapshot, index) => {
      if (snapshot.exists) { duplicates++; return; }
      const article = chunk[index];
      const data = {
        title: article.title,
        summary: article.summary,
        excerpt: article.summary,
        description: article.summary,
        source: article.source,
        sourceName: article.source,
        originalUrl: article.originalUrl,
        url: article.originalUrl,
        imageUrl: article.imageUrl || null,
        status: "pending",
        type: "auto",
        createdBy: "rss-bot",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (article.publishedAt) {
        data.publishedAt = admin.firestore.Timestamp.fromDate(article.publishedAt);
      }
      batch.create(refs[index], data);
      created++;
    });
    if (chunk.length) await batch.commit();
  }
  return { created, duplicates };
}

async function main() {
  const db = initializeFirebase();
  const allArticles = [];
  for (const feed of FEEDS) {
    try {
      const articles = await fetchFeed(feed);
      console.log(feed.name + ": " + articles.length + " haber okundu.");
      allArticles.push(...articles);
    } catch (error) {
      console.error("RSS kaynağı okunamadı (" + feed.name + "): " + error.message);
    }
  }
  if (!allArticles.length) throw new Error("Hiçbir RSS kaynağından haber alınamadı.");
  const unique = [...new Map(allArticles.map((article) => [article.id, article])).values()];
  const result = await savePendingArticles(db, unique);
  console.log("RSS tamamlandı. Yeni taslak: " + result.created + "; mevcut kayıt: " + result.duplicates + ".");
}

main().catch((error) => {
  console.error("RSS senkronizasyon hatası:", error);
  process.exitCode = 1;
});
