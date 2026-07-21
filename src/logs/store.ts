import { createReadStream } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * Append-only writer for a run.
 * `offset` counts bytes, never characters: that's what the browser-side
 * read resumption works with, and a multi-byte character can span several bytes.
 */
export class LogWriter {
  private _offset = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly handle: FileHandle) {}

  get offset(): number {
    return this._offset;
  }

  /**
   * Reserves the offset immediately then serializes the writes.
   *
   * Fragments arrive from a PTY, without waiting: if the offset were computed
   * after the write, two concurrent fragments could claim the same position
   * and the browser-side catch-up would duplicate or lose text.
   */
  async append(chunk: string): Promise<number> {
    const buf = Buffer.from(chunk, "utf8");
    const start = this._offset;
    this._offset += buf.byteLength;

    this.queue = this.queue.then(() => this.handle.write(buf)).catch(() => {
      // The file may have been closed while the process was still finishing up.
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

  /** For serving a large log without loading it entirely into memory. */
  stream(runId: number, fromOffset = 0): NodeJS.ReadableStream {
    return createReadStream(this.pathFor(runId), { start: fromOffset });
  }
}
