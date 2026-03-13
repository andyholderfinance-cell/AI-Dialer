require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");
const twilio = require("twilio");
const crypto = require("crypto");
const fetch = require("node-fetch");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

const CALLER_NAME = process.env.CALLER_NAME || "David";
const UNDERWRITER_NAME = process.env.UNDERWRITER_NAME || "Andy Holder";
const DEFAULT_STATE = process.env.DEFAULT_STATE || "Florida";
const DEFAULT_TIMEZONE = process.env.CALENDLY_TIMEZONE || "America/New_York";

const CALENDLY_API_KEY = process.env.CALENDLY_API_KEY;
const CALENDLY_EVENT_TYPE_URI = process.env.CALENDLY_EVENT_TYPE_URI;

const client = twilio(accountSid, authToken);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/conversationrelay" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * ============================================================================
 * SCRIPT + OBJECTIONS
 * ============================================================================
 */

const SCRIPT_STEPS = [
  {
    id: "intro_1",
    type: "question",
    resume_after_objection: true,
    text: "Hey, is this {{first_name}}?",
  },
  {
    id: "intro_2",
    type: "question",
    resume_after_objection: true,
    text: `Hey {{first_name}}, this is ${CALLER_NAME}, a case worker here in {{state}}. I'm calling in regards to the mortgage life and disability protection file that was opened back when you closed with {{lender}}. Does that sound familiar?`,
  },
  {
    id: "intro_3",
    type: "statement",
    resume_after_objection: true,
    text: "Okay, it looks like back when you closed on your mortgage you filled out a request for information on the plan that would pay off your mortgage or make those monthly payments for you if you were to become sick, permanently disabled, or pass away. It's showing up as incomplete or due for a review.",
  },
  {
    id: "intro_4",
    type: "question",
    resume_after_objection: true,
    text: "What they do is assign a case worker, in this case me, to get you appointed with the state underwriter so they can go over the information and see what you qualify for. Does that make sense?",
  },
  {
    id: "verify_intro",
    type: "statement",
    resume_after_objection: true,
    text: "Okay perfect, I just need to verify a few things first to make sure I have the correct information on file.",
  },
  {
    id: "verify_address",
    type: "question",
    resume_after_objection: true,
    text: "I have your address here as {{address}}. Is that correct?",
  },
  {
    id: "verify_loan",
    type: "question",
    resume_after_objection: true,
    text: "I have the total loan amount as around {{loan_amount}}. Is that correct?",
  },
  {
    id: "verify_coborrower",
    type: "question",
    resume_after_objection: true,
    text: "I don't see a co borrower on file. Is there anyone helping you pay for the home?",
  },
  {
    id: "verify_age",
    type: "question",
    resume_after_objection: true,
    text: "And I have your age here as {{age}} years young. Is that correct?",
  },
  {
    id: "underwriter_intro",
    type: "statement",
    resume_after_objection: true,
    text: `${UNDERWRITER_NAME} is the underwriter for your county. He will be able to explain mortgage protection to you, as well as share his license with the state of {{state}}. He'll answer any questions you may have, pull up options tailored specifically to you, and help you apply for coverage.`,
  },
  {
    id: "virtual_meeting",
    type: "question",
    resume_after_objection: true,
    text: "Ever since COVID we take care of families through virtual meetings. Do you prefer Zoom, or does a phone call work better for you?",
  },
  {
    id: "calendar_check",
    type: "statement",
    resume_after_objection: false,
    text: `Okay, give me just a moment to look at ${UNDERWRITER_NAME}'s calendar.`,
  },
  {
    id: "offer_times_today",
    type: "booking",
    resume_after_objection: true,
    text: "It looks like he has availability for {{slot_1_day_phrase}} at {{time_option_1}} or {{time_option_2}}. Which works best for you?",
  },
  {
    id: "offer_times_tomorrow",
    type: "booking",
    resume_after_objection: true,
    text: "Okay no worries. Do you prefer tomorrow morning or afternoon?",
  },
  {
    id: "offer_times_tomorrow_slots",
    type: "booking",
    resume_after_objection: true,
    text: "Okay, he has {{slot_3_day_phrase}} at {{time_option_3}} or {{time_option_4}}. Which works best for you?",
  },
  {
    id: "collect_email",
    type: "input",
    resume_after_objection: true,
    text: "Okay perfect, can you spell out a good email address where I can send the appointment confirmation?",
  },
  {
    id: "confirmation",
    type: "statement",
    resume_after_objection: false,
    text: "Amazing, that should be all I need. You are going to receive an email and a text message as a reminder for the appointment.",
  },
  {
    id: "reminder_instruction",
    type: "statement",
    resume_after_objection: false,
    text: `About two to four hours before the appointment, go ahead and reconfirm so ${UNDERWRITER_NAME} knows to still attend. He helps a lot of homeowners and just wants to make sure he gets to everyone.`,
  },
  {
    id: "closing",
    type: "statement",
    resume_after_objection: false,
    text: `${UNDERWRITER_NAME} will call you at {{scheduled_time}} your time. It was a pleasure speaking with you, and enjoy the rest of your day.`,
  },
];

const OBJECTION_LIBRARY = [
  {
    id: "what_is_this",
    triggers: [
      "what is this",
      "what's this about",
      "what is this about",
      "what are you talking about",
      "what is this regarding",
      "why are you calling",
      "what is this in reference to",
    ],
    action: "resume_script",
    response: [
      "It looks like back when you closed on your mortgage you filled out a request for information on the plan that would pay off your mortgage, or make those monthly payments for you if you were to become sick, disabled, or pass away.",
      "[PAUSE_3_SECONDS]",
      "It's just showing up as incomplete or due for review.",
    ],
  },
  {
    id: "not_interested",
    triggers: [
      "i'm not interested",
      "im not interested",
      "not interested",
      "no thanks",
      "i'm good",
      "im good",
      "i do not want it",
      "i dont want it",
      "don't want it",
      "do not want it",
    ],
    action: "branch_followup",
    response: [
      "Okay no worries, before I close out your file, do you already have something in place to offset the cost of your mortgage if something were to happen to you, or are you just not concerned about it?",
    ],
    branches: {
      has_coverage: {
        detect: [
          "yes",
          "yeah",
          "i do",
          "i have something",
          "already covered",
          "i already have coverage",
          "i have life insurance",
          "i have something through work",
          "covered",
        ],
        action: "ask_followup_then_resume",
        response: [
          "Okay great, and is that a personal life policy, or something specifically for the mortgage?",
        ],
      },
      not_concerned: {
        detect: [
          "not concerned",
          "don't care",
          "dont care",
          "do not care",
          "not worried about it",
          "close it out",
          "just close it out",
          "not really",
          "no",
        ],
        action: "close_file_end_call",
        response: [
          "Okay no worries, I'll go ahead and close out your file. Thank you for your time.",
        ],
      },
    },
  },
  {
    id: "already_have_insurance",
    triggers: [
      "i already have insurance",
      "i already got this taken care of",
      "i have something through work",
      "i already have life insurance",
      "i'm already covered",
      "im already covered",
      "i have a policy already",
      "i already have something in place",
    ],
    action: "resume_script",
    response: [
      "Okay great, it makes sense as to why it says due for review. My job is just to get you appointed with the state underwriter so he can go over your policy to make sure you aren't overpaying and have all the correct benefits.",
    ],
  },
  {
    id: "never_filled_anything_out",
    triggers: [
      "i never filled anything out",
      "i never filled that out",
      "i didn't fill anything out",
      "i did not fill anything out",
      "i don't remember filling that out",
      "i dont remember filling that out",
      "i never requested that",
    ],
    action: "resume_script",
    response: [
      "No worries, most people don't remember. It might have been a while ago. We've been backed up due to COVID and layoffs, so we're just reaching back out to everyone we missed.",
    ],
  },
  {
    id: "do_not_call",
    triggers: [
      "stop calling me",
      "take me off your call list",
      "remove me from your list",
      "don't call me again",
      "dont call me again",
      "do not call me again",
      "i already said no to this",
      "quit calling me",
    ],
    action: "end_call",
    response: [
      "Oh okay, sorry about that. I'll go ahead and close this out for you. Have a great day.",
    ],
  },
];

/**
 * ============================================================================
 * SESSION STORE
 * ============================================================================
 */

const callSessions = new Map();

/**
 * ============================================================================
 * HELPERS
 * ============================================================================
 */

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

function renderTemplate(text, lead) {
  return safeString(text).replace(/\{\{(.*?)\}\}/g, (_, key) => {
    const cleanKey = key.trim();
    return lead[cleanKey] !== undefined && lead[cleanKey] !== null
      ? String(lead[cleanKey])
      : "";
  });
}

function inferTimezoneFromState(state) {
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

  return map[s] || DEFAULT_TIMEZONE;
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

function buildSessionFromLead(lead = {}) {
  const timezone =
    lead.timezone || inferTimezoneFromState(lead.state || lead.state_code);

  const stateValue = lead.state_code || lead.state || DEFAULT_STATE;

  const sessionLead = {
    first_name: lead.first_name || "there",
    full_name: lead.full_name || lead.first_name || "Homeowner",
    phone: lead.phone || "",
    lender: lead.lender || "your lender",
    loan_amount: lead.loan_amount || "the amount on file",
    age: lead.age || "the age on file",
    address: lead.address || "the address on file",
    co_borrower: lead.co_borrower || "",
    state: stateValue,
    email: lead.email || "",
    meeting_type: lead.meeting_type || "",
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
    language: lead.language || "English",
    booked_by: lead.booked_by || CALLER_NAME,
  };

  return {
    id: randomId(),
    callSid: null,
    lead: sessionLead,
    currentStepIndex: 0,
    lastQuestionStepIndex: 0,
    activeObjection: null,
    waitingForObjectionBranch: false,
    waitingForCoverageTypeAnswer: false,
    shouldEndCall: false,
    calendlyReady: false,
    availableSlots: [],
    pendingChosenSlot: null,
    notes: [],
    createdAt: Date.now(),
  };
}

function getCurrentStep(session) {
  return SCRIPT_STEPS[session.currentStepIndex] || null;
}

function isQuestionLike(step) {
  return step && ["question", "input", "booking"].includes(step.type);
}

function buildPromptFromCurrentStep(session) {
  const parts = [];
  let idx = session.currentStepIndex;

  while (idx < SCRIPT_STEPS.length) {
    const step = SCRIPT_STEPS[idx];
    parts.push(renderTemplate(step.text, session.lead));

    if (isQuestionLike(step)) {
      session.lastQuestionStepIndex = idx;
      break;
    }

    idx += 1;
    if (idx >= SCRIPT_STEPS.length) break;
  }

  return parts.join(" ");
}

function advanceToNextStep(session) {
  session.currentStepIndex += 1;
  return getCurrentStep(session);
}

function rewindToLastQuestion(session) {
  session.currentStepIndex = session.lastQuestionStepIndex || session.currentStepIndex;
}

function extractEmail(text) {
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const match = safeString(text).match(emailRegex);
  return match ? match[0] : null;
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

function detectZoomPreference(text) {
  const t = normalizeText(text);
  if (t.includes("zoom")) return "Zoom";
  if (t.includes("phone")) return "Phone";
  if (t.includes("call")) return "Phone";
  return "";
}

function detectMorningAfternoon(text) {
  const t = normalizeText(text);
  if (t.includes("morning")) return "morning";
  if (t.includes("afternoon")) return "afternoon";
  return "";
}

function detectObjection(text) {
  const t = normalizeText(text);

  for (const objection of OBJECTION_LIBRARY) {
    for (const trigger of objection.triggers) {
      if (t.includes(normalizeText(trigger))) {
        return objection;
      }
    }
  }

  return null;
}

function detectObjectionBranch(text, objection) {
  if (!objection || !objection.branches) return null;

  const t = normalizeText(text);

  for (const [branchName, branch] of Object.entries(objection.branches)) {
    for (const trigger of branch.detect) {
      if (t.includes(normalizeText(trigger))) {
        return { branchName, branch };
      }
    }
  }

  return null;
}

function formatObjectionResponse(lines) {
  return lines
    .map((line) => (line === "[PAUSE_3_SECONDS]" ? "..." : line))
    .join(" ");
}

function buildVoiceMessage(text) {
  return JSON.stringify({
    type: "text",
    token: text,
    last: true,
  });
}

function sendVoice(ws, text) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(buildVoiceMessage(text));
  }
}

function chooseSlotFromResponse(text, session, pair = "first") {
  const t = normalizeText(text);

  const options =
    pair === "first"
      ? [session.availableSlots[0], session.availableSlots[1]]
      : [session.availableSlots[2], session.availableSlots[3]];

  const [a, b] = options;

  if (a && t.includes(normalizeText(a.localTime))) return a;
  if (b && t.includes(normalizeText(b.localTime))) return b;
  if (a && (t.includes("first") || t.includes("earlier"))) return a;
  if (b && (t.includes("second") || t.includes("later"))) return b;

  return null;
}

/**
 * ============================================================================
 * CALENDLY
 * ============================================================================
 */

async function calendlyFetch(path, options = {}) {
  if (!CALENDLY_API_KEY) {
    throw new Error("Missing CALENDLY_API_KEY");
  }

  const response = await fetch(`https://api.calendly.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CALENDLY_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Calendly ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function getCalendlyAvailableTimes(eventTypeUri, timezone) {
  const now = new Date();
  const start = new Date(now.getTime() + 5 * 60 * 1000);
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    event_type: eventTypeUri,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
  });

  const data = await calendlyFetch(`/event_type_available_times?${params.toString()}`);

  const collection = Array.isArray(data.collection) ? data.collection : [];

  return collection.slice(0, 6).map((slot) => {
    const utcTime = slot.start_time || slot.start || slot.time;
    return {
      raw: slot,
      utcTime,
      timezone,
      localTime: formatLocalTime(utcTime, timezone),
      dayPhrase: formatLocalDayPhrase(utcTime, timezone),
    };
  });
}

function buildCalendlyQuestionsAndAnswers(session) {
  return [
    { question: "Phone Number:", answer: safeString(session.lead.phone), position: 0 },
    { question: "State:", answer: safeString(session.lead.state), position: 1 },
    { question: "Original Mortgage Loan Amount:", answer: safeString(session.lead.loan_amount), position: 2 },
    { question: "Lender:", answer: safeString(session.lead.lender), position: 3 },
    { question: "Address:", answer: safeString(session.lead.address), position: 4 },
    { question: "Age:", answer: safeString(session.lead.age), position: 5 },
    { question: "Policy Review?", answer: safeString(session.lead.policy_review || "No"), position: 6 },
    { question: "ONLY If Its a Policy Review\\nCarrier:\\nCoverage:\\nPremium:\\nProduct:", answer: safeString(session.lead.coverage || ""), position: 7 },
    { question: "Language:", answer: safeString(session.lead.language || "English"), position: 8 },
    { question: "Booked By:", answer: safeString(session.lead.booked_by || CALLER_NAME), position: 9 },
  ];
}

function buildCalendlyLocation(session) {
  if (session.lead.meeting_type === "Zoom") {
    return { kind: "zoom_conference" };
  }

  return {
    kind: "outbound_call",
    location: safeString(session.lead.phone),
  };
}

async function createCalendlyInvitee(session) {
  if (!CALENDLY_EVENT_TYPE_URI) {
    throw new Error("Missing CALENDLY_EVENT_TYPE_URI");
  }

  if (!session.pendingChosenSlot?.utcTime) {
    throw new Error("No selected Calendly slot");
  }

  if (!session.lead.email) {
    throw new Error("Missing invitee email");
  }

  const payload = {
    event_type: CALENDLY_EVENT_TYPE_URI,
    start_time: session.pendingChosenSlot.utcTime,
    invitee: {
      name: safeString(session.lead.full_name || session.lead.first_name),
      first_name: safeString(session.lead.first_name),
      email: safeString(session.lead.email),
      timezone: safeString(session.lead.timezone || DEFAULT_TIMEZONE),
    },
    location: buildCalendlyLocation(session),
    questions_and_answers: buildCalendlyQuestionsAndAnswers(session),
  };

  if (session.lead.phone) {
    payload.invitee.text_reminder_number = safeString(session.lead.phone);
  }

  return calendlyFetch("/invitees", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * ============================================================================
 * AI FALLBACK
 * ============================================================================
 */

async function getFallbackAIReply(session, callerText) {
  try {
    const aiResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `
You are a calm, professional mortgage protection appointment setter.

Rules:
- Be concise.
- Sound human and conversational.
- Do not mention AI.
- Do not invent company names or product details.
- If possible, guide the caller back to the current step.

Current step: ${safeString(getCurrentStep(session)?.id)}
Lead: ${JSON.stringify(session.lead)}
`,
        },
        {
          role: "user",
          content: callerText,
        },
      ],
    });

    return aiResponse.output_text || "Sorry, I didn't catch that. Could you repeat that for me?";
  } catch (error) {
    console.error("Fallback AI error:", error);
    return "Sorry, I didn't catch that. Could you repeat that for me?";
  }
}

/**
 * ============================================================================
 * ROUTES
 * ============================================================================
 */

app.get("/", (req, res) => {
  res.send("AI dialer is running.");
});

app.post("/voice", (req, res) => {
  const host = req.headers.host;
  const leadId = req.query.leadId || "";

  const twiml = `
<Response>
  <Connect>
    <ConversationRelay url="wss://${host}/conversationrelay?leadId=${leadId}" />
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
      first_name: "John",
      full_name: "John Test",
      lender: "Wells Fargo",
      state: "FL",
      address: "123 Oak Ridge Drive",
      loan_amount: "$286,000",
      age: "41",
      email: process.env.TEST_DIAL_EMAIL || "",
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
 * CALL FLOW
 * ============================================================================
 */

async function primeCalendlySlots(session) {
  if (session.calendlyReady) return;

  if (!CALENDLY_API_KEY || !CALENDLY_EVENT_TYPE_URI) {
    throw new Error("Calendly env vars are missing");
  }

  const slots = await getCalendlyAvailableTimes(
    CALENDLY_EVENT_TYPE_URI,
    session.lead.timezone
  );

  if (!slots.length) {
    throw new Error("No Calendly slots available");
  }

  session.availableSlots = slots;
  session.calendlyReady = true;

  if (slots[0]) {
    session.lead.time_option_1 = slots[0].localTime;
    session.lead.slot_1_day_phrase = slots[0].dayPhrase;
  }
  if (slots[1]) {
    session.lead.time_option_2 = slots[1].localTime;
    session.lead.slot_2_day_phrase = slots[1].dayPhrase;
  }
  if (slots[2]) {
    session.lead.time_option_3 = slots[2].localTime;
    session.lead.slot_3_day_phrase = slots[2].dayPhrase;
  }
  if (slots[3]) {
    session.lead.time_option_4 = slots[3].localTime;
    session.lead.slot_4_day_phrase = slots[3].dayPhrase;
  }
}

async function handleConversationStart(ws, session) {
  const openingPrompt = buildPromptFromCurrentStep(session);
  sendVoice(ws, openingPrompt);
}

async function handleActiveObjectionBranch(ws, session, callerText) {
  const objection = OBJECTION_LIBRARY.find((o) => o.id === session.activeObjection);

  if (!objection) {
    session.activeObjection = null;
    session.waitingForObjectionBranch = false;
    rewindToLastQuestion(session);
    sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
    return;
  }

  const branchMatch = detectObjectionBranch(callerText, objection);

  if (!branchMatch) {
    sendVoice(
      ws,
      "Just so I handle this correctly, do you already have something in place, or are you not concerned about it?"
    );
    return;
  }

  const { branchName, branch } = branchMatch;

  if (branchName === "has_coverage") {
    session.waitingForObjectionBranch = false;
    session.waitingForCoverageTypeAnswer = true;
    sendVoice(ws, formatObjectionResponse(branch.response));
    return;
  }

  if (branchName === "not_concerned") {
    session.shouldEndCall = true;
    sendVoice(ws, formatObjectionResponse(branch.response));
    return;
  }
}

async function handleCoverageTypeAnswer(ws, session, callerText) {
  session.notes.push({
    type: "coverage_type_answer",
    value: callerText,
    at: Date.now(),
  });

  session.lead.policy_review = "Yes";
  session.lead.coverage = callerText;

  session.waitingForCoverageTypeAnswer = false;
  rewindToLastQuestion(session);

  const objectionBridge =
    "Got it. As long as you have something in place, that's exactly why the review is helpful.";

  const resumePrompt = renderTemplate(getCurrentStep(session).text, session.lead);
  sendVoice(ws, `${objectionBridge} ${resumePrompt}`);
}

async function handleStepResponse(ws, session, callerText) {
  const step = getCurrentStep(session);
  if (!step) {
    session.shouldEndCall = true;
    sendVoice(ws, "Thank you again. Have a great day.");
    return;
  }

  const text = safeString(callerText);
  const normalized = normalizeText(text);

  const matchedObjection = detectObjection(text);
  if (matchedObjection) {
    if (matchedObjection.action === "end_call") {
      session.shouldEndCall = true;
      sendVoice(ws, formatObjectionResponse(matchedObjection.response));
      return;
    }

    if (matchedObjection.action === "resume_script") {
      const objectionReply = formatObjectionResponse(matchedObjection.response);
      const resumePrompt = step.resume_after_objection
        ? ` ${renderTemplate(step.text, session.lead)}`
        : "";
      sendVoice(ws, objectionReply + resumePrompt);
      return;
    }

    if (matchedObjection.action === "branch_followup") {
      session.activeObjection = matchedObjection.id;
      session.waitingForObjectionBranch = true;
      sendVoice(ws, formatObjectionResponse(matchedObjection.response));
      return;
    }
  }

  switch (step.id) {
    case "intro_1":
    case "intro_2":
    case "intro_4": {
      advanceToNextStep(session);
      sendVoice(ws, buildPromptFromCurrentStep(session));
      return;
    }

    case "verify_address": {
      if (detectNo(text)) {
        session.notes.push({ type: "address_mismatch", value: callerText, at: Date.now() });
      }
      advanceToNextStep(session);
      sendVoice(ws, buildPromptFromCurrentStep(session));
      return;
    }

    case "verify_loan": {
      if (detectNo(text)) {
        session.notes.push({ type: "loan_mismatch", value: callerText, at: Date.now() });
      }
      advanceToNextStep(session);
      sendVoice(ws, buildPromptFromCurrentStep(session));
      return;
    }

    case "verify_coborrower": {
      session.lead.co_borrower = normalized.includes("no") ? "No" : callerText;
      advanceToNextStep(session);
      sendVoice(ws, buildPromptFromCurrentStep(session));
      return;
    }

    case "verify_age": {
      if (detectNo(text)) {
        session.notes.push({ type: "age_mismatch", value: callerText, at: Date.now() });
      }
      advanceToNextStep(session);
      sendVoice(ws, buildPromptFromCurrentStep(session));
      return;
    }

    case "virtual_meeting": {
      session.lead.meeting_type = detectZoomPreference(text) || "Phone";
      advanceToNextStep(session);
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));

      try {
        await primeCalendlySlots(session);
        session.currentStepIndex = SCRIPT_STEPS.findIndex((s) => s.id === "offer_times_today");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
      } catch (error) {
        console.error("Calendly availability error:", error.message);
        session.currentStepIndex = SCRIPT_STEPS.findIndex((s) => s.id === "collect_email");
        sendVoice(
          ws,
          "It looks like the calendar is updating on my end. Let me grab a good email address and we'll send over the best available time."
        );
      }
      return;
    }

    case "offer_times_today": {
      if (
        normalized.includes("tomorrow") ||
        normalized.includes("not today") ||
        normalized === "no"
      ) {
        session.currentStepIndex = SCRIPT_STEPS.findIndex((s) => s.id === "offer_times_tomorrow");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
        return;
      }

      const chosen = chooseSlotFromResponse(text, session, "first");
      if (chosen) {
        session.pendingChosenSlot = chosen;
        session.lead.scheduled_time = chosen.localTime;
        session.lead.scheduled_time_utc = chosen.utcTime;
        session.currentStepIndex = SCRIPT_STEPS.findIndex((s) => s.id === "collect_email");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
        return;
      }

      sendVoice(
        ws,
        `No problem. I have ${session.lead.slot_1_day_phrase} at ${session.lead.time_option_1} or ${session.lead.time_option_2}. Which works better for you?`
      );
      return;
    }

    case "offer_times_tomorrow": {
      const pref = detectMorningAfternoon(text);
      session.notes.push({
        type: "tomorrow_preference",
        value: pref || callerText,
        at: Date.now(),
      });

      session.currentStepIndex = SCRIPT_STEPS.findIndex(
        (s) => s.id === "offer_times_tomorrow_slots"
      );
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
      return;
    }

    case "offer_times_tomorrow_slots": {
      const chosen = chooseSlotFromResponse(text, session, "second");
      if (chosen) {
        session.pendingChosenSlot = chosen;
        session.lead.scheduled_time = chosen.localTime;
        session.lead.scheduled_time_utc = chosen.utcTime;
        session.currentStepIndex = SCRIPT_STEPS.findIndex((s) => s.id === "collect_email");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
        return;
      }

      sendVoice(
        ws,
        `The next two times I have are ${session.lead.slot_3_day_phrase} at ${session.lead.time_option_3} or ${session.lead.time_option_4}. Which works better for you?`
      );
      return;
    }

    case "collect_email": {
      const email = extractEmail(text);
      session.lead.email = email || callerText;

      try {
        const booking = await createCalendlyInvitee(session);

        session.notes.push({
          type: "calendly_booking",
          value: booking,
          at: Date.now(),
        });

        advanceToNextStep(session);

        const confirmationBundle = buildPromptFromCurrentStep(session);
        session.shouldEndCall = true;
        sendVoice(ws, confirmationBundle);
      } catch (error) {
        console.error("Calendly booking error:", error.message);

        sendVoice(
          ws,
          "I have everything I need, but the calendar didn't save on my side just yet. I'll have the confirmation sent over manually so you don't lose the spot."
        );
        session.shouldEndCall = true;
      }
      return;
    }

    default: {
      const fallback = await getFallbackAIReply(session, callerText);
      sendVoice(ws, fallback);
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

      if (data.type === "prompt" && data.voicePrompt) {
        const callerText = data.voicePrompt;
        console.log("Caller said:", callerText);

        if (session.shouldEndCall) {
          sendVoice(ws, "Thank you. Goodbye.");
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

        await handleStepResponse(ws, session, callerText);
      }
    } catch (error) {
      console.error("WebSocket error:", error);
      sendVoice(ws, "Sorry, something went wrong on my side.");
    }
  });

  ws.on("close", () => {
    console.log("Twilio disconnected from /conversationrelay", {
      leadId,
      sessionId: session.id,
    });
  });
});

/**
 * ============================================================================
 * START SERVER
 * ============================================================================
 */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
