require("dotenv").config();
const { connectDB, productsCol, ordersCol, pagesCol, linksCol } = require("./db");
const { ObjectId } = require("mongodb");

const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Helpers ---
function validateNewProduct(body) {
  if (typeof body !== "object" || body === null) return "Body must be a JSON object.";

  const { name, price, dimensions, stock } = body;

  if (typeof name !== "string" || name.trim().length === 0) return "Field 'name' must be a non-empty string.";
  if (typeof price !== "number" || Number.isNaN(price) || price < 0) return "Field 'price' must be a non-negative number.";

  if (typeof dimensions !== "object" || dimensions === null) return "Field 'dimensions' must be an object with x, y, z.";
  const { x, y, z } = dimensions;
  for (const [k, v] of Object.entries({ x, y, z })) {
    if (typeof v !== "number" || Number.isNaN(v) || v <= 0) return `Dimension '${k}' must be a number > 0.`;
  }

  if (typeof stock !== "number" || !Number.isInteger(stock) || stock < 0) {
    return "Field 'stock' must be an integer >= 0.";
  }

  return null;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function productToHtml(product) {
  const reviews = Array.isArray(product.reviews) ? product.reviews : [];
  const avg = reviews.length
    ? (reviews.reduce((a, b) => a + b, 0) / reviews.length).toFixed(2)
    : "N/A";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Product ${product._id}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    .card { border: 1px solid #ddd; padding: 16px; border-radius: 8px; max-width: 640px; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(product.name)} <small>(ID: ${product._id})</small></h1>
    <p><b>Price:</b> $${product.price}</p>
    <p><b>Stock:</b> ${product.stock}</p>
    <p><b>Dimensions:</b> x=${product.dimensions.x}, y=${product.dimensions.y}, z=${product.dimensions.z}</p>
    <p><b>Reviews:</b> ${reviews.length} (avg: ${avg})</p>

    <h2>Links</h2>
    <ul>
      <li><a href="/products/${product._id}">This product (HTML)</a></li>
      <li><a href="/reviews/${product._id}">This product's reviews (HTML)</a></li>
      <li><a href="/index.html">Back to client</a></li>
    </ul>

    <h2>JSON representation</h2>
    <p>Request this same URL with <code>Accept: application/json</code>.</p>
  </div>
</body>
</html>`;
}

function reviewsToHtml(product) {
  const reviews = Array.isArray(product.reviews) ? product.reviews : [];
  const items = reviews.length
    ? reviews.map((r, i) => `<li>Review #${i + 1}: <b>${r}</b></li>`).join("")
    : "<li><i>No reviews yet.</i></li>";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Reviews for Product ${product._id}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    .card { border: 1px solid #ddd; padding: 16px; border-radius: 8px; max-width: 640px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Reviews for: ${escapeHtml(product.name)} (ID: ${product._id})</h1>
    <ul>${items}</ul>
    <p><a href="/products/${product._id}">Back to product</a></p>
    <p><a href="/index.html">Back to client</a></p>
    <p>To retrieve JSON, request this same URL with <code>Accept: application/json</code>.</p>
  </div>
</body>
</html>`;
}

// --- PageRank helpers ---
const pagerankCache = new Map(); // datasetName -> Map(url -> score)

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

async function computePageRanksForDataset(datasetName) {
  // Return cached values if already computed
  if (pagerankCache.has(datasetName)) {
    return pagerankCache.get(datasetName);
  }

  const pages = await pagesCol()
    .find({ dataset: datasetName }, { projection: { url: 1 } })
    .toArray();

  if (!pages.length) {
    return null;
  }

  const urls = pages.map(p => p.url);
  const N = urls.length;

  // URL -> index
  const indexByUrl = new Map();
  urls.forEach((url, i) => indexByUrl.set(url, i));

  // Load links
  const allLinks = await linksCol()
    .find({ dataset: datasetName }, { projection: { from: 1, to: 1, _id: 0 } })
    .toArray();

  // Build adjacency list using ONLY pages in this dataset
  const outNeighbors = Array.from({ length: N }, () => new Set());

  for (const link of allLinks) {
    const fromIdx = indexByUrl.get(link.from);
    const toIdx = indexByUrl.get(link.to);

    if (fromIdx === undefined || toIdx === undefined) continue;

    // Ignore self-links
    if (fromIdx === toIdx) continue;

    outNeighbors[fromIdx].add(toIdx);
  }

  // Iterative PageRank: alpha = teleport probability
  const alpha = 0.1;
  const threshold = 0.0001;

  let pr = Array(N).fill(1 / N);
  let next = Array(N).fill(0);

  while (true) {
    const base = alpha / N;

    // Reset next vector with teleport contribution
    for (let i = 0; i < N; i++) next[i] = base;

    // Dangling mass (pages with no outgoing links)
    let danglingMass = 0;
    for (let i = 0; i < N; i++) {
      if (outNeighbors[i].size === 0) {
        danglingMass += pr[i];
      }
    }

    // Distribute dangling mass uniformly
    const danglingContribution = (1 - alpha) * (danglingMass / N);
    for (let i = 0; i < N; i++) {
      next[i] += danglingContribution;
    }

    // Distribute normal link-following mass
    for (let j = 0; j < N; j++) {
      const outDeg = outNeighbors[j].size;
      if (outDeg === 0) continue;

      const share = (1 - alpha) * (pr[j] / outDeg);
      for (const i of outNeighbors[j]) {
        next[i] += share;
      }
    }

    // Check convergence
    const dist = euclideanDistance(pr, next);
    if (dist < threshold) break;

    // Swap vectors
    pr = [...next];
  }

  // Save as URL -> score map
  const scoreMap = new Map();
  for (let i = 0; i < N; i++) {
    scoreMap.set(urls[i], pr[i]);
  }

  pagerankCache.set(datasetName, scoreMap);
  return scoreMap;
}

function parseBoost(v) {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s === "true";
}

function parseLimit(v) {
  let n = 10;
  if (typeof v === "string" && v.trim().length) {
    const x = Number(v);
    if (Number.isFinite(x)) n = Math.trunc(x);
  }
  if (n < 1) n = 1;
  if (n > 50) n = 50;
  return n;
}

function safeTitle(page) {
  const t = (page && typeof page.title === "string") ? page.title.trim() : "";
  if (t) return t;
  const url = page?.url || "";
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || url;
  } catch {
    return url;
  }
}

// --- Routes ---
app.get("/", (req, res) => {
  res.send("Server running. Open /index.html for the client.");
});

/**
 * 1) Search products by name and/or inStock/all
 * GET /products?name=chair&stock=inStock
 */
app.get("/products", async (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  const stock = typeof req.query.stock === "string" ? req.query.stock : "all";

  const filter = {};

  if (name) filter.name = { $regex: name, $options: "i" };

  if (stock === "inStock") {
    filter.stock = { $gt: 0 };
  } else if (stock !== "all") {
    return res.status(400).json({ error: "Invalid stock value. Use 'all' or 'inStock'." });
  }

  const products = await productsCol().find(filter).toArray();
  res.json(products);
});

/**
 * 2) Create a new product
 * POST /products
 */
app.post("/products", async (req, res) => {
  const err = validateNewProduct(req.body);
  if (err) return res.status(400).json({ error: err });

  const newProduct = { ...req.body, reviews: [] };
  const result = await productsCol().insertOne(newProduct);

  res.status(201).json({ _id: result.insertedId, ...newProduct });
});

/**
 * 3) Retrieve a product by ID, JSON or HTML (via Accept header)
 * GET /products/:id
 */
app.get("/products/:id", async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const product = await productsCol().findOne({ _id });

    if (!product) return res.status(404).json({ error: "Product not found." });

    res.format({
      "application/json": () => res.json(product),
      "text/html": () => res.type("html").send(productToHtml(product)),
      default: () => res.status(406).send("Not Acceptable"),
    });
  } catch {
    return res.status(400).json({ error: "Invalid product ID format." });
  }
});

/**
 * 4) Add a review (rating 1-10) for a product
 * POST /reviews/:id
 * body: { "rating": 7 }
 */
app.post("/reviews/:id", async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const rating = req.body?.rating;

    if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
      return res.status(400).json({ error: "Rating must be an integer from 1 to 10." });
    }

    const result = await productsCol().findOneAndUpdate(
      { _id },
      { $push: { reviews: rating } },
      { returnDocument: "after" }
    );

    if (!result.value) return res.status(404).json({ error: "Product not found." });

    res.status(201).json({
      productId: _id.toString(),
      reviews: result.value.reviews,
    });
  } catch {
    return res.status(400).json({ error: "Invalid product ID format." });
  }
});

/**
 * 5) Get only reviews for a product, JSON or HTML
 * GET /reviews/:id
 */
app.get("/reviews/:id", async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const product = await productsCol().findOne({ _id });

    if (!product) return res.status(404).json({ error: "Product not found." });

    const reviews = Array.isArray(product.reviews) ? product.reviews : [];

    res.format({
      "application/json": () => res.json({ productId: _id.toString(), reviews }),
      "text/html": () => res.type("html").send(reviewsToHtml(product)),
      default: () => res.status(406).send("Not Acceptable"),
    });
  } catch {
    return res.status(400).json({ error: "Invalid product ID format." });
  }
});

/**
 * POST /orders
 * GET /orders
 * GET /orders/:id
 */
function normalizeOrderItems(items) {
  // Combine duplicates by productId
  const map = new Map();
  for (const it of items) {
    map.set(it.productId, (map.get(it.productId) || 0) + it.quantity);
  }
  return [...map.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

app.post("/orders", async (req, res) => {
  const { customerName, items } = req.body ?? {};

  const problems = [];

  if (typeof customerName !== "string" || customerName.trim().length === 0) {
    problems.push("Missing purchaser name: 'customerName' must be a non-empty string.");
  }

  if (!Array.isArray(items) || items.length === 0) {
    problems.push("Missing items: 'items' must be a non-empty array.");
  } else {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (typeof it !== "object" || it === null) {
        problems.push(`Item #${i + 1} must be an object.`);
        continue;
      }
      if (typeof it.productId !== "string" || it.productId.trim().length === 0) {
        problems.push(`Item #${i + 1}: 'productId' must be a non-empty string.`);
      }
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        problems.push(`Item #${i + 1}: 'quantity' must be an integer > 0.`);
      }
    }
  }

  if (problems.length) {
    return res.status(409).json({ error: "Invalid order", problems });
  }

  // Normalize duplicates
  const normalized = normalizeOrderItems(items);

  // Convert ids + fetch products
  const parsed = [];
  for (const it of normalized) {
    let _id;
    try {
      _id = new ObjectId(it.productId);
    } catch {
      return res.status(409).json({
        error: "Invalid order",
        problems: [`Invalid productId format: ${it.productId}`],
      });
    }

    const product = await productsCol().findOne({ _id });
    if (!product) {
      return res.status(409).json({
        error: "Invalid order",
        problems: [`Product does not exist: productId=${it.productId}`],
      });
    }

    parsed.push({ _id, quantity: it.quantity, product });
  }

  // Stock check + decrement using conditional update (prevents negative stock)
  for (const it of parsed) {
    const result = await productsCol().updateOne(
      { _id: it._id, stock: { $gte: it.quantity } },
      { $inc: { stock: -it.quantity } }
    );

    if (result.matchedCount === 0) {
      return res.status(409).json({
        error: "Invalid order",
        problems: [
          `Insufficient stock for productId=${it._id.toString()} (${it.product.name}): requested=${it.quantity}, available=${it.product.stock}`,
        ],
      });
    }
  }

  // Create order snapshot once
  const orderDoc = {
    customerName: customerName.trim(),
    createdAt: new Date(),
    items: parsed.map(it => ({
      productId: it._id.toString(),
      quantity: it.quantity,
      name: it.product.name,
      unitPrice: it.product.price,
    })),
  };

  const insert = await ordersCol().insertOne(orderDoc);

  res.status(201)
    .set("Location", `/orders/${insert.insertedId.toString()}`)
    .json({
      _id: insert.insertedId,
      ...orderDoc,
      links: { self: `/orders/${insert.insertedId.toString()}` },
    });
});

app.get("/orders", async (req, res) => {
  const orders = await ordersCol()
    .find({}, { projection: { customerName: 1, createdAt: 1, items: 1 } })
    .sort({ createdAt: -1 })
    .toArray();

  res.json(
    orders.map(o => ({
      _id: o._id,
      customerName: o.customerName,
      createdAt: o.createdAt,
      itemCount: Array.isArray(o.items) ? o.items.length : 0,
      links: { self: `/orders/${o._id.toString()}` },
    }))
  );
});

app.get("/orders/:id", async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const order = await ordersCol().findOne({ _id });

    if (!order) return res.status(404).json({ error: "Order not found." });

    res.json({
      _id: order._id,
      customerName: order.customerName,
      createdAt: order.createdAt,
      items: order.items || [],
      links: { self: `/orders/${order._id.toString()}` },
    });
  } catch {
    return res.status(400).json({ error: "Invalid order ID format." });
  }
});

/**
 * 1) GET /:datasetName/popular
 * 2) GET /:datasetName/pages/:pageId
 */

// Popular pages: top 10 by incoming link count
app.get("/:datasetName/popular", async (req, res) => {
  const datasetName = req.params.datasetName;
  const base = `${req.protocol}://${req.get("host")}`;

  try {
    const top10 = await linksCol()
      .aggregate([
        { $match: { dataset: datasetName } },

        // exclude self-links
        { $match: { $expr: { $ne: ["$from", "$to"] } } },

        // unique incoming sources (dedupe by from->to)
        { $group: { _id: { to: "$to", from: "$from" } } },
        { $group: { _id: "$_id.to", incomingCount: { $sum: 1 } } },

        // deterministic ordering
        { $sort: { incomingCount: -1, _id: 1 } },
        { $limit: 10 },

        // join to pages to get the page document _id for this dataset+url
        {
          $lookup: {
            from: "pages",
            let: { toUrl: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$dataset", datasetName] },
                      { $eq: ["$url", "$$toUrl"] },
                    ],
                  },
                },
              },
              { $project: { _id: 1, url: 1 } },
              { $limit: 1 },
            ],
            as: "page",
          },
        },
        { $unwind: { path: "$page", preserveNullAndEmptyArrays: true } },
      ])
      .toArray();

    const result = top10.map((row) => {
      const origUrl = row._id;
      return {
        url: row.page?._id
          ? `${base}/${datasetName}/pages/${row.page._id.toString()}`
          : `${base}/${datasetName}/pages/byUrl/${encodeURIComponent(origUrl)}`,
        origUrl,
      };
    });

    res.json({ result });
  } catch (err) {
    console.error("Error in /popular:", err);
    res.status(500).json({ error: "Failed to compute popular pages." });
  }
});

// Page details: original URL + list of incoming links
app.get("/:datasetName/pages/:pageId", async (req, res) => {
  const datasetName = req.params.datasetName;
  const pageId = req.params.pageId;

  try {
    if (!ObjectId.isValid(pageId)) {
      return res.status(400).json({ error: "Invalid page id." });
    }

    const _id = new ObjectId(pageId);

    // Find the page doc to get its original crawled URL
    const page = await pagesCol().findOne(
      { _id, dataset: datasetName },
      { projection: { url: 1 } }
    );

    if (!page) {
      return res.status(404).json({ error: "Page not found." });
    }

    // Incoming links are link docs where `to` == this page's url
    const incoming = await linksCol()
      .find(
        { dataset: datasetName, to: page.url },
        { projection: { from: 1, _id: 0 } }
      )
      .toArray();

    const incomingLinks = [...new Set(incoming.map(x => x.from))];

    res.json({
      webUrl: page.url,
      incomingLinks
    });
  } catch (err) {
    console.error("Error in /pages/:pageId:", err);
    res.status(500).json({ error: "Failed to fetch page details." });
  }
});

// Optional fallback if /popular couldn't find the page doc by _id
app.get("/:datasetName/pages/byUrl/:encodedUrl", async (req, res) => {
  const datasetName = req.params.datasetName;
  const webUrl = decodeURIComponent(req.params.encodedUrl);

  try {
    const incoming = await linksCol()
      .find(
        { dataset: datasetName, to: webUrl },
        { projection: { from: 1, _id: 0 } }
      )
      .toArray();

    const incomingLinks = [...new Set(incoming.map(x => x.from))];

    res.json({
      webUrl,
      incomingLinks
    });
  } catch (err) {
    console.error("Error in /pages/byUrl:", err);
    res.status(500).json({ error: "Failed to fetch page details." });
  }
});

// PageRank value by URL (plain text) and store PR to DB
app.get("/pageranks", async (req, res) => {
  try {
    const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!url) {
      return res.status(400).type("text/plain").send("Missing query parameter url");
    }

    const page = await pagesCol().findOne({ url }, { projection: { url: 1, dataset: 1 } });
    if (!page) {
      return res.status(404).type("text/plain").send("URL not found");
    }

    const datasetName = page.dataset;

    let prMap = pagerankCache.get(datasetName);
    if (!prMap) {
      prMap = await computePageRanksForDataset(datasetName);
      if (!prMap) return res.status(404).type("text/plain").send("Dataset not found");

      // Add PageRank to DB
      const bulk = [];
      for (const [u, pr] of prMap.entries()) {
        bulk.push({
          updateOne: {
            filter: { dataset: datasetName, url: u },
            update: { $set: { pr } },
          },
        });
      }
      if (bulk.length) await pagesCol().bulkWrite(bulk, { ordered: false });

      pagerankCache.set(datasetName, prMap);
    }

    const score = prMap.get(url);
    if (score === undefined) return res.status(404).type("text/plain").send("URL not found");

    res.type("text/plain").send(String(score));
  } catch (err) {
    console.error("Pagerank error:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

// Page details for UI (optional)
app.get("/page", async (req, res) => {
  try {
    const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!url) return res.status(400).json({ error: "Missing query parameter url" });

    const page = await pagesCol().findOne(
      { url },
      { projection: { _id: 0, dataset: 1, url: 1, title: 1, termFreq: 1, wordCount: 1, pr: 1, outLinks: 1 } }
    );
    if (!page) return res.status(404).json({ error: "URL not found" });

    if (typeof page.pr !== "number") {
      const prMap = pagerankCache.get(page.dataset) || await computePageRanksForDataset(page.dataset);
      if (prMap) {
        const bulk = [];
        for (const [u, pr] of prMap.entries()) {
          bulk.push({ updateOne: { filter: { dataset: page.dataset, url: u }, update: { $set: { pr } } } });
        }
        if (bulk.length) await pagesCol().bulkWrite(bulk, { ordered: false });
        pagerankCache.set(page.dataset, prMap);
        page.pr = prMap.get(url) ?? 0;
      } else {
        page.pr = 0;
      }
    }

    const incoming = await linksCol()
      .find({ dataset: page.dataset, to: url }, { projection: { from: 1, _id: 0 } })
      .toArray();

    const outgoing = await linksCol()
      .find({ dataset: page.dataset, from: url }, { projection: { to: 1, _id: 0 } })
      .toArray();

    res.json({
      url: page.url,
      title: safeTitle(page),
      pr: page.pr ?? 0,
      incomingLinks: [...new Set(incoming.map(x => x.from))],
      outgoingLinks: [...new Set(outgoing.map(x => x.to))],
      wordCount: page.wordCount ?? 0,
      termFreq: page.termFreq || {},
      outLinks: page.outLinks || []
    });
  } catch (err) {
    console.error("Error in /page:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Search endpoint for datasets (supports q, boost, limit; returns url, score, title, pr)
app.get('/:datasetName', async (req, res) => {
  try {
    const datasetName = req.params.datasetName;

    // Support q and phrase; assignment specifies q
    const queryText =
      (typeof req.query.q === "string" ? req.query.q : "") ||
      (typeof req.query.phrase === "string" ? req.query.phrase : "");

    const boost = parseBoost(req.query.boost);
    const limit = parseLimit(req.query.limit);

    const dataset = await pagesCol()
      .find({ dataset: datasetName })
      .toArray();

    if (!dataset.length) {
      return res.status(404).json({ error: "Dataset not found" });
    }

    // Ensure PR is available (required pr field; also needed for boost)
    if (!pagerankCache.has(datasetName)) {
      const prMap = await computePageRanksForDataset(datasetName);
      if (prMap) {
        const bulk = [];
        for (const [u, pr] of prMap.entries()) {
          bulk.push({
            updateOne: { filter: { dataset: datasetName, url: u }, update: { $set: { pr } } }
          });
        }
        if (bulk.length) await pagesCol().bulkWrite(bulk, { ordered: false });
        pagerankCache.set(datasetName, prMap);
      }
    }

    // If no query, MUST return exactly limit results with score=0
    if (!queryText || !queryText.trim().length) {
      const out = dataset.slice(0, limit).map(p => ({
        url: p.url,
        score: 0,
        title: safeTitle(p),
        pr: (typeof p.pr === "number") ? p.pr : (pagerankCache.get(datasetName)?.get(p.url) ?? 0)
      }));
      return res.json({ result: out });
    }

    const documentFrequency = {};
    for (const page of dataset) {
      for (const word of Object.keys(page.termFreq || {})) {
        documentFrequency[word] = (documentFrequency[word] || 0) + 1;
      }
    }

    const idf = {};
    const totalDocuments = dataset.length;
    for (const [word, df] of Object.entries(documentFrequency)) {
      idf[word] = Math.max(0, Math.log2(totalDocuments / (1 + df)));
    }

    const rawQueryWords = queryText
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 0);

    // If tokenizer yields nothing, return any limit docs with score 0
    if (rawQueryWords.length === 0) {
      const out = dataset.slice(0, limit).map(p => ({
        url: p.url,
        score: 0,
        title: safeTitle(p),
        pr: (typeof p.pr === "number") ? p.pr : (pagerankCache.get(datasetName)?.get(p.url) ?? 0)
      }));
      return res.json({ result: out });
    }

    const queryLength = rawQueryWords.length;

    const queryFrequency = {};
    for (const word of rawQueryWords) {
      queryFrequency[word] = (queryFrequency[word] || 0) + 1;
    }

    const vocabulary = Object.keys(queryFrequency).filter(word => (idf[word] || 0) > 0);

    // If all query terms have idf==0, scores will be 0; still return limit docs
    if (vocabulary.length === 0) {
      const out = dataset.slice(0, limit).map(p => ({
        url: p.url,
        score: 0,
        title: safeTitle(p),
        pr: (typeof p.pr === "number") ? p.pr : (pagerankCache.get(datasetName)?.get(p.url) ?? 0)
      }));
      return res.json({ result: out });
    }

    const queryVector = [];
    let queryMagSquared = 0;
    for (const word of vocabulary) {
      const tf = queryFrequency[word] / queryLength;
      const tfidf = Math.log2(1 + tf) * idf[word];
      queryVector.push(tfidf);
      queryMagSquared += tfidf * tfidf;
    }

    const queryMagnitude = Math.sqrt(queryMagSquared);

    const results = [];
    for (const page of dataset) {
      let dot = 0;
      let pageMagSquared = 0;

      for (let i = 0; i < vocabulary.length; i++) {
        const word = vocabulary[i];

        const freq = (page.termFreq && page.termFreq[word]) ? page.termFreq[word] : 0;
        const wc = page.wordCount || 0;
        const tf = wc > 0 ? (freq / wc) : 0;
        const tfidf = Math.log2(1 + tf) * idf[word];

        dot += tfidf * queryVector[i];
        pageMagSquared += tfidf * tfidf;
      }

      const pageMagnitude = Math.sqrt(pageMagSquared);

      const baseScore =
        pageMagnitude === 0 || queryMagnitude === 0
          ? 0
          : dot / (pageMagnitude * queryMagnitude);

      const pr = (typeof page.pr === "number") ? page.pr : (pagerankCache.get(datasetName)?.get(page.url) ?? 0);
      const finalScore = boost ? (baseScore * (1 + pr)) : baseScore;

      results.push({
        url: page.url,
        score: finalScore,
        title: safeTitle(page),
        pr
      });
    }

    results.sort((a, b) => (b.score - a.score) || a.url.localeCompare(b.url));

    // MUST return exactly limit results (fruitsA dataset has 100 pages, limit max 50)
    res.json({
      result: results.slice(0, limit)
    });

  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start the server after connecting to the database
connectDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });