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

const CALLER_NAME = process.env.CALLER_NAME || "Kendall";
const UNDERWRITER_NAME = process.env.UNDERWRITER_NAME || "Andy";
const DEFAULT_STATE = process.env.DEFAULT_STATE || "Florida";
const DEFAULT_TIMEZONE = process.env.CALENDLY_TIMEZONE || "America/New_York";

const CALENDLY_API_KEY = process.env.CALENDLY_API_KEY;
const CALENDLY_EVENT_TYPE_URI = process.env.CALENDLY_EVENT_TYPE_URI;

const SLOT_HOLD_MS = Number(process.env.SLOT_HOLD_MS || 4 * 60 * 1000);
const SLOT_HOLD_CLEANUP_MS = Number(
  process.env.SLOT_HOLD_CLEANUP_MS || 30 * 1000
);

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

Pacing rules:
- Pause after key thoughts
- Do not rush sentences
- Let statements breathe

Delivery:
- Speak like you're thinking while talking
- Slight hesitation before important phrases
- Emphasize words like "actually", "just", "worst case"

Avoid:
- sounding scripted
- sounding too clean
- sounding overly confident

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
    text: "Hey, is this {{first_name}}?",
  },
  {
    id: "intro_2",
    type: "question",
    text: `Hey {{first_name}}, this is ${CALLER_NAME}. I'm just giving you a quick call in regards to the mortgage life and disability protection file... it looks like it was opened up, back when you closed on your home with {{lender}}... Does that sound familiar?`,
  },
  {
    id: "intro_3",
    type: "statement",
    text: "Okay, from what I'm seeing here, it was a request for information on the plan that would pay off your mortgage, or make those monthly payments for you if you were to become sick, disabled, or passed away. Its just showing up as incomplete or due for review...",
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
    text: "Got it. I also have the loan amount at about {{loan_amount}}. Is that correct?",
  },
  {
    id: "verify_loan_update",
    type: "input",
    text: "Okay, what is the correct loan amount roughly?",
  },
  {
    id: "verify_coborrower",
    type: "question",
    text: "And I don't see a co-borrower on file, is it just you paying for the home?",
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
    text: `Perfect... So, ${UNDERWRITER_NAME} is the underwriter for your county. He can go over the mortgage protection information with you, answer any questions, and pull up some options based on your needs.`,
  },
  {
    id: "virtual_meeting",
    type: "question",
    text: "Ever since covid, we handle appointments by phone or Zoom. Which do you prefer?",
  },
  {
    id: "calendar_check",
    type: "statement",
    text: `Okay, give me just a moment while I check ${UNDERWRITER_NAME}'s calendar...`,
  },
  {
  id: "offer_day_choice",
  type: "booking",
  text: "Would today or tomorrow be better for you?",
},
{
  id: "offer_daypart_choice",
  type: "booking",
  text: "Got it. Would morning or evening work better for you?",
},
{
  id: "offer_exact_time",
  type: "booking",
  text: "What time works best {{chosen_day}} {{chosen_daypart}}?",
},
  {
    id: "collect_email",
    type: "input",
    text: "Okay, what is a good email address for the appointment confirmation?",
  },
  {
    id: "confirmation",
    type: "statement",
    text: "Awesome, that should be all I need. You'll get an email and a text reminder for the appointment.",
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
      "what is this about",
      "what is this regarding",
      "what are you calling about",
      "what is this in reference to",
      "what do you want",
      "what do you need",
      "what is this concerning",
      "what is this supposed to be",
      "what are we talking about",
      "what is this call regarding",
      "what is the reason for the call",
      "what's going on",
      "what is this about exactly",
      "why are you calling",
      "what are you trying to do",
      "what is this all about",
      "what's this about again",
      "why did you call me",
      "what is this for"
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
      "how did you get my info",
      "how did you get my information",
      "where did you get my info",
      "where did you get my information",
      "how did you get my number",
      "how do you have my number",
      "how did you find me",
      "where did you get this",
      "where did you get my contact info",
      "how did yall get my info",
      "why do you have my information",
      "where are you pulling this from",
      "who gave you my number",
      "how did you get ahold of me",
      "why do you have my number",
      "where did this come from",
      "how are you connected to me",
      "who gave you my information",
      "where did yall get my number",
      "how did you get this number"
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
  "Totally fair...",
  "That’s actually why we set it up this way — the underwriter works with a bunch of A-rated companies,",
  "so he can find whatever the most affordable option is for you.",
  "And since the call’s free, worst case you just get clarity on your options and decide from there.",
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
      "No, not at all. I'm just following up on the request that was sent in so that way the underwriter can go over those options with you.",
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
      "I work with the underwriter assigned to the file. He is contracted with multiple carrier's within the state, so we aren't tied to just one company.",
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
      "I wish I could, that would make my job a lot easier, but the actual options depend on your age, health, and what you need, which is why we set the review with the underwriter.",
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
      "No, I'm not trying to sell you anything. My job is just to verify the file and get you appointed with the underwriter. Mortgage protection is something you have to apply for, it can't just be bought off the shelf, like a loaf of bread.",
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
      "Yea, of course. No decisions are being made on this call. I just need to find a time that works best for you to speak with the underwriter.",
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
  "I completely understand...",
  "That’s exactly why I’m calling — the underwriter works with multiple A-rated carriers,",
  "so he can usually find something that fits based on your age and health.",
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
      'Okay, no worries let me just update your file here... Now, mortgage protection is something that follows you specifically. So in the event that you no longer have a mortgage, you would still be covered if something were to happen to you. Whether that be income replacement, or final expenses.'
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
  "Gotcha...",
  "just so I handle the file correctly — is that more because of cost,",
  "or you're not sure you'd qualify?",
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
      "i already have life insurance",
      "i already have coverage",
      "im already covered",
      "i have a policy already",
      "i already have a policy in place",
      "im taken care of",
      "im already protected",
      "i already got that",
      "ive already got something",
      "i already have coverage for that",
      "im set",
      "i already handled that a while ago",
      "i have enough insurance",
      "i have it through work",
      "i have insurance through my job",
      "i already have life insurance through my job",
      "i already have something for that",
      "i already took care of that",
      "i'm good on that"
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
 * SESSION STORE / SLOT HOLDS
 * ============================================================================
 */

const callSessions = new Map();
const slotHolds = new Map();

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
    pendingChosenSlot: null,
    pendingChosenSlotPair: "first",
    heldSlotUtcTime: "",
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

  session.currentStepIndex = Math.min(questionStepIndex, SCRIPT_STEPS.length - 1);
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

  if (containsAny(t, [
    "today",
    "this afternoon",
    "this evening",
    "tonight",
    "today morning",
    "today evening"
  ])) {
    return "today";
  }

  if (containsAny(t, ["tomorrow", "tmrw", "tmr"])) {
    return "tomorrow";
  }

  return "";
}

function detectMorningEvening(text) {
  const t = normalizeText(text);

  if (containsAny(t, [
    "morning",
    "am",
    "early",
    "earlier",
    "start of the day",
    "this morning",
    "today morning",
    "tomorrow morning"
  ])) return "morning";

  if (containsAny(t, [
    "evening",
    "pm",
    "tonight",
    "later",
    "after work",
    "later on",
    "end of the day",
    "this evening",
    "today evening",
    "tomorrow evening"
  ])) return "evening";

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
    offer_day_choice: "Would today or tomorrow be better for you?",
    offer_daypart_choice: "Would morning or evening work better for you?",
    offer_exact_time: renderTemplate(
      "What time works best {{chosen_day}} {{chosen_daypart}}?",
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

function buildCalendlyBookingFields(session) {
  const lead = session.lead || {};

  const fullName = safeString(
    lead.full_name || lead.first_name || "Client"
  ).trim();

  const firstName = safeString(lead.first_name || "Client").trim();

  const meetingType =
    safeString(lead.meeting_type).trim() === "Zoom" ? "Zoom" : "Phone call";

  return {
    name: fullName || "Client",
    first_name: firstName || "Client",
    email: safeString(lead.email).trim(),
    meeting_type: meetingType,
    phone: safeString(lead.phone).trim(),
    state: safeString(lead.state || DEFAULT_STATE).trim(),
    loan_amount: safeString(lead.loan_amount || "Unknown").trim(),
    lender: safeString(lead.lender || "Unknown").trim(),
    address: safeString(lead.address || "Unknown").trim(),
    age: safeString(lead.age || "Unknown").trim(),
    policy_review:
      safeString(lead.policy_review).trim() === "Yes" ? "Yes" : "No",
    language: safeString(lead.language || "English").trim(),
    booked_by: safeString(lead.booked_by || CALLER_NAME).trim(),
    timezone: safeString(lead.timezone || DEFAULT_TIMEZONE).trim(),
  };
}

function resumeAfterObjection(ws, session) {
  const returnStepId =
    session.objectionReturnStepId || session.pendingPromptStartStepId || null;

  const returnIndex =
    returnStepId !== null ? getStepIndexById(returnStepId) : session.resumeStepIndex;

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

  const fillers = [
    "Perfect... give me just a second.",
    "Okay... just a second here.",
    "Gotcha... one second.",
  ];

  sendVoice(ws, pick(fillers), session);

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

function buildCalendlyErrorSummary(error) {
  const body = error?.body || {};
  const title = safeString(body.title || "");
  const message = safeString(body.message || "");
  const details = Array.isArray(body.details) ? body.details : [];

  const invalidParams = details
    .filter((d) => d?.parameter)
    .map((d) => d.parameter);

  return {
    status: error?.status || null,
    title,
    message,
    invalidParams,
    raw: body,
    isAuth:
      title.toLowerCase().includes("unauthenticated") ||
      message.toLowerCase().includes("access token"),
    isInvalidArgument: title.toLowerCase().includes("invalid argument"),
  };
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
    session
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

  const rawText = await response.text();
  let data = {};

  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { raw: rawText };
  }

  if (!response.ok) {
    const summary = buildCalendlyErrorSummary({
      status: response.status,
      body: data,
    });

    console.error("Calendly API failure", {
      path,
      method: options.method || "GET",
      status: response.status,
      response: data,
      parsed: summary,
    });

    const err = new Error(
      `Calendly request failed | ${options.method || "GET"} ${path} | status=${response.status} | body=${JSON.stringify(
        data
      )}`
    );
    err.status = response.status;
    err.body = data;
    err.summary = summary;
    throw err;
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

 return collection.slice(0, 20).map((slot) => {
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

async function primeCalendlySlots(session, forceRefresh = false) {
  if (session.calendlyReady && !forceRefresh) {
    applySessionSlots(session);
    return;
  }

  if (!CALENDLY_API_KEY || !CALENDLY_EVENT_TYPE_URI) {
    throw new Error("Calendly env vars are missing");
  }

  const slots = await getCalendlyAvailableTimes(
    CALENDLY_EVENT_TYPE_URI,
    session.lead.timezone
  );

  if (!Array.isArray(slots)) {
    throw new Error("Calendly availability response was not an array");
  }

  const filtered = filterHeldSlotsForSession(slots, session);

  if (!filtered.length) {
    const err = new Error("No Calendly slots available");
    err.code = "NO_SLOTS";
    throw err;
  }

  session.availableSlots = filtered;
  session.calendlyReady = true;
  applySessionSlots(session);

  console.error("Calendly availability success", {
    eventType: CALENDLY_EVENT_TYPE_URI,
    timezone: session.lead.timezone,
    totalSlots: slots.length,
    usableSlots: filtered.length,
    heldSlots: slotHolds.size,
  });
}

function buildCalendlyQuestionsAndAnswers(session) {
  const fields = buildCalendlyBookingFields(session);

  const answers = [
    {
      question: "Phone Number:",
      answer: fields.phone,
      position: 0,
    },
    {
      question: "State:",
      answer: fields.state,
      position: 1,
    },
    {
      question: "Original Mortgage Loan Amount:",
      answer: fields.loan_amount,
      position: 2,
    },
    {
      question: "Lender:",
      answer: fields.lender,
      position: 3,
    },
    {
      question: "Address:",
      answer: fields.address,
      position: 4,
    },
    {
      question: "Age:",
      answer: fields.age,
      position: 5,
    },
  ];

  if (fields.policy_review) {
    answers.push({
      question: "Policy Review?",
      answer: fields.policy_review,
      position: answers.length,
    });
  }

  if (fields.language) {
    answers.push({
      question: "Language",
      answer: fields.language,
      position: answers.length,
    });
  }

  if (fields.booked_by) {
    answers.push({
      question: "Booked By:",
      answer: fields.booked_by,
      position: answers.length,
    });
  }

  return answers;
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

async function ensureChosenSlotStillAvailable(session) {
  extendSlotHold(session);
  await primeCalendlySlots(session, true);

  if (!session.pendingChosenSlot?.utcTime) {
    throw new Error("No selected Calendly slot");
  }

  const stillAvailable = session.availableSlots.some(
    (slot) => slot.utcTime === session.pendingChosenSlot.utcTime
  );

  if (!stillAvailable) {
    const err = new Error("Chosen slot is no longer available");
    err.code = "SLOT_GONE";
    throw err;
  }

  const hold = slotHolds.get(session.pendingChosenSlot.utcTime);
  if (!hold || hold.sessionId !== session.id) {
    const err = new Error("Chosen slot hold was lost");
    err.code = "HOLD_LOST";
    throw err;
  }
}

async function createCalendlyInvitee(session) {
  if (!CALENDLY_EVENT_TYPE_URI) {
    throw new Error("Missing CALENDLY_EVENT_TYPE_URI");
  }

  if (!session.pendingChosenSlot?.utcTime) {
    throw new Error("No selected Calendly slot");
  }

  const fields = buildCalendlyBookingFields(session);

  if (!fields.email) {
    throw new Error("Missing invitee email");
  }

  if (!fields.name) {
    throw new Error("Missing invitee name");
  }

  if (!fields.phone) {
    throw new Error("Missing phone number for Calendly");
  }

  const payload = {
    event_type: CALENDLY_EVENT_TYPE_URI,
    start_time: session.pendingChosenSlot.utcTime,
    invitee: {
      name: fields.name,
      first_name: fields.first_name,
      email: fields.email,
      timezone: fields.timezone,
      text_reminder_number: fields.phone,
    },
    location:
      fields.meeting_type === "Zoom"
        ? { kind: "zoom_conference" }
        : {
            kind: "outbound_call",
            location: fields.phone,
          },
    questions_and_answers: buildCalendlyQuestionsAndAnswers(session),
  };

  console.log("Calendly invitee payload:", JSON.stringify(payload, null, 2));

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
      voice="BVA1oNX6xZt6o7QaUwxr-flash_v2_5-0.85_0.75_0.80"
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
    const phone = process.env.TEST_DIAL_NUMBER || "+18177090206";

    const leadId = randomId();
    const session = buildSessionFromLead({
      phone,
      first_name: "Erica",
      full_name: "Erica Holder",
      lender: "Rocket Mortgage",
      state: "Florida",
      address: "1 2 3 Main Street",
      loan_amount: "$150,000",
      age: "56",
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
            "No harm in taking a quick look",
          ]
        : [
            "I completely understand...",
            "That’s exactly why I’m calling — the underwriter works with multiple A-rated carriers,",
            "so he can usually find something that fits based on your age and health.",
            "No harm in taking a quick look",
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

  try {
    await primeCalendlySlots(session, true);
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

  const matchedObjection = detectObjection(text);
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

  session.currentStepIndex = getStepIndexById("calendar_check");
  sendVoice(
    ws,
    renderTemplate(getCurrentStep(session).text, session.lead),
    session
  );
  return;
}

   case "calendar_check": {
  try {
    await primeCalendlySlots(session);

    session.currentStepIndex = getStepIndexById("offer_day_choice");

    sendVoice(
      ws,
      "Would today or tomorrow be better for you?",
      session
    );
  } catch (err) {
    console.error("Calendly error:", err);

    sendVoice(
      ws,
      "Looks like I’m having trouble pulling up the calendar right now. We’ll follow up with you shortly.",
      session
    );

    session.shouldEndCall = true;
  }

  return;
}

case "offer_day_choice": {
  const direct = detectDirectBookingIntent(text);

  if (direct.day) {
    session.chosenBookingDay = direct.day;
    session.lead.chosen_day = direct.day;
  }

  if (direct.daypart) {
    session.chosenBookingDaypart = direct.daypart;
    session.lead.chosen_daypart = direct.daypart;
  }

  // 🔥 FULL SENTENCE BOOKING
  if (direct.day && direct.daypart && direct.hasTime) {
    const filtered = getFilteredSlots(session, direct.day, direct.daypart);
    const chosen = chooseSlotFromFilteredResponse(text, filtered);

    if (chosen) {
      await confirmChosenSlot(ws, session, chosen);
      return;
    }
  }

  const day = detectTodayTomorrow(text);

  if (!day) {
    sendVoice(ws, "Would today or tomorrow work better?", session);
    return;
  }

  session.chosenBookingDay = day;
  session.lead.chosen_day = day;

  session.currentStepIndex = getStepIndexById("offer_daypart_choice");

  sendVoice(ws, "Morning or evening works better?", session);
  return;
}

case "offer_daypart_choice": {
  const direct = detectDirectBookingIntent(text);

  if (direct.day && !session.chosenBookingDay) {
    session.chosenBookingDay = direct.day;
    session.lead.chosen_day = direct.day;
  }

  if (direct.daypart) {
    session.chosenBookingDaypart = direct.daypart;
    session.lead.chosen_daypart = direct.daypart;
  }

  if (session.chosenBookingDay && direct.daypart && direct.hasTime) {
    const filtered = getFilteredSlots(
      session,
      session.chosenBookingDay,
      direct.daypart
    );

    const chosen = chooseSlotFromFilteredResponse(text, filtered);

    if (chosen) {
      await confirmChosenSlot(ws, session, chosen);
      return;
    }
  }

  const daypart = detectMorningEvening(text);

  if (!daypart) {
    sendVoice(ws, "Morning or evening works better?", session);
    return;
  }

  session.chosenBookingDaypart = daypart;
  session.lead.chosen_daypart = daypart;

  session.currentStepIndex = getStepIndexById("offer_exact_time");

  sendVoice(
    ws,
    `What time works best ${session.chosenBookingDay} ${session.chosenBookingDaypart}?`,
    session
  );

  return;
}

case "offer_exact_time": {
  const direct = detectDirectBookingIntent(text);

  const day = direct.day || session.chosenBookingDay;
  const daypart = direct.daypart || session.chosenBookingDaypart;

  const filtered = getFilteredSlots(session, day, daypart);
  const chosen = chooseSlotFromFilteredResponse(text, filtered);

  if (chosen) {
    await confirmChosenSlot(ws, session, chosen);
    return;
  }

if (!filtered.length) {
  const otherDaypart = daypart === "morning" ? "evening" : "morning";

  sendVoice(
    ws,
    `I'm not seeing anything open ${day} ${daypart}. Would ${otherDaypart} work better?`,
    session
  );

  return;
}

  const options = filtered
    .slice(0, 3)
    .map((s) => s.localTime)
    .join(", ");

  sendVoice(
    ws,
    `I have ${options} ${day} ${daypart}. What works best for you?`,
    session
  );

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
        await ensureChosenSlotStillAvailable(session);

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
