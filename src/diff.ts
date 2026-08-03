import * as path from "path";
import * as vscode from "vscode";

import { pathOf, revisionUri } from "./comments";
import { Repo, Repos } from "./repos";
import { FileNode } from "./turns";

/** Serves file content at a snapshot revision, so a diff can show a side that no
 * longer exists on disk. The revision URI names an absolute path, so which repo
 * to ask is a lookup rather than an assumption. */
export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repos: Repos) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const located = this.repos.locate(pathOf(uri));
    if (located === undefined) {
      throw new Error(`octoview: ${uri.path} is not inside any repository in this workspace`);
    }
    return located.repo.git.fileAt(uri.query, located.rel);
  }
}

/** Open turn N-1 → turn N for one file.
 *
 * For the newest turn the right-hand side is the real file on disk, so the
 * language server attaches and hovers, types, and go-to-definition work while
 * reading. Older turns diff two revisions and are read-only by nature. */
export async function openDiff(repo: Repo, node: FileNode): Promise<void> {
  const abs = path.join(repo.root, node.file.path);
  const isLatest = node.turn.n === repo.store.latestTurn?.n;
  const left = revisionUri(node.turn.parent, abs);
  const right = isLatest ? vscode.Uri.file(abs) : revisionUri(node.turn.sha, abs);
  const title = isLatest
    ? `${repo.name}/${node.file.path} — turn ${node.turn.n} (working tree)`
    : `${repo.name}/${node.file.path} — turn ${node.turn.n - 1} → ${node.turn.n}`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true,
  });
}
