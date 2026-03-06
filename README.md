# Brodcasta SDK

A clean, typed TypeScript client for connecting to the Brodcasta platform. It supports WebSocket and SSE with automatic fallback, room management, and strongly typed events.

## Features
- WS first with automatic fallback to SSE
- Typed inbound and outbound events
- Clean connection lifecycle helpers
- Configurable base URL, project ID/secret, and paths
- Built-in reconnect strategy

## Install (Local)

From `frontend/`:

```bash
pnpm add ../sdk
```

Then import:

```ts
import { BrodcastaClient } from 'brodcasta-sdk';
```

## Quick Start

```ts
import { BrodcastaClient } from 'brodcasta-sdk';

type InboundEvents = {
  'message.received': { room_id: string; message: string; sender_id: string };
  'broadcast.received': { message: string; sender_id: string };
  'direct.received': { message: string; sender_id: string; target_client_id: string };
};

type OutboundEvents = {
  'message.send': { room_id: string; message: string };
  'message.broadcast': { message: string };
  'message.direct': { target_client_id: string; message: string };
};

const client = new BrodcastaClient<InboundEvents, OutboundEvents>({
  baseUrl: 'https://api.Brodcasta.dev',
  projectId: 'your_project_id',
  projectSecret: 'your_project_secret',
  wsPath: '/ws/{projectId}',
  ssePath: '/sse/{projectId}/connect',
  sendPath: '/sse/{projectId}/send',
  room: 'global',
  prefer: 'ws',
  fallbackToSse: true,
});

client.on('open', ({ transport }) => {
  console.log('connected via', transport);
});

client.onEvent('message.received', (data) => {
  console.log('message', data.message);
});

await client.connect();
await client.join('global');
await client.sendMessage('global', 'hello world');
```

## API

### `new BrodcastaClient(options)`

Key options:
- `baseUrl` (required): Base HTTP URL for the platform
- `projectId` (required): Project ID for your workspace
- `projectSecret` (required): Project secret for your workspace
- `wsPath`: WebSocket endpoint path (default `'/ws/{projectId}'`)
- `ssePath`: SSE endpoint path (default `'/sse/{projectId}/connect'`)
- `sendPath`: HTTP endpoint for sending messages (default `'/sse/{projectId}/send'`)
- `secretQueryParam`: query param name for secret in WS/SSE URLs (default `'secret'`)
- `headers`: extra headers for HTTP send
- `prefer`: `'ws' | 'sse'` transport preference (default `'ws'`)
- `fallbackToSse`: automatically fallback to SSE when WS fails (default `true`)
- `room`: auto-join room after connect
- `reconnect`: reconnect options (see below)
- `parseEvent`: custom parser for inbound frames
- `formatSend`: customize send envelope
- `formatJoin`: customize room subscribe payload

### Connection helpers
- `connect()`
- `disconnect()`
- `getState()`
- `getTransport()`
- `getClientId()`
- `getClientToken()`

### Messaging
- `join(roomId, payload?)`
- `leave(roomId, payload?)`
- `send(eventType, data, roomId?)`
- `sendMessage(roomId, message)`
- `broadcast(message)`
- `direct(targetClientId, message)`
- `ping()`
- `sendRaw(payload)`

### Events
General lifecycle events are emitted via `client.on(...)`:
- `open`, `close`, `error`, `state`, `reconnect`, `transport`, `raw`, `message`
- `identity`, `connection`

Typed message listeners:
- `onEvent(eventName, listener)`

## Reconnect Options

```ts
reconnect: {
  enabled: true,
  maxAttempts: 10,
  minDelayMs: 500,
  maxDelayMs: 8000,
  jitter: 0.3,
  fallbackAfter: 1,
}
```

## Notes
- WS/SSE require `project_id` and `project_secret` as query params. The SDK injects the secret automatically.
- The server issues a `client_token` after connect (event: `client.identity`). The SDK stores it and includes it on SSE `send` requests automatically.
- If your backend uses a different envelope shape, set `formatSend`, `formatJoin`, and `parseEvent`.

## License
MIT
