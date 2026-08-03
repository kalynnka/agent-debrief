import * as vscode from "vscode";

import { ChangedFile, Turn } from "./git";
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
  ) {}
}

export type Node = RepoNode | TurnNode | FileNode;

/** Repository → turn → file. The repository level is always shown, including for
 * a repo with no turns yet: a workspace of several clones should say which ones
 * it can snapshot, not hide them until they happen to have history. */
export class TurnsProvider implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly repos: Repos) {}

  refresh(): void {
    this.changed.fire(undefined);
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
      item.description = count === 0 ? "no turns yet" : `${count} turn${count === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon("repo");
      item.contextValue = "repo";
      item.tooltip = node.repo.root;
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
      return item;
    }

    const item = new vscode.TreeItem(
      node.file.path.split("/").pop() ?? node.file.path,
      vscode.TreeItemCollapsibleState.None,
    );
    const notes = node.threadCount > 0 ? `  💬 ${node.threadCount}` : "";
    item.description = `${node.file.status}  ${node.file.path}${notes}`;
    item.resourceUri = vscode.Uri.file(node.file.path);
    item.iconPath = new vscode.ThemeIcon(
      node.reviewed ? "pass-filled" : "circle-large-outline",
      new vscode.ThemeColor(node.reviewed ? "charts.green" : "charts.orange"),
    );
    item.contextValue = node.reviewed ? "file-reviewed" : "file-unreviewed";
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
      return [...node.repo.store.data.turns].reverse().map((t) => new TurnNode(node.repo, t));
    }
    if (node.kind === "file") {
      return [];
    }
    const files = await node.repo.git.changedFiles(node.turn.parent, node.turn.sha);
    return files.map(
      (file) =>
        new FileNode(
          node.repo,
          node.turn,
          file,
          node.repo.store.isReviewed(file.path, node.turn.n),
          node.repo.store.threadsFor(file.path).filter((t) => t.state === "draft").length,
        ),
    );
  }
}
