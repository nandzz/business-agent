// The /debug/whatsapp page: a customer phone and the business's WhatsApp Business
// app side by side. Plain HTML + JS, no build step; long-polls /debug/whatsapp/api/chat
// (one request per change or per 25 s, none while the tab is hidden).
export const DEBUG_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Debug WhatsApp</title>
<style>
  :root {
    --bg: #eae6df; --panel: #f0f2f5; --chat: #efeae2; --in: #ffffff; --mine: #d9fdd3;
    --text: #111b21; --muted: #667781; --accent: #00a884; --tick: #53bdeb; --line: #d1d7db;
    --warn-bg: #fff3c4; --warn: #6b5200;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c1317; --panel: #202c33; --chat: #0b141a; --in: #202c33; --mine: #005c4b;
      --text: #e9edef; --muted: #8696a0; --line: #2a3942; --warn-bg: #3a3000; --warn: #ffd866;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--text); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .bar h1 { font-size: 15px; margin: 0 12px 6px 0; }
  .bar label { display: flex; flex-direction: column; font-size: 11px; color: var(--muted); gap: 2px; }
  .bar input { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--chat); color: var(--text); width: 190px; }
  button { font: inherit; border: 1px solid var(--line); background: var(--chat); color: var(--text); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .hint { flex-basis: 100%; font-size: 12px; color: var(--muted); }
  .hint a { color: var(--accent); }
  .phones { flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; padding: 16px; min-height: 0; }
  .phone { display: flex; flex-direction: column; min-height: 420px; max-width: 520px; width: 100%; justify-self: center; border-radius: 16px; overflow: hidden; border: 1px solid var(--line); background: var(--chat); }
  .head { background: var(--panel); padding: 10px 14px; display: flex; gap: 10px; align-items: center; }
  .avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 600; flex: none; }
  .head .who { font-weight: 600; }
  .head .sub { font-size: 12px; color: var(--muted); }
  .head .sub.typing { color: var(--accent); }
  .role { margin-left: auto; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .banner { background: var(--warn-bg); color: var(--warn); font-size: 12px; padding: 6px 14px; display: none; }
  .msgs { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; scrollbar-width: none; }
  .msgs::-webkit-scrollbar { display: none; }
  .empty { margin: auto; color: var(--muted); font-size: 13px; text-align: center; }
  .b { max-width: 80%; padding: 6px 9px 4px; border-radius: 8px; background: var(--in); white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 1px .5px rgba(11,20,26,.13); }
  .b.mine { align-self: flex-end; background: var(--mine); }
  .b .tag { font-size: 11px; font-weight: 600; color: var(--accent); display: block; }
  .b .meta { font-size: 11px; color: var(--muted); float: right; margin: 6px 0 0 10px; }
  .b .meta .tk.read { color: var(--tick); }
  .b audio { display: block; height: 34px; max-width: 240px; }
  .compose { display: flex; gap: 8px; padding: 8px 10px; background: var(--panel); }
  .compose input { flex: 1; font: inherit; padding: 9px 12px; border: none; border-radius: 8px; background: var(--chat); color: var(--text); outline: none; }
  .compose button { border-radius: 50%; width: 38px; height: 38px; padding: 0; background: var(--accent); color: #fff; border: none; }
  .compose button.rec { background: #e5484d; }
  .err { color: #e5484d; font-size: 12px; padding: 0 14px 6px; background: var(--panel); min-height: 0; }
</style>
</head>
<body>
<div class="bar">
  <h1>Debug WhatsApp</h1>
  <label>Business phone_number_id <input id="pn"></label>
  <label>Customer number <input id="wa" inputmode="numeric"></label>
  <label>Customer name <input id="name"></label>
  <button id="newCustomer" title="Random customer number">New customer</button>
  <button id="reset" title="Clears this chat here and the agent's working memory (the Supabase thread stays)">Reset chat</button>
  <div class="hint">Agent, mcp-agent and Supabase dev are real: bookings land in dev. Decide pending requests in the local portal (<a href="http://localhost:3000/dashboard/my-agent" target="_blank">My Agent → Activity</a>); the customer hears back here. Typing as the business pauses the agent.</div>
</div>
<div class="phones">
  <section class="phone">
    <div class="head"><div class="avatar" id="bizAvatar">B</div><div><div class="who">Business</div><div class="sub" id="cSub">online</div></div><span class="role">Customer phone</span></div>
    <div class="msgs" id="cMsgs"></div>
    <div class="err" id="cErr"></div>
    <form class="compose" id="cForm"><input id="cText" maxlength="1024" placeholder="Message as the customer" autocomplete="off"><button type="button" id="mic" title="Record a voice note">🎤</button><button title="Send">➤</button></form>
  </section>
  <section class="phone">
    <div class="head"><div class="avatar" id="custAvatar">C</div><div><div class="who" id="custName">Customer</div><div class="sub" id="bSub"></div></div><span class="role">Business app</span></div>
    <div class="banner" id="paused"></div>
    <div class="msgs" id="bMsgs"></div>
    <div class="err" id="bErr"></div>
    <form class="compose" id="bForm"><input id="bText" maxlength="4096" placeholder="Reply as the owner (takes over)" autocomplete="off"><button title="Send">➤</button></form>
  </section>
</div>
<script>
const $ = (id) => document.getElementById(id);
const store = { get(k, d) { try { return localStorage.getItem("debugwa." + k) || d; } catch { return d; } }, set(k, v) { try { localStorage.setItem("debugwa." + k, v); } catch {} } };
const randomWa = () => "39333" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
$("pn").value = store.get("pn", "TEST_PHONE_NUMBER_ID");
$("wa").value = store.get("wa", randomWa());
$("name").value = store.get("name", "Giulia");
for (const k of ["pn", "wa", "name"]) $(k).addEventListener("change", () => { store.set(k, $(k).value.trim()); last = ""; kick(); });

const q = () => "pn=" + encodeURIComponent($("pn").value.trim()) + "&wa=" + encodeURIComponent($("wa").value.trim());
const time = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function bubble(m, side) {
  // side: which phone. Customer's own = in; business's own = out + owner.
  const mine = side === "customer" ? m.direction === "in" : m.direction !== "in";
  const tag = m.direction === "out" ? "Agent" : m.direction === "owner" ? (side === "business" ? "You" : "") : "";
  const body = m.kind === "voice"
    ? '<audio controls preload="none" src="/debug/whatsapp/api/media?' + q() + "&id=" + encodeURIComponent(m.body) + '"></audio>'
    : esc(m.body);
  const ticks = m.direction === "in" && side === "customer" ? ' <span class="tk ' + (m.status === "read" ? "read" : "") + '">✓✓</span>' : "";
  return '<div class="b' + (mine ? " mine" : "") + '">' + (tag ? '<span class="tag">' + tag + "</span>" : "") + body +
    '<span class="meta">' + time(m.at) + ticks + "</span></div>";
}

function render(el, html) {
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = html;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

let last = "";
let data = null;
let version = 0;
let inflight = null;
async function refresh(wait) {
  const name = $("name").value.trim() || "Customer";
  $("custName").textContent = name;
  $("custAvatar").textContent = name[0].toUpperCase();
  $("bSub").textContent = "+" + $("wa").value.trim();
  try {
    inflight = new AbortController();
    const res = await fetch("/debug/whatsapp/api/chat?" + q() + (wait && version ? "&v=" + version : ""), { signal: inflight.signal });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.status);
    data = json;
    version = json.version;
    fetchedAt = Date.now();
    const why = { agent_disabled: "the agent is switched off (My Agent header switch)", not_connected: "this phone_number_id has no active WhatsApp connection" };
    $("cErr").textContent = data.dryRun ? "DRY_RUN=1: the agent's replies are only logged. Set DRY_RUN=0 in .dev.vars."
      : data.lastSkip ? "No reply: " + (why[data.lastSkip.reason] || data.lastSkip.reason) + "." : "";
  } catch (e) {
    if (e.name === "AbortError") return true;
    $("cErr").textContent = String(e.message || e);
    return false;
  } finally { inflight = null; }
  const key = JSON.stringify([data.messages, data.typing]);
  if (key !== last) {
    last = key;
    const empty = '<div class="empty">No messages yet</div>';
    render($("cMsgs"), data.messages.map((m) => bubble(m, "customer")).join("") || empty);
    render($("bMsgs"), data.messages.map((m) => bubble(m, "business")).join("") || empty);
  }
  $("cSub").textContent = data.typing ? "typing…" : data.pending ? "online · " + data.pending + " waiting" : "online";
  $("cSub").className = "sub" + (data.typing ? " typing" : "");
  tickPause();
  return true;
}

function tickPause() {
  if (!data) return;
  const left = data.pausedUntil - data.now - (Date.now() - fetchedAt);
  const b = $("paused");
  if (left > 0) {
    const s = Math.ceil(left / 1000);
    b.textContent = "Agent paused (owner takeover) · " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " left";
    b.style.display = "block";
  } else b.style.display = "none";
}
let fetchedAt = Date.now();
setInterval(tickPause, 1000);
// Long-poll while the tab is visible; back off on errors.
let looping = false;
async function loop() {
  if (looping) return;
  looping = true;
  while (!document.hidden) {
    const ok = await refresh(true);
    if (!ok) await new Promise((r) => setTimeout(r, 3000));
  }
  looping = false;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { kick(); loop(); } });
// Something changed on our side: drop the waiting request so the loop refetches now.
function kick() { version = 0; if (inflight) inflight.abort(); else if (!looping) refresh(false); }
loop();

async function post(path, body, errEl, type = "application/json") {
  errEl.textContent = "";
  const res = await fetch(path + "?" + q() + "&name=" + encodeURIComponent($("name").value.trim()), { method: "POST", headers: { "content-type": type }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) errEl.textContent = json.error || ("webhook " + (json.webhook || res.status));
  kick();
  // The takeover pause and queue count land just after the webhook returns.
  setTimeout(kick, 1500);
}

$("cForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("cText").value.trim(); if (!text) return;
  $("cText").value = "";
  post("/debug/whatsapp/api/send", JSON.stringify({ text, as: "customer", name: $("name").value.trim() }), $("cErr"));
});
$("bForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("bText").value.trim(); if (!text) return;
  $("bText").value = "";
  post("/debug/whatsapp/api/send", JSON.stringify({ text, as: "owner" }), $("bErr"));
});
$("newCustomer").addEventListener("click", () => { $("wa").value = randomWa(); store.set("wa", $("wa").value); last = ""; kick(); });
$("reset").addEventListener("click", async () => {
  if (!confirm("Reset this chat?")) return;
  await fetch("/debug/whatsapp/api/reset?" + q(), { method: "POST" });
  last = ""; kick();
});

// Voice notes: click to start, click again to send.
let rec = null;
$("mic").addEventListener("click", async () => {
  if (rec) { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = (rec.mimeType || "audio/webm").split(";")[0];
      rec = null; $("mic").classList.remove("rec"); $("mic").textContent = "🎤";
      post("/debug/whatsapp/api/voice", new Blob(chunks, { type }), $("cErr"), type);
    };
    rec.start();
    $("mic").classList.add("rec"); $("mic").textContent = "■";
  } catch (e) { $("cErr").textContent = "Microphone: " + (e.message || e); rec = null; }
});
</script>
</body>
</html>`;
