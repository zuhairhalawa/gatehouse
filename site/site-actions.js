// Registers Gatehouse's operations with the agent runtime. agent-manifest.json loads
// this module through "actions.module"; each name in "actions.agentTools" becomes a
// website_<name> tool. Every action wraps a method of the page object in app.js, the
// same one the page's own buttons call.
import { Gatehouse } from "./app.js";

const URL_FIELD = {
  type: "string",
  minLength: 8,
  maxLength: 500,
  description: "A network URL: the site base, then the network name, such as https://site.example/my_network. Use one from website_search_directory or from the visitor.",
};

/**
 * Describes Gatehouse's operations as actions the agents can call.
 */
class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register({
      name: "search_directory",
      description: "Search Gatehouse's directory of agentic websites by topic or name. Returns up to 8 sites with their verdict (pass, warn, fail or blocked), whether they can be let in, a one-line summary, description and sample questions. Changes nothing.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", maxLength: 200, description: "Words about what the visitor needs, such as \"ferry times\". Leave empty to list every site." },
          verdict: { type: "string", enum: ["any", "loadable", "not_loadable", "blocked"], description: "Filter by verdict. Default any." },
        },
      },
      execute: (args) => SiteActions.page().search({ query: args.query || "", verdict: args.verdict || "any" }),
    });
    actions.register({
      name: "get_passport",
      description: "Read one site's full passport: each spec check with its result, the instruction scan findings, its agents, fingerprint and when its files last changed. Changes nothing and contacts no site.",
      effect: "read",
      inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: URL_FIELD } },
      execute: (args) => SiteActions.page().getPassport(args.url),
    });
    actions.register({
      name: "check_site",
      description: "Check a site now by reading its public agent files from its own origin. The browser asks the visitor first, because it contacts that site. Sends nothing about the visitor. Returns the fresh passport, or ok false with a reason.",
      effect: "irreversible",
      inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: URL_FIELD } },
      execute: (args) => SiteActions.page().checkNow(args.url),
    });
    actions.register({
      name: "let_in",
      description: "Let a site in: pin the fingerprint of its current files in this browser and make it the site that gate_peer hands off to. The browser asks the visitor first. Refuses blocked sites and sites that cannot be loaded. Returns the gate entry, or ok false with a reason.",
      effect: "irreversible",
      inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: URL_FIELD } },
      execute: (args) => SiteActions.page().letIn(args.url),
    });
    actions.register({
      name: "get_gate",
      description: "Read the visitor's gate: the sites they let in, each pinned fingerprint, and which one gate_peer hands off to. Changes nothing.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => SiteActions.page().getGate(),
    });
    actions.register({
      name: "use_admitted",
      description: "Choose which site already on the gate gate_peer hands off to. Only for sites already let in. Returns the gate, or ok false with a reason.",
      effect: "write",
      inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: URL_FIELD } },
      execute: (args) => SiteActions.page().useAdmitted(args.url),
    });
  }

  /**
   * The page object, which view.js creates when the page loads.
   *
   * :return: The Gatehouse page object.
   * :raises Error: When the page has not started, so the runtime reports "unknown".
   */
  static page() {
    if (!Gatehouse.page) {
      throw new Error("The Gatehouse page has not started.");
    }
    return Gatehouse.page;
  }
}

export const registerActions = SiteActions.registerActions;
