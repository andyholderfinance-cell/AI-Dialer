require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");
const twilio = require("twilio");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

const client = twilio(accountSid, authToken);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/conversationrelay" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Twilio hits this route first when a call comes in
app.post("/voice", (req, res) => {
  const host = req.headers.host;

  const twiml = `
<Response>
  <Connect>
    <ConversationRelay url="wss://${host}/conversationrelay" />
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

// Outbound dial endpoint
app.post("/dial", async (req, res) => {
  try {
    const phone = req.body.phone;

    const call = await client.calls.create({
      to: phone,
      from: twilioNumber,
      url: `https://${req.headers.host}/voice`,
    });

    res.json({
      success: true,
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Dial error:", error);
    res.status(500).send("Dial failed");
  }
});

// Simple health check route
app.get("/", (req, res) => {
  res.send("AI dialer is running.");
});

// Simple outbound test route
app.get("/testdial", async (req, res) => {
  try {
    const phone = "+18177090206";

    const call = await client.calls.create({
      to: phone,
      from: twilioNumber,
      url: `https://${req.headers.host}/voice`,
    });

    res.send(`Dialing now... Call SID: ${call.sid}`);
  } catch (error) {
    console.error("Test dial error:", error);
    res.status(500).send("Test dial failed");
  }
});

// Twilio opens a WebSocket here for the live conversation
wss.on("connection", (ws) => {
  console.log("Twilio connected to /conversationrelay");

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("Incoming Twilio event:", data);

      // Greeting when session starts
      if (data.type === "setup") {
        ws.send(
          JSON.stringify({
            type: "text",
            token:
              "Hey, this is David, a case worker here in Florida. I'm calling in regards to a mortgage life and disability protection file. It looks like it was opened back when you closed on your home. Does that sound familiar?",
            last: true,
          })
        );
        return;
      }

      // Handle caller speech
      if (data.type === "prompt" && data.voicePrompt) {
        const callerText = data.voicePrompt;
        console.log("Caller said:", callerText);

        const aiResponse = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content: `
You are a calm, professional mortgage protection assistant calling homeowners with a slightly concerned and conversational tone.

Your job is to:
- explain mortgage protection clearly
- answer simple questions
- qualify the homeowner
- help them book a quick appointment with an underwriter

Speak naturally like a real human on the phone.

Rules:
- keep responses under 2 sentences unless asked for details
- ask one question at a time
- never sound robotic or scripted
- never mention AI or automation
- stay friendly and conversational
- speak slowly and use brief pauses between sentences

Goal:
Move the conversation toward scheduling an appointment.
`,
            },
            {
              role: "user",
              content: callerText,
            },
          ],
        });

        const reply =
          aiResponse.output_text ||
          "Sorry, I did not catch that. Could you repeat it?";

        console.log("AI reply:", reply);

        ws.send(
          JSON.stringify({
            type: "text",
            token: reply,
            last: true,
          })
        );
      }
    } catch (error) {
      console.error("WebSocket error:", error);

      ws.send(
        JSON.stringify({
          type: "text",
          token: "Sorry, something went wrong on my side.",
          last: true,
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("Twilio disconnected from /conversationrelay");
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
