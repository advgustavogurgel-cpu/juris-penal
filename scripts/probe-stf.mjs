import { chromium } from "playwright";

const BASE_URL = "https://jurisprudencia.stf.jus.br";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "pt-BR",
});
const page = await context.newPage();

try {
  await page.goto(`${BASE_URL}/pages/search`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const cookies = await context.cookies();
    if (cookies.some((cookie) => cookie.name === "aws-waf-token")) {
      ready = true;
      break;
    }
    await page.waitForTimeout(1_000);
  }
  if (!ready) throw new Error("O STF não liberou a sessão após o desafio de JavaScript.");

  async function query(base, from, until) {
    const body = {
      query: {
        bool: {
          filter: [{
            range: {
              publicacao_data: { format: "ddMMyyyy", gte: from, lte: until },
            },
          }],
          must: [],
          should: [],
          must_not: [],
        },
      },
      post_filter: { bool: { must: [{ term: { base } }], should: [] } },
      _source: ["base", "ramo_direito", "publicacao_data"],
      aggs: {
        ramo_direito_agg: {
          aggs: {
            ramo_direito_agg: {
              terms: { field: "ramo_direito.keyword", size: 200, execution_hint: "map" },
            },
          },
          filter: { bool: { must: [{ term: { base } }] } },
        },
      },
      size: 1,
      from: 0,
      sort: [{ publicacao_data: "asc" }],
      track_total_hits: true,
    };
    return page.evaluate(async ({ body }) => {
      const response = await fetch("/api/search/search", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      return JSON.parse(text);
    }, { body });
  }

  const results = {};
  for (const base of ["acordaos", "decisoes"]) {
    results[base] = {};
    for (let year = 2020; year <= 2026; year += 1) {
      const until = year === 2026 ? "03092026" : `3112${year}`;
      const response = await query(base, `0101${year}`, until);
      const result = response.result ?? {};
      const buckets = result.aggregations?.ramo_direito_agg?.ramo_direito_agg?.buckets ?? [];
      results[base][year] = {
        total: result.hits?.total?.value ?? 0,
        ramos: buckets.map((bucket) => ({ ramo: bucket.key, total: bucket.doc_count })),
      };
    }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser.close();
}
