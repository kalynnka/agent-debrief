import * as path from "path";

import { Git } from "./git";
import { Lane, resolveLane } from "./lanes";
import { adoptLane } from "./review";
import { Store } from "./state";

/** One repository under review — more precisely, one *lane* of one repository:
 * the checked-out branch of the worktree a workspace folder resolves to. Its
 * snapshot plumbing and review state live under the clone's common dir. */
export class Repo {
  readonly git: Git;
  readonly store: Store;

  constructor(readonly lane: Lane) {
    this.git = new Git(lane.root);
    this.store = new Store(lane);
  }

  get root(): string {
    return this.lane.root;
  }

  get name(): string {
    return path.basename(this.lane.root);
  }
}

/** Which repositories the views draw.
 *
 * A workspace of several clones is usually several clones you are not reviewing
 * at once, and until now the view had no way to be told so: a repo with
 * snapshots always has something to show. This is the reviewer saying which of
 * them they want on screen, and it is about the view and nothing else. Every
 * repo the work touched is still snapshotted, and a hidden repo keeps its
 * numbering, its state and its comments — hiding one is not dropping it.
 *
 * It remembers the roots that are **hidden** rather than the ones shown, so a
 * clone added to the workspace tomorrow arrives visible. The reviewer has said
 * nothing about it, and the answer to "nothing said" should be the one they
 * never had to ask for. Roots are kept even once a folder leaves the workspace,
 * so closing a folder and reopening it does not quietly undo the choice. */
export class RepoSelection {
  private hidden: Set<string>;

  constructor(hidden: readonly string[] = []) {
    this.hidden = new Set(hidden);
  }

  shows(repo: Repo): boolean {
    return !this.hidden.has(repo.root);
  }

  set(root: string, shown: boolean): void {
    if (shown) {
      this.hidden.delete(root);
    } else {
      this.hidden.add(root);
    }
  }

  /** The roots to remember. Sorted, so an unchanged selection serializes to the
   * same string twice and the caller can skip a write that changes nothing. */
  get hiddenRoots(): string[] {
    return [...this.hidden].sort();
  }
}

/** The repositories the workspace folders resolve to.
 *
 * A workspace routinely holds several clones — and several folders inside one
 * clone, since a `.vscode` directory can be added as a folder of its own — so
 * folders are mapped to git roots and deduped. The unit of review is the
 * repository, not the folder. */
export class Repos {
  private byRoot = new Map<string, Repo>();

  get all(): Repo[] {
    return [...this.byRoot.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The repos a review is actually looking at: the ones still checked, that have
   * something to show. Both subtractions in one place because the tree and the
   * badge on the activity-bar icon have to agree on the answer — a count that
   * includes a repo the tree left out is a number nobody can account for. */
  drawn(selection: RepoSelection): Repo[] {
    return this.all.filter(
      (repo) => selection.shows(repo) && repo.store.data.snapshots.length > 0,
    );
  }

  /** Resolve folders to repos and load their review state. A repo already known
   * is kept only while its lane is unchanged — switching branches starts a new
   * lane, and the Repo follows it. */
  async discover(folders: string[]): Promise<void> {
    const roots = new Set<string>();
    for (const folder of folders) {
      const root = await Git.discoverRoot(folder);
      if (root !== undefined) {
        roots.add(root);
      }
    }
    const next = new Map<string, Repo>();
    for (const root of roots) {
      const lane = await resolveLane(root);
      const existing = this.byRoot.get(root);
      if (existing !== undefined && existing.lane.name === lane.name) {
        next.set(root, existing);
        continue;
      }
      const repo = new Repo(lane);
      // A lane appearing for the first time may be a branch just cut from the one
      // being reviewed, in which case the review comes with it.
      await adoptLane(repo.git, repo.lane);
      next.set(root, repo);
    }
    this.byRoot = next;
    await Promise.all(this.all.map((repo) => repo.store.load()));
  }

  /** The repo an absolute path belongs to, and the path relative to its root.
   *
   * Longest root wins, so a clone nested inside another folder resolves to the
   * inner one. Revision URIs carry an absolute path for exactly this reason: one
   * rule then resolves both them and working-tree files. */
  locate(absPath: string): { repo: Repo; rel: string } | undefined {
    let found: { repo: Repo; rel: string } | undefined;
    for (const repo of this.byRoot.values()) {
      const rel = path.relative(repo.root, absPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        continue;
      }
      if (found === undefined || repo.root.length > found.repo.root.length) {
        found = { repo, rel };
      }
    }
    return found;
  }
}
