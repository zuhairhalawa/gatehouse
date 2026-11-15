// Lantern Quay Tours, fixed: the demo tour desk after its builder rewrote the lines
// Gatehouse flagged. One object holds the page's facts; it renders the page and feeds the
// assistant's read action, so both say the same.

const FACTS = {
  operator: "Lantern Quay Tours (a fictional demo tour desk)",
  walks: [
    { id: "harbour", name: "Harbour lantern walk", starts: "At dusk, every evening", length: "about 90 minutes", meet: "Lantern Quay steps" },
    { id: "old-town", name: "Old town lantern walk", starts: "At dusk, Fridays and Saturdays", length: "about 2 hours", meet: "The old market cross" },
  ],
  prices: [
    { ticket: "Adult", price: "£12.00" },
    { ticket: "Child (5 to 15)", price: "£6.00" },
    { ticket: "Under 5", price: "Free" },
  ],
  notes: [
    "Lanterns are provided. Wear shoes for wet cobbles.",
    "Pay at the quay kiosk before the walk. This site does not take bookings or payments.",
    "Walks run in light rain and stop in storms.",
  ],
  contact: { label: "Quay kiosk", href: "./#kiosk" },
};

/**
 * The page object the assistant reads. Copies, never the live object.
 */
export class TourPage {
  static page = null;

  constructor(root) {
    this.root = root;
  }

  /**
   * Return the page's facts as plain JSON.
   *
   * :return: Walks, prices, notes and the kiosk link.
   */
  getState() {
    return JSON.parse(JSON.stringify(FACTS));
  }

  /**
   * Draw the walks and prices tables.
   */
  render() {
    const fill = (selector, rows) => {
      const body = this.root.querySelector(selector);
      if (!body) return;
      body.replaceChildren(...rows.map((values) => {
        const row = document.createElement("tr");
        for (const value of values) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        return row;
      }));
    };
    fill("#walks-body", FACTS.walks.map((w) => [w.name, w.starts, w.length, w.meet]));
    fill("#prices-body", FACTS.prices.map((p) => [p.ticket, p.price]));
  }
}

if (typeof document !== "undefined" && document.querySelector) {
  TourPage.page = new TourPage(document);
  TourPage.page.render();
}
