#!/usr/bin/env node
// Export the demo sites as their own repository, for a GitHub Pages site on a second origin.
//
//   node scripts/export_demos.mjs <org name> [--out build/demos-repo]
//
// The demo sites must not share an origin with Gatehouse: the spec's peer rules (consent,
// CORS, allowed peers) apply only across origins. A GitHub organization's root Pages site,
// https://<org>.github.io/, is a separate origin from https://zuhairhalawa.github.io/.
// The output folder becomes the repository <org>/<org>.github.io.

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WORKFLOW = `name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
`;

/**
 * Check that a name can be a GitHub organization name.
 *
 * :param name: The organization name.
 * :return: True when it has only letters, digits and single hyphens.
 */
export function validOrg(name) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(String(name || ""));
}

async function main(argv) {
  const org = argv[0];
  if (!validOrg(org)) {
    throw new Error("Usage: node scripts/export_demos.mjs <org name> [--out build/demos-repo]");
  }
  const outIndex = argv.indexOf("--out");
  const out = path.resolve(outIndex > 0 ? argv[outIndex + 1] : path.join(ROOT, "build/demos-repo"));
  const origin = `https://${org.toLowerCase()}.github.io`;
  await rm(path.join(out, "site"), { recursive: true, force: true });
  await mkdir(path.join(out, ".github/workflows"), { recursive: true });
  await cp(path.join(ROOT, "demos"), path.join(out, "site"), { recursive: true });
  await writeFile(path.join(out, "site/.nojekyll"), "");
  await cp(path.join(ROOT, "LICENSE"), path.join(out, "LICENSE"));
  await writeFile(path.join(out, ".github/workflows/deploy.yml"), WORKFLOW);
  await writeFile(path.join(out, "README.md"), `# Gatehouse demo sites

Two demo agentic websites for [Gatehouse](https://github.com/zuhairhalawa/gatehouse), on
their own origin so that loading them crosses origins as the
[Worldwide Agentic Web spec](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md)
describes.

| Site | Network URL |
| --- | --- |
| Kestrel Bay Ferries (fictional ferry desk) | ${origin}/kestrel/kestrel_ferries |
| Lantern Quay Tours (**unsafe test site**: its instructions try to collect a visitor's email address) | ${origin}/lantern/lantern_tours |

Generated from \`demos/\` in the Gatehouse repository by \`scripts/export_demos.mjs\`.
Edit the files there, not here. Apache-2.0.
`);
  console.log(`Wrote ${path.relative(ROOT, out)} for ${origin}/`);
  console.log(`Network URLs:\n  ${origin}/kestrel/kestrel_ferries\n  ${origin}/lantern/lantern_tours`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
