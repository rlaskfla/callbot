require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const bodyParser = require("body-parser");
const Twilio = require("twilio");
const { createServer } = require("http");
const { Server: IOServer } = require("socket.io");
const WebSocket = require("ws");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fsp = require("fs").promises;
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const httpServer = createServer(app);
const io = new IOServer(httpServer);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  GEMINI_API_KEY,
  PORT = 3003,
  PUBLIC_HOST,
} = process.env;

if (
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_FROM_NUMBER ||
  !AZURE_SPEECH_KEY ||
  !AZURE_SPEECH_REGION ||
  !PUBLIC_HOST
) {
  console.warn(
    "⚠️ 환경변수 미설정: TWILIO_*, AZURE_SPEECH_*, PUBLIC_HOST 필요."
  );
}

const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ---------- 오디오 폴더 ----------
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {}
}

// ---------- Azure TTS ----------
async function synthesizeToFile(text, filename) {
  await ensureDir(AUDIO_DIR);
  const audioFile = path.join(AUDIO_DIR, filename);
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      AZURE_SPEECH_KEY,
      AZURE_SPEECH_REGION
    );
    speechConfig.speechSynthesisLanguage = "ko-KR";
    speechConfig.speechSynthesisVoiceName = "ko-KR-SunHiNeural";
    speechConfig.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Riff8Khz8BitMonoMULaw;
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(audioFile);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    synthesizer.speakTextAsync(
      text || "",
      () => {
        synthesizer.close();
        console.log("[TTS 완료]", audioFile);
        resolve(audioFile);
      },
      (err) => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

// ---------- Twilio 재생 ----------
async function playToCall(callSid, audioUrl) {
  const base = PUBLIC_HOST;
  const wsBase = base.startsWith("https")
    ? base.replace(/^https/, "wss")
    : base.replace(/^http/, "ws");
  const wsUrl = `${wsBase}/media?callSid=${encodeURIComponent(callSid)}`;
  const twiml = [
    "<Response>",
    `<Start><Stream url=\"${wsUrl}\"/></Start>`,
    `<Play>${audioUrl}</Play>`,
    `<Pause length=\"1\"/>`,
    `<Redirect method=\"POST\">${base}/twilio/hold</Redirect>`,
    "</Response>",
  ].join("");
  console.log("📨 Twilio update callSid:", callSid);
  return twilioClient.calls(callSid).update({ twiml });
}

// ---------- 발신 ----------
function generateCallScript(intentText) {
  return `안녕하세요. 고객님을 대신해 간단히 문의드립니다. ${intentText}. 가능/불가능만 알려주시면 감사하겠습니다.`;
}

app.post("/calls", async (req, res) => {
  try {
    const { phone, intentText } = req.body;
    if (!phone || !intentText)
      return res.status(400).json({ error: "phone and intentText required" });

    const script = generateCallScript(intentText);
    const filename = `${uuidv4()}.wav`;
    await synthesizeToFile(script, filename);
    const audioUrl = `${PUBLIC_HOST}/audio/${filename}`;

    const call = await twilioClient.calls.create({
      url: `${PUBLIC_HOST}/twilio/answer?audioUrl=${encodeURIComponent(
        audioUrl
      )}`,
      to: phone,
      from: TWILIO_FROM_NUMBER,
    });

    console.log("📞 Call initiated:", call.sid);
    res.json({ callSid: call.sid, script, audioUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- TwiML (항상 callSid를 Stream URL에 포함) ----------
app.all("/twilio/answer", (req, res) => {
  const audioUrl = req.query.audioUrl;
  const callSid = req.body?.CallSid || req.query?.CallSid || "unknown";
  const wsBase = PUBLIC_HOST.startsWith("https")
    ? PUBLIC_HOST.replace(/^https/, "wss")
    : PUBLIC_HOST.replace(/^http/, "ws");
  const wsUrl = `${wsBase}/media?callSid=${encodeURIComponent(callSid)}`;

  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Start><Stream url=\"${wsUrl}\"/></Start>`,
    `<Play>${audioUrl}</Play>`,
    '<Pause length="60"/>',
    `<Redirect method=\"POST\">${PUBLIC_HOST}/twilio/hold</Redirect>`,
    "</Response>",
  ];
  res.type("text/xml").send(twiml.join("\n"));
});

app.all("/twilio/hold", (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || "unknown";
  const wsUrl = `${PUBLIC_HOST.replace(
    /^http/,
    "ws"
  )}/media?callSid=${encodeURIComponent(callSid)}`;
  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Start><Stream url=\"${wsUrl}\"/></Start>`,
    '<Pause length="60"/>',
    `<Redirect method=\"POST\">${PUBLIC_HOST}/twilio/hold</Redirect>`,
    "</Response>",
  ];
  res.type("text/xml").send(twiml.join("\n"));
});

app.use("/audio", express.static(AUDIO_DIR));

// ---------- μ-law → PCM16 ----------
function mulawToPcm16(mulawBuffer) {
  const out = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    let mu = ~mulawBuffer[i] & 0xff;
    const sign = mu & 0x80 ? -1 : 1;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample = sign * sample;
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

// ---------- STT + 대화기억형 Gemini ----------
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
const activeStreams = new Map();

httpServer.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/media")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else socket.destroy();
});

wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.split("?")[1] || "");
  let callSid = params.get("callSid") || null;

  // ✅ Twilio 'start' 이벤트로 받은 callSid로 확정
  function bindCallSid(newSid) {
    if (!newSid) return;
    if (callSid === newSid && activeStreams.get(newSid) === ws) return;

    if (activeStreams.has(newSid)) {
      try {
        activeStreams.get(newSid).close();
      } catch {}
      activeStreams.delete(newSid);
    }
    if (callSid && activeStreams.get(callSid) === ws) {
      activeStreams.delete(callSid);
    }
    callSid = newSid;
    activeStreams.set(callSid, ws);
    console.log("Twilio Media WS connected:", callSid);
  }

  if (callSid) bindCallSid(callSid);
  else console.log("Twilio Media WS connected: (awaiting start)");

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    AZURE_SPEECH_KEY,
    AZURE_SPEECH_REGION
  );
  speechConfig.speechRecognitionLanguage = "ko-KR";
  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  let lastRecognizedText = "";
  let lastRecognizedTime = 0;
  let conversationHistory = [];

  function isDuplicateRecognition(text) {
    const now = Date.now();
    const tooSoon = now - lastRecognizedTime < 2500;
    const isSame = text === lastRecognizedText;
    if ((isSame && tooSoon) || (text.length <= 3 && tooSoon)) return true;
    lastRecognizedText = text;
    lastRecognizedTime = now;
    return false;
  }

  // ✅ 최종 인식만 처리 (중간 인식 무시)
  recognizer.recognized = async (s, e) => {
    if (
      !e.result ||
      e.result.reason !== sdk.ResultReason.RecognizedSpeech ||
      !e.result.text.trim()
    )
      return;

    const text = e.result.text.trim();
    if (isDuplicateRecognition(text)) return;

    console.log("[🎧 최종 인식 결과]", text);
    conversationHistory.push({ role: "user", content: text });
    if (conversationHistory.length > 20)
      conversationHistory = conversationHistory.slice(-20);

    io.emit("stt.final", { text, callSid });

    try {
      const model = genAI.getGenerativeModel({
        model: "models/gemini-2.0-flash",
      });

      const historyText = conversationHistory
        .map((m) => `${m.role === "user" ? "사용자" : "AI"}: ${m.content}`)
        .join("\n");

      const prompt = `
너는 지금 전화를 건 "손님"의 역할입니다.
너는 가게, 식당, 병원, 전시회 등에서 예약 또는 문의를 하고 있습니다.

### 절대 지켜야 하는 규칙
1) 너는 **손님**이고 상대방은 **직원**입니다. 절대 직원처럼 말하지 않습니다.
2) 상대방이 이미 정보를 줬다면 **추가로 되묻지 않습니다.**
3) 상대방이 "예약해드리겠습니다 / 처리하겠습니다 / 알겠습니다 / 확인했습니다" 등
   **대화를 종료하는 표현을 사용하면, 바로**  
   → "네, 감사합니다." **한 문장으로 끝냅니다.**
4) 불필요한 질문, 확장 질문, 새로운 제안 금지.
5) 답변은 항상 **짧고 명확하게**, 한 문장.
6) 문장은 **정중한 요청 또는 간단한 답변 형태**로 끝납니다.
7) **과거 대화를 모두 기억하는 것처럼 일관되게 응답**합니다. (이미 말한 내용을 반복하지 않음)

### 예시
- "오늘 7시 두 명 예약 가능할까요?"
- "네, 두 명 모두 성인입니다."
- "그러면 6시로 부탁드리겠습니다."
- "네, 감사합니다."

### 입력
지금까지의 대화 기록: ${historyText}
상대방이 방금 말한 내용: "${text}"

### 출력 형식
- 손님의 다음 발화 1문장만 출력
- 추가 설명, 괄호, 따옴표, 해설 금지


      `;

      const result = await model.generateContent(prompt);
      let replyText = result.response.text().trim();
      replyText = replyText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      let replies = [];
      try {
        const parsed = JSON.parse(replyText);
        if (Array.isArray(parsed))
          replies = parsed.map((v) => v.toString().trim());
      } catch {
        replies = replyText
          .split(/[\n,]/)
          .map((v) => v.trim().replace(/^"+|"+$/g, ""))
          .filter(Boolean);
      }

      replies = [...new Set(replies)].slice(0, 3);
      io.emit("recommendations", { callSid, replies });
      conversationHistory.push({
        role: "assistant",
        content: replies.join(" / "),
      });
    } catch (err) {
      console.error("[Gemini 오류]", err);
    }
  };

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        const sid = data.start?.callSid || data.callSid;
        if (sid) bindCallSid(sid);
        console.log("🎧 Media stream started:", callSid || sid || "(unknown)");
      } else if (data.event === "media" && data.media?.payload) {
        const mulaw = Buffer.from(data.media.payload, "base64");
        const pcm16 = mulawToPcm16(mulaw);
        pushStream.write(pcm16);
      } else if (data.event === "stop") {
        console.log("🛑 Media stream stopped:", callSid || "(unknown)");
        pushStream.close();
        recognizer.stopContinuousRecognitionAsync(() => recognizer.close());
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  });

  ws.on("close", () => {
    console.log("🔚 Twilio WS closed:", callSid || "(unknown)");
    if (callSid && activeStreams.get(callSid) === ws) {
      activeStreams.delete(callSid);
    }
    pushStream.close();
    recognizer.stopContinuousRecognitionAsync(() => recognizer.close());
  });

  recognizer.startContinuousRecognitionAsync(
    () => console.log("[STT] Recognition started:", callSid || "(pending)"),
    (err) => console.error("[STT] start error", err)
  );
});

// ---------- 프론트 소켓 ----------
io.on("connection", (socket) => {
  console.log("Frontend socket.io connected");

  socket.on("bind.call", ({ callSid }) => {
    console.log("🔗 callSid 연결됨:", callSid);
    socket.data.callSid = callSid;
  });

  socket.on("replySelected", async ({ text, callSid }) => {
    try {
      const filename = `${uuidv4()}.wav`;
      await synthesizeToFile(text, filename);
      const audioUrl = `${PUBLIC_HOST}/audio/${filename}`;
      await playToCall(callSid, audioUrl);
      console.log("🔊 버튼 TTS 재생:", text);
    } catch (err) {
      console.error("버튼 재생 오류:", err);
    }
  });

  socket.on("say", async ({ text }) => {
    try {
      const sockets = await io.fetchSockets();
      const active = sockets.find((s) => s.data?.callSid);
      const callSid = active ? active.data.callSid : null;
      if (!callSid) {
        socket.emit("say.error", { message: "통화 중이 아닙니다." });
        return;
      }
      const filename = `${uuidv4()}.wav`;
      await synthesizeToFile(text, filename);
      const audioUrl = `${PUBLIC_HOST}/audio/${filename}`;
      await playToCall(callSid, audioUrl);
      socket.emit("say.result", { ok: true });
      console.log("🔊 [say 재생 성공]:", text);
    } catch (err) {
      socket.emit("say.error", { message: err.message });
    }
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

httpServer.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`PUBLIC_HOST=${PUBLIC_HOST}`);
});
