import type { FastifyInstance } from "fastify";

// Provisoire : la tâche 15 remplace ce module par la vraie implémentation
// WebSocket. Il existe uniquement pour que app.ts puisse importer
// `registerWebSocket` et `RunSockets` avant que ces pièces ne soient réelles.
//
// La signature accepte déjà (app, ctx) : c'est ce que app.ts appelle, et ce
// dont la vraie implémentation de la tâche 15 aura besoin pour enregistrer
// ses routes WebSocket et diffuser vers le bon run.
export class RunSockets {
  broadcast(_runId: number, _chunk: string, _offset: number): void {}
  finish(_runId: number, _status: string): void {}
}

export async function registerWebSocket(_app?: FastifyInstance, _ctx?: unknown): Promise<RunSockets> {
  return new RunSockets();
}
