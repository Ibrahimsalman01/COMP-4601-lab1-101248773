require("dotenv").config();
const { connectDB, productsCol, ordersCol } = require("./db");
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

// --- Routes ---

// INFO test
app.get("/info", (req, res) => {
  res.json({ name: process.env.SERVER_NAME || "BernardBilberry2067" });
});

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
