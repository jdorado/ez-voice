const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("ez-voice-token") || "";
const loginToken = /^#[a-f0-9]{64}$/.test(location.hash)
  ? location.hash.slice(1)
  : "";
history.replaceState(null, "", "/");
let pc,
  dc,
  mic,
  seq = 0,
  operation = 0;
let state = "idle",
  authorized = false,
  hasHistory = false,
  muted = false;
const status = (message) => {
  $("status").textContent = message;
};
function render() {
  const active = state === "live" || state === "ending";
  $("call").dataset.state = state;
  $("start").hidden = active;
  $("start").disabled = !authorized || state !== "idle";
  $("start-label").textContent =
    state === "connecting"
      ? "Connecting…"
      : hasHistory
        ? "Resume talking"
        : "Start talking";
  $("mute").hidden = !active;
  $("mute").disabled = state !== "live";
  $("mute").setAttribute("aria-pressed", String(muted));
  $("mute-label").textContent = muted ? "Unmute mic" : "Mute mic";
  $("new").hidden = state !== "idle";
  $("new").disabled = !authorized;
  $("stop").hidden = !active;
  $("stop").disabled = state !== "live";
  $("stop-label").textContent = state === "ending" ? "Ending…" : "End call";
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(
      value.error || "Could not connect. Please try again.",
    );
    error.status = response.status;
    throw error;
  }
  return value;
}
function releaseMedia() {
  mic?.getTracks().forEach((track) => track.stop());
  dc?.close();
  pc?.close();
  pc = dc = mic = undefined;
  muted = false;
  $("audio").srcObject = null;
  $("play").hidden = true;
}
function idle(message) {
  releaseMedia();
  state = "idle";
  render();
  status(message);
}
async function play() {
  try {
    await $("audio").play();
    $("play").hidden = true;
  } catch {
    $("play").hidden = false;
    status("Tap Enable sound to hear your agent.");
  }
}
async function start(resume = true) {
  if (!authorized || state !== "idle") return;
  const attempt = ++operation;
  state = "connecting";
  render();
  status("Getting ready…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (attempt !== operation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    mic = stream;
    pc = new RTCPeerConnection();
    pc.ontrack = (event) => {
      if (attempt === operation) {
        $("audio").srcObject = event.streams[0];
        void play();
      }
    };
    pc.onconnectionstatechange = () => {
      if (attempt === operation && pc && pc.connectionState === "failed")
        void end("Connection lost. Try again.");
    };
    mic.getTracks().forEach((track) => pc.addTrack(track, mic));
    dc = pc.createDataChannel("oai-events");
    dc.onmessage = ({ data }) => {
      try {
        if (JSON.parse(data).type === "error" && attempt === operation)
          status("Something went wrong. Try ending the call and reconnecting.");
      } catch {}
    };
    dc.onopen = () => {
      if (attempt === operation) {
        state = "live";
        hasHistory = true;
        render();
        status("Listening");
      }
    };
    const offer = await pc.createOffer();
    if (attempt !== operation) return;
    await pc.setLocalDescription(offer);
    if (attempt !== operation) return;
    const before = await api(`/status?after=${seq}`);
    for (const event of before.events || []) seq = Math.max(seq, event.seq);
    if (attempt !== operation) return;
    const result = await api("/session", { sdp: offer.sdp, resume });
    if (attempt !== operation) {
      await api("/stop", {});
      return;
    }
    await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
  } catch (error) {
    if (attempt !== operation) return;
    await api("/stop", {}).catch(() => {});
    if (attempt !== operation) return;
    if (error.status === 401) authorized = false;
    idle(
      error.name === "NotAllowedError"
        ? "Allow microphone access to start talking."
        : error.name === "NotFoundError"
          ? "No microphone found. Connect one and try again."
          : error.message,
    );
  }
}
async function end(message = "Call ended") {
  const attempt = ++operation;
  state = "ending";
  releaseMedia();
  render();
  status("Ending call…");
  try {
    const result = await api("/stop", {});
    if (attempt !== operation) return;
    idle(
      result.hangupConfirmed === false
        ? "Disconnected. The call may still be ending."
        : message,
    );
  } catch {
    if (attempt !== operation) return;
    idle("Disconnected. Reopen Voice before trying again.");
    authorized = false;
    render();
  }
}
$("start").onclick = () => void start(true);
$("new").onclick = () => void start(false);
$("stop").onclick = () => void end();
$("play").onclick = () => void play();
$("mute").onclick = () => {
  if (state !== "live" || !mic) return;
  muted = !muted;
  mic.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });
  render();
  status(muted ? "Microphone muted" : "Listening");
};
window.addEventListener("pagehide", () => {
  ++operation;
  releaseMedia();
  if (state !== "idle")
    fetch("/stop", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      keepalive: true,
    }).catch(() => {});
});
function readStatus(data) {
  $("identity").textContent = data.agent || "Your agent";
  if (state === "idle") hasHistory = Boolean(data.history?.messages?.length);
  for (const event of data.events || []) {
    if (event.seq <= seq) continue;
    seq = Math.max(seq, event.seq);
    if (event.type === "closed" && state === "live") {
      ++operation;
      idle(
        event.hangupConfirmed === false
          ? "Disconnected. The call may still be ending."
          : "Call ended",
      );
    }
    if (event.type === "error")
      status("Connection interrupted. Please try again.");
  }
  render();
}
async function poll() {
  const attempt = operation;
  try {
    const data = await api(`/status?after=${seq}`);
    if (attempt === operation) readStatus(data);
  } catch (error) {
    if (error.status === 401) {
      authorized = false;
      ++operation;
      sessionStorage.removeItem("ez-voice-token");
      idle("Session expired. Reopen Voice from your agent.");
      return;
    }
    status("Reconnecting…");
  }
  if (authorized) setTimeout(poll, 1000);
}
async function authenticate() {
  render();
  try {
    if (token) {
      try {
        await api("/status");
      } catch {
        token = "";
        sessionStorage.removeItem("ez-voice-token");
      }
    }
    if (!token) {
      const result = await api(
        "/auth",
        loginToken
          ? { token: loginToken }
          : { initData: window.Telegram?.WebApp?.initData || "" },
      );
      token = result.token;
      sessionStorage.setItem("ez-voice-token", token);
    }
    const data = await api("/status");
    authorized = true;
    readStatus(data);
    status("Ready when you are");
    window.Telegram?.WebApp?.ready();
    void poll();
  } catch {
    sessionStorage.removeItem("ez-voice-token");
    status("Open Voice from your agent in Telegram.");
  }
}
void authenticate();
