#!/usr/bin/env node
// agentic-web-check: check agentic websites against the Worldwide Agentic Web MVP spec.
//
//   node cli/agentic-web-check.mjs <network URL> [more URLs] [--json] [--markdown]
//        [--strict] [--origin https://caller.example] [--pin <fingerprint>]
//
// It loads each site's public agent files the way a calling browser does, checks them
// and prints a passport. Exit code 0 when every site is loadable (and, with --strict,
// has no warnings), 1 when one is not, 2 on a usage error.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkSite } from "../site/lib/passport.js";

const MARK = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

/**
 * Read the command line.
 *
 * :param argv: The arguments after the script name.
 * :return: {urls, json, markdown, strict, origin, pin}.
 */
export function parseArgs(argv) {
  const options = { urls: [], json: false, markdown: false, strict: false, origin: undefined, pin: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--markdown") {
      options.markdown = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--origin" || arg === "--pin") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} needs a value.`);
      }
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}.`);
    } else {
      options.urls.push(arg);
    }
  }
  return options;
}

/**
 * Print one passport as plain text.
 *
 * :param passport: From checkSite.
 * :return: The text.
 */
export function formatText(passport) {
  const lines = [`${passport.url}`, `  Verdict: ${passport.verdict.toUpperCase()} - ${passport.summary}`];
  for (const check of passport.checks) {
    lines.push(`  ${MARK[check.status]}  ${check.title}: ${check.detail}${check.ref ? ` (spec ${check.ref})` : ""}`);
  }
  if (passport.risk.findings.length) {
    lines.push(`  Instruction risk: ${passport.risk.level}`);
    for (const finding of passport.risk.findings) {
      lines.push(`    ${finding.severity.toUpperCase()}  ${finding.message} [${finding.where}] "${finding.excerpt}"`);
    }
  }
  if (passport.fingerprint) {
    lines.push(`  Fingerprint: sha256:${passport.fingerprint}`);
  }
  if (passport.pinCheck) {
    lines.push(`  Pin: ${passport.pinCheck}`);
  }
  return lines.join("\n");
}

/**
 * Print one passport as a Markdown section, for a pull request comment or a job summary.
 *
 * :param passport: From checkSite.
 * :return: The Markdown text.
 */
export function formatMarkdown(passport) {
  const icon = { pass: "✅", warn: "⚠️", fail: "❌", skip: "➖" };
  const lines = [
    `### ${passport.url}`,
    "",
    `**${passport.verdict.toUpperCase()}**: ${passport.summary}`,
    "",
    "| | Check | Result | Spec |",
    "| --- | --- | --- | --- |",
  ];
  for (const check of passport.checks) {
    lines.push(`| ${icon[check.status]} | ${check.title} | ${check.detail.replace(/\|/g, "\\|")} | ${check.ref} |`);
  }
  if (passport.risk.findings.length) {
    lines.push("", `Instruction risk: **${passport.risk.level}**`, "");
    for (const finding of passport.risk.findings) {
      lines.push(`- ${finding.severity}: ${finding.message} (${finding.where}): "${finding.excerpt.replace(/\|/g, "\\|")}"`);
    }
  }
  if (passport.fingerprint) {
    lines.push("", `Fingerprint: \`sha256:${passport.fingerprint}\``);
  }
  return lines.join("\n");
}

/**
 * Run the checks for every URL and print them.
 *
 * :param argv: The command-line arguments.
 * :param io: {log, error, fetchImpl} so tests can capture output.
 * :return: The exit code.
 */
export async function main(argv, io = { log: console.log, error: console.error }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.error(error.message);
    return 2;
  }
  if (options.help || !options.urls.length) {
    io.log("Usage: agentic-web-check <network URL> [more URLs] [--json] [--markdown] [--strict] [--origin URL] [--pin sha256:...]");
    return options.help ? 0 : 2;
  }
  const passports = [];
  for (const url of options.urls) {
    const passport = await checkSite(url, { env: "node", origin: options.origin, fetchImpl: io.fetchImpl });
    if (options.pin && passport.fingerprint) {
      const expected = options.pin.replace(/^sha256:/, "");
      passport.pinCheck = expected === passport.fingerprint ? "matches" : "CHANGED since it was pinned";
      if (expected !== passport.fingerprint) {
        passport.loadable = false;
      }
    }
    passports.push(passport);
  }
  if (options.json) {
    io.log(JSON.stringify(passports.length === 1 ? passports[0] : passports, null, 2));
  } else if (options.markdown) {
    io.log(passports.map(formatMarkdown).join("\n\n"));
  } else {
    io.log(passports.map(formatText).join("\n\n"));
  }
  const bad = passports.some((passport) =>
    !passport.loadable || passport.verdict === "blocked" || (options.strict && passport.verdict !== "pass"));
  return bad ? 1 : 0;
}

/**
 * Say whether node started this file, rather than a test importing it.
 */
function startedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
