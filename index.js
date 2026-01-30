require("dotenv").config();
const { connectDB, productsCol, ordersCol } = require("./db");
const { ObjectId } = require("mongodb");

const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.json());

// Serve the web client from /public
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
app.get("/", (req, res) => {
  // Handled by /public/index.html, but keep a fallback:
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

  if (name) {
    filter.name = { $regex: name, $options: "i" };
  }

  if (stock === "inStock") {
    filter.stock = { $gt: 0 };
  } else if (stock !== "all") {
    return res.status(400).json({ error: "Invalid stock value." });
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

  const newProduct = {
    ...req.body,
    reviews: []
  };
  const result = await productsCol().insertOne(newProduct);

  const insertedProduct = {
    _id: result.insertedId,
    ...newProduct
  };
  
  res.status(201).json(insertedProduct);
});


/**
 * 3) Retrieve a product by ID, JSON or HTML (via Accept header)
 * GET /products/:id
 */
app.get("/products/:id", async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const product = await productsCol().findOne({ _id });
    
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }

    res.format({
      "application/json": () => res.json(product),
      "text/html": () => res.type("html").send(productToHtml(product)),
      default: () => res.status(406).send("Not Acceptable"),
    });
  } catch (error) {
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
      return res.status(400).json({ error: "Rating must be 1–10." });
    }

    const result = await productsCol().findOneAndUpdate(
      { _id },
      { $push: { reviews: rating } },
      { returnDocument: "after" }
    );

    if (!result) {
      console.log("Result:", result);  // Logs the entire result object
      return res.status(404).json({ error: "Product not found." });
    }


    res.status(201).json({
      productId: _id.toString(),
      reviews: result.reviews
    });
  } catch (error) {
    return res.status(400).json({ error: "Invalid product ID format." });
  }
});


/**
 * 5) Get only reviews for a product, JSON or HTML (via Accept header)
 * GET /reviews/:id
 */
app.get("/reviews/:id", async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const product = await productsCol().findOne({ _id });
    
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }

    const reviews = Array.isArray(product.reviews) ? product.reviews : [];

    res.format({
      "application/json": () => res.json({ productId: _id.toString, reviews }),
      "text/html": () => res.type("html").send(reviewsToHtml(product)),
      default: () => res.status(406).send("Not Acceptable"),
    });
  } catch (error) {
    return res.status(400).json({ error: "Invalid product ID format." });
  }
});

// POST /orders: create a new order, validate, decrement stock, store order
app.post("/orders", async (req, res) => {
  const { customerName, items } = req.body;
  
  if (!customerName) return res.status(409).json({ error: "Customer name missing." });
  
  const validatedItems = [];
  for (const item of items) {
    const _id = new ObjectId(item.productId);
    const product = await productsCol().findOne({ _id });
    
    if (!product) return res.status(409).json({ error: "Product does not exist." });
    if (item.quantity <= 0) {
      return res.status(409).json({ error: "Invalid quantity amount. Must be from 1 to the item stock, if item is still in stock." }); 
    } else if (item.quantity > product.stock) {
      return res.status(409).json({ error: "Quantity for product(s) is greater than current stock." });
    }
  
    validatedItems.push({ _id, productStock: product.stock, itemQuantity: item.quantity });
  }

  for (const validatedItem of validatedItems) {
    await productsCol().updateOne(
      { _id: validatedItem._id },
      { $set: { stock: validatedItem.productStock - validatedItem.itemQuantity } }
    );
    await ordersCol().insertOne({ ...req.body });
  }

  return res.status(201).json({ message: "Order successfully placed." });
});

// GET /orders
app.get("/orders", async (req, res) => {
  const orders = await ordersCol().find().toArray();
  res.json(orders);
});

// GET /orders/:id
app.get("/orders/:id", async (req, res) => {
  const _id = new ObjectId(req.params.id);

  const order = await ordersCol().findOne({ _id });
  if (!order) return res.status(404).json({ error: "Order not found." });

  res.json(order);
});


// Start the server after connecting to the database
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });
