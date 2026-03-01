
require("dotenv").config();

const crawlerPkg = require("crawler");
const Crawler = crawlerPkg.default ?? crawlerPkg; // handles default-export packages
const { URL } = require("url");
const { connectDB, pagesCol, linksCol } = require("./db");

const DATASETS = {
  tinyfruits: "https://people.scs.carleton.ca/~avamckenney/tinyfruits/N-0.html",
  fruits100: "https://people.scs.carleton.ca/~avamckenney/fruits100/N-0.html",
  fruitsA: "https://people.scs.carleton.ca/~avamckenney/fruitsA/N-0.html",

  // Seed can stay at our-people, but we allow the crawl to expand under /scs/*
  personal: "https://carleton.ca/scs/our-people",
};

function normalizeUrl(u) {
  const url = new URL(u);
  url.hash = "";
  url.protocol = "https:";
  let s = url.toString();
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function siteRootFromSeed(dataset, seed) {
  const u = new URL(seed);

  if (dataset !== "personal") {
    // Restrict to AVA datasets
    return `${u.origin}/~avamckenney/`;
  }

  // UPDATED: allow the crawl to expand to the entire SCS section
  // e.g. https://carleton.ca/scs and https://carleton.ca/scs/...
  return `${u.origin}/scs`;
}

function isAllowedUrl(dataset, urlStr, root) {
  if (!urlStr.startsWith(root)) return false;

  if (dataset === "personal") {
    try {
      const u = new URL(urlStr);

      // Must remain under /scs or /scs/...
      if (!(u.pathname === "/scs" || u.pathname.startsWith("/scs/"))) return false;

      // Allow query params EXCEPT common tracking params (needed for WP pagination on some pages)
      const badParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
      for (const p of badParams) {
        if (u.searchParams.has(p)) return false;
      }

      const path = u.pathname.toLowerCase();

      // Block WordPress/admin/API endpoints (these cause redirects/403/bloat)
      const blockedExactOrPrefix = [
        "/scs/technical-support/",
        "/scs/tech-support/",
        "/scs/wp-login.php",
        "/scs/wp-admin",
        "/scs/wp-json",
        "/scs/xmlrpc.php",
      ];
      if (blockedExactOrPrefix.some((p) => path === p || path.startsWith(p + "/"))) {
        return false;
      }

      // Avoid non-HTML resources
      const blockedExt = [
        ".zip", ".rar", ".7z", ".tar", ".gz",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
        ".mp4", ".mov", ".avi",
        ".mp3", ".wav",
        ".css", ".js",
        ".json", ".xml", ".pdf",
      ];
      if (blockedExt.some((ext) => path.endsWith(ext))) return false;

      return true;
    } catch {
      return false;
    }
  }

  return true;
}

function extractLinksFromCheerio($, baseUrl) {
  const out = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      out.push(normalizeUrl(new URL(href, baseUrl).toString()));
    } catch {
      // ignore bad URLs
    }
  });
  return [...new Set(out)];
}

// Words come ONLY from <p> paragraphs, excluding link text.
function extractParagraphIndexFromCheerio($) {
  const paragraphText = $("p")
    .map((_, p) => {
      const clean = $(p).clone();
      clean.find("a").remove(); // exclude link text explicitly
      return clean.text();
    })
    .get()
    .join(" ");

  const tokens = paragraphText
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const termFreq = {};
  for (const t of tokens) termFreq[t] = (termFreq[t] || 0) + 1;

  return { paragraphText, termFreq, wordCount: tokens.length };
}

function enqueue(c, url) {
  if (typeof c.add === "function") return c.add({ url });
  return c.queue({ uri: url });
}

async function ensureIndexes() {
  await pagesCol().createIndex({ dataset: 1, url: 1 }, { unique: true });
  await linksCol().createIndex({ dataset: 1, from: 1, to: 1 }, { unique: true });
}

async function crawlDataset(dataset) {
  const seed = DATASETS[dataset];
  if (!seed) throw new Error(`Unknown dataset: ${dataset}`);

  await connectDB();
  await ensureIndexes();

  const siteRoot = siteRootFromSeed(dataset, seed);
  const seen = new Set();
  const bad = new Set();

  // For personal you need >= 500 pages; use a larger cap but safe default.
  const MAX_PAGES = dataset === "personal" ? 4000 : 2500;

  await new Promise((resolve, reject) => {
    const c = new Crawler({
      maxConnections: 10,
      timeout: 20000,
      retries: 1,
      retryInterval: 1000,

      callback: async (error, res, done) => {
        try {
          const rawUrl = res?.options?.url ?? res?.options?.uri;
          if (!rawUrl) return;

          const url = normalizeUrl(rawUrl);

          if (!isAllowedUrl(dataset, url, siteRoot)) return;

          if (seen.has(url) || bad.has(url)) return;
          seen.add(url);

          const reachedCap = seen.size >= MAX_PAGES;

          if (error) {
            bad.add(url);
            await pagesCol().updateOne(
              { dataset, url },
              {
                $set: {
                  dataset,
                  url,
                  status: 0,
                  html: null,
                  outLinks: [],
                  paragraphText: "",
                  termFreq: {},
                  wordCount: 0,
                  fetchedAt: new Date(),
                  error: String(error.message || error),
                },
              },
              { upsert: true }
            );
            return;
          }

          const status = res.statusCode || 0;

          if (status === 404 || status === 403 || status === 410) {
            bad.add(url);
            return;
          }

          const body =
            typeof res.body === "string"
              ? res.body
              : Buffer.isBuffer(res.body)
              ? res.body.toString("utf8")
              : String(res.body ?? "");

          let outLinks = [];
          let paragraphText = "";
          let termFreq = {};
          let wordCount = 0;

          if (status === 200 && res.$) {
            outLinks = extractLinksFromCheerio(res.$, url).filter((to) =>
              isAllowedUrl(dataset, to, siteRoot)
            );

            ({ paragraphText, termFreq, wordCount } =
              extractParagraphIndexFromCheerio(res.$));
          } else {
            outLinks = [];
          }

          await pagesCol().updateOne(
            { dataset, url },
            {
              $set: {
                dataset,
                url,
                status,
                html: status === 200 ? body : null,
                outLinks,
                paragraphText,
                termFreq,
                wordCount,
                fetchedAt: new Date(),
              },
            },
            { upsert: true }
          );

          if (outLinks.length) {
            const edges = outLinks
              .filter((to) => to !== url)
              .map((to) => ({ dataset, from: url, to }));

            if (edges.length) {
              await linksCol()
                .insertMany(edges, { ordered: false })
                .catch((err) => {
                  if (!String(err?.message || "").includes("E11000")) throw err;
                });
            }

            // Keep enqueuing until cap reached
            if (!reachedCap) {
              for (const link of outLinks) {
                if (!seen.has(link) && !bad.has(link)) enqueue(c, link);
              }
            }
          }
        } catch (e) {
          reject(e);
        } finally {
          done();
        }
      },
    });

    c.on("drain", resolve);
    c.on("error", reject);

    enqueue(c, seed);
  });

  console.log(`Done crawling dataset: ${dataset}. Pages seen: ${seen.size}`);
  if (dataset === "personal" && seen.size < 500) {
    console.warn(`WARNING: personal dataset only reached ${seen.size} pages (< 500). Consider broadening root to https://carleton.ca/ with a whitelist.`);
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log("Usage: node crawler.js <tinyfruits|fruits100|fruitsA|personal|all>");
    process.exit(1);
  }

  if (arg === "all") {
    for (const d of Object.keys(DATASETS)) await crawlDataset(d);
  } else {
    await crawlDataset(arg);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
