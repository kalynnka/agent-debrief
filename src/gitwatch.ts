import * as path from "path";
import * as vscode from "vscode";

/** The slice of the built-in git extension's API (`vscode.git`, version 1) this
 * needs: its live model of the repository, which is the only cheap way to learn
 * that the working tree, the index or the checkout moved. Octoview does its own
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
  /** Every branch, tag and remote ref the extension knows. Optional because this
   * is a hand-written slice of someone else's API, and an absent field must read
   * as "cannot tell" rather than as "none". */
  readonly refs?: readonly Ref[];
  readonly indexChanges: readonly Change[];
  readonly workingTreeChanges: readonly Change[];
  readonly untrackedChanges: readonly Change[];
  readonly onDidChange: vscode.Event<void>;
}

interface GitRepository {
  readonly state: GitRepositoryState;
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
    throw new Error("octoview: the built-in git extension (vscode.git) is not available");
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

function shapeOf(repository: GitRepository): Shape {
  const state = repository.state;
  return {
    branch: state.HEAD?.name ?? "",
    head: state.HEAD?.commit ?? "",
    // Undefined means the API did not give us refs, which has to read as "unknown"
    // — a constant would claim they never change and quietly stop invalidating.
    refs: state.refs === undefined ? "?" : state.refs.map((ref) => ref.name ?? "").join(","),
    changes: [...state.indexChanges, ...state.workingTreeChanges, ...state.untrackedChanges]
      .map((change) => `${change.status} ${change.uri.fsPath}`)
      .join("\n"),
  };
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
  private timer: NodeJS.Timeout | undefined;
  private pending: GitMoved = { checkout: false, structure: false };

  constructor(private readonly api: GitAPI) {
    this.api.repositories.forEach((repository) => this.watch(repository));
    this.listeners.push(
      this.api.onDidOpenRepository((repository) => {
        this.watch(repository);
        this.schedule({ checkout: true, structure: true });
      }),
      this.api.onDidCloseRepository((repository) => {
        this.seen.delete(repository);
        this.schedule({ checkout: true, structure: true });
      }),
    );
  }

  dispose(): void {
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

  private watch(repository: GitRepository): void {
    this.seen.set(repository, shapeOf(repository));
    this.listeners.push(
      repository.state.onDidChange(() => {
        const before = this.seen.get(repository);
        const now = shapeOf(repository);
        this.seen.set(repository, now);
        // git re-runs status on any file event under the repo — a build writing
        // to an ignored directory, a save, an editor opening — and reports the
        // result whether or not it differs. Rebuilding the tree for an answer
        // that did not change is exactly what makes the rows flicker.
        const same =
          before !== undefined &&
          before.branch === now.branch &&
          before.head === now.head &&
          before.refs === now.refs &&
          before.changes === now.changes;
        if (same) {
          return;
        }
        this.schedule({
          checkout: before === undefined || before.branch !== now.branch,
          structure:
            before === undefined ||
            before.branch !== now.branch ||
            before.head !== now.head ||
            before.refs !== now.refs,
        });
      }),
    );
  }

  /** git reports every file an agent writes, one event each, so the burst becomes
   * one event.
   *
   * 400ms rather than 200. It was originally raised because a redraw cost about
   * as much as the interval — 27 subprocesses, ~200ms — so an agent mid-turn kept
   * the view rebuilding continuously. Splitting structural work out of the redraw
   * fixed that (a worktree-only redraw is now 6 subprocesses and ~50ms), so 200
   * would be affordable again; it stays at 400 because collapsing more of a write
   * burst is free, and nothing in this view is what a reviewer watches while an
   * agent types. */
  private schedule(moved: GitMoved): void {
    this.pending = {
      checkout: this.pending.checkout || moved.checkout,
      structure: this.pending.structure || moved.structure,
    };
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const moved = this.pending;
      this.pending = { checkout: false, structure: false };
      this.moved.fire(moved);
    }, 400);
  }
}
