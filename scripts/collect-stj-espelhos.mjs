import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const CKAN = "https://dadosabertos.web.stj.jus.br/api/3/action/package_show?id=";
const datasets = [
  { slug: "espelhos-de-acordaos-quinta-turma", folder: "quinta", initial: ["20211231.json", "20220508.json"] },
  { slug: "espelhos-de-acordaos-sexta-turma", folder: "sexta", initial: ["20220508.json"] },
  { slug: "espelhos-de-acordaos-terceira-secao", folder: "terceira", initial: ["20201231.json", "20220508.json"] },
];

const args = new Map(process.argv.slice(2).map((value, index, all) => {
  if (!value.startsWith("--")) return [String(index), value];
  const [key, inline] = value.slice(2).split("=", 2);
  return [key, inline ?? all[index + 1]];
}));
const outputFile = args.get("output") ?? "stj-penal-desde-2020.ndjson";
const cacheDir = args.get("cache") ?? ".cache/stj";
const since = (args.get("since") ?? "2020-01-01").replaceAll("-", "");
const download = args.has("download");

mkdirSync(cacheDir, { recursive: true });

function isoCompact(value) {
  if (!value || !/^\d{8}$/.test(String(value))) return null;
  const text = String(value);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function publicationDate(value, fallback) {
  const match = String(value ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : fallback;
}

function clean(value) {
  return String(value ?? "").replace(/\r/g, "").trim();
}

function compact(value, max = 1200) {
  const text = clean(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function getJson(url) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": "JurisPenal/1.0" } });
    if (response.ok) return response.json();
    lastStatus = response.status;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  throw new Error(`Falha ${lastStatus}: ${url}`);
}

async function downloadFile(url, destination) {
  if (existsSync(destination)) return;
  const partial = `${destination}.part`;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    rmSync(partial, { force: true });
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "JurisPenal/1.0", accept: "application/json, application/zip" },
      });
      lastStatus = response.status;
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(response.body, createWriteStream(partial));
      renameSync(partial, destination);
      return;
    } catch (error) {
      rmSync(partial, { force: true });
      if (attempt === 8) {
        throw new Error(`Falha ${lastStatus || "de rede"}: ${url}`, { cause: error });
      }
      const delay = Math.min(30_000, 2 ** attempt * 1_500);
      process.stderr.write(`Tentativa ${attempt}/8 falhou para ${basename(destination)}; nova tentativa em ${delay / 1000}s.\n`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function recordsFromFile(path, member) {
  const raw = member
    ? execFileSync("unzip", ["-p", path, member], { maxBuffer: 700 * 1024 * 1024 })
    : readFileSync(path);
  return JSON.parse(raw.toString("utf8"));
}

function normalize(item) {
  const judgment = isoCompact(item.dataDecisao);
  const published = publicationDate(item.dataPublicacao, judgment);
  if (!judgment || !published || String(item.dataDecisao) < since) return null;

  const sourceId = clean(item.id);
  const registration = clean(item.numeroRegistro);
  const caseClass = clean(item.siglaClasse || item.descricaoClasse);
  const process = [caseClass, clean(item.numeroProcesso)].filter(Boolean).join(" ");
  const ementa = clean(item.ementa);
  const id = `stj-${sourceId || createHash("sha256").update(`${registration}:${process}`).digest("hex").slice(0, 24)}`;

  return {
    id,
    tribunal: "STJ",
    sourceId: sourceId || registration || id,
    processNumber: process || registration || id,
    registrationNumber: registration || null,
    decisionType: "Acórdão",
    caseClass: clean(item.descricaoClasse || item.siglaClasse) || null,
    judicialBody: clean(item.nomeOrgaoJulgador) || "Órgão julgador não informado",
    rapporteur: clean(item.ministroRelator) || "Relator não informado",
    judgmentDate: judgment,
    publicationDate: published,
    subject: compact(item.tema || ementa.split("\n")[0] || item.descricaoClasse, 260),
    summary: ementa,
    holding: compact(item.teseJuridica, 1400),
    outcome: compact(item.decisao, 900),
    officialUrl: registration
      ? `https://scon.stj.jus.br/SCON/GetInteiroTeorDoAcordao?num_registro=${registration}`
      : "https://scon.stj.jus.br/SCON/",
  };
}

const selectedFiles = [];
for (const dataset of datasets) {
  const folder = join(cacheDir, dataset.folder);
  mkdirSync(folder, { recursive: true });
  const packageData = await getJson(`${CKAN}${dataset.slug}`);
  const resources = packageData.result.resources.filter((resource) =>
    resource.format === "ZIP" || resource.format === "JSON"
  );

  if (download) {
    for (const resource of resources) {
      await downloadFile(resource.url, join(folder, basename(new URL(resource.url).pathname)));
    }
  }

  const zip = resources.find((resource) => resource.format === "ZIP");
  if (!zip) throw new Error(`Carga histórica ausente: ${dataset.slug}`);
  const zipPath = join(folder, basename(new URL(zip.url).pathname));
  for (const member of dataset.initial) selectedFiles.push({ path: zipPath, member, dataset: dataset.slug });
  for (const resource of resources.filter((resource) => resource.format === "JSON")) {
    selectedFiles.push({
      path: join(folder, basename(new URL(resource.url).pathname)),
      member: null,
      dataset: dataset.slug,
    });
  }
}

const byId = new Map();
for (const source of selectedFiles) {
  if (!existsSync(source.path)) throw new Error(`Arquivo ausente: ${source.path}; use --download`);
  const rows = recordsFromFile(source.path, source.member);
  for (const item of rows) {
    const decision = normalize(item);
    if (decision) byId.set(decision.id, decision);
  }
}

const output = createWriteStream(outputFile, { encoding: "utf8" });
for (const decision of [...byId.values()].sort((a, b) =>
  a.publicationDate.localeCompare(b.publicationDate) || a.id.localeCompare(b.id)
)) {
  output.write(`${JSON.stringify(decision)}\n`);
}
output.end();
await new Promise((resolve, reject) => output.on("finish", resolve).on("error", reject));
process.stdout.write(`${byId.size} acórdãos únicos desde ${since} gravados em ${outputFile}\n`);
