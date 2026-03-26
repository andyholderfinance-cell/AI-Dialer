require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const fetch = require("node-fetch");

const {
  twilioNumber,
  CALLER_NAME,
  UNDERWRITER_NAME,
  DEFAULT_STATE,
  DEFAULT_TIMEZONE,
  CALENDLY_API_KEY,
  CALENDLY_EVENT_TYPE_URI,
  SLOT_HOLD_MS,
  SLOT_HOLD_CLEANUP_MS,
  client,
  openai,
  VOICE_STYLE_INSTRUCTIONS,
} = require("./src/config");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/conversationrelay" });

/**
 * ============================================================================
 * SCRIPT
 * ============================================================================
 */

const { SCRIPT_STEPS } = require("./src/script");

/**
 * ============================================================================
 * OBJECTIONS
 * ============================================================================
 */

const { OBJECTION_LIBRARY } = require("./src/objections");

/**
 * ============================================================================
 * UNKNOWN OBJECTION UPGRADE
 * ============================================================================
 */

const {
  UNKNOWN_OBJECTION_TYPES,
  UNKNOWN_ACTIONS,
} = require("./src/unknownHandling");

const callSessions = new Map();
const slotHolds = new Map();

/**
 * ============================================================================
 * HELPERS
 * ============================================================================
 */

const {
  randomId,
  safeString,
  normalizeText,
  containsAny,
  renderTemplate,
  pick,
  naturalAck,
  recenterLine,
  humanize,
  detectConversationEmotion,
  nextConversationTone,
  emotionAcknowledgement,
  recenterToFile,
  fastAIFallbackLine,
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
} = require("./src/helpers");

const AI_REPLY_TIMEOUT_MS = Number(process.env.AI_REPLY_TIMEOUT_MS || 1200);
const AI_CLASSIFIER_TIMEOUT_MS = Number(
  process.env.AI_CLASSIFIER_TIMEOUT_MS || 900
);

function shouldDetectObjectionsAtStep(stepId) {
  const objectionStartIndex = getStepIndexById("intro_3");
  const currentIndex = getStepIndexById(stepId);
  return currentIndex >= objectionStartIndex;
}

function isAffirmative(text) {
  const t = normalizeText(text);
  return containsAny(t, [
    "yes",
    "yeah",
    "yep",
    "sure",
    "okay",
    "ok",
    "that works",
    "works",
    "perfect",
    "sounds good",
    "lets do it",
    "let's do it",
    "that is fine",
    "fine",
  ]);
}

function isNegative(text) {
  const t = normalizeText(text);
  return containsAny(t, [
    "no",
    "nope",
    "not really",
    "that wont work",
    "that won't work",
    "different time",
    "something else",
    "another time",
  ]);
}

function slotLabel(slot) {
  return `${slot.dayPhrase} at ${slot.localTime}`;
}

function clearBookingOfferState(session) {
  session.offeredSlotOptions = [];
  session.pendingConfirmationSlot = null;
  session.awaitingSlotConfirmation = false;
}

function setBookingContext(session, day = "", daypart = "") {
  if (day) {
    session.chosenBookingDay = day;
    session.lead.chosen_day = day;
    session.bookingContext.day = day;
  }

  if (daypart) {
    session.chosenBookingDaypart = daypart;
    session.lead.chosen_daypart = daypart;
    session.bookingContext.daypart = daypart;
  }
}

function getAllUsableSlots(session) {
  return filterHeldSlotsForSession(session.availableSlots, session);
}

function getSlotsForPreference(session, day = "", daypart = "") {
  return getAllUsableSlots(session).filter((slot) => {
    const dayOk = !day || slot.dayPhrase === day;
    const daypartOk = !daypart || getDaypartForSlot(slot) === daypart;
    return dayOk && daypartOk;
  });
}

function pickInitialOfferSlots(session) {
  const slots = getAllUsableSlots(session);

  if (!slots.length) return [];

  const today = slots.find((s) => s.dayPhrase === "today");
  const tomorrow = slots.find(
    (s) => s.dayPhrase === "tomorrow" && s.utcTime !== today?.utcTime
  );

  if (today && tomorrow) return [today, tomorrow];

  return slots.slice(0, 2);
}

function chooseFromOfferedSlots(text, session) {
  const slots = session.offeredSlotOptions || [];
  if (!slots.length) return null;

  const chosen = chooseSlotFromFilteredResponse(text, slots);
  if (chosen) return chosen;

  const t = normalizeText(text);

  if (slots[0] && containsAny(t, ["first", "earlier", "sooner"])) {
    return slots[0];
  }

  if (slots[1] && containsAny(t, ["second", "later"])) {
    return slots[1];
  }

  if (slots.length === 1 && isAffirmative(text)) {
    return slots[0];
  }

  return null;
}

function offerConcreteSlots(ws, session, slots, prefix = "") {
  const cleanSlots = (slots || []).slice(0, 2);
  session.offeredSlotOptions = cleanSlots;

  if (!cleanSlots.length) {
    sendVoice(
      ws,
      "It looks like I do not have anything open right this second. Let me grab your email and we’ll send over the next available time.",
      session
    );
    session.currentStepIndex = getStepIndexById("collect_email");
    return;
  }

  if (cleanSlots.length === 1) {
    const msg = prefix
      ? `${prefix} I have ${slotLabel(cleanSlots[0])}. Would that work for you?`
      : `I have ${slotLabel(cleanSlots[0])}. Would that work for you?`;

    sendVoice(ws, msg, session, { isPreciseBooking: true });
    return;
  }

  const msg = prefix
    ? `${prefix} I have ${slotLabel(cleanSlots[0])} or ${slotLabel(cleanSlots[1])}. Which works better for you?`
    : `I have ${slotLabel(cleanSlots[0])} or ${slotLabel(cleanSlots[1])}. Which works better for you?`;

  sendVoice(ws, msg, session, { isPreciseBooking: true });
}

function getAlternateDaypart(daypart) {
  if (daypart === "morning") return "evening";
  if (daypart === "evening") return "morning";
  return "";
}

function findClosestSlot(targetTimeText, slots) {
  const candidates = spokenWordsToTimeCandidates(targetTimeText);

  if (!candidates.length || !slots.length) return null;

  const targetDigits = candidates[0].replace(/[^\d]/g, "");
  if (!targetDigits) return null;

  const targetHour = parseInt(targetDigits.slice(0, 2));
  const targetMin = targetDigits.length > 2 ? parseInt(targetDigits.slice(2)) : 0;
  const targetTotal = targetHour * 60 + targetMin;

  let closest = null;
  let smallestDiff = Infinity;

  for (const slot of slots) {
    const match = slot.localTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) continue;

    let hour = parseInt(match[1]);
    const min = parseInt(match[2]);
    const ap = match[3].toLowerCase();

    if (ap === "pm" && hour !== 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;

    const total = hour * 60 + min;
    const diff = Math.abs(total - targetTotal);

    if (diff < smallestDiff) {
      smallestDiff = diff;
      closest = slot;
    }
  }

  return closest;
}

function detectPossibleUnknownObjection(text) {
  const t = normalizeText(text);
  if (!t) return false;

  const objectionSignals = [
    "what",
    "why",
    "how",
    "dont remember",
    "don't remember",
    "not interested",
    "already have",
    "already got",
    "through work",
    "too expensive",
    "cost",
    "price",
    "busy",
    "call me later",
    "who is this",
    "who are you",
    "sounds like",
    "scam",
    "remove me",
    "stop calling",
    "not now",
    "cant talk",
    "can't talk",
    "working",
    "at work",
    "send me something",
    "email me",
    "text me",
    "why do you need",
    "i have questions",
    "that makes no sense",
    "hold on",
    "wait",
    "im confused",
    "i'm confused",
    "how do i know",
    "is this legit",
    "is this real",
    "what do you mean",
    "why do you need that",
    "are you with my lender",
    "with my lender",
    "what company is this",
    "is this pmi",
    "is this homeowners insurance",
    "is this life insurance",
    "i'm driving",
    "im driving",
    "my wife handles that",
    "my husband handles that",
    "what happens next",
    "why do i need to talk to him",
    "why cant you just tell me",
    "why can't you just tell me",
    "you people keep calling",
    "this is stupid",
  ];

  return objectionSignals.some((signal) => t.includes(signal));
}

function soundsLikeCallScreening(text) {
  const t = normalizeText(text);
  const patterns = [
    "please say your name",
    "say your name",
    "state your name",
    "name and reason for calling",
    "reason for calling",
    "please state your name",
    "please say your name and reason for calling",
    "i will see if i can connect you",
    "i'll see if i can connect you",
    "google voice subscriber",
    "record your name",
    "announce yourself",
    "who is calling and why",
    "say your name after the tone",
    "tell me your name",
    "tell me who is calling",
  ];
  return patterns.some((p) => t.includes(p));
}

function soundsLikeHumanGreeting(text) {
  const t = normalizeText(text);
  const patterns = [
    "hello",
    "hi",
    "hey",
    "yeah",
    "yes",
    "speaking",
    "this is he",
    "this is she",
    "this is",
    "who is this",
    "who's this",
    "whos this",
    "yo",
    "yeah this is",
    "yes this is",
  ];
  return patterns.some((p) => t.includes(p));
}

function soundsLikeVoicemailGreeting(text) {
  const t = normalizeText(text);
  const patterns = [
    "leave a message",
    "leave your message",
    "please leave a message",
    "at the tone",
    "record your message",
    "not available",
    "cannot take your call",
    "can't take your call",
    "mailbox",
    "voice mailbox",
    "voicemail",
    "after the tone",
  ];
  return patterns.some((p) => t.includes(p));
}

function detectCoverageType(text) {
  const t = normalizeText(text);

  if (containsAny(t, ["through work", "work policy", "job", "employer"])) {
    return "work";
  }
  if (
    containsAny(t, ["mortgage", "specifically for the mortgage", "home loan"])
  ) {
    return "mortgage_specific";
  }
  if (containsAny(t, ["personal", "whole life", "term life", "life policy"])) {
    return "personal";
  }
  if (containsAny(t, ["not sure", "dont know", "don't know"])) {
    return "unknown";
  }

  return "unspecified";
}

function validateEnv() {
  const missing = [];

  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
  if (!process.env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
  if (!process.env.TWILIO_PHONE_NUMBER) missing.push("TWILIO_PHONE_NUMBER");
  if (!process.env.CALENDLY_API_KEY) missing.push("CALENDLY_API_KEY");
  if (!process.env.CALENDLY_EVENT_TYPE_URI) {
    missing.push("CALENDLY_EVENT_TYPE_URI");
  }

  if (missing.length) {
    console.error("Missing required env vars:", missing.join(", "));
  }

  if (
    process.env.CALENDLY_EVENT_TYPE_URI &&
    !process.env.CALENDLY_EVENT_TYPE_URI.startsWith(
      "https://api.calendly.com/event_types/"
    )
  ) {
    console.error(
      "CALENDLY_EVENT_TYPE_URI does not look like a Calendly API event type URI."
    );
  }
}

function buildSessionFromLead(lead = {}) {
  const timezone =
  lead.timezone ||
  inferTimezoneFromState(lead.state || lead.state_code, DEFAULT_TIMEZONE);
  
  const stateValue = lead.state_code || lead.state || DEFAULT_STATE;

  const sessionLead = {
    first_name: lead.first_name || "there",
    full_name: lead.full_name || lead.first_name || "Homeowner",
    phone: lead.phone || "",
    lender: lead.lender || "your lender",
    loan_amount: lead.loan_amount || "the amount on file",
    loan_amount_numeric: null,
    age: lead.age || "the age on file",
    age_numeric: null,
    address: lead.address || "the address on file",
    co_borrower: lead.co_borrower || "",
    state: stateValue,
    email: lead.email || "",
    meeting_type: lead.meeting_type || "Phone call",
    timezone,
    scheduled_time: "",
    scheduled_time_utc: "",
    slot_1_day_phrase: "today",
    slot_2_day_phrase: "today",
    slot_3_day_phrase: "tomorrow",
    slot_4_day_phrase: "tomorrow",
    time_option_1: "",
    time_option_2: "",
    time_option_3: "",
    time_option_4: "",
    policy_review: lead.policy_review || "No",
    coverage: lead.coverage || "",
    coverage_type: "",
    language: lead.language || "English",
    booked_by: lead.booked_by || CALLER_NAME,
    lead_type: lead.lead_type || "aged",
    no_mortgage: "No",
    chosen_day: "",
    chosen_daypart: "",
  };

  return {
    id: randomId(),
    callSid: null,
    lead: sessionLead,
    chosenBookingDay: "",
    chosenBookingDaypart: "",
    currentStepIndex: 0,
    lastQuestionStepIndex: 0,
    resumeStepIndex: 0,
    pendingPromptStartStepId: null,
    pendingPromptEndStepId: null,
    activeObjection: null,
    waitingForObjectionBranch: false,
    waitingForCoverageTypeAnswer: false,
    waitingForPostObjectionAck: false,
    postObjectionMode: null,
    postObjectionSourceId: null,
    postObjectionClarificationCount: 0,
    objectionReturnStepId: null,
    lastResolvedObjectionId: null,
    maxRecoverableObjections: 3,
    shouldEndCall: false,
    calendlyReady: false,
    availableSlots: [],
    pendingConfirmationSlot: null,
    awaitingSlotConfirmation: false,
    offeredSlotOptions: [],
    pendingChosenSlot: null,
    bookingContext: {
      day: "",
      daypart: "",
    },
    pendingChosenSlotPair: "first",
    heldSlotUtcTime: "",
    notes: [],
    createdAt: Date.now(),
    screeningState: "unknown",
    screeningCount: 0,
    scriptStarted: false,
    conversationTone: "neutral",
    lastDetectedEmotion: "neutral",
    aiLatencyMode: "normal",    
    lastBotMessage: "",
    lastMeaningfulBotMessage: "",
    lastMeaningfulBotStepId: "",
    lastPromptAt: 0,
    awaitingCallbackTime: false,
    callbackRequested: false,
    callbackReason: "",
    relativeAnswered: false,
    verifyingField: null,
    repeatCount: 0,
    blankResponseCount: 0,
    callOutcome: "in_progress",
    objectionHistory: [],
    unknownObjectionHistory: [],
    lastUnknownClassification: null,
    crm: {
      corrected_address: "",
      corrected_age: "",
      corrected_age_numeric: null,
      corrected_loan_amount: "",
      corrected_loan_amount_numeric: null,
      callback_time: "",
      callback_reason: "",
      objection_history: [],
      unknown_objection_history: [],
      final_outcome: "",
      meeting_type: "",
      booking_status: "",
      existing_coverage_type: "",
      no_mortgage: "No",
    },
  };
}

function getCurrentStep(session) {
  return SCRIPT_STEPS[session.currentStepIndex] || null;
}

function getStepIndexById(stepId) {
  return SCRIPT_STEPS.findIndex((step) => step.id === stepId);
}

function moveToNextStep(session) {
  if (session.currentStepIndex < SCRIPT_STEPS.length - 1) {
    session.currentStepIndex += 1;
    return true;
  }
  return false;
}

function isQuestionLike(step) {
  return step && ["question", "input", "booking"].includes(step.type);
}

function isMeaningfulFollowupText(text) {
  const t = normalizeText(text);
  const tiny = [
    "does that make sense",
    "fair enough",
    "okay",
    "okay so far",
    "you follow me",
    "are you still there",
    "hello",
  ];
  return !tiny.some((x) => t === normalizeText(x));
}

function buildPromptFromCurrentStep(session) {
  const parts = [];
  const startIndex = session.currentStepIndex;

  let idx = session.currentStepIndex;
  let questionStepIndex = session.currentStepIndex;

  while (idx < SCRIPT_STEPS.length) {
    const step = SCRIPT_STEPS[idx];
    parts.push(renderTemplate(step.text, session.lead));

    if (isQuestionLike(step)) {
      questionStepIndex = idx;
      session.lastQuestionStepIndex = idx;
      break;
    }

    idx += 1;
    questionStepIndex = idx;
  }

  session.resumeStepIndex = startIndex;
  session.pendingPromptStartStepId = SCRIPT_STEPS[startIndex]?.id || null;
  session.pendingPromptEndStepId =
    SCRIPT_STEPS[Math.min(questionStepIndex, SCRIPT_STEPS.length - 1)]?.id ||
    null;

  session.currentStepIndex = Math.min(
    questionStepIndex,
    SCRIPT_STEPS.length - 1
  );
  return parts.join(" ");
}

function detectNo(text) {
  const t = normalizeText(text);
  return (
    t.includes("no") ||
    t.includes("nope") ||
    t.includes("not really") ||
    t.includes("that's not right") ||
    t.includes("that is not right")
  );
}

function detectYes(text) {
  const t = normalizeText(text);
  return (
    t.includes("yes") ||
    t.includes("yeah") ||
    t.includes("yep") ||
    t.includes("correct") ||
    t.includes("that's right") ||
    t.includes("that is right") ||
    t.includes("right")
  );
}

function detectZoomPreference(text) {
  const t = normalizeText(text);
  if (t.includes("zoom")) return "Zoom";
  if (t.includes("phone")) return "Phone call";
  if (t.includes("call")) return "Phone call";
  return "";
}

function phraseMatch(input, trigger) {
  const a = normalizeText(input);
  const b = normalizeText(trigger);

  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;

  const aWords = new Set(a.split(" "));
  const bWords = b.split(" ").filter(Boolean);

  if (bWords.length === 1) {
    return aWords.has(bWords[0]);
  }

  let hits = 0;
  for (const word of bWords) {
    if (aWords.has(word)) hits++;
  }

  const ratio = hits / bWords.length;
  return ratio >= 0.7;
}

function detectTodayTomorrow(text) {
  const t = normalizeText(text);

  if (
    containsAny(t, [
      "today",
      "this afternoon",
      "this evening",
      "tonight",
      "today morning",
      "today evening",
    ])
  ) {
    return "today";
  }

  if (containsAny(t, ["tomorrow", "tmrw", "tmr"])) {
    return "tomorrow";
  }

  return "";
}

function detectMorningEvening(text) {
  const t = normalizeText(text);

  if (
    containsAny(t, [
      "morning",
      "am",
      "early",
      "earlier",
      "start of the day",
      "this morning",
      "today morning",
      "tomorrow morning",
    ])
  ) {
    return "morning";
  }

  if (
    containsAny(t, [
      "evening",
      "pm",
      "tonight",
      "later",
      "after work",
      "later on",
      "end of the day",
      "this evening",
      "today evening",
      "tomorrow evening",
    ])
  ) {
    return "evening";
  }

  return "";
}

function detectDirectBookingIntent(text) {
  const day = detectTodayTomorrow(text);
  const daypart = detectMorningEvening(text);
  const timeCandidates = spokenWordsToTimeCandidates(text);

  return {
    day,
    daypart,
    hasTime: timeCandidates.length > 0,
    timeCandidates,
  };
}

function detectObjection(text) {
  const t = normalizeText(text);
  if (!t) return null;

  for (const objection of OBJECTION_LIBRARY) {
    for (const trigger of objection.triggers) {
      if (phraseMatch(t, trigger)) {
        return objection;
      }
    }
  }

  return null;
}

function formatObjectionResponse(lines) {
  return lines
    .map((line) => {
      if (safeString(line).includes("[PAUSE")) return "...";
      return line;
    })
    .join(" ");
}

function buildVoiceMessage(text) {
  return JSON.stringify({
    type: "text",
    token: text,
    last: true,
  });
}

function sendVoice(ws, text, session = null, options = {}) {
  if (session) {
    session.lastBotMessage = text;

    if (!options.isFollowupPrompt && isMeaningfulFollowupText(text)) {
      session.lastMeaningfulBotMessage = text;
      session.lastMeaningfulBotStepId = safeString(getCurrentStep(session)?.id);
    }
  }

  const shouldHumanize =
    !options?.skipHumanize && !options?.isPreciseBooking;

  const finalText = shouldHumanize
    ? humanize(text, {
        tone: session?.conversationTone || "neutral",
        emotion: session?.lastDetectedEmotion || "neutral",
        isPreciseBooking: Boolean(options?.isPreciseBooking),
      })
    : text;

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(buildVoiceMessage(finalText));
  }
}

function setOutcome(session, outcome) {
  session.callOutcome = outcome;
  session.crm.final_outcome = outcome;
}

function note(session, type, value) {
  session.notes.push({
    type,
    value,
    at: Date.now(),
  });
}

function updateSessionToneFromText(session, callerText) {
  const emotion = detectConversationEmotion(callerText);
  session.lastDetectedEmotion = emotion;
  session.conversationTone = nextConversationTone(
    session.conversationTone,
    emotion
  );
  return emotion;
}

function buildUnknownAnchoredReply(session, baseReply = "") {
  const raw = safeString(baseReply).trim();

  const anchor = pick([
    "From what I'm seeing here on the file, I'm just trying to verify it the right way.",
    "I'm really just trying to handle the file correctly on my end.",
    "My part is just verifying the file and getting you lined up if you still want to review it.",
  ]);

  if (!raw) return anchor;

  const normalized = normalizeText(raw);
  if (
    normalized.includes("file") ||
    normalized.includes("underwriter") ||
    normalized.includes("verify")
  ) {
    return raw;
  }

  return `${raw} ${anchor}`;
}

async function withTimeout(workFn, ms, fallbackValue) {
  let timeoutId;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackValue), ms);
  });

  try {
    const result = await Promise.race([workFn(), timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

function sendNextPrompt(ws, session) {
  const prompt = buildPromptFromCurrentStep(session);
  sendVoice(ws, prompt, session);
}

function getPostObjectionModeForId(objectionId) {
  const modeMap = {
    what_is_this: "does_that_make_sense",
    how_did_you_get_my_info: "does_that_make_sense",
    is_this_a_scam: "does_that_make_sense",
    mandatory: "does_that_make_sense",
    are_you_selling: "does_that_make_sense",
    email_it: "does_that_make_sense",
    who_do_you_work_for: "does_that_make_sense",
    qualify: "does_that_make_sense",
    no_mortgage: "does_that_make_sense",
    already_have_insurance: "fair_enough",
    never_filled_anything_out: "does_that_make_sense",
    cost: "fair_enough",
    call_back: "okay_so_far",
    who_are_you: "brief_ack",
    unknown: "does_that_make_sense",
  };

  return modeMap[objectionId] || "does_that_make_sense";
}

function askPostObjectionFollowup(
  ws,
  session,
  mode = "does_that_make_sense",
  sourceId = null
) {
  session.waitingForPostObjectionAck = true;
  session.postObjectionMode = mode;
  session.postObjectionSourceId = sourceId;
  session.postObjectionClarificationCount = 0;

  if (mode === "does_that_make_sense") {
    sendVoice(ws, "Does that make sense?", session, { isFollowupPrompt: true });
    return;
  }

  if (mode === "fair_enough") {
    sendVoice(ws, "Fair enough?", session, { isFollowupPrompt: true });
    return;
  }

  if (mode === "okay_so_far") {
    sendVoice(ws, "Okay so far?", session, { isFollowupPrompt: true });
    return;
  }

  if (mode === "brief_ack") {
    sendVoice(ws, "Okay?", session, { isFollowupPrompt: true });
    return;
  }

  if (mode === "you_follow_me") {
    sendVoice(ws, "You follow me?", session, { isFollowupPrompt: true });
    return;
  }

  sendVoice(ws, "Does that make sense?", session, { isFollowupPrompt: true });
}

function isPositiveAck(text) {
  const t = normalizeText(text);

  return containsAny(t, [
    "yes",
    "yeah",
    "yep",
    "okay",
    "ok",
    "got it",
    "i got it",
    "makes sense",
    "that makes sense",
    "understood",
    "alright",
    "all right",
    "sure",
    "uh huh",
    "right",
    "correct",
    "fine",
    "fair enough",
  ]);
}

function isNegativeAck(text) {
  const t = normalizeText(text);

  return containsAny(t, [
    "no",
    "nope",
    "not really",
    "i dont understand",
    "i don't understand",
    "still confused",
    "confused",
    "doesnt make sense",
    "doesn't make sense",
    "not sure",
    "what do you mean",
    "huh",
    "i'm confused",
    "im confused",
    "not following",
    "i dont follow",
    "i don't follow",
  ]);
}

function getClarifyingFollowupForStep(stepId) {
  const map = {
    what_is_this:
      "It just looks like the file tied to the mortgage closing never got fully reviewed on my end.",
    how_did_you_get_my_info:
      "From what I'm seeing here, it was tied to the mortgage file from when the home was closed.",
    is_this_a_scam:
      "No, I get why you'd ask. I'm just trying to verify the file and see if you wanted to review it.",
    cost:
      "The underwriter would be the one to show the options, since that depends on your age and health.",
    mandatory:
      "No, you do not have to get it. I'm just checking whether you were able to get something in place.",
    who_do_you_work_for:
      "I work under the underwriter assigned to the file, so we are not tied to just one company.",
    email_it:
      "I can send the appointment details, but the actual options depend on your age, health, and what you need.",
    are_you_selling:
      "No, this call is just to verify the file and see if you want to review it with the underwriter.",
    call_back:
      "This call is really just to find a better time that works for you.",
    who_are_you: `This is ${CALLER_NAME}, the case worker assigned to the file on my end.`,
    qualify:
      "A lot of people think that at first, which is why the underwriter checks multiple options.",
    no_mortgage:
      "Even if the mortgage is paid off, some people still review personal protection depending on what they want it for.",
    already_have_insurance:
      "The review is just to make sure what you already have still fits what you need and that you're not overpaying.",
    never_filled_anything_out:
      "A lot of people do not remember because it may have been tied to the home closing a while back.",
    unknown:
      "I'm just making sure I'm looking at the right file and explaining it clearly on my end.",
  };

  return (
    map[stepId] ||
    "I'm just making sure I'm looking at the right file and explaining it clearly on my end."
  );
}

function buildShortRepeat(session) {
  const stepId = session.lastMeaningfulBotStepId;

  const byStep = {
    intro_1: renderTemplate("Hey, is this {{first_name}}?", session.lead),
    intro_2: renderTemplate(
      `I'm just calling about the mortgage protection information tied to your loan with {{lender}}.`,
      session.lead
    ),
    intro_3:
      "From what I'm seeing, the mortgage protection request tied to the home never got fully reviewed on my end.",
    intro_4: `My job is just to verify the information and get you lined up with ${UNDERWRITER_NAME} so you guys can go over it.`,
    verify_address: renderTemplate(
      "I have your address as {{address}}. Is that correct?",
      session.lead
    ),
    verify_loan: renderTemplate(
      "I have the loan amount as around {{loan_amount}}. Is that correct?",
      session.lead
    ),
    verify_age: renderTemplate(
      "I have your age as {{age}}. Is that still correct?",
      session.lead
    ),
    virtual_meeting: "Do you prefer Zoom or a phone call?",
    offer_day_choice: "Would today or tomorrow be better for you?",
    offer_daypart_choice: "Do you prefer mornings or in the evening?",
    offer_exact_time: renderTemplate(
      "What time works best {{chosen_day}} {{chosen_daypart}}?",
      session.lead
    ),
    collect_email:
      "What is a good email address for the appointment confirmation?",
  };

  return byStep[stepId] || safeString(session.lastMeaningfulBotMessage).trim();
}

async function handleRepeatRequest(ws, session) {
  session.repeatCount += 1;

  let repeatMessage = safeString(buildShortRepeat(session)).trim();

  if (session.repeatCount >= 3) {
    repeatMessage =
      "I'm just calling about the mortgage protection file tied to the home.";
  }

  if (!repeatMessage) {
    const currentStep = getCurrentStep(session);
    if (currentStep) {
      const rendered = renderTemplate(currentStep.text, session.lead);
      sendVoice(ws, `Yea, ${rendered}`, session);
      return true;
    }

    sendVoice(ws, "Yea, no worries.", session);
    return true;
  }

  sendVoice(ws, `Yea, ${repeatMessage}`, session);
  return true;
}

function detectLikelyInterruption(session) {
  const now = Date.now();
  const diff = now - (session.lastPromptAt || 0);
  session.lastPromptAt = now;
  return diff < 1800;
}

function maybeStartWithLeadType(session) {
  session.currentStepIndex = getStepIndexById("intro_1");
}

function detectCallbackTime(text) {
  const t = normalizeText(text);

  if (containsAny(t, ["later today", "this afternoon", "after work"])) {
    return "later today";
  }
  if (containsAny(t, ["tomorrow morning"])) {
    return "tomorrow morning";
  }
  if (containsAny(t, ["tomorrow afternoon"])) {
    return "tomorrow afternoon";
  }
  if (containsAny(t, ["tomorrow"])) {
    return "tomorrow";
  }
  if (containsAny(t, ["this afternoon", "afternoon"])) {
    return "this afternoon";
  }
  if (containsAny(t, ["this evening", "evening", "tonight"])) {
    return "this evening";
  }
  if (containsAny(t, ["morning"])) {
    return "morning";
  }

  return safeString(text).trim();
}

function detectCallbackReason(text) {
  const t = normalizeText(text);

  if (containsAny(t, ["at work", "working", "on the job"])) return "at_work";
  if (containsAny(t, ["driving", "in the car"])) return "driving";
  if (containsAny(t, ["busy", "bad time", "cant talk", "can't talk"])) {
    return "busy";
  }
  if (containsAny(t, ["call me later", "call back"])) {
    return "asked_for_callback";
  }

  return "general_callback";
}

function clearObjectionState(session) {
  session.activeObjection = null;
  session.waitingForObjectionBranch = false;
  session.waitingForCoverageTypeAnswer = false;
  session.waitingForPostObjectionAck = false;
  session.postObjectionMode = null;
  session.postObjectionSourceId = null;
  session.postObjectionClarificationCount = 0;
}

function releaseHeldSlotForSession(session) {
  cleanupExpiredSlotHolds();

  if (session?.heldSlotUtcTime) {
    const existing = slotHolds.get(session.heldSlotUtcTime);
    if (existing && existing.sessionId === session.id) {
      slotHolds.delete(session.heldSlotUtcTime);
    }
    session.heldSlotUtcTime = "";
  }
}

function resumeAfterObjection(ws, session) {
  const returnStepId =
    session.objectionReturnStepId || session.pendingPromptStartStepId || null;

  const returnIndex =
    returnStepId !== null
      ? getStepIndexById(returnStepId)
      : session.resumeStepIndex;

  const resolvedId =
    session.postObjectionSourceId ||
    session.activeObjection ||
    session.lastResolvedObjectionId ||
    null;

  session.lastResolvedObjectionId = resolvedId;
  session.objectionReturnStepId = null;
  session.pendingPromptStartStepId = null;
  session.pendingPromptEndStepId = null;

  clearObjectionState(session);

  if (returnIndex !== null && returnIndex >= 0) {
    session.currentStepIndex = returnIndex;
    sendNextPrompt(ws, session);
    return;
  }

  if (getCurrentStep(session)) {
    sendNextPrompt(ws, session);
    return;
  }

  session.shouldEndCall = true;
  sendVoice(ws, "Okay perfect. Thank you for your time.", session);
}

function countRecoverableObjections(session) {
  return session.objectionHistory.filter((id) => {
    const obj = OBJECTION_LIBRARY.find((o) => o.id === id);
    return obj && obj.category === "recoverable";
  }).length;
}

function shouldExitObjectionLoop(session) {
  return countRecoverableObjections(session) >= session.maxRecoverableObjections;
}

async function handleSilenceOrBlank(ws, session) {
  session.blankResponseCount += 1;

  if (session.blankResponseCount === 1) {
    sendVoice(ws, "Hello, are you still there?", session, {
      isFollowupPrompt: true,
    });
    return true;
  }

  if (session.blankResponseCount === 2) {
    sendVoice(ws, "Sorry, you cut out for a second.", session, {
      isFollowupPrompt: true,
    });

    const currentStep = getCurrentStep(session);
    if (currentStep) {
      sendVoice(ws, renderTemplate(currentStep.text, session.lead), session);
      return true;
    }
  }

  if (session.blankResponseCount >= 3) {
    session.shouldEndCall = true;
    setOutcome(session, "dead_air");
    sendVoice(
      ws,
      "No worries, I'll let you go for now. Have a great day.",
      session
    );
    return true;
  }

  return false;
}

async function handlePostObjectionAck(ws, session, callerText) {
  note(session, "post_objection_ack", callerText);

  const ackText = normalizeText(callerText);
  const currentObjectionId = session.postObjectionSourceId || "unknown";
  const currentMode = session.postObjectionMode || "does_that_make_sense";

  if (isNegativeAck(ackText)) {
    const clarification = getClarifyingFollowupForStep(currentObjectionId);
    sendVoice(ws, clarification, session);

    session.postObjectionClarificationCount =
      (session.postObjectionClarificationCount || 0) + 1;

    if (session.postObjectionClarificationCount >= 2) {
      resumeAfterObjection(ws, session);
      return;
    }

    if (currentMode === "fair_enough") {
      sendVoice(ws, "Fair enough?", session, { isFollowupPrompt: true });
      return;
    }

    if (currentMode === "okay_so_far") {
      sendVoice(ws, "Okay so far?", session, { isFollowupPrompt: true });
      return;
    }

    if (currentMode === "brief_ack") {
      sendVoice(ws, "Okay?", session, { isFollowupPrompt: true });
      return;
    }

    if (currentMode === "you_follow_me") {
      sendVoice(ws, "You follow me?", session, { isFollowupPrompt: true });
      return;
    }

    sendVoice(ws, "Does that make sense?", session, { isFollowupPrompt: true });
    return;
  }

  if (isPositiveAck(ackText) || ackText) {
    resumeAfterObjection(ws, session);
    return;
  }
}

/**
 * ============================================================================
 * CALENDLY ERROR READER / SLOT HOLDS / SLOT DETECTION
 * ============================================================================
 */

function cleanupExpiredSlotHolds() {
  const now = Date.now();
  for (const [utcTime, hold] of slotHolds.entries()) {
    if (!hold || hold.expiresAt <= now) {
      slotHolds.delete(utcTime);
    }
  }
}

function isSlotHeldByOtherSession(utcTime, session) {
  cleanupExpiredSlotHolds();
  const hold = slotHolds.get(utcTime);
  if (!hold) return false;
  return hold.sessionId !== session.id;
}

function acquireSlotHold(session, slot) {
  cleanupExpiredSlotHolds();

  if (!slot?.utcTime) return false;

  const existing = slotHolds.get(slot.utcTime);
  if (
    existing &&
    existing.sessionId !== session.id &&
    existing.expiresAt > Date.now()
  ) {
    return false;
  }

  releaseHeldSlotForSession(session);

  slotHolds.set(slot.utcTime, {
    sessionId: session.id,
    leadPhone: session.lead.phone,
    leadName: session.lead.full_name || session.lead.first_name,
    expiresAt: Date.now() + SLOT_HOLD_MS,
    createdAt: Date.now(),
  });

  session.heldSlotUtcTime = slot.utcTime;
  return true;
}

function extendSlotHold(session) {
  cleanupExpiredSlotHolds();

  if (!session?.heldSlotUtcTime) return;
  const hold = slotHolds.get(session.heldSlotUtcTime);
  if (!hold) return;
  if (hold.sessionId !== session.id) return;

  hold.expiresAt = Date.now() + SLOT_HOLD_MS;
  slotHolds.set(session.heldSlotUtcTime, hold);
}

function filterHeldSlotsForSession(slots, session) {
  cleanupExpiredSlotHolds();
  return slots.filter((slot) => !isSlotHeldByOtherSession(slot.utcTime, session));
}

function normalizeTimeForMatching(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(/o'clock/g, "")
    .trim();
}

function slotTimeVariants(slot) {
  const local = safeString(slot.localTime);
  const compact = normalizeTimeForMatching(local);

  const parts = local.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  const variants = new Set();

  variants.add(compact);
  variants.add(compact.replace(":00", ""));
  variants.add(compact.replace(":", ""));
  variants.add(
    compact.replace("pm", " p m").replace("am", " a m").replace(/\s+/g, "")
  );
  variants.add(compact.replace(":00pm", "pm"));
  variants.add(compact.replace(":00am", "am"));

  if (parts) {
    const hh = parts[1];
    const mm = parts[2];
    const ap = parts[3].toLowerCase();

    variants.add(`${hh}:${mm}${ap}`);
    variants.add(`${hh}${mm}${ap}`);
    variants.add(`${hh} ${mm} ${ap}`.replace(/\s+/g, ""));
    variants.add(`${hh} ${ap}`.replace(/\s+/g, ""));
    if (mm === "00") {
      variants.add(`${hh}${ap}`);
      variants.add(`${hh}:00${ap}`);
    }
  }

  return Array.from(variants);
}

function spokenWordsToTimeCandidates(text) {
  const t = normalizeText(text);

  const numberWords = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  const minuteWords = {
    "00": ["o clock", "oclock", "hundred"],
    "15": ["fifteen"],
    "30": ["thirty"],
    "45": ["forty five", "forty-five", "fortyfive"],
  };

  const candidates = new Set();

  const digitMatches = [
    ...t.matchAll(/\b(\d{1,2})[:\s](00|15|30|45)\b/g),
    ...t.matchAll(/\b(\d{1,2})(00|15|30|45)\b/g),
    ...t.matchAll(/\b(\d{1,2})\s*(am|pm)\b/g),
    ...t.matchAll(/\b(\d{1,2})\b/g),
  ];

  for (const match of digitMatches) {
    const hour = match[1];
    const part2 = match[2] || "";
    const part3 = match[3] || "";

    if (part3 === "am" || part3 === "pm") {
      candidates.add(`${hour}:00${part3}`);
      candidates.add(`${hour}${part3}`);
    } else if (part2 && ["00", "15", "30", "45"].includes(part2)) {
      candidates.add(`${hour}:${part2}`);
      candidates.add(`${hour}${part2}`);
    } else if (!part2 && Number(hour) >= 1 && Number(hour) <= 12) {
      candidates.add(`${hour}:00`);
      candidates.add(`${hour}`);
    }
  }

  for (const [word, hour] of Object.entries(numberWords)) {
    if (t.includes(word)) {
      candidates.add(`${hour}:00`);
      candidates.add(`${hour}`);

      for (const [minute, phrases] of Object.entries(minuteWords)) {
        for (const phrase of phrases) {
          if (t.includes(`${word} ${phrase}`)) {
            candidates.add(`${hour}:${minute}`);
            candidates.add(`${hour}${minute}`);
          }
        }
      }

      if (t.includes(`${word} pm`)) {
        candidates.add(`${hour}:00pm`);
        candidates.add(`${hour}pm`);
      }

      if (t.includes(`${word} am`)) {
        candidates.add(`${hour}:00am`);
        candidates.add(`${hour}am`);
      }
    }
  }

  return Array.from(candidates).map((x) =>
    String(x).toLowerCase().replace(/\s+/g, "")
  );
}

function slotMatchesCandidate(slot, candidates) {
  const slotVariants = slotTimeVariants(slot).map((v) =>
    String(v).toLowerCase().replace(/\s+/g, "")
  );

  for (const candidate of candidates) {
    for (const variant of slotVariants) {
      if (candidate === variant) return true;
      if (variant.includes(candidate) || candidate.includes(variant)) return true;

      const candidateDigits = candidate.replace(/[^\d]/g, "");
      const variantDigits = variant.replace(/[^\d]/g, "");
      if (candidateDigits && variantDigits.startsWith(candidateDigits)) return true;
    }
  }

  return false;
}

function buildCandidateSlotList(session, pair = "first") {
  const raw =
    pair === "first"
      ? session.availableSlots.slice(0, 2)
      : session.availableSlots.slice(2, 4);

  return filterHeldSlotsForSession(raw, session);
}

function getDaypartForSlot(slot) {
  const local = safeString(slot.localTime).toLowerCase();
  const match = local.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);

  if (!match) return "";

  const hour = Number(match[1]);
  const ap = match[3].toLowerCase();

  const hour24 =
    ap === "pm" && hour !== 12
      ? hour + 12
      : ap === "am" && hour === 12
      ? 0
      : hour;

  return hour24 < 12 ? "morning" : "evening";
}

function getFilteredSlots(session, day, daypart) {
  const slots = filterHeldSlotsForSession(session.availableSlots, session);

  return slots.filter((slot) => {
    const dayOk = !day || slot.dayPhrase === day;
    const daypartOk = !daypart || getDaypartForSlot(slot) === daypart;
    return dayOk && daypartOk;
  });
}

function chooseSlotFromFilteredResponse(text, slots) {
  const t = normalizeText(text);
  const compact = normalizeTimeForMatching(text);

  if (!slots.length) return null;

  for (const slot of slots) {
    for (const variant of slotTimeVariants(slot)) {
      if (variant && compact.includes(variant)) {
        return slot;
      }
    }
  }

  const spokenCandidates = spokenWordsToTimeCandidates(text);
  for (const slot of slots) {
    if (slotMatchesCandidate(slot, spokenCandidates)) {
      return slot;
    }
  }

  if (
    slots.length === 1 &&
    containsAny(t, ["yes", "okay", "works", "sure", "fine"])
  ) {
    return slots[0];
  }

  return null;
}

function chooseSlotFromResponse(text, session, pair = "first") {
  const t = normalizeText(text);
  const compact = normalizeTimeForMatching(text);
  const options = buildCandidateSlotList(session, pair);
  const [a, b] = options;

  if (!options.length) return null;

  for (const slot of options) {
    for (const variant of slotTimeVariants(slot)) {
      if (variant && compact.includes(variant)) {
        return slot;
      }
    }
  }

  const spokenCandidates = spokenWordsToTimeCandidates(text);
  for (const slot of options) {
    if (slotMatchesCandidate(slot, spokenCandidates)) {
      return slot;
    }
  }

  if (a && containsAny(t, ["first", "earlier", "sooner"])) return a;
  if (b && containsAny(t, ["second", "later"])) return b;

  if (a && !b && containsAny(t, ["yes", "okay", "works", "sure", "fine"])) {
    return a;
  }

  return null;
}

async function confirmChosenSlot(ws, session, chosen) {
  const held = acquireSlotHold(session, chosen);

  if (!held) {
    const recovered = await offerFreshSlotsAfterHoldLoss(
      ws,
      session,
      "That spot just got grabbed a second ago. Let me give you the next openings I still have."
    );

    if (!recovered) {
      session.shouldEndCall = true;
      setOutcome(session, "booking_failed_manual_followup");
      session.crm.booking_status = "manual_followup_needed";
      sendVoice(
        ws,
        "It looks like the calendar changed on me. We'll follow up with the updated times manually.",
        session
      );
    }

    return false;
  }

  session.pendingChosenSlot = chosen;
  session.lead.scheduled_time = chosen.localTime;
  session.lead.scheduled_time_utc = chosen.utcTime;

  note(session, "slot_selected", chosen);

  session.currentStepIndex = getStepIndexById("collect_email");

  sendVoice(
    ws,
    `Perfect, I have you at ${chosen.localTime}. ${renderTemplate(
      getCurrentStep(session).text,
      session.lead
    )}`,
    session,
    { isPreciseBooking: true }
  );

  return true;
}

function applySessionSlots(session) {
  const filtered = filterHeldSlotsForSession(session.availableSlots, session);

  session.lead.time_option_1 = filtered[0]?.localTime || "";
  session.lead.slot_1_day_phrase = filtered[0]?.dayPhrase || "today";

  session.lead.time_option_2 = filtered[1]?.localTime || "";
  session.lead.slot_2_day_phrase = filtered[1]?.dayPhrase || "today";

  session.lead.time_option_3 = filtered[2]?.localTime || "";
  session.lead.slot_3_day_phrase = filtered[2]?.dayPhrase || "tomorrow";

  session.lead.time_option_4 = filtered[3]?.localTime || "";
  session.lead.slot_4_day_phrase = filtered[3]?.dayPhrase || "tomorrow";
}

setInterval(cleanupExpiredSlotHolds, SLOT_HOLD_CLEANUP_MS).unref();

/**
 * ============================================================================
 * CALENDLY
 * ============================================================================
 */

const {
  calendlyFetch,
  buildCalendlyErrorSummary,
  getCalendlyAvailableTimes,
  primeCalendlySlots,
  buildCalendlyBookingFields,
  buildCalendlyQuestionsAndAnswers,
  buildCalendlyLocation,
  ensureChosenSlotStillAvailable,
  createCalendlyInvitee,
} = require("./src/calendly");

async function primeCalendlySlotsWrapper(session, forceRefresh = false) {
  return primeCalendlySlots(
    session,
    forceRefresh,
    filterHeldSlotsForSession,
    applySessionSlots
  );
}

async function ensureChosenSlotStillAvailableWrapper(session) {
  await ensureChosenSlotStillAvailable(
    session,
    extendSlotHold,
    primeCalendlySlotsWrapper
  );

  const hold = slotHolds.get(session.pendingChosenSlot.utcTime);
  if (!hold || hold.sessionId !== session.id) {
    const err = new Error("Chosen slot hold was lost");
    err.code = "HOLD_LOST";
    throw err;
  }
}

/**
 * ============================================================================
 * UNKNOWN OBJECTION CLASSIFIER / AI FALLBACK
 * ============================================================================
 */

function classifyUnknownObjectionRuleBased(session, text) {
  const t = normalizeText(text);
  const stepId = safeString(getCurrentStep(session)?.id);

  if (!t) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.GENERIC_UNKNOWN,
      confidence: 0.2,
      recommended_action: UNKNOWN_ACTIONS.REPEAT_LAST_STEP,
      reason: "blank_unknown",
    };
  }

  if (
    containsAny(t, [
      "stop calling",
      "bullshit",
      "this is bullshit",
      "fuck off",
      "f off",
      "leave me alone",
      "go to hell",
      "quit calling",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.HARD_HOSTILITY,
      confidence: 0.98,
      recommended_action: UNKNOWN_ACTIONS.GRACEFUL_EXIT,
      reason: "hard_hostility_phrase",
    };
  }

  if (
    containsAny(t, [
      "you people keep calling",
      "this is stupid",
      "i dont have time for this",
      "i don't have time for this",
      "this sounds stupid",
      "annoying",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.SOFT_HOSTILITY,
      confidence: 0.9,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME,
      reason: "soft_hostility_phrase",
    };
  }

  if (
    containsAny(t, [
      "why do you need my age",
      "why do you need my address",
      "why do you need that",
      "why do you need this",
      "why do you need my information",
      "why do you need my info",
      "why do you need the address",
      "why do you need the age",
      "why are you asking that",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.PRIVACY_RESISTANCE,
      confidence: 0.95,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_REPEAT_STEP,
      reason: "privacy_resistance_phrase",
    };
  }

  if (
    containsAny(t, [
      "are you with my lender",
      "with my lender",
      "what company is this",
      "what company are you with",
      "who are you with exactly",
      "how do i know this is real",
      "how do i know this is legit",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.IDENTITY_TRUST,
      confidence: 0.93,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME,
      reason: "identity_trust_phrase",
    };
  }

  if (
    containsAny(t, [
      "where did this come from",
      "why are you calling me",
      "i never asked for this",
      "i never filled that out",
      "i dont remember this",
      "i don't remember this",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.SOURCE_CONFUSION,
      confidence: 0.9,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME,
      reason: "source_confusion_phrase",
    };
  }

  if (
    containsAny(t, [
      "is this pmi",
      "is this homeowners insurance",
      "is this just life insurance",
      "is this life insurance",
      "what exactly is mortgage protection",
      "what kind of insurance is this",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.PRODUCT_CONFUSION,
      confidence: 0.95,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME,
      reason: "product_confusion_phrase",
    };
  }

  if (
    containsAny(t, [
      "i probably wont qualify",
      "i probably won't qualify",
      "im diabetic",
      "i'm diabetic",
      "i had cancer",
      "i have cancer",
      "im too old",
      "i'm too old",
      "i have health issues",
      "my health is bad",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.QUALIFICATION_FEAR,
      confidence: 0.92,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME,
      reason: "qualification_fear_phrase",
    };
  }

  if (
    containsAny(t, [
      "ballpark what does it cost",
      "roughly what does it cost",
      "are we talking 50 bucks",
      "are we talking 500",
      "what would this run me",
      "what kind of monthly payment",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.COST_PROBE,
      confidence: 0.9,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME,
      reason: "cost_probe_phrase",
    };
  }

  if (
    containsAny(t, [
      "im driving",
      "i'm driving",
      "walking into work",
      "i only have a second",
      "can you hurry up",
      "i'm heading in",
      "im heading in",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.TIME_PRESSURE,
      confidence: 0.96,
      recommended_action: UNKNOWN_ACTIONS.OFFER_CALLBACK,
      reason: "time_pressure_phrase",
    };
  }

  if (
    containsAny(t, [
      "my wife handles that",
      "my husband handles that",
      "my spouse handles that",
      "you need to talk to my wife",
      "you need to talk to my husband",
      "my wife deals with that",
      "my husband deals with that",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.SPOUSE_GATEKEEPER,
      confidence: 0.96,
      recommended_action: UNKNOWN_ACTIONS.GATEKEEPER_BRANCH,
      reason: "spouse_gatekeeper_phrase",
    };
  }

  if (
    containsAny(t, [
      "what happens next",
      "what is the underwriter going to do",
      "why do i need to talk to him",
      "why cant you just tell me",
      "why can't you just tell me",
      "so what are you actually trying to do",
    ])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.PROCESS_CONFUSION,
      confidence: 0.92,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME,
      reason: "process_confusion_phrase",
    };
  }

  if (
    stepId.startsWith("verify_") &&
    containsAny(t, ["why", "what for", "why do you need that"])
  ) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.PRIVACY_RESISTANCE,
      confidence: 0.8,
      recommended_action: UNKNOWN_ACTIONS.CLARIFY_THEN_REPEAT_STEP,
      reason: "verification_stage_privacy_resistance",
    };
  }

  if (containsAny(t, ["what do you mean", "im confused", "i'm confused"])) {
    return {
      type: UNKNOWN_OBJECTION_TYPES.OFF_TOPIC,
      confidence: 0.65,
      recommended_action: UNKNOWN_ACTIONS.REPEAT_LAST_STEP,
      reason: "general_confusion_phrase",
    };
  }

  return {
    type: UNKNOWN_OBJECTION_TYPES.GENERIC_UNKNOWN,
    confidence: 0.35,
    recommended_action: UNKNOWN_ACTIONS.AI_BRIEF_CLARIFY_THEN_RECENTER,
    reason: "rule_based_weak_match",
  };
}

async function classifyUnknownMomentAI(session, callerText) {
  const fallbackClassification = {
    type: UNKNOWN_OBJECTION_TYPES.GENERIC_UNKNOWN,
    confidence: 0.25,
    recommended_action: UNKNOWN_ACTIONS.AI_BRIEF_CLARIFY_THEN_RECENTER,
    reason: "ai_classifier_failed",
  };

  return withTimeout(
    async () => {
      try {
        const response = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content: `
You classify unexpected caller responses during a mortgage protection appointment-setting call.

Return strict JSON only.

Required JSON fields:
- type
- confidence
- recommended_action
- reason

Allowed "type" values:
identity_trust
source_confusion
product_confusion
privacy_resistance
qualification_fear
cost_probe
time_pressure
spouse_gatekeeper
process_confusion
soft_hostility
hard_hostility
off_topic
generic_unknown

Allowed "recommended_action" values:
clarify_then_resume
clarify_then_repeat_step
offer_callback
gatekeeper_branch
graceful_exit
repeat_last_step
ai_brief_clarify_then_recenter
`,
            },
            {
              role: "user",
              content: JSON.stringify({
                current_step: safeString(getCurrentStep(session)?.id),
                lead: session.lead,
                caller_text: callerText,
                tone: session.conversationTone,
                emotion: session.lastDetectedEmotion,
              }),
            },
          ],
        });

        const raw = safeString(response.output_text).trim();
        const parsed = JSON.parse(raw);

        if (!parsed.type || !parsed.recommended_action) {
          throw new Error("AI classifier returned incomplete JSON");
        }

        return {
          type: parsed.type,
          confidence: Number(parsed.confidence || 0.5),
          recommended_action: parsed.recommended_action,
          reason: safeString(parsed.reason || "ai_classifier"),
        };
      } catch (error) {
        console.error("Unknown objection classifier AI error:", error);
        return fallbackClassification;
      }
    },
    AI_CLASSIFIER_TIMEOUT_MS,
    fallbackClassification
  );
}

async function classifyUnknownMomentHybrid(session, callerText) {
  const ruleResult = classifyUnknownObjectionRuleBased(session, callerText);

  if (ruleResult.confidence >= 0.8) {
    return ruleResult;
  }

  const aiResult = await classifyUnknownMomentAI(session, callerText);

  return aiResult?.confidence > ruleResult.confidence ? aiResult : ruleResult;
}

function buildUnknownResponsePlan(session, classification) {
  switch (classification.type) {
    case UNKNOWN_OBJECTION_TYPES.TIME_PRESSURE:
      return {
        action: UNKNOWN_ACTIONS.OFFER_CALLBACK,
      };

    case UNKNOWN_OBJECTION_TYPES.SPOUSE_GATEKEEPER:
      return {
        action: UNKNOWN_ACTIONS.GATEKEEPER_BRANCH,
      };

    case UNKNOWN_OBJECTION_TYPES.HARD_HOSTILITY:
      return {
        action: UNKNOWN_ACTIONS.GRACEFUL_EXIT,
      };

    case UNKNOWN_OBJECTION_TYPES.PRIVACY_RESISTANCE:
      return {
        action: UNKNOWN_ACTIONS.CLARIFY_THEN_REPEAT_STEP,
      };

    case UNKNOWN_OBJECTION_TYPES.OFF_TOPIC:
      return {
        action: UNKNOWN_ACTIONS.REPEAT_LAST_STEP,
      };

    case UNKNOWN_OBJECTION_TYPES.IDENTITY_TRUST:
    case UNKNOWN_OBJECTION_TYPES.SOURCE_CONFUSION:
    case UNKNOWN_OBJECTION_TYPES.PRODUCT_CONFUSION:
    case UNKNOWN_OBJECTION_TYPES.QUALIFICATION_FEAR:
    case UNKNOWN_OBJECTION_TYPES.COST_PROBE:
    case UNKNOWN_OBJECTION_TYPES.PROCESS_CONFUSION:
    case UNKNOWN_OBJECTION_TYPES.SOFT_HOSTILITY:
      return {
        action: UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME,
      };

    default:
      return {
        action: UNKNOWN_ACTIONS.AI_BRIEF_CLARIFY_THEN_RECENTER,
      };
  }
}

function getUnknownTemplateReply(type, session) {
  switch (type) {
    case UNKNOWN_OBJECTION_TYPES.IDENTITY_TRUST:
      return "I’m just the case worker assigned to the file on my end, and I’m only trying to verify it and get you lined up if you still wanted to review it.";

    case UNKNOWN_OBJECTION_TYPES.SOURCE_CONFUSION:
      return "From what I’m seeing here, it was tied to the mortgage file from when the home was closed, and I’m just following up on my end.";

    case UNKNOWN_OBJECTION_TYPES.PRODUCT_CONFUSION:
      return "No, this is separate from PMI and homeowners. It’s the mortgage protection review tied to the home in case something were to happen to you.";

    case UNKNOWN_OBJECTION_TYPES.PRIVACY_RESISTANCE:
      return "Just so I know I’m looking at the right file and the underwriter has the right information in front of him.";

    case UNKNOWN_OBJECTION_TYPES.QUALIFICATION_FEAR:
      return "That’s actually why the underwriter goes over it, because he checks what may still fit based on your age and health.";

    case UNKNOWN_OBJECTION_TYPES.COST_PROBE:
      return "The underwriter would be the one to show what the actual options look like, since that depends on your age, health, and what you need.";

    case UNKNOWN_OBJECTION_TYPES.PROCESS_CONFUSION:
      return "My part is just verifying the file and getting you lined up with the underwriter so he can go over the options and answer the specifics.";

    case UNKNOWN_OBJECTION_TYPES.SOFT_HOSTILITY:
      return "I get it. I’m really just trying to handle the file correctly on my end and keep this quick for you.";

    default:
      return "";
  }
}

async function getFallbackAIReply(session, callerText) {
  const fallbackLine = buildUnknownAnchoredReply(
    session,
    fastAIFallbackLine()
  );

  return withTimeout(
    async () => {
      try {
        const aiResponse = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content: `
${VOICE_STYLE_INSTRUCTIONS}

Conversation rules:
- You are only for short clarification when the caller says something unexpected.
- Do not continue the script on your own.
- Do not invent new script lines.
- Do not add new sales language.
- Keep replies to one short sentence when possible.
- After clarifying, gently return control back to the scripted flow.
- Do not restate large parts of the process unless the caller directly asks.
- Never discuss detailed coverage, pricing, underwriting, or guarantees.

Current step: ${safeString(getCurrentStep(session)?.id)}
Lead: ${JSON.stringify(session.lead)}
Tone: ${safeString(session.conversationTone)}
Emotion: ${safeString(session.lastDetectedEmotion)}
`,
            },
            {
              role: "user",
              content: callerText,
            },
          ],
        });

        const output =
          aiResponse.output_text || "Okay, let me see if I have this right here.";

        return buildUnknownAnchoredReply(session, output);
      } catch (error) {
        console.error("Fallback AI error:", error);
        return fallbackLine;
      }
    },
    AI_REPLY_TIMEOUT_MS,
    fallbackLine
  );
}

async function getUnknownObjectionReply(session, callerText) {
  const fastFallback = buildUnknownAnchoredReply(
    session,
    fastAIFallbackLine()
  );

  return withTimeout(
    async () => {
      try {
        const currentStep = getCurrentStep(session);

        const aiResponse = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content: `
${VOICE_STYLE_INSTRUCTIONS}

You are responding to a homeowner during a scripted mortgage protection call.

CRITICAL RULE:
Your response MUST stay aligned with the script narrative.

The script narrative is:
• A mortgage protection file was opened during the home closing
• The file shows incomplete or due for review
• You are the case worker assigned to the file
• Your job is to verify the information and get them appointed with the underwriter

Do NOT:
• invent policies
• invent companies
• invent prices
• invent underwriting rules
• change the purpose of the call
• create a new sales pitch
• restart the script

Response rules:
• 1 sentence preferred
• 2 sentences maximum
• under 24 words
• natural human tone
• calm and conversational
• keep some anchor to the file / verify / underwriter narrative

Current script step: ${safeString(currentStep?.id)}
Script line: ${safeString(currentStep?.text)}
Lead info: ${JSON.stringify(session.lead)}
Tone: ${safeString(session.conversationTone)}
Emotion: ${safeString(session.lastDetectedEmotion)}
`,
            },
            {
              role: "user",
              content: callerText,
            },
          ],
        });

        const output =
          aiResponse.output_text ||
          "I got you, let me just make sure I have this right here.";

        return buildUnknownAnchoredReply(session, output);
      } catch (error) {
        console.error("Unknown objection AI error:", error);
        return fastFallback;
      }
    },
    AI_REPLY_TIMEOUT_MS,
    fastFallback
  );
}

/**
 * ============================================================================
 * ROUTES
 * ============================================================================
 */

app.get("/", (req, res) => {
  res.send("AI dialer is running.");
});

app.get("/health", (req, res) => {
  cleanupExpiredSlotHolds();
  res.json({
    ok: true,
    calendlyConfigured: Boolean(CALENDLY_API_KEY && CALENDLY_EVENT_TYPE_URI),
    eventTypeUri: CALENDLY_EVENT_TYPE_URI || null,
    holdCount: slotHolds.size,
  });
});

app.get("/test-calendly", async (req, res) => {
  try {
    const timezone = req.query.timezone || DEFAULT_TIMEZONE;
    const slots = await getCalendlyAvailableTimes(
      CALENDLY_EVENT_TYPE_URI,
      timezone
    );

    res.json({
      success: true,
      timezone,
      eventTypeUri: CALENDLY_EVENT_TYPE_URI,
      slotCount: slots.length,
      slots,
    });
  } catch (error) {
    console.error("Test Calendly error:", error.message);
    res.status(500).json({
      success: false,
      eventTypeUri: CALENDLY_EVENT_TYPE_URI || null,
      error: error.message,
      body: error.body || null,
      status: error.status || null,
      summary: error.summary || null,
    });
  }
});

app.get("/slot-holds", (req, res) => {
  cleanupExpiredSlotHolds();
  res.json({
    count: slotHolds.size,
    holds: Array.from(slotHolds.entries()).map(([utcTime, hold]) => ({
      utcTime,
      ...hold,
    })),
  });
});

app.post("/voice", (req, res) => {
  const host = req.headers.host;
  const leadId = req.query.leadId || "";

  const twiml = `
<Response>
  <Connect>
    <ConversationRelay
      url="wss://${host}/conversationrelay?leadId=${leadId}"
      ttsProvider="ElevenLabs"
      voice="s3TPKV1kjDlVtZbl4Ksh-flash_v2_5-0.85_0.75_0.80"
      language="en-US"
      ttsLanguage="en-US"
    />
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

app.post("/dial", async (req, res) => {
  try {
    const host = req.headers.host;
    const body = req.body || {};

    if (!body.phone) {
      return res.status(400).json({
        success: false,
        error: "phone is required",
      });
    }

    const leadId = randomId();
    const session = buildSessionFromLead(body);

    callSessions.set(leadId, session);

    const call = await client.calls.create({
      to: body.phone,
      from: twilioNumber,
      url: `https://${host}/voice?leadId=${leadId}`,
    });

    session.callSid = call.sid;

    res.json({
      success: true,
      leadId,
      callSid: call.sid,
      sessionPreview: {
        first_name: session.lead.first_name,
        lender: session.lead.lender,
        state: session.lead.state,
        address: session.lead.address,
        loan_amount: session.lead.loan_amount,
        age: session.lead.age,
        timezone: session.lead.timezone,
        lead_type: session.lead.lead_type,
      },
    });
  } catch (error) {
    console.error("Dial error:", error);
    res.status(500).json({
      success: false,
      error: "Dial failed",
      details: error.message,
    });
  }
});

app.get("/testdial", async (req, res) => {
  try {
    const host = req.headers.host;
    const phone = process.env.TEST_DIAL_NUMBER || "+18175842356";

    const leadId = randomId();
    const session = buildSessionFromLead({
      phone,
      first_name: "Andy",
      full_name: "Andy Holder",
      lender: "Rocket Mortgage",
      state: "Florida",
      address: "1 2 3 Main Street",
      loan_amount: "$150,000",
      age: "25",
      email: process.env.TEST_DIAL_EMAIL || "",
      lead_type: "aged",
    });

    callSessions.set(leadId, session);

    const call = await client.calls.create({
      to: phone,
      from: twilioNumber,
      url: `https://${host}/voice?leadId=${leadId}`,
    });

    session.callSid = call.sid;

    res.send(`Dialing now... Call SID: ${call.sid} | Lead ID: ${leadId}`);
  } catch (error) {
    console.error("Test dial error:", error);
    res.status(500).send("Test dial failed");
  }
});

app.get("/session/:leadId", (req, res) => {
  const session = callSessions.get(req.params.leadId);

  if (!session) {
    return res.status(404).json({ found: false });
  }

  res.json({
    found: true,
    session,
    currentStep: getCurrentStep(session),
  });
});

/**
 * ============================================================================
 * UNKNOWN OBJECTION EXECUTION
 * ============================================================================
 */

async function handleUnknownMomentByType(ws, session, callerText, classification) {
  const plan = buildUnknownResponsePlan(session, classification);
  const currentStep = getCurrentStep(session);
  const currentStepId = safeString(currentStep?.id);

  session.lastUnknownClassification = classification;
  session.unknownObjectionHistory.push(classification.type);
  session.crm.unknown_objection_history = [...session.unknownObjectionHistory];

  note(session, "unknown_objection_type", classification);

  if (plan.action === UNKNOWN_ACTIONS.GRACEFUL_EXIT) {
    session.shouldEndCall = true;
    setOutcome(session, "unknown_hard_hostility");
    releaseHeldSlotForSession(session);
    sendVoice(
      ws,
      "Understood. I'll close it out on my end. Take care.",
      session
    );
    return true;
  }

  if (plan.action === UNKNOWN_ACTIONS.OFFER_CALLBACK) {
    session.activeObjection = "callback_request";
    session.waitingForObjectionBranch = true;
    session.awaitingCallbackTime = true;
    session.callbackReason = detectCallbackReason(callerText);
    session.crm.callback_reason = session.callbackReason;

    sendVoice(
      ws,
      "Totally understand. What works better for you, later today or tomorrow?",
      session
    );
    return true;
  }

  if (plan.action === UNKNOWN_ACTIONS.GATEKEEPER_BRANCH) {
    session.awaitingCallbackTime = true;
    session.callbackReason = "spouse_gatekeeper";
    session.crm.callback_reason = "spouse_gatekeeper";

    sendVoice(
      ws,
      "Gotcha. Is there a better time to catch both of you, or would later today or tomorrow be better?",
      session
    );
    return true;
  }

  if (plan.action === UNKNOWN_ACTIONS.REPEAT_LAST_STEP) {
    const shortRepeat = buildShortRepeat(session);
    sendVoice(ws, shortRepeat || "Let me say that a little simpler.", session, {
      isFollowupPrompt: true,
    });

    if (currentStep && isQuestionLike(currentStep)) {
  const alreadyAsked = session.lastQuestion === currentStep.id;

  if (!alreadyAsked) {
    session.lastQuestion = currentStep.id;

    sendVoice(
      ws,
      renderTemplate(currentStep.text, session.lead),
      session,
      { isFollowupPrompt: true }
    );
  } else {
    
    sendVoice(
      ws,
      "Gotcha — just wanted to make sure I heard you right there.",
      session,
      { isFollowupPrompt: true }
    );
  }

  return true;
}

    sendVoice(ws, `${recenterLine()} give me one second here.`, session, {
      isFollowupPrompt: true,
    });
    return true;
  }

  if (plan.action === UNKNOWN_ACTIONS.CLARIFY_THEN_REPEAT_STEP) {
    const templated = getUnknownTemplateReply(classification.type, session);
    const reply =
      templated ||
      "Just so I know I'm looking at the right file and the underwriter has the right information.";

    sendVoice(ws, reply, session);

    if (currentStep && isQuestionLike(currentStep)) {
      sendVoice(
        ws,
        renderTemplate(currentStep.text, session.lead),
        session,
        { isFollowupPrompt: true }
      );
      return true;
    }

    session.objectionReturnStepId = currentStepId;
    askPostObjectionFollowup(
      ws,
      session,
      "brief_ack",
      classification.type || "unknown"
    );
    return true;
  }

  if (plan.action === UNKNOWN_ACTIONS.AI_BRIEF_CLARIFY_THEN_RECENTER) {
    const freestyleReply = await getUnknownObjectionReply(session, callerText);
    const anchoredReply = buildUnknownAnchoredReply(session, freestyleReply);
    const emotionLead = emotionAcknowledgement(session.lastDetectedEmotion);

    sendVoice(
      ws,
      [emotionLead, anchoredReply].filter(Boolean).join(" "),
      session
    );
    sendVoice(ws, `${recenterToFile()} ..., give me one second here`, session);
    return true;
  }  

   if (plan.action === UNKNOWN_ACTIONS.CLARIFY_THEN_RESUME) {
    const templated = getUnknownTemplateReply(classification.type, session);
    const aiReply =
      templated || (await getUnknownObjectionReply(session, callerText));
    const anchoredReply = buildUnknownAnchoredReply(session, aiReply);
    const emotionLead = emotionAcknowledgement(session.lastDetectedEmotion);

    sendVoice(
      ws,
      [emotionLead, anchoredReply].filter(Boolean).join(" "),
      session
    );

    session.objectionReturnStepId = currentStepId;
    askPostObjectionFollowup(
      ws,
      session,
      "brief_ack",
      classification.type || "unknown"
    );
    return true;
  }

  const freestyleReply = await getUnknownObjectionReply(session, callerText);
  sendVoice(ws, freestyleReply, session);
  sendVoice(ws, `${recenterLine()} ..., give me one second here`, session);
  return true;
}

/**
 * ============================================================================
 * CALL FLOW
 * ============================================================================
 */

async function handlePendingSlotConfirmation(ws, session, callerText) {
  const text = safeString(callerText);

  if (!session.awaitingSlotConfirmation || !session.pendingConfirmationSlot) {
    return false;
  }

  if (isAffirmative(text)) {
    const chosen = session.pendingConfirmationSlot;
    session.pendingConfirmationSlot = null;
    session.awaitingSlotConfirmation = false;
    clearBookingOfferState(session);

    await confirmChosenSlot(ws, session, chosen);
    return true;
  }

  if (isNegative(text)) {
    const rejected = session.pendingConfirmationSlot;
    session.pendingConfirmationSlot = null;
    session.awaitingSlotConfirmation = false;

    const fallbackPool = getSlotsForPreference(
      session,
      rejected.dayPhrase,
      getDaypartForSlot(rejected)
    ).filter((slot) => slot.utcTime !== rejected.utcTime);

    if (fallbackPool.length) {
      offerConcreteSlots(ws, session, fallbackPool, "No problem,");
      return true;
    }

    const allFallback = getAllUsableSlots(session).filter(
      (slot) => slot.utcTime !== rejected.utcTime
    );

    if (allFallback.length) {
      offerConcreteSlots(ws, session, allFallback, "No problem,");
      return true;
    }

    sendVoice(
      ws,
      "No problem. Let me grab your email and we'll send over the next available opening.",
      session
    );
    session.currentStepIndex = getStepIndexById("collect_email");
    return true;
  }

  sendVoice(
    ws,
    `Would ${slotLabel(session.pendingConfirmationSlot)} work for you?`,
    session
  );
  return true;
}

async function handleBookingStep(ws, session, callerText) {
  const text = safeString(callerText);
  const direct = detectDirectBookingIntent(text);

  if (direct.day) {
    setBookingContext(session, direct.day, "");
  }

  if (direct.daypart) {
    setBookingContext(session, "", direct.daypart);
  }

  const offeredChoice = chooseFromOfferedSlots(text, session);
  if (offeredChoice) {
    clearBookingOfferState(session);
    await confirmChosenSlot(ws, session, offeredChoice);
    return;
  }

  const day =
    direct.day || session.chosenBookingDay || session.bookingContext.day;
  const daypart =
    direct.daypart ||
    session.chosenBookingDaypart ||
    session.bookingContext.daypart;

  if (direct.hasTime) {
    const filtered = getSlotsForPreference(session, day, daypart);

    const exact = chooseSlotFromFilteredResponse(text, filtered);
    if (exact) {
      clearBookingOfferState(session);
      await confirmChosenSlot(ws, session, exact);
      return;
    }

    if (filtered.length) {
      const closest = findClosestSlot(text, filtered);

      if (closest) {
        session.pendingConfirmationSlot = closest;
        session.awaitingSlotConfirmation = true;

        sendVoice(
          ws,
          `The closest I have is ${slotLabel(closest)}. Would that work for you?`,
          session
        );
        return;
      }
    }
  }

  if (day || daypart) {
    const preferred = getSlotsForPreference(session, day, daypart);

    if (preferred.length) {
      offerConcreteSlots(ws, session, preferred);
      return;
    }

    if (day && daypart) {
      const altDaypart = getAlternateDaypart(daypart);
      const alternate = getSlotsForPreference(session, day, altDaypart);

      if (alternate.length) {
        setBookingContext(session, day, altDaypart);
        offerConcreteSlots(
          ws,
          session,
          alternate,
          `I’m not seeing anything open ${day} ${daypart},`
        );
        return;
      }
    }

    const fallback = getAllUsableSlots(session);
    if (fallback.length) {
      offerConcreteSlots(
        ws,
        session,
        fallback,
        "I’m not seeing anything open in that exact window,"
      );
      return;
    }

    sendVoice(
      ws,
      "It looks like nothing is showing open right now. Let me grab your email and we’ll send over the next available time.",
      session
    );
    session.currentStepIndex = getStepIndexById("collect_email");
    return;
  }

  const currentOffered = session.offeredSlotOptions || [];
  if (currentOffered.length) {
    offerConcreteSlots(
      ws,
      session,
      currentOffered,
      "Just so I give you a real option,"
    );
    return;
  }

  const initial = pickInitialOfferSlots(session);
  offerConcreteSlots(ws, session, initial);
}

async function handleConversationStart(ws, session) {
  session.scriptStarted = false;
  maybeStartWithLeadType(session);
}

async function handlePreScriptAudio(ws, session, callerText) {
  const text = safeString(callerText);
  const normalized = normalizeText(text);

  if (!normalized) return true;

  if (soundsLikeVoicemailGreeting(text)) {
    session.screeningState = "voicemail";
    session.shouldEndCall = true;
    setOutcome(session, "voicemail");
    note(session, "voicemail_detected", callerText);

    sendVoice(
      ws,
      `Hey this is ${CALLER_NAME}, just calling regarding the mortgage protection information tied to the property. Please give me a call back when you get a chance. Thanks.`,
      session
    );
    return true;
  }

  if (soundsLikeCallScreening(text)) {
    session.screeningState = "screening";
    session.screeningCount += 1;
    setOutcome(session, "screened_call");
    note(session, "call_screen_detected", callerText);

    if (session.screeningCount <= 2) {
      sendVoice(ws, `${CALLER_NAME}, calling back.`, session);
    } else {
      session.shouldEndCall = true;
      sendVoice(ws, "Okay, thank you.", session);
    }

    return true;
  }

  if (soundsLikeHumanGreeting(text)) {
    session.screeningState = "human_connected";

    if (!session.scriptStarted) {
      session.scriptStarted = true;
      session.currentStepIndex = getStepIndexById("intro_1");
      sendVoice(
        ws,
        renderTemplate(getCurrentStep(session).text, session.lead),
        session
      );
      return true;
    }
  }

  if (
    session.screeningState === "screening" &&
    !soundsLikeCallScreening(text) &&
    !session.scriptStarted
  ) {
    session.screeningState = "human_connected";
    session.scriptStarted = true;
    session.currentStepIndex = getStepIndexById("intro_1");
    sendVoice(
      ws,
      renderTemplate(getCurrentStep(session).text, session.lead),
      session
    );
    return true;
  }

  return false;
}

async function handleRelativeOrWrongParty(ws, session, callerText) {
  if (detectDeceased(callerText)) {
    setOutcome(session, "deceased_lead");
    note(session, "deceased_lead", callerText);
    session.shouldEndCall = true;
    releaseHeldSlotForSession(session);
    sendVoice(
      ws,
      "Oh wow, I'm sorry to hear that. I'll go ahead and update the file on my end. Thank you.",
      session
    );
    return true;
  }

  if (detectWrongPerson(callerText)) {
    setOutcome(session, "wrong_number");
    note(session, "wrong_number", callerText);
    session.shouldEndCall = true;
    releaseHeldSlotForSession(session);
    sendVoice(ws, "Oh okay, sorry about that. Have a great day.", session);
    return true;
  }

  if (detectRelativeAnswer(callerText)) {
    session.relativeAnswered = true;
    setOutcome(session, "relative_answered");
    note(session, "relative_answered", callerText);

    sendVoice(
      ws,
      `Gotcha. Do you help with the home as well, or would it be better if I just caught ${session.lead.first_name} directly?`,
      session
    );

    session.awaitingCallbackTime = true;
    session.callbackReason = "relative_answered";
    session.crm.callback_reason = "relative_answered";
    return true;
  }

  if (detectNotAvailablePerson(callerText)) {
    session.relativeAnswered = true;
    setOutcome(session, "person_not_available");
    note(session, "person_not_available", callerText);
    session.awaitingCallbackTime = true;
    session.callbackReason = "person_not_available";
    session.crm.callback_reason = "person_not_available";
    sendVoice(
      ws,
      `No worries. When would be a better time for ${session.lead.first_name} to get a quick call back?`,
      session
    );
    return true;
  }

  return false;
}

async function handleCallbackCapture(ws, session, callerText) {
  const callbackTime = detectCallbackTime(callerText);
  const callbackReason =
    session.callbackReason || detectCallbackReason(callerText);

  session.callbackRequested = true;
  session.awaitingCallbackTime = false;

  note(session, "callback_time", callbackTime);
  note(session, "callback_reason", callbackReason);

  session.crm.callback_time = callbackTime;
  session.crm.callback_reason = callbackReason;

  setOutcome(session, "callback_requested");

  session.shouldEndCall = true;
  releaseHeldSlotForSession(session);

  sendVoice(
    ws,
    `Perfect, I'll make a note for ${callbackTime}. Appreciate it.`,
    session
  );
}

function markObjection(session, matchedObjection, currentStepId) {
  session.resumeStepIndex = session.resumeStepIndex ?? session.currentStepIndex;
  session.objectionHistory.push(matchedObjection.id);
  session.crm.objection_history = [...session.objectionHistory];
  note(session, "objection", matchedObjection.id);
  session.objectionReturnStepId = currentStepId;
  session.lastResolvedObjectionId = null;
}

async function handleActiveObjectionBranch(ws, session, callerText) {
  const activeId = session.activeObjection;

  if (activeId === "callback_request") {
    await handleCallbackCapture(ws, session, callerText);
    return;
  }

  if (activeId === "existing_coverage_detail") {
    const coverageType = detectCoverageType(callerText);
    session.lead.policy_review = "Yes";
    session.lead.coverage = callerText;
    session.lead.coverage_type = coverageType;
    session.crm.existing_coverage_type = coverageType;
    note(session, "existing_coverage_type", coverageType);

    clearObjectionState(session);

    sendVoice(
      ws,
      "Gotcha. The review is really just to make sure what you have still fits what you need and that you're not overpaying.",
      session
    );
    askPostObjectionFollowup(
      ws,
      session,
      "fair_enough",
      "already_have_insurance"
    );
    return;
  }

  if (activeId === "not_interested") {
    const t = normalizeText(callerText);

    if (
      containsAny(t, [
        "cost",
        "price",
        "pricing",
        "too expensive",
        "qualify",
        "qualification",
        "i don't think i'd qualify",
        "i dont think id qualify",
        "wondering if i'd qualify",
        "wondering if i would qualify",
        "not sure i qualify",
        "dont think i qualify",
        "don't think i qualify",
        "i probably wouldnt qualify",
        "i probably wouldn't qualify",
      ])
    ) {
      const isCost = containsAny(t, [
        "cost",
        "price",
        "pricing",
        "too expensive",
      ]);

      const responseText = formatObjectionResponse(
        isCost
          ? [
              "Totally fair...",
              "That’s actually why we set it up this way — the underwriter works with a bunch of A-rated companies,",
              "so he can find whatever the most affordable option is for you.",
              "And since the call’s free, worst case you just get clarity on your options and decide from there.",
            ]
          : [
              "I completely understand...",
              "That’s exactly why I’m calling — the underwriter works with multiple A-rated carriers,",
              "so he can usually find something that fits based on your age and health.",
            ]
      );

      sendVoice(ws, responseText, session);

      session.waitingForObjectionBranch = false;
      askPostObjectionFollowup(
        ws,
        session,
        "brief_ack",
        isCost ? "cost" : "qualify"
      );
      return;
    }

    if (
      containsAny(t, [
        "still not interested",
        "not interested",
        "no",
        "nope",
        "just not interested",
        "i'm good",
        "im good",
        "leave it alone",
        "i'm okay",
        "im okay",
        "no thank you",
        "i'll pass",
        "dont want it",
        "don't want it",
      ])
    ) {
      session.activeObjection = "not_interested_coverage_check";
      sendVoice(
        ws,
        "Okay, no worries. Before I close out the file, do you already have something in place for the home if something were to happen to you, or are you just not concerned about it?",
        session
      );
      return;
    }

    sendVoice(
      ws,
      "Just so I update it correctly, is it more the cost, the qualifying part, or you just don't want to go over it?",
      session
    );
    return;
  }

  if (activeId === "not_interested_coverage_check") {
    const t = normalizeText(callerText);

    if (
      containsAny(t, [
        "yes",
        "yeah",
        "i do",
        "i have something",
        "already covered",
        "i already have coverage",
        "i have life insurance",
        "i have something through work",
        "covered",
        "i have insurance",
        "i have a policy",
        "i have coverage",
        "i have something in place",
        "i'm covered",
        "im covered",
      ])
    ) {
      session.waitingForObjectionBranch = false;
      session.activeObjection = "existing_coverage_detail";
      note(session, "has_existing_coverage", callerText);

      sendVoice(
        ws,
        "Okay great, and is that a personal life policy, something through work, or something specifically for the mortgage?",
        session
      );
      return;
    }

    if (
      containsAny(t, [
        "not concerned",
        "don't care",
        "dont care",
        "do not care",
        "not worried about it",
        "close it out",
        "just close it out",
        "not really",
        "no",
      ])
    ) {
      session.shouldEndCall = true;
      clearObjectionState(session);
      setOutcome(session, "not_interested");
      releaseHeldSlotForSession(session);
      sendVoice(
        ws,
        "Okay no worries, I'll go ahead and close out your file. Thank you for your time.",
        session
      );
      return;
    }

    sendVoice(
      ws,
      "Just so I update it correctly, do you already have something in place, or are you just not concerned about it?",
      session
    );
    return;
  }
}

async function handleCoverageTypeAnswer(ws, session, callerText) {
  note(session, "coverage_type_answer", callerText);

  session.lead.policy_review = "Yes";
  session.lead.coverage = callerText;
  session.lead.coverage_type = detectCoverageType(callerText);
  session.crm.existing_coverage_type = session.lead.coverage_type;

  session.waitingForCoverageTypeAnswer = false;

  if (moveToNextStep(session)) {
    sendNextPrompt(ws, session);
    return;
  }

  session.shouldEndCall = true;
  releaseHeldSlotForSession(session);
  sendVoice(ws, "Okay perfect. Thank you for your time.", session);
}

async function offerFreshSlotsAfterHoldLoss(ws, session, introLine = "") {
  releaseHeldSlotForSession(session);
  session.calendlyReady = false;
  session.availableSlots = [];
  session.pendingChosenSlot = null;
  session.lead.scheduled_time = "";
  session.lead.scheduled_time_utc = "";
  session.pendingConfirmationSlot = null;
  session.awaitingSlotConfirmation = false;
  session.offeredSlotOptions = [];
  session.bookingContext = { day: "", daypart: "" };
  session.chosenBookingDay = "";
  session.chosenBookingDaypart = "";
  session.lead.chosen_day = "";
  session.lead.chosen_daypart = "";

  try {
    await primeCalendlySlotsWrapper(session, true);
    session.currentStepIndex = getStepIndexById("offer_day_choice");

    if (introLine) {
      sendVoice(ws, introLine, session);
    }

    sendVoice(
      ws,
      renderTemplate(getCurrentStep(session).text, session.lead),
      session
    );
    return true;
  } catch (reprimeError) {
    console.error("Calendly reprime error:", reprimeError.message);
    return false;
  }
}

async function handleStepResponse(ws, session, callerText) {
  const step = getCurrentStep(session);
  console.log("STEP:", step?.id, "| USER:", callerText);

  if (!step) {
    session.shouldEndCall = true;
    releaseHeldSlotForSession(session);
    sendVoice(ws, "Thank you again. Have a great day.", session);
    return;
  }

  const text = safeString(callerText);
  const normalized = normalizeText(text);

  const relativeHandled = await handleRelativeOrWrongParty(
    ws,
    session,
    callerText
  );
  if (relativeHandled) return;

  const objectionEnabledSteps = new Set(
    SCRIPT_STEPS.slice(getStepIndexById("intro_3")).map((s) => s.id)
  );

  const matchedObjection = objectionEnabledSteps.has(step.id)
    ? detectObjection(text)
    : null;

  if (matchedObjection) {
    markObjection(session, matchedObjection, step.id);

    if (matchedObjection.action === "end_call") {
      session.shouldEndCall = true;
      setOutcome(session, "do_not_call");
      releaseHeldSlotForSession(session);
      sendVoice(
        ws,
        formatObjectionResponse(matchedObjection.response),
        session
      );
      return;
    }

    if (matchedObjection.action === "callback_branch") {
      sendVoice(
        ws,
        formatObjectionResponse(matchedObjection.response),
        session
      );
      session.activeObjection = "callback_request";
      session.waitingForObjectionBranch = true;
      session.awaitingCallbackTime = true;
      session.callbackReason = detectCallbackReason(callerText);
      session.crm.callback_reason = session.callbackReason;
      sendVoice(
        ws,
        "What works better for you, later today or tomorrow?",
        session
      );
      return;
    }

    if (matchedObjection.action === "existing_coverage_branch") {
      session.activeObjection = "existing_coverage_detail";
      session.waitingForObjectionBranch = true;
      note(session, "has_existing_coverage", callerText);
      sendVoice(
        ws,
        formatObjectionResponse(matchedObjection.response),
        session
      );
      return;
    }

    if (matchedObjection.action === "resume_script_next_step") {
      if (matchedObjection.id === "no_mortgage") {
        session.lead.no_mortgage = "Yes";
        session.crm.no_mortgage = "Yes";
      }

      sendVoice(
        ws,
        formatObjectionResponse(matchedObjection.response),
        session
      );
      const postMode = getPostObjectionModeForId(matchedObjection.id);
      askPostObjectionFollowup(ws, session, postMode, matchedObjection.id);
      return;
    }

    if (matchedObjection.action === "branch_followup") {
      session.activeObjection = matchedObjection.id;
      session.waitingForObjectionBranch = true;
      sendVoice(
        ws,
        formatObjectionResponse(matchedObjection.response),
        session
      );
      return;
    }
  }

  if (detectPossibleUnknownObjection(text)) {
    note(session, "unknown_objection", callerText);

    if (shouldExitObjectionLoop(session)) {
      session.shouldEndCall = true;
      setOutcome(session, "too_many_objections");
      releaseHeldSlotForSession(session);
      sendVoice(
        ws,
        "No worries, it sounds like now may not be the best time to go over it. I'll let you go for now. Have a great day.",
        session
      );
      return;
    }

    const classification = await classifyUnknownMomentHybrid(
      session,
      callerText
    );

    await handleUnknownMomentByType(ws, session, callerText, classification);
    return;
  }

  switch (step.id) {
    case "intro_1": {
      const t = normalizeText(text);

      const confirmedIdentity = containsAny(t, [
        "yes",
        "yeah",
        "yep",
        "speaking",
        "this is he",
        "this is she",
        "this is",
        "hello",
        "hi",
        "hey",
      ]);

      const asksWho = containsAny(t, [
        "who is this",
        "who s this",
        "whos this",
        "who are you",
        "what is your name",
        "what's your name",
        "what was your name",
      ]);

      if (confirmedIdentity) {
        session.currentStepIndex = getStepIndexById("intro_2");

        sendVoice(
          ws,
          renderTemplate(getCurrentStep(session).text, session.lead),
          session
        );
        return;
      }

      if (detectWrongPerson(text)) {
        session.shouldEndCall = true;
        setOutcome(session, "wrong_number");
        releaseHeldSlotForSession(session);
        sendVoice(ws, "Oh okay, sorry about that. Have a great day.", session);
        return;
      }

      if (asksWho) {
        session.currentStepIndex = getStepIndexById("intro_2");

        sendVoice(
          ws,
          renderTemplate(getCurrentStep(session).text, session.lead),
          session
        );
        return;
      }

      session.currentStepIndex = getStepIndexById("intro_2");
      sendVoice(
        ws,
        renderTemplate(getCurrentStep(session).text, session.lead),
        session
      );
      return;
    }

    case "intro_2": {
      session.currentStepIndex = getStepIndexById("intro_3");
      sendNextPrompt(ws, session);
      return;
    }

    case "intro_4": {
      session.currentStepIndex = getStepIndexById("verify_intro");
      sendNextPrompt(ws, session);
      return;
    }

    case "verify_address": {
      if (detectNo(text)) {
        session.verifyingField = "address";
        note(session, "address_mismatch", callerText);
        session.currentStepIndex = getStepIndexById("verify_address_update");
        sendVoice(
          ws,
          renderTemplate(getCurrentStep(session).text, session.lead),
          session
        );
        return;
      }

      session.currentStepIndex = getStepIndexById("verify_loan");
      sendVoice(
        ws,
        renderTemplate(getCurrentStep(session).text, session.lead),
        session
      );
      return;
    }

    case "verify_address_update": {
      session.lead.address = callerText;
      session.crm.corrected_address = callerText;
      note(session, "address_updated", callerText);
      session.verifyingField = null;

      session.currentStepIndex = getStepIndexById("verify_loan");
      sendVoice(
        ws,
        `${naturalAck()}. ${renderTemplate(
          getCurrentStep(session).text,
          session.lead
        )}`,
        session
      );
      return;
    }

    case "verify_loan": {
      if (detectNo(text)) {
        session.verifyingField = "loan_amount";
        note(session, "loan_mismatch", callerText);
        session.currentStepIndex = getStepIndexById("verify_loan_update");
        sendVoice(
          ws,
          renderTemplate(getCurrentStep(session).text, session.lead),
          session
        );
        return;
      }

      session.currentStepIndex = getStepIndexById("verify_coborrower");
      sendVoice(
        ws,
        renderTemplate(getCurrentStep(session).text, session.lead),
        session
      );
      return;
    }

    case "verify_loan_update": {
      session.lead.loan_amount = callerText;
      const parsed = normalizeApproxNumber(callerText);
      session.lead.loan_amount_numeric = parsed.numeric;
      session.crm.corrected_loan_amount = callerText;
      session.crm.corrected_loan_amount_numeric = parsed.numeric;
      note(session, "loan_amount_updated", parsed);
      session.verifyingField = null;

      session.currentStepIndex = getStepIndexById("verify_coborrower");
      sendVoice(
        ws,
        `${naturalAck()}. ${renderTemplate(
          getCurrentStep(session).text,
          session.lead
        )}`,
        session
      );
      return;
    }

    case "verify_coborrower": {
      if (containsAny(normalized, ["no", "nobody", "no one", "just me"])) {
        session.lead.co_borrower = "No";
      } else {
        session.lead.co_borrower = callerText;
      }

      note(session, "co_borrower_answer", session.lead.co_borrower);

      session.currentStepIndex = getStepIndexById("verify_age");
      sendVoice(
        ws,
        renderTemplate(getCurrentStep(session).text, session.lead),
        session
      );
      return;
    }

    case "verify_age": {
      if (detectNo(text)) {
        session.verifyingField = "age";
        note(session, "age_mismatch", callerText);
        session.currentStepIndex = getStepIndexById("verify_age_update");
        sendVoice(
          ws,
          renderTemplate(getCurrentStep(session).text, session.lead),
          session
        );
        return;
      }

      session.currentStepIndex = getStepIndexById("underwriter_intro");
      sendNextPrompt(ws, session);
      return;
    }

    case "verify_age_update": {
      session.lead.age = callerText;
      const parsed = normalizeAge(callerText);
      session.lead.age_numeric = parsed.numeric;
      session.crm.corrected_age = callerText;
      session.crm.corrected_age_numeric = parsed.numeric;
      note(session, "age_updated", parsed);
      session.verifyingField = null;

      session.currentStepIndex = getStepIndexById("underwriter_intro");
      sendNextPrompt(ws, session);
      return;
    }

    case "virtual_meeting": {
      session.lead.meeting_type = detectZoomPreference(text) || "Phone call";
      session.crm.meeting_type = session.lead.meeting_type;
      note(session, "meeting_type", session.lead.meeting_type);

      sendVoice(
        ws,
        renderTemplate(
          `Okay {{first_name}}, give me just a moment while I check ${UNDERWRITER_NAME}'s calendar...`,
          session.lead
        ),
        session
      );

      try {
        await primeCalendlySlotsWrapper(session);
        clearBookingOfferState(session);

        const initialSlots = pickInitialOfferSlots(session);
        session.currentStepIndex = getStepIndexById("offer_day_choice");

        offerConcreteSlots(ws, session, initialSlots);
      } catch (err) {
        console.error("Calendly error:", err);

        sendVoice(
          ws,
          "Looks like I'm having trouble pulling up the calendar right now. We’ll follow up with you shortly.",
          session
        );

        session.shouldEndCall = true;
      }

      return;
    }

    case "offer_day_choice":
    case "offer_daypart_choice":
    case "offer_exact_time": {
      await handleBookingStep(ws, session, callerText);
      return;
    }

    case "collect_email": {
      extendSlotHold(session);

      const email = extractEmail(text);

      if (!email) {
        sendVoice(
          ws,
          "I'm sorry, I didn't quite catch the email. Can you say that one more time for me?",
          session
        );
        return;
      }

      session.lead.email = email;
      note(session, "email_collected", session.lead.email);

      if (!session.pendingChosenSlot?.utcTime) {
        note(session, "manual_followup_email_only", {
          email: session.lead.email,
          reason: "no_slot_selected",
        });

        setOutcome(session, "manual_followup_needed");
        session.crm.booking_status = "manual_followup_needed";
        releaseHeldSlotForSession(session);

        sendVoice(
          ws,
          "Perfect, I have your email. We'll send over the next available time as soon as the calendar opens up.",
          session
        );
        session.shouldEndCall = true;
        return;
      }

      try {
        await ensureChosenSlotStillAvailableWrapper(session);

        const booking = await createCalendlyInvitee(session);

        note(session, "calendly_booking", booking);
        setOutcome(session, "booked");
        session.crm.booking_status = "booked";
        releaseHeldSlotForSession(session);

        moveToNextStep(session);
        sendNextPrompt(ws, session);
        session.shouldEndCall = true;
      } catch (error) {
        console.error("Calendly booking error:", {
          message: error.message,
          summary: error.summary || null,
          slot: session.pendingChosenSlot?.utcTime || null,
          heldSlot: session.heldSlotUtcTime || null,
        });

        if (error.code === "SLOT_GONE" || error.code === "HOLD_LOST") {
          const recovered = await offerFreshSlotsAfterHoldLoss(
            ws,
            session,
            "That spot just got taken. Let me give you the next two openings I have."
          );
          if (recovered) {
            return;
          }
        }

        note(session, "booking_manual_followup_needed", {
          email: session.lead.email,
          scheduled_time: session.lead.scheduled_time,
          scheduled_time_utc: session.lead.scheduled_time_utc,
          phone: session.lead.phone,
          meeting_type: session.lead.meeting_type,
          error: error.message,
          summary: error.summary || null,
        });

        setOutcome(session, "booking_failed_manual_followup");
        session.crm.booking_status = "manual_followup_needed";
        releaseHeldSlotForSession(session);

        sendVoice(
          ws,
          "I have everything I need, but the appointment did not finish saving on my side. We'll follow up with the confirmation manually so you do not lose it.",
          session
        );
        session.shouldEndCall = true;
      }
      return;
    }

    default: {
      const fallback = await getFallbackAIReply(session, callerText);
      sendVoice(ws, fallback, session);

      const currentStep = getCurrentStep(session);
      if (currentStep && isQuestionLike(currentStep)) {
        sendVoice(
          ws,
          renderTemplate(currentStep.text, session.lead),
          session
        );
      }

      return;
    }
  }
}

/**
 * ============================================================================
 * WEBSOCKET
 * ============================================================================
 */

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const leadId = url.searchParams.get("leadId");

  let session = leadId ? callSessions.get(leadId) : null;

  if (!session) {
    session = buildSessionFromLead({});
    console.warn("No session found for leadId. Using fallback session.");
  }

  ws.sessionLeadId = leadId || null;
  ws.sessionId = session.id;

  console.log("Twilio connected to /conversationrelay", {
    leadId,
    sessionId: session.id,
  });

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("Incoming Twilio event:", data);

      if (data.type === "setup") {
        await handleConversationStart(ws, session);
        return;
      }

      if (data.type === "prompt" && data.voicePrompt !== undefined) {
      const callerText = safeString(data.voicePrompt);
      console.log("Caller said:", callerText);

      updateSessionToneFromText(session, callerText);

        const interrupted = detectLikelyInterruption(session);
        if (interrupted) {
          note(session, "interruption", callerText);
        }

        if (session.heldSlotUtcTime) {
          extendSlotHold(session);
        }

        session.repeatCount = 0;

        if (session.shouldEndCall) {
          sendVoice(ws, "Thank you. Goodbye.", session, {
            isFollowupPrompt: true,
          });
          return;
        }

        if (!session.scriptStarted) {
          const handledPreScript = await handlePreScriptAudio(
            ws,
            session,
            callerText
          );

          if (handledPreScript) {
            return;
          }
        }

        if (detectBlankish(callerText)) {
          const handledBlank = await handleSilenceOrBlank(ws, session);
          if (handledBlank) return;
        } else {
          session.blankResponseCount = 0;
        }

        if (detectRepeatRequest(callerText)) {
          await handleRepeatRequest(ws, session);
          return;
        }

        if (detectGoodbye(callerText)) {
          session.shouldEndCall = true;
          setOutcome(session, "hangup_or_goodbye");
          releaseHeldSlotForSession(session);
          sendVoice(
            ws,
            "Alright, no problem. Have a great rest of your day.",
            session
          );
          return;
        }

        const currentStep = getCurrentStep(session);
        const stepId = currentStep?.id || "";

        const detected = detectObjection(callerText);

        const freshObjection =
          detected &&
          (detected.category === "terminal" ||
            shouldDetectObjectionsAtStep(stepId))
            ? detected
            : null;

        if (
          freshObjection &&
          freshObjection.id !== session.postObjectionSourceId &&
          freshObjection.id !== session.activeObjection
        ) {
          clearObjectionState(session);
          await handleStepResponse(ws, session, callerText);
          return;
        }

        if (session.awaitingSlotConfirmation) {
          const handledPending = await handlePendingSlotConfirmation(
            ws,
            session,
            callerText
          );
          if (handledPending) return;
        }

        if (session.awaitingCallbackTime) {
          await handleCallbackCapture(ws, session, callerText);
          return;
        }

        if (session.waitingForObjectionBranch) {
          await handleActiveObjectionBranch(ws, session, callerText);
          return;
        }

        if (session.waitingForCoverageTypeAnswer) {
          await handleCoverageTypeAnswer(ws, session, callerText);
          return;
        }

        if (session.waitingForPostObjectionAck) {
          await handlePostObjectionAck(ws, session, callerText);
          return;
        }

        await handleStepResponse(ws, session, callerText);
      }
    } catch (error) {
      console.error("WebSocket error:", error);
      releaseHeldSlotForSession(session);
      sendVoice(ws, "Sorry, something went wrong on my side.", session);
    }
  });

  ws.on("close", () => {
    if (!session.crm.final_outcome) {
      session.crm.final_outcome = session.callOutcome;
    }

    releaseHeldSlotForSession(session);

    console.log("Twilio disconnected from /conversationrelay", {
      leadId,
      sessionId: session.id,
      outcome: session.callOutcome,
    });
  });
});

/**
 * ============================================================================
 * START SERVER
 * ============================================================================
 */

validateEnv();

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Calendly Event Type:", CALENDLY_EVENT_TYPE_URI || null);
  console.log("Calendly API Key present:", Boolean(CALENDLY_API_KEY));
  console.log("Slot hold length ms:", SLOT_HOLD_MS);
});
