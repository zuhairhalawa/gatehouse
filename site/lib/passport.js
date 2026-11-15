// Site passports: conformance checks, an instruction risk scan and a fingerprint.
//
// checkSite() loads a peer's public agent files the way a calling browser does
// (section 3.2 of the Worldwide Agentic Web MVP spec): network URL -> site base ->
// agent-manifest.json -> the entry whose name matches exactly -> its network file,
// plus links.json. It never runs the network and never sends anything about a visitor.
//
// It runs in Node (the nightly crawl and the agentic-web-check command) and in the
// browser (the "check a site" form). In Node it reads the CORS header itself. In a
// browser the header is hidden from scripts, so a cross-origin read that succeeds is the
// proof that browsers may read the file.

import { parseHocon } from "../runtime/hocon.js";
import { AgentNetwork, validateNetwork } from "../runtime/kernel.js";
import { riskLevel, scanNetwork } from "./risk.js";

export const PASSPORT_VERSION = 1;
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 12_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\botk_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /"(api_?key|apiKey|secret|token|password)"\s*:\s*"[^"]{8,}"/i,
];

/**
 * Split a network URL into its site base and network name (spec section 3.2: the final
 * path component is the network name; the path before it is the site base).
 *
 * :param networkUrl: Such as "https://peer.example/agents/transit".
 * :return: {ok, url, base, name, origin, reason}.
 */
export function parseNetworkUrl(networkUrl) {
  let url;
  try {
    url = new URL(String(networkUrl || "").trim());
  } catch {
    return { ok: false, reason: "Not a complete URL. Use the form https://site.example/<network name>." };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, reason: "Network URLs use http or https." };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: "A network URL has no query or fragment." };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name || url.pathname.endsWith("/")) {
    return { ok: false, reason: "The URL must end with the network name, such as https://site.example/my_network." };
  }
  const base = `${url.origin}/${parts.join("/")}`.replace(/\/$/, "");
  return { ok: true, url: `${base}/${name}`, base, name, origin: url.origin, loopback: LOOPBACK.has(url.hostname) };
}

/**
 * Turn a value into JSON with sorted keys, so the same content always hashes the same.
 *
 * :param value: Any JSON value.
 * :return: The canonical JSON text.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Hash text with SHA-256 through Web Crypto (Node 22 and browsers).
 *
 * :param text: The text to hash.
 * :return: The lowercase hex digest.
 */
export async function sha256(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch one public file with a time limit and a size limit.
 *
 * :param url: The file URL.
 * :param options: {fetchImpl, env, origin}. In Node, origin is sent as the Origin header
 *   so the reply's CORS header can be read.
 * :return: {ok, status, text, cors, finalUrl, error}. cors is "yes", "no" or "untested".
 */
export async function fetchPublic(url, { fetchImpl = globalThis.fetch, env = "node", origin = "https://gatehouse.check" } = {}) {
  const init = { redirect: "follow", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (env === "node") {
    init.headers = { Origin: origin, Accept: "application/json, text/plain, */*" };
  }
  let resp;
  try {
    resp = await fetchImpl(url, init);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      text: "",
      cors: env === "browser" ? "no" : "untested",
      finalUrl: url,
      error: timedOut
        ? `No answer within ${TIMEOUT_MS / 1000} s.`
        : env === "browser"
          ? "The browser could not read it: the server is down, or it sends no CORS header."
          : `Could not connect: ${error?.cause?.code || error?.message || "network error"}.`,
    };
  }
  let text = "";
  try {
    text = await resp.text();
  } catch {
    text = "";
  }
  let cors = "untested";
  if (env === "node") {
    const allow = resp.headers?.get?.("access-control-allow-origin");
    cors = allow === "*" || allow === origin ? "yes" : "no";
  } else if (typeof location !== "undefined") {
    cors = new URL(url).origin === location.origin ? "untested" : "yes";
  }
  return {
    ok: resp.ok,
    status: resp.status,
    text: text.length > MAX_BYTES ? "" : text,
    tooBig: text.length > MAX_BYTES,
    cors,
    finalUrl: resp.url || url,
    error: resp.ok ? null : `HTTP ${resp.status}.`,
  };
}

/**
 * Collects check results for one passport.
 */
class CheckList {
  constructor() {
    this.items = [];
  }

  /**
   * Record one check.
   *
   * :param id: A stable check id.
   * :param status: "pass", "warn", "fail" or "skip".
   * :param title: A short name a visitor reads.
   * :param detail: One sentence on what was found.
   * :param ref: The spec section, such as "3.2".
   */
  add(id, status, title, detail, ref = "") {
    this.items.push({ id, status, title, detail, ref });
  }

  get failed() {
    return this.items.some((item) => item.status === "fail");
  }
}

/**
 * Read the agents of a network definition into a short public summary.
 *
 * :param config: The parsed network definition.
 * :param frontMan: The front agent's name.
 * :return: One entry per agent with its name, description and tools.
 */
function summarizeAgents(config, frontMan) {
  return (config.tools || [])
    .filter((agent) => agent && typeof agent === "object" && agent.name)
    .map((agent) => ({
      name: agent.name,
      front: agent.name === frontMan,
      description: String(agent.function?.description || "").slice(0, 300),
      tools: (agent.tools || []).map((ref) => (typeof ref === "string" ? ref : ref?.url || "?")),
      allowDownstream: agent.allow?.to_downstream?.sly_data ?? null,
      allowUpstream: agent.allow?.to_upstream?.sly_data ?? null,
    }));
}

/**
 * Hash each agent the way the runtime will run it: after its own config filter expands
 * replacement strings and pushes down defaults. The same function can then hash the
 * network the runtime actually compiled (session.network.config) and compare.
 *
 * :param network: A network definition, raw (from the file) or already filtered.
 * :param name: The network name.
 * :return: {agentName: sha256 hex}.
 */
export async function agentHashes(network, name = "network") {
  const filtered = network instanceof AgentNetwork ? network.config : new AgentNetwork(structuredClone(network || {}), name).config;
  const agents = {};
  for (const agent of filtered.tools || []) {
    if (agent && agent.name) {
      agents[agent.name] = await sha256(canonicalJson({
        instructions: agent.instructions || "",
        function: agent.function || null,
        tools: agent.tools || [],
        allow: agent.allow || null,
      }));
    }
  }
  return agents;
}

/**
 * Say whether two sets of agent hashes are the same.
 *
 * :param a: {agentName: hash}.
 * :param b: {agentName: hash}.
 * :return: True when both name the same agents with the same hashes.
 */
export function sameAgents(a, b) {
  const left = Object.keys(a || {}).sort();
  const right = Object.keys(b || {}).sort();
  return left.length === right.length && left.every((key, i) => key === right[i] && a[key] === b[key]);
}

/**
 * Hash each published file and the agents' instructions, so a later check can say
 * exactly what changed.
 *
 * :param files: {manifest, network, links} as parsed JSON (links may be null).
 * :param entryName: The network name, to pick the manifest entry.
 * :return: {fingerprint, files: {manifest, network, links}, agents: {name: hash}}.
 */
export async function fingerprintFiles({ manifest, network, links }, entryName) {
  const entry = (manifest?.networks || []).find((item) => item?.name === entryName) || null;
  const parts = {
    manifest: await sha256(canonicalJson(manifest)),
    network: await sha256(canonicalJson(network)),
    links: await sha256(canonicalJson(links ?? null)),
  };
  const agents = await agentHashes(network, entryName);
  const fingerprint = await sha256(canonicalJson({
    entry,
    manifest: parts.manifest,
    network: parts.network,
    links: parts.links,
    router: manifest?.llm_router || null,
    peers: manifest?.allowed_peers || [],
  }));
  return { fingerprint, files: parts, agents };
}

/**
 * Compare two fingerprints and say what changed in plain words.
 *
 * :param before: A fingerprint record from fingerprintFiles (or a passport's pin).
 * :param after: A newer one.
 * :return: A list of short sentences; empty when nothing changed.
 */
export function describeChanges(before, after) {
  if (!before || !after || before.fingerprint === after.fingerprint) {
    return [];
  }
  const changes = [];
  if (before.files?.manifest !== after.files?.manifest) {
    changes.push("The manifest changed (router, peers, policy or network list).");
  }
  if (before.files?.links !== after.files?.links) {
    changes.push("links.json changed (the sites this network hands off to).");
  }
  const names = new Set([...Object.keys(before.agents || {}), ...Object.keys(after.agents || {})]);
  for (const name of [...names].sort()) {
    const old = before.agents?.[name];
    const now = after.agents?.[name];
    if (!old) {
      changes.push(`New agent: ${name}.`);
    } else if (!now) {
      changes.push(`Agent removed: ${name}.`);
    } else if (old !== now) {
      changes.push(`Agent ${name} changed its instructions, tools or data rules.`);
    }
  }
  if (!changes.length) {
    changes.push("The published files changed.");
  }
  return changes;
}

/**
 * Check one network URL and build its passport.
 *
 * :param networkUrl: The peer network URL.
 * :param options: {fetchImpl, env ("node" or "browser"), origin, now}.
 * :return: The passport: identity, verdict, checks, risk findings, agents and fingerprint.
 */
export async function checkSite(networkUrl, options = {}) {
  const env = options.env || "node";
  const now = options.now || new Date().toISOString();
  const checks = new CheckList();
  const passport = {
    version: PASSPORT_VERSION,
    url: String(networkUrl || "").trim(),
    checkedAt: now,
    checkedFrom: env,
    verdict: "fail",
    loadable: false,
    checks: checks.items,
    risk: { level: "none", findings: [] },
  };
  const parsed = parseNetworkUrl(networkUrl);
  if (!parsed.ok) {
    checks.add("url", "fail", "Network URL", parsed.reason, "3.2");
    passport.summary = parsed.reason;
    return passport;
  }
  Object.assign(passport, { url: parsed.url, base: parsed.base, name: parsed.name, origin: parsed.origin });
  const httpsOk = parsed.url.startsWith("https://") || parsed.loopback;
  checks.add("https", httpsOk ? "pass" : "fail", "HTTPS",
    httpsOk
      ? (parsed.url.startsWith("https://") ? "Served over HTTPS." : "Loopback address: plain HTTP is fine for local development only.")
      : "Production sites must use HTTPS.",
    "3.2");

  // 1. The manifest at the site base.
  const manifestUrl = `${parsed.base}/agent-manifest.json`;
  const fetchOptions = { fetchImpl: options.fetchImpl, env, origin: options.origin };
  const manifestResp = await fetchPublic(manifestUrl, fetchOptions);
  if (!manifestResp.ok) {
    checks.add("manifest", "fail", "Manifest", `${manifestUrl}: ${manifestResp.error}`, "3.3");
    passport.summary = env === "browser" && manifestResp.status === 0
      ? "Browsers cannot read this site's manifest, so no other site can load it."
      : "No manifest found at the site base.";
    return finish(passport, checks);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestResp.text);
  } catch {
    checks.add("manifest", "fail", "Manifest", "agent-manifest.json is not valid JSON.", "3.3");
    passport.summary = "The manifest is not valid JSON.";
    return finish(passport, checks);
  }
  checks.add("manifest", "pass", "Manifest", "agent-manifest.json found at the site base.", "3.3");
  addCorsCheck(checks, "cors_manifest", "Manifest readable by other sites", manifestResp, env);
  if (new URL(manifestResp.finalUrl).origin !== parsed.origin) {
    checks.add("redirect", "warn", "Redirect", `The manifest redirects to ${new URL(manifestResp.finalUrl).origin}, a new destination.`, "5");
  }

  const networks = Array.isArray(manifest.networks) ? manifest.networks : [];
  const fieldProblems = [];
  if (!networks.length) {
    fieldProblems.push("no networks list");
  }
  networks.forEach((item, index) => {
    for (const field of ["name", "front_man", "hocon"]) {
      if (!item || typeof item[field] !== "string" || !item[field]) {
        fieldProblems.push(`networks[${index}] has no ${field}`);
      }
    }
  });
  if (!manifest.llm_router || typeof manifest.llm_router !== "object") {
    fieldProblems.push("no llm_router");
  }
  if (!manifest.peer_policy || typeof manifest.peer_policy !== "object") {
    fieldProblems.push("no peer_policy");
  }
  checks.add("manifest_fields", fieldProblems.length ? "fail" : "pass", "Manifest fields",
    fieldProblems.length ? `Missing: ${fieldProblems.join("; ")}.` : "Networks with name, front_man and hocon; router metadata; peer policy.",
    "3.3");

  // 2. The exact network name (spec: fail rather than pick another network).
  const entry = networks.find((item) => item?.name === parsed.name);
  passport.brand = typeof manifest.brand === "string" ? manifest.brand.slice(0, 120) : "";
  passport.published = networks.map((item) => item?.name).filter(Boolean);
  if (!entry) {
    checks.add("exact_name", "fail", "Exact network name",
      `No network named "${parsed.name}". Published: ${passport.published.join(", ") || "none"}.`, "3.2");
    passport.summary = `This site publishes no network named "${parsed.name}".`;
    return finish(passport, checks);
  }
  checks.add("exact_name", "pass", "Exact network name", `The manifest lists "${parsed.name}".`, "3.2");
  passport.description = String(entry.description || "").slice(0, 400);
  passport.sampleQueries = (entry.sample_queries || []).filter((q) => typeof q === "string").slice(0, 8);
  passport.tags = (entry.tags || []).filter((t) => typeof t === "string").slice(0, 12);

  // 3. The network definition.
  let networkUrlResolved;
  try {
    networkUrlResolved = /^https?:\/\//i.test(entry.hocon) ? entry.hocon : new URL(entry.hocon, `${parsed.base}/`).href;
  } catch {
    checks.add("network", "fail", "Network definition", `The hocon value "${entry.hocon}" is not a usable path.`, "3.2");
    return finish(passport, checks);
  }
  const networkResp = await fetchPublic(networkUrlResolved, fetchOptions);
  if (!networkResp.ok) {
    checks.add("network", "fail", "Network definition", `${networkUrlResolved}: ${networkResp.error}`, "3.2");
    passport.summary = "The network definition could not be read.";
    return finish(passport, checks);
  }
  addCorsCheck(checks, "cors_network", "Network readable by other sites", networkResp, env);
  let config;
  try {
    config = parseHocon(networkResp.text);
  } catch (error) {
    checks.add("network", "fail", "Network definition", `Does not parse: ${String(error?.message || error).slice(0, 160)}`, "2");
    passport.summary = "The network definition does not parse.";
    return finish(passport, checks);
  }
  const network = new AgentNetwork(config, parsed.name);
  const validation = validateNetwork(network);
  const frontMan = network.findFrontMan();
  if (validation.errors.length) {
    checks.add("network", "fail", "Network definition",
      `Fails validation: ${validation.errors.slice(0, 3).join("; ")}`, "2.1");
  } else {
    checks.add("network", "pass", "Network definition", "Parses and passes the runtime's own validator.", "2.1");
  }
  if (frontMan && frontMan !== entry.front_man) {
    checks.add("front_man", "warn", "Front agent", `The manifest says "${entry.front_man}", the network's front agent is "${frontMan}".`, "2.1");
  } else if (frontMan) {
    checks.add("front_man", "pass", "Front agent", `Front agent "${frontMan}".`, "2.1");
  }
  const agents = summarizeAgents(config, frontMan);
  passport.agents = agents;
  passport.externals = validation.externals || [];
  passport.mcps = validation.mcps || [];
  checks.add("agents", agents.length >= 2 ? "pass" : "warn", "Agent count",
    agents.length >= 2 ? `${agents.length} agents.` : "One agent. The spec's first interoperability check uses a two-agent network.", "6");

  // 4. links.json (a minimum public file in section 3.3; the runtime tolerates a missing one).
  const linksResp = await fetchPublic(`${parsed.base}/links.json`, fetchOptions);
  let links = null;
  if (linksResp.ok) {
    try {
      links = JSON.parse(linksResp.text);
      checks.add("links", "pass", "links.json", "Published.", "3.3");
    } catch {
      checks.add("links", "warn", "links.json", "Published but not valid JSON.", "3.3");
    }
  } else {
    checks.add("links", "warn", "links.json", "Not published. Section 3.3 lists it as a public file.", "3.3");
  }

  // 5. Policies: peers, router, private context, coded tools, secrets.
  const mode = manifest.peer_policy?.mode;
  checks.add("peer_policy", mode === "closed" ? "pass" : "warn", "Peer policy",
    mode === "closed"
      ? closedPolicyText((manifest.allowed_peers || []).length)
      : `Mode "${mode || "missing"}": the network may ask to contact origins it does not list.`,
    "3.2");
  const routerBase = String(manifest.llm_router?.base_url || "");
  const routerOk = /^https:\/\//i.test(routerBase) || routerBase.startsWith("browser://") || /^http:\/\/(localhost|127\.0\.0\.1)/i.test(routerBase);
  checks.add("router", routerBase ? (routerOk ? "pass" : "warn") : "warn", "Default router",
    routerBase ? `${routerBase}. Callers ignore it: a peer runs on the caller's router.` : "No default router base_url.", "4");
  const broadSly = agents.filter((agent) =>
    [agent.allowDownstream, agent.allowUpstream].some((list) => list === true || (Array.isArray(list) && list.includes("*"))));
  checks.add("private_context", broadSly.length ? "warn" : "pass", "Private context",
    broadSly.length
      ? `${broadSly.map((a) => a.name).join(", ")} pass all private fields across boundaries ("*").`
      : "Deny by default: no agent passes all private fields.",
    "2.1");
  if (manifest.coded_tools?.bundle) {
    checks.add("coded_tools", manifest.coded_tools.integrity ? "pass" : "warn", "Coded tools",
      manifest.coded_tools.integrity ? "Bundle declared with an SRI digest." : "Bundle declared without an SRI digest.", "5");
  }
  const published = `${manifestResp.text}\n${networkResp.text}\n${linksResp.text || ""}`;
  const leaked = KEY_PATTERNS.some((pattern) => pattern.test(published));
  checks.add("secrets", leaked ? "fail" : "pass", "No keys in public files",
    leaked ? "Something that looks like an API key or secret is in the public files." : "No key-like strings found.", "4");

  // 6. Instruction risk scan and fingerprint.
  const findings = scanNetwork(config);
  passport.risk = { level: riskLevel(findings), findings: findings.slice(0, 20) };
  const networkJson = (() => {
    try { return JSON.parse(networkResp.text); } catch { return config; }
  })();
  passport.pin = await fingerprintFiles({ manifest, network: networkJson, links }, parsed.name);
  passport.fingerprint = passport.pin.fingerprint;
  return finish(passport, checks);
}

/**
 * Describe a closed peer policy by how many origins it lists.
 */
function closedPolicyText(count) {
  if (count === 0) return "Closed: it may contact no other origin.";
  return `Closed: it may contact only the ${count} origin${count === 1 ? "" : "s"} it lists.`;
}

/**
 * Record whether a cross-origin read is allowed.
 */
function addCorsCheck(checks, id, title, resp, env) {
  if (resp.cors === "yes") {
    checks.add(id, "pass", title, env === "browser" ? "This browser read it from another origin." : "Sends Access-Control-Allow-Origin.", "3.4");
  } else if (resp.cors === "no") {
    checks.add(id, "fail", title, "No Access-Control-Allow-Origin header: browsers on other sites cannot read it.", "3.4");
  } else {
    checks.add(id, "skip", title, "Same origin as this page, so CORS was not tested.", "3.4");
  }
}

/**
 * Work out the verdict and the one-line summary.
 *
 * :param passport: The passport being built.
 * :param checks: Its checks.
 * :return: The finished passport.
 */
function finish(passport, checks) {
  const corsFailed = checks.items.some((item) => item.id.startsWith("cors_") && item.status === "fail");
  const hardFail = checks.items.some((item) => item.status === "fail");
  passport.loadable = !hardFail;
  if (passport.risk.level === "high") {
    passport.verdict = "blocked";
    passport.summary = "Its instructions try to steer the caller's model. Do not let it in.";
  } else if (hardFail) {
    passport.verdict = "fail";
    if (!passport.summary) {
      passport.summary = corsFailed ? "Not loadable: browsers on other sites cannot read its files (missing CORS)."
        : `Not loadable: ${checks.items.find((item) => item.status === "fail").title.toLowerCase()} failed.`;
    }
  } else if (passport.risk.level === "medium" || checks.items.some((item) => item.status === "warn")) {
    passport.verdict = "warn";
    passport.summary = passport.risk.level === "medium"
      ? "Loadable, with instruction text worth reading before you let it in."
      : "Loadable, with minor gaps against the spec.";
  } else {
    passport.verdict = "pass";
    passport.summary = "Loadable and meets every checked rule.";
  }
  if (passport.risk.level === "high") {
    passport.loadable = !hardFail;
  }
  return passport;
}
