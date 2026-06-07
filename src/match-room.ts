/// <reference types="@cloudflare/workers-types" />

const ROOM_PROTOCOL = "https://match-room.internal";

type ConnectionAttachment = {
  userId: number;
  matchId: string;
};

export class MatchRoom implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }

      const userId = Number(url.searchParams.get("userId"));
      const matchId = url.searchParams.get("matchId");

      if (!Number.isInteger(userId) || userId <= 0 || !matchId) {
        return new Response("invalid connection metadata", { status: 400 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      server.serializeAttachment({ userId, matchId } satisfies ConnectionAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      const sockets = this.state.getWebSockets();
      const message = JSON.stringify({ type: "match-updated" });

      for (const ws of sockets) {
        try {
          ws.send(message);
        } catch {
          // Ignore broken connections; hibernation lifecycle will clean them up.
        }
      }

      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        // Ignore send errors on closed sockets.
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code, "closing");
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "internal error");
    } catch {
      // Already closed.
    }
  }
}

export function matchRoomConnectUrl(userId: number, matchId: string) {
  const url = new URL("/connect", ROOM_PROTOCOL);
  url.searchParams.set("userId", String(userId));
  url.searchParams.set("matchId", matchId);
  return url.toString();
}

export function matchRoomNotifyUrl() {
  return new URL("/notify", ROOM_PROTOCOL).toString();
}
