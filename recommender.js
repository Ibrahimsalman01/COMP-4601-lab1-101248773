// recommender.js
const fs = require("fs/promises");
const path = require("path");

// dataset cache: name -> dataset object
const datasetCache = new Map();

function isRated(x) {
  return typeof x === "number" && x >= 0;
}

function pearsonSimilarity(uIdx, vIdx, ratings, userMeans) {
  const mu = userMeans[uIdx];
  const mv = userMeans[vIdx];
  const ru = ratings[uIdx];
  const rv = ratings[vIdx];

  let num = 0;
  let du2 = 0;
  let dv2 = 0;

  for (let i = 0; i < ru.length; i++) {
    const a = ru[i];
    const b = rv[i];
    if (!isRated(a) || !isRated(b)) continue;

    const da = a - mu;
    const db = b - mv;
    num += da * db;
    du2 += da * da;
    dv2 += db * db;
  }

  const den = Math.sqrt(du2) * Math.sqrt(dv2);
  if (den === 0) return 0;
  return num / den;
}

function computeUserMeans(ratings) {
  return ratings.map((row) => {
    let sum = 0;
    let cnt = 0;
    for (const x of row) {
      if (isRated(x)) {
        sum += x;
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  });
}

function globalMean(ratings) {
  let sum = 0;
  let cnt = 0;
  for (const row of ratings) {
    for (const x of row) {
      if (isRated(x)) {
        sum += x;
        cnt++;
      }
    }
  }
  return cnt ? sum / cnt : 0;
}

async function loadDatasetFromFile(datasetName, filePath) {
  if (datasetCache.has(datasetName)) return datasetCache.get(datasetName);

  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length);

  if (lines.length < 3) throw new Error("Invalid dataset file: not enough lines");

  const [Nstr, Mstr] = lines[0].split(/\s+/);
  const N = Number(Nstr);
  const M = Number(Mstr);
  if (!Number.isInteger(N) || !Number.isInteger(M) || N <= 0 || M <= 0) {
    throw new Error("Invalid N M line");
  }

  const users = lines[1].split(/\s+/);
  const items = lines[2].split(/\s+/);
  if (users.length !== N) throw new Error(`Expected ${N} users, got ${users.length}`);
  if (items.length !== M) throw new Error(`Expected ${M} items, got ${items.length}`);

  const ratings = [];
  for (let r = 0; r < N; r++) {
    const rowLine = lines[3 + r];
    if (!rowLine) throw new Error(`Missing ratings row for user index ${r}`);
    const row = rowLine.split(/\s+/).map((x) => Number(x));
    if (row.length !== M) throw new Error(`Expected ${M} ratings in row ${r}, got ${row.length}`);
    ratings.push(row);
  }

  const userIndex = new Map(users.map((u, i) => [u, i]));
  const itemIndex = new Map(items.map((it, i) => [it, i]));

  const userMeans = computeUserMeans(ratings);
  const gMean = globalMean(ratings);

  // "u|v" with u < v
  const simCache = new Map();
  const getSim = (u, v) => {
    const a = Math.min(u, v);
    const b = Math.max(u, v);
    const key = `${a}|${b}`;
    if (simCache.has(key)) return simCache.get(key);
    const s = pearsonSimilarity(a, b, ratings, userMeans);
    simCache.set(key, s);
    return s;
  };

  const ds = {
    name: datasetName,
    N,
    M,
    users,
    items,
    ratings,
    userIndex,
    itemIndex,
    userMeans,
    globalMean: gMean,
    getSim,
  };

  datasetCache.set(datasetName, ds);
  return ds;
}

function getTruthOrGuess(ds, userName, itemName, k = 2) {
  const u = ds.userIndex.get(userName);
  const i = ds.itemIndex.get(itemName);
  if (u === undefined) return { error: `Unknown user: ${userName}` };
  if (i === undefined) return { error: `Unknown item: ${itemName}` };

  const r = ds.ratings[u][i];
  if (isRated(r)) {
    return { score: r, source: "truth" };
  }

  // find neighbors who rated item i
  const candidates = [];
  for (let v = 0; v < ds.N; v++) {
    if (v === u) continue;
    const rv = ds.ratings[v][i];
    if (!isRated(rv)) continue;
    const s = ds.getSim(u, v);
    if (s !== 0) candidates.push({ v, s, rv });
  }

  // take top-k by similarity (descending)
  candidates.sort((a, b) => b.s - a.s);
  const neigh = candidates.slice(0, k);

  // if no usable neighbors: fallback to user's mean; if that is 0 (no ratings), use global mean
  const mu = ds.userMeans[u];
  if (neigh.length === 0) {
    const fallback = mu !== 0 ? mu : ds.globalMean;
    return { score: fallback, source: "guess" };
  }

  let num = 0;
  let den = 0;
  for (const { v, s, rv } of neigh) {
    num += s * (rv - ds.userMeans[v]);
    den += Math.abs(s);
  }

  if (den === 0) {
    const fallback = mu !== 0 ? mu : ds.globalMean;
    return { score: fallback, source: "guess" };
  }

  const pred = mu + num / den;
  return { score: pred, source: "guess" };
}

module.exports = {
  loadDatasetFromFile,
  getTruthOrGuess,
};