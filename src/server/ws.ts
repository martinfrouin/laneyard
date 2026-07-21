import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { AppContext } from "./app.js";
import { SESSION_COOKIE } from "./auth.js";

/** Tout ce dont le concentrateur a besoin d'un client : pouvoir recevoir du texte. */
export interface Sink {
  send(data: string): void;
}

/**
 * Diffuse les fragments de sortie aux navigateurs qui regardent un run.
 *
 * Chaque message porte son décalage en octets : un client qui se reconnecte
 * demande le log depuis son dernier décalage connu et ne perd rien.
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
        // Un client mort ne doit jamais interrompre la diffusion aux autres.
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
    // Redondance assumée : le hook global d'`app.ts` refuse déjà tout `/api`
    // sans session, et le fait dès la poignée de main — un client non authentifié
    // reçoit un 401 HTTP et n'arrive jamais ici. Ce garde ne coûte rien et évite
    // qu'une exemption future de ce hook ouvre silencieusement le flux.
    if (!ctx.sessions.valid(req.cookies[SESSION_COOKIE])) {
      socket.close(4001, "Session requise");
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
