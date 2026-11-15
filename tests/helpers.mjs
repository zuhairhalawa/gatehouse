// Test helpers: an in-memory web of static files with or without CORS.

/**
 * Build a fake fetch over a map of URL -> file.
 *
 * :param files: {url: {body, cors = true, status = 200}} or {url: "body"}.
 * :return: A fetch function, with .calls listing every requested URL.
 */
export function fakeWeb(files) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    const file = files[url];
    if (file === undefined) {
      return new Response("not found", { status: 404 });
    }
    if (file instanceof Error) {
      throw file;
    }
    const spec = typeof file === "string" || (typeof file === "object" && !("body" in file)) ? { body: file } : file;
    const body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    const headers = new Headers({ "content-type": "application/json" });
    if (spec.cors !== false) {
      headers.set("access-control-allow-origin", "*");
    }
    return new Response(body, { status: spec.status || 200, headers });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/**
 * A small valid two-agent network, as the reference build writes it.
 *
 * :param overrides: Fields to change on the front agent.
 * :return: The network definition.
 */
export function twoAgentNetwork(overrides = {}) {
  return {
    metadata: { description: "Answers questions about harbour boat tours.", sample_queries: ["What tours do you run?"] },
    llm_config: { model_name: "alibaba/qwen3.8-flash" },
    tools: [
      {
        name: "harbor_front",
        function: {
          description: "Answers questions about boat tours.",
          parameters: { type: "object", properties: { request: { type: "string", description: "The request." } }, required: ["request"] },
        },
        instructions: "You help visitors with boat tours. Never ask for passwords or payment card details. Do not ask for names, emails, phone numbers or codes.",
        tools: ["tour_expert"],
        ...overrides,
      },
      {
        name: "tour_expert",
        function: {
          description: "Knows the tour routes.",
          parameters: { type: "object", properties: { request: { type: "string", description: "The question." } }, required: ["request"] },
        },
        instructions: "Answer from the published routes only.",
        tools: [],
      },
    ],
  };
}

/**
 * A manifest for one network.
 *
 * :param name: The network name.
 * :param overrides: Top-level fields to change.
 * :return: The manifest.
 */
export function manifestFor(name, overrides = {}) {
  return {
    brand: "Harbor Tours",
    networks: [{ name, front_man: "harbor_front", hocon: `./${name}.network.json`, description: "Boat tours.", sample_queries: ["What tours do you run?"] }],
    llm_router: { base_url: "https://api.otari.ai/api/v1", mock: false },
    allowed_peers: [],
    peer_policy: { mode: "closed" },
    ...overrides,
  };
}

/**
 * The files of one good site under a base URL.
 *
 * :param base: Such as "https://harbor.example".
 * :param name: The network name.
 * :param options: {network, manifest, cors} to change parts.
 * :return: A files map for fakeWeb.
 */
export function siteFiles(base, name, { network = twoAgentNetwork(), manifest = manifestFor(name), cors = true } = {}) {
  return {
    [`${base}/agent-manifest.json`]: { body: manifest, cors },
    [`${base}/${name}.network.json`]: { body: network, cors },
    [`${base}/links.json`]: { body: { version: 1, networks: {} }, cors },
  };
}
