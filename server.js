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
- slightly confused or mildly concerned, like you're looking at a file that needs attention
- warm and conversational
- never robotic
- never polished like an announcer
- never salesy

Tone rules:
- Speak like a real person on the phone.
- Use short natural phrasing.
- Occasionally use filler words like "um", "uh", "let me see", "okay", or "just a second" in a light natural way.
- Do not overuse filler words.
- Stay polite and relaxed.
- Never sound pushy, aggressive, scripted, or overly excited.
`;

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
    text: "Awesome, now I have the total loan amount as around {{loan_amount}}. Is that correct?",
  },
  {
    id: "verify_coborrower",
    type: "question",
    resume_after_objection: true,
    text: "Great, I don't see a co borrower on file. Is there anyone helping you pay for the home?",
  },
  {
    id: "verify_age",
    type: "question",
    resume_after_objection: true,
    text: "Okay, and I have your age here as {{age}} years young. Is that correct?",
  },
  {
    id: "underwriter_intro",
    type: "statement",
    resume_after_objection: true,
    text: `Okay, now ${UNDERWRITER_NAME} is the underwriter for your county. He will be able to explain mortgage protection to you, as well as share his license with the state of {{state}}. He'll answer any questions you may have, pull up options tailored specifically to you, and help you apply for coverage.`,
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
      "what is this even",
      "what exactly is this",
      "what exactly is this about",
      "what is this call about",
      "what are you referring to",
      "what file",
      "what do you mean",
      "what are you talking about here",
      "what is this concerning",
      "what is this supposed to be",
      "what is this in regards to",
      "what are you even talking about",
      "what are you talking about exactly",
      "what is this all about",
    ],
    response: [
      "Yea, so this is about the mortgage life and disability protection file that was opened up when you closed on your home.",
      "[PAUSE_3_SECONDS]",
      "It's just showing up as incomplete or due for review.",
    ],
  },
  {
    id: "cost",
    action: "resume_script_next_step",
    triggers: [
      "how much does this cost",
      "how much is it",
      "what does it cost",
      "what is the cost",
      "the cost",
      "how much would it be",
      "what would it cost",
      "price",
      "pricing",
      "too expensive",
      "how much",
      "what's the price",
      "what is the price",
      "what would it run me",
      "what would that cost me",
      "how expensive is it",
      "is it expensive",
      "what's the monthly",
      "what is the monthly",
      "monthly payment",
      "monthly premium",
      "premium",
      "how much per month",
      "what are the payments",
      "what kind of payment",
      "what kind of payments",
      "how much a month",
      "how much monthly",
      "what would my payment be",
      "what would the premium be",
    ],
    response: [
      "So the state underwriter will be able to pull up some options for you, but they are based on your current age and health. My job is just to get you appointed with the underwriter so he can go over those options with you.",
    ],
  },
  {
    id: "mandatory",
    action: "resume_script_next_step",
    triggers: [
      "is this mandatory",
      "is this required",
      "do i have to do this",
      "do i need to do this",
      "is this something i have to have",
      "do i have to have this",
      "is this required by law",
      "is this required for the mortgage",
      "do i need this",
      "is this necessary",
      "is this something i need",
      "am i required to do this",
      "do i have to get this",
    ],
    response: [
      "No, not at all, I'm just reaching out to see if anyone was able to take care of getting that coverage in place for you.",
    ],
  },
  {
    id: "who_do_you_work_for",
    action: "resume_script_next_step",
    triggers: [
      "who do you work for",
      "who are you with",
      "what company do you work for",
      "who do you work with",
      "what company are you with",
      "who is your company",
      "who do you represent",
      "what are you calling from",
      "where are you calling from",
      "who are you working with",
      "what firm are you with",
      "what company is this",
      "who is this company",
      "what organization are you with",
    ],
    response: [
      "Yea of course, I work under the state underwriter assigned to your file. He is licensed with the state and contracted with multiple A-rated carriers. So we aren't tied to one specific company.",
    ],
  },
  {
    id: "email_it",
    action: "resume_script_next_step",
    triggers: [
      "can you just email it to me",
      "just email it to me",
      "email it to me",
      "can you email it",
      "send it to me by email",
      "send me something",
      "can you just send me something",
      "can you send that to me",
      "just send it to me",
      "email me the info",
      "send me the information",
      "can you text it to me",
      "can you send me an email",
      "just email me",
      "send it over",
      "can you just text me",
      "can you send me the details",
    ],
    response: [
      "I wish I could, that would make my job a lot easier, but your options are based on your current age and health, as well as financial needs. That is why we book a time to go over all that with the state underwriter.",
    ],
  },
  {
    id: "are_you_selling",
    action: "resume_script_next_step",
    triggers: [
      "are you trying to sell me something",
      "are you selling me insurance",
      "are you trying to sell me insurance",
      "is this a sales call",
      "are you selling something",
      "are you trying to sell me",
      "is this sales",
      "is this some kind of sales call",
      "are you calling to sell me something",
      "are you selling life insurance",
      "are you pitching me something",
      "is this a solicitation",
      "are you marketing something to me",
    ],
    response: [
      "Completely understand the concern, but no, not at all. Mortgage protection is something you have to apply for. It isn't something you can just buy off the shelf.",
    ],
  },
  {
    id: "call_back",
    action: "resume_script_next_step",
    triggers: [
      "can you call me back",
      "can i call you back",
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
      "can you ring me back",
      "give me a call later",
      "maybe call later",
    ],
    response: [
      "Yea, of course. No decisions are being made on this call. It's just to find a time that you are available to speak with the underwriter.",
    ],
  },
  {
    id: "who_are_you",
    action: "resume_script_next_step",
    triggers: [
      "who are you",
      "what's your name",
      "what is your name",
      "who is this",
      "who am i speaking with",
      "who am i talking to",
      "what did you say your name was",
      "say your name again",
      "who is calling",
      "what was your name",
      "who's this",
    ],
    response: [
      `Of course, my name is ${CALLER_NAME}, I'm the case worker assigned to your mortgage protection file.`,
    ],
  },
  {
    id: "qualify",
    action: "resume_script_next_step",
    triggers: [
      "wondering if i'd qualify",
      "wondering if i would qualify",
      "i don't think i'd qualify",
      "i dont think id qualify",
      "i don't think i would qualify",
      "i dont think i would qualify",
      "would i qualify",
      "qualify",
      "qualification",
      "would i even qualify",
      "i probably wouldn't qualify",
      "i probably wont qualify",
      "i don't know if i'd qualify",
      "i dont know if id qualify",
      "not sure if i qualify",
      "can i qualify",
      "would i be approved",
      "i dont think i could get approved",
    ],
    response: [
      "A lot of people feel that way initially, however the state underwriter is contracted with multiple A-rated carriers and would have no trouble finding one to qualify you.",
    ],
  },
  {
    id: "no_mortgage",
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
      "i dont owe on the house",
      "i don't owe on the house",
      "i don't have a loan",
      "i dont have a loan",
      "mortgage is paid off",
      "there is no mortgage",
      "i own it outright",
    ],
    response: [
      "Okay no worries let me just update your file here. Now mortgage protection is something that follows you specifically. So in the event that you no longer have a mortgage, you would still be covered if something were to happen to you. Whether that be income replacement, or final expenses.",
    ],
  },
  {
    id: "not_interested",
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
      "do not want it",
      "i'm all set",
      "im all set",
      "not really interested",
      "i'm okay",
      "im okay",
      "not for me",
      "i'm fine",
      "im fine",
      "leave me alone",
      "i dont need it",
      "i don't need it",
      "i'm not looking for anything",
      "im not looking for anything",
      "no thank you",
      "not really",
      "i'll pass",
    ],
    response: [
      "Okay, no problem, let me just update your file. I know this was something that was important to you when you originally sent the request in. Are you unsure now because of the cost, or wondering if you'd qualify?",
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
          "wondering if i'd qualify",
          "wondering if i would qualify",
          "not sure i qualify",
          "dont think i qualify",
          "don't think i qualify",
          "i probably wouldnt qualify",
          "i probably wouldn't qualify",
        ],
        response: [
          "A lot of people feel that way initially. The underwriter will be able to go over that with you and show you what options are available.",
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
          "leave it alone",
          "i'm okay",
          "im okay",
          "no thank you",
          "i'll pass",
          "dont want it",
          "don't want it",
        ],
        response: [
          "Okay no worries, before I close out your file, do you already have something in place to offset the cost of your mortgage if something were to happen to you, or are you just not concerned about it?",
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
          "leave it alone",
          "not concerned about it",
          "i dont care",
          "i don't care",
        ],
        response: [
          "Okay no worries, I'll go ahead and close out your file. Thank you for your time.",
        ],
      },
    },
  },
  {
    id: "already_have_insurance",
    action: "resume_script_next_step",
    triggers: [
      "i already have insurance",
      "i already got this taken care of",
      "i have something through work",
      "i already have life insurance",
      "i'm already covered",
      "im already covered",
      "i have a policy already",
      "i already have something in place",
      "i already have coverage",
      "i've already got coverage",
      "ive already got coverage",
      "i already handled that",
      "i'm covered",
      "im covered",
      "i have insurance through work",
      "i have a policy",
      "i already have life",
      "i got life insurance",
      "i already got life insurance",
      "i'm good on insurance",
      "im good on insurance",
      "i have coverage already",
      "already got a policy",
      "i already took care of that",
      "i have something in place",
    ],
    response: [
      "Okay great, it makes sense as to why it says due for review. My job is just to get you appointed with the state underwriter so he can go over your policy to make sure you aren't overpaying and have all the correct benefits.",
    ],
  },
  {
    id: "never_filled_anything_out",
    action: "resume_script_next_step",
    triggers: [
      "i never filled anything out",
      "i never filled that out",
      "i never filled this out",
      "i didn't fill anything out",
      "i did not fill anything out",
      "i didn't fill that out",
      "i did not fill that out",
      "i didn't fill this out",
      "i did not fill this out",
      "i don't remember filling that out",
      "i dont remember filling that out",
      "i don't remember filling this out",
      "i dont remember filling this out",
      "i don't remember that",
      "i dont remember that",
      "i don't remember doing that",
      "i dont remember doing that",
      "i don't recall filling this out",
      "i dont recall filling this out",
      "i never requested that",
      "i never asked for that",
      "i dont remember applying",
      "i don't remember applying",
      "i never applied for that",
      "i didnt apply for that",
      "i did not apply for that",
      "i never asked for this",
      "i dont remember signing up for that",
      "i didn't sign up for that",
      "i did not sign up for that",
      "i never signed up for that",
    ],
    response: [
      "No worries, most people don't remember. It might have been a while ago. We've been backed up due to COVID and layoffs, so we're just reaching back out to everyone we missed.",
    ],
  },
  {
    id: "do_not_call",
    action: "end_call",
    triggers: [
      "stop calling me",
      "take me off your call list",
      "remove me from your list",
      "don't call me again",
      "dont call me again",
      "do not call me again",
      "i already said no to this",
      "quit calling me",
      "put me on do not call",
      "take me off the list",
      "remove me",
      "stop calling",
      "leave me alone",
      "take me off",
      "put me on the do not call list",
      "don't ring me again",
      "do not ring me again",
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

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(normalizeText(phrase)));
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

function rewindToLastQuestion(session) {
  session.currentStepIndex =
    session.lastQuestionStepIndex || session.currentStepIndex;
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

function sendNextPrompt(ws, session) {
  const prompt = buildPromptFromCurrentStep(session);
  sendVoice(ws, prompt);
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
- You are only for brief clarification when the caller says something unexpected.
- Do not continue the script on your own.
- Do not invent new script lines.
- Do not add new sales language.
- Keep replies to one short sentence when possible.
- After clarifying, gently return control back to the scripted flow.
- Do not restate large parts of the process unless the caller directly asks.

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

You may clarify confusion, but you must NOT introduce new explanations, services, or processes.

Do NOT:
• invent policies
• invent companies
• invent prices
• invent underwriting rules
• change the purpose of the call
• create a new sales pitch
• restart the script

Your job is ONLY to briefly smooth over confusion and guide the conversation back to the script.

Response rules:
• 1 sentence preferred
• 2 sentences maximum
• under 25 words
• natural human tone
• calm and conversational
• may start with phrases like:
  "Um,"
  "Yeah so"
  "No worries,"
  "I got you,"
  "From what I'm seeing here"
• If possible, reuse wording from the script itself.

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
  sendNextPrompt(ws, session);
}

async function handleActiveObjectionBranch(ws, session, callerText) {
  const activeId = session.activeObjection;

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
        "A lot of people feel that way initially. The underwriter will be able to go over that with you and show you what options are available."
      );
      session.activeObjection = "not_interested_coverage_check";
      sendVoice(
        ws,
        "Okay no worries, before I close out your file, do you already have something in place to offset the cost of your mortgage if something were to happen to you, or are you just not concerned about it?"
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
        "Okay no worries, before I close out your file, do you already have something in place to offset the cost of your mortgage if something were to happen to you, or are you just not concerned about it?"
      );
      return;
    }

    sendVoice(
      ws,
      "Just so I handle this correctly, are you unsure because of the cost, wondering if you'd qualify, or are you just not interested in going over it?"
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
      session.activeObjection = null;
      session.waitingForCoverageTypeAnswer = true;
      sendVoice(
        ws,
        "Okay great, and is that a personal life policy, or something specifically for the mortgage?"
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
      session.waitingForObjectionBranch = false;
      session.activeObjection = null;
      sendVoice(
        ws,
        "Okay no worries, I'll go ahead and close out your file, thank you for your time."
      );
      return;
    }

    sendVoice(
      ws,
      "Just so I update it correctly, do you already have something in place, or are you just not concerned about it?"
    );
    return;
  }

  const objection = OBJECTION_LIBRARY.find((o) => o.id === activeId);

  if (!objection) {
    session.activeObjection = null;
    session.waitingForObjectionBranch = false;
    if (moveToNextStep(session)) {
      sendNextPrompt(ws, session);
    }
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
    session.activeObjection = null;
    session.waitingForCoverageTypeAnswer = true;
    sendVoice(ws, formatObjectionResponse(branch.response));
    return;
  }

  if (branchName === "not_concerned") {
    session.shouldEndCall = true;
    session.waitingForObjectionBranch = false;
    session.activeObjection = null;
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

  if (moveToNextStep(session)) {
    sendNextPrompt(ws, session);
    return;
  }

  session.shouldEndCall = true;
  sendVoice(ws, "Okay perfect. Thank you for your time.");
}

async function handleStepResponse(ws, session, callerText) {
  const step = getCurrentStep(session);
  console.log("STEP:", step?.id, "| USER:", callerText);

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

    if (matchedObjection.action === "resume_script_next_step") {
      sendVoice(ws, formatObjectionResponse(matchedObjection.response));

      if (moveToNextStep(session)) {
        sendNextPrompt(ws, session);
        return;
      }

      session.shouldEndCall = true;
      sendVoice(ws, "Okay perfect. Thank you for your time.");
      return;
    }

    if (matchedObjection.action === "branch_followup") {
      session.activeObjection = matchedObjection.id;
      session.waitingForObjectionBranch = true;
      sendVoice(ws, formatObjectionResponse(matchedObjection.response));
      return;
    }
  }

  if (detectPossibleUnknownObjection(text)) {
    const freestyleReply = await getUnknownObjectionReply(session, callerText);
    sendVoice(ws, freestyleReply);

    if (moveToNextStep(session)) {
      sendNextPrompt(ws, session);
      return;
    }

    session.shouldEndCall = true;
    sendVoice(ws, "Okay perfect. Thank you for your time.");
    return;
  }

  switch (step.id) {
    case "intro_1": {
      session.currentStepIndex = getStepIndexById("intro_2");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
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
        session.notes.push({
          type: "address_mismatch",
          value: callerText,
          at: Date.now(),
        });
      }

      session.currentStepIndex = getStepIndexById("verify_loan");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
      return;
    }

    case "verify_loan": {
      if (detectNo(text)) {
        session.notes.push({
          type: "loan_mismatch",
          value: callerText,
          at: Date.now(),
        });
      }

      session.currentStepIndex = getStepIndexById("verify_coborrower");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
      return;
    }

    case "verify_coborrower": {
      session.lead.co_borrower = normalized.includes("no") ? "No" : callerText;

      session.currentStepIndex = getStepIndexById("verify_age");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
      return;
    }

    case "verify_age": {
      if (detectNo(text)) {
        session.notes.push({
          type: "age_mismatch",
          value: callerText,
          at: Date.now(),
        });
      }

      session.currentStepIndex = getStepIndexById("underwriter_intro");
      sendNextPrompt(ws, session);
      return;
    }

    case "virtual_meeting": {
      session.lead.meeting_type = detectZoomPreference(text) || "Phone";
      session.currentStepIndex = getStepIndexById("calendar_check");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));

      try {
        await primeCalendlySlots(session);
        session.currentStepIndex = getStepIndexById("offer_times_today");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
      } catch (error) {
        console.error("Calendly availability error:", error.message);
        session.currentStepIndex = getStepIndexById("collect_email");
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
        session.currentStepIndex = getStepIndexById("offer_times_tomorrow");
        sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
        return;
      }

      const chosen = chooseSlotFromResponse(text, session, "first");
      if (chosen) {
        session.pendingChosenSlot = chosen;
        session.lead.scheduled_time = chosen.localTime;
        session.lead.scheduled_time_utc = chosen.utcTime;
        session.currentStepIndex = getStepIndexById("collect_email");
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

      session.currentStepIndex = getStepIndexById("offer_times_tomorrow_slots");
      sendVoice(ws, renderTemplate(getCurrentStep(session).text, session.lead));
      return;
    }

    case "offer_times_tomorrow_slots": {
      const chosen = chooseSlotFromResponse(text, session, "second");
      if (chosen) {
        session.pendingChosenSlot = chosen;
        session.lead.scheduled_time = chosen.localTime;
        session.lead.scheduled_time_utc = chosen.utcTime;
        session.currentStepIndex = getStepIndexById("collect_email");
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

        moveToNextStep(session);
        sendNextPrompt(ws, session);
        session.shouldEndCall = true;
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

      const currentStep = getCurrentStep(session);
      if (currentStep && isQuestionLike(currentStep)) {
        sendVoice(ws, renderTemplate(currentStep.text, session.lead));
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

      if (data.type === "prompt" && data.voicePrompt) {
        const callerText = data.voicePrompt;
        console.log("Caller said:", callerText);

        if (detectGoodbye(callerText)) {
          session.shouldEndCall = true;
          sendVoice(ws, "Alright, no problem. Have a great rest of your day.");
          return;
        }

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
