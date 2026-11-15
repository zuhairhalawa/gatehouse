// Mounts the assistant inside the Gatehouse page (from the agentify-website template's
// site.js), and adds three things the template does not have:
//   1. The hand-off. The network's gate_peer link slot resolves to the site the visitor
//      let in, never to a URL the model or a peer chooses. Before each hand-off the
//      site's files are read again and compared with the pinned fingerprint. A changed
//      site is not loaded until the visitor sees what changed and lets the new version in.
//   2. The consent card names the site the visitor let in, not the slot.
//   3. The evidence panel: what the runtime's own trace shows about the router, the
//      contacted origins and the private fields a peer received.
import { Gatehouse } from "./app.js";
import { agentHashes, parseNetworkUrl, sameAgents } from "./lib/passport.js";

const GATE_SLOT = "gate_peer";

/**
 * Boots the browser runtime in the page's assistant section.
 */
export class AssistantMount {
  /**
   * The first chat message once the visitor has a key: what the assistant can do here.
   */
  static GREETING = "I can find agentic websites for you, explain their passports, check a site, and, once you let one in, hand your question to it. Ask, for example: find me a site that knows ferry times.";

  /**
   * The confirmation dialog's words for each irreversible action.
   */
  static DIALOGS = {
    check_site: {
      title: "Read this site's agent files?",
      sentence: "Gatehouse will fetch the public agent files from the site below to check them. Nothing about you is sent.",
      confirm: "Check the site",
      decline: "Don't contact it",
    },
    let_in: {
      title: "Let this site in?",
      sentence: "The assistant may then hand your questions to this site's agents. They run here, in your browser, on your model and key. Gatehouse pins the version below and asks again if it changes.",
      confirm: "Let it in",
      decline: "Keep it out",
    },
  };

  static engine = null;
  static lastHandOff = null;

  /**
   * Boot the runtime and report the result in the status line.
   *
   * :return: The runtime engine, or null when boot failed.
   */
  static async start() {
    const status = document.querySelector("#assistant-status");
    const siteBase = new URL("./", import.meta.url).href;
    try {
      const { boot } = await import("./runtime/index.js");
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
      });
      const engine = booted.engine;
      AssistantMount.engine = engine;
      AssistantMount.defaultReview = engine.onActionConfirm;
      engine.onActionConfirm = AssistantMount.review;
      AssistantMount.defaultConsent = engine.onConsent;
      engine.onConsent = AssistantMount.consent;
      AssistantMount.installGate(engine);
      Evidence.attach(engine, booted.trace);
      const needsKey = !engine.mockLLM && (!engine.byokKey || engine.byokKey === "demo");
      status.textContent = needsKey
        ? "The assistant needs your AI provider key. Add it in AI model settings below. The directory and checks above work without one."
        : "Assistant connected to this page.";
      if (!needsKey) {
        AssistantMount.greet();
      }
      return engine;
    } catch (error) {
      status.textContent = "The assistant could not load. You can still use the directory and checks directly.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  /**
   * Make the gate_peer slot resolve only through the gate.
   *
   * The runtime keeps a link binding in the network and in localStorage after the first
   * use. Gatehouse clears it before each resolution of its own slot, so every hand-off
   * goes through onLinkRequired, which reads the gate and checks the pin.
   *
   * :param engine: The runtime engine.
   */
  static installGate(engine) {
    const resolve = engine.resolveLink.bind(engine);
    engine.resolveLink = async (reference, network, base, parentSpan) => {
      if (reference === GATE_SLOT && base === engine.top?.base) {
        delete network.links[GATE_SLOT];
        try {
          localStorage.removeItem(engine._linkKey(base, network.name, GATE_SLOT));
        } catch {
          // Storage may be blocked; the binding in the network is cleared either way.
        }
      }
      return resolve(reference, network, base, parentSpan);
    };
    AssistantMount.defaultLinkRequired = engine.onLinkRequired;
    engine.onLinkRequired = AssistantMount.linkRequired;
    // The runtime fetches and compiles the peer itself and caches it for the page. For
    // the site on the gate, drop the cache so each hand-off loads it fresh, then check
    // that the agents it compiled are the ones the visitor approved. If they differ,
    // fail closed: the runtime reports the error and runs nothing from that site.
    const resolveRemote = engine.resolveRemote.bind(engine);
    engine.resolveRemote = async (ref, chain, parentSpan, sourceManifest) => {
      const record = Gatehouse.page?.gate.current();
      const target = parseNetworkUrl(new URL(ref, `${engine.top.base}/`).href);
      const isGate = Boolean(record && target.ok && target.url === record.url);
      if (isGate) {
        engine.registry.cache.delete(engine.registry.cacheKey(target.base, target.name));
      }
      const session = await resolveRemote(ref, chain, parentSpan, sourceManifest);
      if (isGate) {
        const loaded = await agentHashes(session.network, target.name);
        if (!sameAgents(loaded, record.pin?.agents)) {
          engine.registry.cache.delete(engine.registry.cacheKey(target.base, target.name));
          AssistantMount.noteHandOff("mismatch", `${record.brand} served different agents to the runtime than the version you let in, so nothing from it ran.`);
          throw new Error(`Gatehouse: ${record.brand} served agents that do not match the pinned version. Nothing from it ran.`);
        }
        Evidence.add("gate", `The agents that loaded from ${record.brand} match the pinned version.`);
      }
      return session;
    };
  }

  /**
   * Resolve a link slot. Only Gatehouse's own gate_peer slot resolves, and only to the
   * site on the visitor's gate whose files still match its pin.
   *
   * :param info: {reference, sourceNetwork, sourceOrigin}.
   * :return: The admitted network URL, or null so the runtime continues without it.
   */
  static async linkRequired(info) {
    const engine = AssistantMount.engine;
    if (info.reference !== GATE_SLOT || info.sourceOrigin !== engine.top?.base) {
      AssistantMount.noteHandOff("refused", `A network asked for a link named "${info.reference}". Gatehouse only hands off to sites on your gate.`);
      return null;
    }
    const house = Gatehouse.page;
    const result = await house.verifyCurrent();
    if (result.status === "none") {
      AssistantMount.noteHandOff("none", "No site is on the gate yet. Let a site in first.");
      return null;
    }
    const name = result.record.brand;
    if (result.status === "unreachable") {
      AssistantMount.noteHandOff("unreachable", `${name} could not be loaded just now: ${result.passport.summary}`);
      return null;
    }
    if (result.status === "blocked") {
      house.answerChange(result, false);
      AssistantMount.noteHandOff("blocked", `${name} changed, and its new instructions are blocked: ${result.passport.summary}`);
      return null;
    }
    if (result.status === "changed") {
      const accepted = await new Promise(AssistantMount.openChangeDialog.bind(null, result));
      house.answerChange(result, accepted);
      AssistantMount.keepFocusInChat();
      if (!accepted) {
        AssistantMount.noteHandOff("kept_out", `${name} changed since you let it in, and you kept the new version out.`);
        return null;
      }
    }
    AssistantMount.noteHandOff("handed_off", `Handed off to ${name}, pinned version ${result.passport.fingerprint.slice(0, 12)}.`);
    return result.record.url;
  }

  /**
   * Remember the last hand-off result, so website_get_gate can tell the agent why.
   */
  static noteHandOff(status, reason) {
    AssistantMount.lastHandOff = { status, reason, at: new Date().toISOString() };
    if (Gatehouse.page) {
      Gatehouse.page.lastHandOff = AssistantMount.lastHandOff;
    }
    Evidence.add("gate", reason);
  }

  /**
   * Replace the runtime's general first chat message with GREETING.
   */
  static greet() {
    const first = document.querySelector("#ns-msgs .ns-msg.bot");
    if (first) {
      first.textContent = AssistantMount.GREETING;
    }
  }

  /**
   * Ask the visitor to confirm actions before they run (from the template).
   *
   * :param items: The actions waiting for confirmation.
   * :return: True when the visitor confirms.
   */
  static async review(items) {
    let confirmed = false;
    const pageOrigin = new URL(document.URL).origin;
    if (items.length > 1) {
      for (const item of items) {
        if (item.origin === pageOrigin && Object.hasOwn(AssistantMount.DIALOGS, item.action)) {
          throw new Error(`Nothing ran. "${AssistantMount.DIALOGS[item.action].confirm}" needs its own confirmation, so ask the assistant to do that on its own.`);
        }
      }
    }
    const own = items.length === 1 && items[0].origin === pageOrigin;
    if (own && Object.hasOwn(AssistantMount.DIALOGS, items[0].action)) {
      const content = AssistantMount.dialogContent(items[0]);
      if (content.refusal) {
        throw new Error(content.refusal);
      }
      confirmed = await new Promise(AssistantMount.openDialog.bind(null, content));
    } else {
      confirmed = await AssistantMount.defaultReview(items);
    }
    AssistantMount.keepFocusInChat();
    return confirmed;
  }

  /**
   * The page's own "Let it in" button gets the same dialog as the let_in action.
   *
   * :param url: The network URL.
   * :return: True when the visitor confirms.
   */
  static async confirmLetIn(url) {
    const content = AssistantMount.dialogContent({ action: "let_in", origin: location.origin, effect: "irreversible", arguments: { url } });
    if (content.refusal) {
      document.querySelector("#gate-status").textContent = content.refusal;
      return false;
    }
    return new Promise(AssistantMount.openDialog.bind(null, content));
  }

  /**
   * Show the runtime's consent card, named after the site on the gate.
   *
   * :param info: What the card shows.
   * :return: "allow", "always" or "decline".
   */
  static async consent(info) {
    const shown = { ...info };
    const current = Gatehouse.page?.gate.current();
    if (current && info.peerLabel === GATE_SLOT) {
      shown.peerLabel = `${current.brand} (on your gate)`;
    }
    const answer = AssistantMount.defaultConsent(shown);
    AssistantMount.focusConsentCard();
    const decision = await answer;
    Evidence.add("consent", `${shown.peerLabel || info.peerOrigin} at ${info.peerOrigin}: ${decision === "decline" ? "you declined; nothing was sent" : `you chose ${decision}`}.`);
    AssistantMount.keepFocusInChat();
    return decision;
  }

  /**
   * Name the newest consent card after its title and move focus to it (from the template).
   */
  static focusConsentCard() {
    if (typeof document === "undefined") {
      return;
    }
    const cards = document.querySelectorAll("#ns-msgs .ns-consent");
    const card = cards[cards.length - 1];
    const title = card ? card.querySelector(".ns-consent-title") : null;
    if (!title) {
      return;
    }
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", title.textContent);
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest("#agent-app")) {
      return;
    }
    title.tabIndex = -1;
    title.focus();
  }

  /**
   * Work out what the dialog says for one action (from the template).
   */
  static dialogContent(item) {
    let details = {};
    try {
      details = AssistantMount.reviewDetails(item.action, item.arguments) || {};
    } catch (error) {
      console.error("Could not add details to the confirmation dialog", error);
    }
    return {
      ...AssistantMount.DIALOGS[item.action],
      details: details,
      refusal: details.refusal,
      exact: `${item.action} on ${item.origin} (${item.effect})\n${JSON.stringify(item.arguments, null, 2)}`,
    };
  }

  /**
   * The readable details of one irreversible action, from the page's own checks.
   *
   * :param action: The action name.
   * :param args: The action's arguments.
   * :return: Details by label, {refusal: reason}, or {}.
   */
  static reviewDetails(action, args) {
    if (action === "check_site") {
      const parsed = parseNetworkUrl(args.url);
      if (!parsed.ok) {
        return { refusal: parsed.reason };
      }
      return {
        "Site contacted": parsed.origin,
        "Network": parsed.name,
        "Files read": "agent-manifest.json, the network file it names, links.json",
        "Sent about you": "Nothing. No key, cookie or chat text.",
      };
    }
    if (action === "let_in") {
      const check = Gatehouse.page.checkLetIn(args.url);
      if (!check.ok) {
        return { refusal: check.reason };
      }
      const p = check.passport;
      const findings = p.risk?.findings || [];
      return {
        "Site": `${p.brand || p.name} (${p.origin})`,
        "Network": p.url,
        "Passport": `${p.verdict === "pass" ? "Passes" : "Passes, with notes"}: ${p.summary}`,
        "Instruction scan": findings.filter((f) => f.severity !== "low").length
          ? findings.filter((f) => f.severity !== "low").map((f) => f.message).join(" ")
          : "Nothing serious found.",
        "Pinned version": `sha256:${p.fingerprint}`,
        "Checked": new Date(p.checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
        "Its agents get": "Only the request text the assistant writes. Not your chat, your key or private fields.",
      };
    }
    return {};
  }

  /**
   * Open the confirmation dialog (from the template).
   */
  static openDialog(content, resolve) {
    const dialog = document.createElement("dialog");
    dialog.className = "assistant-review";
    dialog.setAttribute("aria-labelledby", "assistant-review-title");
    const heading = document.createElement("h2");
    heading.id = "assistant-review-title";
    heading.textContent = content.title;
    heading.tabIndex = -1;
    heading.autofocus = true;
    const sentence = document.createElement("p");
    sentence.textContent = content.sentence;
    dialog.append(heading, sentence);
    const exact = document.createElement("details");
    const exactLabel = document.createElement("summary");
    exactLabel.textContent = "Technical details";
    const exactText = document.createElement("pre");
    exactText.textContent = content.exact;
    exact.append(exactLabel, exactText);
    const entries = Object.entries(content.details);
    if (entries.length) {
      const list = document.createElement("dl");
      for (const [label, value] of entries) {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.textContent = Array.isArray(value) ? value.join("\n") : String(value);
        list.append(term, description);
      }
      dialog.append(list);
    } else {
      exact.open = true;
    }
    const confirmButton = document.createElement("button");
    confirmButton.textContent = content.confirm;
    confirmButton.addEventListener("click", dialog.close.bind(dialog, "confirm"));
    const declineButton = document.createElement("button");
    declineButton.className = "assistant-decline";
    declineButton.textContent = content.decline;
    declineButton.addEventListener("click", dialog.close.bind(dialog, "decline"));
    dialog.addEventListener("close", AssistantMount.finishDialog.bind(null, dialog, resolve));
    dialog.append(exact, confirmButton, declineButton);
    document.body.append(dialog);
    dialog.showModal();
  }

  /**
   * Ask the visitor about a site that changed since they let it in.
   *
   * :param result: From Gatehouse.verifyCurrent, with status "changed".
   * :param resolve: Receives true when the visitor lets the new version in.
   */
  static openChangeDialog(result, resolve) {
    const p = result.passport;
    const findings = (p.risk?.findings || []).filter((f) => f.severity !== "low");
    AssistantMount.openDialog({
      title: `${result.record.brand} changed. Let the new version in?`,
      sentence: "Its agent files are not the ones you let in. Read what changed before its agents get your question.",
      details: {
        "What changed": result.changes,
        "Passport now": `${p.verdict}: ${p.summary}`,
        "Instruction scan now": findings.length ? findings.map((f) => `${f.message} "${f.excerpt}"`).join("\n") : "Nothing serious found.",
        "Pinned version": `sha256:${result.record.fingerprint}`,
        "Version now": `sha256:${p.fingerprint}`,
      },
      confirm: "Let the new version in",
      decline: "Keep it out",
      exact: `gate_peer hand-off to ${result.record.url}`,
    }, resolve);
  }

  static finishDialog(dialog, resolve) {
    dialog.remove();
    resolve(dialog.returnValue === "confirm");
  }

  static keepFocusInChat() {
    if (typeof document === "undefined") {
      return;
    }
    if (document.activeElement === document.body || document.activeElement === null) {
      document.querySelector("#ns-input")?.focus();
    }
  }
}

/**
 * The evidence panel: a plain log of what the runtime's trace shows during the visit.
 */
export class Evidence {
  static list = null;

  /**
   * Listen to the runtime's trace.
   *
   * :param engine: The runtime engine.
   * :param trace: Its TraceBus.
   */
  static attach(engine, trace) {
    Evidence.list = document.querySelector("#evidence-list");
    if (!trace || !Evidence.list) {
      return;
    }
    Evidence.list.replaceChildren();
    const router = engine.userRouter?.baseUrl || engine.top?.manifest?.llm_router?.base_url || "none";
    Evidence.add("router", `Model calls go to ${router}${engine.byokKey && engine.byokKey !== "demo" ? ", with your key from this browser" : ""}.`);
    trace.addEventListener("event", (event) => Evidence.fromTrace(event.detail, engine));
  }

  /**
   * Turn one trace event into a line, when it is evidence for a spec check.
   *
   * :param ev: The trace event.
   * :param engine: The runtime engine.
   */
  static fromTrace(ev, engine) {
    const topHost = (() => { try { return new URL(engine.top.base).host; } catch { return ""; } })();
    if (ev.kind === "model_call" && ev.phase === "start") {
      const peer = ev.origin && ev.origin !== topHost;
      Evidence.add(peer ? "peer-model" : "model", `${peer ? `Agent from ${ev.origin}` : "Gatehouse agent"} called ${ev.model} on ${ev.routerHost}${peer ? ", your router, not the peer's" : ""}. Key: ${ev.keySource}.`);
    } else if (ev.kind === "remote_fetch" && ev.phase === "start") {
      Evidence.add("contact", `Fetched ${ev.peerOrigin}'s public agent files to run them here.`);
    } else if (ev.kind === "remote_call" && ev.phase === "start") {
      const keys = Object.keys(ev.requestPayload?.sly_data || {});
      Evidence.add("private", `Ran ${ev.network} from ${ev.peerOrigin} in this browser. Private fields passed to it: ${keys.length ? keys.join(", ") : "none"}. This page holds a private field (backend_token) that stays here.`);
    } else if (ev.kind === "remote_call" && ev.phase === "end" && ev.status === "error") {
      Evidence.add("error", `The peer failed: ${ev.error}`);
    } else if (ev.kind === "composition_limit" || ev.kind === "composition_skip") {
      Evidence.add("limit", `Stopped a call to ${ev.target}: ${ev.reason}.`);
    } else if (ev.kind === "consent" && ev.decision === "declined") {
      Evidence.add("consent", `You declined contact with ${ev.peerOrigin}. Nothing was sent.`);
    } else if (ev.kind === "compile" && ev.phase === "end" && ev.status === "error") {
      Evidence.add("error", `Refused a network: ${ev.error}`);
    } else if (ev.kind === "tool" && ev.phase === "end" && ev.status === "error") {
      Evidence.add("error", `${ev.tool || "A tool"} failed: ${ev.error}`);
    }
  }

  /**
   * Add one line to the panel.
   *
   * :param kind: A short tag for styling.
   * :param text: The line.
   */
  static add(kind, text) {
    if (!Evidence.list) {
      return;
    }
    const item = document.createElement("li");
    item.className = `evidence-${kind}`;
    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    item.append(time, document.createTextNode(` ${text}`));
    Evidence.list.prepend(item);
    while (Evidence.list.children.length > 60) {
      Evidence.list.lastElementChild.remove();
    }
  }
}

// Boot only in a browser. Node tests import this file to check the dialog's words.
if (typeof window !== "undefined") {
  await AssistantMount.start();
}
