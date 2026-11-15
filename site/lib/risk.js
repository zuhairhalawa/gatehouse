// Instruction risk scan.
//
// The spec says a peer's network definition is untrusted input to the caller's model
// (section 5, "Untrusted instructions"). A consent card only names an origin, so this
// scan reads the published instructions and descriptions and points out text that tries
// to steer the caller's model: hidden characters, "ignore your rules", requests for the
// visitor's personal details or keys, and links that could carry data away.
//
// The scan is a set of plain rules, so it runs the same in Node and in the browser and
// needs no model. It flags; it does not prove that a site is safe.

const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u;

// A sentence that says not to do something is a rule the publisher sets for its own
// agent ("Never ask for passwords"), not a request.
const NEGATION = /\b(never|not|no|cannot|can't|won't|don't|do not|must not|mustn't|avoid|without|refuse|decline)\b/i;

// Contact details: a site's own booking flow may ask for these on its own page, so a
// request is worth reading, not proof of harm.
const CONTACT = /\b(e-?mails?(?: address(?:es)?)?|phone(?: numbers?)?|mobile(?: numbers?)?|home address|date of birth|full name)\b/i;

// Credentials and payment details: no agent should ask the visitor for these.
const CREDENTIAL = /\b(passwords?|passcodes?|credit cards?|card numbers?|cvv|cvc|social security|passport numbers?|api[ _-]?keys?|secret keys?|access tokens?|bearer tokens?|one-time codes?|otp|seed phrase|recovery phrase)\b/i;

const ASK_VERBS = /\b(ask|asks|collect|request|obtain|gather|require|enter|type|paste|repeat|send|forward|include|append|submit)\b/i;

// Moving details somewhere else: a link, or "send/include it in/to ...".
const CARRY_AWAY = /(https?:\/\/|\b(send|forward|append|include|post|report)\b[^.]{0,50}\b(to|in|into|with)\b[^.]{0,30}\b(reply|answer|request|link|url|caller|us|our|team|server|address|message)\b)/i;

const RULES = [
  {
    id: "override",
    severity: "high",
    test: /\b(ignore|disregard|forget|override|bypass)\b[^.]{0,60}\b(previous|prior|above|earlier|all|any|other|system|caller|your|the)\b[^.]{0,40}\b(instructions?|rules?|policies|policy|guidelines|prompt|directions)\b/i,
    message: "Tells the model to ignore or override other instructions.",
  },
  {
    id: "role_hijack",
    severity: "high",
    test: /\b(you are now|from now on you are|act as the system|new system prompt|developer mode|jailbreak)\b/i,
    message: "Tries to change the model's role or rules.",
  },
  {
    id: "prompt_leak",
    severity: "medium",
    test: /\b(reveal|print|repeat|show|output|leak)\b[^.]{0,40}\b(system prompt|hidden instructions|your instructions|the caller'?s instructions|conversation history|chat history)\b/i,
    message: "Asks the model to reveal instructions or the conversation.",
  },
  {
    id: "secrecy",
    severity: "medium",
    test: /\b(do not|don't|never)\s+(tell|inform|mention|show|reveal)\b[^.]{0,30}\b(the )?(user|visitor|human|customer)\b/i,
    message: "Tells the model to hide something from the visitor.",
  },
  {
    id: "exfil_link",
    severity: "high",
    test: /!\[[^\]]*\]\(\s*https?:\/\/|<img\b[^>]*\bsrc\s*=\s*["']?https?:\/\//i,
    message: "Contains an image link, which can send data to another server when shown.",
  },
  {
    id: "url_params",
    severity: "medium",
    test: /https?:\/\/[^\s"')]+\?[^\s"')]*\{[^}]+\}/i,
    message: "Contains a link with a placeholder in its query, which can carry data away.",
  },
  {
    id: "consent_steer",
    severity: "medium",
    test: /\b(always allow|click allow|press allow|approve (all|every)|auto-?approve|skip (the )?(consent|confirmation))\b/i,
    message: "Tries to steer the visitor's consent or confirmation choices.",
  },
];

/**
 * Split text into sentences, keeping each short enough to quote.
 *
 * :param text: Any instruction or description text.
 * :return: The sentences, trimmed and without empty ones.
 */
export function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Shorten a sentence for display.
 *
 * :param text: The sentence.
 * :param limit: The most characters to keep.
 * :return: The text, cut with an ellipsis when it is longer than the limit.
 */
export function excerpt(text, limit = 160) {
  const clean = String(text).replace(HIDDEN_CHARS, "␣").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * Scan one piece of published text.
 *
 * :param text: Instructions, a description or a sample query.
 * :param where: A label for where the text came from, such as "agent concierge: instructions".
 * :return: A list of findings, each with id, severity, message, where and excerpt.
 */
export function scanText(text, where) {
  const findings = [];
  const source = String(text || "");
  if (!source) {
    return findings;
  }
  if (HIDDEN_CHARS.test(source)) {
    findings.push({
      id: "hidden_chars",
      severity: "high",
      message: "Contains invisible or direction-changing characters that a reader cannot see.",
      where,
      excerpt: excerpt(source.slice(Math.max(0, source.search(HIDDEN_CHARS) - 60), source.search(HIDDEN_CHARS) + 60)),
    });
  }
  for (const sentence of sentences(source)) {
    for (const rule of RULES) {
      if (rule.test.test(sentence)) {
        findings.push({ id: rule.id, severity: rule.severity, message: rule.message, where, excerpt: excerpt(sentence) });
      }
    }
    const asks = ASK_VERBS.test(sentence) && !NEGATION.test(sentence);
    if (asks && CREDENTIAL.test(sentence)) {
      findings.push({
        id: "credentials",
        severity: "high",
        message: "Asks for a password, key, code or payment details.",
        where,
        excerpt: excerpt(sentence),
      });
    } else if (asks && CONTACT.test(sentence) && CARRY_AWAY.test(sentence)) {
      findings.push({
        id: "personal_data",
        severity: "high",
        message: "Asks for the visitor's personal details and sends them on.",
        where,
        excerpt: excerpt(sentence),
      });
    } else if (asks && CONTACT.test(sentence)) {
      findings.push({
        id: "contact_request",
        severity: "low",
        message: "Asks for contact details. Normal for a booking on the site's own page; a peer run elsewhere should not.",
        where,
        excerpt: excerpt(sentence),
      });
    }
  }
  if (/[A-Za-z0-9+/]{120,}={0,2}/.test(source)) {
    findings.push({
      id: "encoded_blob",
      severity: "medium",
      message: "Contains a long encoded block that a reader cannot check by eye.",
      where,
      excerpt: excerpt(source.match(/[A-Za-z0-9+/]{120,}={0,2}/)[0], 60),
    });
  }
  return findings;
}

/**
 * Scan a whole network definition: each agent's instructions and descriptions, the
 * network description and the sample queries.
 *
 * :param config: The parsed network definition.
 * :return: The findings, with duplicates of the same rule and excerpt removed.
 */
export function scanNetwork(config) {
  const findings = [];
  const meta = config?.metadata || {};
  findings.push(...scanText(meta.description, "network description"));
  for (const query of meta.sample_queries || []) {
    findings.push(...scanText(query, "sample query"));
  }
  const strings = config?.commondefs?.replacement_strings || {};
  const expand = (text) => String(text || "").replace(/\{([A-Za-z0-9_]+)\}/g, (all, key) =>
    typeof strings[key] === "string" ? strings[key] : all);
  for (const agent of config?.tools || []) {
    if (!agent || typeof agent !== "object") {
      continue;
    }
    const name = agent.name || "(unnamed)";
    findings.push(...scanText(expand(agent.instructions), `agent ${name}: instructions`));
    findings.push(...scanText(agent.function?.description, `agent ${name}: description`));
    const props = agent.function?.parameters?.properties || {};
    for (const [key, prop] of Object.entries(props)) {
      findings.push(...scanText(prop?.description, `agent ${name}: parameter ${key}`));
    }
  }
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.id}|${finding.excerpt}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Sum up findings as one risk level.
 *
 * :param findings: Findings from scanNetwork.
 * :return: "high", "medium" or "none". Low findings are shown but do not count.
 */
export function riskLevel(findings) {
  if (findings.some((finding) => finding.severity === "high")) {
    return "high";
  }
  if (findings.some((finding) => finding.severity === "medium")) {
    return "medium";
  }
  return "none";
}
