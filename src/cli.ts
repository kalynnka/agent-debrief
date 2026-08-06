#!/usr/bin/env node
// The octoview command-line interface — the integration contract every surface
// that is not the extension (hooks, skills, agents, other editors) talks through.
//
// Machine-facing commands print one JSON object on stdout when given --json,
// carrying schemaVersion; diagnostics go to stderr, never stdout.
//
// Exit codes:
//   0  success
//   2  usage error
//   3  the repository, lane, snapshot or revision could not be resolved
import { parseArgs } from "util";

import { ChangedFile, Git, Snapshot } from "./git";
import { resolveLane } from "./lanes";
import { adoptLane, landedSnapshots, sweepLanes, takeSnapshot } from "./review";
import { Store } from "./state";
import { labelOf, summaryFromTranscript } from "./transcript";

/** Bumped when a payload's shape changes; clients refuse a version they do not
 * know. 2 renamed every `turn` field and `turns` array to `snapshot`; 3 records
 * the HEAD a snapshot was taken at; 4 adds the stash tip beside it. */
const SCHEMA_VERSION = 4;

const USAGE = `usage: octoview <command> [options]

  status                 capture nothing; report repo, lane, snapshots and review state
  snapshot               capture a snapshot  (-m, --label, --agent, --session, --from-stop-hook)
  snapshot describe <n>  give snapshot n the message it should have had  (-m required)
  snapshot commit <n>    commit snapshots 1..n as one commit  (-m required, --force)
                         --force overrides both refusals: a staged index, and a
                         snapshot the agent never described
  diff <n>               changed files for snapshot n
  show <rev> <path>      file content at a revision (a snapshot number or a sha)
  review submit          write the pending comment threads out as one batch
  review batch           print the latest submitted batch
  gc                     let go of lanes whose branch is gone, so git can collect
                         their snapshots on its own schedule  (--dry-run)

options: --repo <path> (default .) · --lane <name> (default: checked-out branch) · --json
exit codes: 0 success · 2 usage error · 3 resolution failure`;

class UsageError extends Error {}

interface FilePayload extends ChangedFile {
  reviewed: boolean;
}

interface SnapshotPayload extends Snapshot {
  files: FilePayload[];
}

export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`octoview: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`octoview: ${(error as Error).message}`);
    return 3;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "status":
      return statusCommand(rest);
    case "snapshot": {
      const [sub, ...args] = rest;
      if (sub === "commit") {
        return commitCommand(args);
      }
      if (sub === "describe") {
        return describeCommand(args);
      }
      // Anything else is the capture itself and its flags — the common case, and
      // the one the Stop hook runs, so it is the command with nothing in it.
      return snapshotCommand(rest);
    }
    case "gc":
      return gcCommand(rest);
    case "diff":
      return diffCommand(rest);
    case "show":
      return showCommand(rest);
    case "review": {
      const [sub, ...args] = rest;
      if (sub === "submit") {
        return submitCommand(args);
      }
      if (sub === "batch") {
        return batchCommand(args);
      }
      throw new UsageError(`unknown review subcommand '${sub ?? ""}'`);
    }
    default:
      throw new UsageError(command === undefined ? "no command given" : `unknown command '${command}'`);
  }
}

/** parseArgs errors are usage errors (exit 2), not resolution errors (exit 3). */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function open(repo: string | undefined, laneName: string | undefined) {
  const lane = await resolveLane(repo ?? ".", laneName);
  const git = new Git(lane.root);
  // A lane named with --lane is the caller's choice and stands as given. A
  // resolved one may be a branch just cut from another, whose review comes with
  // it — every entry point heals the lane, so it does not matter which one the
  // reviewer or the hook happens to reach first.
  if (laneName === undefined) {
    await adoptLane(git, lane);
  }
  const store = new Store(lane);
  await store.load();
  return { lane, git, store };
}

function snapshotPayload(store: Store, snapshot: Snapshot, files: ChangedFile[]): SnapshotPayload {
  return {
    ...snapshot,
    files: files.map((f) => ({ ...f, reviewed: store.isReviewed(f.path, snapshot.n) })),
  };
}

function fileLine(f: FilePayload): string {
  const name = f.oldPath === undefined ? f.path : `${f.oldPath} -> ${f.path}`;
  return `  ${f.status}  ${name}${f.reviewed ? "  (reviewed)" : ""}`;
}

async function statusCommand(args: string[]): Promise<number> {
  const { values } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
        json: { type: "boolean" },
      },
    }),
  );
  const { lane, git, store } = await open(values.repo, values.lane);
  const snapshots: SnapshotPayload[] = [];
  for (const snapshot of store.data.snapshots) {
    const files = await git.changedFiles(snapshot.parent, snapshot.sha);
    snapshots.push(snapshotPayload(store, snapshot, files));
  }
  const payload = { schemaVersion: SCHEMA_VERSION, repo: lane.root, lane: lane.name, snapshots };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  process.stdout.write(
    `repo:      ${lane.root}\nlane:      ${lane.name}\nsnapshots: ${snapshots.length}\n`,
  );
  for (const snapshot of snapshots) {
    const reviewed = snapshot.files.filter((f) => f.reviewed).length;
    process.stdout.write(
      `  ${snapshot.n}  ${snapshot.label} — ${snapshot.files.length} file(s), ` +
        `${reviewed} reviewed [${snapshot.agent}]\n`,
    );
  }
  return 0;
}

async function gcCommand(args: string[]): Promise<number> {
  const { values } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
      },
    }),
  );
  const lane = await resolveLane(values.repo ?? ".");
  const git = new Git(lane.root);
  const dryRun = values["dry-run"] ?? false;
  const sweep = await sweepLanes(git, lane.commonDir, !dryRun);
  if (values.json ?? false) {
    process.stdout.write(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, repo: lane.root, dryRun, ...sweep }) + "\n",
    );
    return 0;
  }
  process.stdout.write(`repo: ${lane.root}${dryRun ? "  (dry run — nothing changed)" : ""}\n`);
  for (const name of sweep.closed) {
    process.stdout.write(`  closed     ${name}  — refs dropped, git owns the snapshots now\n`);
  }
  for (const name of sweep.collected) {
    process.stdout.write(`  collected  ${name}  — git already took the snapshots\n`);
  }
  for (const ref of sweep.stray) {
    process.stdout.write(`  stray      ${ref}  — no lane claims it\n`);
  }
  if (sweep.closed.length + sweep.collected.length + sweep.stray.length === 0) {
    process.stdout.write("  every lane still has its branch\n");
  } else if (sweep.closed.length + sweep.stray.length > 0) {
    // The refs were the only thing keeping them: say what actually frees the disk,
    // since octoview deliberately never runs it.
    process.stdout.write("\nrun `git gc` when you want the objects back.\n");
  }
  return 0;
}

async function snapshotCommand(args: string[]): Promise<number> {
  const { values } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
        json: { type: "boolean" },
        label: { type: "string" },
        message: { type: "string", short: "m" },
        agent: { type: "string" },
        session: { type: "string" },
        "from-stop-hook": { type: "boolean" },
      },
    }),
  );
  let { repo, label, message, agent, session } = values;
  let described: Snapshot["described"] = message === undefined ? undefined : "agent";
  if (values["from-stop-hook"] ?? false) {
    const hook = stopHookPayload(await readStdin());
    repo ??= hook.cwd;
    session ??= hook.sessionId;
    agent ??= "claude";
    if (hook.transcriptPath !== undefined) {
      // Only what the caller did not give. An agent that described its own snapshot
      // has said it better than the transcript's last paragraph can; the scrape
      // is the backstop for the snapshot where it did not get the chance — and the
      // snapshot is marked as having been answered for, because that is also the
      // shape of a snapshot that was cut off before it could finish.
      const summary = await summaryFromTranscript(hook.transcriptPath);
      label ??= summary?.label;
      if (message === undefined && summary !== undefined) {
        message = summary.message;
        described = "transcript";
      }
    }
  }
  // A message is enough on its own: the label is its first line, by the rule
  // the transcript is read with.
  label ??= labelOf(message);
  const { lane, git, store } = await open(repo, values.lane);
  const result = await takeSnapshot(git, store, {
    label,
    message,
    described,
    agent: agent ?? "manual",
    session,
  });
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    repo: lane.root,
    lane: lane.name,
    created: result.created,
    snapshot: result.created ? snapshotPayload(store, result.snapshot, result.files) : null,
  };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  if (!result.created) {
    // Not an error either way: nothing to record, or nothing yet worth
    // attributing. The hook runs this on every turn and must not fail a turn.
    process.stdout.write(
      result.reason === "unchanged"
        ? `nothing changed in ${lane.name} — no snapshot taken\n`
        : `${result.operation} is in progress — no snapshot taken, since the ` +
            `worktree is not the agent's work yet\n`,
    );
    return 0;
  }
  process.stdout.write(
    `snapshot ${result.snapshot.n}: ${result.snapshot.label} — ${result.files.length} file(s)\n`,
  );
  return 0;
}

/** Give a snapshot the message it should have been recorded with.
 *
 * The snapshot is the thing that cannot be missed, so the hook takes it whether
 * or not the agent was in a position to say what it did — a snapshot cut short by an
 * interrupt is recorded with whatever the transcript last held, which is often a
 * sentence from the middle of the work. This is the way back: the next run says
 * it properly. Only the description moves. The snapshot, its ref, its parent and
 * its place in the order are all untouched, so nothing that has been reviewed or
 * committed against this snapshot is disturbed. */
async function describeCommand(args: string[]): Promise<number> {
  const { values, positionals } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
        json: { type: "boolean" },
        message: { type: "string", short: "m" },
        label: { type: "string" },
      },
      allowPositionals: true,
    }),
  );
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
    throw new UsageError("snapshot describe takes exactly one snapshot number");
  }
  const message = values.message;
  if (message === undefined || message === "") {
    throw new UsageError('snapshot describe needs a message: -m "<what the snapshot did>"');
  }
  const label = values.label ?? labelOf(message);
  if (label === undefined) {
    throw new UsageError("the message has no line to take a label from");
  }
  const n = Number(positionals[0]);
  const { lane, store } = await open(values.repo, values.lane);
  const described = await store.withLock((state) => {
    const snapshot = state.snapshots.find((t) => t.n === n);
    if (snapshot === undefined) {
      return undefined;
    }
    snapshot.label = label;
    snapshot.message = message;
    // Whatever the hook had to guess, the agent has now answered for: a
    // described snapshot is one somebody stood behind.
    snapshot.described = "agent";
    return snapshot;
  });
  if (described === undefined) {
    throw new Error(`no snapshot ${n} in lane ${lane.name}`);
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    repo: lane.root,
    lane: lane.name,
    snapshot: described,
  };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  process.stdout.write(`snapshot ${described.n}: ${described.label}\n`);
  return 0;
}

/** Commit everything up to and including snapshot n — the reviewed prefix — as one
 * commit, and leave every later snapshot uncommitted on disk.
 *
 * Committing is the human's call. This exists so it can be carried out on their
 * instruction without hand-assembling plumbing, not so an agent can decide to
 * land work: `prepare-change-review` still forbids reaching for it uninvited. */
async function commitCommand(args: string[]): Promise<number> {
  const { values, positionals } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
        json: { type: "boolean" },
        message: { type: "string", short: "m" },
        force: { type: "boolean" },
      },
      allowPositionals: true,
    }),
  );
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
    throw new UsageError("snapshot commit takes exactly one snapshot number");
  }
  if (values.message === undefined || values.message === "") {
    throw new UsageError("snapshot commit needs a message: -m \"<subject>\"");
  }
  const n = Number(positionals[0]);
  const { lane, git, store } = await open(values.repo, values.lane);
  const snapshot = store.data.snapshots.find((t) => t.n === n);
  if (snapshot === undefined) {
    throw new Error(`no snapshot ${n} in lane ${lane.name}`);
  }
  const head = await git.head();
  if (head !== undefined && (await git.treeOf(head)) === (await git.treeOf(snapshot.sha))) {
    throw new Error(`snapshot ${n} is already committed — HEAD holds exactly its snapshot`);
  }
  // Loading the snapshot into the index destroys whatever was staged, and the
  // staged set is the reviewer's own progress marker.
  if (head !== undefined && !(values.force ?? false) && (await git.staged())) {
    throw new Error(
      `the index has staged changes that committing snapshot ${n} would replace — ` +
        `commit or unstage them first, or pass --force`,
    );
  }
  // What gets committed is snapshot n's snapshot exactly as it stands, so a snapshot the
  // agent never described is a tree nobody said was finished — the shape an
  // interrupted snapshot leaves behind. Snapshots from before this was recorded say
  // nothing either way and are not second-guessed.
  if (snapshot.described === "transcript" && !(values.force ?? false)) {
    throw new Error(
      `snapshot ${n} was recorded by the Stop hook rather than described by the agent, ` +
        `so it may be work that was cut off mid-change — and its snapshot is ` +
        `exactly what would be committed. Read it, or describe it, or pass --force`,
    );
  }
  const files = await git.changedFiles(head ?? (await git.emptyTree()), snapshot.sha);
  const sha = await git.commitSnapshot(snapshot.sha, values.message);
  const landed = await landedSnapshots(git, store.data.snapshots, sha);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    repo: lane.root,
    lane: lane.name,
    commit: sha,
    through: n,
    landed: [...landed],
    files: files.map((f) => ({ ...f, reviewed: store.isReviewed(f.path, n) })),
  };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  process.stdout.write(
    `committed ${sha.slice(0, 8)} — snapshots through ${n}, ${files.length} file(s)\n` +
      `landed:   ${payload.landed.join(", ") || "none"}\n`,
  );
  for (const f of payload.files) {
    process.stdout.write(fileLine(f) + "\n");
  }
  return 0;
}

async function diffCommand(args: string[]): Promise<number> {
  const { values, positionals } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    }),
  );
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
    throw new UsageError("diff takes exactly one snapshot number");
  }
  const n = Number(positionals[0]);
  const { lane, git, store } = await open(values.repo, values.lane);
  const snapshot = store.data.snapshots.find((t) => t.n === n);
  if (snapshot === undefined) {
    throw new Error(`no snapshot ${n} in lane ${lane.name}`);
  }
  const files = await git.changedFiles(snapshot.parent, snapshot.sha);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    repo: lane.root,
    lane: lane.name,
    snapshot: snapshotPayload(store, snapshot, files),
  };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  for (const f of payload.snapshot.files) {
    process.stdout.write(fileLine(f) + "\n");
  }
  return 0;
}

async function showCommand(args: string[]): Promise<number> {
  const { values, positionals } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
      },
      allowPositionals: true,
    }),
  );
  if (positionals.length !== 2) {
    throw new UsageError("show takes a revision and a path");
  }
  const [rev, file] = positionals;
  const { lane, git, store } = await open(values.repo, values.lane);
  let sha = rev;
  if (/^\d+$/.test(rev)) {
    const snapshot = store.data.snapshots.find((t) => t.n === Number(rev));
    if (snapshot === undefined) {
      throw new Error(`no snapshot ${rev} in lane ${lane.name}`);
    }
    sha = snapshot.sha;
  }
  // A file absent at the revision prints empty: an added file has no left side.
  process.stdout.write(await git.fileAt(sha, file));
  return 0;
}

async function submitCommand(args: string[]): Promise<number> {
  const { values } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
        json: { type: "boolean" },
      },
    }),
  );
  const { lane, store } = await open(values.repo, values.lane);
  const result = await store.submit();
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    repo: lane.root,
    lane: lane.name,
    submitted: result?.count ?? 0,
    path: result?.path ?? null,
  };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  process.stdout.write(
    result === undefined
      ? "no draft comments to submit\n"
      : `submitted ${result.count} thread(s) -> ${result.path}\n`,
  );
  return 0;
}

async function batchCommand(args: string[]): Promise<number> {
  const { values } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
        json: { type: "boolean" },
      },
    }),
  );
  const { lane, store } = await open(values.repo, values.lane);
  const latest = await store.latestBatch();
  if (values.json ?? false) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      repo: lane.root,
      lane: lane.name,
      path: latest?.path ?? null,
      batch: latest === undefined ? null : (JSON.parse(latest.content) as unknown),
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  process.stdout.write(latest === undefined ? "no batch submitted yet\n" : latest.content);
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** The JSON a Claude Code Stop hook pipes in: session id, transcript path, and
 * the project directory the session runs in. Everything is optional — a missing
 * field falls back to flags or defaults rather than failing the snapshot. */
function stopHookPayload(raw: string): {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
} {
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    throw new Error("the stop-hook payload on stdin is not JSON");
  }
  if (typeof entry !== "object" || entry === null) {
    throw new Error("the stop-hook payload is not an object");
  }
  const { session_id, transcript_path, cwd } = entry as {
    session_id?: unknown;
    transcript_path?: unknown;
    cwd?: unknown;
  };
  return {
    sessionId: typeof session_id === "string" ? session_id : undefined,
    transcriptPath: typeof transcript_path === "string" ? transcript_path : undefined,
    cwd: typeof cwd === "string" ? cwd : undefined,
  };
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
