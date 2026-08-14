// dsh-feishu-send — DSH web-profile plugin registering the `feishu_send` tool.
// The tool forwards agent-initiated messages to the standalone
// dsh-feishu-gateway process via its loopback HTTP receiver.
//
// Configuration resolution (in order):
//   1. env DSH_FEISHU_SEND_URL + DSH_FEISHU_SEND_TOKEN
//   2. ~/.dsh-feishu-gateway.json  (auto-written by the gateway on start)
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const name = "feishu-send";
const inject = ["tools"];
const HOME_CONFIG = join(os.homedir(), ".dsh-feishu-gateway.json");

function resolveGateway() {
  const envUrl = process.env.DSH_FEISHU_SEND_URL;
  const envToken = process.env.DSH_FEISHU_SEND_TOKEN;
  if (envUrl && envToken) return { url: envUrl, token: envToken };
  try {
    if (existsSync(HOME_CONFIG)) {
      const j = JSON.parse(readFileSync(HOME_CONFIG, "utf8"));
      if (j && j.url && j.token) return { url: j.url, token: j.token };
    }
  } catch {
    // fall through
  }
  return null;
}

function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "feishu_send",
      description:
        "Proactively send a message (markdown supported) to the user's Feishu chat through the local dsh-feishu-gateway. Use when you need to push a result, notification, or follow-up to the user instead of waiting for their next message. Requires the gateway process to be running.",
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "Message text to send (markdown: **bold**, `code`, lists, links)."
        },
        appName: {
          type: "string",
          description: "Which gateway bot to send through (name in bots.json). Defaults to the bot that most recently received a message."
        },
        openId: {
          type: "string",
          description: "Explicit Feishu open_id to send to. Defaults to the most recent chat of that bot."
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sent: { type: "boolean", required: true }
          }
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
      },
      async execute(args) {
        const gw = resolveGateway();
        if (!gw) {
          throw new Error(
            "feishu_send: gateway not reachable — set env DSH_FEISHU_SEND_URL / DSH_FEISHU_SEND_TOKEN, or start dsh-feishu-gateway once so it writes ~/.dsh-feishu-gateway.json"
          );
        }
        const res = await fetch(`${gw.url}/feishu_send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: gw.token, appName: args.appName, openId: args.openId, text: args.text })
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) {
          throw new Error(`feishu_send failed: ${body?.error ?? `HTTP ${res.status}`}`);
        }
        return { sent: true };
      }
    })
  );
}

export { apply, inject, name };
