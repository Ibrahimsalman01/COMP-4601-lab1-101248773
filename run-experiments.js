const BASE_URL = "http://localhost:3000";
const DATASET = "assignment2";

const topKValues = [1, 2, 5, 10, 20, 50, 100];
const thresholdValues = [0, 0.1, 0.2, 0.3, 0.5, 0.7];

function buildExperiments() {
  const experiments = [];

  for (const type of ["user", "item"]) {
    for (const negCorr of [false, true]) {
      for (const k of topKValues) {
        experiments.push({
          dataset: DATASET,
          type,
          mode: "topk",
          k,
          threshold: 0,
          negCorr,
        });
      }

      for (const threshold of thresholdValues) {
        experiments.push({
          dataset: DATASET,
          type,
          mode: "threshold",
          k: 5,
          threshold,
          negCorr,
        });
      }
    }
  }

  return experiments;
}

function toUrl(exp) {
  const params = new URLSearchParams({
    type: exp.type,
    mode: exp.mode,
    k: String(exp.k),
    threshold: String(exp.threshold),
    negCorr: String(exp.negCorr),
  });

  return `${BASE_URL}/mae/${exp.dataset}?${params.toString()}`;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function toCsvRow(obj, headers) {
  return headers.map((h) => csvEscape(obj[h])).join(",");
}

async function run() {
  const experiments = buildExperiments();

  const headers = [
    "dataset",
    "type",
    "mode",
    "k",
    "threshold",
    "negCorr",
    "mae",
    "count",
    "fallbackCount",
    "durationMs",
    "status",
    "url",
  ];

  console.log(headers.join(","));

  for (let idx = 0; idx < experiments.length; idx++) {
    const exp = experiments[idx];
    const url = toUrl(exp);

    try {
      const res = await fetch(url);
      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }

      if (!res.ok) {
        const row = {
          dataset: exp.dataset,
          type: exp.type,
          mode: exp.mode,
          k: exp.k,
          threshold: exp.threshold,
          negCorr: exp.negCorr,
          mae: "",
          count: "",
          fallbackCount: "",
          durationMs: "",
          status: `HTTP_${res.status}`,
          url,
        };
        console.log(toCsvRow(row, headers));
        continue;
      }

      const row = {
        dataset: data.dataset ?? exp.dataset,
        type: data.type ?? exp.type,
        mode: data.mode ?? exp.mode,
        k: data.k ?? exp.k,
        threshold: data.threshold ?? exp.threshold,
        negCorr: data.negCorr ?? exp.negCorr,
        mae: data.mae,
        count: data.count,
        fallbackCount: data.fallbackCount,
        durationMs: data.durationMs,
        status: "OK",
        url,
      };

      console.log(toCsvRow(row, headers));
    } catch (err) {
      const row = {
        dataset: exp.dataset,
        type: exp.type,
        mode: exp.mode,
        k: exp.k,
        threshold: exp.threshold,
        negCorr: exp.negCorr,
        mae: "",
        count: "",
        fallbackCount: "",
        durationMs: "",
        status: `ERROR_${err.message}`,
        url,
      };
      console.log(toCsvRow(row, headers));
    }
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});