#!/usr/bin/env node
// The debrief command-line interface — the integration contract every surface
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

import { ChangedFile, Git, Snapshot } from "./core/git";
import { resolveLane } from "./core/lanes";
import {
  adoptLane,
  openThreads,
  replyToThread,
  resolveThreads,
  reviewText,
  sweepLanes,
  takeSnapshot,
} from "./core/review";
import { Store } from "./core/state";
import { labelOf, summaryFromTranscript, summaryOf } from "./core/transcript";

/** Bumped when a payload's shape changes; clients refuse a version they do not
 * know. 2 renamed every `turn` field and `turns` array to `snapshot`; 3 records
 * the HEAD a snapshot was taken at; 4 adds the stash tip beside it; 5 gives a
 * lane a `base`, the commit a cleared lane starts from; 6 gives a thread an
 * `origin`, the revision and lines the comment was written against. */
const SCHEMA_VERSION = 6;

const USAGE = `usage: debrief <command> [options]

  status                 capture nothing; report repo, lane, snapshots and review state
  snapshot               capture a snapshot  (--label, -m, --agent, --session, --from-stop-hook)
                         --label is one sentence and names the snapshot; -m is the
                         few lines under it, and needs a --label to go with it
  snapshot describe <n>  say what snapshot n did  (--label and -m both required)
  diff <n>               changed files for snapshot n
  show <rev> <path>      file content at a revision (a snapshot number or a sha)
  review submit          write the pending comment threads out as one batch
  review open            print every comment still waiting on you, across batches
  review reply <id>      say what you did about a comment, leaving it open  (-m
                         required, --author)
  review resolve <id>…   close the comments you have dealt with — the reviewer's
                         job from the widget, yours only when they ask
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
      console.error(`debrief: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`debrief: ${(error as Error).message}`);
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
      // Committing was debrief's for a while, and skills and habits still reach
      // for it. Say where it went rather than letting it fall through to the
      // capture path, which answers `Unexpected argument 'commit'`.
      if (sub === "commit") {
        throw new UsageError(
          "committing is git's — stage what you have read and `git commit`. " +
            "The snapshots it covers move to Commits on their own",
        );
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
      if (sub === "open") {
        return openReviewCommand(args);
      }
      if (sub === "reply") {
        return replyCommand(args);
      }
      if (sub === "resolve") {
        return resolveCommand(args);
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
    // since debrief deliberately never runs it.
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
    // The agent's closing text, from the payload when it carries one: Claude
    // Code puts it in `last_assistant_message`, and its docs say to prefer that
    // over re-reading the transcript for the same sentence. Scraping the file
    // stays as the fallback, for a host whose payload has no such field.
    //
    // Only what the caller did not give. An agent that described its own snapshot
    // has said it better than its last paragraph can; either read is the backstop
    // for the snapshot where it did not get the chance — and the snapshot is
    // marked as having been answered for, because that is also the shape of a
    // snapshot that was cut off before it could finish.
    const summary =
      summaryOf(hook.lastMessage) ??
      (hook.transcriptPath !== undefined
        ? await summaryFromTranscript(hook.transcriptPath)
        : undefined);
    label ??= summary?.label;
    if (message === undefined && summary !== undefined) {
      message = summary.message;
      described = "transcript";
    }
  }
  // A label is a sentence somebody wrote, not the first line of something else.
  // Slicing one out of the message is what the hook does because a transcript
  // gives it nothing better — and the row it produces reads like the middle of a
  // turn, because that is what it is. An agent that has a message has an opinion
  // about what it did, so it is asked for it.
  if (label === undefined && message !== undefined) {
    throw new UsageError(
      'a message needs a label to go with it: --label "<one sentence saying what this snapshot did>"',
    );
  }
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
  const label = values.label;
  if (label === undefined || label === "") {
    throw new UsageError(
      'snapshot describe needs a label: --label "<one sentence saying what this snapshot did>"',
    );
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

/** Every comment still waiting on the agent — the command it runs to pick a
 * review up. `review batch` prints one file, which is the record of a single
 * submit; this is the question "what is still open", which no single batch can
 * answer once there have been two. */
async function openReviewCommand(args: string[]): Promise<number> {
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
  const threads = openThreads(store);
  if (values.json ?? false) {
    process.stdout.write(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, repo: lane.root, lane: lane.name, threads }) +
        "\n",
    );
    return 0;
  }
  process.stdout.write(threads.length === 0 ? "no open review comments\n" : reviewText(threads));
  return 0;
}

/** The agent's half of the loop: the reviewer writes a comment, the agent fixes
 * it and says so here. The thread stays open — closing it is the reviewer reading
 * the answer and agreeing, which is a different act by a different party. */
async function replyCommand(args: string[]): Promise<number> {
  const { values, positionals } = guarded(() =>
    parseArgs({
      args,
      options: {
        repo: { type: "string" },
        lane: { type: "string" },
        message: { type: "string", short: "m" },
        author: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    }),
  );
  if (positionals.length !== 1) {
    throw new UsageError("review reply takes exactly one thread id");
  }
  const body = values.message?.trim() ?? "";
  if (body === "") {
    throw new UsageError('review reply needs a message: -m "<what you did about it>"');
  }
  const { lane, store } = await open(values.repo, values.lane);
  const thread = await replyToThread(store, positionals[0], body, values.author ?? "agent");
  if (thread === undefined) {
    // A resolution failure, not a quiet no-op: the fix this message describes has
    // already been made, and dropping the message leaves the reviewer waiting on
    // an answer that was written.
    throw new Error(
      `no open thread '${positionals[0]}' — it may have been resolved or deleted; ` +
        "run `debrief review open` for the ids that are still waiting",
    );
  }
  if (values.json ?? false) {
    process.stdout.write(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, repo: lane.root, lane: lane.name, thread }) +
        "\n",
    );
    return 0;
  }
  const { file, startLine } = thread.anchor;
  process.stdout.write(
    `replied to ${thread.id} on ${file}:${startLine + 1} — ` +
      `${thread.comments.length} comment(s), still open for the reviewer\n`,
  );
  return 0;
}

/** Close what has been dealt with. Without this `review open` would print the
 * same comments for the life of the branch, and an agent cannot tell a comment
 * it has answered from one it has not. */
async function resolveCommand(args: string[]): Promise<number> {
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
  if (positionals.length === 0) {
    throw new UsageError("review resolve needs at least one thread id");
  }
  const { lane, store } = await open(values.repo, values.lane);
  const resolved = await resolveThreads(store, positionals);
  const unknown = positionals.filter((id) => !resolved.includes(id));
  if (values.json ?? false) {
    process.stdout.write(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        repo: lane.root,
        lane: lane.name,
        resolved,
        unknown,
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(`resolved ${resolved.length} thread(s)\n`);
  if (unknown.length > 0) {
    // Not an error: an id can be stale because the reviewer deleted the thread,
    // or because it was already closed. Say which, and carry on.
    process.stdout.write(`no open thread for: ${unknown.join(", ")}\n`);
  }
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

/** The JSON a Claude Code Stop hook pipes in: session id, transcript path, the
 * project directory the session runs in, and the turn's closing assistant text.
 * Everything is optional — a missing field falls back to flags, to the
 * transcript, or to defaults rather than failing the snapshot, which is what
 * lets another host's stop-time hook send the subset it has. */
function stopHookPayload(raw: string): {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  lastMessage?: string;
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
  const { session_id, transcript_path, cwd, last_assistant_message } = entry as {
    session_id?: unknown;
    transcript_path?: unknown;
    cwd?: unknown;
    last_assistant_message?: unknown;
  };
  return {
    sessionId: typeof session_id === "string" ? session_id : undefined,
    transcriptPath: typeof transcript_path === "string" ? transcript_path : undefined,
    cwd: typeof cwd === "string" ? cwd : undefined,
    lastMessage: typeof last_assistant_message === "string" ? last_assistant_message : undefined,
  };
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
