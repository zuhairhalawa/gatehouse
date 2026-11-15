#!/usr/bin/env node
// Write the directory snapshot into site/gatehouse.hocon, for directory_desk.
//
//   node scripts/snapshot.mjs [--directory site/data/directory.json] [--hocon site/gatehouse.hocon]
//
// Other agentic sites that run Gatehouse's network get none of its website_* tools, so
// its directory_desk agent answers from this list. Only sites that pass or pass with
// notes are listed. Descriptions come from other sites, so they are cut short and
// stripped of anything that could close the string or open a placeholder.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BEGIN = /( *)# BEGIN directory_snapshot[^\n]*\n[\s\S]*?\n( *)# END directory_snapshot/;
const MAX_SITES = 25;

/**
 * Make text from another site safe to put inside a triple-quoted HOCON string.
 *
 * :param text: Any text.
 * :param limit: The most characters to keep.
 * :return: One line with no braces, quotes runs or control characters.
 */
export function clean(text, limit = 140) {
  const flat = String(text || "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, " ")
    .replace(/[{}"`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Build the snapshot lines from a directory.
 *
 * :param directory: The parsed directory.json.
 * :return: The text for the directory_snapshot string.
 */
export function snapshotText(directory) {
  const sites = (directory.sites || [])
    .filter((site) => site.passport?.loadable && ["pass", "warn"].includes(site.passport.verdict))
    .filter((site) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(site.url))
    .slice(0, MAX_SITES);
  const day = String(directory.generatedAt || "").slice(0, 10) || "unknown date";
  if (!sites.length) {
    return `Snapshot of ${day}: no loadable sites yet.`;
  }
  const lines = [`Snapshot of ${day}:`];
  for (const site of sites) {
    const p = site.passport;
    const what = clean(p.description || (p.sampleQueries || []).join("; ") || "no description", 140);
    lines.push(`- ${clean(p.brand || site.listedName || p.name, 60)} | ${clean(site.url, 200)} | ${p.verdict} | ${what}`);
  }
  return lines.join("\n");
}

/**
 * Replace the marked block in the HOCON text.
 *
 * :param hocon: The HOCON text.
 * :param text: The snapshot text.
 * :return: The new HOCON text.
 * :raises Error: When the markers are missing.
 */
export function replaceSnapshot(hocon, text) {
  if (!BEGIN.test(hocon)) {
    throw new Error("gatehouse.hocon has no BEGIN/END directory_snapshot markers.");
  }
  return hocon.replace(BEGIN, (all, indent, endIndent) =>
    `${indent}# BEGIN directory_snapshot (written by scripts/snapshot.mjs; do not edit by hand)\n` +
    `${indent}"directory_snapshot": """\n${text}\n"""\n${endIndent}# END directory_snapshot`);
}

async function main(argv) {
  let directoryPath = path.join(ROOT, "site/data/directory.json");
  let hoconPath = path.join(ROOT, "site/gatehouse.hocon");
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--directory") directoryPath = path.resolve(argv[i + 1]);
    else if (argv[i] === "--hocon") hoconPath = path.resolve(argv[i + 1]);
    else throw new Error(`Unknown option ${argv[i]}.`);
  }
  const directory = JSON.parse(await readFile(directoryPath, "utf8"));
  const hocon = await readFile(hoconPath, "utf8");
  const text = snapshotText(directory);
  await writeFile(hoconPath, replaceSnapshot(hocon, text));
  console.log(`snapshot: ${text.split("\n").length - 1} site(s) written to ${path.relative(ROOT, hoconPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
