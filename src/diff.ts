import * as path from "path";
import * as vscode from "vscode";

import { pathOf, revisionUri, stackUri } from "./comments";
import { Turn } from "./git";
import { Repo, Repos } from "./repos";
import { stackedBase } from "./review";
import { FileNode } from "./turns";

/** Serves file content at a snapshot revision — or, for a `stack:` query, the
 * synthesized stacked-history base — so a diff can show a side that never
 * exists on disk. The URI names an absolute path, so which repo to ask is a
 * lookup rather than an assumption. */
export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repos: Repos) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const located = this.repos.locate(pathOf(uri));
    if (located === undefined) {
      throw new Error(`octoview: ${uri.path} is not inside any repository in this workspace`);
    }
    if (uri.query.startsWith("stack:")) {
      return stackedBase(located.repo.git, located.rel, uri.query.slice("stack:".length).split(","));
    }
    return located.repo.git.fileAt(uri.query, located.rel);
  }
}

/** Open the checked turns as stacked history: one row per changed file, the
 * history inside the file's own diff.
 *
 * `vscode.changes` is the multi-diff editor the git extension uses for "View
 * Changes". Each row diffs a synthesized base (`stackedBase`: the original
 * lines plus every superseded intermediate, in order) against the file at the
 * last checked turn — so the editor itself renders the flow: origin and
 * intermediate values as consecutive deletions, the surviving values as
 * additions, untouched lines as context. Files the checked turns never touched
 * do not appear. When the last checked turn is the repo's newest, the
 * right-hand sides are the live working-tree files, keeping the language
 * server attached. */
export async function openStackedDiff(repo: Repo, turns: Turn[]): Promise<void> {
  const changed = new Set<string>();
  for (const turn of turns) {
    for (const file of await repo.git.changedFiles(turn.parent, turn.sha)) {
      changed.add(file.path);
      if (file.oldPath !== undefined) {
        changed.delete(file.oldPath);
      }
    }
  }
  const states = [turns[0].parent, ...turns.map((t) => t.sha)];
  const last = turns[turns.length - 1];
  const isLatest = last.n === repo.store.latestTurn?.n;
  const resources = [...changed].sort().map((rel) => {
    const abs = path.join(repo.root, rel);
    return [
      vscode.Uri.file(abs),
      stackUri(states, abs),
      isLatest ? vscode.Uri.file(abs) : revisionUri(last.sha, abs),
    ];
  });
  const title =
    turns.length === 1
      ? `${repo.name}: turn ${turns[0].n} — ${turns[0].label}`
      : `${repo.name}: turns ${turns.map((t) => t.n).join(", ")} stacked`;
  await vscode.commands.executeCommand("vscode.changes", title, resources);
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
