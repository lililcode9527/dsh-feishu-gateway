// Local loopback HTTP receiver so a DSH plugin (dsh-feishu-send) can push
// agent-initiated messages ("feishu_send") into Feishu through this gateway.
import { createServer } from "node:http";

/**
 * Start the loopback send server.
 * @param {{ port?: number, token: string, resolveBot: (appName?: string) => {name:string, send:(openId:string, chatId:string|undefined, text:string)=>Promise<any>}|undefined, lastChatFor: (botName:string) => {openId:string, chatId?:string}|undefined }} opts
 */
export async function startSendServer({ port = 3180, token, resolveBot, lastChatFor }) {
  const server = createServer(async (req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== "POST" || (req.url ?? "/").split("?")[0] !== "/feishu_send") {
      json(404, { ok: false, error: "not found" });
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      json(400, { ok: false, error: "bad json" });
      return;
    }
    if (payload.token !== token) {
      json(403, { ok: false, error: "forbidden" });
      return;
    }
    const text = String(payload.text ?? "");
    if (!text.trim()) {
      json(400, { ok: false, error: "empty text" });
      return;
    }
    const bot = resolveBot(payload.appName);
    if (!bot) {
      json(404, { ok: false, error: `bot not found: ${payload.appName ?? "(default)"}` });
      return;
    }
    const target = payload.openId ? { openId: payload.openId } : lastChatFor(bot.name);
    if (!target) {
      json(400, { ok: false, error: "no target chat: pass openId, or have the user message the bot first" });
      return;
    }
    try {
      await bot.send(target.openId, target.chatId, text);
      json(200, { ok: true });
    } catch (err) {
      json(500, { ok: false, error: String(err?.message ?? err) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
