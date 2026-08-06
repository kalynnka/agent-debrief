import * as path from "path";
import * as vscode from "vscode";

import { abandonedRepoUri, frozenSnapshotUri, snapshotFileUri } from "./decorations";
import { ChangedFile, Snapshot } from "./git";
import { GitWatch } from "./gitwatch";
import { Repo, Repos } from "./repos";
import {
  committableRun,
  foreignPaths,
  LandedCommit,
  landedCommits,
  LaneSweep,
  stashedSince,
  sweepLanes,
} from "./review";

export class RepoNode {
  readonly kind = "repo";
  constructor(
    readonly repo: Repo,
    /** Lanes of this clone whose branch is gone, found on the last refresh. The
     * row offers to let go of them only when there are some. */
    readonly abandoned: LaneSweep,
  ) {}

  get abandonedCount(): number {
    return this.abandoned.closed.length + this.abandoned.collected.length;
  }
}

/** Which of a snapshot's files a row stands for. A snapshot read only in part
 * sits in both areas at once — Source Control's own answer to a file that is half
 * staged — and each of its two rows shows, and acts on, only its own half. */
export type Part = "all" | "reviewed" | "unreviewed";

export class SnapshotNode {
  readonly kind = "snapshot";
  constructor(
    readonly repo: Repo,
    readonly snapshot: Snapshot,
    /** How many of the snapshot's files still differ from what it started from.
     * At zero it has been reverted away entirely and is frozen: the snapshot
     * still records what it did, but nothing on disk is its doing any more. */
    readonly live: number,
    /** No later snapshot has written over any file this one changed, so every one
     * of them can still be put back — which is what dropping it does. Where it
     * sits in the order does not matter: a dropped snapshot's commit stays
     * reachable as the git parent of the snapshot after it. */
    readonly droppable: boolean,
    /** How many of those files are marked reviewed at this snapshot. */
    readonly viewed: number,
    /** Every change this snapshot made has reached a commit — as it left it, or
     * as a later snapshot rewrote it. Judged on every path the snapshot touched,
     * so a later snapshot editing one of them cannot un-land it. */
    readonly landed: boolean,
    readonly part: Part = "all",
  ) {}

  /** Every file the snapshot still owns is marked reviewed at it — so the row
   * offers to unmark, and never both at once. A snapshot with nothing live left
   * counts as read: there is nothing there to read. */
  get reviewed(): boolean {
    return this.viewed === this.live;
  }

  /** The same snapshot as one of its halves. */
  showing(part: Part): SnapshotNode {
    return new SnapshotNode(
      this.repo,
      this.snapshot,
      this.live,
      this.droppable,
      this.viewed,
      this.landed,
      part,
    );
  }

  /** Whether one of the snapshot's files belongs on this row. */
  shows(file: string): boolean {
    return (
      this.part === "all" ||
      this.repo.store.isReviewed(file, this.snapshot.n) === (this.part === "reviewed")
    );
  }
}

export class FileNode {
  readonly kind = "file";
  constructor(
    readonly repo: Repo,
    readonly snapshot: Snapshot,
    readonly file: ChangedFile,
    readonly reviewed: boolean,
    readonly threadCount: number,
    /** This snapshot's version of the file is the one on disk, so reverting it
     * undoes this snapshot and nothing else. False once a later one has written
     * over it — revert that first, and this row becomes the top of the stack. */
    readonly revertable: boolean,
    /** The file has staged changes: taken, in the sense the commit will keep. */
    readonly staged: boolean,
    /** The file on disk is what HEAD holds — this change is committed, and the
     * snapshot's remaining work is whatever is not. */
    readonly landed: boolean,
    /** It arrived with a HEAD move under this snapshot — a pull, a merge, a reset —
     * and the snapshot still holds it exactly as that move left it. In the diff it
     * is indistinguishable from the agent's work, which is the whole reason to say
     * so on the row. */
    readonly foreign: boolean,
  ) {}
}

export type Area = "committed" | "reviewed" | "unreviewed";

/** One of a repository's areas, after Source Control's staged/unstaged pair —
 * with a third for work that has left the review entirely. Marking a snapshot
 * reviewed moves it between the first two; committing moves it out of both, so
 * the state is a position rather than an icon.
 *
 * The committed area holds commits rather than snapshots: a snapshot that has
 * landed is a fact about a commit, and reading it back that way is how a lane
 * committed in two batches stays two batches. */
export class GroupNode {
  readonly kind = "group";
  constructor(
    readonly repo: Repo,
    readonly area: Area,
    readonly snapshots: SnapshotNode[],
    readonly commits: CommitNode[],
    /** The last snapshot a commit could run through, and the reviewed snapshots
     * stranded after a gap. Both are meaningless outside the reviewed area, which
     * is the only one that can be committed from. */
    readonly through: number | undefined,
    readonly blocked: Set<number>,
  ) {}
}

/** A commit of this lane, over the snapshots it took. */
export class CommitNode {
  readonly kind = "commit";
  constructor(
    readonly repo: Repo,
    readonly sha: string,
    readonly message: string,
    readonly snapshots: SnapshotNode[],
  ) {}
}

export type Node = RepoNode | GroupNode | CommitNode | SnapshotNode | FileNode;

/** Agents whose own mark ships in `media/`, lifted from the vendor's own VS Code
 * extension. Claude's is brand-coloured and reads on either theme; Codex's is
 * monochrome, so it needs the pair. */
const AGENT_LOGOS: Record<string, { light: string; dark: string }> = {
  claude: { light: "agent-claude.svg", dark: "agent-claude.svg" },
  codex: { light: "agent-codex-light.svg", dark: "agent-codex-dark.svg" },
};

/** Agents with no logo to hand but a codicon that means something: Copilot is
 * the one agent the codicon set draws, and a snapshot you took yourself is a
 * person, not an agent. Anything else — including an agent this build has never
 * heard of — gets the sparkle, which is the point: unknown is still an agent. */
const AGENT_ICONS: Record<string, string> = {
  copilot: "copilot",
  manual: "edit",
};

/** Strike a label through, character by character.
 *
 * A tree item's label takes no formatting — `strikeThrough` exists in the API
 * only for Source Control resource states, not for tree items — so the overlay
 * has to be in the text itself. It is a real string and costs what that implies:
 * type-to-filter no longer matches the row, and anything reading it aloud reads
 * the marks too. */
function struckThrough(text: string): string {
  return [...text].map((character) => `${character}̶`).join("");
}

/** `snapshots 5–13`, `snapshots 2, 5–7`, `snapshot 9`. A commit no longer takes
 * an unbroken run — a reviewer who commits a staged subset lands part of the lane
 * and leaves the rest — so the numbers have to say where the gaps are. */
function spanOf(numbers: number[]): string {
  if (numbers.length === 0) {
    return "no snapshots";
  }
  const runs: string[] = [];
  let start = numbers[0];
  let end = start;
  for (const n of numbers.slice(1)) {
    if (n === end + 1) {
      end = n;
      continue;
    }
    runs.push(start === end ? `${start}` : `${start}–${end}`);
    start = n;
    end = n;
  }
  runs.push(start === end ? `${start}` : `${start}–${end}`);
  return `${numbers.length === 1 ? "snapshot" : "snapshots"} ${runs.join(", ")}`;
}

/** What a row covers: the one file of a file row, and of a snapshot row the files
 * it shows — every file of the snapshot, or one half of them when it is split
 * across the two areas. The review and revert commands act on a set, and this is
 * where the two scopes become the same set. */
export async function filesOf(node: FileNode | SnapshotNode): Promise<ChangedFile[]> {
  if (node.kind === "file") {
    return [node.file];
  }
  const files = await node.repo.git.changedFiles(node.snapshot.parent, node.snapshot.sha);
  return files.filter((file) => node.shows(file.path));
}

/** Repository → snapshot → file. A repo appears once it has snapshots and not
 * before — a workspace of several clones is mostly repos you are not reviewing,
 * and rows reading "no snapshots yet" are the noise this view exists to cut.
 * Snapshotting is unaffected: every repo in the workspace is still captured, and
 * shows up here the moment it has something to show. */
export class SnapshotsProvider implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** Selected snapshot numbers per repo root — the scope every "these snapshots" action
   * works on, and the tree's own selection is where it comes from.
   *
   * Numbers rather than the selected nodes: a refresh rebuilds every node from
   * `store.data`, so the objects the tree handed us are ones this provider has
   * already thrown away. A snapshot number outlives that. */
  private selected = new Map<string, Set<number>>();

  /** Repos whose stash has moved since their newest snapshot. A frozen row says
   * the snapshot's changes were reverted; when a stash did it, that reads as
   * "thrown away" for work that is safe, so the row has to say which it is.
   * Measured once per refresh in `getChildren`, because `getTreeItem` is sync. */
  private stashed = new Set<string>();

  constructor(
    private readonly repos: Repos,
    private readonly gitWatch: GitWatch,
    /** `media/`, where the agent logos live. */
    private readonly media: vscode.Uri,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** Take the tree's selection as the scope. A file row counts for its snapshot and a
   * repo row for all of its snapshots, so selecting a heading means what it looks
   * like it means. */
  setSelection(nodes: readonly Node[]): void {
    const next = new Map<string, Set<number>>();
    const add = (repo: Repo, n: number): void => {
      const set = next.get(repo.root) ?? new Set<number>();
      set.add(n);
      next.set(repo.root, set);
    };
    for (const node of nodes) {
      if (node.kind === "repo") {
        node.repo.store.data.snapshots.forEach((snapshot) => add(node.repo, snapshot.n));
      } else if (node.kind === "group") {
        node.snapshots.forEach((snapshot) => add(node.repo, snapshot.snapshot.n));
        node.commits.forEach((c) =>
          c.snapshots.forEach((snapshot) => add(node.repo, snapshot.snapshot.n)),
        );
      } else if (node.kind === "commit") {
        node.snapshots.forEach((snapshot) => add(node.repo, snapshot.snapshot.n));
      } else {
        add(node.repo, node.snapshot.n);
      }
    }
    this.selected = next;
  }

  /** The selected snapshots of a repo that still exist, in snapshot order — empty when
   * none of it is selected, which each caller answers for itself. Gaps are fine:
   * each snapshot's diff is self-contained (parent → sha), so a non-contiguous
   * selection reads as exactly those snapshots' history. */
  selectedSnapshots(repo: Repo): Snapshot[] {
    const set = this.selected.get(repo.root);
    if (set === undefined) {
      return [];
    }
    return repo.store.data.snapshots.filter((t) => set.has(t.n));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "repo") {
      const count = node.repo.store.data.snapshots.length;
      const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${node.repo.lane.name} · ${count} snapshot${count === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon("repo");
      item.contextValue = node.abandonedCount > 0 ? "repo-abandoned" : "repo";
      item.tooltip = node.repo.root;
      if (node.abandonedCount > 0) {
        // The count and the warning colour come from the decoration provider; a
        // TreeItem carries neither on its own.
        item.resourceUri = abandonedRepoUri(node.repo.root, node.abandonedCount);
        item.tooltip = new vscode.MarkdownString(
          `${node.repo.root}\n\n**${node.abandonedCount} lane(s) whose branch is gone.** ` +
            `Their snapshot refs are what keep those commits alive — until octoview lets ` +
            `go, \`git gc\` cannot collect them.`,
        );
      }
      // The whole lane at once: every snapshot's net change, the same diff the
      // header button gives for a selection.
      item.command = {
        command: "octoview.openSnapshot",
        title: "Open Snapshot Diff",
        arguments: [node],
      };
      return item;
    }

    if (node.kind === "group") {
      const committed = node.area === "committed";
      const count = committed ? node.commits.length : node.snapshots.length;
      const item = new vscode.TreeItem(
        committed ? "Commits" : node.area === "reviewed" ? "Reviewed" : "Unreviewed",
        // Committed work is history: it folds away, and the two areas that still
        // want reading stay open.
        committed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      const stranded = node.blocked.size;
      const unit = committed ? "commit" : "snapshot";
      item.description =
        `${count} ${unit}${count === 1 ? "" : "s"}` +
        (node.through !== undefined ? ` · through ${node.through}` : "") +
        (stranded > 0 ? ` · ${stranded} blocked` : "");
      item.iconPath = new vscode.ThemeIcon(
        committed ? "git-commit" : node.area === "reviewed" ? "code-review" : "git-pull-request",
      );
      item.contextValue = `group-${node.area}`;
      item.tooltip = new vscode.MarkdownString(
        committed
          ? `**Commits**\n\nThe snapshots each commit took. Read back from git rather ` +
            `than recorded, so amending or rebasing moves them.`
          : node.area === "reviewed"
            ? `**Reviewed**\n\nSnapshots you have read. A commit takes them from the ` +
              `earliest one onwards, so only an unbroken run can be landed` +
              (stranded > 0
                ? ` — ${stranded} of these sit after a snapshot you have not read yet.`
                : `.`)
            : `**Unreviewed**\n\nMark a snapshot reviewed to move it up. Marking only some ` +
              `of its files moves those, and the rest stay here.`,
      );
      if (!committed) {
        // The area's own net diff: everything you have approved, or everything
        // left to read, in one tab. The committed area spans commits, which have
        // no single diff between them.
        item.command = {
          command: "octoview.openSnapshot",
          title: "Open Snapshot Diff",
          arguments: [node],
        };
      }
      return item;
    }

    if (node.kind === "commit") {
      const [subject] = node.message.split("\n");
      const item = new vscode.TreeItem(subject, vscode.TreeItemCollapsibleState.Collapsed);
      const span = spanOf(node.snapshots.map((snapshot) => snapshot.snapshot.n));
      item.description = `${node.sha.slice(0, 7)} · ${span}`;
      item.iconPath = new vscode.ThemeIcon("git-commit");
      item.contextValue = "commit";
      // The subject is what a sidebar truncates first, so the hover carries the
      // whole message — body and all, which is where the reasoning usually is.
      const body = node.message.split("\n").slice(1).join("\n").trim();
      item.tooltip = new vscode.MarkdownString(
        `**${subject}**\n\n` +
          (body === "" ? "" : `${body}\n\n`) +
          `\`${node.sha.slice(0, 7)}\` · ${span}`,
      );
      item.command = {
        command: "octoview.openSnapshot",
        title: "Open Snapshot Diff",
        arguments: [node],
      };
      return item;
    }

    if (node.kind === "snapshot") {
      const frozen = node.live === 0;
      const newest = node.snapshot.n === node.repo.store.latestSnapshot?.n;
      // The number leads and the agent's summary follows it, because a label is
      // truncated from the end: what has to survive a narrow sidebar is which snapshot
      // this is. A long summary will still be cut off — a tree row is one line and
      // the sidebar is as wide as it is — so the hover carries it in full.
      const title = `${node.snapshot.n}. ${node.snapshot.label}`;
      const item = new vscode.TreeItem(
        frozen ? struckThrough(title) : title,
        frozen
          ? vscode.TreeItemCollapsibleState.None
          : newest
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
      );
      // An explicit identity, because the same snapshot is two rows once it is half
      // read — and because this is what decides whether VS Code treats a row as
      // new. A new row takes the collapsible state given above; an old one keeps
      // whatever the reviewer left it at. Being the newest snapshot is part of the
      // identity, so a snapshot opens itself when it arrives and folds away again
      // when the next one supersedes it.
      const age = newest ? "new" : "old";
      item.id = `${node.repo.root}|${node.part}|snapshot|${node.snapshot.n}|${age}`;
      const at = new Date(node.snapshot.at);
      const logo = AGENT_LOGOS[node.snapshot.agent];
      // Every snapshot keeps its agent's mark, reverted or not: the row still says
      // who wrote it, and one icon for every snapshot is what makes the column line
      // up. Being reverted is said by the decoration instead.
      item.iconPath =
        logo === undefined
          ? new vscode.ThemeIcon(AGENT_ICONS[node.snapshot.agent] ?? "sparkle")
          : {
              light: vscode.Uri.joinPath(this.media, logo.light),
              dark: vscode.Uri.joinPath(this.media, logo.dark),
            };
      // A whole snapshot gets no description: the sidebar is narrow and the label is
      // what gets truncated first, so everything else lives in the hover. A half
      // of one has to say which half it is, and how much of the snapshot that is.
      const shown = node.part === "reviewed" ? node.viewed : node.live - node.viewed;
      if (node.part !== "all") {
        item.description = `${shown} of ${node.live}`;
      }
      const hover = new vscode.MarkdownString(
        `**${title}**\n\n${node.snapshot.agent} · ${at.toLocaleString()}\n\n`,
      );
      item.tooltip = hover;
      // One state per row, so the reviewed and unreviewed actions are never both
      // offered. A frozen snapshot is neither: it holds its number rather than
      // disappearing, and has nothing left to review. A half row takes its state
      // from which half it is, so marking it acts on exactly the files it shows.
      //
      // Dropping is offered only on a whole snapshot, and only while every file it
      // touched can still be given back: reverting half a snapshot and then removing
      // the record of all of it would leave the other half with nothing to
      // undo it by.
      const state = frozen
        ? "frozen"
        : node.part !== "all"
          ? node.part
          : node.reviewed
            ? "reviewed"
            : "unreviewed";
      const droppable = node.droppable && node.part === "all";
      item.contextValue = `snapshot-${state}${droppable ? "-droppable" : ""}`;
      if (frozen) {
        // The grey comes from the decoration provider; the strike is in the label
        // itself. Neither is something a TreeItem can express on its own.
        item.resourceUri = frozenSnapshotUri(node.repo.root, node.snapshot.n);
        hover.appendMarkdown(
          this.stashed.has(node.repo.root)
            ? `Nothing of this snapshot is on disk — but the stash has moved since the ` +
                `last snapshot, so the likeliest reason is that it is **stashed**, not ` +
                `that it was undone. Pop the stash to bring it back. Dropping is ` +
                `refused while this is true.`
            : `Every change this snapshot made has been reverted, so there is nothing ` +
                `left of it on disk.\n\n` +
                (node.droppable
                  ? `Drop it to take it out of the history.`
                  : `A later snapshot has written over files it changed — drop that one ` +
                    `first.`),
        );
        return item;
      }
      hover.appendMarkdown(
        node.part === "all"
          ? `${node.live} file(s) still changed by this snapshot` +
              (node.reviewed ? `, all marked reviewed` : ``) +
              (node.landed ? `, all committed.` : `.`)
          : `${shown} of this snapshot's ${node.live} file(s), the ones you have ` +
              `${node.part === "reviewed" ? "read" : "not read yet"}. The rest are in ` +
              `${node.part === "reviewed" ? "Unreviewed" : "Reviewed"}.`,
      );
      if (node.snapshot.described === "transcript") {
        hover.appendMarkdown(
          `\n\nRecorded by the hook rather than described by the agent — this snapshot ` +
            `may have been cut off before it was finished.`,
        );
      }
      // A message runs to a page, and a hover clips it without scrolling: what a
      // reviewer sees is a paragraph cut off mid-sentence with no way to reach
      // the rest. So the hover carries its opening and a way in — the note opens
      // as a document, which scrolls, selects and copies like any other.
      //
      // (VS Code's own answer, `workbench.action.showHover` — ⌘K ⌘I — focuses a
      // hover and makes it scrollable. It works here, and it is not something to
      // make a reviewer know.)
      if (node.snapshot.message !== undefined) {
        const opening = node.snapshot.message
          .split(/\n{2,}/)
          .slice(1)
          .find((paragraph) => paragraph.trim() !== "");
        if (opening !== undefined) {
          hover.appendMarkdown(`\n\n---\n\n${opening}`);
        }
        // A command link needs the string trusted; the command it names is ours
        // and takes no input from the message.
        hover.isTrusted = true;
        const args = encodeURIComponent(JSON.stringify([node.repo.root, node.snapshot.n]));
        hover.appendMarkdown(`\n\n[Read the whole note](command:octoview.openNote?${args})`);
      }
      // Clicking the row reads the snapshot, and building a multi-snapshot scope does not:
      // VS Code runs a tree item's command only when the selection is a single
      // element, so a ctrl- or shift-click extends the scope silently and the
      // header's net diff is what opens it.
      item.command = {
        command: "octoview.openSnapshot",
        title: "Open Snapshot Diff",
        arguments: [node],
      };
      return item;
    }

    const abs = path.join(node.repo.root, node.file.path);
    const dir = path.dirname(node.file.path);
    const item = new vscode.TreeItem(path.basename(abs), vscode.TreeItemCollapsibleState.None);
    const notes = node.threadCount > 0 ? `  💬 ${node.threadCount}` : "";
    // The icon slot goes to the file-type icon, so "reviewed" has to say itself;
    // the letter stays in the text because the badge gives its slot up to the
    // problem count whenever there is one.
    const where = dir === "." ? "" : `  ${dir}`;
    // Committed and staged cannot both hold — staged means the index differs from
    // HEAD — so one word covers where the change has got to.
    const landing = node.landed ? " committed" : node.staged ? " staged" : "";
    // Louder than the landing mark and in front of it: whose change this is comes
    // before how far along it is.
    const origin = node.foreign ? "  ⇣ not the agent's" : "";
    const mark = node.reviewed ? "✓  " : "";
    item.description = `${mark}${node.file.status}${landing}${origin}${where}${notes}`;
    item.resourceUri = snapshotFileUri(abs, node.file.status);
    item.tooltip = node.foreign
      ? new vscode.MarkdownString(
          `${node.file.path} — ${node.file.status}${landing}\n\n**Not the agent's change.** ` +
            `It arrived when HEAD moved under this snapshot, and the snapshot holds it ` +
            `exactly as that move left it.`,
        )
      : `${node.file.path} — ${node.file.status}${landing}`;
    item.contextValue = `file-${node.reviewed ? "reviewed" : "unreviewed"}${
      node.revertable ? "-revertable" : ""
    }`;
    item.command = {
      command: "octoview.openDiff",
      title: "Open Diff",
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) {
      // The sweep is one `for-each-ref` plus a directory walk when nothing is
      // abandoned, which is the usual answer — cheap enough to ask every refresh
      // so the row can offer the cleanup exactly when there is one to offer.
      return Promise.all(
        this.repos.all
          .filter((repo) => repo.store.data.snapshots.length > 0)
          .map(
            async (repo) =>
              new RepoNode(repo, await sweepLanes(repo.git, repo.lane.commonDir, false)),
          ),
      );
    }
    if (node.kind === "repo") {
      // Three areas, and empty ones are hidden the way Source Control hides them.
      // The snapshots are measured once here and handed down, so opening an area or a
      // commit costs nothing.
      if (await stashedSince(node.repo.git, node.repo.store)) {
        this.stashed.add(node.repo.root);
      } else {
        this.stashed.delete(node.repo.root);
      }
      // Once, and handed down. Both this and `shapeOf` need to know what has
      // landed, and asking twice cost a second `git log` plus a second HEAD read
      // on every refresh — for an answer that cannot change between the two calls.
      const commits = await landedCommits(
        node.repo.git,
        node.repo.store.data.snapshots,
        await node.repo.git.head(),
      );
      const nodes = await this.shapeOf(node.repo, commits);
      const at = new Map(nodes.map((snapshot) => [snapshot.snapshot.n, snapshot]));
      const taken = new Set(commits.flatMap((commit) => commit.snapshots));
      // Only what a commit has not already taken can be committed: a landed snapshot
      // is out of the running, and the run starts again after it.
      const open = nodes.filter((snapshot) => !taken.has(snapshot.snapshot.n));
      const { through, blocked } = committableRun(
        open.map((snapshot) => ({ n: snapshot.snapshot.n, reviewed: snapshot.reviewed })),
      );
      const stranded = new Set(blocked);
      const areas: GroupNode[] = [
        new GroupNode(
          node.repo,
          "committed",
          [],
          commits.map(
            (commit) =>
              new CommitNode(
                node.repo,
                commit.sha,
                commit.message,
                commit.snapshots.flatMap((n) => at.get(n) ?? []),
              ),
          ),
          undefined,
          new Set(),
        ),
        // A snapshot read only in part sits in both areas at once, as one half each.
        // Marking a file is a move rather than a state, the way staging one is:
        // what you have read is in Reviewed, and what is left is where you left
        // it.
        new GroupNode(
          node.repo,
          "reviewed",
          open
            .filter((snapshot) => snapshot.viewed > 0 || snapshot.reviewed)
            .map((snapshot) => (snapshot.reviewed ? snapshot : snapshot.showing("reviewed"))),
          [],
          through,
          stranded,
        ),
        new GroupNode(
          node.repo,
          "unreviewed",
          open
            .filter((snapshot) => !snapshot.reviewed)
            .map((snapshot) => (snapshot.viewed === 0 ? snapshot : snapshot.showing("unreviewed"))),
          [],
          undefined,
          new Set(),
        ),
      ];
      return areas.filter((area) => area.snapshots.length + area.commits.length > 0);
    }
    if (node.kind === "group") {
      return node.area === "committed" ? node.commits : node.snapshots;
    }
    if (node.kind === "commit") {
      return node.snapshots;
    }
    if (node.kind === "file") {
      return [];
    }
    return this.filesOfSnapshot(node);
  }

  /** Every snapshot of a repo, measured. Whether a snapshot still has anything to show
   * has to be known before it is expanded — and before it can be put in an area —
   * so all of it happens here. The two commits either side of a snapshot never move,
   * so this is cached after the first pass and the lane costs one `hash-object`
   * and one `ls-tree` per refresh.
   *
   * Public because the commit action re-reads it rather than trusting the tree:
   * a `git restore` in a terminal can move what is reviewable between the row
   * being drawn and the button being pressed. */
  async shapeOf(repo: Repo, landedIn?: LandedCommit[]): Promise<SnapshotNode[]> {
    const snapshots = repo.store.data.snapshots;
    // Whether a snapshot still has anything to show has to be known before it is
    // expanded, so every snapshot is measured here. The two commits either side of
    // a snapshot never move, so all of this is cached after the first pass and the
    // lane costs one `hash-object` per refresh.
    const changed = await Promise.all(
      snapshots.map((snapshot) => repo.git.changedFiles(snapshot.parent, snapshot.sha)),
    );
    const disk = await repo.git.blobsOnDisk([
      ...new Set(changed.flat().map((file) => file.path)),
    ]);
    // Which snapshots a commit has taken. HEAD is resolved per refresh rather than
    // cached — it is the one revision in play that moves — and the rule lives
    // with the other snapshot semantics, because the CLI reports the same answer.
    // The tree has usually worked this out already and hands it down; the commit
    // action calls in without one, and re-reads deliberately.
    const commits = landedIn ?? (await landedCommits(repo.git, snapshots, await repo.git.head()));
    const landed = new Set(commits.flatMap((commit) => commit.snapshots));
    const shape = await Promise.all(
      changed.map(async (files, i) => {
        const paths = files.map((file) => file.path);
        const [before, after] = await Promise.all([
          repo.git.blobsAt(snapshots[i].parent, paths),
          repo.git.blobsAt(snapshots[i].sha, paths),
        ]);
        // A file is the snapshot's doing while disk differs from where it started,
        // and is still the snapshot's to give back while disk matches where it
        // ended. Neither means a later snapshot wrote over it, and until that snapshot
        // goes first this one cannot be put back.
        const live = paths.filter((file) => disk.get(file) !== before.get(file));
        const owned = live.filter((file) => disk.get(file) === after.get(file));
        return {
          live: live.length,
          droppable: owned.length === live.length,
          // Only the files the snapshot still owns: one it no longer changes is not
          // on the worklist, so it cannot be what leaves the snapshot unreviewed.
          viewed: live.filter((file) => repo.store.isReviewed(file, snapshots[i].n)).length,
          landed: landed.has(snapshots[i].n),
        };
      }),
    );
    return snapshots.map(
      (t, i) =>
        new SnapshotNode(
          repo,
          t,
          shape[i].live,
          shape[i].droppable,
          shape[i].viewed,
          shape[i].landed,
        ),
    );
  }

  private async filesOfSnapshot(node: SnapshotNode): Promise<FileNode[]> {
    const files = await node.repo.git.changedFiles(node.snapshot.parent, node.snapshot.sha);
    const paths = files.map((file) => file.path);
    const intact = await node.repo.git.unchangedSince(node.snapshot.sha, paths);
    // The mirror of `intact`: a file back at the snapshot's *starting* point has had
    // this snapshot's change undone, so there is nothing left to review and the row
    // goes. The snapshot still records the change — it remains a true statement
    // about what the snapshot did — but the worklist should not still be asking.
    const undone = await node.repo.git.unchangedSince(node.snapshot.parent, paths);
    const head = await node.repo.git.head();
    const landed =
      head === undefined ? new Set<string>() : await node.repo.git.unchangedSince(head, paths);
    const staged = this.gitWatch.stagedPaths(node.repo.root);
    const brought = await foreignPaths(
      node.repo.git,
      node.repo.store.data.snapshots,
      node.snapshot,
    );
    return files
      .filter((file) => !undone.has(file.path) && node.shows(file.path))
      .map(
        (file) =>
          new FileNode(
            node.repo,
            node.snapshot,
            file,
            node.repo.store.isReviewed(file.path, node.snapshot.n),
            node.repo.store.threadsFor(file.path).filter((t) => t.state === "draft").length,
            intact.has(file.path),
            staged.has(file.path),
            landed.has(file.path),
            brought.has(file.path),
          ),
      );
  }
}
