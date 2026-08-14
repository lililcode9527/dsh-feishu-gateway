// Minimal DSH /api RPC client: unary calls + WebSocket mux event stream.
// Wire protocol verified against @deepseek-ai/dsh 0.1.0-rc.6 (see tools/api-probe.mjs).

let seq = 0;
const newRpcId = () => `gw-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

export class DshClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.ws = null;
    this.wsCallbacks = new Set();
    this.reconnectTimer = null;
    this.closed = false;
    this.retryMs = 3000;
  }

  async call(method, payload = {}, { timeoutMs = 120000, signal } = {}) {
    const rpcId = newRpcId();
    const effectiveSignal = signal ?? AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: effectiveSignal,
    });
    if (res.status === 403) throw new Error("DSH /api rejected the request (trust fence): are you on 127.0.0.1?");
    if (res.status === 426) throw new Error(`DSH /api requires WebSocket for events (${res.status})`);
    if (!res.ok) throw new Error(`DSH /api ${method} HTTP ${res.status}`);
    const body = await res.json();
    if (body.type !== "server-response" || body.rpcId !== rpcId) {
      throw new Error(`DSH /api ${method}: unexpected response shape`);
    }
    const result = body.result;
    if (!result.ok) {
      const err = new Error(`DSH ${method} failed: ${result.error?.message ?? "unknown error"}`);
      err.code = result.error?.code;
      err.details = result.error?.details;
      throw err;
    }
    return result.value;
  }

  /** Answer a pending question or approval via /api/respond (rpcId echoed from the mux frame). */
  async respond(rpcId, value) {
    const res = await fetch(`${this.baseUrl}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-response", rpcId, result: { ok: true, value } }),
    });
    if (!res.ok) throw new Error(`DSH /api/respond HTTP ${res.status}`);
    return res.json(); // { accepted, reason? }
  }

  /** Subscribe to the mux event stream. Callback receives parsed frames. */
  onFrame(cb) {
    this.wsCallbacks.add(cb);
    return () => this.wsCallbacks.delete(cb);
  }

  connect() {
    if (this.closed) return;
    const url = this.baseUrl.replace(/^http/, "ws") + "/api/events.mux";
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 3000;
    };
    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const cb of this.wsCallbacks) {
        try {
          cb(frame);
        } catch (err) {
          console.error("[dsh] frame callback error:", err);
        }
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}
