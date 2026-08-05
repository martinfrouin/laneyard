import type { Db } from "./open.js";

const now = () => new Date().toISOString();

/**
 * The number each project's next run will be handed as `LANEYARD_BUILD_NUMBER`.
 *
 * A stored number rather than a count of runs. The two would agree until the
 * first time they had to differ — a project arriving with a counter its
 * repository already kept, an upload made by hand, a server replaced — and a
 * count cannot be told to start at 57. Runs are also deleted by retention,
 * which would walk a count backwards into numbers a store has already seen.
 *
 * Nothing here decides *when* a number is taken; `reserve` is called once, as a
 * run starts, and its result is written onto the run. See `server/app.ts`.
 */
export class BuildNumberStore {
  constructor(private readonly db: Db) {}

  /** What the next run of this project would be handed, without taking it. */
  next(slug: string): number {
    const row = this.db
      .prepare("SELECT next FROM build_number WHERE project_slug = ?")
      .get(slug) as { next: number } | undefined;
    // A project with no row has never run. Writing one here to say so would make
    // a read a write, and 1 is what an absent counter has always meant.
    return row?.next ?? 1;
  }

  /**
   * Takes the next number and advances the counter, in one statement.
   *
   * Atomic on purpose: the queue runs one build at a time today, but a counter
   * that could hand the same number to two readers is the one bug in here that
   * a store would report days later, as a rejected release.
   */
  reserve(slug: string): number {
    const taken = this.next(slug);
    this.db
      .prepare(
        `INSERT INTO build_number (project_slug, next, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (project_slug) DO UPDATE SET next = excluded.next, updated_at = excluded.updated_at`,
      )
      .run(slug, taken + 1, now());
    return taken;
  }

  /** Sets what the next run will be handed. */
  set(slug: string, next: number): void {
    this.db
      .prepare(
        `INSERT INTO build_number (project_slug, next, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (project_slug) DO UPDATE SET next = excluded.next, updated_at = excluded.updated_at`,
      )
      .run(slug, next, now());
  }

  /** Drops a project's counter, when the project itself is removed. */
  forget(slug: string): void {
    this.db.prepare("DELETE FROM build_number WHERE project_slug = ?").run(slug);
  }
}
