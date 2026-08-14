// Plugin test: feishu_send tool registers and forwards to the gateway.
// Uses the local dsh-tools stub; fetch is stubbed via globalThis.
import { apply, inject, name } from "../index.js";

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

check(name === "feishu-send", "plugin name is feishu-send");
check(Array.isArray(inject) && inject.includes("tools"), "plugin injects tools");

let registeredTool = null;
const ctx = { tools: { register: (t) => (registeredTool = t) } };
apply(ctx);
check(registeredTool?.name === "feishu_send", "feishu_send tool registered");
check(typeof registeredTool?.execute === "function", "tool has execute");

// stub fetch
const realFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
process.env.DSH_FEISHU_SEND_URL = "http://127.0.0.1:3180";
process.env.DSH_FEISHU_SEND_TOKEN = "tok-1";
try {
  const result = await registeredTool.execute({ text: "**hi** from agent" });
  check(result?.sent === true, "execute returns sent:true");
  check(requests.length === 1 && requests[0].url === "http://127.0.0.1:3180/feishu_send", "posts to gateway /feishu_send");
  const body = JSON.parse(requests[0].init.body);
  check(body.token === "tok-1" && body.text === "**hi** from agent", "payload carries token and text");
} finally {
  globalThis.fetch = realFetch;
  delete process.env.DSH_FEISHU_SEND_URL;
  delete process.env.DSH_FEISHU_SEND_TOKEN;
}

// failure path: gateway returns error
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) });
process.env.DSH_FEISHU_SEND_URL = "http://127.0.0.1:3180";
process.env.DSH_FEISHU_SEND_TOKEN = "tok-1";
try {
  let threw = null;
  try {
    await registeredTool.execute({ text: "x" });
  } catch (e) {
    threw = e;
  }
  check(threw !== null && String(threw.message).includes("boom"), "gateway error surfaces as tool failure");
} finally {
  globalThis.fetch = realFetch;
  delete process.env.DSH_FEISHU_SEND_URL;
  delete process.env.DSH_FEISHU_SEND_TOKEN;
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
