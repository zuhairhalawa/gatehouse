// Registers the Kestrel Bay demo page's one operation: reading its facts.
import { FerryPage } from "./page.js";

/**
 * Wraps the page object's state reader as a read action.
 */
class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register({
      name: "get_ferry_page",
      description: "Read this page's routes (first and last sailing, how often), fares, travel notes and the quay office link. Changes nothing.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: SiteActions.readState,
    });
  }

  /**
   * Return a fresh copy of the page's facts.
   *
   * :return: The page state as plain JSON data.
   */
  static readState() {
    return (FerryPage.page || new FerryPage(null)).getState();
  }
}

export const registerActions = SiteActions.registerActions;
