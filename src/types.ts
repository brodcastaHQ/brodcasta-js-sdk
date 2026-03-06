export type Transport = 'ws' | 'sse';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error'
  | 'reconnecting';

export type EventMap = Record<string, unknown>;

export interface ReconnectOptions {
  enabled?: boolean;
  maxAttempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  fallbackAfter?: number;
}

export type SecretResolver = string | (() => string | Promise<string>);

export interface ClientOptions<Inbound extends EventMap, Outbound extends EventMap> {
  baseUrl: string;
  projectId: string;
  projectSecret: SecretResolver;
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

export interface InboundEnvelope {
  event_type?: string;
  event?: string;
  type?: string;
  data?: unknown;
  payload?: unknown;
  message?: string;
  room?: string;
}

export type ClientEventMap<Inbound extends EventMap> = {
  open: { transport: Transport };
  close: { transport: Transport; code?: number; reason?: string };
  error: { transport: Transport; error: unknown };
  state: { state: ConnectionState };
  message: { event: keyof Inbound & string; data: Inbound[keyof Inbound] };
  identity: { clientId: string; clientToken: string };
  connection: { connectionId: string; projectId: string };
  raw: { data: unknown };
  reconnect: { attempt: number; delayMs: number; transport: Transport };
  transport: { transport: Transport };
};
