import * as path from "path";
import * as vscode from "vscode";

import { frozenTurnUri, turnFileUri } from "./decorations";
import { ChangedFile, Turn } from "./git";
import { GitWatch } from "./gitwatch";
import { Repo, Repos } from "./repos";
import { committableRun, landedCommits } from "./review";

export class RepoNode {
  readonly kind = "repo";
  constructor(readonly repo: Repo) {}
}

/** Which of a turn's files a row stands for. A turn read only in part sits in
 * both areas at once — Source Control's own answer to a file that is half
 * staged — and each of its two rows shows, and acts on, only its own half. */
export type Part = "all" | "reviewed" | "unreviewed";

export class TurnNode {
  readonly kind = "turn";
  constructor(
    readonly repo: Repo,
    readonly turn: Turn,
    /** How many of the turn's files still differ from what it started from. At
     * zero the turn has been reverted away entirely and is frozen: its snapshot
     * still records what it did, but nothing on disk is its doing any more. */
    readonly live: number,
    /** No later turn has written over any file this one changed, so every one of
     * them can still be put back — which is what dropping the turn does. Where
     * it sits in the order does not matter: a dropped turn's commit stays
     * reachable as the git parent of the turn after it. */
    readonly droppable: boolean,
    /** How many of those files are marked reviewed at this turn. */
    readonly viewed: number,
    /** Nothing uncommitted is this turn's doing: every file it still owns is on
     * disk exactly as HEAD holds it. Judged on the files it *owns* rather than on
     * everything it touched, so a later turn editing one of them again cannot
     * un-land a turn whose own work is already in a commit. */
    readonly landed: boolean,
    readonly part: Part = "all",
  ) {}

  /** Every file the turn still owns is marked reviewed at it — so the row offers
   * to unmark, and never both at once. A turn with nothing live left counts as
   * read: there is nothing there to read. */
  get reviewed(): boolean {
    return this.viewed === this.live;
  }

  /** The same turn as one of its halves. */
  showing(part: Part): TurnNode {
    return new TurnNode(
      this.repo,
      this.turn,
      this.live,
      this.droppable,
      this.viewed,
      this.landed,
      part,
    );
  }

  /** Whether one of the turn's files belongs on this row. */
  shows(file: string): boolean {
    return (
      this.part === "all" ||
      this.repo.store.isReviewed(file, this.turn.n) === (this.part === "reviewed")
    );
  }
}

export class FileNode {
  readonly kind = "file";
  constructor(
    readonly repo: Repo,
    readonly turn: Turn,
    readonly file: ChangedFile,
    readonly reviewed: boolean,
    readonly threadCount: number,
    /** This turn's version of the file is the one on disk, so reverting it undoes
     * this turn and nothing else. False once a later turn has written over it —
     * revert that one first, and this row becomes the top of the stack. */
    readonly revertable: boolean,
    /** The file has staged changes: taken, in the sense the commit will keep. */
    readonly staged: boolean,
    /** The file on disk is what HEAD holds — this change is committed, and the
     * turn's remaining work is whatever is not. */
    readonly landed: boolean,
  ) {}
}

export type Area = "committed" | "reviewed" | "unreviewed";

/** One of a repository's areas, after Source Control's staged/unstaged pair —
 * with a third for work that has left the review entirely. Marking a turn
 * reviewed moves it between the first two; committing moves it out of both, so
 * the state is a position rather than an icon.
 *
 * The committed area holds commits rather than turns: a turn that has landed is
 * a fact about a commit, and reading it back that way is how a lane committed in
 * two batches stays two batches. */
export class GroupNode {
  readonly kind = "group";
  constructor(
    readonly repo: Repo,
    readonly area: Area,
    readonly turns: TurnNode[],
    readonly commits: CommitNode[],
    /** The last turn a commit could run through, and the reviewed turns stranded
     * after a gap. Both are meaningless outside the reviewed area, which is the
     * only one that can be committed from. */
    readonly through: number | undefined,
    readonly blocked: Set<number>,
  ) {}
}

/** A commit of this lane, over the turns it took. */
export class CommitNode {
  readonly kind = "commit";
  constructor(
    readonly repo: Repo,
    readonly sha: string,
    readonly message: string,
    readonly turns: TurnNode[],
  ) {}
}

export type Node = RepoNode | GroupNode | CommitNode | TurnNode | FileNode;

/** Agents whose own mark ships in `media/`, lifted from the vendor's own VS Code
 * extension. Claude's is brand-coloured and reads on either theme; Codex's is
 * monochrome, so it needs the pair. */
const AGENT_LOGOS: Record<string, { light: string; dark: string }> = {
  claude: { light: "agent-claude.svg", dark: "agent-claude.svg" },
  codex: { light: "agent-codex-light.svg", dark: "agent-codex-dark.svg" },
};

/** Agents with no logo to hand but a codicon that means something: Copilot is
 * the one agent the codicon set draws, and a turn you snapshotted yourself is a
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

/** What a row covers: the one file of a file row, and of a turn row the files it
 * shows — every file of the turn, or one half of them when the turn is split
 * across the two areas. The review and revert commands act on a set, and this is
 * where the two scopes become the same set. */
export async function filesOf(node: FileNode | TurnNode): Promise<ChangedFile[]> {
  if (node.kind === "file") {
    return [node.file];
  }
  const files = await node.repo.git.changedFiles(node.turn.parent, node.turn.sha);
  return files.filter((file) => node.shows(file.path));
}

/** Repository → turn → file. A repo appears once it has turns and not before —
 * a workspace of several clones is mostly repos you are not reviewing, and rows
 * reading "no turns yet" are the noise this view exists to cut. Snapshotting is
 * unaffected: every repo in the workspace is still captured, and shows up here
 * the moment it has something to show. */
export class TurnsProvider implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** Selected turn numbers per repo root — the scope every "these turns" action
   * works on, and the tree's own selection is where it comes from.
   *
   * Numbers rather than the selected nodes: a refresh rebuilds every node from
   * `store.data`, so the objects the tree handed us are ones this provider has
   * already thrown away. A turn number outlives that. */
  private selected = new Map<string, Set<number>>();

  constructor(
    private readonly repos: Repos,
    private readonly gitWatch: GitWatch,
    /** `media/`, where the agent logos live. */
    private readonly media: vscode.Uri,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** Take the tree's selection as the scope. A file row counts for its turn and a
   * repo row for all of its turns, so selecting a heading means what it looks
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
        node.repo.store.data.turns.forEach((turn) => add(node.repo, turn.n));
      } else if (node.kind === "group") {
        node.turns.forEach((turn) => add(node.repo, turn.turn.n));
        node.commits.forEach((c) => c.turns.forEach((turn) => add(node.repo, turn.turn.n)));
      } else if (node.kind === "commit") {
        node.turns.forEach((turn) => add(node.repo, turn.turn.n));
      } else {
        add(node.repo, node.turn.n);
      }
    }
    this.selected = next;
  }

  /** The selected turns of a repo that still exist, in turn order — empty when
   * none of it is selected, which each caller answers for itself. Gaps are fine:
   * each turn's diff is self-contained (parent → sha), so a non-contiguous
   * selection reads as exactly those turns' history. */
  selectedTurns(repo: Repo): Turn[] {
    const set = this.selected.get(repo.root);
    if (set === undefined) {
      return [];
    }
    return repo.store.data.turns.filter((t) => set.has(t.n));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "repo") {
      const count = node.repo.store.data.turns.length;
      const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${node.repo.lane.name} · ${count} turn${count === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon("repo");
      item.contextValue = "repo";
      item.tooltip = node.repo.root;
      // The whole lane at once: every turn's net change, the same diff the
      // header button gives for a selection.
      item.command = {
        command: "octoview.openTurn",
        title: "Open Turn Diff",
        arguments: [node],
      };
      return item;
    }

    if (node.kind === "group") {
      const committed = node.area === "committed";
      const count = committed ? node.commits.length : node.turns.length;
      const item = new vscode.TreeItem(
        committed ? "Commits" : node.area === "reviewed" ? "Reviewed" : "Unreviewed",
        // Committed work is history: it folds away, and the two areas that still
        // want reading stay open.
        committed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      const stranded = node.blocked.size;
      const unit = committed ? "commit" : "turn";
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
          ? `**Commits**\n\nThe turns each commit took. Read back from git rather ` +
            `than recorded, so amending or rebasing moves them.`
          : node.area === "reviewed"
            ? `**Reviewed**\n\nTurns you have read. A commit takes them from the ` +
              `earliest one onwards, so only an unbroken run can be landed` +
              (stranded > 0
                ? ` — ${stranded} of these sit after a turn you have not read yet.`
                : `.`)
            : `**Unreviewed**\n\nMark a turn reviewed to move it up. Marking only some ` +
              `of its files moves those, and the rest stay here.`,
      );
      if (!committed) {
        // The area's own net diff: everything you have approved, or everything
        // left to read, in one tab. The committed area spans commits, which have
        // no single diff between them.
        item.command = { command: "octoview.openTurn", title: "Open Turn Diff", arguments: [node] };
      }
      return item;
    }

    if (node.kind === "commit") {
      const [subject] = node.message.split("\n");
      const item = new vscode.TreeItem(subject, vscode.TreeItemCollapsibleState.Collapsed);
      const first = node.turns[0]?.turn.n;
      const last = node.turns[node.turns.length - 1]?.turn.n;
      const span = first === last ? `turn ${first}` : `turns ${first}–${last}`;
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
      item.command = { command: "octoview.openTurn", title: "Open Turn Diff", arguments: [node] };
      return item;
    }

    if (node.kind === "turn") {
      const frozen = node.live === 0;
      const newest = node.turn.n === node.repo.store.latestTurn?.n;
      // The number leads and the agent's summary follows it, because a label is
      // truncated from the end: what has to survive a narrow sidebar is which turn
      // this is. A long summary will still be cut off — a tree row is one line and
      // the sidebar is as wide as it is — so the hover carries it in full.
      const title = `${node.turn.n}. ${node.turn.label}`;
      const item = new vscode.TreeItem(
        frozen ? struckThrough(title) : title,
        frozen
          ? vscode.TreeItemCollapsibleState.None
          : newest
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
      );
      // An explicit identity, because the same turn is two rows once it is half
      // read — and because this is what decides whether VS Code treats a row as
      // new. A new row takes the collapsible state given above; an old one keeps
      // whatever the reviewer left it at. Being the newest turn is part of the
      // identity, so a turn opens itself when it arrives and folds away again
      // when the next one supersedes it.
      item.id = `${node.repo.root}|${node.part}|turn|${node.turn.n}|${newest ? "new" : "old"}`;
      const at = new Date(node.turn.at);
      const logo = AGENT_LOGOS[node.turn.agent];
      // Every turn keeps its agent's mark, reverted or not: the row still says
      // who wrote it, and one icon for every turn is what makes the column line
      // up. Being reverted is said by the decoration instead.
      item.iconPath =
        logo === undefined
          ? new vscode.ThemeIcon(AGENT_ICONS[node.turn.agent] ?? "sparkle")
          : {
              light: vscode.Uri.joinPath(this.media, logo.light),
              dark: vscode.Uri.joinPath(this.media, logo.dark),
            };
      // A whole turn gets no description: the sidebar is narrow and the label is
      // what gets truncated first, so everything else lives in the hover. A half
      // of one has to say which half it is, and how much of the turn that is.
      const shown = node.part === "reviewed" ? node.viewed : node.live - node.viewed;
      if (node.part !== "all") {
        item.description = `${shown} of ${node.live}`;
      }
      const hover = new vscode.MarkdownString(
        `**${title}**\n\n${node.turn.agent} · ${at.toLocaleString()}\n\n`,
      );
      item.tooltip = hover;
      // One state per row, so the reviewed and unreviewed actions are never both
      // offered. A frozen turn is neither: it holds its number rather than
      // disappearing, and has nothing left to review. A half row takes its state
      // from which half it is, so marking it acts on exactly the files it shows.
      //
      // Dropping is offered only on a whole turn, and only while every file it
      // touched can still be given back: reverting half a turn and then removing
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
      item.contextValue = `turn-${state}${droppable ? "-droppable" : ""}`;
      if (frozen) {
        // The grey comes from the decoration provider; the strike is in the label
        // itself. Neither is something a TreeItem can express on its own.
        item.resourceUri = frozenTurnUri(node.repo.root, node.turn.n);
        hover.appendMarkdown(
          `Every change this turn made has been reverted, so there is nothing ` +
            `left of it on disk.\n\n` +
            (node.droppable
              ? `Drop it to take it out of the history.`
              : `A later turn has written over files it changed — drop that one ` +
                `first.`),
        );
        return item;
      }
      hover.appendMarkdown(
        node.part === "all"
          ? `${node.live} file(s) still changed by this turn` +
              (node.reviewed ? `, all marked reviewed` : ``) +
              (node.landed ? `, all committed.` : `.`)
          : `${shown} of this turn's ${node.live} file(s), the ones you have ` +
              `${node.part === "reviewed" ? "read" : "not read yet"}. The rest are in ` +
              `${node.part === "reviewed" ? "Unreviewed" : "Reviewed"}.`,
      );
      if (node.turn.message !== undefined) {
        hover.appendMarkdown(`\n\n---\n\n${node.turn.message}`);
      }
      // Clicking the row reads the turn, and building a multi-turn scope does not:
      // VS Code runs a tree item's command only when the selection is a single
      // element, so a ctrl- or shift-click extends the scope silently and the
      // header's net diff is what opens it.
      item.command = {
        command: "octoview.openTurn",
        title: "Open Turn Diff",
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
    const mark = node.reviewed ? "✓  " : "";
    item.description = `${mark}${node.file.status}${landing}${where}${notes}`;
    item.resourceUri = turnFileUri(abs, node.file.status);
    item.tooltip = `${node.file.path} — ${node.file.status}${landing}`;
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
      return this.repos.all
        .filter((repo) => repo.store.data.turns.length > 0)
        .map((repo) => new RepoNode(repo));
    }
    if (node.kind === "repo") {
      // Three areas, and empty ones are hidden the way Source Control hides them.
      // The turns are measured once here and handed down, so opening an area or a
      // commit costs nothing.
      const nodes = await this.shapeOf(node.repo);
      const at = new Map(nodes.map((turn) => [turn.turn.n, turn]));
      const commits = await landedCommits(
        node.repo.git,
        node.repo.store.data.turns,
        await node.repo.git.head(),
      );
      const taken = new Set(commits.flatMap((commit) => commit.turns));
      // Only what a commit has not already taken can be committed: a landed turn
      // is out of the running, and the run starts again after it.
      const open = nodes.filter((turn) => !taken.has(turn.turn.n));
      const { through, blocked } = committableRun(
        open.map((turn) => ({ n: turn.turn.n, reviewed: turn.reviewed })),
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
                commit.turns.flatMap((n) => at.get(n) ?? []),
              ),
          ),
          undefined,
          new Set(),
        ),
        // A turn read only in part sits in both areas at once, as one half each.
        // Marking a file is a move rather than a state, the way staging one is:
        // what you have read is in Reviewed, and what is left is where you left
        // it.
        new GroupNode(
          node.repo,
          "reviewed",
          open
            .filter((turn) => turn.viewed > 0 || turn.reviewed)
            .map((turn) => (turn.reviewed ? turn : turn.showing("reviewed"))),
          [],
          through,
          stranded,
        ),
        new GroupNode(
          node.repo,
          "unreviewed",
          open
            .filter((turn) => !turn.reviewed)
            .map((turn) => (turn.viewed === 0 ? turn : turn.showing("unreviewed"))),
          [],
          undefined,
          new Set(),
        ),
      ];
      return areas.filter((area) => area.turns.length + area.commits.length > 0);
    }
    if (node.kind === "group") {
      return node.area === "committed" ? node.commits : node.turns;
    }
    if (node.kind === "commit") {
      return node.turns;
    }
    if (node.kind === "file") {
      return [];
    }
    return this.filesOfTurn(node);
  }

  /** Every turn of a repo, measured. Whether a turn still has anything to show
   * has to be known before it is expanded — and before it can be put in an area —
   * so all of it happens here. The two commits either side of a turn never move,
   * so this is cached after the first pass and the lane costs one `hash-object`
   * and one `ls-tree` per refresh.
   *
   * Public because the commit action re-reads it rather than trusting the tree:
   * a `git restore` in a terminal can move what is reviewable between the row
   * being drawn and the button being pressed. */
  async shapeOf(repo: Repo): Promise<TurnNode[]> {
    const turns = repo.store.data.turns;
    // Whether a turn still has anything to show has to be known before it is
    // expanded, so every turn is measured here. The two commits either side of
    // a turn never move, so all of this is cached after the first pass and the
    // lane costs one `hash-object` per refresh.
    const changed = await Promise.all(
      turns.map((turn) => repo.git.changedFiles(turn.parent, turn.sha)),
    );
    const disk = await repo.git.blobsOnDisk([
      ...new Set(changed.flat().map((file) => file.path)),
    ]);
    // Which turns a commit has taken. HEAD is resolved per refresh rather than
    // cached — it is the one revision in play that moves — and the rule lives
    // with the other turn semantics, because the CLI reports the same answer.
    const commits = await landedCommits(repo.git, turns, await repo.git.head());
    const landed = new Set(commits.flatMap((commit) => commit.turns));
    const shape = await Promise.all(
      changed.map(async (files, i) => {
        const paths = files.map((file) => file.path);
        const [before, after] = await Promise.all([
          repo.git.blobsAt(turns[i].parent, paths),
          repo.git.blobsAt(turns[i].sha, paths),
        ]);
        // A file is the turn's doing while disk differs from where it started,
        // and is still the turn's to give back while disk matches where it
        // ended. Neither means a later turn wrote over it, and until that turn
        // goes first this one cannot be put back.
        const live = paths.filter((file) => disk.get(file) !== before.get(file));
        const owned = live.filter((file) => disk.get(file) === after.get(file));
        return {
          live: live.length,
          droppable: owned.length === live.length,
          // Only the files the turn still owns: one it no longer changes is not
          // on the worklist, so it cannot be what leaves the turn unreviewed.
          viewed: live.filter((file) => repo.store.isReviewed(file, turns[i].n)).length,
          landed: landed.has(turns[i].n),
        };
      }),
    );
    return turns.map(
      (t, i) =>
        new TurnNode(repo, t, shape[i].live, shape[i].droppable, shape[i].viewed, shape[i].landed),
    );
  }

  private async filesOfTurn(node: TurnNode): Promise<FileNode[]> {
    const files = await node.repo.git.changedFiles(node.turn.parent, node.turn.sha);
    const paths = files.map((file) => file.path);
    const intact = await node.repo.git.unchangedSince(node.turn.sha, paths);
    // The mirror of `intact`: a file back at the turn's *starting* point has had
    // this turn's change undone, so there is nothing left to review and the row
    // goes. The snapshot still records the change — it remains a true statement
    // about what the turn did — but the worklist should not still be asking.
    const undone = await node.repo.git.unchangedSince(node.turn.parent, paths);
    const head = await node.repo.git.head();
    const landed =
      head === undefined ? new Set<string>() : await node.repo.git.unchangedSince(head, paths);
    const staged = this.gitWatch.stagedPaths(node.repo.root);
    return files
      .filter((file) => !undone.has(file.path) && node.shows(file.path))
      .map(
        (file) =>
          new FileNode(
            node.repo,
            node.turn,
            file,
            node.repo.store.isReviewed(file.path, node.turn.n),
            node.repo.store.threadsFor(file.path).filter((t) => t.state === "draft").length,
            intact.has(file.path),
            staged.has(file.path),
            landed.has(file.path),
          ),
      );
  }
}
