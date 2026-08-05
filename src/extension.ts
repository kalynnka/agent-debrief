import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { Comments, SCHEME, pathOf } from "./comments";
import { TurnDecorations } from "./decorations";
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
import { ChangedFile, Turn } from "./git";
import { GitWatch, gitApi } from "./gitwatch";
import { Repo, Repos } from "./repos";
import { committableRun, dropTurn, landedCommits, revertPaths, snapshotTurn } from "./review";
import {
  CommitNode,
  FileNode,
  GroupNode,
  RepoNode,
  TurnNode,
  TurnsProvider,
  filesOf,
} from "./turns";

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
  const turns = new TurnsProvider(
    repos,
    gitWatch,
    vscode.Uri.joinPath(context.extensionUri, "media"),
  );
  const comments = new Comments(repos);
  const revisions = new RevisionContentProvider(repos);
  const decorations = new TurnDecorations();
  context.subscriptions.push(
    comments,
    gitWatch,
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
  );

  const view = vscode.window.createTreeView("octoview.turns", {
    treeDataProvider: turns,
    canSelectMany: true,
  });

  /** The stacked diffs opened so far, by the title each was given, against the
   * turns it is a review of.
   *
   * There is no handle to a multi-diff editor to hold instead, and its scope has
   * to outlive the sidebar selection that produced it: a reviewer reading turns
   * 30→33 in one tab may well select turn 12 in the tree while doing it. VS Code
   * appends its own "(N files)" to the label, so the tab is matched by prefix. */
  const reviewTabs = new Map<string, { repo: Repo; turns: Turn[] }>();
  const activeReview = (): { repo: Repo; turns: Turn[] } | undefined => {
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


  const openReview = async (repo: Repo, scope: Turn[]): Promise<void> => {
    const title = await openStackedDiff(repo, scope, await rowsFor(repo, scope));
    if (title !== undefined) {
      reviewTabs.set(title, { repo, turns: scope });
    }
    await trackActiveDiff();
  };

  /** Redraw a review tab. The tick on each row header is part of the URI that row
   * was opened with, and a multi-diff's resources cannot be rewritten in place —
   * so the only way to move the ticks is to close the tab and open it again on
   * the same turns. */
  const reopenReview = async (review: { repo: Repo; turns: Turn[] }): Promise<void> => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    for (const [title, scope] of reviewTabs) {
      if (tab !== undefined && scope === review && tab.label.startsWith(title)) {
        reviewTabs.delete(title);
        await vscode.window.tabGroups.close(tab);
        break;
      }
    }
    await openReview(review.repo, review.turns);
  };

  /** Record the reviewer's mark on a set of files, or clear it. `at` is the turn
   * the mark is made against: a later turn touching the file makes it unreviewed
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

  /** Tick — or untick — a set of file rows. Each row is marked at the last turn
   * of the scope that touched it, so rows batch by that turn and the whole set
   * costs one lock per (repo, turn) rather than one per file. */
  const markRows = async (rows: FileRow[], viewed: boolean): Promise<void> => {
    const batches = new Map<string, { repo: Repo; at: number; paths: string[] }>();
    for (const row of rows) {
      const at = row.turns[row.turns.length - 1].n;
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
    view.onDidChangeSelection((event) => turns.setSelection(event.selection)),
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
              turns.refresh();
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
  // an edit moves what the rows describe — which file is staged, which turn's
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
        turns.refresh();
      })();
    }),
  );

  /** The octoview diff in the active tab: which file it shows, and the turn a
   * review mark on it belongs at. The right-hand side answers both — a snapshot
   * revision names its turn in the query, and the working tree means the newest
   * turn, which is the only turn whose diff ends on disk. */
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
      ? located.repo.store.data.turns.find((turn) => turn.sha === modified.query)?.n
      : located.repo.store.latestTurn?.n;
    return at === undefined ? undefined : { repo: located.repo, rel: located.rel, at };
  };

  /** Which title-bar buttons the active tab offers. A plain diff gets the tick
   * for its own file; a review tab gets the actions for everything it covers.
   *
   * A multi-diff's per-row toolbar is a proposed-API menu
   * (`contribMultiDiffEditorMenus`), so the tick cannot sit on each row inside
   * one — the tab-level actions here are what replaces it. */
  const trackActiveDiff = async (): Promise<void> => {
    const active = activeDiff();
    const review = activeReview();
    const rows = review === undefined ? [] : await rowsFor(review.repo, review.turns);
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
      rows.length > 0 && active === undefined,
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
      turns.refresh();
    }),
  );

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register("octoview.snapshot", async () => {
    const label = await vscode.window.showInputBox({
      prompt: "What did this turn do?",
      placeHolder: "e.g. added the review batch schema",
    });
    if (label === undefined) {
      return;
    }
    const taken: string[] = [];
    const unchanged: string[] = [];

    for (const repo of repos.all) {
      const result = await snapshotTurn(repo.git, repo.store, { label, agent: "manual" });
      if (!result.created) {
        // A repo the turn never touched gets no turn. Recording an empty one would
        // put its numbering out of step with the work it is supposed to describe.
        unchanged.push(repo.name);
        continue;
      }
      taken.push(`${repo.name} (${result.files.length})`);
    }

    turns.refresh();
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
    turns.refresh();
  });

  register("octoview.openDiff", async (node: FileNode) => {
    await openDiff(node.repo, node);
  });

  register("octoview.stepHistory", async (node: FileNode) => {
    const selected = turns.selectedTurns(node.repo);
    await openStepHistory(
      node.repo,
      node.file.path,
      selected.length > 0 ? selected : node.repo.store.data.turns,
    );
  });

  register("octoview.openFile", async (node: FileNode) => {
    const uri = vscode.Uri.file(path.join(node.repo.root, node.file.path));
    await vscode.window.showTextDocument(uri, { preview: false });
  });

  // A change can be given back only while no later turn has written over it, so
  // the stack unwinds one turn at a time. The rows already only offer what will
  // work; this runs the same check again because a tree that has not refreshed
  // since a terminal `git restore` would otherwise put back more than its turn.
  const revert = async (node: FileNode | TurnNode): Promise<void> => {
    const changed = await filesOf(node);
    const paths = changed.map((file) => file.path);
    const intact = await node.repo.git.unchangedSince(node.turn.sha, paths);
    // Already back at the turn's starting point — reverting it again is a no-op,
    // not an obstacle. Without this a turn whose files were each reverted one by
    // one could never be undone, and its empty row would be there for good.
    const undone = await node.repo.git.unchangedSince(node.turn.parent, paths);
    const blocked = changed.filter((file) => !intact.has(file.path) && !undone.has(file.path));
    if (blocked.length > 0) {
      vscode.window.showWarningMessage(
        `Octoview: a later turn wrote over ${blocked
          .map((file) => path.basename(file.path))
          .join(", ")} — revert that turn first.`,
      );
      return;
    }
    if (node.kind === "file") {
      const confirmed = await vscode.window.showWarningMessage(
        `Revert turn ${node.turn.n}'s change to ${path.basename(node.file.path)}?`,
        {
          modal: true,
          detail: "The file goes back to how it was before this turn. The index is untouched.",
        },
        "Revert",
      );
      if (confirmed === undefined) {
        return;
      }
      await node.repo.git.restoreFiles(node.turn.parent, changed);
      const { git, store } = node.repo;
      const moved = await revertPaths(git, store, node.turn.n, touched(changed));
      await reopenRevisionTabs(moved);
      turns.refresh();
      return;
    }
    const notes = node.repo.store.data.threads.filter(
      (thread) => thread.turn === node.turn.n,
    ).length;
    // A turn whose work is already reverted has nothing left to put back, so
    // saying files "go back" would be a lie: all that is left to do is forget it.
    const restoring = changed.filter((file) => !undone.has(file.path)).length;
    const comments = notes > 0 ? ` ${notes} comment(s) on it go with it.` : "";
    const detail =
      restoring === 0
        ? `Nothing on disk changes — this turn's work is already reverted. Only the ` +
          `turn itself goes.${comments}`
        : `Its ${restoring} file(s) go back to how they were before it, and the turn ` +
          `itself is removed.${comments} The index is untouched.`;
    const confirmed = await vscode.window.showWarningMessage(
      `${restoring === 0 ? "Drop" : "Undo"} turn ${node.turn.n} — ${node.turn.label}?`,
      { modal: true, detail },
      restoring === 0 ? "Drop Turn" : "Undo Turn",
    );
    if (confirmed === undefined) {
      return;
    }
    await node.repo.git.restoreFiles(node.turn.parent, changed);
    // Rewrite before dropping: the later turns have to stop carrying this turn's
    // content before its record goes, or the next snapshot would report putting
    // it back as the agent's own work.
    const moved = await revertPaths(node.repo.git, node.repo.store, node.turn.n, touched(changed));
    await reopenRevisionTabs(moved);
    await dropTurn(node.repo.git, node.repo.store, node.turn.n);
    turns.refresh();
  };
  register("octoview.revert", revert);
  // The same operation under its own name: on a turn that has already been
  // reverted away there is nothing to revert, only a dead entry to throw out —
  // and a bin says that where a discard arrow would not.
  register("octoview.dropTurn", revert);

  register("octoview.openTurn", async (node: RepoNode | GroupNode | CommitNode | TurnNode) => {
    const scope =
      node.kind === "turn"
        ? [node.turn]
        : node.kind === "repo"
          ? node.repo.store.data.turns
          : node.turns.map((turn) => turn.turn);
    await openReview(node.repo, scope);
  });

  // Commit the reviewed turns of one repository. A commit is a prefix of the
  // lane — turn 12's content sits on top of turn 11's — so only an unbroken run
  // from the earliest turn can be landed, and the tree is re-read here rather
  // than trusted: a `git restore` in a terminal moves what is reviewable between
  // the row being drawn and the button being pressed.
  register("octoview.commitReviewed", async (node: GroupNode) => {
    const { repo } = node;
    const nodes = await turns.shapeOf(repo);
    // Only what a commit has not already taken: the run restarts after the last
    // landed turn, or committing through 13 twice would look available forever.
    const taken = new Set(
      (await landedCommits(repo.git, repo.store.data.turns, await repo.git.head())).flatMap(
        (commit) => commit.turns,
      ),
    );
    const open = nodes.filter((turn) => !taken.has(turn.turn.n));
    const { through, blocked } = committableRun(
      open.map((turn) => ({ n: turn.turn.n, reviewed: turn.reviewed })),
    );
    if (through === undefined && blocked.length === 0) {
      vscode.window.showInformationMessage(
        `Octoview: nothing in ${repo.name} is marked reviewed yet.`,
      );
      return;
    }
    if (blocked.length > 0) {
      const gap = open.find((turn) => !turn.reviewed)?.turn;
      const detail =
        `Turn ${gap?.n} — ${gap?.label} — has not been reviewed, and turn ` +
        `${blocked.join(", ")} ${blocked.length === 1 ? "sits" : "sit"} after it. ` +
        `A commit takes the turns from the earliest one onwards, so it cannot ` +
        `reach past a turn you have not read.`;
      const answer = await vscode.window.showWarningMessage(
        `Octoview: turn ${gap?.n} is in the way.`,
        { modal: true, detail },
        ...(through === undefined ? [] : [`Commit Through Turn ${through}`]),
      );
      if (answer === undefined) {
        return;
      }
    }
    if (through === undefined) {
      return;
    }
    const turn = repo.store.data.turns.find((t) => t.n === through);
    if (turn === undefined) {
      throw new Error(`octoview: turn ${through} went away while committing`);
    }
    // A turn the agent never described is one the Stop hook answered for, which
    // is the shape an interrupted turn leaves behind — and what a commit takes
    // is that turn's snapshot exactly as it stands. Say so before it lands, not
    // after: the reviewer is the only one who can tell finished from cut off.
    if (turn.described === "transcript") {
      const answer = await vscode.window.showWarningMessage(
        `Octoview: turn ${through} was recorded by the hook, not described by the agent.`,
        {
          modal: true,
          detail:
            `Its message was scraped from the session rather than written for it, ` +
            `which is what an interrupted turn leaves behind. The commit takes ` +
            `turn ${through}'s snapshot exactly as it stands — including work that ` +
            `may have been half done when it was cut off.`,
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
        `Octoview: ${repo.name} has staged changes, and committing turn ` +
          `${through} would replace them. Commit or unstage them first.`,
      );
      return;
    }
    const first = open[0].turn.n;
    const message = await vscode.window.showInputBox({
      title: `Commit ${repo.name} turns ${first}–${through}`,
      prompt: `${open.filter((t) => t.turn.n <= through).length} turn(s) become one commit`,
      placeHolder: "what this batch of turns did",
    });
    if (message === undefined || message === "") {
      return;
    }
    const sha = await repo.git.commitSnapshot(turn.sha, message);
    turns.refresh();
    vscode.window.showInformationMessage(
      `Octoview: committed ${sha.slice(0, 8)} — ${repo.name} turns ${first}–${through}.`,
    );
  });

  register("octoview.stackedDiff", async () => {
    let opened = 0;
    for (const repo of repos.all) {
      const selected = turns.selectedTurns(repo);
      if (selected.length > 0) {
        await openReview(repo, selected);
        opened++;
      }
    }
    if (opened === 0) {
      vscode.window.showInformationMessage(
        "Octoview: select one or more turns first — the stacked history shows their flow.",
      );
    }
  });

  // The tick where GitHub puts it: on the file you are reading, not on a row in
  // a list somewhere else.
  const markHere = async (viewed: boolean): Promise<void> => {
    const active = activeDiff();
    if (active === undefined) {
      throw new Error("octoview: no snapshot diff is showing");
    }
    await mark(active.repo, [active.rel], viewed ? active.at : undefined);
    turns.refresh();
    await trackActiveDiff();
  };
  register("octoview.markViewedHere", () => markHere(true));
  register("octoview.markUnviewedHere", () => markHere(false));

  // The turn-level actions, on the review tab and scoped to the turns that tab
  // was opened for — not to whatever the tree happens to have selected now.
  const markReview = async (viewed: boolean): Promise<void> => {
    const review = activeReview();
    if (review === undefined) {
      throw new Error("octoview: no review tab is showing");
    }
    await markRows(await rowsFor(review.repo, review.turns), viewed);
    turns.refresh();
    await reopenReview(review);
  };
  register("octoview.markAllReviewed", () => markReview(true));
  register("octoview.markAllUnreviewed", () => markReview(false));

  register("octoview.markReviewed", async (node: FileNode | TurnNode) => {
    const changed = await filesOf(node);
    await mark(
      node.repo,
      changed.map((file) => file.path),
      node.turn.n,
    );
    turns.refresh();
  });

  register("octoview.markUnreviewed", async (node: FileNode | TurnNode) => {
    const changed = await filesOf(node);
    await mark(
      node.repo,
      changed.map((file) => file.path),
      undefined,
    );
    turns.refresh();
  });

  register("octoview.createThread", async (reply: vscode.CommentReply) => {
    await comments.reply(reply);
    turns.refresh();
  });

  register("octoview.replyThread", async (reply: vscode.CommentReply) => {
    await comments.reply(reply);
    turns.refresh();
  });

  register("octoview.deleteThread", async (thread: vscode.CommentThread) => {
    await comments.delete(thread);
    turns.refresh();
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
    turns.refresh();
    vscode.window.showInformationMessage(`Octoview: submitted · ${written.join(" · ")}`);
  });
}

export function deactivate(): void {}
