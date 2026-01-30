require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const { connectDB, pagesCol, linksCol } = require("./db");

const DATASETS = {
  tinyfruits: "https://people.scs.carleton.ca/~avamckenney/tinyfruits/N-0.html",
  fruits100: "https://people.scs.carleton.ca/~avamckenney/fruits100/N-0.html",
  fruitsA: "https://people.scs.carleton.ca/~avamckenney/fruitsA/N-0.html",
  fruitgraph: "https://people.scs.carleton.ca/~avamckenney/fruitgraph/N-0.html"
};

function normalizeUrl(u) {
  return u.split("#")[0];
}

function baseDirFromSeed(seed) {
  // seed ends with N-0.html; use directory as dataset boundary
  return seed.substring(0, seed.lastIndexOf("/") + 1);
}

function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    const abs = new URL(href, baseUrl).toString();
    links.push(normalizeUrl(abs));
  });
  return [...new Set(links)];
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

  const baseDir = baseDirFromSeed(seed);

  const queue = [seed];
  const seen = new Set(); // optimization; DB unique index is the hard guarantee

  while (queue.length) {
    const url = queue.shift();
    if (!url) continue;

    const norm = normalizeUrl(url);
    if (seen.has(norm)) continue;
    seen.add(norm);

    // Avoid recrawl across reruns
    const already = await pagesCol().findOne({ dataset, url: norm }, { projection: { _id: 1 } });
    if (already) continue;

    let status = 0;
    let html = null;
    let outLinks = [];

    try {
      const res = await axios.get(norm, { timeout: 10000 });
      status = res.status;
      html = typeof res.data === "string" ? res.data : String(res.data);
      outLinks = extractLinks(html, norm);
    } catch (e) {
      status = e.response?.status ?? 0;
      // store failure (still counts as "attempted" for the dataset)
      await pagesCol()
        .insertOne({
          dataset,
          url: norm,
          status,
          html: null,
          outLinks: [],
          fetchedAt: new Date(),
          error: String(e.message),
        })
        .catch(err => {
          // ignore dup key errors
          if (err?.code !== 11000) throw err;
        });

      continue;
    }

    // Store page content + outgoing links
    await pagesCol()
      .insertOne({
        dataset,
        url: norm,
        status,
        html,
        outLinks,
        fetchedAt: new Date(),
      })
      .catch(err => {
        if (err?.code !== 11000) throw err;
      });

    // Store network edges
    if (outLinks.length) {
      const edges = outLinks
        .filter(to => to.startsWith(baseDir))
        .map(to => ({ dataset, from: norm, to }));

      if (edges.length) {
        // insertMany ordered:false so duplicates don't stop batch
        await linksCol().insertMany(edges, { ordered: false }).catch(err => {
          // ignore duplicate key bulk errors
          if (err?.code !== 11000 && err?.code !== 11001) {
            // If it's dup keys, it's fine; otherwise throw.
            if (!String(err.message || "").includes("E11000")) throw err;
          }
        });
      }
    }

    // BFS: enqueue discovered links within the dataset directory
    for (const link of outLinks) {
      if (link.startsWith(baseDir)) queue.push(link);
    }
  }

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
  }
  else {
    await crawlDataset(arg);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
