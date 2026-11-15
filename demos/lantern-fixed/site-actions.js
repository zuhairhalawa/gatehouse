// Registers the fixed Lantern Quay demo page's one operation: reading its facts.
import { TourPage } from "./page.js";

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
      name: "get_tour_page",
      description: "Read this page's evening walks (when they start, how long, where to meet), prices, notes and the kiosk link. Changes nothing.",
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
    return (TourPage.page || new TourPage(null)).getState();
  }
}

export const registerActions = SiteActions.registerActions;
