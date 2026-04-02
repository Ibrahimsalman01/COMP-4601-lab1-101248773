require("dotenv").config();
const { connectDB, productsCol, ordersCol, pagesCol, linksCol } = require("./db");
const { ObjectId } = require("mongodb");

const express = require("express");
const path = require("path");

const { readFile, loadDatasetFromFile } = require("./recommender");

const DATASET_FILES = {
  test: path.join(__dirname, "test.txt"),
  test2: path.join(__dirname, "test2.txt"),
  test3: path.join(__dirname, "test3.txt"),
  test4: path.join(__dirname, "test4.txt"),
  test5: path.join(__dirname, "test5.txt")
};

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// -------------------- Helpers: products/orders --------------------
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

// ------------------------------- Lab 9 ----------------------------
app.get('/recommendations/:datasetName', async (req, res) => {
  try {
    const datasetName = req.params.datasetName;

    const type = typeof req.query.type === "string" ? req.query.type.trim() : "";

    if (!type) {
      return res.status(400).json({ error: "Missing required query parameters: type" });
    }

    const filePath = DATASET_FILES[datasetName];
    if (!filePath) {
      return res.status(404).json({ error: `Unknown dataset: ${datasetName}` });
    }

    const ds = await loadDatasetFromFile(datasetName, filePath);

    // 1. get items that user1 rated 1
    const userOneRatedItems = ds.ratings[0];
    const otherUserRatedItems = ds.ratings.slice(1);

    // 2. find the users that are connected to those items
    const connectedPaths = Array.from({ length: ds.N - 1 }, () => new Array(ds.M).fill(0));
    // console.log(connectedPaths);
    for (let i = 0; i < otherUserRatedItems.length; i++) {
      for (let j = 0; j < otherUserRatedItems[i].length; j++) {
        if (otherUserRatedItems[i][j] === 1 && userOneRatedItems[j] === 1) connectedPaths[i][j] = 1;
        else connectedPaths[i][j] = 0;
      } 
    }

    // intermediary step to filter out any of the connectedPaths' arrays that don't have any 1s
    const filteredConnectedPaths = connectedPaths.filter((arr) => !arr.every(val => val === 0));
    
    // 3. check out the items those users liked, that user1 hasn't already liked
    // in other words, take note of the values that are 1 for other users and 0 for user1
    const itemsToRecommend = Array.from({ length: filteredConnectedPaths.length }, () => new Array(ds.M).fill(0));
    for (let i = 0; i < filteredConnectedPaths.length; i++) {
      for (let j = 0; j < filteredConnectedPaths[i].length; j++) {
        if (otherUserRatedItems[i][j] === 1 && userOneRatedItems[j] === 0) itemsToRecommend[i][j] = 1;
        else itemsToRecommend[i][j] = 0;
      } 
    }
    console.log(itemsToRecommend);

    // 4. count the paths to those items and rank based on most paths to least
    const results = [];
    for (let i = 0; i < filteredConnectedPaths.length; i++) {
      const pathCount = filteredConnectedPaths[i].reduce((sum, val) => sum + val, 0);

      for (let j = 0; j < ds.M; j++) {
        if (itemsToRecommend[i][j] === 1) {
          let item = results.find(obj => obj.name === `Item${j + 1}`);
          if (!item) {
            item = { name: `Item${j + 1}`, votes: 0 };
            results.push(item);
          }
          item.votes += pathCount;
        }
      }
    }

    results.sort((a, b) => b.votes - a.votes);
    return res.json({ results });
  } catch (e) {
    console.error(e)
  }
});


// -------------------- Search + PageRank caches --------------------
/**
 * datasetCache:
 *  name -> {
 *    pages: Array<pageDoc>,
 *    idf: Record<string, number>,
 *    prMap: Map<string,urlPr>,
 *    ready: boolean,
 *    warmingPromise: Promise<void> | null
 *  }
 */
const datasetCache = new Map();

function getDatasetState(name) {
  if (!datasetCache.has(name)) {
    datasetCache.set(name, {
      pages: [],
      idf: Object.create(null),
      prMap: new Map(),
      ready: false,
      warmingPromise: null,
    });
  }
  return datasetCache.get(name);
}

function parseBoost(v) {
  if (typeof v !== "string") return false;
  return v.trim().toLowerCase() === "true";
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

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Compute PageRank once for a dataset; capped iterations for speed.
 */
async function computePageRanksForDataset(datasetName, pages) {
  if (!Array.isArray(pages) || pages.length === 0) return new Map();

  const urls = pages.map((p) => p.url);
  const N = urls.length;

  const indexByUrl = new Map();
  for (let i = 0; i < N; i++) indexByUrl.set(urls[i], i);

  const allLinks = await linksCol()
    .find({ dataset: datasetName }, { projection: { from: 1, to: 1, _id: 0 } })
    .toArray();

  console.log(`[pr ${datasetName}] links=${allLinks.length} pages=${pages.length}`);

  // adjacency as arrays for speed
  const outSets = Array.from({ length: N }, () => new Set());
  for (const l of allLinks) {
    const fromIdx = indexByUrl.get(l.from);
    const toIdx = indexByUrl.get(l.to);
    if (fromIdx === undefined || toIdx === undefined) continue;
    if (fromIdx === toIdx) continue;
    outSets[fromIdx].add(toIdx);
  }

  const out = outSets.map((s) => Array.from(s));
  const outDeg = out.map((a) => a.length);

  const alpha = 0.1;
  const threshold = 0.0001;
  const MAX_ITERS = 60; // optimize for speed

  let pr = Array(N).fill(1 / N);
  let next = Array(N).fill(0);

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const base = alpha / N;
    for (let i = 0; i < N; i++) next[i] = base;

    let danglingMass = 0;
    for (let i = 0; i < N; i++) if (outDeg[i] === 0) danglingMass += pr[i];

    const danglingContribution = (1 - alpha) * (danglingMass / N);
    for (let i = 0; i < N; i++) next[i] += danglingContribution;

    // normal
    for (let j = 0; j < N; j++) {
      const d = outDeg[j];
      if (d === 0) continue;
      const share = (1 - alpha) * (pr[j] / d);
      const neigh = out[j];
      for (let k = 0; k < neigh.length; k++) next[neigh[k]] += share;
    }

    const dist = euclideanDistance(pr, next);
    pr = [...next];
    if (dist < threshold) break;
  }

  const prMap = new Map();
  for (let i = 0; i < N; i++) prMap.set(urls[i], pr[i]);
  return prMap;
}

/**
 * Warm dataset cache:
 * - load pages once (projection; exclude html)
 * - build DF/IDF once
 * - mark ready BEFORE PR
 * - compute PR best-effort (doesn't block readiness)
 */
async function warmDataset(datasetName) {
  const st = getDatasetState(datasetName);
  if (st.ready) return;
  if (st.warmingPromise) return st.warmingPromise;

  st.warmingPromise = (async () => {
    const pages = await pagesCol().find(
      { dataset: datasetName, status: 200 },
      { projection: { url: 1, termFreq: 1, wordCount: 1, title: 1 } }
    ).toArray();

    console.log(`[warm ${datasetName}] pages=${pages.length}`);

    st.pages = pages;

    // build DF then IDF
    const df = Object.create(null);
    for (const p of pages) {
      const tf = p.termFreq || {};
      for (const w of Object.keys(tf)) df[w] = (df[w] || 0) + 1;
    }

    const N = pages.length;
    const idf = Object.create(null);
    for (const [w, c] of Object.entries(df)) {
      idf[w] = Math.max(0, Math.log2(N / (1 + c)));
    }
    st.idf = idf;

    // Allow search immediately (even if PR is still computing)
    st.ready = true;

    try {
      st.prMap = await computePageRanksForDataset(datasetName, pages);
    } catch (e) {
      console.error(`PR failed for dataset=${datasetName}:`, e);
      st.prMap = new Map();
    }
  })().catch((e) => {
    console.error(`Warm failed for dataset=${datasetName}:`, e);
    st.ready = false;
  });

  return st.warmingPromise;
}

// -------------------- Search handler (fast, <1s) --------------------
function makeSearchHandler(datasetNameOrParam = null) {
  return async (req, res) => {
    try {
      const datasetName = datasetNameOrParam ?? req.params.datasetName;
      const st = getDatasetState(datasetName);

      // Kick off warm in background if needed; DO NOT await (keeps request fast).
      if (!st.ready) {
        warmDataset(datasetName);
        return res.status(202).json({ result: [], warming: true });
      }

      const queryText =
        (typeof req.query.q === "string" ? req.query.q : "") ||
        (typeof req.query.phrase === "string" ? req.query.phrase : "");

      const boost = parseBoost(req.query.boost);
      const limit = parseLimit(req.query.limit);

      const pages = st.pages || [];
      if (!pages.length) {
        return res.status(404).json({ error: "Dataset not found" });
      }

      const getPr = (p) => (typeof p.pr === "number" ? p.pr : (st.prMap.get(p.url) ?? 0));

      const returnAny = () => {
        const out = pages.slice(0, limit).map((p) => ({
          url: p.url,
          score: 0,
          title: safeTitle(p),
          pr: getPr(p),
        }));
        return res.json({ result: out });
      };

      if (!queryText || !queryText.trim().length) return returnAny();

      const rawQueryWords = queryText.toLowerCase().split(/\W+/).filter(Boolean);
      if (!rawQueryWords.length) return returnAny();

      const qf = Object.create(null);
      for (const w of rawQueryWords) qf[w] = (qf[w] || 0) + 1;

      const vocab = Object.keys(qf).filter((w) => (st.idf[w] || 0) > 0);
      if (!vocab.length) return returnAny();

      const qLen = rawQueryWords.length;

      // query vector + magnitude
      const qVec = new Array(vocab.length);
      let qMag2 = 0;
      for (let i = 0; i < vocab.length; i++) {
        const w = vocab[i];
        const tf = qf[w] / qLen;
        const tfidf = Math.log2(1 + tf) * st.idf[w];
        qVec[i] = tfidf;
        qMag2 += tfidf * tfidf;
      }
      const qMag = Math.sqrt(qMag2);

      const results = [];
      for (const p of pages) {
        let dot = 0;
        let pMag2 = 0;

        const tfMap = p.termFreq || {};
        const wc = p.wordCount || 0;

        for (let i = 0; i < vocab.length; i++) {
          const w = vocab[i];
          const freq = tfMap[w] || 0;
          const tf = wc > 0 ? freq / wc : 0;
          const tfidf = Math.log2(1 + tf) * st.idf[w];

          dot += tfidf * qVec[i];
          pMag2 += tfidf * tfidf;
        }

        const pMag = Math.sqrt(pMag2);
        const base = (pMag === 0 || qMag === 0) ? 0 : dot / (pMag * qMag);

        const pr = getPr(p);
        const score = boost ? base * (1 + pr) : base;

        results.push({
          url: p.url,
          score,
          title: safeTitle(p),
          pr,
        });
      }

      results.sort((a, b) => (b.score - a.score) || a.url.localeCompare(b.url));
      return res.json({ result: results.slice(0, limit) });
    } catch (err) {
      console.error("Search error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.send("Server running. Open /index.html for the client.");
});

// -------------------- Routes: products --------------------
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
  return res.json(products);
});

app.post("/products", async (req, res) => {
  const err = validateNewProduct(req.body);
  if (err) return res.status(400).json({ error: err });

  const newProduct = { ...req.body, reviews: [] };
  const result = await productsCol().insertOne(newProduct);

  return res.status(201).json({ _id: result.insertedId, ...newProduct });
});

app.get("/products/:id", async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const product = await productsCol().findOne({ _id });

    if (!product) return res.status(404).json({ error: "Product not found." });

    return res.format({
      "application/json": () => res.json(product),
      "text/html": () => res.type("html").send(productToHtml(product)),
      default: () => res.status(406).send("Not Acceptable"),
    });
  } catch {
    return res.status(400).json({ error: "Invalid product ID format." });
  }
});

// -------------------- Routes: reviews --------------------
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

    return res.status(201).json({
      productId: _id.toString(),
      reviews: result.value.reviews,
    });
  } catch {
    return res.status(400).json({ error: "Invalid product ID format." });
  }
});

app.get("/reviews/:id", async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const product = await productsCol().findOne({ _id });

    if (!product) return res.status(404).json({ error: "Product not found." });

    const reviews = Array.isArray(product.reviews) ? product.reviews : [];

    return res.format({
      "application/json": () => res.json({ productId: _id.toString(), reviews }),
      "text/html": () => res.type("html").send(reviewsToHtml(product)),
      default: () => res.status(406).send("Not Acceptable"),
    });
  } catch {
    return res.status(400).json({ error: "Invalid product ID format." });
  }
});

// -------------------- Routes: orders --------------------
function normalizeOrderItems(items) {
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

  const normalized = normalizeOrderItems(items);

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

  const orderDoc = {
    customerName: customerName.trim(),
    createdAt: new Date(),
    items: parsed.map((it) => ({
      productId: it._id.toString(),
      quantity: it.quantity,
      name: it.product.name,
      unitPrice: it.product.price,
    })),
  };

  const insert = await ordersCol().insertOne(orderDoc);

  return res
    .status(201)
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

  return res.json(
    orders.map((o) => ({
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

    return res.json({
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

// Popular pages: top 10 by unique incoming link count
app.get("/:datasetName/popular", async (req, res) => {
  const datasetName = req.params.datasetName;
  const base = `${req.protocol}://${req.get("host")}`;

  try {
    const top10 = await linksCol()
      .aggregate([
        { $match: { dataset: datasetName } },
        { $match: { $expr: { $ne: ["$from", "$to"] } } },
        { $group: { _id: { to: "$to", from: "$from" } } },
        { $group: { _id: "$_id.to", incomingCount: { $sum: 1 } } },
        { $sort: { incomingCount: -1, _id: 1 } },
        { $limit: 10 },
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

    return res.json({ result });
  } catch (err) {
    console.error("Error in /popular:", err);
    return res.status(500).json({ error: "Failed to compute popular pages." });
  }
});

function pageToHtml(webUrl, incomingLinks, outgoingLinks, wordFrequency, datasetName, title) {
  const displayTitle = (title && title.trim()) || (() => {
    try {
      const parts = new URL(webUrl).pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || webUrl;
    } catch { return webUrl; }
  })();

  const wordRows = Object.entries(wordFrequency)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => `<li><code>${escapeHtml(word)}</code>: ${count}</li>`)
    .join("");

  const incomingItems = incomingLinks.length
    ? incomingLinks.map((l) => `<li><a href="${escapeHtml(l)}">${escapeHtml(l)}</a></li>`).join("")
    : "<li><i>None</i></li>";

  const outgoingItems = outgoingLinks.length
    ? outgoingLinks.map((l) => `<li><a href="${escapeHtml(l)}">${escapeHtml(l)}</a></li>`).join("")
    : "<li><i>None</i></li>";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Page Details</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    .card { border: 1px solid #ddd; padding: 16px; border-radius: 8px; max-width: 640px; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Page Details</h1>
    <p><b>Title:</b> ${escapeHtml(displayTitle)}</p>
    <p><b>URL:</b> <a href="${escapeHtml(webUrl)}">${escapeHtml(webUrl)}</a></p>
    <p><b>Incoming Links:</b> ${incomingLinks.length}</p>
    <p><b>Outgoing Links:</b> ${outgoingLinks.length}</p>

    <h2>Incoming Links</h2>
    <ul>${incomingItems}</ul>

    <h2>Outgoing Links</h2>
    <ul>${outgoingItems}</ul>

    <h2>Word Frequency</h2>
    <ul>${wordRows || "<li><i>No words indexed.</i></li>"}</ul>

    <h2>Links</h2>
    <ul>
      <li><a href="/index.html">Back to client</a></li>
    </ul>

    <h2>JSON representation</h2>
    <p>Request this same URL with <code>Accept: application/json</code>.</p>
  </div>
</body>
</html>`;
}

// Page details: original URL + list of unique incoming links
app.get("/:datasetName/pages/:pageId", async (req, res) => {
  const datasetName = req.params.datasetName;
  const pageId = req.params.pageId;

  try {
    if (!ObjectId.isValid(pageId)) {
      return res.status(400).json({ error: "Invalid page id." });
    }

    const _id = new ObjectId(pageId);

    const page = await pagesCol().findOne(
      { _id, dataset: datasetName },
      { projection: { url: 1, outLinks: 1, termFreq: 1, title: 1 } }
    );

    if (!page) {
      return res.status(404).json({ error: "Page not found." });
    }

    const incoming = await linksCol()
      .find({ dataset: datasetName, to: page.url }, { projection: { from: 1, _id: 0 } })
      .toArray();

    const incomingLinks = [...new Set(incoming.map((x) => x.from))];
    const outgoingLinks = page.outLinks || [];
    const wordFrequency = page.termFreq || {};

    return res.format({
      "application/json": () => res.json({ webUrl: page.url, incomingLinks, outgoingLinks, wordFrequency }),
      "text/html": () =>
        res.type("html").send(pageToHtml(page.url, incomingLinks, outgoingLinks, wordFrequency, datasetName, page.title)),
      default: () => res.status(406).send("Not Acceptable"),
    });
  } catch (err) {
    console.error("Error in /pages/:pageId:", err);
    return res.status(500).json({ error: "Failed to fetch page details." });
  }
});

// Optional fallback by URL
app.get("/:datasetName/pages/byUrl/:encodedUrl", async (req, res) => {
  const datasetName = req.params.datasetName;
  const webUrl = decodeURIComponent(req.params.encodedUrl);

  try {
    const page = await pagesCol().findOne(
      { dataset: datasetName, url: webUrl },
      { projection: { outLinks: 1, termFreq: 1, title: 1 } }
    );

    const incoming = await linksCol()
      .find({ dataset: datasetName, to: webUrl }, { projection: { from: 1, _id: 0 } })
      .toArray();

    const incomingLinks = [...new Set(incoming.map((x) => x.from))];
    const outgoingLinks = page?.outLinks || [];
    const wordFrequency = page?.termFreq || {};

    return res.format({
      "application/json": () => res.json({ webUrl, incomingLinks, outgoingLinks, wordFrequency }),
      "text/html": () =>
        res.type("html").send(pageToHtml(webUrl, incomingLinks, outgoingLinks, wordFrequency, datasetName, page?.title)),
      default: () => res.status(406).send("Not Acceptable"),
    });
  } catch (err) {
    console.error("Error in /pages/byUrl:", err);
    return res.status(500).json({ error: "Failed to fetch page details." });
  }
});

app.get("/pageranks", async (req, res) => {
  try {
    const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!url) {
      return res.status(400).type("text/plain").send("Missing query parameter url");
    }

    // dataset lookup (fast)
    const page = await pagesCol().findOne({ url }, { projection: { dataset: 1 } });
    if (!page) {
      return res.status(404).type("text/plain").send("URL not found");
    }

    const datasetName = page.dataset;
    const st = getDatasetState(datasetName);

    // If cache not ready, warm in background and return 0 quickly (graceful).
    if (!st.ready) {
      warmDataset(datasetName);
      return res.type("text/plain").send("0");
    }

    const score = st.prMap.get(url);
    if (score === undefined) return res.status(404).type("text/plain").send("URL not found");

    return res.type("text/plain").send(String(score));
  } catch (err) {
    console.error("Pagerank error:", err);
    return res.status(500).type("text/plain").send("Internal server error");
  }
});

// Search routes
app.get("/fruitsA", makeSearchHandler("fruitsA"));
app.get("/personal", makeSearchHandler("personal"));
app.get("/:datasetName", makeSearchHandler(null));

connectDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server listening on port ${PORT}`);
    });

    // // Warm datasets in background (do not block listening)
    // warmDataset("fruitsA");
    // warmDataset("personal");

    // readFile('./test.txt');
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });