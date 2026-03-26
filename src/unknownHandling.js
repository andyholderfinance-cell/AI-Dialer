const UNKNOWN_OBJECTION_TYPES = {
  IDENTITY_TRUST: "identity_trust",
  SOURCE_CONFUSION: "source_confusion",
  PRODUCT_CONFUSION: "product_confusion",
  PRIVACY_RESISTANCE: "privacy_resistance",
  QUALIFICATION_FEAR: "qualification_fear",
  COST_PROBE: "cost_probe",
  TIME_PRESSURE: "time_pressure",
  SPOUSE_GATEKEEPER: "spouse_gatekeeper",
  PROCESS_CONFUSION: "process_confusion",
  SOFT_HOSTILITY: "soft_hostility",
  HARD_HOSTILITY: "hard_hostility",
  OFF_TOPIC: "off_topic",
  GENERIC_UNKNOWN: "generic_unknown",
};

const UNKNOWN_ACTIONS = {
  CLARIFY_THEN_RESUME: "clarify_then_resume",
  CLARIFY_THEN_REPEAT_STEP: "clarify_then_repeat_step",
  OFFER_CALLBACK: "offer_callback",
  GATEKEEPER_BRANCH: "gatekeeper_branch",
  GRACEFUL_EXIT: "graceful_exit",
  REPEAT_LAST_STEP: "repeat_last_step",
  AI_BRIEF_CLARIFY_THEN_RECENTER: "ai_brief_clarify_then_recenter",
};

module.exports = {
  UNKNOWN_OBJECTION_TYPES,
  UNKNOWN_ACTIONS,
};
