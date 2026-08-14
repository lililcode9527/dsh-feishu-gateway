// Tests for the loopback feishu_send receiver (gateway side).
import { startSendServer } from "../src/send-server.js";

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

const sent = [];
const lastChat = new Map([["default", { openId: "ou_last", chatId: "oc_last" }]]);
const server = await startSendServer({
  port: 3199,
  token: "test-token",
  resolveBot: (appName) => {
    if (appName !== undefined && appName !== "default") return undefined;
    return {
      name: "default",
      send: async (openId, chatId, text) => sent.push({ openId, chatId, text }),
    };
  },
  lastChatFor: (botName) => lastChat.get(botName),
});
const base = "http://127.0.0.1:3199";

const post = async (path, body) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

// wrong token -> 403
{
  const r = await post("/feishu_send", { token: "nope", text: "hi" });
  check(r.status === 403 && r.body.ok === false, "wrong token rejected (403)");
}
// explicit openId -> sends
{
  const r = await post("/feishu_send", { token: "test-token", openId: "ou_x", text: "**hi**" });
  check(r.status === 200 && r.body.ok === true, "explicit openId accepted");
  check(sent.some((s) => s.openId === "ou_x" && s.text === "**hi**"), "message sent to explicit openId");
}
// no openId -> last chat
{
  const r = await post("/feishu_send", { token: "test-token", text: "to last" });
  check(r.status === 200, "last-chat target accepted");
  check(sent.some((s) => s.openId === "ou_last" && s.chatId === "oc_last" && s.text === "to last"), "message sent to last chat");
}
// unknown bot -> 404
{
  const r = await post("/feishu_send", { token: "test-token", text: "x", appName: "ghost" });
  check(r.status === 404, "unknown bot rejected (404)");
}
// empty text -> 400
{
  const r = await post("/feishu_send", { token: "test-token", text: "   " });
  check(r.status === 400, "empty text rejected (400)");
}
// GET -> 404
{
  const r = await fetch(base + "/feishu_send");
  check(r.status === 404, "GET rejected (404)");
}

server.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
