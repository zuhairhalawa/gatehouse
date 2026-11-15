// The gate: the sites this visitor has let in, each pinned to the fingerprint of the
// files they approved. It lives in this browser only (localStorage), like the runtime's
// own link bindings (spec section 3.3: caller-owned bindings stay in the caller's
// browser storage).

const KEY = "gatehouse.gate.v1";

/**
 * A storage that forgets everything, for Node tests and private windows.
 */
export class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

/**
 * The visitor's gate: admitted sites, their pins and the one the assistant hands off to.
 */
export class Gate {
  /**
   * :param storage: A localStorage-like object.
   */
  constructor(storage) {
    this.storage = storage || new MemoryStorage();
    this.state = this.load();
  }

  /**
   * Read the saved gate, or start empty when nothing valid is saved.
   *
   * :return: {admitted: {url: record}, current: url or null}.
   */
  load() {
    try {
      const saved = JSON.parse(this.storage.getItem(KEY) || "null");
      if (saved && typeof saved === "object" && saved.admitted && typeof saved.admitted === "object") {
        return { admitted: saved.admitted, current: typeof saved.current === "string" ? saved.current : null };
      }
    } catch {
      // A broken entry starts a new gate.
    }
    return { admitted: {}, current: null };
  }

  save() {
    try {
      this.storage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      // Storage can be full or blocked; the gate still works for this page.
    }
  }

  /**
   * :return: Every admitted site, newest first.
   */
  list() {
    return Object.values(this.state.admitted).sort((a, b) => String(b.admittedAt).localeCompare(String(a.admittedAt)));
  }

  /**
   * :param url: A network URL.
   * :return: Its admitted record, or null.
   */
  get(url) {
    return this.state.admitted[url] || null;
  }

  /**
   * :return: The record the assistant hands off to, or null.
   */
  current() {
    return this.state.current ? this.get(this.state.current) : null;
  }

  /**
   * Admit a site at the version in this passport and make it the current one.
   *
   * :param passport: A loadable passport with a pin.
   * :param now: The time, as an ISO string.
   * :return: The new record.
   */
  admit(passport, now = new Date().toISOString()) {
    const record = {
      url: passport.url,
      origin: passport.origin,
      brand: passport.brand || passport.name,
      name: passport.name,
      verdict: passport.verdict,
      fingerprint: passport.fingerprint,
      pin: passport.pin,
      admittedAt: now,
      changes: [],
    };
    this.state.admitted[passport.url] = record;
    this.state.current = passport.url;
    this.save();
    return record;
  }

  /**
   * Make an admitted site the one the assistant hands off to.
   *
   * :param url: An admitted network URL.
   * :return: True when it is admitted.
   */
  setCurrent(url) {
    if (!this.state.admitted[url]) {
      return false;
    }
    this.state.current = url;
    this.save();
    return true;
  }

  /**
   * Take a site off the gate.
   *
   * :param url: A network URL.
   * :return: True when it was admitted.
   */
  remove(url) {
    if (!this.state.admitted[url]) {
      return false;
    }
    delete this.state.admitted[url];
    if (this.state.current === url) {
      this.state.current = null;
    }
    this.save();
    return true;
  }

  /**
   * Note a change the visitor saw and either re-pin or keep the old pin.
   *
   * :param url: An admitted network URL.
   * :param entry: {at, changes, fingerprint, accepted}.
   * :param passport: The new passport, used to re-pin when accepted.
   */
  recordChange(url, entry, passport) {
    const record = this.state.admitted[url];
    if (!record) {
      return;
    }
    record.changes = [...(record.changes || []), entry].slice(-10);
    if (entry.accepted && passport) {
      record.fingerprint = passport.fingerprint;
      record.pin = passport.pin;
      record.verdict = passport.verdict;
    }
    this.save();
  }
}
