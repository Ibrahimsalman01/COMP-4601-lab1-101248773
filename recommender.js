const fs = require("fs/promises");

const datasetCache = new Map();

async function readFile(file) {
    const map = {};

    const data = [];
    const openedFile = await fs.open(file);
    for await (const line of openedFile.readLines()) {
        if (line.length === 0) break;
        console.log(line);
        data.push(line);
    }

    // parse data into map
    /**
    3 4
    User1 User2 User3
    Item1 Item2 Item3 Item4
    0 1 0 1
    0 1 1 1
    1 0 1 0
   * 
   * {
   *  user1: [0, 1, 0, 1],
   *  user2: [0, 1, 1, 1],
   *  user3: [1, 0, 1, 0]
   * }
   * 
   */
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

  // const userIndex = new Map(users.map((u, i) => [u, i]));
  // const itemIndex = new Map(items.map((it, i) => [it, i]));
  // const globalMean = computeGlobalMean(ratings);
  // const userMeans = computeUserMeans(ratings, globalMean);
  // const { minRating, maxRating } = computeMinMaxRating(ratings);

  // const userRatedItems = Array.from({ length: N }, () => []);
  // const itemRatedByUsers = Array.from({ length: M }, () => []);
  // const userSum = new Array(N).fill(0);
  // const userCount = new Array(N).fill(0);

  // for (let u = 0; u < N; u++) {
  //   for (let i = 0; i < M; i++) {
  //     const r = ratings[u][i];
  //     if (!isRated(r)) continue;

  //     userRatedItems[u].push(i);
  //     itemRatedByUsers[i].push(u);
  //     userSum[u] += r;
  //     userCount[u]++;
  //   }
  // }

  const ds = {
    name: datasetName,
    N,
    M,
    users,
    items,
    ratings,
    // userIndex,
    // itemIndex,
    // globalMean,
    // userMeans,
    // minRating,
    // maxRating,
    // userRatedItems,
    // itemRatedByUsers,
    // userSum,
    // userCount,
  };

  datasetCache.set(datasetName, ds);
  return ds;
}

module.exports = { readFile, loadDatasetFromFile };
