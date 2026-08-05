import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { Comments, SCHEME } from "./comments";
import { TurnDecorations } from "./decorations";
import { RevisionContentProvider, openDiff, openStackedDiff, openStepHistory } from "./diff";
import { GitWatch, gitApi } from "./gitwatch";
import { Repos } from "./repos";
import { snapshotTurn } from "./review";
import { FileNode, TurnNode, TurnsProvider } from "./turns";

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repos = new Repos();
  await repos.discover(workspaceFolders());

  const gitWatch = new GitWatch(await gitApi());
  const turns = new TurnsProvider(repos, gitWatch);
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
  context.subscriptions.push(
    view,
    view.onDidChangeCheckboxState((event) => {
      // VS Code reports the box that was clicked and cascades a repo row onto the
      // turns it has already materialized; both are mirrored here so the model is
      // right even for a collapsed repo. A shift-selected range it does not know
      // about at all, so a toggle inside the selection carries the rest with it.
      const selected = view.selection.filter((n): n is TurnNode => n.kind === "turn");
      let beyondTheBox = false;
      for (const [node, state] of event.items) {
        const on = state === vscode.TreeItemCheckboxState.Checked;
        if (node.kind === "repo") {
          turns.setAllChecked(node.repo, on);
          beyondTheBox = true;
        } else if (node.kind === "turn") {
          turns.setChecked(node, on);
          if (selected.some((s) => s.repo === node.repo && s.turn.n === node.turn.n)) {
            selected.forEach((s) => turns.setChecked(s, on));
            beyondTheBox = true;
          }
        }
      }
      if (beyondTheBox) {
        turns.refresh();
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, revisions),
  );

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
    const checked = turns.checkedTurns(node.repo);
    await openStepHistory(
      node.repo,
      node.file.path,
      checked.length > 0 ? checked : node.repo.store.data.turns,
    );
  });

  register("octoview.openFile", async (node: FileNode) => {
    const uri = vscode.Uri.file(path.join(node.repo.root, node.file.path));
    await vscode.window.showTextDocument(uri, { preview: false });
  });

  // Only offered on the row whose version is the one on disk, so a revert always
  // undoes exactly one turn — the file lands on that turn's parent, which is the
  // previous turn's version, and that row becomes revertable in its place.
  register("octoview.revertTurn", async (node: FileNode) => {
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
    await node.repo.git.restoreFile(node.turn.parent, node.file.path);
    if (node.file.oldPath !== undefined) {
      await node.repo.git.restoreFile(node.turn.parent, node.file.oldPath);
    }
    turns.refresh();
  });

  register("octoview.stackedDiff", async () => {
    let opened = 0;
    for (const repo of repos.all) {
      const checked = turns.checkedTurns(repo);
      if (checked.length > 0) {
        await openStackedDiff(repo, checked);
        opened++;
      }
    }
    if (opened === 0) {
      vscode.window.showInformationMessage(
        "Octoview: check one or more turns first — the stacked history shows their flow.",
      );
    }
  });

  register("octoview.markReviewed", async (node: FileNode) => {
    await node.repo.store.withLock((state) => {
      state.reviewed[node.file.path] = node.turn.n;
    });
    turns.refresh();
  });

  register("octoview.markUnreviewed", async (node: FileNode) => {
    await node.repo.store.withLock((state) => {
      delete state.reviewed[node.file.path];
    });
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
