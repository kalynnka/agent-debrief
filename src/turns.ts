import * as path from "path";
import * as vscode from "vscode";

import { turnFileUri } from "./decorations";
import { ChangedFile, Turn } from "./git";
import { GitWatch } from "./gitwatch";
import { Repo, Repos } from "./repos";

export class RepoNode {
  readonly kind = "repo";
  constructor(readonly repo: Repo) {}
}

export class TurnNode {
  readonly kind = "turn";
  constructor(
    readonly repo: Repo,
    readonly turn: Turn,
    readonly checked: boolean,
  ) {}
}

export class FileNode {
  readonly kind = "file";
  constructor(
    readonly repo: Repo,
    readonly turn: Turn,
    readonly file: ChangedFile,
    readonly reviewed: boolean,
    readonly threadCount: number,
    /** This turn's version of the file is the one on disk, so reverting it undoes
     * this turn and nothing else. False once a later turn has written over it —
     * revert that one first, and this row becomes the top of the stack. */
    readonly revertable: boolean,
    /** The file has staged changes: taken, in the sense the commit will keep. */
    readonly staged: boolean,
  ) {}
}

export type Node = RepoNode | TurnNode | FileNode;

/** Repository → turn → file. The repository level is always shown, including for
 * a repo with no turns yet: a workspace of several clones should say which ones
 * it can snapshot, not hide them until they happen to have history. */
export class TurnsProvider implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** Checked turn numbers per repo root — the selection for a stacked diff. */
  private checked = new Map<string, Set<number>>();

  constructor(
    private readonly repos: Repos,
    private readonly gitWatch: GitWatch,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  setChecked(node: TurnNode, on: boolean): void {
    const set = this.checked.get(node.repo.root) ?? new Set<number>();
    if (on) {
      set.add(node.turn.n);
    } else {
      set.delete(node.turn.n);
    }
    this.checked.set(node.repo.root, set);
  }

  /** Every turn of a repo at once — what the repo row's own checkbox means. */
  setAllChecked(repo: Repo, on: boolean): void {
    this.checked.set(repo.root, on ? new Set(repo.store.data.turns.map((t) => t.n)) : new Set());
  }

  /** The checked turns that still exist, in turn order. Gaps are fine: each
   * turn's diff is self-contained (parent → sha), so a non-contiguous
   * selection reads as exactly those turns' history. */
  checkedTurns(repo: Repo): Turn[] {
    const set = this.checked.get(repo.root);
    if (set === undefined) {
      return [];
    }
    return repo.store.data.turns.filter((t) => set.has(t.n));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "repo") {
      const count = node.repo.store.data.turns.length;
      const item = new vscode.TreeItem(
        node.repo.name,
        count === 0
          ? vscode.TreeItemCollapsibleState.None
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      const turns = count === 0 ? "no turns yet" : `${count} turn${count === 1 ? "" : "s"}`;
      item.description = `${node.repo.lane.name} · ${turns}`;
      item.iconPath = new vscode.ThemeIcon("repo");
      item.contextValue = "repo";
      item.tooltip = node.repo.root;
      if (count > 0) {
        item.checkboxState =
          this.checkedTurns(node.repo).length === count
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
      }
      return item;
    }

    if (node.kind === "turn") {
      const item = new vscode.TreeItem(
        `Turn ${node.turn.n} — ${node.turn.label}`,
        node.turn.n === node.repo.store.latestTurn?.n
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = new Date(node.turn.at).toLocaleTimeString();
      item.iconPath = new vscode.ThemeIcon("git-commit");
      item.contextValue = "turn";
      item.checkboxState = node.checked
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      return item;
    }

    const abs = path.join(node.repo.root, node.file.path);
    const dir = path.dirname(node.file.path);
    const item = new vscode.TreeItem(path.basename(abs), vscode.TreeItemCollapsibleState.None);
    const notes = node.threadCount > 0 ? `  💬 ${node.threadCount}` : "";
    // The icon slot goes to the file-type icon, so "reviewed" has to say itself;
    // the letter stays in the text because the badge gives its slot up to the
    // problem count whenever there is one.
    const where = dir === "." ? "" : `  ${dir}`;
    const staged = node.staged ? " staged" : "";
    item.description = `${node.reviewed ? "✓  " : ""}${node.file.status}${staged}${where}${notes}`;
    item.resourceUri = turnFileUri(abs, node.file.status);
    item.tooltip = `${node.file.path} — ${node.file.status}${node.staged ? ", staged" : ""}`;
    item.contextValue = `file-${node.reviewed ? "reviewed" : "unreviewed"}${
      node.revertable ? "-revertable" : ""
    }`;
    item.command = {
      command: "octoview.openDiff",
      title: "Open Diff",
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) {
      return this.repos.all.map((repo) => new RepoNode(repo));
    }
    if (node.kind === "repo") {
      const set = this.checked.get(node.repo.root);
      return node.repo.store.data.turns.map(
        (t) => new TurnNode(node.repo, t, set?.has(t.n) ?? false),
      );
    }
    if (node.kind === "file") {
      return [];
    }
    const files = await node.repo.git.changedFiles(node.turn.parent, node.turn.sha);
    const intact = await node.repo.git.unchangedSince(
      node.turn.sha,
      files.map((file) => file.path),
    );
    const staged = this.gitWatch.stagedPaths(node.repo.root);
    return files.map(
      (file) =>
        new FileNode(
          node.repo,
          node.turn,
          file,
          node.repo.store.isReviewed(file.path, node.turn.n),
          node.repo.store.threadsFor(file.path).filter((t) => t.state === "draft").length,
          intact.has(file.path),
          staged.has(file.path),
        ),
    );
  }
}
