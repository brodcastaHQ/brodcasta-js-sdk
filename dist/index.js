// src/client.ts
var TypedEventEmitter = class {
  listeners = /* @__PURE__ */ new Map();
  on(event, listener) {
    const set = this.listeners.get(event) ?? /* @__PURE__ */ new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }
  off(event, listener) {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(event);
  }
  once(event, listener) {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      listener(payload);
    }
  }
};
var DEFAULTS = {
  wsPath: "/ws/{projectId}",
  ssePath: "/sse/{projectId}/connect",
  sendPath: "/sse/{projectId}/send",
  tokenQueryParam: "token",
  autoConnect: true,
  prefer: "ws",
  fallbackToSse: true,
  connectTimeoutMs: 8e3,
  reconnect: {
    enabled: true,
    maxAttempts: 10,
    minDelayMs: 500,
    maxDelayMs: 8e3,
    jitter: 0.3,
    fallbackAfter: 1
  },
  token: null
  // Default token placeholder
};
function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}
function applyProjectId(path, projectId) {
  return path.replace("{projectId}", projectId).replace("{project_id}", projectId).replace(":projectId", projectId).replace(":project_id", projectId);
}
function toWsUrl(httpUrl) {
  if (httpUrl.startsWith("https://")) return httpUrl.replace("https://", "wss://");
  if (httpUrl.startsWith("http://")) return httpUrl.replace("http://", "ws://");
  return httpUrl;
}
function buildUrlWithToken(baseUrl, path, token) {
  const url = `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}
function nextDelay(attempt, minDelay, maxDelay, jitter) {
  const exp = minDelay * Math.pow(2, Math.max(0, attempt - 1));
  const base = clamp(exp, minDelay, maxDelay);
  const delta = base * jitter;
  return Math.round(base + (Math.random() * 2 - 1) * delta);
}
var BrodcastaClient = class {
  options;
  emitter = new TypedEventEmitter();
  eventListeners = /* @__PURE__ */ new Map();
  state = "idle";
  transport = null;
  ws = null;
  sse = null;
  sseListeners = /* @__PURE__ */ new Map();
  connectPromise = null;
  reconnectAttempts = 0;
  wsFailures = 0;
  reconnectTimer = null;
  manualClose = false;
  clientToken = null;
  clientId = null;
  pendingSse = [];
  constructor(options) {
    const reconnect = { ...DEFAULTS.reconnect, ...options.reconnect };
    const token = options.token || null;
    this.options = {
      ...DEFAULTS,
      ...options,
      reconnect,
      token
    };
    if (!this.options.projectId) {
      throw new Error("projectId is required");
    }
    if (this.options.autoConnect) {
      void this.connect();
    }
  }
  on(event, listener) {
    return this.emitter.on(event, listener);
  }
  off(event, listener) {
    this.emitter.off(event, listener);
  }
  once(event, listener) {
    return this.emitter.once(event, listener);
  }
  onEvent(event, listener) {
    const set = this.eventListeners.get(event) ?? /* @__PURE__ */ new Set();
    set.add(listener);
    this.eventListeners.set(event, set);
    this.ensureSseListener(event);
    return () => this.offEvent(event, listener);
  }
  offEvent(event, listener) {
    const set = this.eventListeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.eventListeners.delete(event);
    if (!this.eventListeners.has(event)) {
      this.removeSseListener(event);
    }
  }
  getState() {
    return this.state;
  }
  getTransport() {
    return this.transport;
  }
  getClientToken() {
    return this.clientToken;
  }
  getClientId() {
    return this.clientId;
  }
  async connect(token) {
    if (this.connectPromise) return this.connectPromise;
    this.manualClose = false;
    this.connectPromise = this.connectInternal(token).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }
  async disconnect(code, reason) {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.rejectPendingSse(new Error("Client disconnected"));
    if (this.ws) {
      this.ws.close(code, reason);
      this.ws = null;
    }
    if (this.sse) {
      this.sse.close();
      this.sse = null;
    }
    this.sseListeners.clear();
    this.setState("closed");
  }
  async join(roomId, payload) {
    const payloadObj = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const data = this.options.formatJoin ? this.options.formatJoin(roomId, payload) : { event_type: "room.subscribe", data: { room_id: roomId, ...payloadObj } };
    await this.sendRaw(data);
  }
  async leave(roomId, payload) {
    const payloadObj = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const data = this.options.formatJoin ? this.options.formatJoin(roomId, payload) : { event_type: "room.unsubscribe", data: { room_id: roomId, ...payloadObj } };
    await this.sendRaw(data);
  }
  async send(event, data, room, token) {
    let payloadData = data;
    if (room) {
      if (data && typeof data === "object" && !Array.isArray(data)) {
        payloadData = { room_id: room, ...data };
      } else {
        payloadData = { room_id: room, data };
      }
    }
    const payload = this.options.formatSend ? this.options.formatSend(event, payloadData) : { event_type: event, data: payloadData };
    await this.sendRaw(payload, token);
  }
  async sendMessage(roomId, message, token) {
    await this.sendRaw({ event_type: "message.send", data: { room_id: roomId, message } }, token);
  }
  async broadcast(message, token) {
    await this.sendRaw({ event_type: "message.broadcast", data: { message } }, token);
  }
  async direct(targetClientId, message, token) {
    await this.sendRaw({ event_type: "message.direct", data: { target_client_id: targetClientId, message } }, token);
  }
  async ping() {
    await this.sendRaw({ event_type: "client.ping", data: {} });
  }
  async sendRaw(payload, token) {
    if (this.state !== "open") {
      throw new Error("Client is not connected");
    }
    if (this.transport === "ws" && this.ws) {
      this.ws.send(JSON.stringify(payload));
      return;
    }
    if (this.transport === "sse" && !this.clientToken) {
      await new Promise((resolve, reject) => {
        this.pendingSse.push({ payload, resolve, reject });
      });
      return;
    }
    await this.sendHttp(payload, token || this.options.token || void 0);
  }
  async connectInternal(token) {
    this.setState("connecting");
    if (this.options.prefer === "sse") {
      try {
        await this.connectSse(token);
        return;
      } catch (error) {
        if (!this.options.fallbackToSse) throw error;
        await this.connectWs(token);
        return;
      }
    }
    try {
      await this.connectWs(token);
    } catch (error) {
      if (!this.options.fallbackToSse) throw error;
      this.wsFailures += 1;
      await this.connectSse(token);
    }
  }
  async connectWs(token) {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl);
    const path = applyProjectId(this.options.wsPath ?? DEFAULTS.wsPath, this.options.projectId);
    const authToken = token || this.options.token || "";
    const wsUrl = toWsUrl(buildUrlWithToken(baseUrl, path, authToken));
    this.transport = "ws";
    this.emitter.emit("transport", { transport: "ws" });
    await new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timeout = window.setTimeout(() => {
        if (!opened) {
          this.log("warn", "WebSocket connection timed out");
          ws.close();
          reject(new Error("WebSocket connection timed out"));
        }
      }, this.options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs);
      ws.onopen = () => {
        opened = true;
        window.clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.wsFailures = 0;
        this.setState("open");
        this.emitter.emit("open", { transport: "ws" });
        if (this.options.room) {
          void this.join(this.options.room);
        }
        resolve();
      };
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleInbound(data.data, "ws", { event_type: data.event_type });
      };
      ws.onerror = (event) => {
        this.emitter.emit("error", { transport: "ws", error: { message: "Websocket Connection Failed" } });
        if (!opened) {
          window.clearTimeout(timeout);
          reject(new Error("WebSocket failed to connect"));
        }
      };
      ws.onclose = (event) => {
        window.clearTimeout(timeout);
        this.emitter.emit("close", { transport: "ws", code: event.code, reason: event.reason });
        if (!opened) {
          reject(new Error("WebSocket closed before opening"));
          return;
        }
        if (!this.manualClose) {
          this.setState("closed");
          this.scheduleReconnect("ws");
        }
      };
    });
  }
  parseEvent(raw) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      return {};
    }
  }
  async connectSse(token) {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl);
    const path = applyProjectId(this.options.ssePath ?? DEFAULTS.ssePath, this.options.projectId);
    const authToken = token || this.options.token || "";
    const sseUrl = buildUrlWithToken(baseUrl, path, authToken);
    this.transport = "sse";
    this.emitter.emit("transport", { transport: "sse" });
    await new Promise((resolve, reject) => {
      let opened = false;
      const sse = new EventSource(sseUrl);
      this.sse = sse;
      this.sseListeners.clear();
      this.ensureSseListener("message.received");
      this.ensureSseListener("message.send.ok");
      this.ensureSseListener("message.broadcast.ok");
      this.ensureSseListener("message.direct.ok");
      this.ensureSseListener("connect");
      this.ensureSseListener("disconnect");
      this.ensureSseListener("client.identity");
      this.ensureSseListener("connection.established");
      this.ensureSseListener("presence.joined");
      this.ensureSseListener("presence.leave");
      this.ensureSseListener("presence.left");
      for (const eventName of this.eventListeners.keys()) {
        this.ensureSseListener(eventName);
      }
      const timeout = window.setTimeout(() => {
        if (!opened) {
          this.log("warn", "SSE connection timed out");
          sse.close();
          reject(new Error("SSE connection timed out"));
        }
      }, this.options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs);
      sse.onopen = () => {
        opened = true;
        window.clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.setState("open");
        this.emitter.emit("open", { transport: "sse" });
        if (this.options.room) {
          void this.join(this.options.room);
        }
        resolve();
      };
      sse.onerror = (event) => {
        this.emitter.emit("error", { transport: "sse", error: event });
        if (!opened) {
          window.clearTimeout(timeout);
          reject(new Error("SSE failed to connect"));
        }
      };
    });
  }
  handleInbound(data, transport, meta) {
    this.emitter.emit("raw", { data });
    const eventName = (meta == null ? void 0 : meta.event_type) || "unkown";
    if (eventName === "client.identity" && data && typeof data === "object") {
      const identity = data;
      if (identity.client_token && identity.client_id) {
        this.clientToken = identity.client_token;
        this.clientId = identity.client_id;
        this.emitter.emit("identity", { clientId: identity.client_id, clientToken: identity.client_token });
        void this.flushPendingSse();
      }
    }
    if (eventName === "connection.established" && data && typeof data === "object") {
      const connection = data;
      if (connection.connection_id && connection.project_id) {
        this.emitter.emit("connection", {
          connectionId: connection.connection_id,
          projectId: connection.project_id
        });
      }
    }
    this.emitter.emit("message", { event: eventName, data });
    const set = this.eventListeners.get(eventName);
    if (set) {
      for (const listener of set) {
        listener(data);
      }
    }
  }
  normalizeInbound(parsed) {
    if (!parsed || typeof parsed !== "object") {
      return { data: parsed };
    }
    const obj = parsed;
    return {
      event_type: typeof obj.event_type === "string" ? obj.event_type : void 0,
      event: typeof obj.event === "string" ? obj.event : void 0,
      type: typeof obj.type === "string" ? obj.type : void 0,
      data: obj.data,
      payload: obj.payload,
      message: typeof obj.message === "string" ? obj.message : void 0,
      room: typeof obj.room === "string" ? obj.room : void 0
    };
  }
  ensureSseListener(eventName) {
    if (!this.sse) return;
    if (this.sseListeners.has(eventName)) return;
    const handler = (event) => {
      const data = event.data;
      if (eventName === "client.identity") {
        const jsonData = JSON.parse(data);
        this.clientId = jsonData.client_id;
        this.clientToken = jsonData.client_token;
        return;
      }
      if (data === void 0) return;
      this.handleInbound(this.parseEvent(data), "sse", { event_type: eventName });
    };
    this.sseListeners.set(eventName, handler);
    this.sse.addEventListener(eventName, handler);
  }
  removeSseListener(eventName) {
    const handler = this.sseListeners.get(eventName);
    if (!handler) return;
    this.sseListeners.delete(eventName);
    if (!this.sse) return;
    this.sse.removeEventListener(eventName, handler);
  }
  async sendHttp(payload, token) {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl);
    const path = applyProjectId(this.options.sendPath ?? DEFAULTS.sendPath, this.options.projectId);
    if (!path) {
      throw new Error("sendPath is required for HTTP send");
    }
    const authToken = token || this.options.token || "";
    const targetUrl = buildUrlWithToken(baseUrl, path, authToken);
    const headers = {
      "content-type": "application/json",
      ...this.options.headers ?? {}
    };
    const body = this.withClientTokenAndAuth(payload, authToken);
    await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  }
  scheduleReconnect(transport) {
    const reconnect = this.options.reconnect ?? DEFAULTS.reconnect;
    if (!reconnect.enabled || this.manualClose) return;
    this.reconnectAttempts += 1;
    const maxAttempts = reconnect.maxAttempts ?? DEFAULTS.reconnect.maxAttempts;
    if (this.reconnectAttempts > maxAttempts) {
      if (transport === "ws") {
        this.wsFailures += 1;
        if (this.options.fallbackToSse && this.wsFailures >= (reconnect.fallbackAfter ?? 1)) {
          void this.connectSse(this.options.token);
        }
      }
      return;
    }
    const delay = nextDelay(
      this.reconnectAttempts,
      reconnect.minDelayMs ?? DEFAULTS.reconnect.minDelayMs,
      reconnect.maxDelayMs ?? DEFAULTS.reconnect.maxDelayMs,
      reconnect.jitter ?? DEFAULTS.reconnect.jitter
    );
    this.setState("reconnecting");
    this.emitter.emit("reconnect", { attempt: this.reconnectAttempts, delayMs: delay, transport });
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      void this.connectInternal(this.options.token);
    }, delay);
  }
  clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  setState(state) {
    this.state = state;
    this.emitter.emit("state", { state });
  }
  withClientToken(payload) {
    if (!this.clientToken) return payload;
    if (!payload || typeof payload !== "object") return payload;
    const obj = payload;
    if ("client_token" in obj) return payload;
    return { ...obj, client_token: this.clientToken };
  }
  withClientTokenAndAuth(payload, authToken) {
    let result = this.withClientToken(payload);
    if (!authToken) return result;
    if (!result || typeof result !== "object") {
      return { token: authToken };
    }
    const obj = result;
    if ("token" in obj) return result;
    return { ...obj, token: authToken };
  }
  async flushPendingSse() {
    if (!this.pendingSse.length) return;
    const pending = [...this.pendingSse];
    this.pendingSse = [];
    for (const item of pending) {
      try {
        await this.sendHttp(item.payload, this.options.token || void 0);
        item.resolve();
      } catch (error) {
        item.reject(error);
      }
    }
  }
  rejectPendingSse(error) {
    if (!this.pendingSse.length) return;
    const pending = [...this.pendingSse];
    this.pendingSse = [];
    for (const item of pending) {
      item.reject(error);
    }
  }
  log(level, message, meta) {
    var _a, _b;
    (_b = (_a = this.options).onLog) == null ? void 0 : _b.call(_a, level, message, meta);
  }
};
export {
  BrodcastaClient
};
