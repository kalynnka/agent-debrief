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
//   3  the repository, lane, turn or revision could not be resolved
import { parseArgs } from "util";

import { ChangedFile, Git, Turn } from "./git";
import { resolveLane } from "./lanes";
import { landedTurns, snapshotTurn } from "./review";
import { Store } from "./state";
import { labelOf, summaryFromTranscript } from "./transcript";

/** Bumped when a payload's shape changes; clients refuse a version they do not know. */
const SCHEMA_VERSION = 1;

const USAGE = `usage: octoview <command> [options]

  status                capture nothing; report repo, lane, turns and review state
  turn snapshot         capture a turn  (-m, --label, --agent, --session, --from-stop-hook)
  turn describe <n>     give turn n the message it should have had  (-m required)
  turn commit <n>       commit turns 1..n as one commit  (-m required, --force)
                        --force overrides both refusals: a staged index, and a
                        turn the agent never described
  diff <n>              changed files for turn n
  show <rev> <path>     file content at a revision (a turn number or a sha)
  review submit         write the pending comment threads out as one batch
  review batch          print the latest submitted batch

options: --repo <path> (default .) · --lane <name> (default: checked-out branch) · --json
exit codes: 0 success · 2 usage error · 3 resolution failure`;

class UsageError extends Error {}

interface FilePayload extends ChangedFile {
  reviewed: boolean;
}

interface TurnPayload extends Turn {
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
    case "turn": {
      const [sub, ...args] = rest;
      if (sub === "commit") {
        return commitCommand(args);
      }
      if (sub === "describe") {
        return describeCommand(args);
      }
      if (sub !== "snapshot") {
        throw new UsageError(`unknown turn subcommand '${sub ?? ""}'`);
      }
      return snapshotCommand(args);
    }
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
  const store = new Store(lane);
  await store.load();
  return { lane, git, store };
}

function turnPayload(store: Store, turn: Turn, files: ChangedFile[]): TurnPayload {
  return {
    ...turn,
    files: files.map((f) => ({ ...f, reviewed: store.isReviewed(f.path, turn.n) })),
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
  const turns: TurnPayload[] = [];
  for (const turn of store.data.turns) {
    turns.push(turnPayload(store, turn, await git.changedFiles(turn.parent, turn.sha)));
  }
  const payload = { schemaVersion: SCHEMA_VERSION, repo: lane.root, lane: lane.name, turns };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  process.stdout.write(`repo:  ${lane.root}\nlane:  ${lane.name}\nturns: ${turns.length}\n`);
  for (const turn of turns) {
    const reviewed = turn.files.filter((f) => f.reviewed).length;
    process.stdout.write(
      `  ${turn.n}  ${turn.label} — ${turn.files.length} file(s), ${reviewed} reviewed [${turn.agent}]\n`,
    );
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
  let described: Turn["described"] = message === undefined ? undefined : "agent";
  if (values["from-stop-hook"] ?? false) {
    const hook = stopHookPayload(await readStdin());
    repo ??= hook.cwd;
    session ??= hook.sessionId;
    agent ??= "claude";
    if (hook.transcriptPath !== undefined) {
      // Only what the caller did not give. An agent that described its own turn
      // has said it better than the transcript's last paragraph can; the scrape
      // is the backstop for the turn where it did not get the chance — and the
      // turn is marked as having been answered for, because that is also the
      // shape of a turn that was cut off before it could finish.
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
  const result = await snapshotTurn(git, store, {
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
    turn: result.created ? turnPayload(store, result.turn, result.files) : null,
  };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  if (!result.created) {
    process.stdout.write(`nothing changed in ${lane.name} — no turn taken\n`);
    return 0;
  }
  process.stdout.write(
    `turn ${result.turn.n}: ${result.turn.label} — ${result.files.length} file(s)\n`,
  );
  return 0;
}

/** Give a turn the message it should have been recorded with.
 *
 * The snapshot is the thing that cannot be missed, so the hook takes it whether
 * or not the agent was in a position to say what it did — a turn cut short by an
 * interrupt is recorded with whatever the transcript last held, which is often a
 * sentence from the middle of the work. This is the way back: the next run says
 * it properly. Only the description moves. The snapshot, its ref, its parent and
 * its place in the order are all untouched, so nothing that has been reviewed or
 * committed against this turn is disturbed. */
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
    throw new UsageError("turn describe takes exactly one turn number");
  }
  const message = values.message;
  if (message === undefined || message === "") {
    throw new UsageError('turn describe needs a message: -m "<what the turn did>"');
  }
  const label = values.label ?? labelOf(message);
  if (label === undefined) {
    throw new UsageError("the message has no line to take a label from");
  }
  const n = Number(positionals[0]);
  const { lane, store } = await open(values.repo, values.lane);
  const described = await store.withLock((state) => {
    const turn = state.turns.find((t) => t.n === n);
    if (turn === undefined) {
      return undefined;
    }
    turn.label = label;
    turn.message = message;
    // Whatever the hook had to guess, the agent has now answered for: a
    // described turn is one somebody stood behind.
    turn.described = "agent";
    return turn;
  });
  if (described === undefined) {
    throw new Error(`no turn ${n} in lane ${lane.name}`);
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    repo: lane.root,
    lane: lane.name,
    turn: described,
  };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  process.stdout.write(`turn ${described.n}: ${described.label}\n`);
  return 0;
}

/** Commit everything up to and including turn n — the reviewed prefix — as one
 * commit, and leave every later turn uncommitted on disk.
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
    throw new UsageError("turn commit takes exactly one turn number");
  }
  if (values.message === undefined || values.message === "") {
    throw new UsageError("turn commit needs a message: -m \"<subject>\"");
  }
  const n = Number(positionals[0]);
  const { lane, git, store } = await open(values.repo, values.lane);
  const turn = store.data.turns.find((t) => t.n === n);
  if (turn === undefined) {
    throw new Error(`no turn ${n} in lane ${lane.name}`);
  }
  const head = await git.head();
  if (head !== undefined && (await git.treeOf(head)) === (await git.treeOf(turn.sha))) {
    throw new Error(`turn ${n} is already committed — HEAD holds exactly its snapshot`);
  }
  // Loading the snapshot into the index destroys whatever was staged, and the
  // staged set is the reviewer's own progress marker.
  if (head !== undefined && !(values.force ?? false) && (await git.staged())) {
    throw new Error(
      `the index has staged changes that committing turn ${n} would replace — ` +
        `commit or unstage them first, or pass --force`,
    );
  }
  // What gets committed is turn n's snapshot exactly as it stands, so a turn the
  // agent never described is a tree nobody said was finished — the shape an
  // interrupted turn leaves behind. Turns from before this was recorded say
  // nothing either way and are not second-guessed.
  if (turn.described === "transcript" && !(values.force ?? false)) {
    throw new Error(
      `turn ${n} was recorded by the Stop hook rather than described by the agent, ` +
        `so it may be work that was cut off mid-change — and its snapshot is ` +
        `exactly what would be committed. Read it, or describe it, or pass --force`,
    );
  }
  const files = await git.changedFiles(head ?? (await git.emptyTree()), turn.sha);
  const sha = await git.commitSnapshot(turn.sha, values.message);
  const landed = await landedTurns(git, store.data.turns, sha);
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
    `committed ${sha.slice(0, 8)} — turns through ${n}, ${files.length} file(s)\n` +
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
    throw new UsageError("diff takes exactly one turn number");
  }
  const n = Number(positionals[0]);
  const { lane, git, store } = await open(values.repo, values.lane);
  const turn = store.data.turns.find((t) => t.n === n);
  if (turn === undefined) {
    throw new Error(`no turn ${n} in lane ${lane.name}`);
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    repo: lane.root,
    lane: lane.name,
    turn: turnPayload(store, turn, await git.changedFiles(turn.parent, turn.sha)),
  };
  if (values.json ?? false) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  for (const f of payload.turn.files) {
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
    const turn = store.data.turns.find((t) => t.n === Number(rev));
    if (turn === undefined) {
      throw new Error(`no turn ${rev} in lane ${lane.name}`);
    }
    sha = turn.sha;
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
