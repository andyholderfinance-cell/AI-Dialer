const crypto = require("crypto");

function randomId() {
  return crypto.randomBytes(8).toString("hex");
}

function safeString(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function normalizeText(text) {
  return safeString(text)
    .toLowerCase()
    .replace(/[^\w\s@.:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(normalizeText(phrase)));
}

function renderTemplate(text, lead) {
  return safeString(text).replace(/\{\{(.*?)\}\}/g, (_, key) => {
    const cleanKey = key.trim();
    return lead[cleanKey] !== undefined && lead[cleanKey] !== null
      ? String(lead[cleanKey])
      : "";
  });
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function naturalAck() {
  return pick(["Okay", "Gotcha", "Alright", "Perfect", "Okay got it"]);
}

function recenterLine() {
  return pick([
    "Gotcha, and just so I handle the file correctly,",
    "No worries, and the main thing I'm checking is",
    "Right, and the reason I'm asking is just to make sure",
    "Okay, and I just want to make sure I'm looking at the right file here,",
  ]);
}

function humanize(text) {
  const fillers = ["…", "uh,", "um,", "let me see…", "just a second…"];

  if (Math.random() < 0.25) {
    return `${pick(fillers)} ${text}`;
  }

  return text;
}

function detectGoodbye(text) {
  const t = normalizeText(text);
  const goodbyes = [
    "bye",
    "goodbye",
    "bye bye",
    "have a good day",
    "have a nice day",
    "talk later",
    "see you",
    "see ya",
    "alright bye",
    "all right bye",
    "ok bye",
    "okay bye",
    "thanks bye",
    "thank you bye",
    "gotta go",
    "i have to go",
    "i gotta go",
  ];
  return goodbyes.some((g) => t.includes(g));
}

function detectRepeatRequest(text) {
  const t = normalizeText(text);
  const phrases = [
    "what was that",
    "repeat that",
    "can you repeat that",
    "could you repeat that",
    "say that again",
    "can you say that again",
    "could you say that again",
    "come again",
    "sorry what",
    "sorry",
    "huh",
    "i didnt hear you",
    "i didn't hear you",
    "didnt catch that",
    "didn't catch that",
    "can you repeat",
    "say again",
    "what did you say",
    "say that one more time",
    "one more time",
    "pardon",
    "pardon me",
  ];

  return phrases.some(
    (p) => t === normalizeText(p) || t.includes(normalizeText(p))
  );
}

function detectWrongPerson(text) {
  const t = normalizeText(text);
  return containsAny(t, [
    "wrong number",
    "you have the wrong number",
    "not me",
    "not this person",
    "you got the wrong person",
  ]);
}

function detectRelativeAnswer(text) {
  const t = normalizeText(text);
  return containsAny(t, [
    "this is his wife",
    "this is her wife",
    "this is his husband",
    "this is her husband",
    "this is his daughter",
    "this is her daughter",
    "this is his son",
    "this is her son",
    "this is his mom",
    "this is her mom",
    "this is his mother",
    "this is her mother",
    "this is his father",
    "this is her father",
    "this is his sister",
    "this is her sister",
    "this is his brother",
    "this is her brother",
    "i'm his wife",
    "im his wife",
    "i'm her wife",
    "im her wife",
    "i'm his husband",
    "im his husband",
    "i'm her husband",
    "im her husband",
    "i'm his daughter",
    "im his daughter",
    "i'm her daughter",
    "im her daughter",
    "i'm his son",
    "im his son",
    "i'm her son",
    "im her son",
  ]);
}

function detectNotAvailablePerson(text) {
  const t = normalizeText(text);
  return containsAny(t, [
    "he's not here",
    "hes not here",
    "she's not here",
    "shes not here",
    "not available",
    "not home",
    "they're not here",
    "theyre not here",
    "not in right now",
    "not around",
  ]);
}

function detectDeceased(text) {
  const t = normalizeText(text);
  return containsAny(t, [
    "he passed away",
    "she passed away",
    "passed away",
    "he died",
    "she died",
    "deceased",
    "no longer with us",
    "he is deceased",
    "she is deceased",
  ]);
}

function inferTimezoneFromState(state, defaultTimezone) {
  const s = safeString(state).trim().toUpperCase();
  const map = {
    CA: "America/Los_Angeles",
    OR: "America/Los_Angeles",
    WA: "America/Los_Angeles",
    NV: "America/Los_Angeles",
    AZ: "America/Phoenix",
    UT: "America/Denver",
    CO: "America/Denver",
    NM: "America/Denver",
    ID: "America/Denver",
    MT: "America/Denver",
    WY: "America/Denver",
    TX: "America/Chicago",
    IL: "America/Chicago",
    WI: "America/Chicago",
    MN: "America/Chicago",
    IA: "America/Chicago",
    MO: "America/Chicago",
    LA: "America/Chicago",
    OK: "America/Chicago",
    KS: "America/Chicago",
    NE: "America/Chicago",
    SD: "America/Chicago",
    ND: "America/Chicago",
    FL: "America/New_York",
    GA: "America/New_York",
    SC: "America/New_York",
    NC: "America/New_York",
    VA: "America/New_York",
    WV: "America/New_York",
    OH: "America/New_York",
    MI: "America/New_York",
    IN: "America/New_York",
    KY: "America/New_York",
    TN: "America/Chicago",
    AL: "America/Chicago",
    MS: "America/Chicago",
    AR: "America/Chicago",
    NY: "America/New_York",
    NJ: "America/New_York",
    PA: "America/New_York",
    CT: "America/New_York",
    RI: "America/New_York",
    MA: "America/New_York",
    VT: "America/New_York",
    NH: "America/New_York",
    ME: "America/New_York",
    MD: "America/New_York",
    DE: "America/New_York",
    DC: "America/New_York",
    AK: "America/Anchorage",
    HI: "Pacific/Honolulu",
  };
  return map[s] || defaultTimezone;
}

function formatLocalTime(utcIso, timezone) {
  const date = new Date(utcIso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function formatLocalDayPhrase(utcIso, timezone) {
  const date = new Date(utcIso);
  const now = new Date();

  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  const localNowDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  if (localDate === localNowDate) return "today";

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const localTomorrowDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(tomorrow);

  if (localDate === localTomorrowDate) return "tomorrow";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(date);
}

function normalizeApproxNumber(text) {
  const raw = safeString(text).toLowerCase();

  if (!raw) {
    return { raw: "", numeric: null };
  }

  let cleaned = raw
    .replace(/[$,]/g, "")
    .replace(/\babout\b/g, "")
    .replace(/\baround\b/g, "")
    .replace(/\broughly\b/g, "")
    .replace(/\bapproximately\b/g, "")
    .trim();

  const digits = cleaned.match(/-?\d+(\.\d+)?/g);
  if (!digits) {
    return { raw: text, numeric: null };
  }

  let value = parseFloat(digits[0]);

  if (cleaned.includes("thousand") || cleaned.includes("k")) {
    value *= 1000;
  } else if (cleaned.includes("million")) {
    value *= 1000000;
  }

  return {
    raw: text,
    numeric: Number.isFinite(value) ? Math.round(value) : null,
  };
}

function normalizeAge(text) {
  const parsed = normalizeApproxNumber(text);
  return {
    raw: text,
    numeric: parsed.numeric,
  };
}

function detectBlankish(text) {
  const t = normalizeText(text);
  return !t || ["uh", "um", "hmm", "mm", "huh"].includes(t);
}

function normalizeSpokenEmail(text) {
  if (!text) return "";

  return String(text)
    .toLowerCase()
    .replace(/\s*\(\s*at\s*\)\s*/g, "@")
    .replace(/\s*\[\s*at\s*\]\s*/g, "@")
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+underscore\s+/g, "_")
    .replace(/\s+dash\s+/g, "-")
    .replace(/\s+hyphen\s+/g, "-")
    .replace(/\s+/g, "")
    .replace(/,+/g, "")
    .trim();
}

function extractEmail(text) {
  const normalized = normalizeSpokenEmail(text);
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const match = normalized.match(emailRegex);
  return match ? match[0] : null;
}

module.exports = {
  randomId,
  safeString,
  normalizeText,
  containsAny,
  renderTemplate,
  pick,
  naturalAck,
  recenterLine,
  humanize,
  detectGoodbye,
  detectRepeatRequest,
  detectWrongPerson,
  detectRelativeAnswer,
  detectNotAvailablePerson,
  detectDeceased,
  inferTimezoneFromState,
  formatLocalTime,
  formatLocalDayPhrase,
  normalizeApproxNumber,
  normalizeAge,
  detectBlankish,
  normalizeSpokenEmail,
  extractEmail,
};
