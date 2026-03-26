require("dotenv").config();

const OpenAI = require("openai");
const twilio = require("twilio");

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

module.exports = {
  accountSid,
  authToken,
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
};
