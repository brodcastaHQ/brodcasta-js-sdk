type Transport = 'ws' | 'sse';
type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error' | 'reconnecting';
type EventMap = Record<string, unknown>;
interface ReconnectOptions {
    enabled?: boolean;
    maxAttempts?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
    fallbackAfter?: number;
}
type SecretResolver = string | (() => string | Promise<string>);
interface ClientOptions<Inbound extends EventMap, Outbound extends EventMap> {
    baseUrl: string;
    projectId: string;
    token?: string | null;
    wsPath?: string;
    ssePath?: string;
    sendPath?: string;
    room?: string;
    secretQueryParam?: string | null;
    headers?: Record<string, string>;
    autoConnect?: boolean;
    prefer?: Transport;
    fallbackToSse?: boolean;
    connectTimeoutMs?: number;
    reconnect?: ReconnectOptions;
    parseEvent?: (raw: string) => unknown;
    formatSend?: (eventType: string, data: unknown) => unknown;
    formatJoin?: (roomId: string, payload?: unknown) => unknown;
    onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown) => void;
}
interface InboundEnvelope {
    event_type?: string;
    event?: string;
    type?: string;
    data?: unknown;
    payload?: unknown;
    message?: string;
    room?: string;
}
type ClientEventMap<Inbound extends EventMap> = {
    open: {
        transport: Transport;
    };
    close: {
        transport: Transport;
        code?: number;
        reason?: string;
    };
    error: {
        transport: Transport;
        error: unknown;
    };
    state: {
        state: ConnectionState;
    };
    message: {
        event: keyof Inbound & string;
        data: Inbound[keyof Inbound];
    };
    identity: {
        clientId: string;
        clientToken: string;
    };
    connection: {
        connectionId: string;
        projectId: string;
    };
    raw: {
        data: unknown;
    };
    reconnect: {
        attempt: number;
        delayMs: number;
        transport: Transport;
    };
    transport: {
        transport: Transport;
    };
};

declare class BrodcastaClient<Inbound extends EventMap = EventMap, Outbound extends EventMap = EventMap> {
    private options;
    private emitter;
    private eventListeners;
    private state;
    private transport;
    private ws;
    private sse;
    private sseListeners;
    private connectPromise;
    private reconnectAttempts;
    private wsFailures;
    private reconnectTimer;
    private manualClose;
    private clientToken;
    private clientId;
    private pendingSse;
    constructor(options: ClientOptions<Inbound, Outbound>);
    on<K extends keyof ClientEventMap<Inbound>>(event: K, listener: (payload: ClientEventMap<Inbound>[K]) => void): () => void;
    off<K extends keyof ClientEventMap<Inbound>>(event: K, listener: (payload: ClientEventMap<Inbound>[K]) => void): void;
    once<K extends keyof ClientEventMap<Inbound>>(event: K, listener: (payload: ClientEventMap<Inbound>[K]) => void): () => void;
    onEvent<E extends keyof Inbound & string>(event: E, listener: (data: Inbound[E]) => void): () => void;
    offEvent<E extends keyof Inbound & string>(event: E, listener: (data: Inbound[E]) => void): void;
    getState(): ConnectionState;
    getTransport(): Transport | null;
    getClientToken(): string | null;
    getClientId(): string | null;
    connect(token?: string): Promise<void>;
    disconnect(code?: number, reason?: string): Promise<void>;
    join(roomId: string, payload?: unknown): Promise<void>;
    leave(roomId: string, payload?: unknown): Promise<void>;
    send<E extends keyof Outbound & string>(event: E, data: Outbound[E], room?: string): Promise<void>;
    sendMessage(roomId: string, message: string): Promise<void>;
    broadcast(message: string): Promise<void>;
    direct(targetClientId: string, message: string): Promise<void>;
    ping(): Promise<void>;
    sendRaw(payload: unknown): Promise<void>;
    private connectInternal;
    private connectWs;
    private parseEvent;
    private connectSse;
    private handleInbound;
    private normalizeInbound;
    private ensureSseListener;
    private removeSseListener;
    private sendHttp;
    private scheduleReconnect;
    private clearReconnectTimer;
    private setState;
    private withClientToken;
    private flushPendingSse;
    private rejectPendingSse;
    private log;
}

export { BrodcastaClient, type ClientEventMap, type ClientOptions, type ConnectionState, type EventMap, type InboundEnvelope, type ReconnectOptions, type SecretResolver, type Transport };
