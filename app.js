// -------------------------
// 📡 기본 소켓 연결 (중복 방지)
// -------------------------
let socket;
if (window.activeSocket) {
  socket = window.activeSocket;
} else {
  socket = io();
  window.activeSocket = socket;
}

// -------------------------
// 📞 DOM 요소
// -------------------------
const phoneInput = document.getElementById("phone");
const intentInput = document.getElementById("intent");
const callBtn = document.getElementById("callBtn");
const logEl = document.getElementById("log");
const midText = document.getElementById("midText");
const sayBtn = document.getElementById("sayBtn");
const recommendContainer = document.getElementById("recommendationButtons");

// -------------------------
// 🧾 로그 출력 함수
// -------------------------
function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// -------------------------
// ☎️ 전화걸기 버튼
// -------------------------
callBtn.addEventListener("click", async () => {
  const phone = phoneInput.value.trim();
  const intent = intentInput.value.trim();
  if (!phone || !intent) {
    alert("전화번호와 의도를 입력하세요.");
    return;
  }
  log("발신 요청 중...");

  try {
    const resp = await fetch(
      "https://glancingly-gorsy-zana.ngrok-free.dev/calls",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, intentText: intent }),
      }
    );
    const data = await resp.json();

    if (resp.ok) {
      log(`📞 Call started: ${data.callSid}`);
      log(`🗣️ Script: ${data.script}`);
      socket.emit("bind.call", { callSid: data.callSid });
    } else {
      log(`❌ Error: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    log("네트워크 오류: " + err.message);
  }
});

// -------------------------
// 💬 통화 중 발화 버튼
// -------------------------
sayBtn.addEventListener("click", () => {
  const text = midText.value.trim();
  if (!text) return alert("문장을 입력하세요.");
  log("🎤 통화 중 발화 요청: " + text);

  socket.emit("say", { text });

  midText.value = "";
  midText.focus();
});

// -------------------------
// 📥 서버 응답 로그 이벤트
// -------------------------
socket.on("say.result", () => {
  log("✅ 발화 대기열 등록 완료 (침묵 시 재생 예정)");
});
socket.on("say.error", (data) => {
  log("❌ SAY 오류: " + data.message);
});
socket.on("stt.final", (d) => {
  log("🎧 인식 결과: " + d.text);
});
socket.on("call.event", (d) => {
  log("📞 Call Event: " + JSON.stringify(d));
});

// -------------------------
// 🌟 Gemini 추천답변 수신
// -------------------------
socket.on("recommendations", (data) => {
  const { callSid, replies } = data;

  const extractReplies = (input) => {
    let arr = [];
    (input || []).forEach((r) => {
      let text = "";
      if (typeof r === "string") text = r;
      else if (r.text) text = r.text;
      else if (r.message) text = r.message;
      else if (r.content) text = r.content;
      else text = JSON.stringify(r);

      text = text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .replace(/\\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      try {
        const possibleArray = text.match(/\[.*\]/s);
        if (possibleArray) {
          const parsed = JSON.parse(possibleArray[0]);
          if (Array.isArray(parsed)) {
            arr.push(...parsed.map((v) => v.toString().trim()));
            return;
          }
        }
      } catch {}

      text = text.replace(/[\[\]\{\}]/g, "").trim();
      text = text
        .replace(/^"+|"+$/g, "")
        .replace(/"/g, "")
        .trim();

      const splitText = text
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      arr.push(...splitText);
    });

    return [...new Set(arr.filter((x) => x.length > 0))];
  };

  const cleanedReplies = extractReplies(replies);
  log("💡 추천답변 수신: " + cleanedReplies.join(" / "));

  recommendContainer.innerHTML = "";
  cleanedReplies.forEach((reply) => {
    const btn = document.createElement("button");
    btn.textContent = reply;
    btn.className = "recommend-btn";
    btn.onclick = () => {
      log(`🗣️ 선택한 답변: ${reply}`);
      socket.emit("replySelected", { text: reply, callSid });
    };
    recommendContainer.appendChild(btn);
  });
});

// -------------------------
// 🪄 초기 기본 추천답변 표시
// -------------------------
document.addEventListener("DOMContentLoaded", () => {
  const defaults = [
    "영업시간과 오늘 예약 가능 여부가 궁금해요.",
    "가격대와 소요시간을 알려주세요.",
    "이번 주말(토/일) 가능한 가장 빠른 시간 알려주세요.",
  ];
  recommendContainer.innerHTML = "";
  defaults.forEach((txt) => {
    const btn = document.createElement("button");
    btn.textContent = txt;
    btn.className = "recommend-btn";
    btn.onclick = () => {
      log(`🗣️ 선택한 답변: ${txt}`);
      socket.emit("replySelected", { text: txt });
    };
    recommendContainer.appendChild(btn);
  });
});
