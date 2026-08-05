import * as path from "path";
import * as vscode from "vscode";

import { SCHEME, pathOf, revisionUri } from "./comments";
import { Turn } from "./git";
import { Repo, Repos } from "./repos";
import { FileNode } from "./turns";

/** Serves file content at a snapshot revision, so a diff can show a side that
 * no longer exists on disk. The revision URI names an absolute path, so which
 * repo to ask is a lookup rather than an assumption. */
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

/** Open the checked turns' net change: the native multi-diff editor, one row
 * per changed file, base → last checked snapshot. Everything the diff editor
 * gives — word-level highlights, line numbers, comments, open-file — works
 * untouched; the turn-by-turn flow lives in `openStepHistory`, reachable per
 * file. A change a later turn reverted nets out and does not appear. */
export async function openStackedDiff(repo: Repo, turns: Turn[]): Promise<void> {
  const base = turns[0].parent;
  const last = turns[turns.length - 1];
  const files = await repo.git.changedFiles(base, last.sha);
  if (files.length === 0) {
    vscode.window.showInformationMessage(
      `Octoview: turns ${turns[0].n}→${last.n} in ${repo.name} net out to no changes.`,
    );
    return;
  }
  const isLatest = last.n === repo.store.latestTurn?.n;
  const span =
    turns.length === 1
      ? `turn ${turns[0].n} — ${turns[0].label}`
      : `turns ${turns[0].n}→${last.n} net`;
  if (files.length === 1) {
    // A one-row multi-diff leaves the rest of the tab empty; the plain diff
    // editor shows the same change at full height.
    const file = files[0];
    const abs = path.join(repo.root, file.path);
    await vscode.commands.executeCommand(
      "vscode.diff",
      revisionUri(base, path.join(repo.root, file.oldPath ?? file.path)),
      isLatest ? vscode.Uri.file(abs) : revisionUri(last.sha, abs),
      `${repo.name}/${file.path}: ${span}`,
      { preview: false },
    );
    return;
  }
  const resources = files.map((file) => {
    const abs = path.join(repo.root, file.path);
    const absOld = path.join(repo.root, file.oldPath ?? file.path);
    return [
      vscode.Uri.file(abs),
      revisionUri(base, absOld),
      isLatest ? vscode.Uri.file(abs) : revisionUri(last.sha, abs),
    ];
  });
  await vscode.commands.executeCommand("vscode.changes", `${repo.name}: ${span}`, resources);
}

/** Open one file's evolution as native diff rows: each selected turn that
 * touched the file contributes its own parent → sha transition, in order, so
 * scrolling the tab replays the file step by step with real diffs — word-level
 * highlights and comments included. Each row's header names its turn, and the
 * view opens as its own tab so closing it lands back on whatever was showing. */
export async function openStepHistory(repo: Repo, rel: string, turns: Turn[]): Promise<void> {
  const abs = path.join(repo.root, rel);
  const steps: Turn[] = [];
  for (const turn of turns) {
    const files = await repo.git.changedFiles(turn.parent, turn.sha);
    if (files.some((f) => f.path === rel || f.oldPath === rel)) {
      steps.push(turn);
    }
  }
  if (steps.length === 0) {
    vscode.window.showInformationMessage(`Octoview: no selected turn touched ${rel}.`);
    return;
  }
  const latest = repo.store.latestTurn?.n;
  if (steps.length === 1) {
    // One step is one diff; the plain editor shows it at full height instead
    // of a single multi-diff row floating over empty space.
    const turn = steps[0];
    await vscode.commands.executeCommand(
      "vscode.diff",
      revisionUri(turn.parent, abs),
      turn.n === latest ? vscode.Uri.file(abs) : revisionUri(turn.sha, abs),
      `${path.basename(rel)}: t${turn.n} — ${turn.label}`,
      { preview: false },
    );
    return;
  }
  // The multi-diff lands in the preview slot and would evict whatever preview
  // is showing — usually the net diff. Pin that first so the step view arrives
  // as a second tab and closing it goes straight back.
  if (vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview === true) {
    await vscode.commands.executeCommand("workbench.action.keepEditor");
  }
  const resources = steps.map((turn) => [
    // The multi-diff row header renders this first URI, so its path names the
    // turn; pathOf recovers the real path from the fragment.
    vscode.Uri.from({
      scheme: SCHEME,
      path: path.join(path.dirname(abs), `t${turn.n} — ${turn.label.replaceAll("/", "∕")}`),
      query: turn.sha,
      fragment: abs,
    }),
    revisionUri(turn.parent, abs),
    turn.n === latest ? vscode.Uri.file(abs) : revisionUri(turn.sha, abs),
  ]);
  // Every row header already names the file's directory and its turn, so the tab
  // only has to say which file and how far it runs. VS Code appends its own
  // "(N files)" to a multi-diff title — here N is the step count, and there is no
  // way to suppress it — which is one more reason to keep the label short.
  await vscode.commands.executeCommand(
    "vscode.changes",
    `${path.basename(rel)}: t${steps[0].n}→t${steps[steps.length - 1].n}`,
    resources,
  );
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
