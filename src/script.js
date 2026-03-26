const { CALLER_NAME, UNDERWRITER_NAME } = require("./config");

const SCRIPT_STEPS = [
  {
    id: "intro_1",
    type: "question",
    text: "Hey is this {{first_name}}?",
  },
  {
    id: "intro_2",
    type: "question",
    text: `Hey {{first_name}}, this is ${CALLER_NAME}. I'm just giving you a quick call in regards to the mortgage life and disability protection information..., back when you closed on your home with {{lender}}... Does that sound familiar?`,
  },
  {
    id: "intro_3",
    type: "statement",
    text: "Okay, from what I'm seeing here, it was a request for information on the plan that would pay off your mortgage, or make those monthly payments for you if you were to become sick, disabled, or passed away. Its just showing up as incomplete or due for review...",
  },
  {
    id: "intro_4",
    type: "question",
    text: `so they just have me verify the information and get you scheduled with the state underwriter, so he can go over your options. Does that make sense?`,
  },
  {
    id: "verify_intro",
    type: "statement",
    text: "Okay, perfect, I just need to verify a few things so I know I'm looking at the right file.",
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
    text: "... Now, ever since covid, we do handle appointments by phone or Zoom..., Which one do you prefer?",
  },
  {
    id: "offer_day_choice",
    type: "booking",
    text: "Now, {{first_name}}, Would today or tomorrow be better for you?",
  },
  {
    id: "offer_daypart_choice",
    type: "booking",
    text: "Okay, and do you prefer the morning or the evening?",
  },
  {
    id: "offer_exact_time",
    type: "booking",
    text: "Got it. What time works best {{chosen_day}} {{chosen_daypart}}?",
  },
  {
    id: "collect_email",
    type: "input",
    text: "Alright {{first_name}}, and what is a good email address for the appointment confirmation?",
  },
  {
    id: "confirmation",
    type: "statement",
    text: "Awesome, that should be all I need. You'll get an email and a text reminder for the appointment.",
  },
  {
    id: "reminder_instruction",
    type: "statement",
    text: `...A couple hours before the appointment, just reconfirm so ${UNDERWRITER_NAME} knows you'll still be attending.`,
  },
  {
    id: "closing",
    type: "statement",
    text: `Okay {{first_name}} that is all for this call..., ${UNDERWRITER_NAME} will call you at {{scheduled_time}}. Thank you, and enjoy the rest of your day.`,
  },
];

module.exports = {
  SCRIPT_STEPS,
};
