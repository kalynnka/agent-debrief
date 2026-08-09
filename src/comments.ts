import * as vscode from "vscode";

import { Repo, Repos } from "./repos";
import { anchorForward, resolveThreads } from "./review";
import { Thread } from "./state";

export const SCHEME = "debrief";

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

  constructor(
    private readonly repos: Repos,
    /** Which snapshot's diff a document is being read as. Only the extension can
     * answer it — the question is about which tab the document is open in — so it
     * arrives as a function rather than being worked out here. */
    private readonly reviewedAt: (uri: vscode.Uri, repo: Repo) => number | undefined,
  ) {
    this.controller = vscode.comments.createCommentController(SCHEME, "Debrief");
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

  /** Who a comment is from.
   *
   * Git already knows, and it is the name every other record of this work carries,
   * so it is the default rather than something to configure. `debrief.author` is
   * there for the case git's answer is wrong for a review — a shared machine, a
   * work identity on a personal clone — and only then. */
  private async author(repo: Repo): Promise<vscode.CommentAuthorInformation> {
    const configured = vscode.workspace.getConfiguration("debrief").get<string>("author", "");
    return { name: configured !== "" ? configured : ((await repo.git.userName()) ?? "reviewer") };
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
    // "Draft" would say the agent cannot see this yet, and it can — a comment is
    // open from the moment it is written. What a Submit still changes is the
    // record it writes, and that the thread stops taking replies.
    const stage =
      thread.state === "draft" ? "Open" : thread.state === "submitted" ? "Submitted" : "Resolved";
    const outdated = thread.outdated ? " · outdated" : "";
    widget.label = `${stage} · snapshot ${thread.snapshot}${outdated}`;
    widget.contextValue = thread.id;
    widget.canReply = thread.state === "draft";
    // Every drawn thread is one still waiting — `placement` keeps the resolved out
    // — so there is no folded case to mark. The unresolved state is set anyway,
    // for the dot VS Code puts beside a live thread.
    widget.state = vscode.CommentThreadState.Unresolved;
    widget.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  private key(repo: Repo, id: string, uri: vscode.Uri): string {
    return `${repo.root}\0${id}\0${uri.toString()}`;
  }

  /** The one document a thread is drawn on, and where on it.
   *
   * One, not two: a thread with two homes is a comment the Comments panel lists
   * twice, which is the same complaint as being drawn on every revision, only
   * quieter. Which home is decided by whether the lines survived.
   *
   * While they exist it is the file on disk, at `anchor` — `carryForward` keeps
   * that true, and the file is the copy you go and edit. Once they are gone the
   * file has no honest position left, so the thread falls back to the diff it was
   * written against, at `origin`, where its lines are what they always were and
   * always will be. That is where an outdated comment is actually readable, and
   * GitHub keeps them off the current file for the same reason.
   *
   * A thread from before `origin` was recorded has only the file.
   *
   * A resolved one has nowhere at all. It has been answered, and on a lane where
   * the snapshots and the file move this fast it would be a widget over lines that
   * have since become someone else's — the record stays in `state.json`, and
   * `review open` is the thing that says what is still waiting. */
  private placement(thread: Thread, uri: vscode.Uri): vscode.Range | undefined {
    if (thread.state === "resolved") {
      return undefined;
    }
    const origin = thread.origin;
    if (thread.outdated && origin !== undefined) {
      return uri.scheme === SCHEME && uri.query === origin.rev
        ? new vscode.Range(origin.startLine, 0, origin.endLine, 0)
        : undefined;
    }
    return uri.scheme === "file"
      ? new vscode.Range(thread.anchor.startLine, 0, thread.anchor.endLine, 0)
      : undefined;
  }

  /** Draw stored threads onto a document that has a home for them. */
  rehydrate(uri: vscode.Uri): void {
    const located = this.repos.locate(pathOf(uri));
    if (located === undefined) {
      return;
    }
    for (const thread of located.repo.store.threadsFor(located.rel)) {
      const key = this.key(located.repo, thread.id, uri);
      const range = this.placement(thread, uri);
      if (this.live.has(key) || range === undefined) {
        continue;
      }
      const widget = this.controller.createCommentThread(uri, range, []);
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
      author: (await this.author(repo)).name ?? "reviewer",
      at: new Date().toISOString(),
    };
    const existingId = reply.thread.contextValue;

    // Two questions, two answers: the *revision* is what the document holds, since
    // those are the lines being anchored, and the *snapshot* is the diff it belongs
    // to — not the same thing on a left-hand side. The anchor then travels to the
    // newest snapshot, where every other anchor already is. Prepared before the
    // lock, so the lock is held only for the write.
    const start = reply.thread.range?.start.line ?? 0;
    const end = reply.thread.range?.end.line ?? start;
    const document = await vscode.workspace.openTextDocument(uri);
    const latest = repo.store.latestSnapshot;
    const { anchor, outdated } = await anchorForward(
      repo.git,
      rel,
      start,
      end,
      document.getText().split("\n"),
      uri.scheme === SCHEME ? uri.query : latest?.sha,
      latest?.sha,
    );
    const rev = uri.scheme === SCHEME ? uri.query : latest?.sha;
    const fresh: Thread = {
      id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`,
      anchor,
      // Kept beside the anchor, not instead of it: this is the diff row the
      // reviewer was looking at, which no amount of relocation should move.
      origin: rev === undefined ? undefined : { rev, startLine: start, endLine: end },
      snapshot: this.reviewedAt(uri, repo) ?? latest?.n ?? 0,
      state: "draft",
      outdated,
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

  /** Let go of the widgets on a revision document that has closed. Reopening the
   * diff draws them again from `origin`, so nothing is lost — and without this the
   * Comments panel keeps listing a tab that is no longer there. The file on disk
   * keeps its own: closing that tab is not the reviewer saying they are done. */
  forget(uri: vscode.Uri): void {
    if (uri.scheme === "file") {
      return;
    }
    const closed = uri.toString();
    for (const [key, live] of this.live) {
      if (live.widget.uri.toString() === closed) {
        live.widget.dispose();
        this.live.delete(key);
      }
    }
  }

  /** Close a thread from its title bar: the reviewer saying the answer will do.
   *
   * The button is theirs and only theirs. An agent can close one too, from the
   * CLI, but only when told to — otherwise the thing that decides a comment is
   * dealt with would be the thing that answered it. `refresh` then takes the
   * widget off the file, since a resolved thread is drawn nowhere. */
  async resolve(widget: vscode.CommentThread): Promise<void> {
    const id = widget.contextValue;
    const located = this.repos.locate(pathOf(widget.uri));
    if (id === undefined || located === undefined) {
      return;
    }
    await resolveThreads(located.repo.store, [id]);
    this.refresh();
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
   * or an external writer (the hook) moved anchors under us.
   *
   * A thread that has been resolved since the last pass goes, the same as one that
   * has been deleted: this is where an agent answering a review in a terminal takes
   * its comments off the file, without the reviewer having to close anything. */
  refresh(): void {
    for (const [key, live] of this.live) {
      const thread = live.repo.store.data.threads.find((t) => t.id === live.id);
      if (thread === undefined || thread.state === "resolved") {
        live.widget.dispose();
        this.live.delete(key);
      } else {
        this.decorate(live.widget, thread);
      }
    }
  }
}
