import * as path from "path";
import * as vscode from "vscode";

import { SCHEME, pathOf, revisionUri } from "./comments";
import { FileRow } from "./files";
import { ChangedFile, Snapshot } from "./git";
import { Repo, Repos } from "./repos";
import { FileNode } from "./snapshots";

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

/** Where a review's opening note is served from. Its query is the snapshots it
 * covers, in order; an empty query is the empty left-hand side that makes the
 * note render as one added block rather than as a file with no changes. */
export const NOTE_SCHEME = "octoview-note";

/** Named as a file so the row header reads as one, and given a markdown
 * extension so the icon theme draws it as a note rather than as source. Short,
 * because the row header shows it beside the repository name. */
const NOTE_NAME = "Notes.md";

function noteUri(repo: Repo, snapshots: Snapshot[], text: boolean): vscode.Uri {
  return vscode.Uri.from({
    scheme: NOTE_SCHEME,
    path: path.join(repo.root, NOTE_NAME),
    query: text ? snapshots.map((snapshot) => snapshot.n).join(",") : "",
  });
}

/** The note on its own, as a document — what the sidebar hover links to when the
 * message is longer than a hover can hold. An editor scrolls, selects and copies,
 * none of which a hover does.
 *
 * Its own tab, not the preview slot: the preview slot is usually holding the
 * review this note belongs to, and reading the note is not a reason to lose it. */
export async function openNote(repo: Repo, snapshots: Snapshot[]): Promise<void> {
  await vscode.window.showTextDocument(noteUri(repo, snapshots, true), { preview: false });
}

/** What the agent said when it finished each snapshot, as a document — so a review
 * can open with it. The tab title and the tree row have room for its first line
 * only; this is the rest of it, which is where the reasoning and the caveats
 * are. A snapshot taken before messages were kept falls back to its label.
 *
 * A diff row renders no markdown, so this is read exactly as it is written —
 * which is what `prepare-change-review` writes the message for. */
export class NoteContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repos: Repos) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query === "") {
      return "";
    }
    const located = this.repos.locate(uri.path);
    if (located === undefined) {
      throw new Error(`octoview: ${uri.path} is not inside any repository in this workspace`);
    }
    const wanted = new Set(uri.query.split(","));
    const all = located.repo.store.data.snapshots;
    return all
      .filter((snapshot) => wanted.has(String(snapshot.n)))
      .map(
        (snapshot) =>
          `Snapshot ${snapshot.n} · ${titleCase(snapshot.agent)} · ` +
          `${new Date(snapshot.at).toLocaleString()}\n\n` +
          headMoved(all, snapshot) +
          `${snapshot.message ?? snapshot.label}\n`,
      )
      .join("\n———\n\n");
  }
}

/** A warning line when HEAD moved between this snapshot and the one before it,
 * and nothing at all when it did not.
 *
 * A snapshot diffs against the previous snapshot, not against HEAD, so a `git
 * pull` or `git merge` in between shows up inside the diff as though the agent
 * had written it. Nothing here can tell which lines were whose — that is the
 * subtraction still to be built — so it says the one thing it does know, in the
 * place a reviewer reads before the diff. Snapshots from before HEAD was recorded
 * say nothing rather than guessing. */
function headMoved(all: Snapshot[], snapshot: Snapshot): string {
  const previous = all[all.indexOf(snapshot) - 1];
  if (
    previous === undefined ||
    snapshot.head === undefined ||
    previous.head === undefined ||
    snapshot.head === previous.head
  ) {
    return "";
  }
  return (
    `HEAD moved under this snapshot: ${previous.head.slice(0, 7)} → ` +
    `${snapshot.head.slice(0, 7)}. Files marked ⇣ arrived with that move rather ` +
    `than from the agent.\n\n`
  );
}

/** An agent's name as a name: the field is a lowercase id (`claude`, `codex`,
 * `manual`) and this line is a heading a person reads. Anything the build has
 * never heard of still gets capitalised rather than dropped. */
function titleCase(agent: string): string {
  return agent === "" ? agent : `${agent[0].toUpperCase()}${agent.slice(1)}`;
}

/** Open our revision-backed diff tabs again, following any snapshot that moved.
 *
 * Two things leave one of these tabs showing the wrong thing, and reopening is
 * the fix for both. A window reload restores tabs before the extension has
 * activated, so nothing is serving the `octoview:` scheme yet and the editor
 * comes back unresolved — the tab is still there, but its content never arrives.
 * And a revert rewrites snapshot commits, which leaves a tab pointed at a snapshot
 * that is no longer any snapshot's; `moved` carries it to the one that replaced it.
 *
 * Only plain diff tabs. The multi-diff editor's input type is not in the stable
 * API — it arrives as `unknown` — so a stacked or step-history tab is left alone
 * and has to be reopened from the tree. */
export async function reopenRevisionTabs(moved: Map<string, string>): Promise<void> {
  const follow = (uri: vscode.Uri): vscode.Uri => {
    const to = uri.scheme === SCHEME ? moved.get(uri.query) : undefined;
    return to === undefined ? uri : uri.with({ query: to });
  };
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputTextDiff)) {
        continue;
      }
      const { original, modified } = tab.input;
      if (original.scheme !== SCHEME && modified.scheme !== SCHEME) {
        continue;
      }
      await vscode.window.tabGroups.close(tab);
      await vscode.commands.executeCommand(
        "vscode.diff",
        follow(original),
        follow(modified),
        tab.label,
        // The reopened tab has to land where it was, without stealing the cursor
        // from whatever the reviewer is actually looking at.
        { preview: false, preserveFocus: true, viewColumn: group.viewColumn },
      );
    }
  }
}

/** Open the selected snapshots' net change: the native multi-diff editor, one row
 * per changed file, base → last selected snapshot. Everything the diff editor
 * gives — word-level highlights, line numbers, comments, open-file — works
 * untouched; the snapshot-by-snapshot flow lives in `openStepHistory`, reachable per
 * file.
 *
 * The rows come from the caller rather than from one diff across the span: a
 * non-contiguous selection would otherwise show files that only an unselected
 * snapshot in the gap had touched. A change a later selected snapshot reverted nets out
 * and does not appear either way.
 *
 * Returns the title it used, which is the only handle a multi-diff tab has. */
export async function openStackedDiff(
  repo: Repo,
  snapshots: Snapshot[],
  rows: FileRow[],
): Promise<string | undefined> {
  const base = snapshots[0].parent;
  const last = snapshots[snapshots.length - 1];
  if (rows.length === 0) {
    vscode.window.showInformationMessage(
      `Octoview: snapshots ${snapshots[0].n}→${last.n} in ${repo.name} net out to no changes.`,
    );
    return undefined;
  }
  const isLatest = last.n === repo.store.latestSnapshot?.n;
  const added = rows.reduce((n, row) => n + row.stat.added, 0);
  const deleted = rows.reduce((n, row) => n + row.stat.deleted, 0);
  // Which snapshots and how big, and nothing else. What they *did* is the first
  // row of the review, in full and unabridged; a tab is one line, and a label
  // repeated there only pushed the numbers off the end of it.
  const span =
    snapshots.length === 1
      ? `snapshot ${snapshots[0].n}`
      : `snapshots ${snapshots[0].n}→${last.n} net`;
  const counts = `+${added} −${deleted}`;
  if (rows.length === 1) {
    // A one-row multi-diff leaves the rest of the tab empty; the plain diff
    // editor shows the same change at full height. There is no note row here, so
    // the title says which file instead.
    const file = rows[0].file;
    const abs = path.join(repo.root, file.path);
    const title = `${repo.name}: ${span} · ${path.basename(file.path)} · ${counts}`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      revisionUri(base, path.join(repo.root, file.oldPath ?? file.path)),
      isLatest ? vscode.Uri.file(abs) : revisionUri(last.sha, abs),
      title,
      { preview: false },
    );
    return title;
  }
  const title = `${repo.name}: ${span} · ${counts}`;
  // The agent's own account of the work, first: a diff is easier to read for
  // knowing what the snapshot was trying to do, and this is the one place with
  // room for the whole message. Always present, because it is now the only place
  // the message is — a snapshot with none falls back to its label, which the tab
  // title no longer carries either.
  const resources = [
    [
      vscode.Uri.file(path.join(repo.root, NOTE_NAME)),
      noteUri(repo, snapshots, false),
      noteUri(repo, snapshots, true),
    ],
    ...rows.map((row) => {
      const abs = path.join(repo.root, row.file.path);
      const absOld = path.join(repo.root, row.file.oldPath ?? row.file.path);
      return [
        viewedLabel(abs, row.reviewed, row.foreign),
        revisionUri(base, absOld),
        isLatest ? vscode.Uri.file(abs) : revisionUri(last.sha, abs),
      ];
    }),
  ];
  await vscode.commands.executeCommand("vscode.changes", title, resources);
  return title;
}

/** A multi-diff row's header label, ticked when the file has been viewed.
 *
 * The tick rides in the name because nothing else about that header can hold it:
 * the label is built with `setFile(uri, {strikethrough})` — no `fileDecorations`,
 * so a `FileDecoration` badge never reaches it — and the row's toolbar takes
 * buttons, not state. The extension stays on the end, so the icon theme still
 * recognises the file, and the tick costs nothing else: `vscode.changes` leaves
 * `goToFileUri` unset, so Open File follows the editor's own URI rather than this
 * one, and still opens the real file.
 *
 * Baked in when the tab opens: a mark made later moves this only on reopen. */
function viewedLabel(absPath: string, viewed: boolean, foreign: boolean): vscode.Uri {
  // A multi-diff row shows the file's own name, so anything a reviewer needs to
  // know about the row has to be in that name. `⇣` marks a change that arrived
  // with a HEAD move rather than from the agent — the diff cannot tell them apart,
  // and reading someone else's merge as the agent's work is the error worth a
  // character of width.
  const marks = `${viewed ? "✓ " : ""}${foreign ? "⇣ " : ""}`;
  if (marks === "") {
    return vscode.Uri.file(absPath);
  }
  return vscode.Uri.file(path.join(path.dirname(absPath), `${marks}${path.basename(absPath)}`));
}

/** How much of a file changed, for a tab title. The per-file toolbar a diff
 * editor would carry this in belongs to a proposed API, so the title is the one
 * place left that a reviewer reads without looking away from the change. */
async function counted(
  repo: Repo,
  from: string,
  to: string,
  file: ChangedFile,
): Promise<string> {
  const stat = (await repo.git.diffStat(from, to)).get(file.path);
  return stat === undefined ? "+0 −0" : `+${stat.added} −${stat.deleted}`;
}

/** Open one file's evolution as native diff rows: each selected snapshot that
 * touched the file contributes its own parent → sha transition, in order, so
 * scrolling the tab replays the file step by step with real diffs — word-level
 * highlights and comments included. Each row's header names its snapshot, and the
 * view opens as its own tab so closing it lands back on whatever was showing. */
export async function openStepHistory(
  repo: Repo,
  rel: string,
  snapshots: Snapshot[],
): Promise<void> {
  const abs = path.join(repo.root, rel);
  const steps: Snapshot[] = [];
  for (const snapshot of snapshots) {
    const files = await repo.git.changedFiles(snapshot.parent, snapshot.sha);
    if (files.some((f) => f.path === rel || f.oldPath === rel)) {
      steps.push(snapshot);
    }
  }
  if (steps.length === 0) {
    vscode.window.showInformationMessage(`Octoview: no selected snapshot touched ${rel}.`);
    return;
  }
  const latest = repo.store.latestSnapshot?.n;
  if (steps.length === 1) {
    // One step is one diff; the plain editor shows it at full height instead
    // of a single multi-diff row floating over empty space.
    const snapshot = steps[0];
    await vscode.commands.executeCommand(
      "vscode.diff",
      revisionUri(snapshot.parent, abs),
      snapshot.n === latest ? vscode.Uri.file(abs) : revisionUri(snapshot.sha, abs),
      `${path.basename(rel)}: snapshot ${snapshot.n}`,
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
  const resources = steps.map((snapshot) => [
    // The multi-diff row header renders this first URI, so its path names the
    // snapshot; pathOf recovers the real path from the fragment.
    vscode.Uri.from({
      scheme: SCHEME,
      path: path.join(
        path.dirname(abs),
        `s${snapshot.n} — ${snapshot.label.replaceAll("/", "∕")}`,
      ),
      query: snapshot.sha,
      fragment: abs,
    }),
    revisionUri(snapshot.parent, abs),
    snapshot.n === latest ? vscode.Uri.file(abs) : revisionUri(snapshot.sha, abs),
  ]);
  // Every row header already names the file's directory and its snapshot, so the tab
  // only has to say which file and how far it runs. VS Code appends its own
  // "(N files)" to a multi-diff title — here N is the step count, and there is no
  // way to suppress it — which is one more reason to keep the label short.
  await vscode.commands.executeCommand(
    "vscode.changes",
    `${path.basename(rel)}: s${steps[0].n}→s${steps[steps.length - 1].n}`,
    resources,
  );
}

/** Open snapshot N-1 → snapshot N for one file.
 *
 * For the newest snapshot the right-hand side is the real file on disk, so the
 * language server attaches and hovers, types, and go-to-definition work while
 * reading. Older snapshots diff two revisions and are read-only by nature. */
export async function openDiff(repo: Repo, node: FileNode): Promise<void> {
  const abs = path.join(repo.root, node.file.path);
  const isLatest = node.snapshot.n === repo.store.latestSnapshot?.n;
  const left = revisionUri(node.snapshot.parent, abs);
  const right = isLatest ? vscode.Uri.file(abs) : revisionUri(node.snapshot.sha, abs);
  const counts = await counted(repo, node.snapshot.parent, node.snapshot.sha, node.file);
  const title = isLatest
    ? `${repo.name}/${node.file.path} — snapshot ${node.snapshot.n} (working tree) · ${counts}`
    : `${repo.name}/${node.file.path} — snapshot ${node.snapshot.n - 1} → ` +
      `${node.snapshot.n} · ${counts}`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true,
  });
}
