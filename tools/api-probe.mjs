// API probe v2: WebSocket mux + unary RPC against the live harness.
const BASE = "http://127.0.0.1:3080";
const WS = "ws://127.0.0.1:3080/api/events.mux";
let rpcSeq = 0;
const rpcId = () => `probe2-${Date.now()}-${++rpcSeq}`;

async function call(method, payload) {
  const id = rpcId();
  const res = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: id, method, payload }),
  });
  return { id, body: await res.json() };
}

const ws = new WebSocket(WS);
const frames = [];
ws.onmessage = (ev) => {
  try {
    frames.push(JSON.parse(ev.data));
  } catch (e) {
    console.log("non-JSON ws message:", String(ev.data).slice(0, 120));
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = (e) => reject(new Error("ws error"));
  setTimeout(() => reject(new Error("ws open timeout")), 8000);
});
console.log("WS connected");

const created = await call("session.create", {});
const sessionId = created.body.result.value.sessionId;
console.log("sessionId:", sessionId);

const prompt = await call("session.prompt", {
  sessionId,
  mode: "queue",
  content: [{ type: "text", text: "请只回复两个字母：PONG，不要做任何其他事，不要调用任何工具" }],
});
console.log("session.prompt ->", JSON.stringify(prompt.body).slice(0, 200));

const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  const frame = frames.shift();
  if (!frame) {
    await new Promise((r) => setTimeout(r, 250));
    continue;
  }
  const p = frame.payload ?? {};
  if (frame.method === "session/subscribed") {
    console.log("subscribed", p.sessionId, "lastSeq:", p.lastSeq);
    continue;
  }
  if (frame.method === "stream/error") {
    console.log("STREAM ERROR:", JSON.stringify(p.error));
    break;
  }
  if (p.sessionId !== sessionId) continue;
  if (frame.method === "session/event") {
    const ev = p.event ?? {};
    const data = ev.data ?? {};
    if (ev.type === "assistant/message") {
      const blocks = (data.message?.content ?? data.content ?? []).map((b) =>
        b.type === "text" ? `text:${b.text.slice(0, 200)}` : `block:${b.type}`
      );
      console.log("ASSISTANT MESSAGE event.seq=", ev.seq, JSON.stringify(blocks, null, 1).slice(0, 800));
      break;
    }
    console.log("event:", ev.type, JSON.stringify(data).slice(0, 220));
  } else if (frame.method === "session/queue") {
    console.log("queue items:", JSON.stringify(p.items?.map((i) => ({ id: i.id, placement: i.placement, role: i.message?.role }))));
  } else {
    console.log("frame:", frame.method, JSON.stringify(p).slice(0, 220));
  }
}
ws.close();
try {
  const c = await call("session.cancel", { sessionId });
  console.log("cancel ->", JSON.stringify(c.body).slice(0, 160));
} catch {}
process.exit(0);
