#!/usr/bin/env node
// Nightly crawl: find agentic websites, check each one and update the directory.
//
//   node scripts/crawl.mjs [--out site/data/directory.json] [--extra <network URL>]...
//                          [--no-official] [--no-prs] [--no-nanda]
//
// Sources, in order:
//   1. The official list in cognizant-ai-labs/agentic-web (docs/agentic_websites.md).
//   2. Rows that open pull requests add to that list (entrants waiting for review).
//   3. Domains in the NANDA Index, probed for an agent-manifest.json at the root.
//   4. data/sources.json in this repository (sites submitted to Gatehouse).
//   5. --extra URLs from the command line.
//
// Each site gets a passport from site/lib/passport.js. The crawl keeps each site's
// fingerprint history, so the directory shows when a site's agent files last changed.
// It reads only public files and sends nothing about anyone.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSite, fetchPublic, parseNetworkUrl } from "../site/lib/passport.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFFICIAL_LIST = "https://raw.githubusercontent.com/cognizant-ai-labs/agentic-web/main/docs/agentic_websites.md";
const OFFICIAL_PRS = "https://api.github.com/repos/cognizant-ai-labs/agentic-web/pulls?state=open&per_page=50";
const NANDA_INDEX = "https://api.nandaindex.org/api/v1/index";
const USER_AGENT = "Gatehouse-crawler/0.1";
const HISTORY_LIMIT = 20;

/**
 * Read the command line.
 *
 * :param argv: Arguments after the script name.
 * :return: The options.
 */
export function parseArgs(argv) {
  const options = { out: path.join(ROOT, "site/data/directory.json"), extra: [], official: true, prs: true, nanda: true, sources: path.join(ROOT, "data/sources.json") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--extra" || arg === "--sources") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} needs a value.`);
      }
      if (arg === "--extra") {
        options.extra.push(value);
      } else {
        options[arg.slice(2)] = path.resolve(value);
      }
      i += 1;
    } else if (arg === "--no-official") {
      options.official = false;
    } else if (arg === "--no-prs") {
      options.prs = false;
    } else if (arg === "--no-nanda") {
      options.nanda = false;
    } else {
      throw new Error(`Unknown option ${arg}.`);
    }
  }
  return options;
}

/**
 * Pull the links out of the official list's Markdown table rows.
 *
 * :param markdown: The list's Markdown, or the "+" lines of a pull request's patch.
 * :return: [{name, siteUrl, agentUrl}] for each row with a link.
 */
export function parseListRows(markdown) {
  const rows = [];
  for (const raw of String(markdown || "").split("\n")) {
    const line = raw.replace(/^\+/, "").trim();
    if (!line.startsWith("|") || /^\|\s*-+/.test(line) || /^\|\s*URL\s*\|/i.test(line)) {
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) {
      continue;
    }
    const links = [...line.matchAll(/\((https?:\/\/[^)\s]+)\)|(?<![(\w])(https?:\/\/[^\s|)]+)/g)].map((m) => m[1] || m[2]);
    if (!links.length) {
      continue;
    }
    rows.push({ name: cells[1] || "", siteUrl: links[0], agentUrl: links[links.length - 1] });
  }
  return rows;
}

/**
 * Turn a link from a list row into a network URL. A row may link to the network URL
 * itself, to a *.network.json file, or to a site root with an agent-manifest.json.
 *
 * :param link: The link.
 * :param fetchImpl: fetch, for tests.
 * :return: A list of network URLs (a manifest may publish several).
 */
export async function networkUrlsFromLink(link, fetchImpl = globalThis.fetch) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return [];
  }
  const fileMatch = url.pathname.match(/^(.*\/)([^/]+)\.network\.json$/);
  const folder = fileMatch ? `${url.origin}${fileMatch[1]}` : url.pathname.endsWith("/") ? `${url.origin}${url.pathname}` : null;
  if (!folder) {
    // Already a network URL (its last path part is the network name).
    return parseNetworkUrl(link).ok ? [parseNetworkUrl(link).url] : [];
  }
  const resp = await fetchPublic(`${folder}agent-manifest.json`, { fetchImpl });
  if (!resp.ok) {
    // Keep a guess, so the passport records why the site is not loadable.
    return fileMatch ? [`${folder}${fileMatch[2]}`] : [];
  }
  let manifest;
  try {
    manifest = JSON.parse(resp.text);
  } catch {
    return fileMatch ? [`${folder}${fileMatch[2]}`] : [];
  }
  const base = folder.replace(/\/$/, "");
  const networks = (manifest.networks || []).filter((entry) => entry && typeof entry.name === "string");
  if (fileMatch) {
    const target = url.href;
    const owner = networks.find((entry) => {
      try {
        return new URL(entry.hocon, `${base}/`).href === target;
      } catch {
        return false;
      }
    });
    return [`${base}/${owner ? owner.name : fileMatch[2]}`];
  }
  return networks.map((entry) => `${base}/${entry.name}`);
}

/**
 * Fetch JSON with a time limit.
 */
async function getJson(url, headers = {}) {
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return resp.json();
}

/**
 * Collect candidate network URLs from every source.
 *
 * :param options: From parseArgs.
 * :param log: Where progress goes.
 * :return: A map from network URL to {sources: [...], listedName}.
 */
export async function collectCandidates(options, log = console.log) {
  const found = new Map();
  const add = (networkUrl, source, listedName = "") => {
    const parsed = parseNetworkUrl(networkUrl);
    if (!parsed.ok) {
      return;
    }
    const entry = found.get(parsed.url) || { sources: [], listedName: "" };
    if (!entry.sources.includes(source)) {
      entry.sources.push(source);
    }
    entry.listedName = entry.listedName || listedName;
    found.set(parsed.url, entry);
  };
  if (options.official) {
    try {
      const resp = await fetch(OFFICIAL_LIST, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
      const rows = parseListRows(await resp.text());
      for (const row of rows) {
        for (const networkUrl of await networkUrlsFromLink(row.agentUrl)) {
          add(networkUrl, "official list", row.name);
        }
      }
      log(`official list: ${rows.length} row(s)`);
    } catch (error) {
      log(`official list: skipped (${error.message})`);
    }
  }
  if (options.prs) {
    try {
      const token = process.env.GITHUB_TOKEN;
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const pulls = await getJson(OFFICIAL_PRS, headers);
      let count = 0;
      for (const pull of pulls) {
        const files = await getJson(`${pull.url}/files`, headers);
        const list = files.find((file) => file.filename === "docs/agentic_websites.md");
        if (!list?.patch) {
          continue;
        }
        const added = list.patch.split("\n").filter((line) => line.startsWith("+")).join("\n");
        for (const row of parseListRows(added)) {
          for (const networkUrl of await networkUrlsFromLink(row.agentUrl)) {
            add(networkUrl, `pull request #${pull.number}`, row.name);
            count += 1;
          }
        }
      }
      log(`open pull requests: ${count} network(s)`);
    } catch (error) {
      log(`open pull requests: skipped (${error.message})`);
    }
  }
  if (options.nanda) {
    try {
      const index = await getJson(NANDA_INDEX);
      const items = Array.isArray(index) ? index : index.items || index.data || [];
      const domains = new Set();
      for (const item of items) {
        const domain = item?.extensions?.["org.projectnanda"]?.domain;
        if (typeof domain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
          domains.add(domain.toLowerCase());
        }
      }
      let hits = 0;
      for (const domain of domains) {
        for (const networkUrl of await networkUrlsFromLink(`https://${domain}/`)) {
          add(networkUrl, "NANDA Index domain");
          hits += 1;
        }
      }
      log(`NANDA Index: ${domains.size} domain(s) probed, ${hits} agentic network(s) found`);
    } catch (error) {
      log(`NANDA Index: skipped (${error.message})`);
    }
  }
  try {
    const submitted = JSON.parse(await readFile(options.sources, "utf8"));
    for (const item of submitted.sites || []) {
      add(item.url, item.source || "submitted to Gatehouse", item.name || "");
    }
    log(`${path.basename(options.sources)}: ${(submitted.sites || []).length} site(s)`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      log(`${path.basename(options.sources)}: skipped (${error.message})`);
    }
  }
  for (const url of options.extra) {
    add(url, "command line");
  }
  return found;
}

/**
 * Keep only what the directory page and the assistant need from a passport.
 *
 * :param passport: From checkSite.
 * :return: A smaller copy.
 */
export function slimPassport(passport) {
  const keep = ["url", "base", "name", "origin", "brand", "description", "sampleQueries", "tags", "verdict", "loadable",
    "summary", "checkedAt", "checks", "risk", "fingerprint", "pin", "published", "externals", "mcps"];
  const out = {};
  for (const key of keep) {
    if (passport[key] !== undefined) {
      out[key] = passport[key];
    }
  }
  if (passport.agents) {
    out.agents = passport.agents.map(({ name, front, description, tools }) => ({ name, front, description, tools }));
  }
  return out;
}

/**
 * Merge a fresh passport into the site's previous record.
 *
 * :param previous: The site's record from the last directory, or undefined.
 * :param passport: Today's passport.
 * :param sources: Where the site was found.
 * :param listedName: The name a list gives it.
 * :return: The new record.
 */
export function mergeRecord(previous, passport, sources, listedName) {
  const now = passport.checkedAt;
  const history = [...(previous?.history || [])];
  const last = history[history.length - 1];
  if (!last || last.fingerprint !== (passport.fingerprint || null) || last.verdict !== passport.verdict) {
    history.push({ at: now, fingerprint: passport.fingerprint || null, verdict: passport.verdict });
  }
  const changed = !last || last.fingerprint !== (passport.fingerprint || null);
  return {
    url: passport.url,
    listedName: listedName || previous?.listedName || "",
    sources,
    firstSeen: previous?.firstSeen || now,
    lastChanged: changed ? now : previous?.lastChanged || now,
    history: history.slice(-HISTORY_LIMIT),
    passport: slimPassport(passport),
  };
}

/**
 * Run the crawl and write the directory.
 *
 * :param argv: Command-line arguments.
 * :return: The directory that was written.
 */
export async function main(argv) {
  const options = parseArgs(argv);
  let previous = { sites: [] };
  try {
    previous = JSON.parse(await readFile(options.out, "utf8"));
  } catch {
    // First crawl.
  }
  const before = new Map((previous.sites || []).map((site) => [site.url, site]));
  const candidates = await collectCandidates(options);
  const sites = [];
  for (const [url, { sources, listedName }] of candidates) {
    const passport = await checkSite(url, { env: "node" });
    sites.push(mergeRecord(before.get(passport.url), passport, sources, listedName));
    console.log(`${passport.verdict.padEnd(7)} ${url}`);
  }
  const order = { pass: 0, warn: 1, fail: 2, blocked: 3 };
  sites.sort((a, b) => (order[a.passport.verdict] - order[b.passport.verdict]) || a.url.localeCompare(b.url));
  const directory = {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      total: sites.length,
      loadable: sites.filter((s) => s.passport.loadable && s.passport.verdict !== "blocked").length,
      notLoadable: sites.filter((s) => !s.passport.loadable).length,
      blocked: sites.filter((s) => s.passport.verdict === "blocked").length,
    },
    sites,
  };
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(directory, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, options.out)}: ${directory.counts.total} site(s), ${directory.counts.loadable} loadable`);
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
