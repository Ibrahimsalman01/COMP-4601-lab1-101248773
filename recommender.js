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

function computeUserMeans(ratings) {
  return ratings.map((row) => {
    let sum = 0;
    let count = 0;
    for (const x of row) {
      if (isRated(x)) {
        sum += x;
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
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
    return { minRating: 0.5, maxRating: 5.0 };
  }

  return { minRating, maxRating };
}

function clampRating(ds, value) {
  return Math.max(ds.minRating, Math.min(ds.maxRating, value));
}

function meanWithout(ds, userIdx, heldOutItemIdx) {
  let sum = 0;
  let count = 0;

  for (const j of ds.userRatedItems[userIdx]) {
    if (j === heldOutItemIdx) continue;
    const r = ds.ratings[userIdx][j];
    if (isRated(r)) {
      sum += r;
      count++;
    }
  }

  return count > 0 ? sum / count : ds.globalMean;
}

function userMeanWithout(ds, userIdx, heldOutItemIdx) {
  return meanWithout(ds, userIdx, heldOutItemIdx);
}

function pearsonSimilarity(ds, uIdx, vIdx, heldOutUserIdx = -1, heldOutItemIdx = -1) {
  const ru = ds.ratings[uIdx];
  const rv = ds.ratings[vIdx];

  const mu = (uIdx === heldOutUserIdx)
    ? userMeanWithout(ds, uIdx, heldOutItemIdx)
    : ds.userMeans[uIdx];

  const mv = (vIdx === heldOutUserIdx)
    ? userMeanWithout(ds, vIdx, heldOutItemIdx)
    : ds.userMeans[vIdx];

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

function adjustedCosineSimilarity(ds, itemA, itemB, heldOutUserIdx = -1, heldOutItemIdx = -1) {
  let num = 0;
  let da2 = 0;
  let db2 = 0;
  let overlap = 0;

  for (let u = 0; u < ds.N; u++) {
    const ra = ds.ratings[u][itemA];
    const rb = ds.ratings[u][itemB];
    if (!isRated(ra) || !isRated(rb)) continue;

    const meanU = (u === heldOutUserIdx)
      ? userMeanWithout(ds, u, heldOutItemIdx)
      : ds.userMeans[u];

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
  for (let u = 0; u < N; u++) {
    const rowLine = lines[3 + u];
    if (!rowLine) {
      throw new Error(`Missing ratings row ${u + 1}`);
    }

    const row = rowLine.split(/\s+/).map(Number);
    if (row.length !== M) {
      throw new Error(`Expected ${M} ratings in row ${u + 1}, got ${row.length}`);
    }

    ratings.push(row);
  }

  const userIndex = new Map(users.map((u, idx) => [u, idx]));
  const itemIndex = new Map(items.map((i, idx) => [i, idx]));

  const userRatedItems = Array.from({ length: N }, () => []);
  const itemRatedByUsers = Array.from({ length: M }, () => []);

  for (let u = 0; u < N; u++) {
    for (let i = 0; i < M; i++) {
      if (isRated(ratings[u][i])) {
        userRatedItems[u].push(i);
        itemRatedByUsers[i].push(u);
      }
    }
  }

  const userMeans = computeUserMeans(ratings);
  const globalMean = computeGlobalMean(ratings);
  const { minRating, maxRating } = computeMinMaxRating(ratings);

  const ds = {
    name: datasetName,
    N,
    M,
    users,
    items,
    ratings,
    userIndex,
    itemIndex,
    userRatedItems,
    itemRatedByUsers,
    userMeans,
    globalMean,
    minRating,
    maxRating,
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

  for (let u = 0; u < ds.N; u++) {
    for (const i of ds.userRatedItems[u]) {
      const actual = ds.ratings[u][i];
      if (!isRated(actual)) continue;

      // Leave one out
      ds.ratings[u][i] = 0;

      const baseMean = meanWithout(ds, u, i);
      let pred = baseMean;
      let usedFallback = false;

      if (type === "user") {
        const candidates = [];

        for (let v = 0; v < ds.N; v++) {
          if (v === u) continue;

          const rv = ds.ratings[v][i];
          if (!isRated(rv)) continue;

          const sim = pearsonSimilarity(ds, u, v, u, i);
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
            const meanV = (n.neighborId === u)
              ? userMeanWithout(ds, n.neighborId, i)
              : ds.userMeans[n.neighborId];

            num += n.sim * (n.rating - meanV);
            den += n.sim;
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

        for (const j of ds.userRatedItems[u]) {
          if (j === i) continue;

          const ruj = ds.ratings[u][j];
          if (!isRated(ruj)) continue;

          const sim = adjustedCosineSimilarity(ds, i, j, u, i);
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

      // Restore held-out rating
      ds.ratings[u][i] = actual;
    }
  }

  return {
    mae: count > 0 ? totalAbsError / count : 0,
    count,
    fallbackCount,
  };
}

module.exports = {
  loadDatasetFromFile,
  computeMAE,
};