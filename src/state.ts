import * as fs from "fs/promises";
import * as path from "path";

import { Turn } from "./git";
import { Lane } from "./lanes";

export interface ReviewComment {
  body: string;
  author: string;
  at: string;
}

export interface Anchor {
  /** Repo-relative path. Artifact slugs join as containers in M2. */
  file: string;
  /** Zero-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Blob of the file at the revision the anchor was made against; empty when
   * that revision did not contain the file, in which case the thread cannot be
   * relocated and goes outdated as soon as the file changes. */
  blobSha: string;
  /** SHA-256 of the anchored lines, for cheap drift detection. */
  contentHash: string;
}

export type ThreadState = "draft" | "submitted" | "resolved";

export interface Thread {
  id: string;
  anchor: Anchor;
  /** The turn under review when the thread was opened. */
  turn: number;
  state: ThreadState;
  /** The anchored lines themselves changed and the thread could not be
   * relocated — GitHub's semantics: still visible, still open, marked. */
  outdated: boolean;
  comments: ReviewComment[];
}

export interface State {
  schemaVersion: number;
  turns: Turn[];
  /** file → the highest turn number the file has been marked reviewed at. A
   * later turn touching the same file therefore makes it unreviewed again, with
   * no bookkeeping: `reviewed[file] >= turn` is the whole rule. */
  reviewed: Record<string, number>;
  threads: Thread[];
}

const emptyState = (): State => ({ schemaVersion: 1, turns: [], reviewed: {}, threads: [] });

/** Per-lane persistence under the clone's common dir, so every worktree of a
 * clone agrees on where state lives and nothing ever appears in `git status`.
 *
 * From M1 there are two writers — the Stop hook's CLI process and the extension
 * acting on clicks — so every mutation goes through `withLock`: an advisory
 * lock file serializing the read-modify-write (the PRD §12.1 decision). */
export class Store {
  private state: State = emptyState();

  constructor(readonly lane: Lane) {}

  get dir(): string {
    return this.lane.dir;
  }

  get file(): string {
    return path.join(this.dir, "state.json");
  }

  get lockFile(): string {
    return path.join(this.dir, "state.json.lock");
  }

  /** The lane's private snapshot index (GIT_INDEX_FILE), beside its state. */
  get indexFile(): string {
    return path.join(this.dir, "index");
  }

  get batchesDir(): string {
    return path.join(this.dir, "batches");
  }

  get data(): State {
    return this.state;
  }

  async load(): Promise<void> {
    try {
      this.state = JSON.parse(await fs.readFile(this.file, "utf8")) as State;
    } catch {
      this.state = emptyState();
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }

  /** Reload → mutate → save, holding the lane's advisory lock file.
   *
   * The reload is why this is safe: another process — the Stop hook's CLI — may
   * have written the file since we last read it, so we start from what is on disk
   * rather than from what we remember.
   *
   * It also means **every object inside `state` is replaced on each call**. A
   * `Turn` you were holding from before is now a different object from the one in
   * `state.turns`, and mutating or reading it has nothing to do with the store:
   *
   *     const r = await snapshotTurn(git, store, {…});  // r.turn is one object
   *     await revertPaths(git, store, r.turn.n, […]);   // reloads; updates another
   *     r.turn.sha                                      // still the old value
   *
   * So pass turn *numbers* across a mutation, never turn objects, and read the
   * turn back out of `store.data.turns` afterwards if you need its new sha. The
   * tree view gets this for free — it rebuilds every node from `store.data` on
   * refresh — but anything holding a `Turn` across one of these calls does not.
   *
   * A crashed holder leaves the lock behind; it is stolen after 10s of silence.
   * Two stealers racing on the same corpse can in theory both proceed — accepted
   * for an advisory lock whose contended path is hook-vs-click, not crash-vs-crash. */
  async withLock<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true });
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const handle = await fs.open(this.lockFile, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") {
          throw error;
        }
        const stat = await fs.stat(this.lockFile).catch(() => undefined);
        if (stat !== undefined && Date.now() - stat.mtimeMs > 10_000) {
          await fs.rm(this.lockFile, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${this.lockFile}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      await this.load();
      const result = await fn(this.state);
      await this.save();
      return result;
    } finally {
      await fs.rm(this.lockFile, { force: true });
    }
  }

  get latestTurn(): Turn | undefined {
    return this.state.turns[this.state.turns.length - 1];
  }

  isReviewed(file: string, turn: number): boolean {
    const at = this.state.reviewed[file];
    return at !== undefined && at >= turn;
  }

  threadsFor(file: string): Thread[] {
    return this.state.threads.filter((t) => t.anchor.file === file);
  }

  get pending(): Thread[] {
    return this.state.threads.filter((t) => t.state === "draft");
  }

  /** Write the pending threads out as one batch — the product's actual output —
   * and flip them to submitted. Returns undefined when there is nothing to send. */
  async submit(): Promise<{ path: string; count: number } | undefined> {
    return this.withLock(async (state) => {
      const batch = state.threads.filter((t) => t.state === "draft");
      if (batch.length === 0) {
        return undefined;
      }
      const now = new Date().toISOString();
      const out = path.join(this.batchesDir, `${now.replace(/[:.]/g, "-")}.json`);
      await fs.mkdir(this.batchesDir, { recursive: true });
      await fs.writeFile(
        out,
        JSON.stringify(
          {
            schemaVersion: state.schemaVersion,
            lane: this.lane.name,
            submittedAt: now,
            turn: this.latestTurn?.n ?? null,
            comments: batch.map((t) => ({
              id: t.id,
              file: t.anchor.file,
              // 1-based on the wire, matching how humans and agents read files.
              line: t.anchor.startLine + 1,
              endLine: t.anchor.endLine + 1,
              turn: t.turn,
              outdated: t.outdated,
              comments: t.comments,
            })),
          },
          null,
          2,
        ),
        "utf8",
      );
      for (const thread of batch) {
        thread.state = "submitted";
      }
      return { path: out, count: batch.length };
    });
  }

  /** The newest submitted batch, for `review batch` — how an agent picks the
   * review up as its next input. */
  async latestBatch(): Promise<{ path: string; content: string } | undefined> {
    let names: string[];
    try {
      names = await fs.readdir(this.batchesDir);
    } catch {
      return undefined;
    }
    const latest = names.filter((n) => n.endsWith(".json")).sort().pop();
    if (latest === undefined) {
      return undefined;
    }
    const file = path.join(this.batchesDir, latest);
    return { path: file, content: await fs.readFile(file, "utf8") };
  }
}
