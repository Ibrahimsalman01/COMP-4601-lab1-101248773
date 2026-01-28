const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.json());

// Serve the web client from /public
app.use(express.static(path.join(__dirname, "public")));

// In-memory "database" (will change in Lab 2)
const products = [
  {"name":"Tasty Cotton Chair","price":444,"dimensions":{"x":2,"y":4,"z":5},"stock":21,"id":0},
  {"name":"Small Concrete Towels","price":806,"dimensions":{"x":4,"y":7,"z":8},"stock":47,"id":1},
  {"name":"Small Metal Tuna","price":897,"dimensions":{"x":7,"y":4,"z":5},"stock":13,"id":2},
  {"name":"Generic Fresh Chair","price":403,"dimensions":{"x":3,"y":8,"z":11},"stock":47,"id":3},
  {"name":"Generic Steel Keyboard","price":956,"dimensions":{"x":3,"y":8,"z":6},"stock":8,"id":4},
  {"name":"Refined Metal Bike","price":435,"dimensions":{"x":7,"y":5,"z":5},"stock":36,"id":5},
  {"name":"Practical Steel Pizza","price":98,"dimensions":{"x":4,"y":7,"z":4},"stock":12,"id":6},
  {"name":"Awesome Wooden Bike","price":36,"dimensions":{"x":11,"y":10,"z":10},"stock":3,"id":7},
  {"name":"Licensed Cotton Keyboard","price":990,"dimensions":{"x":8,"y":7,"z":3},"stock":27,"id":8},
  {"name":"Incredible Fresh Hat","price":561,"dimensions":{"x":6,"y":7,"z":5},"stock":28,"id":9},
  {"name":"Tasty Cotton Soap","price":573,"dimensions":{"x":2,"y":6,"z":11},"stock":31,"id":10},
  {"name":"Intelligent Metal Mouse","price":3,"dimensions":{"x":4,"y":5,"z":10},"stock":0,"id":11},
  {"name":"Practical Plastic Ball","price":11,"dimensions":{"x":11,"y":9,"z":11},"stock":25,"id":12},
  {"name":"Rustic Fresh Tuna","price":159,"dimensions":{"x":8,"y":6,"z":8},"stock":30,"id":13},
  {"name":"Small Metal Tuna","price":225,"dimensions":{"x":8,"y":10,"z":8},"stock":49,"id":14}
];

// In-memory "orders" store (TODO: move this to MongoDB)
const orders = [];
let nextOrderId = 1;

// --- Helpers ---
function getNextId() {
  if (products.length === 0) return 0;
  return Math.max(...products.map(p => p.id)) + 1;
}

// Can be removed later? (atomic DB updates)
function findProductById(id) {
  return products.find(p => p.id === id);
}

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

function validateOrderBody(body) {
  const problems = [];

  if (typeof body !== "object" || body === null) {
    return { ok: false, problems: ["Body must be a JSON object."] };
  }

  const { customerName, items } = body;

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
      const { productId, quantity } = it;
      if (!Number.isInteger(productId)) problems.push(`Item #${i + 1}: 'productId' must be an integer.`);
      if (!Number.isInteger(quantity) || quantity <= 0) problems.push(`Item #${i + 1}: 'quantity' must be an integer > 0.`);
    }
  }

  return { ok: problems.length === 0, problems };
}

function checkOrderStockAndExistence(items) {
  const problems = [];
  const normalizedItems = [];

  // Combine duplicates (same productId) to prevent double-decrement issues
  const qtyByProductId = new Map();
  for (const it of items) {
    qtyByProductId.set(it.productId, (qtyByProductId.get(it.productId) || 0) + it.quantity);
  }

  for (const [productId, quantity] of qtyByProductId.entries()) {
    const product = findProductById(productId);
    if (!product) {
      problems.push(`Product does not exist: productId=${productId}`);
      continue;
    }
    if (product.stock < quantity) {
      problems.push(
        `Insufficient stock for productId=${productId} (${product.name}): requested=${quantity}, available=${product.stock}`
      );
      continue;
    }
    normalizedItems.push({ product, productId, quantity });
  }
  return { ok: problems.length === 0, problems, normalizedItems };
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
  <title>Product ${product.id}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    .card { border: 1px solid #ddd; padding: 16px; border-radius: 8px; max-width: 640px; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(product.name)} <small>(ID: ${product.id})</small></h1>
    <p><b>Price:</b> $${product.price}</p>
    <p><b>Stock:</b> ${product.stock}</p>
    <p><b>Dimensions:</b> x=${product.dimensions.x}, y=${product.dimensions.y}, z=${product.dimensions.z}</p>
    <p><b>Reviews:</b> ${reviews.length} (avg: ${avg})</p>

    <h2>Links</h2>
    <ul>
      <li><a href="/products/${product.id}">This product (HTML)</a></li>
      <li><a href="/reviews/${product.id}">This product's reviews (HTML)</a></li>
      <li><a href="/index.html">Back to client</a></li>
    </ul>

    <h2>JSON representation</h2>
    <p>Request this same URL with <code>Accept: application/json</code> (e.g., via fetch/Postman).</p>
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
  <title>Reviews for Product ${product.id}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    .card { border: 1px solid #ddd; padding: 16px; border-radius: 8px; max-width: 640px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Reviews for: ${escapeHtml(product.name)} (ID: ${product.id})</h1>
    <ul>${items}</ul>
    <p><a href="/products/${product.id}">Back to product</a></p>
    <p><a href="/index.html">Back to client</a></p>
    <p>To retrieve JSON, request this same URL with <code>Accept: application/json</code>.</p>
  </div>
</body>
</html>`;
}

// --- Routes ---
app.get("/", (req, res) => {
  // Handled by /public/index.html, but keep a fallback:
  res.send("Server running. Open /index.html for the client.");
});

/**
 * 1) Search products by name and/or inStock/all
 * GET /products?name=chair&stock=inStock
 */
app.get("/products", (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  const stock = typeof req.query.stock === "string" ? req.query.stock : "all";

  let results = [...products];

  if (name.length > 0) {
    const q = name.toLowerCase();
    results = results.filter(p => p.name.toLowerCase().includes(q));
  }

  if (stock === "inStock") {
    results = results.filter(p => p.stock > 0);
  } else if (stock !== "all") {
    return res.status(400).json({ error: "Invalid 'stock' value. Use 'all' or 'inStock'." });
  }

  res.json(results);
});

/**
 * 2) Create a new product
 * POST /products
 */
app.post("/products", (req, res) => {
  const err = validateNewProduct(req.body);
  if (err) return res.status(400).json({ error: err });

  const id = getNextId();
  const newProduct = { ...req.body, id, reviews: [] };
  products.push(newProduct);

  res.status(201).json(newProduct);
});

/**
 * 3) Retrieve a product by ID, JSON or HTML (via Accept header)
 * GET /products/:id
 */
app.get("/products/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Product id must be an integer." });

  const product = findProductById(id);
  if (!product) return res.status(404).json({ error: "Product not found." });

  res.format({
    "application/json": () => res.json(product),
    "text/html": () => res.type("html").send(productToHtml(product)),
    default: () => res.status(406).send("Not Acceptable. Use Accept: application/json or text/html."),
  });
});

/**
 * 4) Add a review (rating 1-10) for a product
 * POST /reviews/:id
 * body: { "rating": 7 }
 */
app.post("/reviews/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Product id must be an integer." });

  const product = findProductById(id);
  if (!product) return res.status(404).json({ error: "Product not found." });

  const rating = req.body?.rating;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 10) {
    return res.status(400).json({ error: "Field 'rating' must be an integer from 1 to 10." });
  }

  if (!Array.isArray(product.reviews)) product.reviews = [];
  product.reviews.push(rating);

  res.status(201).json({ productId: product.id, reviews: product.reviews });
});

/**
 * 5) Get only reviews for a product, JSON or HTML (via Accept header)
 * GET /reviews/:id
 */
app.get("/reviews/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Product id must be an integer." });

  const product = findProductById(id);
  if (!product) return res.status(404).json({ error: "Product not found." });

  const reviews = Array.isArray(product.reviews) ? product.reviews : [];

  res.format({
    "application/json": () => res.json({ productId: product.id, reviews }),
    "text/html": () => res.type("html").send(reviewsToHtml(product)),
    default: () => res.status(406).send("Not Acceptable. Use Accept: application/json or text/html."),
  });
});



/**
 * - POST /orders: create a new order, validate, decrement stock, store order
 * - GET /orders: list orders with links
 * - GET /orders/:id: fetch a specific order
 */

// Create order
app.post("/orders", (req, res) => {
  const basic = validateOrderBody(req.body);
  if (!basic.ok) {
    return res.status(409).json({
      error: "Invalid order",
      problems: basic.problems,
    });
  }

  const { customerName, items } = req.body;

  const check = checkOrderStockAndExistence(items);
  if (!check.ok) {
    return res.status(409).json({
      error: "Invalid order",
      problems: check.problems,
    });
  }

  // Decrement stock (in-memory "transaction").
  // This method can be removed once we switch to MongoDB? (atomic DB updates)
  for (const it of check.normalizedItems) {
    it.product.stock -= it.quantity;
  }

  // Create order "receipt" snapshot
  const orderId = nextOrderId++;
  const order = {
    id: orderId,
    customerName: customerName.trim(),
    createdAt: new Date().toISOString(),
    items: check.normalizedItems.map(({ product, productId, quantity }) => ({
      productId,
      quantity,
      unitPrice: product.price,
      name: product.name,
    })),
    links: { self: `/orders/${orderId}` },
  };

  // TODO: Swap to MongoDB / OrderModel.create(order)
  orders.push(order);

  res.status(201)
    .set("Location", order.links.self)
    .json(order);
});

// List orders (include links to each order)
app.get("/orders", (req, res) => {
  const list = orders.map(o => ({
    id: o.id,
    customerName: o.customerName,
    createdAt: o.createdAt,
    links: o.links,
  }));

  res.json(list);
});

// Get a specific order
app.get("/orders/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Order id must be an integer." });

  const order = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  res.json(order);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
