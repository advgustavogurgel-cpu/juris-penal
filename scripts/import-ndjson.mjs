import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const [file, siteUrl] = process.argv.slice(2);
const token = process.env.JURIS_INGEST_TOKEN;
const sitesToken = process.env.OAI_SITES_AUTHORIZATION;
const runId = process.env.JURIS_RUN_ID;
const sourceName = process.env.JURIS_SOURCE_NAME ?? "Importação NDJSON";
const intervalStart = process.env.JURIS_INTERVAL_START ?? "2020-01-01";
const intervalEnd = process.env.JURIS_INTERVAL_END ?? new Date().toISOString().slice(0, 10);
const expectedCount = Number(process.env.JURIS_EXPECTED_COUNT ?? "") || null;

if (!file || !siteUrl || !token) {
  process.stderr.write(
    "Uso: JURIS_INGEST_TOKEN=... node scripts/import-ndjson.mjs arquivo.ndjson https://site\n"
  );
  process.exitCode = 1;
} else {
  const input = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let batch = [];
  let imported = 0;
  const pending = new Set();
  const concurrency = Math.max(1, Number(process.env.JURIS_CONCURRENCY ?? "6") || 6);
  const batchSize = Math.min(100, Math.max(1, Number(process.env.JURIS_BATCH_SIZE ?? "100") || 100));

  async function send(items, final = false) {
    const run = runId ? {
      id: runId,
      tribunal: "STJ",
      sourceName,
      intervalStart,
      intervalEnd,
      expectedCount,
      status: final ? "reconciled" : "running",
      notes: final ? "Carga oficial concluída e deduplicada por ID do STJ." : "Carga oficial em andamento.",
    } : undefined;
    const response = await fetch(`${siteUrl.replace(/\/$/, "")}/api/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(sitesToken ? { "OAI-Sites-Authorization": `Bearer ${sitesToken}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({ decisions: items, run }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? `Falha HTTP ${response.status}`);
    }
    imported += result.accepted;
    process.stdout.write(`\r${imported} registros importados`);
  }

  async function schedule(items) {
    const task = send(items, false).finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size >= concurrency) await Promise.race(pending);
  }

  for await (const line of input) {
    if (!line.trim()) continue;
    batch.push(JSON.parse(line));
    if (batch.length === batchSize) {
      await schedule(batch);
      batch = [];
    }
  }

  if (batch.length) await schedule(batch);
  await Promise.all(pending);
  if (runId) await send([], true);
  process.stdout.write("\nImportação concluída.\n");
}
