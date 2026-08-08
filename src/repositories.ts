import * as vscode from "vscode";

import { Repo, RepoSelection, Repos } from "./repos";

/** The repository selector: every git repository the workspace resolves to, each
 * with a checkbox saying whether the Snapshots view draws it.
 *
 * Source Control's own Repositories section is the model, down to listing repos
 * the Snapshots view would not — a repo with no snapshots yet still belongs
 * here, because this is the list you choose from rather than the list you read,
 * and a repo you cannot see is one you cannot pre-select.
 *
 * It holds no state of its own. The checkbox reads and writes `RepoSelection`,
 * which is what the Snapshots view filters on, so the two views cannot disagree
 * about what is showing. */
export class RepositoriesProvider implements vscode.TreeDataProvider<Repo> {
  private changed = new vscode.EventEmitter<Repo | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly repos: Repos,
    private readonly selection: RepoSelection,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(repo: Repo): vscode.TreeItem {
    const item = new vscode.TreeItem(repo.name, vscode.TreeItemCollapsibleState.None);
    const count = repo.store.data.snapshots.length;
    item.description = `${repo.lane.name} · ${count} snapshot${count === 1 ? "" : "s"}`;
    item.iconPath = new vscode.ThemeIcon("repo");
    item.tooltip = repo.root;
    item.checkboxState = this.selection.shows(repo)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return item;
  }

  getChildren(repo?: Repo): Repo[] {
    // Flat, like the section it copies: a repository is the unit of review and
    // has nothing above it to nest under.
    return repo === undefined ? this.repos.all : [];
  }
}
