import {
  ClientEventMap,
  ClientOptions,
  ConnectionState,
  EventMap,
  InboundEnvelope,
  Transport,
} from './types';

type AnyListener = (payload: unknown) => void;

class TypedEventEmitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<AnyListener>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as AnyListener);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener as AnyListener);
    if (set.size === 0) this.listeners.delete(event);
  }

  once<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      listener(payload as unknown);
    }
  }
}

const DEFAULTS = {
  wsPath: '/ws/{projectId}',
  ssePath: '/sse/{projectId}/connect',
  sendPath: '/sse/{projectId}/send',
  secretQueryParam: 'secret',
  autoConnect: true,
  prefer: 'ws' as Transport,
  fallbackToSse: true,
  connectTimeoutMs: 8000,
  reconnect: {
    enabled: true,
    maxAttempts: 10,
    minDelayMs: 500,
    maxDelayMs: 8000,
    jitter: 0.3,
    fallbackAfter: 1,
  },
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string): string {
  if (!path.startsWith('/')) return `${baseUrl}/${path}`;
  return `${baseUrl}${path}`;
}

function applyProjectId(path: string, projectId: string): string {
  return path
    .replace('{projectId}', projectId)
    .replace('{project_id}', projectId)
    .replace(':projectId', projectId)
    .replace(':project_id', projectId);
}

function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return httpUrl.replace('https://', 'wss://');
  if (httpUrl.startsWith('http://')) return httpUrl.replace('http://', 'ws://');
  return httpUrl;
}

function withQuery(url: string, params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return url;
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? '')}`)
    .join('&');
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${query}`;
}

function clamp(num: number, min: number, max: number): number {
  return Math.min(Math.max(num, min), max);
}

function nextDelay(attempt: number, minDelay: number, maxDelay: number, jitter: number): number {
  const exp = minDelay * Math.pow(2, Math.max(0, attempt - 1));
  const base = clamp(exp, minDelay, maxDelay);
  const delta = base * jitter;
  return Math.round(base + (Math.random() * 2 - 1) * delta);
}

export class BrodcastaClient<Inbound extends EventMap = EventMap, Outbound extends EventMap = EventMap> {
  private options: ClientOptions<Inbound, Outbound>;
  private emitter = new TypedEventEmitter<ClientEventMap<Inbound>>();
  private eventListeners = new Map<string, Set<(data: unknown) => void>>();
  private state: ConnectionState = 'idle';
  private transport: Transport | null = null;
  private ws: WebSocket | null = null;
  private sse: EventSource | null = null;
  private sseListeners = new Map<string, (event: Event) => void>();
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private wsFailures = 0;
  private reconnectTimer: number | null = null;
  private manualClose = false;
  private clientToken: string | null = null;
  private clientId: string | null = null;
  private pendingSse: Array<{
    payload: unknown;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(options: ClientOptions<Inbound, Outbound>) {
    const reconnect = { ...DEFAULTS.reconnect, ...options.reconnect };
    this.options = {
      ...DEFAULTS,
      ...options,
      reconnect,
    };

    if (!this.options.projectId) {
      throw new Error('projectId is required');
    }

    if (this.options.autoConnect) {
      void this.connect();
    }
  }

  on<K extends keyof ClientEventMap<Inbound>>(
    event: K,
    listener: (payload: ClientEventMap<Inbound>[K]) => void
  ): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof ClientEventMap<Inbound>>(
    event: K,
    listener: (payload: ClientEventMap<Inbound>[K]) => void
  ): void {
    this.emitter.off(event, listener);
  }

  once<K extends keyof ClientEventMap<Inbound>>(
    event: K,
    listener: (payload: ClientEventMap<Inbound>[K]) => void
  ): () => void {
    return this.emitter.once(event, listener);
  }

  onEvent<E extends keyof Inbound & string>(
    event: E,
    listener: (data: Inbound[E]) => void
  ): () => void {
    const set = this.eventListeners.get(event) ?? new Set();
    set.add(listener as (data: unknown) => void);
    this.eventListeners.set(event, set);
    this.ensureSseListener(event);
    return () => this.offEvent(event, listener);
  }

  offEvent<E extends keyof Inbound & string>(event: E, listener: (data: Inbound[E]) => void): void {
    const set = this.eventListeners.get(event);
    if (!set) return;
    set.delete(listener as (data: unknown) => void);
    if (set.size === 0) this.eventListeners.delete(event);
    if (!this.eventListeners.has(event)) {
      this.removeSseListener(event);
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  getTransport(): Transport | null {
    return this.transport;
  }

  getClientToken(): string | null {
    return this.clientToken;
  }

  getClientId(): string | null {
    return this.clientId;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.manualClose = false;
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect(code?: number, reason?: string): Promise<void> {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.rejectPendingSse(new Error('Client disconnected'));

    if (this.ws) {
      this.ws.close(code, reason);
      this.ws = null;
    }

    if (this.sse) {
      this.sse.close();
      this.sse = null;
    }
    this.sseListeners.clear();

    this.setState('closed');
  }

  async join(roomId: string, payload?: unknown): Promise<void> {
    const payloadObj =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    const data = this.options.formatJoin
      ? this.options.formatJoin(roomId, payload)
      : { event_type: 'room.subscribe', data: { room_id: roomId, ...payloadObj } };
    await this.sendRaw(data);
  }

  async leave(roomId: string, payload?: unknown): Promise<void> {
    const payloadObj =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    const data = this.options.formatJoin
      ? this.options.formatJoin(roomId, payload)
      : { event_type: 'room.unsubscribe', data: { room_id: roomId, ...payloadObj } };
    await this.sendRaw(data);
  }

  async send<E extends keyof Outbound & string>(event: E, data: Outbound[E], room?: string): Promise<void> {
    let payloadData: unknown = data;
    if (room) {
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        payloadData = { room_id: room, ...(data as Record<string, unknown>) };
      } else {
        payloadData = { room_id: room, data };
      }
    }

    const payload = this.options.formatSend
      ? this.options.formatSend(event, payloadData)
      : { event_type: event, data: payloadData };
    await this.sendRaw(payload);
  }

  async sendMessage(roomId: string, message: string): Promise<void> {
    await this.sendRaw({ event_type: 'message.send', data: { room_id: roomId, message } });
  }

  async broadcast(message: string): Promise<void> {
    await this.sendRaw({ event_type: 'message.broadcast', data: { message } });
  }

  async direct(targetClientId: string, message: string): Promise<void> {
    await this.sendRaw({ event_type: 'message.direct', data: { target_client_id: targetClientId, message } });
  }

  async ping(): Promise<void> {
    await this.sendRaw({ event_type: 'client.ping', data: {} });
  }

  async sendRaw(payload: unknown): Promise<void> {
    if (this.state !== 'open') {
      throw new Error('Client is not connected');
    }

    if (this.transport === 'ws' && this.ws) {
      this.ws.send(JSON.stringify(payload));
      return;
    }

    if (this.transport === 'sse' && !this.clientToken) {
      await new Promise<void>((resolve, reject) => {
        this.pendingSse.push({ payload, resolve, reject });
      });
      return;
    }
    await this.sendHttp(payload);
  }

  private async connectInternal(): Promise<void> {
    this.setState('connecting');

    if (this.options.prefer === 'sse') {
      try {
        await this.connectSse();
        return;
      } catch (error) {
        if (!this.options.fallbackToSse) throw error;
        await this.connectWs();
        return;
      }
    }

    try {
      await this.connectWs();
    } catch (error) {
      if (!this.options.fallbackToSse) throw error;
      this.wsFailures += 1;
      await this.connectSse();
    }
  }

  private async connectWs(): Promise<void> {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl);
    const path = applyProjectId(this.options.wsPath ?? DEFAULTS.wsPath, this.options.projectId);
    const url = joinUrl(baseUrl, path);
    const secret = await this.requireSecret();
    const secretQueryParam = this.options.secretQueryParam ?? DEFAULTS.secretQueryParam;
    const wsUrl = toWsUrl(withQuery(url, secretQueryParam ? { [secretQueryParam]: secret } : {}));

    this.transport = 'ws';
    this.emitter.emit('transport', { transport: 'ws' });

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const timeout = window.setTimeout(() => {
        if (!opened) {
          this.log('warn', 'WebSocket connection timed out');
          ws.close();
          reject(new Error('WebSocket connection timed out'));
        }
      }, this.options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs);

      ws.onopen = () => {
        opened = true;
        window.clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.wsFailures = 0;
        this.setState('open');
        this.emitter.emit('open', { transport: 'ws' });
        if (this.options.room) {
          void this.join(this.options.room);
        }
        resolve();
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleInbound(data.data, 'ws', {event_type: data.event_type});
      };

      ws.onerror = (event) => {
        this.emitter.emit('error', { transport: 'ws', error: {message: "Websocket Connection Failed"} });
        if (!opened) {
          window.clearTimeout(timeout);
          reject(new Error('WebSocket failed to connect'));
        }
      };

      ws.onclose = (event) => {
        window.clearTimeout(timeout);
        this.emitter.emit('close', { transport: 'ws', code: event.code, reason: event.reason });
        if (!opened) {
          reject(new Error('WebSocket closed before opening'));
          return;
        }
        if (!this.manualClose) {
          this.setState('closed');
          this.scheduleReconnect('ws');
        }
      };
    });
  }

  private parseEvent(raw: string): InboundEnvelope {
    try {
      return JSON.parse(raw);
    } catch (error) {
      return {};
    }
  }

  private async connectSse(): Promise<void> {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl);
    const path = applyProjectId(this.options.ssePath ?? DEFAULTS.ssePath, this.options.projectId);
    const url = joinUrl(baseUrl, path);
    const secret = await this.requireSecret();
    const secretQueryParam = this.options.secretQueryParam ?? DEFAULTS.secretQueryParam;
    const sseUrl = withQuery(url, secretQueryParam ? { [secretQueryParam]: secret } : {});

    this.transport = 'sse';
    this.emitter.emit('transport', { transport: 'sse' });

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const sse = new EventSource(sseUrl);
      this.sse = sse;
      this.sseListeners.clear();

      this.ensureSseListener('message.received');
      this.ensureSseListener('message.send.ok');
      this.ensureSseListener('message.broadcast.ok');
      this.ensureSseListener("message.direct.ok")
      this.ensureSseListener('connect');
      this.ensureSseListener('disconnect');
      this.ensureSseListener('client.identity');
      this.ensureSseListener('connection.established');
      this.ensureSseListener('presence.joined');
      this.ensureSseListener('presence.leave');
      this.ensureSseListener('presence.left');
      for (const eventName of this.eventListeners.keys()) {
        this.ensureSseListener(eventName);
      }

      const timeout = window.setTimeout(() => {
        if (!opened) {
          this.log('warn', 'SSE connection timed out');
          sse.close();
          reject(new Error('SSE connection timed out'));
        }
      }, this.options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs);

      sse.onopen = () => {
        opened = true;
        window.clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.setState('open');
        this.emitter.emit('open', { transport: 'sse' });
        if (this.options.room) {
          void this.join(this.options.room);
        }
        resolve();
      };

      sse.onerror = (event) => {
        this.emitter.emit('error', { transport: 'sse', error: event });
        if (!opened) {
          window.clearTimeout(timeout);
          reject(new Error('SSE failed to connect'));
        }
      };
    });
  }

  private handleInbound(data: object, transport: Transport, meta?: { event_type?: string }): void {
    

    this.emitter.emit('raw', { data: data });

    const eventName = meta?.event_type || "unkown"
    if (eventName === 'client.identity' && data && typeof data === 'object') {
      const identity = data as { client_token?: string; client_id?: string };
      if (identity.client_token && identity.client_id) {
        this.clientToken = identity.client_token;
        this.clientId = identity.client_id;
        this.emitter.emit('identity', { clientId: identity.client_id, clientToken: identity.client_token });
        void this.flushPendingSse();
      }
    }

    if (eventName === 'connection.established' && data && typeof data === 'object') {
      const connection = data as { connection_id?: string; project_id?: string };
      if (connection.connection_id && connection.project_id) {
        this.emitter.emit('connection', {
          connectionId: connection.connection_id,
          projectId: connection.project_id,
        });
      }
    }
   

    this.emitter.emit('message', { event: eventName as keyof Inbound & string, data: data as Inbound[keyof Inbound] });
    const set = this.eventListeners.get(eventName);
    if (set) {
      for (const listener of set) {
        listener(data);
      }
    }
  }

  private normalizeInbound(parsed: unknown): InboundEnvelope {
    if (!parsed || typeof parsed !== 'object') {
      return { data: parsed };
    }
    
    const obj = parsed as Record<string, unknown>;
    
    return {
      event_type: typeof obj.event_type === 'string' ? obj.event_type : undefined,
      event: typeof obj.event === 'string' ? obj.event : undefined,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      data: obj.data,
      payload: obj.payload,
      message: typeof obj.message === 'string' ? obj.message : undefined,
      room: typeof obj.room === 'string' ? obj.room : undefined,
    };
  }

  private ensureSseListener(eventName: string): void {
    if (!this.sse) return;
    if (this.sseListeners.has(eventName)) return;
    
    const handler = (event: Event) => {
      const data = (event as MessageEvent).data;
      if (eventName === 'client.identity') {
        // TODO: Handle client.identity event
        const jsonData = JSON.parse(data);
        this.clientId = jsonData.client_id;
        this.clientToken = jsonData.client_token;
        
       
        return;
      }
      if (data === undefined) return;
      this.handleInbound(this.parseEvent(data), 'sse', { event_type: eventName });
    };

    this.sseListeners.set(eventName, handler);
    this.sse.addEventListener(eventName, handler);
  }

  private removeSseListener(eventName: string): void {
    const handler = this.sseListeners.get(eventName);
    if (!handler) return;
    this.sseListeners.delete(eventName);
    if (!this.sse) return;
    this.sse.removeEventListener(eventName, handler);
  }

  private async sendHttp(payload: unknown): Promise<void> {
    const baseUrl = normalizeBaseUrl(this.options.baseUrl);
    const path = applyProjectId(this.options.sendPath ?? DEFAULTS.sendPath, this.options.projectId);
    if (!path) {
      throw new Error('sendPath is required for HTTP send');
    }

    const secret = await this.requireSecret();
    const url = joinUrl(baseUrl, path);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.options.headers ?? {}),
    };

    const secretQueryParam = this.options.secretQueryParam ?? DEFAULTS.secretQueryParam;
    const targetUrl = withQuery(url, secretQueryParam ? { [secretQueryParam]: secret } : {});
    const body = this.withClientToken(payload);

    await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  private scheduleReconnect(transport: Transport): void {
    const reconnect = this.options.reconnect ?? DEFAULTS.reconnect;
    if (!reconnect.enabled || this.manualClose) return;

    this.reconnectAttempts += 1;
    const maxAttempts = reconnect.maxAttempts ?? DEFAULTS.reconnect.maxAttempts;
    if (this.reconnectAttempts > maxAttempts) {
      if (transport === 'ws') {
        this.wsFailures += 1;
        if (this.options.fallbackToSse && this.wsFailures >= (reconnect.fallbackAfter ?? 1)) {
          void this.connectSse();
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

    this.setState('reconnecting');
    this.emitter.emit('reconnect', { attempt: this.reconnectAttempts, delayMs: delay, transport });

    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      void this.connectInternal();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emitter.emit('state', { state });
  }

  private async resolveSecret(): Promise<string | undefined> {
    const secret = this.options.projectSecret;
    if (!secret) return undefined;
    if (typeof secret === 'function') {
      const value = await secret();
      return value || undefined;
    }
    return secret;
  }

  private async requireSecret(): Promise<string> {
    const secret = await this.resolveSecret();
    if (!secret) {
      throw new Error('projectSecret is required');
    }
    return secret;
  }

  private withClientToken(payload: unknown): unknown {
    if (!this.clientToken) return payload;
    if (!payload || typeof payload !== 'object') return payload;
    const obj = payload as Record<string, unknown>;
    if ('client_token' in obj) return payload;
    return { ...obj, client_token: this.clientToken };
  }

  private async flushPendingSse(): Promise<void> {
    if (!this.pendingSse.length) return;
    const pending = [...this.pendingSse];
    this.pendingSse = [];
    for (const item of pending) {
      try {
        await this.sendHttp(item.payload);
        item.resolve();
      } catch (error) {
        item.reject(error);
      }
    }
  }

  private rejectPendingSse(error: unknown): void {
    if (!this.pendingSse.length) return;
    const pending = [...this.pendingSse];
    this.pendingSse = [];
    for (const item of pending) {
      item.reject(error);
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
    this.options.onLog?.(level, message, meta);
  }
}
