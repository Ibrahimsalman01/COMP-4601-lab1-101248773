async function readJson(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

function show(elId, obj) {
  document.getElementById(elId).textContent =
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

// Search
document.getElementById("btnSearch").addEventListener("click", async () => {
  const name = document.getElementById("searchName").value.trim();
  const stock = document.getElementById("searchStock").value;

  const qs = new URLSearchParams();
  if (name) qs.set("name", name);
  if (stock) qs.set("stock", stock);

  const res = await fetch(`/products?${qs.toString()}`, {
    headers: { Accept: "application/json" }
  });

  const out = await readJson(res);
  show("searchOutput", out);
});

// Get product
document.getElementById("btnGetProductJson").addEventListener("click", async () => {
  const id = document.getElementById("productId").value.trim();
  const res = await fetch(`/products/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" }
  });
  const out = await readJson(res);
  show("productOutput", out);
});

document.getElementById("btnOpenProductHtml").addEventListener("click", () => {
  const id = document.getElementById("productId").value.trim();
  window.open(`/products/${encodeURIComponent(id)}`, "_blank");
});

// Create product
document.getElementById("btnCreate").addEventListener("click", async () => {
  const body = {
    name: document.getElementById("newName").value.trim(),
    price: Number(document.getElementById("newPrice").value),
    dimensions: {
      x: Number(document.getElementById("newX").value),
      y: Number(document.getElementById("newY").value),
      z: Number(document.getElementById("newZ").value),
    },
    stock: Number(document.getElementById("newStock").value),
  };

  const res = await fetch("/products", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  const out = await readJson(res);
  show("createOutput", out);
});

// Reviews
document.getElementById("btnAddReview").addEventListener("click", async () => {
  const id = document.getElementById("reviewProductId").value.trim();
  const rating = Number(document.getElementById("reviewRating").value);

  const res = await fetch(`/reviews/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ rating }),
  });

  const out = await readJson(res);
  show("reviewsOutput", out);
});

document.getElementById("btnGetReviewsJson").addEventListener("click", async () => {
  const id = document.getElementById("reviewProductId").value.trim();
  const res = await fetch(`/reviews/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  const out = await readJson(res);
  show("reviewsOutput", out);
});

document.getElementById("btnOpenReviewsHtml").addEventListener("click", () => {
  const id = document.getElementById("reviewProductId").value.trim();
  window.open(`/reviews/${encodeURIComponent(id)}`, "_blank");
});
