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
}

interface Branch {
  readonly name?: string;
}

interface GitRepositoryState {
  /** Undefined on a detached HEAD — which is precisely when a lane falls back to
   * the worktree's directory name, so the branch name is the whole lane key. */
  readonly HEAD?: Branch;
  readonly indexChanges: readonly Change[];
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

function branchOf(repository: GitRepository): string {
  return repository.state.HEAD?.name ?? "";
}

/** git's own change events, collapsed into one.
 *
 * The Turns view is computed from what is on disk — the status letter, the
 * problem count, which row may still be reverted — so a terminal `git restore`
 * or `gh pr checkout` is otherwise invisible to it, and a stale row offers a
 * revert that would undo more than its own turn. */
export class GitWatch implements vscode.Disposable {
  private moved = new vscode.EventEmitter<boolean>();
  /** Fires once the dust settles. True when the checkout itself changed, which
   * means a different lane rather than different content. */
  readonly onDidChange = this.moved.event;

  private readonly listeners: vscode.Disposable[] = [];
  private readonly branches = new Map<GitRepository, string>();
  private timer: NodeJS.Timeout | undefined;
  private checkoutMoved = false;

  constructor(private readonly api: GitAPI) {
    this.api.repositories.forEach((repository) => this.watch(repository));
    this.listeners.push(
      this.api.onDidOpenRepository((repository) => {
        this.watch(repository);
        this.schedule(true);
      }),
      this.api.onDidCloseRepository((repository) => {
        this.branches.delete(repository);
        this.schedule(true);
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
   * reviewer marks a change taken, so a turn's row can say that its file has
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
    this.branches.set(repository, branchOf(repository));
    this.listeners.push(
      repository.state.onDidChange(() => {
        const branch = branchOf(repository);
        const moved = this.branches.get(repository) !== branch;
        this.branches.set(repository, branch);
        this.schedule(moved);
      }),
    );
  }

  /** git reports every file an agent writes, one event each, while rebuilding the
   * view costs two git processes per open turn — so the burst becomes one event. */
  private schedule(checkoutMoved: boolean): void {
    this.checkoutMoved ||= checkoutMoved;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const moved = this.checkoutMoved;
      this.checkoutMoved = false;
      this.moved.fire(moved);
    }, 200);
  }
}
