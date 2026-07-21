import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { AppContext } from "./app.js";
import { SESSION_COOKIE } from "./auth.js";

/** All the hub needs from a client: the ability to receive text. */
export interface Sink {
  send(data: string): void;
}

/**
 * Broadcasts output fragments to browsers watching a run.
 *
 * Every message carries its byte offset: a client that reconnects requests
 * the log from its last known offset and loses nothing.
 */
export class RunSockets {
  private readonly byRun = new Map<number, Set<Sink>>();

  subscribe(runId: number, sink: Sink): void {
    const set = this.byRun.get(runId) ?? new Set<Sink>();
    set.add(sink);
    this.byRun.set(runId, set);
  }

  unsubscribe(runId: number, sink: Sink): void {
    const set = this.byRun.get(runId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.byRun.delete(runId);
  }

  private emit(runId: number, payload: unknown): void {
    const set = this.byRun.get(runId);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const sink of set) {
      try {
        sink.send(data);
      } catch {
        // A dead client must never interrupt the broadcast to the others.
        set.delete(sink);
      }
    }
  }

  broadcast(runId: number, chunk: string, offset: number): void {
    this.emit(runId, { type: "chunk", offset, data: chunk });
  }

  finish(runId: number, status: string): void {
    this.emit(runId, { type: "finished", status });
  }
}

export async function registerWebSocket(app: FastifyInstance, ctx: AppContext): Promise<RunSockets> {
  const hub = new RunSockets();
  await app.register(websocket);

  app.get("/api/runs/:id/stream", { websocket: true }, (socket, req) => {
    // Deliberate redundancy: `app.ts`'s global hook already refuses every
    // `/api` route without a session, and does so right at the handshake —
    // an unauthenticated client gets a 401 HTTP response and never reaches
    // here. This guard costs nothing and prevents a future exemption of
    // that hook from silently opening the stream.
    if (!ctx.sessions.valid(req.cookies[SESSION_COOKIE])) {
      socket.close(4001, "Session required");
      return;
    }

    const runId = Number((req.params as { id: string }).id);
    const sink: Sink = { send: (d) => socket.send(d) };

    hub.subscribe(runId, sink);
    socket.on("close", () => hub.unsubscribe(runId, sink));
  });

  app.decorate("broadcastRunChunk", (runId: number, chunk: string, offset: number) =>
    hub.broadcast(runId, chunk, offset),
  );

  return hub;
}
