const express = require("express");
const VoiceResponse = require("twilio").twiml.VoiceResponse;

const app = express();

app.post("/voice", (req, res) => {
  const twiml = new VoiceResponse();

  twiml.say("Hello. This is your AI dialer test call.");

  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
