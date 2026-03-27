const fs = require("fs/promises");

const datasetCache = new Map();

function isRated(x) {
  return typeof x === "number" && x > 0;
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

// -------- user-based Pearson  --------
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

// -------- item-based adjusted cosine --------
function adjustedCosineSimilarity(itemA, itemB, ratings, userMeans) {
  let num = 0;
  let da2 = 0;
  let db2 = 0;

  for (let u = 0; u < ratings.length; u++) {
    const ra = ratings[u][itemA];
    const rb = ratings[u][itemB];
    if (!isRated(ra) || !isRated(rb)) continue;

    const adjA = ra - userMeans[u];
    const adjB = rb - userMeans[u];

    num += adjA * adjB;
    da2 += adjA * adjA;
    db2 += adjB * adjB;
  }

  const den = Math.sqrt(da2) * Math.sqrt(db2);
  if (den === 0) return 0;
  return num / den;
}

async function loadDatasetFromFile(datasetName, filePath) {
  if (datasetCache.has(datasetName)) return datasetCache.get(datasetName);

  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 3) {
    throw new Error("Invalid dataset file: not enough lines");
  }

  const [Nstr, Mstr] = lines[0].split(/\s+/);
  const N = Number(Nstr);
  const M = Number(Mstr);

  if (!Number.isInteger(N) || !Number.isInteger(M) || N <= 0 || M <= 0) {
    throw new Error("Invalid first line: expected 'N M'");
  }

  const users = lines[1].split(/\s+/);
  const items = lines[2].split(/\s+/);

  if (users.length !== N) throw new Error(`Expected ${N} users, got ${users.length}`);
  if (items.length !== M) throw new Error(`Expected ${M} items, got ${items.length}`);

  const ratings = [];
  for (let r = 0; r < N; r++) {
    const rowLine = lines[3 + r];
    if (!rowLine) throw new Error(`Missing ratings row ${r + 1}`);

    const row = rowLine.split(/\s+/).map(Number);
    if (row.length !== M) {
      throw new Error(`Expected ${M} ratings in row ${r + 1}, got ${row.length}`);
    }
    ratings.push(row);
  }

  const userIndex = new Map(users.map((u, i) => [u, i]));
  const itemIndex = new Map(items.map((it, i) => [it, i]));
  const userMeans = computeUserMeans(ratings);
  const gMean = globalMean(ratings);

  const userSimCache = new Map();
  const itemSimCache = new Map();

  function getUserSim(u, v) {
    const a = Math.min(u, v);
    const b = Math.max(u, v);
    const key = `${a}|${b}`;

    if (userSimCache.has(key)) return userSimCache.get(key);

    const sim = pearsonSimilarity(a, b, ratings, userMeans);
    userSimCache.set(key, sim);
    return sim;
  }

  function getItemSim(i, j) {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = `${a}|${b}`;

    if (itemSimCache.has(key)) return itemSimCache.get(key);

    const sim = adjustedCosineSimilarity(a, b, ratings, userMeans);
    itemSimCache.set(key, sim);
    return sim;
  }

  function invalidateUserSims(u) {
    for (let v = 0; v < N; v++) {
      if (v === u) continue;
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      userSimCache.delete(`${a}|${b}`);
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
    userMeans,
    globalMean: gMean,
    getUserSim,
    getItemSim,
    invalidateUserSims,
  };

  datasetCache.set(datasetName, ds);
  return ds;
}

// ---------- user-based helper ----------
function getUserBasedTruthOrGuess(ds, userName, itemName, k = 2) {
  const u = ds.userIndex.get(userName);
  const i = ds.itemIndex.get(itemName);

  if (u === undefined) return { error: `Unknown user: ${userName}` };
  if (i === undefined) return { error: `Unknown item: ${itemName}` };

  const current = ds.ratings[u][i];
  if (isRated(current)) {
    return { score: current, source: "truth" };
  }

  const candidates = [];
  for (let v = 0; v < ds.N; v++) {
    if (v === u) continue;

    const neighborRating = ds.ratings[v][i];
    if (!isRated(neighborRating)) continue;

    const sim = ds.getUserSim(u, v);

    // keep all similarities, including negative ones
    candidates.push({ v, sim, rating: neighborRating });
  }

  // choose the top-k most similar users by similarity descending
  candidates.sort((a, b) => b.sim - a.sim);
  const neighbors = candidates.slice(0, k);

  const mu = ds.userMeans[u];

  if (neighbors.length === 0) {
    return { score: mu || ds.globalMean, source: "guess" };
  }

  let num = 0;
  let den = 0;

  for (const n of neighbors) {
    num += n.sim * (n.rating - ds.userMeans[n.v]);
    den += n.sim;
  }

  if (den === 0) {
    return { score: mu || ds.globalMean, source: "guess" };
  }

  return {
    score: mu + num / den,
    source: "guess",
  };
}

function getItemBasedTruthOrGuess(ds, userName, itemName, k = 2) {
  const u = ds.userIndex.get(userName);
  const i = ds.itemIndex.get(itemName);

  if (u === undefined) return { error: `Unknown user: ${userName}` };
  if (i === undefined) return { error: `Unknown item: ${itemName}` };

  const current = ds.ratings[u][i];
  if (isRated(current)) {
    return { score: current, source: "truth" };
  }

  // candidate neighbors = items already rated by this user
  const candidates = [];
  for (let j = 0; j < ds.M; j++) {
    if (j === i) continue;

    const userRatingOnJ = ds.ratings[u][j];
    if (!isRated(userRatingOnJ)) continue;

    const sim = ds.getItemSim(i, j);

    // only consider similarity > 0
    if (sim > 0) {
      candidates.push({ j, sim, rating: userRatingOnJ });
    }
  }

  candidates.sort((a, b) => b.sim - a.sim);
  const neighbors = candidates.slice(0, k);

  if (neighbors.length === 0) {
    return { score: ds.userMeans[u] || ds.globalMean, source: "guess" };
  }

  let num = 0;
  let den = 0;
  for (const n of neighbors) {
    num += n.sim * n.rating;
    den += Math.abs(n.sim);
  }

  if (den === 0) {
    return { score: ds.userMeans[u] || ds.globalMean, source: "guess" };
  }

  return {
    score: num / den,
    source: "guess",
  };
}

// -------- Leave-One-Out MAE evaluation --------
async function computeMAE(ds, k = 5, type = "user") {
  // Step 1: Build per-user rated-item index (avoids scanning 4423 cols per iteration).
  const userRatedItems = ds.ratings.map((row) => {
    const indices = [];
    for (let j = 0; j < row.length; j++) {
      if (isRated(row[j])) indices.push(j);
    }
    return indices;
  });

  // Step 3: LOO loop
  let totalError = 0;
  let count = 0;

  for (let u = 0; u < ds.N; u++) {
    const ratedItems = userRatedItems[u];

    for (const i of ratedItems) {
      const actual = ds.ratings[u][i];

      // Invalidate cached similarities involving user u before hiding the rating
      ds.invalidateUserSims(u);

      // Temporarily hide this rating
      ds.ratings[u][i] = 0;

      // Compute user mean without item i
      let sum = 0;
      let cnt = 0;
      for (const j of ratedItems) {
        if (j !== i) {
          sum += ds.ratings[u][j];
          cnt++;
        }
      }
      const meanWithout = cnt > 0 ? sum / cnt : ds.globalMean;

      // Temporarily override user u's mean so Pearson recomputes with the LOO mean
      const savedMean = ds.userMeans[u];
      ds.userMeans[u] = meanWithout;

      // Find candidate neighbours: users who rated item i
      const candidates = [];
      for (let v = 0; v < ds.N; v++) {
        if (v === u) continue;
        const vRating = ds.ratings[v][i];
        if (!isRated(vRating)) continue;
        const sim = ds.getUserSim(u, v);
        candidates.push({ v, sim, rating: vRating });
      }

      // Sort by similarity descending, take top-k
      candidates.sort((a, b) => b.sim - a.sim);
      const neighbours = candidates.slice(0, k);

      // Predict
      let predicted;
      if (neighbours.length === 0) {
        predicted = meanWithout;
      } else {
        let num = 0;
        let den = 0;
        for (const n of neighbours) {
          num += n.sim * (n.rating - ds.userMeans[n.v]);
          den += n.sim;
        }
        predicted = den === 0 ? meanWithout : meanWithout + num / den;
      }

      // Clamp to valid rating range
      predicted = Math.max(1, Math.min(5, predicted));

      totalError += Math.abs(predicted - actual);
      count++;

      // Restore mean and rating
      ds.userMeans[u] = savedMean;
      ds.ratings[u][i] = actual;
    }
  }

  return {
    mae: count > 0 ? totalError / count : 0,
    count,
    k,
    type,
  };
}

module.exports = {
  loadDatasetFromFile,
  getUserBasedTruthOrGuess,
  getItemBasedTruthOrGuess,
  computeMAE,
};