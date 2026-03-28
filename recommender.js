const fs = require("fs/promises");

const datasetCache = new Map();

function isRated(x) {
  return typeof x === "number" && x > 0;
}

function computeGlobalMean(ratings) {
  let sum = 0;
  let count = 0;

  for (const row of ratings) {
    for (const x of row) {
      if (isRated(x)) {
        sum += x;
        count++;
      }
    }
  }

  return count > 0 ? sum / count : 0;
}

function computeUserMeans(ratings, fallbackMean = 0) {
  return ratings.map((row) => {
    let sum = 0;
    let count = 0;

    for (const x of row) {
      if (isRated(x)) {
        sum += x;
        count++;
      }
    }

    return count > 0 ? sum / count : fallbackMean;
  });
}

function computeMinMaxRating(ratings) {
  let minRating = Infinity;
  let maxRating = -Infinity;

  for (const row of ratings) {
    for (const x of row) {
      if (isRated(x)) {
        if (x < minRating) minRating = x;
        if (x > maxRating) maxRating = x;
      }
    }
  }

  if (!Number.isFinite(minRating) || !Number.isFinite(maxRating)) {
    return { minRating: 1, maxRating: 5 };
  }

  return { minRating, maxRating };
}

function clampRating(ds, value) {
  return Math.max(ds.minRating, Math.min(ds.maxRating, value));
}

function meanWithoutFast(ds, userIdx, heldOutRatingValue) {
  const newCount = ds.userCount[userIdx] - 1;
  if (newCount <= 0) return ds.globalMean;
  return (ds.userSum[userIdx] - heldOutRatingValue) / newCount;
}

function pearsonSimilarity(ds, uIdx, vIdx, userMeans) {
  const ru = ds.ratings[uIdx];
  const rv = ds.ratings[vIdx];

  const mu = userMeans[uIdx];
  const mv = userMeans[vIdx];

  let num = 0;
  let du2 = 0;
  let dv2 = 0;
  let overlap = 0;

  for (let i = 0; i < ds.M; i++) {
    const a = ru[i];
    const b = rv[i];
    if (!isRated(a) || !isRated(b)) continue;

    const da = a - mu;
    const db = b - mv;

    num += da * db;
    du2 += da * da;
    dv2 += db * db;
    overlap++;
  }

  if (overlap === 0) return 0;

  const den = Math.sqrt(du2) * Math.sqrt(dv2);
  if (den === 0) return 0;

  return num / den;
}

function adjustedCosineSimilarity(ds, itemA, itemB, userMeans) {
  let num = 0;
  let da2 = 0;
  let db2 = 0;
  let overlap = 0;

  for (let u = 0; u < ds.N; u++) {
    const ra = ds.ratings[u][itemA];
    const rb = ds.ratings[u][itemB];
    if (!isRated(ra) || !isRated(rb)) continue;

    const meanU = userMeans[u];
    const da = ra - meanU;
    const db = rb - meanU;

    num += da * db;
    da2 += da * da;
    db2 += db * db;
    overlap++;
  }

  if (overlap === 0) return 0;

  const den = Math.sqrt(da2) * Math.sqrt(db2);
  if (den === 0) return 0;

  return num / den;
}

function selectNeighbors(candidates, { mode, k, threshold, negCorr }) {
  let filtered;

  if (mode === "topk") {
    filtered = negCorr
      ? candidates
      : candidates.filter((c) => c.sim > 0);

    filtered.sort((a, b) => {
      if (negCorr) return Math.abs(b.sim) - Math.abs(a.sim);
      return b.sim - a.sim;
    });

    return filtered.slice(0, k);
  }

  if (mode === "threshold") {
    filtered = candidates.filter((c) => {
      if (negCorr) return Math.abs(c.sim) >= threshold;
      return c.sim >= threshold;
    });

    filtered.sort((a, b) => {
      if (negCorr) return Math.abs(b.sim) - Math.abs(a.sim);
      return b.sim - a.sim;
    });

    return filtered;
  }

  return [];
}

async function loadDatasetFromFile(datasetName, filePath) {
  if (datasetCache.has(datasetName)) {
    return datasetCache.get(datasetName);
  }

  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 3) {
    throw new Error("Invalid dataset file: not enough lines");
  }

  const [nStr, mStr] = lines[0].split(/\s+/);
  const N = Number(nStr);
  const M = Number(mStr);

  if (!Number.isInteger(N) || !Number.isInteger(M) || N <= 0 || M <= 0) {
    throw new Error("Invalid first line: expected 'N M'");
  }

  const users = lines[1].split(/\s+/);
  const items = lines[2].split(/\s+/);

  if (users.length !== N) {
    throw new Error(`Expected ${N} users, got ${users.length}`);
  }
  if (items.length !== M) {
    throw new Error(`Expected ${M} items, got ${items.length}`);
  }

  const ratings = [];
  for (let r = 0; r < N; r++) {
    const rowLine = lines[3 + r];
    if (!rowLine) {
      throw new Error(`Missing ratings row ${r + 1}`);
    }

    const row = rowLine.split(/\s+/).map(Number);
    if (row.length !== M) {
      throw new Error(`Expected ${M} ratings in row ${r + 1}, got ${row.length}`);
    }

    ratings.push(row);
  }

  const userIndex = new Map(users.map((u, i) => [u, i]));
  const itemIndex = new Map(items.map((it, i) => [it, i]));
  const globalMean = computeGlobalMean(ratings);
  const userMeans = computeUserMeans(ratings, globalMean);
  const { minRating, maxRating } = computeMinMaxRating(ratings);

  const userRatedItems = Array.from({ length: N }, () => []);
  const itemRatedByUsers = Array.from({ length: M }, () => []);
  const userSum = new Array(N).fill(0);
  const userCount = new Array(N).fill(0);

  for (let u = 0; u < N; u++) {
    for (let i = 0; i < M; i++) {
      const r = ratings[u][i];
      if (!isRated(r)) continue;

      userRatedItems[u].push(i);
      itemRatedByUsers[i].push(u);
      userSum[u] += r;
      userCount[u]++;
    }
  }

  const ds = {
    name: datasetName,
    N,
    M,
    users,
    items,
    ratings,
    userIndex,
    itemIndex,
    globalMean,
    userMeans,
    minRating,
    maxRating,
    userRatedItems,
    itemRatedByUsers,
    userSum,
    userCount,
  };

  datasetCache.set(datasetName, ds);
  return ds;
}

async function computeMAE(
  ds,
  {
    type = "user",
    mode = "topk",
    k = 5,
    threshold = 0,
    negCorr = false,
  } = {}
) {
  if (type !== "user" && type !== "item") {
    throw new Error("type must be 'user' or 'item'");
  }

  if (mode !== "topk" && mode !== "threshold") {
    throw new Error("mode must be 'topk' or 'threshold'");
  }

  let totalAbsError = 0;
  let count = 0;
  let fallbackCount = 0;

  // Reuse one means array. For each LOO trial, only user u's mean changes.
  const looUserMeans = ds.userMeans.slice();

  for (let u = 0; u < ds.N; u++) {
    for (const i of ds.userRatedItems[u]) {
      const actual = ds.ratings[u][i];
      if (!isRated(actual)) continue;

      // Leave one out
      ds.ratings[u][i] = 0;

      const savedMeanU = looUserMeans[u];
      const baseMean = meanWithoutFast(ds, u, actual);
      looUserMeans[u] = baseMean;

      let pred = baseMean;
      let usedFallback = false;

      if (type === "user") {
        const candidates = [];

        // Only users who rated item i can be neighbors.
        for (const v of ds.itemRatedByUsers[i]) {
          if (v === u) continue;

          const rv = ds.ratings[v][i];
          if (!isRated(rv)) continue;

          const sim = pearsonSimilarity(ds, u, v, looUserMeans);
          candidates.push({
            neighborId: v,
            sim,
            rating: rv,
          });
        }

        const neighbors = selectNeighbors(candidates, {
          mode,
          k,
          threshold,
          negCorr,
        });

        if (neighbors.length === 0) {
          pred = baseMean;
          usedFallback = true;
        } else {
          let num = 0;
          let den = 0;

          for (const n of neighbors) {
            const meanV = looUserMeans[n.neighborId];
            num += n.sim * (n.rating - meanV);
            den += Math.abs(n.sim);
          }

          if (Math.abs(den) < 1e-12) {
            pred = baseMean;
            usedFallback = true;
          } else {
            pred = baseMean + num / den;
          }
        }
      } else {
        const candidates = [];

        // Only items already rated by user u can be neighbors.
        for (const j of ds.userRatedItems[u]) {
          if (j === i) continue;

          const ruj = ds.ratings[u][j];
          if (!isRated(ruj)) continue;

          const sim = adjustedCosineSimilarity(ds, i, j, looUserMeans);
          candidates.push({
            neighborId: j,
            sim,
            rating: ruj,
          });
        }

        const neighbors = selectNeighbors(candidates, {
          mode,
          k,
          threshold,
          negCorr,
        });

        if (neighbors.length === 0) {
          pred = baseMean;
          usedFallback = true;
        } else {
          let num = 0;
          let den = 0;

          for (const n of neighbors) {
            num += n.sim * n.rating;
            den += Math.abs(n.sim);
          }

          if (Math.abs(den) < 1e-12) {
            pred = baseMean;
            usedFallback = true;
          } else {
            pred = num / den;
          }
        }
      }

      pred = clampRating(ds, pred);

      totalAbsError += Math.abs(pred - actual);
      count++;

      if (usedFallback) {
        fallbackCount++;
      }

      // Restore
      looUserMeans[u] = savedMeanU;
      ds.ratings[u][i] = actual;
    }
  }

  return {
    mae: count > 0 ? totalAbsError / count : 0,
    count,
    fallbackCount,
    k,
    type,
    mode,
    threshold,
    negCorr,
    dataset: ds.name,
  };
}

module.exports = {
  loadDatasetFromFile,
  computeMAE,
};