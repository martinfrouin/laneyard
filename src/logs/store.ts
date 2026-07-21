import { createReadStream } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * Écrivain append-only pour un run.
 * `offset` compte des octets, jamais des caractères : c'est ce que la reprise
 * de lecture côté navigateur manipule, et un accent occupe deux octets.
 */
export class LogWriter {
  private _offset = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly handle: FileHandle) {}

  get offset(): number {
    return this._offset;
  }

  /**
   * Réserve le décalage immédiatement puis sérialise les écritures.
   *
   * Les fragments arrivent d'un PTY, sans attendre : si le décalage était calculé
   * après l'écriture, deux fragments concurrents pourraient s'attribuer la même
   * position et le rattrapage côté navigateur dupliquerait ou perdrait du texte.
   */
  async append(chunk: string): Promise<number> {
    const buf = Buffer.from(chunk, "utf8");
    const start = this._offset;
    this._offset += buf.byteLength;

    this.queue = this.queue.then(() => this.handle.write(buf)).catch(() => {
      // Le fichier a pu être fermé pendant que le processus finissait de parler.
    });
    await this.queue;
    return start;
  }

  async close(): Promise<void> {
    await this.queue;
    await this.handle.close();
  }
}

export class LogStore {
  constructor(private readonly dir: string) {}

  pathFor(runId: number): string {
    return join(this.dir, `${runId}.log`);
  }

  async open(runId: number): Promise<LogWriter> {
    await mkdir(this.dir, { recursive: true });
    return new LogWriter(await open(this.pathFor(runId), "w"));
  }

  async read(runId: number, fromOffset = 0): Promise<string> {
    try {
      const buf = await readFile(this.pathFor(runId));
      return buf.subarray(fromOffset).toString("utf8");
    } catch {
      return "";
    }
  }

  /** Pour servir un gros log sans le charger entièrement en mémoire. */
  stream(runId: number, fromOffset = 0): NodeJS.ReadableStream {
    return createReadStream(this.pathFor(runId), { start: fromOffset });
  }
}
