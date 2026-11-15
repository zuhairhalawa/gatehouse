# Gatehouse

**Find agentic websites. Check them. Then let one in.**

Gatehouse is an open agentic website for the
[Worldwide Agentic Web](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md).
Agentic sites publish agent networks that other sites run in their visitors' browsers.
Before one of those networks gets a visitor's question, Gatehouse:

1. **finds** it: a nightly crawl of the official list of agentic websites, the entries
   waiting in that list's pull requests, domains in the NANDA Index and sites submitted
   here;
2. **checks** it against the spec and records a **passport**: manifest, CORS, the exact
   network name, the runtime's own validator, peer policy, private-context rules, keys in
   public files, and an **instruction scan** for text that tries to steer the caller's
   model (hidden characters, "ignore your rules", requests for contact details that are
   sent on, consent steering);
3. **lets it in** only when the visitor approves, and **pins** the SHA-256 fingerprint of
   the files they approved. Before every hand-off Gatehouse reads the files again. If they
   changed, the visitor sees what changed and decides. If the files the runtime then loads
   differ from the ones Gatehouse checked, nothing runs.

The spec lists registries and search, conformance tests, and "hashes, caller pinning …
re-consent when published artifacts change" as open work (section 7). Gatehouse is a
working answer to those three, built on the reference runtime without changing it.

## What is in this repository

| Path | What it is |
| --- | --- |
| `site/` | The Gatehouse website: directory, "Check a site", the gate, the assistant and the evidence panel |
| `site/gatehouse.hocon` | The agent network (3 agents): a concierge, a passport inspector and a directory desk |
| `site/site-actions.js` | Six site actions the agents call: search, read a passport, check a site, let in, read the gate, choose the site to hand off to |
| `site/site.js` | Mounts the runtime and adds the gate: the `gate_peer` slot resolves only to the site on the visitor's gate, after the pin check |
| `site/lib/passport.js`, `site/lib/risk.js` | The checker and the instruction scan. They run in the browser and in Node |
| `cli/agentic-web-check.mjs` | The same checks as a command |
| `action.yml` | The same checks as a GitHub Action |
| `scripts/crawl.mjs` | The nightly crawl |
| `scripts/snapshot.mjs` | Writes the nightly directory snapshot into the network for other sites that call Gatehouse |
| `demos/kestrel/` | A fictional ferry desk: a good agentic site to let in |
| `demos/lantern/` | A clearly labelled unsafe test site whose instructions try to collect the visitor's email address |
| `vendor/agentify-website/` | The challenge's reference runtime, templates and build scripts, unchanged (Apache-2.0) |
| `tests/` | Unit tests and end-to-end tests on the real runtime with a scripted model |

## Demo sites on a second origin

The demo sites are published from `demos/` (with `scripts/export_demos.mjs`) to their own
origin, so that letting one in crosses origins as the spec describes:

- Kestrel Bay Ferries: `https://gatehouse-demos.github.io/kestrel/kestrel_ferries`
- Lantern Quay Tours, the unsafe test site: `https://gatehouse-demos.github.io/lantern/lantern_tours`

## Run it locally

Node 22 or newer, no install step.

```bash
node vendor/agentify-website/scripts/serve_site.mjs site --port 8080 --open-as 127.0.0.1
node vendor/agentify-website/scripts/serve_site.mjs demos/kestrel --port 8081 --open-as localhost
node vendor/agentify-website/scripts/serve_site.mjs demos/lantern --port 8082 --open-as localhost
```

Open http://127.0.0.1:8080/ and check `http://localhost:8081/kestrel_ferries` and
`http://localhost:8082/lantern_tours`. Gatehouse runs on `127.0.0.1` and the demos on
`localhost`, so they are different origins and the runtime's saved-key cookie never
reaches the demos.

The directory, the checks and the gate work without any AI key. The assistant needs one:
open **⚙ AI model settings** and add a key for the provider you choose. Your key stays
in this browser and goes only to that provider. When you are done, delete the saved setup
and close the tab.

To list the local demo sites in the directory, run a crawl into the local file the page
reads on `127.0.0.1`:

```bash
node scripts/crawl.mjs --out site/data/directory.local.json --extra http://localhost:8081/kestrel_ferries --extra http://localhost:8082/lantern_tours
```

## Check your own site

```bash
node cli/agentic-web-check.mjs https://your.site/your_network
node cli/agentic-web-check.mjs https://your.site/your_network --json
node cli/agentic-web-check.mjs https://your.site/your_network --pin sha256:<fingerprint>
```

The exit code is 1 when a site cannot be loaded or is blocked (with `--strict`, also on
warnings). In a workflow:

```yaml
- uses: zuhairhalawa/gatehouse@main
  with:
    url: https://your.site/your_network
```

The results go to the job summary.

## Call Gatehouse from your site

Gatehouse's network is public. Add its network URL to an agent's `tools` and its origin
to `allowed_peers`. Run elsewhere, it has none of its site tools, so its directory desk
answers from the nightly snapshot: which listed sites fit a request, with their network
URLs and verdicts.

## How the spec's interoperability checks are shown

| Check (spec section 6) | Where |
| --- | --- |
| A two-agent network and a manifest on an HTTPS host | `site/gatehouse.hocon` (3 agents), `site/agent-manifest.json`, served by GitHub Pages |
| Runs on the default router; BYOK | The assistant with **⚙ AI model settings**; the evidence panel names the router of every model call |
| An internal agent plus a grounded site action | `passport_inspector`, `directory_desk` and six `website_*` actions |
| Load a named network from a second origin after approval | Let in Kestrel Bay Ferries, then ask a question: the consent card, then its agents run here |
| The second site never gets the key and cannot change the router | Evidence panel; `tests/handoff.test.mjs` checks every request to the peer and the router of every peer model call |
| Private context absent at the peer | Evidence panel ("Private fields passed to it: none"); tested with a private field set |
| Visible errors: invalid network, cycle, over budget, denied origin | Passports show invalid networks and missing CORS; the gate refuses unknown links and blocked sites; the runtime skips a second call to the same peer in one message; tests cover each |

## Limits

- A passport records what Gatehouse found in a site's public files. It does not prove who
  runs a site or what its own servers do, and the instruction scan is a set of rules,
  not a guarantee.
- Gatehouse reads a site's public agent files when the visitor presses **Check**, lets a
  site in, or hands a question to it. Those reads carry nothing about the visitor; the
  runtime's consent card still asks before the question is sent.
- The gate lives in this browser only.
- The assistant's `write` actions run without a dialog (a limit of the reference
  runtime); Gatehouse's only write is choosing which admitted site to hand off to.
- Everything in the network file, instructions included, is public.

## License

Apache-2.0. `vendor/agentify-website/` and each `runtime/` folder are the challenge's
reference runtime and tools (Apache-2.0, see `vendor/agentify-website/runtime/LICENSE.txt`).
