// Gatehouse page: loads the directory, draws passports and wires the page's own forms
// and buttons to the page object in app.js. All text goes in through textContent.

import { Gatehouse } from "./app.js";

const VERDICT_LABEL = { pass: "Passes", warn: "Passes, with notes", fail: "Not loadable", blocked: "Blocked" };
const STATUS_LABEL = { pass: "Pass", warn: "Note", fail: "Fail", skip: "Not tested" };

/**
 * Make an element.
 *
 * :param tag: The tag name, with optional classes as "tag.class1.class2".
 * :param attrs: Attributes; "text" sets textContent.
 * :param children: Child nodes or strings.
 * :return: The element.
 */
export function el(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split(".");
  const node = document.createElement(name);
  if (classes.length) {
    node.className = classes.join(" ");
  }
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Format an ISO time for people.
 */
function when(iso) {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function shortPrint(fingerprint) {
  const hex = String(fingerprint || "").replace(/^sha256:/, "");
  return hex ? `${hex.slice(0, 12)}…${hex.slice(-6)}` : "none";
}

/**
 * Draw a verdict stamp.
 */
function stamp(verdict) {
  return el(`span.stamp.stamp-${verdict}`, { text: VERDICT_LABEL[verdict] || verdict });
}

/**
 * Draw one passport.
 *
 * :param house: The Gatehouse page object.
 * :param url: The network URL.
 * :param options: {open: show checks expanded}.
 * :return: An article element.
 */
export function passportCard(house, url, { open = false } = {}) {
  const info = house.getPassport(url);
  if (!info.ok) {
    return el("article.passport", {}, el("p", { text: info.reason }));
  }
  const p = info.passport;
  const card = el(`article.passport.passport-${p.verdict}`, { "data-url": p.url });
  const head = el("header.passport-head", {},
    el("div", {},
      el("h3", { text: p.title || p.url }),
      el("p.passport-url", {}, el("code", { text: p.url }))),
    stamp(p.verdict));
  const summary = el("p.passport-summary", { text: p.summary });
  const meta = el("dl.passport-meta", {},
    el("dt", { text: "Fingerprint" }), el("dd", {}, el("code", { title: p.fingerprint || "", text: shortPrint(p.fingerprint) })),
    el("dt", { text: "Checked" }), el("dd", { text: `${when(p.checkedAt)}${p.checkedHere ? " (on this page)" : " (nightly)"}` }),
    el("dt", { text: "Agents" }), el("dd", { text: p.agents?.length ? p.agents.map((a) => a.name).join(", ") : "unknown" }),
    info.lastChanged ? el("dt", { text: "Files last changed" }) : null,
    info.lastChanged ? el("dd", { text: when(info.lastChanged) }) : null,
    el("dt", { text: "Found in" }), el("dd", { text: info.sources.join(", ") || "this page" }));
  if (p.description) {
    card.append(head, el("p.passport-desc", { text: p.description }), summary, meta);
  } else {
    card.append(head, summary, meta);
  }
  const checks = el("details.passport-checks", { open: open || null },
    el("summary", { text: `${p.checks.filter((c) => c.status === "pass").length} of ${p.checks.length} checks pass` }),
    el("ul", {}, p.checks.map((check) => el(`li.check.check-${check.status}`, {},
      el("span.check-mark", { "aria-label": STATUS_LABEL[check.status], text: { pass: "✓", warn: "!", fail: "✕", skip: "–" }[check.status] }),
      el("span", {}, el("strong", { text: `${check.title}. ` }), check.detail, check.spec ? el("span.spec-ref", { text: ` §${check.spec}` }) : null)))));
  card.append(checks);
  const findings = p.risk?.findings || [];
  if (findings.length) {
    card.append(el("details.passport-risk", { open: p.risk.level === "high" || null },
      el("summary", { text: `Instruction scan: ${p.risk.level === "none" ? "nothing serious" : `${p.risk.level} risk`} (${findings.length} note${findings.length === 1 ? "" : "s"})` }),
      el("ul", {}, findings.map((f) => el(`li.risk.risk-${f.severity}`, {},
        el("strong", { text: `${f.message} ` }),
        el("span.risk-where", { text: f.where }),
        el("q", { text: f.excerpt }))))));
  } else if (p.loadable) {
    card.append(el("p.passport-clean", { text: "Instruction scan: nothing found." }));
  }
  const actions = el("div.passport-actions");
  const letIn = house.checkLetIn(p.url);
  if (info.admitted) {
    actions.append(el("span.admitted-note", { text: "On your gate" }));
  } else if (letIn.ok) {
    actions.append(el("button.primary", { type: "button", "data-action": "let-in", "data-url": p.url, text: "Let it in" }));
  }
  actions.append(el("button", { type: "button", "data-action": "recheck", "data-url": p.url, text: "Check again now" }));
  actions.append(el("button", { type: "button", "data-action": "copy", "data-url": p.url, text: "Copy network URL" }));
  card.append(actions);
  return card;
}

/**
 * The page's own controller: forms, buttons and redraws.
 */
export class PageView {
  constructor(house) {
    this.house = house;
    this.query = "";
    this.verdict = "any";
  }

  /**
   * Load the directory and draw the page.
   */
  async start() {
    const local = ["localhost", "127.0.0.1"].includes(location.hostname);
    const urls = local ? ["data/directory.local.json", "data/directory.json"] : ["data/directory.json"];
    for (const url of urls) {
      try {
        const resp = await fetch(url, { cache: "no-store" });
        if (resp.ok) {
          this.house.useDirectory(await resp.json());
          break;
        }
      } catch {
        // Try the next file.
      }
    }
    this.house.onChange(() => this.render());
    this.wire();
    this.render();
  }

  wire() {
    document.querySelector("#check-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.querySelector("#check-url");
      this.runCheck(input.value);
    });
    document.querySelector("#search-form")?.addEventListener("submit", (event) => event.preventDefault());
    document.querySelector("#search-q")?.addEventListener("input", (event) => {
      this.query = event.target.value;
      this.renderDirectory();
    });
    for (const chip of document.querySelectorAll("[data-verdict]")) {
      chip.addEventListener("click", () => {
        this.verdict = chip.dataset.verdict;
        for (const other of document.querySelectorAll("[data-verdict]")) {
          other.setAttribute("aria-pressed", String(other === chip));
        }
        this.renderDirectory();
      });
    }
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("button[data-action]");
      if (!button) return;
      const url = button.dataset.url;
      if (button.dataset.action === "let-in") this.letIn(url);
      else if (button.dataset.action === "recheck") this.runCheck(url);
      else if (button.dataset.action === "copy") navigator.clipboard?.writeText(url).then(() => { button.textContent = "Copied"; });
      else if (button.dataset.action === "use") this.house.useAdmitted(url);
      else if (button.dataset.action === "remove") this.house.removeFromGate(url);
    });
  }

  /**
   * The page's "Check" button. Pressing it is the visitor's request to contact that origin.
   */
  async runCheck(url) {
    const out = document.querySelector("#check-result");
    const status = document.querySelector("#check-status");
    const input = document.querySelector("#check-url");
    if (input && input.value !== url) input.value = url;
    status.textContent = `Reading the public agent files at ${(() => { try { return new URL(url).host; } catch { return url; } })()}…`;
    const result = await this.house.checkNow(url);
    if (!result.ok) {
      status.textContent = result.reason;
      input?.setCustomValidity(result.reason);
      input?.reportValidity();
      input?.setCustomValidity("");
      return;
    }
    status.textContent = `Checked ${result.passport.title}.`;
    out.replaceChildren(passportCard(this.house, result.passport.url, { open: true }));
  }

  /**
   * The page's "Let it in" button. The page shows the same confirmation dialog the
   * assistant's let_in action gets.
   */
  async letIn(url) {
    const mount = (await import("./site.js")).AssistantMount;
    const confirmed = await mount.confirmLetIn(url);
    if (confirmed) {
      const result = this.house.letIn(url);
      document.querySelector("#gate-status").textContent = result.ok
        ? `${result.admitted.title} is on your gate. The assistant can now hand off to it.`
        : result.reason;
    }
  }

  render() {
    this.renderStats();
    this.renderDirectory();
    this.renderGate();
    const shown = document.querySelector("#check-result .passport");
    if (shown) {
      shown.replaceWith(passportCard(this.house, shown.dataset.url, { open: true }));
    }
  }

  renderStats() {
    const stats = this.house.stats();
    const box = document.querySelector("#stats");
    if (!box) return;
    box.replaceChildren(
      el("div.stat", {}, el("strong", { text: String(stats.total) }), el("span", { text: "sites checked" })),
      el("div.stat.stat-pass", {}, el("strong", { text: String(stats.loadable) }), el("span", { text: "can be let in" })),
      el("div.stat.stat-fail", {}, el("strong", { text: String(stats.notLoadable) }), el("span", { text: "not loadable" })),
      el("div.stat.stat-blocked", {}, el("strong", { text: String(stats.blocked) }), el("span", { text: "blocked" })),
    );
    const crawl = document.querySelector("#crawl-time");
    if (crawl) crawl.textContent = stats.generatedAt ? when(stats.generatedAt) : "not yet";
  }

  renderDirectory() {
    const list = document.querySelector("#directory-list");
    if (!list) return;
    const { results, total } = this.house.search({ query: this.query, verdict: this.verdict, limit: 20 });
    document.querySelector("#directory-count").textContent = `${total} site${total === 1 ? "" : "s"}`;
    list.replaceChildren(...(results.length
      ? results.map((r) => el("li", {}, passportCard(this.house, r.url)))
      : [el("li.empty", { text: "No site matches. Check a site by its network URL above." })]));
  }

  renderGate() {
    const box = document.querySelector("#gate-list");
    if (!box) return;
    const gate = this.house.getGate();
    if (!gate.admitted.length) {
      box.replaceChildren(el("p.empty", { text: "Nothing let in yet. Let a site in from its passport, and the assistant can hand questions to it." }));
      return;
    }
    box.replaceChildren(el("ul.gate", {}, gate.admitted.map((entry) => el(`li.gate-entry${entry.current ? ".gate-current" : ""}`, {},
      el("div", {},
        el("strong", { text: entry.title }),
        entry.current ? el("span.badge", { text: "Assistant hands off here" }) : null,
        el("p", {}, el("code", { text: entry.url })),
        el("p.gate-pin", { text: `Pinned to ${shortPrint(entry.fingerprint)} on ${when(entry.admittedAt)}${entry.changesSeen ? ` · ${entry.changesSeen} change(s) seen since` : ""}` })),
      el("div.gate-actions", {},
        entry.current ? null : el("button", { type: "button", "data-action": "use", "data-url": entry.url, text: "Hand off here" }),
        el("button", { type: "button", "data-action": "recheck", "data-url": entry.url, text: "Check again now" }),
        el("button", { type: "button", "data-action": "remove", "data-url": entry.url, text: "Take off the gate" }))))));
  }
}

if (typeof window !== "undefined") {
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  Gatehouse.page = new Gatehouse({ storage, env: "browser" });
  const view = new PageView(Gatehouse.page);
  window.__gatehouse = { house: Gatehouse.page, view };
  await view.start();
}
