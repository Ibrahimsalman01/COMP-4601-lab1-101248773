async function readJson(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function show(elId, obj) {
  document.getElementById(elId).textContent =
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

//page Search
document.getElementById("btnPageSearch").addEventListener("click", async () => {
  const dataset = document.getElementById("dataset").value;
  const q = document.getElementById("pageSearch").value.trim();
  const limit = document.getElementById("resultLimit").value.trim();
  const boost = document.getElementById("boostSearch").value;

  const qs = new URLSearchParams({ boost });
  if (q) qs.set("q", q);
  if (limit) qs.set("limit", limit);

  const res = await fetch(`/${dataset}?${qs.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const out = await readJson(res);

  const container = document.getElementById("pageSearchOutput");

  if (!out.ok || !out.data?.result) {
    container.textContent = JSON.stringify(out, null, 2);
    return;
  }

  const results = out.data.result;
  if (results.length === 0) {
    container.textContent = "No results found.";
    return;
  }

  container.innerHTML = results.map((r) => {
    const detailUrl = `/${dataset}/pages/byUrl/${encodeURIComponent(r.url)}`;
    return `<div class="result-card">
  <div class="result-title">${escapeHtml(r.title)}</div>
  <div class="result-url"><a href="${r.url}" target="_blank">${escapeHtml(r.url)}</a></div>
  <div class="result-meta">
    <span>Score: <b>${r.score.toFixed(6)}</b></span>
    <span>PageRank: <b>${r.pr.toFixed(6)}</b></span>
    <a class="detail-link" href="${detailUrl}" target="_blank">View Page Details</a>
  </div>
</div>`;
  }).join("");
});

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