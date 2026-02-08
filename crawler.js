require("dotenv").config();

const crawlerPkg = require("crawler");
const Crawler = crawlerPkg.default ?? crawlerPkg; // handles default-export packages
const { URL } = require("url");
const { connectDB, pagesCol, linksCol } = require("./db");

const DATASETS = {
  tinyfruits: "https://people.scs.carleton.ca/~avamckenney/tinyfruits/N-0.html",
  fruits100: "https://people.scs.carleton.ca/~avamckenney/fruits100/N-0.html",
  fruitsA: "https://people.scs.carleton.ca/~avamckenney/fruitsA/N-0.html",
  fruitgraph: "https://people.scs.carleton.ca/~avamckenney/fruitgraph/N-0.html",
};

function normalizeUrl(u) {
  const url = new URL(u);
  url.hash = "";
  url.protocol = "https:"; // unify http/https
  let s = url.toString();
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// Dataset crawl boundary should be the instructor subtree: https://people.scs.carleton.ca/~avamckenney/
function siteRootFromSeed(seed) {
  const u = new URL(seed);
  return `${u.origin}/~avamckenney/`;
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

async function ensureIndexes() {
  await pagesCol().createIndex({ dataset: 1, url: 1 }, { unique: true });
  await linksCol().createIndex({ dataset: 1, from: 1, to: 1 }, { unique: true });
}

async function crawlDataset(dataset) {
  const seed = DATASETS[dataset];
  if (!seed) throw new Error(`Unknown dataset: ${dataset}`);

  await connectDB();
  await ensureIndexes();

  const siteRoot = siteRootFromSeed(seed);
  const seen = new Set();

  // Wrap crawler completion in a Promise that resolves on drain
  await new Promise((resolve, reject) => {
    const c = new Crawler({
      maxConnections: 10,
      rateLimit: 0,
      timeout: 20000,
      retries: 1,
      retryInterval: 1000,
      // Cheerio enabled by default; res.$ is available :contentReference[oaicite:2]{index=2}
      callback: async (error, res, done) => {
        try {
          const url = normalizeUrl(res.options.url);

          // Hard boundary
          if (!url.startsWith(siteRoot)) return;

          if (seen.has(url)) return;
          seen.add(url);

          if (error) {
            await pagesCol().updateOne(
              { dataset, url },
              {
                $set: {
                  dataset,
                  url,
                  status: 0,
                  html: null,
                  outLinks: [],
                  fetchedAt: new Date(),
                  error: String(error.message || error),
                },
              },
              { upsert: true }
            );
            return;
          }

          const status = res.statusCode || 0;
          const body =
            typeof res.body === "string"
              ? res.body
              : Buffer.isBuffer(res.body)
              ? res.body.toString("utf8")
              : String(res.body ?? "");

          // Only proceed on successful HTML fetch
          let outLinks = [];
          if (status === 200 && res.$) {
            outLinks = extractLinksFromCheerio(res.$, url).filter((to) => to.startsWith(siteRoot));
          }

          // Store page
          await pagesCol().updateOne(
            { dataset, url },
            {
              $set: {
                dataset,
                url,
                status,
                html: status === 200 ? body : null,
                outLinks,
                fetchedAt: new Date(),
              },
            },
            { upsert: true }
          );

          // Store edges (exclude self-links)
          if (outLinks.length) {
            const edges = outLinks
              .filter((to) => to !== url)
              .map((to) => ({ dataset, from: url, to }));

            if (edges.length) {
              await linksCol()
                .insertMany(edges, { ordered: false })
                .catch((err) => {
                  // ignore dup key errors from unique index
                  if (!String(err?.message || "").includes("E11000")) throw err;
                });
            }

            // Enqueue discovered links (BFS-ish)
            for (const link of outLinks) {
              if (!seen.has(link) && link.startsWith(siteRoot)) {
                // contentReference[oaicite:3]{index=3}
                c.add({ url: link });
              }
            }
          }
        } catch (e) {
          reject(e);
        } finally {
          done(); // must be called :contentReference[oaicite:4]{index=4}
        }
      },
    });

    c.on("drain", resolve);
    c.on("error", reject);

    // Start crawl
    c.add({ url: seed });
  });

  console.log(`Done crawling dataset: ${dataset}`);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log("Usage: node crawler.js <tinyfruits|fruits100|fruitsA|fruitgraph|all>");
    process.exit(1);
  }

  if (arg === "all") {
    for (const d of Object.keys(DATASETS)) {
      await crawlDataset(d);
    }
  } else {
    await crawlDataset(arg);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
