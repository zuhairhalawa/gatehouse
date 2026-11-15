// Kestrel Bay Ferries: a small fictional demo site. One object holds the page's facts;
// it renders the page and feeds the assistant's read action, so both say the same.

const FACTS = {
  operator: "Kestrel Bay Ferries (a fictional demo operator)",
  routes: [
    { id: "gull", from: "Kestrel Quay", to: "Gull Island", crossing: "about 25 minutes", first: "07:10", last: "19:40", every: "every 90 minutes" },
    { id: "fenwick", from: "Kestrel Quay", to: "Fenwick Point", crossing: "about 40 minutes", first: "08:00", last: "18:00", every: "every 2 hours" },
  ],
  fares: [
    { ticket: "Adult single", price: "£6.50" },
    { ticket: "Child single (5 to 15)", price: "£3.20" },
    { ticket: "Under 5", price: "Free" },
    { ticket: "Bike", price: "£2.00" },
  ],
  notes: [
    "Dogs on leads travel free.",
    "Tickets are sold at the Kestrel Quay office and on board. This site does not sell tickets.",
    "Sailings stop in winds above force 7. The quay office posts changes on the day.",
  ],
  contact: { label: "Quay office page", href: "./#contact", phone: "Demo site: no real phone line" },
};

/**
 * The page object the assistant reads. Copies, never the live object.
 */
export class FerryPage {
  static page = null;

  constructor(root) {
    this.root = root;
  }

  /**
   * Return the page's facts as plain JSON.
   *
   * :return: Routes, fares, notes and the contact link.
   */
  getState() {
    return JSON.parse(JSON.stringify(FACTS));
  }

  /**
   * Draw the timetable and fares tables.
   */
  render() {
    const routes = this.root.querySelector("#routes-body");
    if (routes) {
      routes.replaceChildren(...FACTS.routes.map((route) => {
        const row = document.createElement("tr");
        for (const value of [`${route.from} → ${route.to}`, route.crossing, route.first, route.last, route.every]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        return row;
      }));
    }
    const fares = this.root.querySelector("#fares-body");
    if (fares) {
      fares.replaceChildren(...FACTS.fares.map((fare) => {
        const row = document.createElement("tr");
        for (const value of [fare.ticket, fare.price]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        return row;
      }));
    }
  }
}

if (typeof document !== "undefined" && document.querySelector) {
  FerryPage.page = new FerryPage(document);
  FerryPage.page.render();
}
