import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { chromium } from "playwright";

const BASE_URL = "https://jurisprudencia.stf.jus.br";
const CRIMINAL_CLASSES = ["AP", "HC", "RHC", "INQ", "EXT", "PPE", "EP", "RC", "RvC"];
const TEXT_FIELDS = [
  "ementa_texto", "acordao_ata", "decisao_texto",
  "documental_indexacao_texto", "documental_legislacao_citada_texto",
  "documental_observacao_texto", "inteiro_teor_texto",
];
const TEXT_TERMS = [
  "direito penal", "processual penal", "processo penal", "código penal",
  "código de processo penal", "infração penal", "ação penal", "habeas corpus",
  "crime", "criminal", "criminoso", "delito", "prisão", "réu", "acusado",
  "condenado", "denúncia", "dosimetria", "punibilidade", "prescrição",
  "tráfico", "entorpecente", "roubo", "furto", "homicídio", "estupro",
  "latrocínio", "lavagem de dinheiro", "organização criminosa", "tribunal do júri",
];
const SOURCE_FIELDS = [
  "id", "dg_unique", "titulo", "processo_codigo_completo",
  "processo_classe_processual_unificada_extenso",
  "processo_classe_processual_unificada_classe_sigla",
  "processo_classe_processual_unificada_incidente_sigla",
  "julgamento_data", "publicacao_data", "orgao_julgador",
  "relator_processo_nome", "relator_acordao_nome", "relator_decisao_nome",
  "ministro_facet", "ementa_texto", "acordao_ata", "decisao_texto",
  "documental_indexacao_texto", "documental_tese_texto",
  "documental_tese_tema_texto", "inteiro_teor_url",
];

const args = new Map(process.argv.slice(2).map((value, index, all) => {
  if (!value.startsWith("--")) return [String(index), value];
  const [key, inline] = value.slice(2).split("=", 2);
  return [key, inline ?? all[index + 1]];
}));
const since = args.get("since") ?? "2020-01-01";
const until = args.get("until") ?? new Date().toISOString().slice(0, 10);
const outputFile = args.get("output") ?? "stf-penal-desde-2020.ndjson";
const PAGE_SIZE = 250;

function clean(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).join("\n");
  return String(value ?? "").replace(/\r/g, "").trim();
}
function compact(value, max) {
  const text = clean(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function toDmy(iso) {
  return `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
}
function monthEnd(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}
function addMonths(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}
function addDays(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
}

function buildQuery(base, start, end, from = 0) {
  const penalUnion = {
    bool: {
      minimum_should_match: 1,
      should: [
        { terms: { "processo_classe_processual_unificada_classe_sigla.keyword": CRIMINAL_CLASSES } },
        ...TEXT_TERMS.map((term) => ({
          multi_match: { query: term, fields: TEXT_FIELDS, type: "phrase" },
        })),
      ],
    },
  };
  return {
    query: {
      bool: {
        filter: [
          { range: { publicacao_data: { format: "ddMMyyyy", gte: toDmy(start), lte: toDmy(end) } } },
          penalUnion,
        ],
        must: [], should: [], must_not: [],
      },
    },
    post_filter: { bool: { must: [{ term: { base } }], should: [] } },
    _source: SOURCE_FIELDS,
    size: PAGE_SIZE,
    from,
    sort: [{ publicacao_data: "asc" }],
    track_total_hits: true,
  };
}

function normalize(hit, base) {
  const item = hit._source ?? {};
  const rawId = clean(item.id || item.dg_unique || hit._id);
  const fallback = createHash("sha256")
    .update(`${base}:${clean(item.titulo)}:${clean(item.publicacao_data)}:${clean(item.ministro_facet)}`)
    .digest("hex")
    .slice(0, 32);
  const sourceId = `${base}:${rawId || fallback}`;
  const title = clean(item.titulo || item.processo_codigo_completo) || sourceId;
  const ementa = clean(item.ementa_texto);
  const decision = clean(item.decisao_texto);
  const ata = clean(item.acordao_ata);
  const indexacao = clean(item.documental_indexacao_texto);
  const tese = clean(item.documental_tese_texto);
  const tema = clean(item.documental_tese_tema_texto);
  const isAcordao = base === "acordaos";
  const summary = isAcordao ? compact(ementa || ata, 4_500) : compact(decision || ementa, 3_500);
  const holding = compact(tese || indexacao || summary, 1_800);
  const outcome = compact(ata || decision, 1_000);
  const subject = compact(tema || indexacao || ementa || decision || title, 260);
  const officialUrl = clean(item.inteiro_teor_url) ||
    `${BASE_URL}/pages/search/${encodeURIComponent(rawId || hit._id)}/false`;

  return {
    id: `stf-${createHash("sha256").update(sourceId).digest("hex").slice(0, 32)}`,
    tribunal: "STF",
    sourceId,
    processNumber: title,
    registrationNumber: null,
    decisionType: isAcordao ? "Acórdão" : "Decisão monocrática",
    caseClass: clean(item.processo_classe_processual_unificada_extenso ||
      item.processo_classe_processual_unificada_classe_sigla) || null,
    judicialBody: clean(item.orgao_julgador) || (isAcordao ? "Órgão colegiado não informado" : "Decisão monocrática"),
    rapporteur: clean(item.relator_acordao_nome || item.relator_decisao_nome ||
      item.relator_processo_nome || item.ministro_facet) || "Relator não informado",
    judgmentDate: clean(item.julgamento_data) || null,
    publicationDate: clean(item.publicacao_data),
    subject,
    summary,
    holding,
    outcome,
    officialUrl,
  };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "pt-BR",
});
const page = await context.newPage();
const output = createWriteStream(outputFile, { encoding: "utf8" });
const ids = new Set();
let expected = 0;
let emitted = 0;

async function post(body) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await page.evaluate(async ({ body }) => {
        const response = await fetch("/api/search/search", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
        return JSON.parse(text);
      }, { body });
    } catch (error) {
      lastError = error;
      if (attempt === 6) break;
      await page.waitForTimeout(attempt * 1_500);
    }
  }
  throw lastError;
}

async function emitHits(hits, base) {
  for (const hit of hits) {
    const record = normalize(hit, base);
    if (!record.publicationDate) throw new Error(`Data de publicação ausente: ${record.sourceId}`);
    if (ids.has(record.id)) throw new Error(`ID duplicado na fonte/paginação: ${record.sourceId}`);
    ids.add(record.id);
    if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, "drain");
    emitted += 1;
  }
}

async function collectSlice(base, start, end, firstResponse = null) {
  const first = firstResponse ?? await post(buildQuery(base, start, end, 0));
  const total = first.result?.hits?.total?.value ?? 0;
  if (total >= 10_000) throw new Error(`Intervalo excede limite do STF: ${base} ${start} a ${end} (${total})`);
  expected += total;
  await emitHits(first.result?.hits?.hits ?? [], base);
  for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE) {
    const response = await post(buildQuery(base, start, end, from));
    await emitHits(response.result?.hits?.hits ?? [], base);
  }
  process.stdout.write(`\r${emitted}/${expected} registros coletados até ${end}`);
}

try {
  await page.goto(`${BASE_URL}/pages/search`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const cookies = await context.cookies();
    if (cookies.some((cookie) => cookie.name === "aws-waf-token")) { ready = true; break; }
    await page.waitForTimeout(1_000);
  }
  if (!ready) throw new Error("O STF não liberou a sessão após o desafio de JavaScript.");

  let month = `${since.slice(0, 7)}-01`;
  while (month <= until) {
    const end = monthEnd(month) < until ? monthEnd(month) : until;
    const start = month < since ? since : month;
    for (const base of ["acordaos", "decisoes"]) {
      const first = await post(buildQuery(base, start, end, 0));
      const total = first.result?.hits?.total?.value ?? 0;
      if (total < 10_000) {
        await collectSlice(base, start, end, first);
      } else {
        for (let day = start; day <= end; day = addDays(day)) {
          await collectSlice(base, day, day);
        }
      }
    }
    month = addMonths(month);
  }

  output.end();
  await once(output, "finish");
  if (emitted !== expected || emitted !== ids.size) {
    throw new Error(`Reconciliação falhou: fonte=${expected}, emitidos=${emitted}, únicos=${ids.size}`);
  }
  process.stdout.write(`\n${emitted} decisões únicas do STF reconciliadas em ${outputFile}.\n`);
} finally {
  if (!output.closed) output.destroy();
  await browser.close();
}
