// Feishu (Lark) bot transport. Long-connection mode via Lark.WSClient,
// supports: text messages, image messages, file messages, interactive
// approval cards with button callbacks (card.action.trigger over WS),
// plus a dry-run mode (no credentials) for local testing.

export class FeishuBot {
  constructor({ appId, appSecret }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.client = null;
    this.wsClient = null;
    this.messageHandler = null;
    this.cardHandler = null;
    this.dryRun = !appId || !appSecret;
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  onCardAction(handler) {
    this.cardHandler = handler;
  }

  async start() {
    if (this.dryRun) {
      console.warn("[feishu] dry-run mode: no FEISHU_APP_ID/FEISHU_APP_SECRET, outgoing messages will be logged only");
      return;
    }
    const lark = await import("@larksuiteoapi/node-sdk");
    this.client = new lark.Client({ appId: this.appId, appSecret: this.appSecret });
    this.wsClient = new lark.WSClient({ appId: this.appId, appSecret: this.appSecret, loggerLevel: lark.LoggerLevel.info });
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const sender = data?.sender ?? {};
        const message = data?.message ?? {};
        const openId = sender.sender_id?.open_id;
        const chatId = message.chat_id;
        const messageType = message.message_type ?? "text";
        const contentRaw = message.content ?? "";
        if (!openId) return;
        // Forward every message type; the plugin decides what to do (text,
        // image -> download for the agent, etc.)
        let text = "";
        if (messageType === "text") {
          try {
            const parsed = JSON.parse(contentRaw);
            text = parsed.text ?? parsed.content ?? "";
          } catch {
            text = String(contentRaw ?? "");
          }
        }
        if (this.messageHandler) {
          await this.messageHandler({
            openId,
            chatId,
            text: text.trim(),
            messageId: message.message_id,
            messageType,
            contentRaw,
          });
        }
      },
      "card.action.trigger": async (data) => {
        // RawCardActionEvent: { operator:{open_id}, action:{value,tag}, context:{open_chat_id} }
        const action = data?.action ?? {};
        const operator = data?.operator ?? {};
        const openId = operator.open_id ?? data?.open_id;
        const chatId = data?.context?.open_chat_id ?? data?.open_chat_id;
        const value = action.value ?? {};
        if (!openId) return;
        if (this.cardHandler) {
          try {
            await this.cardHandler({ openId, chatId, value });
          } catch (err) {
            console.error("[feishu] card action handler error:", err);
          }
        }
      },
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log("[feishu] long-connection started (WS)");
  }

  connectionStatus() {
    return this.wsClient?.getConnectionStatus?.() ?? null;
  }

  stop() {
    try {
      this.wsClient?.close?.({ force: true });
    } catch {}
  }

  /** Send a plain-text message into the chat the user messaged from. */
  async sendText(openId, chatId, text) {
    const content = JSON.stringify({ text });
    if (this.dryRun) {
      console.log(`[feishu:dry] -> ${openId} (chat ${chatId}): ${text.slice(0, 500)}`);
      return;
    }
    console.log(`[feishu] -> ${openId} (chat ${chatId}): ${text.slice(0, 120)}`);
    await this.sendMessage(openId, chatId, "text", content);
  }

  /**
   * Send a message as an interactive card with lark_md content, so markdown
   * (bold/code/lists/links) renders instead of showing raw source.
   */
  async sendMarkdown(openId, chatId, text) {
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content: text }],
    };
    if (this.dryRun) {
      console.log(`[feishu:dry] -> ${openId} (chat ${chatId}): card(md): ${text.slice(0, 500)}`);
      return;
    }
    console.log(`[feishu] -> ${openId} (chat ${chatId}): card(md): ${text.slice(0, 120)}`);
    await this.sendMessage(openId, chatId, "interactive", JSON.stringify(card));
  }

  /** Upload and send an image message (base64 payload from DSH session.attachment). */
  async sendImage(openId, chatId, { data, mediaType }) {
    if (this.dryRun) {
      const approxBytes = Math.round((data?.length ?? 0) * 3 / 4);
      console.log(`[feishu:dry] -> ${openId} (chat ${chatId}): image (${mediaType}, ~${approxBytes} B)`);
      return;
    }
    console.log(`[feishu] -> ${openId} (chat ${chatId}): image (${mediaType})`);
    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0) throw new Error("empty image data");
    const uploaded = await this.client.im.v1.image.create({
      data: { image_type: "message", image: buffer },
    });
    const imageKey = uploaded?.image_key;
    if (!imageKey) throw new Error("image upload returned no image_key");
    await this.sendMessage(openId, chatId, "image", JSON.stringify({ image_key: imageKey }));
  }

  /** Upload and send a file message. */
  async sendFile(openId, chatId, { fileName, buffer }) {
    if (this.dryRun) {
      console.log(`[feishu:dry] -> ${openId} (chat ${chatId}): file ${fileName} (${buffer?.length ?? 0} B)`);
      return;
    }
    console.log(`[feishu] -> ${openId} (chat ${chatId}): file ${fileName} (${buffer?.length ?? 0} B)`);
    const uploaded = await this.client.im.v1.file.create({
      data: { file_type: "stream", file_name: fileName, file: buffer },
    });
    const fileKey = uploaded?.file_key;
    if (!fileKey) throw new Error("file upload returned no file_key");
    await this.sendMessage(openId, chatId, "file", JSON.stringify({ file_key: fileKey }));
  }

  /** Send an interactive approval card with 允许/拒绝 buttons. */
  async sendApprovalCard(openId, chatId, { toolName, reason, rpcId, approvalId, sessionId }) {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: "🔐 需要授权" } },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**调用工具：** \`${toolName}\`\n${reason ? `**原因：** ${reason}` : "该操作需要你的批准"}`,
          },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "✅ 允许" },
              type: "primary",
              value: { kind: "approval", rpcId, approvalId, sessionId, outcome: "allowed-once" },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "🚫 拒绝" },
              type: "danger",
              value: { kind: "approval", rpcId, approvalId, sessionId, outcome: "rejected" },
            },
          ],
        },
      ],
    };
    if (this.dryRun) {
      console.log(`[feishu:dry] -> ${openId} (chat ${chatId}): approval card (${toolName})`);
      return;
    }
    console.log(`[feishu] -> ${openId} (chat ${chatId}): approval card (${toolName})`);
    await this.sendMessage(openId, chatId, "interactive", JSON.stringify(card));
  }

  async sendMessage(openId, chatId, msgType, content) {
    if (!this.client) throw new Error("feishu client not initialized");
    const receiveId = chatId ?? openId;
    const receiveIdType = chatId ? "chat_id" : "open_id";
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: msgType, content },
    });
    return res?.data?.message_id ? { messageId: res.data.message_id } : {};
  }

  /** Download an image resource from a received message (base64 + mediaType). */
  async downloadImage(messageId, fileKey) {
    if (this.dryRun) throw new Error("dry-run has no client");
    if (!this.client) throw new Error("feishu client not initialized");
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: "image" },
    });
    const stream = res?.getReadableStream?.();
    if (!stream) throw new Error("message resource returned no stream");
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const buf = Buffer.concat(chunks);
    return { data: buf.toString("base64"), mediaType: "image/png" };
  }

  /** Send a markdown card and return its message id (for later updates). */
  async sendCard(chatId, text) {
    const card = { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: text }] };
    if (this.dryRun) {
      console.log(`[feishu:dry] card -> ${chatId}: ${text.slice(0, 80)}`);
      return {};
    }
    return this.sendMessage(chatId, chatId, "interactive", JSON.stringify(card));
  }

  /** Update an interactive card message in place (progress etc.). */
  async updateCard(chatId, messageId, text) {
    if (this.dryRun || !messageId) return;
    const card = { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: text }] };
    if (!this.client) throw new Error("feishu client not initialized");
    await this.client.im.v1.message.update({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
  }
}
