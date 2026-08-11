import * as path from "path";
import * as vscode from "vscode";

/** The slice of the built-in git extension's API (`vscode.git`, version 1) this
 * needs: its live model of the repository, which is the only cheap way to learn
 * that the working tree, the index or the checkout moved. Debrief does its own
 * git plumbing — this is a signal, not a client. The full contract lives in
 * microsoft/vscode, `extensions/git/src/api/git.d.ts`; `extensionDependencies`
 * in package.json is what guarantees it is present and activated before us. */
interface Change {
  readonly uri: vscode.Uri;
  /** `Status`, a numeric enum. Only ever compared, never interpreted here. */
  readonly status: number;
}

interface Branch {
  readonly name?: string;
  /** The commit HEAD points at. Free to read — the git extension already tracks
   * it — and it is what tells a commit apart from an edit without asking git. */
  readonly commit?: string;
}

interface Ref {
  readonly name?: string;
}

interface GitRepositoryState {
  /** Undefined on a detached HEAD — which is precisely when a lane falls back to
   * the worktree's directory name, so the branch name is the whole lane key. */
  readonly HEAD?: Branch;
  readonly indexChanges: readonly Change[];
  readonly workingTreeChanges: readonly Change[];
  readonly untrackedChanges: readonly Change[];
  readonly onDidChange: vscode.Event<void>;
}

/** What `getRefs` filters by. Debrief passes it empty, which means every ref —
 * a fingerprint of "did anything structural move" wants all of them, including
 * `refs/stash` and debrief's own `refs/debrief/*`. */
interface RefQuery {
  readonly pattern?: string | string[];
}

interface GitRepository {
  readonly state: GitRepositoryState;
  /** Every branch, tag and remote ref, straight off `for-each-ref` and already
   * in refname order, so joining the names gives a stable fingerprint.
   *
   * This is where `state.refs` went. That getter still exists, but the extension
   * now answers it with an empty array and a deprecation warning — so a shape
   * built on it reported "no refs" forever and the refs half of the comparison
   * had gone quietly blind. Reading it costs a subprocess, which is why it is
   * only ever compared and never interpreted. */
  getRefs(query: RefQuery): Promise<readonly Ref[]>;
}

interface GitAPI {
  readonly repositories: readonly GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

export async function gitApi(): Promise<GitAPI> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (extension === undefined) {
    throw new Error("debrief: the built-in git extension (vscode.git) is not available");
  }
  return (await extension.activate()).getAPI(1);
}

/** What the Snapshots view actually reads out of git: the lane, and which paths git
 * is calling changed. Compared as a whole to tell a real change from a re-run. */
interface Shape {
  branch: string;
  /** HEAD's commit and the set of refs: everything a snapshot's *structure*
   * depends on. Which commits landed, which lanes are abandoned, whether the
   * stash moved — none of it can change unless one of these does. */
  head: string;
  refs: string;
  /** What is on disk right now. Moves on every file an agent writes, and decides
   * only the file rows. */
  changes: string;
}

async function shapeOf(repository: GitRepository): Promise<Shape> {
  // Read the state git is reporting now, before going to git for the rest, so the
  // cheap half of the shape describes one moment rather than being torn across the
  // wait for the refs.
  const state = repository.state;
  const branch = state.HEAD?.name ?? "";
  const head = state.HEAD?.commit ?? "";
  const changes = [...state.indexChanges, ...state.workingTreeChanges, ...state.untrackedChanges]
    .map((change) => `${change.status} ${change.uri.fsPath}`)
    .join("\n");
  const refs = await repository.getRefs({});
  return { branch, head, refs: refs.map((ref) => ref.name ?? "").join(","), changes };
}

/** How much moved, so a listener can redraw only what the move can have changed.
 *
 * `checkout` means a different lane entirely — a different review. `structure`
 * means HEAD or the refs moved, so which snapshots landed, which lanes are
 * abandoned and whether the stash moved all have to be worked out again. Neither
 * set means the working tree changed and nothing else did, which is what an agent
 * mid-turn produces: every file it writes, and no structure at all. */
export interface GitMoved {
  checkout: boolean;
  structure: boolean;
}

/** git's own change events, collapsed into one.
 *
 * The Snapshots view is computed from what is on disk — the status letter, the
 * problem count, which row may still be reverted — so a terminal `git restore`
 * or `gh pr checkout` is otherwise invisible to it, and a stale row offers a
 * revert that would undo more than its own snapshot. */
export class GitWatch implements vscode.Disposable {
  private moved = new vscode.EventEmitter<GitMoved>();
  /** Fires once the dust settles, saying how much moved. */
  readonly onDidChange = this.moved.event;

  private readonly listeners: vscode.Disposable[] = [];
  private readonly seen = new Map<GitRepository, Shape>();
  /** Which read of a repository is the newest one issued. Reading a shape now
   * waits on git, so two of them can be in flight at once and they can come back
   * in either order — see `resample`. */
  private readonly latest = new Map<GitRepository, number>();
  /** Repositories that have reported an event and not yet been read. Named, not
   * counted, because a workspace of several clones gets one event per clone and
   * only the ones that spoke are worth a subprocess. */
  private readonly dirty = new Set<GitRepository>();
  private timer: NodeJS.Timeout | undefined;
  private pending: GitMoved = { checkout: false, structure: false };
  private disposed = false;

  constructor(private readonly api: GitAPI) {
    this.api.repositories.forEach((repository) => this.watch(repository));
    this.listeners.push(
      this.api.onDidOpenRepository((repository) => {
        this.watch(repository);
        this.schedule({ checkout: true, structure: true });
      }),
      this.api.onDidCloseRepository((repository) => {
        this.seen.delete(repository);
        // Dropping the ticket also settles any read still out on this repository:
        // it will find no ticket of its own and put nothing back.
        this.latest.delete(repository);
        // And a repository that spoke and then closed is not one to go and read.
        this.dirty.delete(repository);
        this.schedule({ checkout: true, structure: true });
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.listeners.forEach((listener) => listener.dispose());
    this.moved.dispose();
  }

  /** Paths whose changes are staged, relative to the repo root. Staging is how a
   * reviewer marks a change taken, so a snapshot's row can say that its file has
   * already been accepted — the one thing Source Control cannot say back. */
  stagedPaths(root: string): Set<string> {
    const repository = this.api.getRepository(vscode.Uri.file(root));
    if (repository === null) {
      return new Set();
    }
    return new Set(
      repository.state.indexChanges.map((change) => path.relative(root, change.uri.fsPath)),
    );
  }

  /** Re-read a repository's shape and hand back the one it replaced.
   *
   * Reading waits on git, so a burst can put several reads in flight and they can
   * return out of order. Each takes a ticket first and drops its answer if a later
   * read has been issued since: writing an older shape over a newer one would
   * leave `seen` describing a past, and the next event would compare against it
   * and report moves that already happened.
   *
   * Undefined means exactly that — this read was overtaken and has nothing to say,
   * because the read that overtook it will speak for both. */
  private async resample(
    repository: GitRepository,
  ): Promise<{ before: Shape | undefined; now: Shape } | undefined> {
    const ticket = (this.latest.get(repository) ?? 0) + 1;
    this.latest.set(repository, ticket);
    const now = await shapeOf(repository);
    if (this.latest.get(repository) !== ticket) {
      return undefined;
    }
    const before = this.seen.get(repository);
    this.seen.set(repository, now);
    return { before, now };
  }

  private watch(repository: GitRepository): void {
    // The first read takes a ticket like any other: an event can land while it is
    // still out, and the answer it seeds must not land on top of a fresher one.
    // Until one of them returns the repository is simply unseen, which already
    // reads as "everything moved".
    void this.resample(repository);
    // Noting that the repository spoke is the whole of the work done here. What it
    // now looks like is asked once the burst is over, in `settle`.
    this.listeners.push(
      repository.state.onDidChange(() => {
        this.dirty.add(repository);
        this.arm();
      }),
    );
  }

  /** Read every repository that spoke, and fire once for all of them.
   *
   * git re-runs status on any file event under the repo — a build writing to an
   * ignored directory, a save, an editor opening — and reports the result whether
   * or not it differs, which is why a shape is compared before anything is
   * redrawn. A repository whose shape did not move contributes nothing, and when
   * none of them moved nothing fires at all. */
  private async settle(): Promise<void> {
    const spoke = [...this.dirty];
    this.dirty.clear();
    const moved = this.pending;
    this.pending = { checkout: false, structure: false };
    // An open or a close says its own answer without being asked, so it fires
    // whatever the readings say.
    let fire = moved.checkout || moved.structure;
    // One repository failing its read — closed, or deleted under us mid-burst —
    // says nothing about that one and must not take the others' event with it.
    const readings = await Promise.all(
      spoke.map((repository) => this.resample(repository).catch(() => undefined)),
    );
    if (this.disposed) {
      return;
    }
    for (const reading of readings) {
      if (reading === undefined) {
        continue;
      }
      const { before, now } = reading;
      if (
        before !== undefined &&
        before.branch === now.branch &&
        before.head === now.head &&
        before.refs === now.refs &&
        before.changes === now.changes
      ) {
        continue;
      }
      // A working tree that moved on its own sets neither flag, and still fires:
      // that is an agent mid-turn, and the file rows are drawn from disk.
      fire = true;
      moved.checkout ||= before === undefined || before.branch !== now.branch;
      moved.structure ||=
        before === undefined ||
        before.branch !== now.branch ||
        before.head !== now.head ||
        before.refs !== now.refs;
    }
    if (fire) {
      this.moved.fire(moved);
    }
  }

  /** An answer this watch already has, without reading anything: a repository
   * opening or closing is a different set of lanes either way. */
  private schedule(moved: GitMoved): void {
    this.pending = {
      checkout: this.pending.checkout || moved.checkout,
      structure: this.pending.structure || moved.structure,
    };
    this.arm();
  }

  /** git reports every file an agent writes, one event each, so the burst becomes
   * one settle — and, now, one read of each repository rather than one per event.
   *
   * The reading used to happen in the listener, ahead of this timer, so the
   * collapsing protected the redraw and nothing else: a shape costs a
   * `for-each-ref` subprocess, and an agent writing forty files paid forty of them
   * per window to conclude forty times that the refs had not moved. A window is
   * cheap and people keep many open, so that multiplied by every window with the
   * repo in it. Reading behind the timer costs one per repository per burst.
   *
   * What it costs is latency: the shape is now read after the quiet period rather
   * than during it, so the event lands a subprocess later than it did — tens of
   * milliseconds, against a 400ms wait nobody is watching.
   *
   * 400ms rather than 200. It was originally raised because a redraw cost about
   * as much as the interval — 27 subprocesses, ~200ms — so an agent mid-turn kept
   * the view rebuilding continuously. Splitting structural work out of the redraw
   * fixed that (a worktree-only redraw is now 6 subprocesses and ~50ms), so 200
   * would be affordable again; it stays at 400 because collapsing more of a write
   * burst is free, and nothing in this view is what a reviewer watches while an
   * agent types. */
  private arm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.settle();
    }, 400);
  }
}
