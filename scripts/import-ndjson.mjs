import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const [file, siteUrl] = process.argv.slice(2);
const runId = process.env.JURIS_RUN_ID;
const sourceName = process.env.JURIS_SOURCE_NAME ?? "Importação NDJSON";
const intervalStart = process.env.JURIS_INTERVAL_START ?? "2020-01-01";
const intervalEnd = process.env.JURIS_INTERVAL_END ?? new Date().toISOString().slice(0, 10);
const expectedCount = Number(process.env.JURIS_EXPECTED_COUNT ?? "") || null;

if (!file || !siteUrl) {
  process.stderr.write(
    "Uso: node scripts/import-ndjson.mjs arquivo.ndjson https://site\n"
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
  let oidc = { token: "", expiresAt: 0 };

  function tokenExpiry(token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      return Number(payload.exp ?? 0) * 1000;
    } catch {
      return 0;
    }
  }

  async function authorizationToken() {
    const legacyToken = process.env.JURIS_INGEST_TOKEN;
    if (legacyToken) return legacyToken;
    if (oidc.token && oidc.expiresAt > Date.now() + 30_000) return oidc.token;
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) {
      throw new Error("Identidade OIDC do GitHub Actions indisponível");
    }
    const separator = requestUrl.includes("?") ? "&" : "?";
    const response = await fetch(`${requestUrl}${separator}audience=juris-penal`, {
      headers: { authorization: `Bearer ${requestToken}` },
    });
    if (!response.ok) throw new Error(`Falha ao obter identidade OIDC: HTTP ${response.status}`);
    const body = await response.json();
    oidc = { token: body.value, expiresAt: tokenExpiry(body.value) };
    return oidc.token;
  }

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
    let lastError = "Falha de importação";
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const token = await authorizationToken();
      const response = await fetch(`${siteUrl.replace(/\/$/, "")}/api/ingest`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decisions: items, run }),
      });
      const result = await response.json();
      if (response.ok) {
        imported += result.accepted;
        process.stdout.write(`\r${imported} registros importados`);
        return;
      }
      lastError = result.error ?? `Falha HTTP ${response.status}`;
      const retryable = response.status === 429 || response.status >= 500 || /overloaded|queued for too long|CPU time limit|reset|exceeded|temporar/i.test(lastError);
      if (!retryable || attempt === 10) break;
      const delay = Math.min(20_000, 750 * 2 ** attempt) + Math.floor(Math.random() * 500);
      process.stderr.write(`\nLote adiado (${lastError}); tentativa ${attempt + 1}/10 em ${Math.round(delay / 1000)}s.\n`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new Error(lastError);
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
