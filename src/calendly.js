const fetch = require("node-fetch");

const {
  CALENDLY_API_KEY,
  CALENDLY_EVENT_TYPE_URI,
  CALLER_NAME,
  DEFAULT_STATE,
  DEFAULT_TIMEZONE,
} = require("./config");

const {
  safeString,
  formatLocalTime,
  formatLocalDayPhrase,
} = require("./helpers");

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
    const err = new Error(
      `Calendly request failed | ${options.method || "GET"} ${path} | status=${response.status} | body=${JSON.stringify(
        data
      )}`
    );
    err.status = response.status;
    err.body = data;
    throw err;
  }

  return data;
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

  return collection.slice(0, 100).map((slot) => {
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

async function primeCalendlySlots(
  session,
  forceRefresh,
  filterHeldSlotsForSession,
  applySessionSlots
) {
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
  });
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

async function ensureChosenSlotStillAvailable(
  session,
  extendSlotHold,
  primeCalendlySlotsFn
) {
  extendSlotHold(session);
  await primeCalendlySlotsFn(session, true);

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

module.exports = {
  calendlyFetch,
  buildCalendlyErrorSummary,
  getCalendlyAvailableTimes,
  primeCalendlySlots,
  buildCalendlyBookingFields,
  buildCalendlyQuestionsAndAnswers,
  buildCalendlyLocation,
  ensureChosenSlotStillAvailable,
  createCalendlyInvitee,
};
