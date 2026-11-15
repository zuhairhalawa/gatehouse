// Gatehouse page object. The page's own buttons and the assistant's site actions call
// these same methods, so both follow one set of rules (see site-actions.js).

import { checkSite, describeChanges, parseNetworkUrl } from "./lib/passport.js";
import { Gate } from "./lib/gate.js";

const SEARCH_LIMIT = 8;

/**
 * Split text into lowercase search words.
 *
 * :param text: Any text.
 * :return: Words of two or more letters or digits.
 */
export function words(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]{2,}/g) || [];
}

/**
 * The directory, the live checks made on this page and the visitor's gate.
 */
export class Gatehouse {
  static page = null;

  /**
   * :param options: {storage, fetchImpl, env, now}. env is "browser" on the page and
   *   "node" in tests.
   */
  constructor({ storage, fetchImpl, env = "browser", now } = {}) {
    this.gate = new Gate(storage);
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.now = now || (() => new Date().toISOString());
    this.directory = { generatedAt: null, counts: { total: 0, loadable: 0, notLoadable: 0, blocked: 0 }, sites: [] };
    this.live = new Map();
    this.listeners = new Set();
    this.lastHandOff = null;
  }

  /**
   * Call fn after every change, so the page can redraw.
   *
   * :param fn: A function with no arguments.
   */
  onChange(fn) {
    this.listeners.add(fn);
  }

  changed() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (error) {
        console.error(error);
      }
    }
  }

  /**
   * Use a directory document (from the nightly crawl).
   *
   * :param doc: The parsed directory.json.
   */
  useDirectory(doc) {
    if (doc && Array.isArray(doc.sites)) {
      this.directory = doc;
      this.changed();
    }
  }

  /**
   * Every known record: the nightly ones, with this page's live checks on top.
   *
   * :return: A list of {url, passport, source fields}.
   */
  records() {
    const byUrl = new Map(this.directory.sites.map((site) => [site.url, site]));
    for (const [url, passport] of this.live) {
      const old = byUrl.get(url);
      byUrl.set(url, { ...(old || { url, sources: ["checked on this page"], history: [] }), passport, checkedHere: true });
    }
    return [...byUrl.values()];
  }

  /**
   * Find a record by network URL, after normalizing it.
   *
   * :param url: A network URL.
   * :return: The record, or null.
   */
  find(url) {
    const parsed = parseNetworkUrl(url);
    if (!parsed.ok) {
      return null;
    }
    return this.records().find((record) => record.url === parsed.url) || null;
  }

  /**
   * Search the directory. Read-only.
   *
   * :param options: {query, verdict ("any", "loadable", "not_loadable", "blocked"), limit}.
   * :return: {query, total, results: [{url, title, verdict, loadable, summary, ...}]}.
   */
  search({ query = "", verdict = "any", limit = SEARCH_LIMIT } = {}) {
    const terms = words(query);
    const scored = [];
    for (const record of this.records()) {
      const p = record.passport;
      if (verdict === "loadable" && !(p.loadable && p.verdict !== "blocked")) continue;
      if (verdict === "not_loadable" && p.loadable) continue;
      if (verdict === "blocked" && p.verdict !== "blocked") continue;
      let score = 0;
      if (terms.length) {
        const fields = [
          [`${p.brand || ""} ${p.name || ""} ${record.listedName || ""}`, 3],
          [p.description, 2],
          [[...(p.sampleQueries || []), ...(p.tags || []), ...(p.agents || []).map((a) => a.description)].join(" "), 1],
        ];
        for (const term of terms) {
          for (const [text, weight] of fields) {
            if (words(text).some((word) => word.startsWith(term))) {
              score += weight;
            }
          }
        }
        if (!score) continue;
      }
      if (p.loadable && p.verdict !== "blocked") score += 0.5;
      scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score || a.record.url.localeCompare(b.record.url));
    const max = Math.max(1, Math.min(Number(limit) || SEARCH_LIMIT, 20));
    return {
      query,
      total: scored.length,
      results: scored.slice(0, max).map(({ record }) => this.brief(record)),
    };
  }

  /**
   * A short public summary of one record, for search results.
   */
  brief(record) {
    const p = record.passport;
    return {
      url: record.url,
      title: p.brand || record.listedName || p.name || record.url,
      verdict: p.verdict,
      loadable: Boolean(p.loadable && p.verdict !== "blocked"),
      summary: p.summary,
      description: p.description || "",
      sampleQueries: (p.sampleQueries || []).slice(0, 3),
      checkedAt: p.checkedAt,
      lastChanged: record.lastChanged || null,
      admitted: Boolean(this.gate.get(record.url)),
    };
  }

  /**
   * One site's full passport. Read-only.
   *
   * :param url: A network URL.
   * :return: {ok: true, passport, firstSeen, lastChanged, history, sources} or {ok: false, reason}.
   */
  getPassport(url) {
    const record = this.find(url);
    if (!record) {
      const parsed = parseNetworkUrl(url);
      return { ok: false, reason: parsed.ok ? "Gatehouse has no passport for that URL yet. Check it first." : parsed.reason };
    }
    const p = record.passport;
    return {
      ok: true,
      passport: {
        url: p.url, title: p.brand || p.name, verdict: p.verdict, loadable: p.loadable, summary: p.summary,
        description: p.description, checkedAt: p.checkedAt, checkedHere: Boolean(record.checkedHere),
        checks: (p.checks || []).map(({ id, status, title, detail, ref }) => ({ id, status, title, detail, spec: ref })),
        risk: p.risk,
        agents: (p.agents || []).map(({ name, front, description }) => ({ name, front, description })),
        fingerprint: p.fingerprint ? `sha256:${p.fingerprint}` : null,
      },
      firstSeen: record.firstSeen || null,
      lastChanged: record.lastChanged || null,
      history: (record.history || []).slice(-5),
      sources: record.sources || [],
      admitted: Boolean(this.gate.get(record.url)),
    };
  }

  /**
   * Check a site now. This contacts the site's origin for its public agent files.
   *
   * :param url: A network URL.
   * :return: {ok: true, passport summary} or {ok: false, reason}.
   */
  async checkNow(url) {
    const parsed = parseNetworkUrl(url);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, field: "url" };
    }
    const passport = await checkSite(parsed.url, { env: this.env, fetchImpl: this.fetchImpl, now: this.now() });
    this.live.set(parsed.url, passport);
    this.changed();
    return this.getPassport(parsed.url);
  }

  /**
   * The read-only check that letIn runs first, and that the confirmation dialog shows.
   *
   * :param url: A network URL.
   * :return: {ok: true, passport, record} or {ok: false, reason}.
   */
  checkLetIn(url) {
    const record = this.find(url);
    if (!record) {
      return { ok: false, reason: "Gatehouse has no passport for that URL yet. Check it first." };
    }
    const p = record.passport;
    if (p.verdict === "blocked") {
      return { ok: false, reason: `${p.brand || p.name} is blocked: ${p.summary}` };
    }
    if (!p.loadable || !p.fingerprint) {
      return { ok: false, reason: `${p.brand || p.name} cannot be loaded: ${p.summary}` };
    }
    if (typeof location !== "undefined" && p.origin === location.origin) {
      return { ok: false, reason: "That network is on this site's own origin." };
    }
    return { ok: true, passport: p, record };
  }

  /**
   * Let a site in: pin its current files and make it the site the assistant hands off to.
   *
   * :param url: A network URL.
   * :return: {ok: true, admitted} or {ok: false, reason}.
   */
  letIn(url) {
    const check = this.checkLetIn(url);
    if (!check.ok) {
      return check;
    }
    const record = this.gate.admit(check.passport, this.now());
    this.changed();
    return { ok: true, admitted: this.gateEntry(record), current: record.url };
  }

  /**
   * Choose which admitted site the assistant hands off to. Reversible on the page.
   *
   * :param url: An admitted network URL.
   * :return: The gate, or {ok: false, reason}.
   */
  useAdmitted(url) {
    const parsed = parseNetworkUrl(url);
    if (!parsed.ok || !this.gate.setCurrent(parsed.url)) {
      return { ok: false, reason: "That site is not on your gate. Let it in first." };
    }
    this.changed();
    return this.getGate();
  }

  /**
   * Take a site off the gate.
   *
   * :param url: A network URL.
   * :return: The gate, or {ok: false, reason}.
   */
  removeFromGate(url) {
    const parsed = parseNetworkUrl(url);
    if (!parsed.ok || !this.gate.remove(parsed.url)) {
      return { ok: false, reason: "That site is not on your gate." };
    }
    this.changed();
    return this.getGate();
  }

  gateEntry(record) {
    return {
      url: record.url,
      title: record.brand,
      verdict: record.verdict,
      fingerprint: `sha256:${record.fingerprint}`,
      admittedAt: record.admittedAt,
      current: this.gate.state.current === record.url,
      changesSeen: (record.changes || []).length,
    };
  }

  /**
   * The visitor's gate. Read-only.
   *
   * :return: {current, admitted: [...], lastHandOff: why the last hand-off went as it did}.
   */
  getGate() {
    const admitted = this.gate.list().map((record) => this.gateEntry(record));
    return { current: this.gate.state.current, admitted, lastHandOff: this.lastHandOff };
  }

  /**
   * Before a hand-off: check the current site again and compare it with its pin.
   *
   * :return: {status: "none" | "same" | "changed" | "blocked" | "unreachable", record,
   *   passport, changes}.
   */
  async verifyCurrent() {
    const record = this.gate.current();
    if (!record) {
      return { status: "none" };
    }
    const passport = await checkSite(record.url, { env: this.env, fetchImpl: this.fetchImpl, now: this.now() });
    this.live.set(record.url, passport);
    this.changed();
    if (passport.verdict === "blocked") {
      return { status: "blocked", record, passport, changes: describeChanges(record.pin, passport.pin) };
    }
    if (!passport.loadable || !passport.fingerprint) {
      return { status: "unreachable", record, passport, changes: [] };
    }
    if (passport.fingerprint === record.fingerprint) {
      return { status: "same", record, passport, changes: [] };
    }
    return { status: "changed", record, passport, changes: describeChanges(record.pin, passport.pin) };
  }

  /**
   * Record the visitor's answer to a changed site.
   *
   * :param result: From verifyCurrent, with status "changed".
   * :param accepted: True when the visitor lets the new version in.
   */
  answerChange(result, accepted) {
    this.gate.recordChange(result.record.url, {
      at: this.now(),
      changes: result.changes,
      fingerprint: result.passport.fingerprint,
      accepted,
    }, result.passport);
    this.changed();
  }

  /**
   * Counts for the page header.
   */
  stats() {
    const records = this.records();
    return {
      total: records.length,
      loadable: records.filter((r) => r.passport.loadable && r.passport.verdict !== "blocked").length,
      notLoadable: records.filter((r) => !r.passport.loadable).length,
      blocked: records.filter((r) => r.passport.verdict === "blocked").length,
      generatedAt: this.directory.generatedAt,
    };
  }
}
