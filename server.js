require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");

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

// Simple health check route so you can test the app in browser
app.get("/", (req, res) => {
  res.send("AI dialer is running.");
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
              "Hey, this is David, a case worker here in Florida... I'm calling about a mortgage life and disability protection file that was opened up back when you closed on you're home... Does that sound familiar?,
            last: true,
          })
        );
        return;
      }

      // Handle caller speech
      if (data.type === "prompt" && data.voicePrompt) {
        const callerText = data.voicePrompt;

        const aiResponse = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
content: `
You are a calm, professional mortgage protection assistant named David, calling homeowners.

Your job is to:
• explain mortgage protection clearly
• answer simple questions
• qualify the homeowner
• help them book a quick appointment with an underwriter

Speak naturally like a real human on the phone.

Rules:
• keep responses under 2 sentences unless asked for details
• ask one question at a time
• never sound robotic or scripted
• never mention AI or automation
• stay friendly and conversational

Goal:
Move the conversation toward scheduling an appointment.
`
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
