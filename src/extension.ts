import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { Comments, SCHEME, pathOf } from "./comments";
import { SnapshotDecorations } from "./decorations";
import {
  NOTE_SCHEME,
  NoteContentProvider,
  RevisionContentProvider,
  openDiff,
  openStackedDiff,
  openStepHistory,
  reopenRevisionTabs,
} from "./diff";
import { FileRow, rowsFor } from "./files";
import { ChangedFile, Snapshot } from "./git";
import { GitWatch, gitApi } from "./gitwatch";
import { Repo, Repos } from "./repos";
import { committableRun, dropSnapshot, landedCommits, revertPaths, takeSnapshot } from "./review";
import {
  CommitNode,
  FileNode,
  GroupNode,
  RepoNode,
  SnapshotNode,
  SnapshotsProvider,
  filesOf,
} from "./snapshots";

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/** Every path a set of changes occupies. A rename holds two, and putting it back
 * has to account for both of them. */
function touched(files: ChangedFile[]): string[] {
  return files.flatMap((file) =>
    file.oldPath === undefined ? [file.path] : [file.path, file.oldPath],
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repos = new Repos();
  await repos.discover(workspaceFolders());

  const gitWatch = new GitWatch(await gitApi());
  const snapshots = new SnapshotsProvider(
    repos,
    gitWatch,
    vscode.Uri.joinPath(context.extensionUri, "media"),
  );
  const comments = new Comments(repos);
  const revisions = new RevisionContentProvider(repos);
  const decorations = new SnapshotDecorations();
  context.subscriptions.push(
    comments,
    gitWatch,
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
  );

  const view = vscode.window.createTreeView("octoview.snapshots", {
    treeDataProvider: snapshots,
    canSelectMany: true,
  });

  /** The stacked diffs opened so far, by the title each was given, against the
   * snapshots it is a review of.
   *
   * There is no handle to a multi-diff editor to hold instead, and its scope has
   * to outlive the sidebar selection that produced it: a reviewer reading snapshots
   * 30→33 in one tab may well select snapshot 12 in the tree while doing it. VS Code
   * appends its own "(N files)" to the label, so the tab is matched by prefix. */
  const reviewTabs = new Map<string, { repo: Repo; snapshots: Snapshot[] }>();
  const activeReview = (): { repo: Repo; snapshots: Snapshot[] } | undefined => {
    const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
    if (label === undefined) {
      return undefined;
    }
    for (const [title, scope] of reviewTabs) {
      if (label.startsWith(title)) {
        return scope;
      }
    }
    return undefined;
  };


  const openReview = async (repo: Repo, scope: Snapshot[]): Promise<void> => {
    const title = await openStackedDiff(repo, scope, await rowsFor(repo, scope));
    if (title !== undefined) {
      reviewTabs.set(title, { repo, snapshots: scope });
    }
    await trackActiveDiff();
  };

  /** Redraw a review tab. The tick on each row header is part of the URI that row
   * was opened with, and a multi-diff's resources cannot be rewritten in place —
   * so the only way to move the ticks is to close the tab and open it again on
   * the same snapshots. */
  const reopenReview = async (review: { repo: Repo; snapshots: Snapshot[] }): Promise<void> => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    for (const [title, scope] of reviewTabs) {
      if (tab !== undefined && scope === review && tab.label.startsWith(title)) {
        reviewTabs.delete(title);
        await vscode.window.tabGroups.close(tab);
        break;
      }
    }
    await openReview(review.repo, review.snapshots);
  };

  /** Record the reviewer's mark on a set of files, or clear it. `at` is the snapshot
   * the mark is made against: a later snapshot touching the file makes it unreviewed
   * again on its own, which is the whole rule. */
  const mark = async (repo: Repo, paths: string[], at: number | undefined): Promise<void> => {
    await repo.store.withLock((state) => {
      for (const file of paths) {
        if (at === undefined) {
          delete state.reviewed[file];
        } else {
          state.reviewed[file] = at;
        }
      }
    });
  };

  /** Tick — or untick — a set of file rows. Each row is marked at the last snapshot
   * of the scope that touched it, so rows batch by that snapshot and the whole set
   * costs one lock per (repo, snapshot) rather than one per file. */
  const markRows = async (rows: FileRow[], viewed: boolean): Promise<void> => {
    const batches = new Map<string, { repo: Repo; at: number; paths: string[] }>();
    for (const row of rows) {
      const at = row.snapshots[row.snapshots.length - 1].n;
      const batch = batches.get(`${row.repo.root}:${at}`) ?? { repo: row.repo, at, paths: [] };
      batch.paths.push(row.file.path);
      batches.set(`${row.repo.root}:${at}`, batch);
    }
    for (const batch of batches.values()) {
      await mark(batch.repo, batch.paths, viewed ? batch.at : undefined);
    }
  };

  context.subscriptions.push(
    view,
    // Selection is the whole scoping mechanism now that the checkboxes are gone.
    // Nothing is redrawn on it: a refresh here would throw away the rows the
    // reviewer is in the middle of clicking, and every action reads the
    // selection when it runs rather than following it.
    view.onDidChangeSelection((event) => snapshots.setSelection(event.selection)),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, revisions),
    vscode.workspace.registerTextDocumentContentProvider(
      NOTE_SCHEME,
      new NoteContentProvider(repos),
    ),
  );
  // Tabs are restored before we activate, so any diff left open at shutdown came
  // back with nothing serving its scheme. Now that the provider is registered,
  // open them again so they resolve instead of sitting empty.
  await reopenRevisionTabs(new Map());

  // How the view learns that a snapshot landed without a click: a watch on each
  // lane's state directory — a file watch, not a service (PRD §12.2). The Stop
  // hook writes state.json from its own process; this is the only signal.
  const watchers: fs.FSWatcher[] = [];
  let reloadTimer: NodeJS.Timeout | undefined;
  const rewatch = (): void => {
    for (const watcher of watchers.splice(0)) {
      watcher.close();
    }
    for (const repo of repos.all) {
      fs.mkdirSync(repo.store.dir, { recursive: true });
      watchers.push(
        fs.watch(repo.store.dir, () => {
          if (reloadTimer !== undefined) {
            clearTimeout(reloadTimer);
          }
          reloadTimer = setTimeout(() => {
            void (async () => {
              await Promise.all(repos.all.map((r) => r.store.load()));
              comments.refresh();
              snapshots.refresh();
            })();
          }, 200);
        }),
      );
    }
  };
  rewatch();
  context.subscriptions.push({
    dispose: () => {
      for (const watcher of watchers) {
        watcher.close();
      }
      if (reloadTimer !== undefined) {
        clearTimeout(reloadTimer);
      }
    },
  });

  // The other half of the review loop happens in a terminal. A `git restore` or
  // an edit moves what the rows describe — which file is staged, which snapshot's
  // version is still the one that a revert would undo — and a `git checkout` or
  // `gh pr checkout` moves the lane itself, which is a different review entirely.
  context.subscriptions.push(
    gitWatch.onDidChange((checkoutMoved) => {
      void (async () => {
        if (checkoutMoved) {
          await repos.discover(workspaceFolders());
          rewatch();
          comments.refresh();
        }
        snapshots.refresh();
      })();
    }),
  );

  /** The octoview diff in the active tab: which file it shows, and the snapshot a
   * review mark on it belongs at. The right-hand side answers both — a snapshot
   * revision names its snapshot in the query, and the working tree means the newest
   * snapshot, which is the only snapshot whose diff ends on disk. */
  const activeDiff = (): { repo: Repo; rel: string; at: number } | undefined => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!(tab?.input instanceof vscode.TabInputTextDiff)) {
      return undefined;
    }
    const { original, modified } = tab.input;
    if (original.scheme !== SCHEME && modified.scheme !== SCHEME) {
      return undefined;
    }
    const revision = modified.scheme === SCHEME;
    const located = repos.locate(revision ? pathOf(modified) : modified.fsPath);
    if (located === undefined) {
      return undefined;
    }
    const at = revision
      ? located.repo.store.data.snapshots.find((snapshot) => snapshot.sha === modified.query)?.n
      : located.repo.store.latestSnapshot?.n;
    return at === undefined ? undefined : { repo: located.repo, rel: located.rel, at };
  };

  /** The row of a review tab the cursor is in. A multi-diff's rows are ordinary
   * editors, so the active one names the file; which snapshot the mark belongs at
   * is that row's own last snapshot, the same answer `markRows` gives.
   *
   * Either side of the row resolves — the mark's snapshot comes from the row, not
   * from the revision the cursor happens to be on. */
  const activeRow = async (): Promise<{ repo: Repo; rel: string; at: number } | undefined> => {
    const review = activeReview();
    const editor = vscode.window.activeTextEditor;
    if (review === undefined || editor === undefined) {
      return undefined;
    }
    const uri = editor.document.uri;
    const located = repos.locate(uri.scheme === SCHEME ? pathOf(uri) : uri.fsPath);
    if (located === undefined || located.repo !== review.repo) {
      return undefined;
    }
    const row = (await rowsFor(review.repo, review.snapshots)).find(
      (r) => r.file.path === located.rel || r.file.oldPath === located.rel,
    );
    return row === undefined
      ? undefined
      : {
          repo: review.repo,
          rel: row.file.path,
          at: row.snapshots[row.snapshots.length - 1].n,
        };
  };

  /** Which title-bar buttons the active tab offers. A plain diff gets the tick
   * for its own file; a review tab gets the actions for everything it covers, and
   * the tick for whichever row the cursor is in.
   *
   * A multi-diff's per-row toolbar is a proposed-API menu
   * (`contribMultiDiffEditorMenus`), so the tick cannot sit on the row itself —
   * the tab-level tick, following the focused row, is what replaces it. */
  const trackActiveDiff = async (): Promise<void> => {
    const active = activeDiff() ?? (await activeRow());
    const review = activeReview();
    const rows = review === undefined ? [] : await rowsFor(review.repo, review.snapshots);
    await vscode.commands.executeCommand("setContext", "octoview.inDiff", active !== undefined);
    await vscode.commands.executeCommand(
      "setContext",
      "octoview.diffViewed",
      active !== undefined && active.repo.store.isReviewed(active.rel, active.at),
    );
    // A one-file review opens as a plain diff, which already carries the tick for
    // that file. Offering "mark all" beside it would be the same button twice.
    await vscode.commands.executeCommand(
      "setContext",
      "octoview.inReview",
      rows.length > 0 && activeDiff() === undefined,
    );
    await vscode.commands.executeCommand(
      "setContext",
      "octoview.reviewAllViewed",
      rows.length > 0 && rows.every((row) => row.reviewed),
    );
  };
  void trackActiveDiff();
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => void trackActiveDiff()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => void trackActiveDiff()),
    // Moving between rows never changes the tab, so the tick would otherwise
    // still be describing the row you left.
    vscode.window.onDidChangeActiveTextEditor(() => void trackActiveDiff()),
  );

  const paint = (editor: vscode.TextEditor | undefined): void => {
    if (editor !== undefined) {
      comments.rehydrate(editor.document.uri);
    }
  };
  vscode.window.visibleTextEditors.forEach(paint);
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(paint)),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await repos.discover(workspaceFolders());
      rewatch();
      snapshots.refresh();
    }),
  );

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register("octoview.snapshot", async () => {
    const label = await vscode.window.showInputBox({
      prompt: "What did this snapshot do?",
      placeHolder: "e.g. added the review batch schema",
    });
    if (label === undefined) {
      return;
    }
    const taken: string[] = [];
    const unchanged: string[] = [];

    for (const repo of repos.all) {
      const result = await takeSnapshot(repo.git, repo.store, { label, agent: "manual" });
      if (!result.created) {
        // A repo the work never touched gets no snapshot. Recording an empty one
        // would put its numbering out of step with the work it describes.
        unchanged.push(repo.name);
        continue;
      }
      taken.push(`${repo.name} (${result.files.length})`);
    }

    snapshots.refresh();
    vscode.window.showInformationMessage(
      taken.length === 0
        ? `Octoview: nothing changed in ${unchanged.length} repo(s).`
        : `Octoview: snapshotted ${taken.join(", ")}` +
            (unchanged.length > 0 ? ` · unchanged: ${unchanged.join(", ")}` : ""),
    );
  });

  register("octoview.refresh", async () => {
    await repos.discover(workspaceFolders());
    rewatch();
    comments.refresh();
    snapshots.refresh();
  });

  register("octoview.openDiff", async (node: FileNode) => {
    await openDiff(node.repo, node);
  });

  register("octoview.stepHistory", async (node: FileNode) => {
    const selected = snapshots.selectedSnapshots(node.repo);
    await openStepHistory(
      node.repo,
      node.file.path,
      selected.length > 0 ? selected : node.repo.store.data.snapshots,
    );
  });

  register("octoview.openFile", async (node: FileNode) => {
    const uri = vscode.Uri.file(path.join(node.repo.root, node.file.path));
    await vscode.window.showTextDocument(uri, { preview: false });
  });

  // A change can be given back only while no later snapshot has written over it, so
  // the stack unwinds one snapshot at a time. The rows already only offer what will
  // work; this runs the same check again because a tree that has not refreshed
  // since a terminal `git restore` would otherwise put back more than its snapshot.
  const revert = async (node: FileNode | SnapshotNode): Promise<void> => {
    const changed = await filesOf(node);
    const paths = changed.map((file) => file.path);
    const intact = await node.repo.git.unchangedSince(node.snapshot.sha, paths);
    // Already back at the snapshot's starting point — reverting it again is a no-op,
    // not an obstacle. Without this a snapshot whose files were each reverted one by
    // one could never be undone, and its empty row would be there for good.
    const undone = await node.repo.git.unchangedSince(node.snapshot.parent, paths);
    const blocked = changed.filter((file) => !intact.has(file.path) && !undone.has(file.path));
    if (blocked.length > 0) {
      vscode.window.showWarningMessage(
        `Octoview: a later snapshot wrote over ${blocked
          .map((file) => path.basename(file.path))
          .join(", ")} — revert that snapshot first.`,
      );
      return;
    }
    if (node.kind === "file") {
      const confirmed = await vscode.window.showWarningMessage(
        `Revert snapshot ${node.snapshot.n}'s change to ${path.basename(node.file.path)}?`,
        {
          modal: true,
          detail: "The file goes back to how it was before this snapshot. The index is untouched.",
        },
        "Revert",
      );
      if (confirmed === undefined) {
        return;
      }
      await node.repo.git.restoreFiles(node.snapshot.parent, changed);
      const { git, store } = node.repo;
      const moved = await revertPaths(git, store, node.snapshot.n, touched(changed));
      await reopenRevisionTabs(moved);
      snapshots.refresh();
      return;
    }
    const notes = node.repo.store.data.threads.filter(
      (thread) => thread.snapshot === node.snapshot.n,
    ).length;
    // A snapshot whose work is already reverted has nothing left to put back, so
    // saying files "go back" would be a lie: all that is left to do is forget it.
    const restoring = changed.filter((file) => !undone.has(file.path)).length;
    const comments = notes > 0 ? ` ${notes} comment(s) on it go with it.` : "";
    const detail =
      restoring === 0
        ? `Nothing on disk changes — this snapshot's work is already reverted. Only the ` +
          `snapshot itself goes.${comments}`
        : `Its ${restoring} file(s) go back to how they were before it, and the snapshot ` +
          `itself is removed.${comments} The index is untouched.`;
    const confirmed = await vscode.window.showWarningMessage(
      `${restoring === 0 ? "Drop" : "Undo"} snapshot ${node.snapshot.n} — ` +
        `${node.snapshot.label}?`,
      { modal: true, detail },
      restoring === 0 ? "Drop Snapshot" : "Undo Snapshot",
    );
    if (confirmed === undefined) {
      return;
    }
    await node.repo.git.restoreFiles(node.snapshot.parent, changed);
    // Rewrite before dropping: the later snapshots have to stop carrying this
    // one's content before its record goes, or the next snapshot would report
    // putting it back as the agent's own work.
    const reverting = touched(changed);
    const moved = await revertPaths(node.repo.git, node.repo.store, node.snapshot.n, reverting);
    await reopenRevisionTabs(moved);
    await dropSnapshot(node.repo.git, node.repo.store, node.snapshot.n);
    snapshots.refresh();
  };
  register("octoview.revert", revert);
  // The same operation under its own name: on a snapshot that has already been
  // reverted away there is nothing to revert, only a dead entry to throw out —
  // and a bin says that where a discard arrow would not.
  register("octoview.dropSnapshot", revert);

  type OpenTarget = RepoNode | GroupNode | CommitNode | SnapshotNode;
  register("octoview.openSnapshot", async (node: OpenTarget) => {
    const scope =
      node.kind === "snapshot"
        ? [node.snapshot]
        : node.kind === "repo"
          ? node.repo.store.data.snapshots
          : node.snapshots.map((snapshot) => snapshot.snapshot);
    await openReview(node.repo, scope);
  });

  // Commit the reviewed snapshots of one repository. A commit is a prefix of the
  // lane — snapshot 12's content sits on top of snapshot 11's — so only an unbroken run
  // from the earliest snapshot can be landed, and the tree is re-read here rather
  // than trusted: a `git restore` in a terminal moves what is reviewable between
  // the row being drawn and the button being pressed.
  register("octoview.commitReviewed", async (node: GroupNode) => {
    const { repo } = node;
    const nodes = await snapshots.shapeOf(repo);
    // Only what a commit has not already taken: the run restarts after the last
    // landed snapshot, or committing through 13 twice would look available forever.
    const taken = new Set(
      (await landedCommits(repo.git, repo.store.data.snapshots, await repo.git.head())).flatMap(
        (commit) => commit.snapshots,
      ),
    );
    const open = nodes.filter((snapshot) => !taken.has(snapshot.snapshot.n));
    const { through, blocked } = committableRun(
      open.map((snapshot) => ({ n: snapshot.snapshot.n, reviewed: snapshot.reviewed })),
    );
    if (through === undefined && blocked.length === 0) {
      vscode.window.showInformationMessage(
        `Octoview: nothing in ${repo.name} is marked reviewed yet.`,
      );
      return;
    }
    if (blocked.length > 0) {
      const gap = open.find((snapshot) => !snapshot.reviewed)?.snapshot;
      const detail =
        `Snapshot ${gap?.n} — ${gap?.label} — has not been reviewed, and snapshot ` +
        `${blocked.join(", ")} ${blocked.length === 1 ? "sits" : "sit"} after it. ` +
        `A commit takes the snapshots from the earliest one onwards, so it cannot ` +
        `reach past a snapshot you have not read.`;
      const answer = await vscode.window.showWarningMessage(
        `Octoview: snapshot ${gap?.n} is in the way.`,
        { modal: true, detail },
        ...(through === undefined ? [] : [`Commit Through Snapshot ${through}`]),
      );
      if (answer === undefined) {
        return;
      }
    }
    if (through === undefined) {
      return;
    }
    const snapshot = repo.store.data.snapshots.find((t) => t.n === through);
    if (snapshot === undefined) {
      throw new Error(`octoview: snapshot ${through} went away while committing`);
    }
    // A snapshot the agent never described is one the Stop hook answered for,
    // which is the shape an interrupted turn leaves behind — and what a commit
    // takes is that snapshot exactly as it stands. Say so before it lands, not
    // after: the reviewer is the only one who can tell finished from cut off.
    if (snapshot.described === "transcript") {
      const answer = await vscode.window.showWarningMessage(
        `Octoview: snapshot ${through} was recorded by the hook, not described by the agent.`,
        {
          modal: true,
          detail:
            `Its message was scraped from the session rather than written for it, ` +
            `which is what an interrupted turn leaves behind. The commit takes ` +
            `snapshot ${through} exactly as it stands — including work that may ` +
            `have been half done when it was cut off.`,
        },
        "Commit Anyway",
      );
      if (answer === undefined) {
        return;
      }
    }
    // The snapshot is loaded into the index to be committed, and the staged set
    // is the reviewer's own progress marker. Refuse rather than replace it.
    if (await repo.git.staged()) {
      vscode.window.showWarningMessage(
        `Octoview: ${repo.name} has staged changes, and committing snapshot ` +
          `${through} would replace them. Commit or unstage them first.`,
      );
      return;
    }
    const first = open[0].snapshot.n;
    const message = await vscode.window.showInputBox({
      title: `Commit ${repo.name} snapshots ${first}–${through}`,
      prompt: `${open.filter((t) => t.snapshot.n <= through).length} snapshot(s) become one commit`,
      placeHolder: "what this batch of snapshots did",
    });
    if (message === undefined || message === "") {
      return;
    }
    const sha = await repo.git.commitSnapshot(snapshot.sha, message);
    snapshots.refresh();
    vscode.window.showInformationMessage(
      `Octoview: committed ${sha.slice(0, 8)} — ${repo.name} snapshots ${first}–${through}.`,
    );
  });

  register("octoview.stackedDiff", async () => {
    let opened = 0;
    for (const repo of repos.all) {
      const selected = snapshots.selectedSnapshots(repo);
      if (selected.length > 0) {
        await openReview(repo, selected);
        opened++;
      }
    }
    if (opened === 0) {
      vscode.window.showInformationMessage(
        "Octoview: select one or more snapshots first — the stacked history shows their flow.",
      );
    }
  });

  // The tick where GitHub puts it: on the file you are reading, not on a row in
  // a list somewhere else.
  const markHere = async (viewed: boolean): Promise<void> => {
    const active = activeDiff() ?? (await activeRow());
    if (active === undefined) {
      throw new Error("octoview: no snapshot diff is showing");
    }
    await mark(active.repo, [active.rel], viewed ? active.at : undefined);
    snapshots.refresh();
    await trackActiveDiff();
  };
  register("octoview.markViewedHere", () => markHere(true));
  register("octoview.markUnviewedHere", () => markHere(false));

  // The snapshot-level actions, on the review tab and scoped to the snapshots that tab
  // was opened for — not to whatever the tree happens to have selected now.
  const markReview = async (viewed: boolean): Promise<void> => {
    const review = activeReview();
    if (review === undefined) {
      throw new Error("octoview: no review tab is showing");
    }
    await markRows(await rowsFor(review.repo, review.snapshots), viewed);
    snapshots.refresh();
    await reopenReview(review);
  };
  register("octoview.markAllReviewed", () => markReview(true));
  register("octoview.markAllUnreviewed", () => markReview(false));

  register("octoview.markReviewed", async (node: FileNode | SnapshotNode) => {
    const changed = await filesOf(node);
    await mark(
      node.repo,
      changed.map((file) => file.path),
      node.snapshot.n,
    );
    snapshots.refresh();
  });

  register("octoview.markUnreviewed", async (node: FileNode | SnapshotNode) => {
    const changed = await filesOf(node);
    await mark(
      node.repo,
      changed.map((file) => file.path),
      undefined,
    );
    snapshots.refresh();
  });

  register("octoview.createThread", async (reply: vscode.CommentReply) => {
    await comments.reply(reply);
    snapshots.refresh();
  });

  register("octoview.replyThread", async (reply: vscode.CommentReply) => {
    await comments.reply(reply);
    snapshots.refresh();
  });

  register("octoview.deleteThread", async (thread: vscode.CommentThread) => {
    await comments.delete(thread);
    snapshots.refresh();
  });

  register("octoview.submit", async () => {
    const written: string[] = [];
    for (const repo of repos.all) {
      const result = await repo.store.submit();
      if (result !== undefined) {
        written.push(`${repo.name}: ${result.count} → ${result.path}`);
      }
    }
    if (written.length === 0) {
      vscode.window.showInformationMessage("Octoview: no draft comments to submit.");
      return;
    }
    comments.refresh();
    snapshots.refresh();
    vscode.window.showInformationMessage(`Octoview: submitted · ${written.join(" · ")}`);
  });
}

export function deactivate(): void {}
