import * as vscode from "vscode";

import { Repo, Repos } from "./repos";
import { makeAnchor } from "./review";
import { Thread } from "./state";

export const SCHEME = "octoview";

/** Build the URI for a file's content at a snapshot revision.
 *
 * The path is absolute so the same repo lookup serves revisions and working-tree
 * files; a repo-relative path would be ambiguous once the workspace holds more
 * than one clone. */
export function revisionUri(sha: string, absPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: absPath, query: sha });
}

/** The absolute path a URI names, for both schemes we read.
 *
 * Step-history label URIs show a snapshot name as their path so the multi-diff row
 * header can display it; the real path rides in the fragment. */
export function pathOf(uri: vscode.Uri): string {
  if (uri.scheme === "file") {
    return uri.fsPath;
  }
  return uri.fragment !== "" ? uri.fragment : uri.path;
}

class Note implements vscode.Comment {
  constructor(
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public timestamp?: Date,
  ) {}
}

/** A widget currently on screen, with the repo whose store backs it. One
 * controller serves every repo, so the repo has to be carried rather than
 * recovered from the thread id — ids are only unique within a store. */
interface Live {
  widget: vscode.CommentThread;
  repo: Repo;
  id: string;
}

/** Owns the VS Code comment controller and keeps it in step with the stores.
 *
 * Threads anchor to a repo-relative path so a comment made against a snapshot
 * revision and one made against the working-tree file are the same anchor. */
export class Comments {
  private readonly controller: vscode.CommentController;
  private readonly live = new Map<string, Live>();

  constructor(private readonly repos: Repos) {
    this.controller = vscode.comments.createCommentController(SCHEME, "Octoview");
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (this.repos.locate(pathOf(document.uri)) === undefined) {
          return [];
        }
        return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
      },
    };
  }

  dispose(): void {
    this.controller.dispose();
  }

  private author(): vscode.CommentAuthorInformation {
    return {
      name: vscode.workspace.getConfiguration("octoview").get<string>("author", "reviewer"),
    };
  }

  private render(thread: Thread): vscode.Comment[] {
    return thread.comments.map(
      (c) =>
        new Note(new vscode.MarkdownString(c.body), vscode.CommentMode.Preview, {
          name: c.author,
        }, new Date(c.at)),
    );
  }

  private decorate(widget: vscode.CommentThread, thread: Thread): void {
    widget.comments = this.render(thread);
    const stage =
      thread.state === "draft" ? "Draft" : thread.state === "submitted" ? "Submitted" : "Resolved";
    const outdated = thread.outdated ? " · outdated" : "";
    widget.label = `${stage} · snapshot ${thread.snapshot}${outdated}`;
    widget.contextValue = thread.id;
    widget.canReply = thread.state === "draft";
    widget.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  private key(repo: Repo, id: string, uri: vscode.Uri): string {
    return `${repo.root}\0${id}\0${uri.toString()}`;
  }

  /** Draw stored threads onto whichever document is showing the file. */
  rehydrate(uri: vscode.Uri): void {
    const located = this.repos.locate(pathOf(uri));
    if (located === undefined) {
      return;
    }
    for (const thread of located.repo.store.threadsFor(located.rel)) {
      const key = this.key(located.repo, thread.id, uri);
      if (this.live.has(key)) {
        continue;
      }
      const widget = this.controller.createCommentThread(
        uri,
        new vscode.Range(thread.anchor.startLine, 0, thread.anchor.endLine, 0),
        [],
      );
      this.decorate(widget, thread);
      this.live.set(key, { widget, repo: located.repo, id: thread.id });
    }
  }

  /** Append to an existing thread, or open a new one when the widget is empty.
   * The store mutation runs under the lane lock — the Stop hook's CLI process
   * may be writing the same state.json. */
  async reply(reply: vscode.CommentReply): Promise<void> {
    const text = reply.text.trim();
    if (text.length === 0) {
      return;
    }
    const uri = reply.thread.uri;
    const located = this.repos.locate(pathOf(uri));
    if (located === undefined) {
      return;
    }
    const { repo, rel } = located;
    const note = {
      body: text,
      author: this.author().name ?? "reviewer",
      at: new Date().toISOString(),
    };
    const existingId = reply.thread.contextValue;

    // Anchor against the latest snapshot, from the document the reviewer is reading;
    // prepared before taking the lock so the lock is held only for the write.
    const start = reply.thread.range?.start.line ?? 0;
    const end = reply.thread.range?.end.line ?? start;
    const document = await vscode.workspace.openTextDocument(uri);
    const fresh: Thread = {
      id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`,
      anchor: await makeAnchor(
        repo.git,
        repo.store.latestSnapshot?.sha,
        rel,
        start,
        end,
        document.getText().split("\n"),
      ),
      snapshot: repo.store.latestSnapshot?.n ?? 0,
      state: "draft",
      outdated: false,
      comments: [],
    };

    const updated = await repo.store.withLock((state) => {
      const existing = state.threads.find((t) => t.id === existingId);
      if (existing !== undefined) {
        existing.comments.push(note);
        return existing;
      }
      fresh.comments.push(note);
      state.threads.push(fresh);
      return fresh;
    });
    this.decorate(reply.thread, updated);
    if (updated === fresh) {
      this.live.set(this.key(repo, fresh.id, uri), { widget: reply.thread, repo, id: fresh.id });
    }
  }

  async delete(widget: vscode.CommentThread): Promise<void> {
    const id = widget.contextValue;
    const located = this.repos.locate(pathOf(widget.uri));
    if (id !== undefined && located !== undefined) {
      await located.repo.store.withLock((state) => {
        state.threads = state.threads.filter((t) => t.id !== id);
      });
      for (const [key, live] of this.live) {
        if (live.id === id && live.repo === located.repo) {
          live.widget.dispose();
          this.live.delete(key);
        }
      }
    }
    widget.dispose();
  }

  /** Repaint every open widget — used after a submit flips threads to read-only
   * or an external writer (the hook) moved anchors under us. */
  refresh(): void {
    for (const [key, live] of this.live) {
      const thread = live.repo.store.data.threads.find((t) => t.id === live.id);
      if (thread === undefined) {
        live.widget.dispose();
        this.live.delete(key);
      } else {
        this.decorate(live.widget, thread);
      }
    }
  }
}
