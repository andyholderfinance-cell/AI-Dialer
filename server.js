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

const CALLER_NAME = process.env.CALLER_NAME || "Josh";
const UNDERWRITER_NAME = process.env.UNDERWRITER_NAME || "Andy";
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

const VOICE_STYLE_INSTRUCTIONS = `
You are a human-sounding mortgage protection case worker and appointment setter.

Your tone must sound:
- calm
- slow
- natural
- warm
- conversational
- lightly concerned like you are looking at a file
- never robotic
- never polished like an announcer
- never salesy

Tone rules:
- Speak like a real person on the phone.
- Use short natural phrasing.
- Occasionally use filler words lightly like "um", "uh", "let me see", "okay", "just a second".
- Do not overuse filler words.
- Stay polite and relaxed.
- Never sound pushy, aggressive, scripted, or overly excited.
- Do not use long speeches.
- Keep clarifications short.
`;

/**
 * ============================================================================
 * SCRIPT
 * ============================================================================
 */

const SCRIPT_STEPS = [
  {
    id: "intro_1",
    type: "question",
    text: "Hey, {{first_name}}?",
  },
  {
    id: "intro_2",
    type: "question",
    text: `Hey {{first_name}}, this is ${CALLER_NAME}. I'm just giving you a quick call about the mortgage protection information tied to your home loan with {{lender}}... Does that ring a bell?`,
  },
  {
    id: "intro_3",
    type: "statement",
    text: "Okay, from what I'm seeing here, it was a request for information on the plan that would pay off your mortgage, or make those monthly payments for you if you were to become sick, disabled, or passed away. Its just showing up as incomplete or due for review.",
  },
  {
    id: "intro_4",
    type: "question",
    text: `My job is just to verify the information and get you appointed with the state underwriter, so he can go over your options. Does that make sense?`,
  },
  {
    id: "verify_intro",
    type: "statement",
    text: "Perfect, I just need to verify a couple things so I know I'm looking at the right file.",
  },
  {
    id: "verify_address",
    type: "question",
    text: "I have your address here as {{address}}. Is that correct?",
  },
  {
    id: "verify_address_update",
    type: "input",
    text: "Okay, what is the correct address?",
  },
  {
    id: "verify_loan",
    type: "question",
    text: "Got it. I also have the loan amount as around {{loan_amount}}. Is that correct?",
  },
  {
    id: "verify_loan_update",
    type: "input",
    text: "Okay, what is the correct loan amount roughly?",
  },
  {
    id: "verify_coborrower",
    type: "question",
    text: "And do you have anyone helping you with the home, like a co borrower or co owner?",
  },
  {
    id: "verify_age",
    type: "question",
    text: "Okay, and I have your age as {{age}}. Is that still correct?",
  },
  {
    id: "verify_age_update",
    type: "input",
    text: "Okay, what is your current age?",
  },
  {
    id: "underwriter_intro",
    type: "statement",
    text: `Perfect. So, ${UNDERWRITER_NAME} is the underwriter for your county. He can go over the mortgage protection information with you, answer any questions, and pull up some options based on your needs.`,
  },
  {
    id: "virtual_meeting",
    type: "question",
    text: "Ever since covid, we handle appointments by phone or Zoom. Which do you prefer?",
  },
  {
    id: "calendar_check",
    type: "statement",
    text: `Okay, give me just a moment while I check ${UNDERWRITER_NAME}'s calendar.`,
  },
  {
    id: "offer_times_today",
    type: "booking",
    text: "It looks like he has {{slot_1_day_phrase}} at {{time_option_1}} or {{time_option_2}}. Which works better for you?",
  },
  {
    id: "offer_times_tomorrow",
    type: "booking",
    text: "No worries. Would tomorrow morning or afternoon be better?",
  },
  {
    id: "offer_times_tomorrow_slots",
    type: "booking",
    text: "Okay, the next openings I have are {{slot_3_day_phrase}} at {{time_option_3}} or {{time_option_4}}. Which works better?",
  },
  {
    id: "collect_email",
    type: "input",
    text: "Perfect, what is a good email address for the appointment confirmation?",
  },
  {
    id: "confirmation",
    type: "statement",
    text: "Perfect, that should be all I need. You'll get an email and a text reminder for the appointment.",
  },
  {
    id: "reminder_instruction",
    type: "statement",
    text: `A couple hours before the appointment, just reconfirm so ${UNDERWRITER_NAME} knows you're still good to go.`,
  },
  {
    id: "closing",
    type: "statement",
    text: `${UNDERWRITER_NAME} will call you at {{scheduled_time}} your time. Appreciate you, and enjoy the rest of your day.`,
  },
];

/**
 * ============================================================================
 * OBJECTIONS
 * ============================================================================
 */

const OBJECTION_LIBRARY = [
  {
    id: "what_is_this",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "what is this",
      "what's this",
      "what is this about",
      "what's this about",
      "what are you talking about",
      "what is this regarding",
      "what is this in reference to",
      "why are you calling",
      "why did you call",
      "what are you calling about",
      "what is this for",
      "what exactly is this",
      "what is this call about",
      "what are you referring to",
      "what file",
      "what do you mean",
      "what is this in regards to",
      "what is this all about",
    ],
    response: [
      "Yea, this is just about the mortgage protection file tied to the home.",
      "[PAUSE_3_SECONDS]",
      "From what I'm seeing, it never got fully reviewed on my end.",
    ],
  },
  {
    id: "how_did_you_get_my_info",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "how did you get my information",
      "how did you get my info",
      "how did you get this number",
      "how did you get my number",
      "where did you get my number",
      "where did you get my information",
      "where did you get my info",
      "how do you have my information",
      "how do you have my number",
      "where are you getting this from",
    ],
    response: [
      "From what I'm seeing here, it was tied to the mortgage file from when the home was closed, and I'm just the case worker assigned to review it on my end.",
    ],
  },
  {
    id: "is_this_a_scam",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "is this a scam",
      "this sounds like a scam",
      "are you a scam",
      "sounds like a scam",
      "is this legit",
      "is this real",
      "how do i know this is real",
      "how do i know this is legit",
      "you sound fake",
      "this doesnt sound real",
      "this doesn't sound real",
    ],
    response: [
      "No, I get why you'd ask. I'm just calling about the mortgage protection file tied to the home, and my job is to verify the information and get you scheduled if you want to review it.",
    ],
  },
  {
    id: "cost",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "how much does this cost",
      "how much is it",
      "what does it cost",
      "what is the cost",
      "the cost",
      "price",
      "pricing",
      "too expensive",
      "how much",
      "what's the price",
      "premium",
      "how much per month",
      "monthly premium",
      "monthly payment",
    ],
    response: [
      "The underwriter would be the one to show you the options, because that depends on your age, health, and what you want in place.",
    ],
  },
  {
    id: "mandatory",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "is this mandatory",
      "is this required",
      "do i have to do this",
      "do i need to do this",
      "do i have to have this",
      "is this required for the mortgage",
      "is this necessary",
    ],
    response: [
      "No, not at all. I'm just checking whether you were able to get something in place or if you still wanted to review it.",
    ],
  },
  {
    id: "who_do_you_work_for",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "who do you work for",
      "who are you with",
      "what company are you with",
      "what company do you work for",
      "who do you represent",
      "where are you calling from",
      "what company is this",
    ],
    response: [
      "I work under the underwriter assigned to the file. We are not tied to just one company.",
    ],
  },
  {
    id: "email_it",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "can you just email it to me",
      "just email it to me",
      "email it to me",
      "send me something",
      "send it to me",
      "email me the info",
      "can you text it to me",
      "just text me",
      "send it over",
    ],
    response: [
      "I can send the appointment details, but the actual options depend on your age, health, and what you need, which is why we set the review.",
    ],
  },
  {
    id: "are_you_selling",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "are you trying to sell me something",
      "are you selling me insurance",
      "is this a sales call",
      "are you selling something",
      "is this some kind of sales call",
      "are you pitching me something",
      "is this a solicitation",
    ],
    response: [
      "No, I'm not trying to sell you anything on this call. My job is just to verify the file and get you in front of the underwriter if you want to review it.",
    ],
  },
  {
    id: "call_back",
    category: "recoverable",
    action: "callback_branch",
    triggers: [
      "can you call me back",
      "call me back",
      "i'll call you back",
      "call me later",
      "can we do this later",
      "can we talk later",
      "i'm busy",
      "im busy",
      "i can't talk right now",
      "i cant talk right now",
      "not a good time",
      "this is a bad time",
      "i'm at work",
      "im at work",
      "give me a call later",
    ],
    response: [
      "Yea, of course. No decisions are being made on this call. I'm really just trying to find a better time for you.",
    ],
  },
  {
    id: "who_are_you",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "who are you",
      "what's your name",
      "what is your name",
      "who is this",
      "who am i speaking with",
      "what was your name",
      "say your name again",
      "who's this",
    ],
    response: [
      `Of course, this is ${CALLER_NAME}. I'm the case worker assigned to your mortgage protection file on my end.`,
    ],
  },
  {
    id: "qualify",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "i don't think i'd qualify",
      "i dont think id qualify",
      "would i qualify",
      "qualify",
      "qualification",
      "would i even qualify",
      "i probably wouldn't qualify",
      "not sure if i qualify",
      "would i be approved",
    ],
    response: [
      "A lot of people feel that way at first. That's exactly why the underwriter checks multiple options instead of just one.",
    ],
  },
  {
    id: "no_mortgage",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "i don't have a mortgage",
      "i dont have a mortgage",
      "my house is paid off",
      "my home is paid off",
      "house is paid off",
      "home is paid off",
      "i paid it off",
      "it's paid off",
      "its paid off",
      "mortgage is paid off",
      "there is no mortgage",
      "i own it outright",
    ],
    response: [
      "Okay, no worries. Let me just note that here. Even if the mortgage is paid off, some people still review personal protection options depending on what they want it for.",
    ],
  },
  {
    id: "not_interested",
    category: "recoverable",
    action: "branch_followup",
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
      "i'm all set",
      "im all set",
      "not really interested",
      "not for me",
      "i'm fine",
      "im fine",
      "i dont need it",
      "i don't need it",
      "i'm not looking for anything",
      "im not looking for anything",
      "no thank you",
      "i'll pass",
    ],
    response: [
      "Okay, no problem. I just want to update the file correctly. Is that mainly because of cost, because you're not sure you'd qualify, or you just don't want to go over it?",
    ],
    branches: {
      cost_or_qualify: {
        detect: [
          "cost",
          "price",
          "pricing",
          "too expensive",
          "qualify",
          "qualification",
          "i don't think i'd qualify",
          "i dont think id qualify",
          "not sure i qualify",
          "i probably wouldn't qualify",
        ],
        response: [
          "Totally fair. The underwriter would be the one to go over that with you and show what options are actually available.",
        ],
      },
      still_not_interested: {
        detect: [
          "still not interested",
          "not interested",
          "no",
          "nope",
          "just not interested",
          "i'm good",
          "im good",
          "i'm okay",
          "im okay",
          "no thank you",
          "i'll pass",
        ],
        response: [
          "Okay, no worries. Before I close the file out, do you already have something in place for the home if something were to happen to you, or are you just not concerned about it?",
        ],
      },
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
          "i have insurance",
          "i have a policy",
          "i have coverage",
          "i have something in place",
          "i'm covered",
          "im covered",
        ],
        response: [
          "Okay great, and is that a personal life policy, something through work, or something specifically for the mortgage?",
        ],
      },
      not_concerned: {
        detect: [
          "not concerned",
          "don't care",
          "dont care",
          "not worried about it",
          "close it out",
          "just close it out",
          "not really",
          "leave it alone",
          "i dont care",
          "i don't care",
        ],
        response: [
          "Okay, no worries. I'll go ahead and close out your file. Thank you for your time.",
        ],
      },
    },
  },
  {
    id: "already_have_insurance",
    category: "recoverable",
    action: "existing_coverage_branch",
    triggers: [
      "i already have insurance",
      "i already got this taken care of",
      "i have something through work",
      "i already have life insurance",
      "i'm already covered",
      "im already covered",
      "i already have something in place",
      "i already have coverage",
      "i've already got coverage",
      "ive already got coverage",
      "i already handled that",
      "i'm covered",
      "im covered",
      "i have insurance through work",
      "i have a policy",
      "i got life insurance",
      "i'm good on insurance",
      "im good on insurance",
    ],
    response: [
      "Okay great. Is that a personal policy, something through work, or something specifically set up for the mortgage?",
    ],
  },
  {
    id: "never_filled_anything_out",
    category: "recoverable",
    action: "resume_script_next_step",
    triggers: [
      "i never filled anything out",
      "i never filled that out",
      "i didn't fill anything out",
      "i did not fill anything out",
      "i don't remember filling that out",
      "i dont remember filling that out",
      "i don't remember that",
      "i dont remember that",
      "i don't remember doing that",
      "i dont remember doing that",
      "i don't recall filling this out",
      "i dont recall filling this out",
      "i never requested that",
      "i never asked for that",
      "i don't remember applying",
      "i dont remember applying",
      "i never applied for that",
      "i didnt apply for that",
      "i never signed up for that",
    ],
    response: [
      "No worries, most people don't remember right away, especially if it's been a while. I'm just reaching back out to make sure the file got handled correctly.",
    ],
  },
  {
    id: "do_not_call",
    category: "terminal",
    action: "end_call",
    triggers: [
      "stop calling me",
      "take me off your call list",
      "remove me from your list",
      "don't call me again",
      "dont call me again",
      "do not call me again",
      "quit calling me",
      "put me on do not call",
      "take me off the list",
      "remove me",
      "stop calling",
      "leave me alone",
      "take me off",
      "put me on the do not call list",
    ],
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

function detectCoverageType(text) {
  const t = normalizeText(text);

  if (containsAny(t, ["through work", "work policy", "job", "employer"])) {
    return "work";
  }
  if (containsAny(t, ["mortgage", "specifically for the mortgage", "home loan"])) {
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

function detectBlankish(text) {
  const t = normalizeText(text);
  return !t || ["uh", "um", "hmm", "mm", "huh"].includes(t);
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
    loan_amount_numeric: null,
    age: lead.age || "the age on file",
    age_numeric: null,
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
    coverage_type: "",
    language: lead.language || "English",
    booked_by: lead.booked_by || CALLER_NAME,
    lead_type: lead.lead_type || "aged", // fresh | aged | warm
    no_mortgage: "No",
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
    pendingChosenSlot: null,
    notes: [],
    createdAt: Date.now(),

    screeningState: "unknown",
    screeningCount: 0,
    scriptStarted: false,

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

    crm: {
      corrected_address: "",
      corrected_age: "",
      corrected_age_numeric: null,
      corrected_loan_amount: "",
      corrected_loan_amount_numeric: null,
      callback_time: "",
      callback_reason: "",
      objection_history: [],
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
  }

  session.currentStepIndex = questionStepIndex;
  return parts.join(" ");
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
  if (!t) return null;

  for (const objection of OBJECTION_LIBRARY) {
    for (const trigger of objection.triggers) {
      const normalizedTrigger = normalizeText(trigger);
      if (t.includes(normalizedTrigger) || normalizedTrigger.includes(t)) {
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
      const normalizedTrigger = normalizeText(trigger);
      if (t.includes(normalizedTrigger) || normalizedTrigger.includes(t)) {
        return { branchName, branch };
      }
    }
  }

  if (
    objection.id === "not_interested" &&
    ((t.includes("insurance") || t.includes("policy") || t.includes("covered")) &&
      !t.includes("not"))
  ) {
    return {
      branchName: "has_coverage",
      branch: objection.branches.has_coverage,
    };
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

function sendVoice(ws, text, session = null, options = {}) {
  if (session) {
    session.lastBotMessage = text;

    if (!options.isFollowupPrompt && isMeaningfulFollowupText(text)) {
      session.lastMeaningfulBotMessage = text;
      session.lastMeaningfulBotStepId = safeString(getCurrentStep(session)?.id);
    }
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(buildVoiceMessage(text));
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
    who_do_you_work_FOR:
      "I work under the underwriter assigned to the file, so we are not tied to just one company.",
    who_do_you_work_for:
      "I work under the underwriter assigned to the file, so we are not tied to just one company.",
    email_it:
      "I can send the appointment details, but the actual options depend on your age, health, and what you need.",
    are_you_selling:
      "No, this call is just to verify the file and see if you want to review it with the underwriter.",
    call_back:
      "This call is really just to find a better time that works for you.",
    who_are_you:
      `This is ${CALLER_NAME}, the case worker assigned to the file on my end.`,
    qualify:
      "A lot of people think that at first, which is why the underwriter checks multiple options.",
    no_mortgage:
      "Even if the mortgage is paid off, some people still review personal protection depending on what they want it for.",
    already_have_insurance:
      "The review is just to make sure what you already have still fits what you need and that you're not overpaying.",
    never_filled_anything_out:
      "A lot of people do not remember because it may have been tied to the home closing a while back.",
    unknown:
      "I'm just trying to make sure I'm looking at the right file and explaining it clearly on my end.",
  };

  return (
    map[stepId] ||
    "I'm just trying to make sure I'm looking at the right file and explaining it clearly on my end."
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
    intro_4: `My job is just to verify the information and get you lined up with ${UNDERWRITER_NAME} if you want to go over it.`,
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
    offer_times_today: renderTemplate(
      "I have {{slot_1_day_phrase}} at {{time_option_1}} or {{time_option_2}}.",
      session.lead
    ),
    offer_times_tomorrow_slots: renderTemplate(
      "I have {{slot_3_day_phrase}} at {{time_option_3}} or {{time_option_4}}.",
      session.lead
    ),
    collect_email: "What is a good email address for the appointment confirmation?",
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
  if (containsAny(t, ["busy", "bad time", "cant talk", "can't talk"])) return "busy";
  if (containsAny(t, ["call me later", "call back"])) return "asked_for_callback";

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

function resumeAfterObjection(ws, session) {
  const returnStepId = session.objectionReturnStepId;
  const currentReturnIndex = getStepIndexById(returnStepId);
  const resolvedId =
    session.postObjectionSourceId || session.activeObjection || session.lastResolvedObjectionId || null;

  session.lastResolvedObjectionId = resolvedId;
  session.objectionReturnStepId = null;
  clearObjectionState(session);

  if (resolvedId === "no_mortgage") {
    session.lead.no_mortgage = "Yes";
    session.crm.no_mortgage = "Yes";
    note(session, "no_mortgage", true);

    if (returnStepId === "verify_address" || returnStepId === "verify_loan") {
      session.currentStepIndex = getStepIndexById("verify_coborrower");
      sendVoice(
        ws,
        renderTemplate(getCurrentStep(session).text, session.lead),
        session
      );
      return;
    }
  }

  if (returnStepId === "verify_address") {
    session.currentStepIndex = getStepIndexById("verify_loan");
    sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
    return;
  }

  if (returnStepId === "verify_loan") {
    session.currentStepIndex = getStepIndexById("verify_coborrower");
    sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
    return;
  }

  if (returnStepId === "verify_coborrower") {
    session.currentStepIndex = getStepIndexById("verify_age");
    sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
    return;
  }

  if (returnStepId === "verify_age") {
    session.currentStepIndex = getStepIndexById("underwriter_intro");
    sendNextPrompt(ws, session);
    return;
  }

  if (currentReturnIndex >= 0 && currentReturnIndex < SCRIPT_STEPS.length - 1) {
    session.currentStepIndex = currentReturnIndex + 1;
    sendNextPrompt(ws, session);
    return;
  }

  if (moveToNextStep(session)) {
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
    sendVoice(ws, "No worries, I'll let you go for now. Have a great day.", session);
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
    throw new Error(`Calendly ${response.status}: ${JSON.stringify(data)}`);
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

  const data = await calendlyFetch(
    `/event_type_available_times?${params.toString()}`
  );

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
    {
      question: "Phone Number:",
      answer: safeString(session.lead.phone),
      position: 0,
    },
    {
      question: "State:",
      answer: safeString(session.lead.state),
      position: 1,
    },
    {
      question: "Original Mortgage Loan Amount:",
      answer: safeString(session.lead.loan_amount),
      position: 2,
    },
    {
      question: "Lender:",
      answer: safeString(session.lead.lender),
      position: 3,
    },
    {
      question: "Address:",
      answer: safeString(session.lead.address),
      position: 4,
    },
    {
      question: "Age:",
      answer: safeString(session.lead.age),
      position: 5,
    },
    {
      question: "Policy Review?",
      answer: safeString(session.lead.policy_review || "No"),
      position: 6,
    },
    {
      question:
        "ONLY If Its a Policy Review\\nCarrier:\\nCoverage:\\nPremium:\\nProduct:",
      answer: safeString(session.lead.coverage || ""),
      position: 7,
    },
    {
      question: "Language:",
      answer: safeString(session.lead.language || "English"),
      position: 8,
    },
    {
      question: "Booked By:",
      answer: safeString(session.lead.booked_by || CALLER_NAME),
      position: 9,
    },
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
`,
        },
        {
          role: "user",
          content: callerText,
        },
      ],
    });

    return (
      aiResponse.output_text ||
      "Okay, I'm just trying to make sure I'm looking at the right file here."
    );
  } catch (error) {
    console.error("Fallback AI error:", error);
    return "Okay, I'm just trying to make sure I'm looking at the right file here.";
  }
}

async function getUnknownObjectionReply(session, callerText) {
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
• under 22 words
• natural human tone
• calm and conversational
• may start with:
  "Yeah so"
  "No worries"
  "I got you"
  "From what I'm seeing here"
• end by gently recentering to the file when possible

Current script step: ${safeString(currentStep?.id)}
Script line: ${safeString(currentStep?.text)}
Lead info: ${JSON.stringify(session.lead)}
`,
        },
        {
          role: "user",
          content: callerText,
        },
      ],
    });

    return (
      aiResponse.output_text ||
      "I got you, I'm just trying to make sure I'm looking at the right file here."
    );
  } catch (error) {
    console.error("Unknown objection AI error:", error);
    return "I got you, I'm just trying to make sure I'm looking at the right file here.";
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
      address: "123 Main Street",
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
  sendVoice(
    ws,
    `Perfect, I'll make a note for ${callbackTime}. Appreciate it.`,
    session
  );
}

function markObjection(session, matchedObjection, currentStepId) {
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
    askPostObjectionFollowup(ws, session, "fair_enough", "already_have_insurance");
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
      sendVoice(
        ws,
        "A lot of people feel that way initially. The underwriter will be able to go over that with you and show you what options are available.",
        session
      );
      session.activeObjection = "not_interested_coverage_check";
      sendVoice(
        ws,
        "Okay, no worries. Before I close out the file, do you already have something in place for the home if something were to happen to you, or are you just not concerned about it?",
        session
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
  sendVoice(ws, "Okay perfect. Thank you for your time.", session);
}

async function handleStepResponse(ws, session, callerText) {
  const step = getCurrentStep(session);
  console.log("STEP:", step?.id, "| USER:", callerText);

  if (!step) {
    session.shouldEndCall = true;
    sendVoice(ws, "Thank you again. Have a great day.", session);
    return;
  }

  const text = safeString(callerText);
  const normalized = normalizeText(text);

  const relativeHandled = await handleRelativeOrWrongParty(ws, session, callerText);
  if (relativeHandled) return;

  const matchedObjection = detectObjection(text);
  if (matchedObjection) {
    markObjection(session, matchedObjection, step.id);

    if (shouldExitObjectionLoop(session)) {
      session.shouldEndCall = true;
      setOutcome(session, "too_many_objections");
      sendVoice(
        ws,
        "No worries, it sounds like now may not be the best time to go over it. I'll let you go for now. Have a great day.",
        session
      );
      return;
    }

    if (matchedObjection.action === "end_call") {
      session.shouldEndCall = true;
      setOutcome(session, "do_not_call");
      sendVoice(ws, formatObjectionResponse(matchedObjection.response), session);
      return;
    }

    if (matchedObjection.action === "callback_branch") {
      sendVoice(ws, formatObjectionResponse(matchedObjection.response), session);
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
      sendVoice(ws, formatObjectionResponse(matchedObjection.response), session);
      return;
    }

    if (matchedObjection.action === "resume_script_next_step") {
      if (matchedObjection.id === "no_mortgage") {
        session.lead.no_mortgage = "Yes";
        session.crm.no_mortgage = "Yes";
      }

      sendVoice(ws, formatObjectionResponse(matchedObjection.response), session);
      const postMode = getPostObjectionModeForId(matchedObjection.id);
      askPostObjectionFollowup(ws, session, postMode, matchedObjection.id);
      return;
    }

    if (matchedObjection.action === "branch_followup") {
      session.activeObjection = matchedObjection.id;
      session.waitingForObjectionBranch = true;
      sendVoice(ws, formatObjectionResponse(matchedObjection.response), session);
      return;
    }
  }

  if (detectPossibleUnknownObjection(text)) {
    note(session, "unknown_objection", callerText);

    if (shouldExitObjectionLoop(session)) {
      session.shouldEndCall = true;
      setOutcome(session, "too_many_objections");
      sendVoice(
        ws,
        "No worries, it sounds like now may not be the best time to go over it. I'll let you go for now. Have a great day.",
        session
      );
      return;
    }

    const freestyleReply = await getUnknownObjectionReply(session, callerText);
    sendVoice(ws, freestyleReply, session);
    sendVoice(ws, `${recenterLine()} the right file here.`, session);
    return;
  }

  switch (step.id) {
    case "intro_1": {
      const t = normalizeText(text);

      if (
        containsAny(t, [
          "yes",
          "yeah",
          "speaking",
          "this is he",
          "this is she",
          "this is",
          "who is this",
          "who's this",
          "whos this",
          "hello",
          "hi",
          "hey",
        ])
      ) {
        session.currentStepIndex = getStepIndexById("intro_2");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
        return;
      }

      if (detectWrongPerson(text)) {
        session.shouldEndCall = true;
        setOutcome(session, "wrong_number");
        sendVoice(ws, "Oh okay, sorry about that. Have a great day.", session);
        return;
      }

      session.currentStepIndex = getStepIndexById("intro_2");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
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
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
        return;
      }

      session.currentStepIndex = getStepIndexById("verify_loan");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
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
        `${naturalAck()}. ${renderTemplate(getCurrentStep(session).text, session.lead)}`,
        session
      );
      return;
    }

    case "verify_loan": {
      if (detectNo(text)) {
        session.verifyingField = "loan_amount";
        note(session, "loan_mismatch", callerText);
        session.currentStepIndex = getStepIndexById("verify_loan_update");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
        return;
      }

      session.currentStepIndex = getStepIndexById("verify_coborrower");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
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
        `${naturalAck()}. ${renderTemplate(getCurrentStep(session).text, session.lead)}`,
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
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
      return;
    }

    case "verify_age": {
      if (detectNo(text)) {
        session.verifyingField = "age";
        note(session, "age_mismatch", callerText);
        session.currentStepIndex = getStepIndexById("verify_age_update");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
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
      session.lead.meeting_type = detectZoomPreference(text) || "Phone";
      session.crm.meeting_type = session.lead.meeting_type;
      note(session, "meeting_type", session.lead.meeting_type);

      session.currentStepIndex = getStepIndexById("calendar_check");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);

      try {
        await primeCalendlySlots(session);
        session.currentStepIndex = getStepIndexById("offer_times_today");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
      } catch (error) {
        console.error("Calendly availability error:", error.message);

        note(session, "booking_fallback", {
          meeting_type: session.lead.meeting_type,
          desired_step: "calendar_unavailable",
        });

        session.currentStepIndex = getStepIndexById("collect_email");
        sendVoice(
          ws,
          "It looks like the calendar is updating on my end. Let me grab a good email address and we'll send over the best available time.",
          session
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
        session.currentStepIndex = getStepIndexById("offer_times_tomorrow");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
        return;
      }

      const chosen = chooseSlotFromResponse(text, session, "first");
      if (chosen) {
        session.pendingChosenSlot = chosen;
        session.lead.scheduled_time = chosen.localTime;
        session.lead.scheduled_time_utc = chosen.utcTime;

        note(session, "slot_selected", chosen);

        session.currentStepIndex = getStepIndexById("collect_email");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
        return;
      }

      sendVoice(
        ws,
        `No problem. I have ${session.lead.slot_1_day_phrase} at ${session.lead.time_option_1} or ${session.lead.time_option_2}. Which works better for you?`,
        session
      );
      return;
    }

    case "offer_times_tomorrow": {
      const pref = detectMorningAfternoon(text);
      note(session, "tomorrow_preference", pref || callerText);

      session.currentStepIndex = getStepIndexById("offer_times_tomorrow_slots");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
      return;
    }

    case "offer_times_tomorrow_slots": {
      const chosen = chooseSlotFromResponse(text, session, "second");
      if (chosen) {
        session.pendingChosenSlot = chosen;
        session.lead.scheduled_time = chosen.localTime;
        session.lead.scheduled_time_utc = chosen.utcTime;

        note(session, "slot_selected", chosen);

        session.currentStepIndex = getStepIndexById("collect_email");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead), session);
        return;
      }

      sendVoice(
        ws,
        `The next two times I have are ${session.lead.slot_3_day_phrase} at ${session.lead.time_option_3} or ${session.lead.time_option_4}. Which works better for you?`,
        session
      );
      return;
    }

    case "collect_email": {
      const email = extractEmail(text);
      session.lead.email = email || callerText;
      note(session, "email_collected", session.lead.email);

      try {
        const booking = await createCalendlyInvitee(session);

        note(session, "calendly_booking", booking);
        setOutcome(session, "booked");
        session.crm.booking_status = "booked";

        moveToNextStep(session);
        sendNextPrompt(ws, session);
        session.shouldEndCall = true;
      } catch (error) {
        console.error("Calendly booking error:", error.message);

        note(session, "booking_manual_followup_needed", {
          email: session.lead.email,
          scheduled_time: session.lead.scheduled_time,
          scheduled_time_utc: session.lead.scheduled_time_utc,
          phone: session.lead.phone,
          meeting_type: session.lead.meeting_type,
          error: error.message,
        });

        setOutcome(session, "booking_failed_manual_followup");
        session.crm.booking_status = "manual_followup_needed";

        sendVoice(
          ws,
          "I have everything I need, but the calendar didn't save on my side just yet. I'll have the confirmation sent over manually so you don't lose the spot.",
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
        sendVoice(ws, renderTemplate(currentStep.text, session.lead), session);
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

        const interrupted = detectLikelyInterruption(session);
        if (interrupted) {
          note(session, "interruption", callerText);
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
          sendVoice(
            ws,
            "Alright, no problem. Have a great rest of your day.",
            session
          );
          return;
        }

        // Priority router:
        // 1. do-not-call / fresh objection
        // 2. callback capture
        // 3. verification correction / objection flow / coverage detail
        // 4. normal step handling

        const freshObjection = detectObjection(callerText);

        if (
          freshObjection &&
          freshObjection.id !== session.postObjectionSourceId &&
          freshObjection.id !== session.activeObjection
        ) {
          clearObjectionState(session);
          await handleStepResponse(ws, session, callerText);
          return;
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
      sendVoice(ws, "Sorry, something went wrong on my side.", session);
    }
  });

  ws.on("close", () => {
    if (!session.crm.final_outcome) {
      session.crm.final_outcome = session.callOutcome;
    }

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

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
