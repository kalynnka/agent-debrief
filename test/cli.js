// Headless check of lane resolution and the CLI contract, neither of which
// imports vscode. Run with `node test/cli.js`.
const assert = require("assert");
const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Git } = require("../out/git");
const { resolveLane } = require("../out/lanes");
const { hashLines } = require("../out/review");
const { Store } = require("../out/state");

const cliPath = path.join(__dirname, "..", "out", "cli.js");
const octoview = (args, cwd, input) =>
  spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8", input });
const collect = (child) =>
  new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });

// realpath up front so every path is physical; git reports physical paths and
// macOS temp dirs are symlinked.
const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octoview-cli-")));
// The directory name is deliberately distinct from the branch name, so the
// detached-HEAD fallback is distinguishable from branch resolution.
const root = path.join(parent, "repo");
fs.mkdirSync(root);
const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function main() {
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);

  // 1. Main tree: the branch is the lane, and the common dir is the repo's .git.
  const mainLane = await resolveLane(root);
  assert.strictEqual(mainLane.name, "main");
  assert.strictEqual(mainLane.root, root);
  assert.strictEqual(mainLane.commonDir, path.join(root, ".git"));
  console.log("main tree: lane = branch             ok");

  // 2. A linked worktree gets its own lane but the clone's shared .git — the
  //    foundation for lane-scoped refs not colliding across worktrees.
  const worktree = path.join(parent, "feature-wt");
  git(["worktree", "add", "-q", "-b", "feature", worktree]);
  const worktreeLane = await resolveLane(worktree);
  assert.strictEqual(worktreeLane.name, "feature");
  assert.strictEqual(worktreeLane.root, worktree);
  assert.strictEqual(worktreeLane.commonDir, path.join(root, ".git"));
  console.log("linked worktree: own lane, shared .git  ok");

  // 3. Detached HEAD falls back to the worktree's directory name.
  git(["checkout", "-q", "--detach"]);
  assert.strictEqual((await resolveLane(root)).name, "repo");
  git(["checkout", "-q", "main"]);
  console.log("detached HEAD -> worktree name       ok");

  // 4. An unborn HEAD (fresh `git init`, no commits) still resolves its init
  //    branch — octoview's own repo is in exactly this state.
  const fresh = path.join(parent, "fresh");
  fs.mkdirSync(fresh);
  git(["init", "-q", "-b", "main", "."], fresh);
  assert.strictEqual((await resolveLane(fresh)).name, "main");
  console.log("unborn HEAD: init branch             ok");

  // 5. An explicit lane wins, and a non-repo is refused with a clear error.
  assert.strictEqual((await resolveLane(root, "pr/7")).name, "pr/7");
  const empty = path.join(parent, "empty");
  fs.mkdirSync(empty);
  await assert.rejects(resolveLane(empty), /not a git repository/);
  console.log("override + non-repo refusal          ok");

  // 6. The JSON envelope: exact shape, data on stdout, nothing on stderr.
  const json = octoview(["status", "--repo", root, "--json"], parent);
  assert.strictEqual(json.status, 0);
  assert.strictEqual(json.stderr, "");
  assert.deepStrictEqual(JSON.parse(json.stdout), {
    schemaVersion: 1,
    repo: root,
    lane: "main",
    turns: [],
  });
  console.log("status --json envelope               ok");

  // 7. The human summary, and --lane plumbed through to the payload.
  const human = octoview(["status"], root);
  assert.strictEqual(human.status, 0);
  assert.strictEqual(human.stdout.includes("lane:  main"), true);
  const overridden = octoview(["status", "--repo", root, "--lane", "pr/7", "--json"], root);
  assert.strictEqual(JSON.parse(overridden.stdout).lane, "pr/7");
  console.log("summary + --lane flag                ok");

  // 8. Documented exit codes: 3 for an unresolvable repo (stderr only), 2 for
  //    usage errors.
  const notRepo = octoview(["status", "--json"], empty);
  assert.strictEqual(notRepo.status, 3);
  assert.strictEqual(notRepo.stdout, "");
  assert.strictEqual(notRepo.stderr.includes("not a git repository"), true);
  const unknownCommand = octoview(["bogus"], root);
  assert.strictEqual(unknownCommand.status, 2);
  const unknownFlag = octoview(["status", "--bogus"], root);
  assert.strictEqual(unknownFlag.status, 2);
  assert.strictEqual(unknownFlag.stderr.includes("usage:"), true);
  console.log("exit codes 3 and 2                   ok");

  // 9. Snapshot from the CLI: creates turn 1, is idempotent, shows up in status,
  //    and leaves the user's index, HEAD and branch list byte-identical — the
  //    §1.3 invariant with a staged file in play.
  fs.writeFileSync(path.join(root, "staged.txt"), "s\n");
  git(["add", "staged.txt"]);
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  const statusBefore = git(["status", "--porcelain"]);
  const headBefore = git(["rev-parse", "HEAD"]).trim();
  const branchesBefore = git(["branch", "--list"]);
  const snap1 = octoview(["turn", "snapshot", "--label", "add b", "--json"], root);
  assert.strictEqual(snap1.status, 0);
  const p1 = JSON.parse(snap1.stdout);
  assert.strictEqual(p1.created, true);
  assert.strictEqual(p1.turn.n, 1);
  assert.deepStrictEqual(p1.turn.files.map((f) => f.path).sort(), ["b.txt", "staged.txt"]);
  const again = JSON.parse(octoview(["turn", "snapshot", "--json"], root).stdout);
  assert.strictEqual(again.created, false, "an unchanged tree must not create a turn");
  const status9 = JSON.parse(octoview(["status", "--repo", root, "--json"], parent).stdout);
  assert.strictEqual(status9.turns.length, 1);
  assert.strictEqual(status9.turns[0].label, "add b");
  assert.strictEqual(status9.turns[0].agent, "manual");
  assert.strictEqual(git(["status", "--porcelain"]), statusBefore, "user's index/worktree disturbed");
  assert.strictEqual(git(["rev-parse", "HEAD"]).trim(), headBefore, "HEAD moved");
  assert.strictEqual(git(["branch", "--list"]), branchesBefore, "branch list changed");
  console.log("CLI snapshot + idempotence + invariant  ok");

  // 10. A linked worktree snapshots through the clone's shared .git (the
  //     `.git`-is-a-file ENOTDIR bug), with its own numbering and its own refs.
  fs.writeFileSync(path.join(worktree, "wt.txt"), "w\n");
  const wsnap = JSON.parse(octoview(["turn", "snapshot", "--label", "wt change", "--json"], worktree).stdout);
  assert.strictEqual(wsnap.created, true);
  assert.strictEqual(wsnap.lane, "feature");
  assert.strictEqual(wsnap.turn.n, 1, "worktree numbering must be independent");
  const refs = git(["for-each-ref", "refs/octoview/turns", "--format=%(refname)"]);
  assert.strictEqual(refs.includes("refs/octoview/turns/main/1"), true);
  assert.strictEqual(refs.includes("refs/octoview/turns/feature/1"), true);
  assert.strictEqual(
    fs.existsSync(path.join(root, ".git", "octoview", "feature", "state.json")),
    true,
    "worktree state must live under the shared common dir",
  );
  console.log("worktree snapshot, lane-scoped refs  ok");

  // 11. A rename is one record carrying both paths, not a silently dropped pair.
  fs.renameSync(path.join(root, "a.txt"), path.join(root, "renamed.txt"));
  const rsnap = JSON.parse(octoview(["turn", "snapshot", "--label", "rename a", "--json"], root).stdout);
  assert.strictEqual(rsnap.turn.files.length, 1);
  assert.strictEqual(rsnap.turn.files[0].status, "R");
  assert.strictEqual(rsnap.turn.files[0].oldPath, "a.txt");
  assert.strictEqual(rsnap.turn.files[0].path, "renamed.txt");
  console.log("rename record: three fields          ok");

  // 12. show: content at a turn number, empty for a file absent there.
  const shown = octoview(["show", "1", "b.txt", "--repo", root], parent);
  assert.strictEqual(shown.status, 0);
  assert.strictEqual(shown.stdout, "b\n");
  const missing = octoview(["show", "1", "nope.txt", "--repo", root], parent);
  assert.strictEqual(missing.status, 0);
  assert.strictEqual(missing.stdout, "");
  const badTurn = octoview(["diff", "9", "--repo", root], parent);
  assert.strictEqual(badTurn.status, 3);
  console.log("show + missing file + bad turn       ok");

  // 13. A repo with no commits can be snapshotted: turn 1 has no commit parent,
  //     diffs against the empty tree, and still creates no branch.
  fs.writeFileSync(path.join(fresh, "first.txt"), "hello\n");
  const fsnap = JSON.parse(octoview(["turn", "snapshot", "--label", "first files", "--json"], fresh).stdout);
  assert.strictEqual(fsnap.created, true);
  assert.deepStrictEqual(fsnap.turn.files.map((f) => `${f.status} ${f.path}`), ["A first.txt"]);
  assert.strictEqual(git(["branch", "--list"], fresh).trim(), "", "a branch appeared in the unborn repo");
  const fagain = JSON.parse(octoview(["turn", "snapshot", "--json"], fresh).stdout);
  assert.strictEqual(fagain.created, false);
  console.log("unborn HEAD snapshot                 ok");

  // 14. Review round-trip at the CLI: a draft thread submits as one batch and
  //     comes back through `review batch`; a second submit has nothing to send.
  const g = new Git(root);
  const lane = await resolveLane(root);
  const store = new Store(lane);
  const blob = await g.blobAt(rsnap.turn.sha, "renamed.txt");
  await store.withLock((state) => {
    state.threads.push({
      id: "cli-t1",
      anchor: { file: "renamed.txt", startLine: 0, endLine: 0, blobSha: blob, contentHash: hashLines(["a"]) },
      turn: rsnap.turn.n,
      state: "draft",
      outdated: false,
      comments: [{ body: "why rename?", author: "me", at: new Date().toISOString() }],
    });
  });
  const sub = JSON.parse(octoview(["review", "submit", "--repo", root, "--json"], parent).stdout);
  assert.strictEqual(sub.submitted, 1);
  const batch = JSON.parse(octoview(["review", "batch", "--repo", root, "--json"], parent).stdout);
  assert.strictEqual(batch.batch.comments.length, 1);
  assert.strictEqual(batch.batch.comments[0].file, "renamed.txt");
  assert.strictEqual(batch.batch.comments[0].line, 1);
  const subAgain = JSON.parse(octoview(["review", "submit", "--repo", root, "--json"], parent).stdout);
  assert.strictEqual(subAgain.submitted, 0);
  console.log("review submit -> batch round-trip    ok");

  // 15. Carry-forward: a thread follows its lines when they move, and goes
  //     outdated when the lines themselves change.
  fs.writeFileSync(path.join(root, "code.txt"), "alpha\nbeta\ngamma\n");
  const csnap = JSON.parse(octoview(["turn", "snapshot", "--label", "add code", "--json"], root).stdout);
  const codeBlob = await g.blobAt(csnap.turn.sha, "code.txt");
  await store.withLock((state) => {
    state.threads.push({
      id: "cf-t1",
      anchor: { file: "code.txt", startLine: 1, endLine: 1, blobSha: codeBlob, contentHash: hashLines(["beta"]) },
      turn: csnap.turn.n,
      state: "draft",
      outdated: false,
      comments: [{ body: "beta?", author: "me", at: new Date().toISOString() }],
    });
  });
  fs.writeFileSync(path.join(root, "code.txt"), "intro\nalpha\nbeta\ngamma\n");
  octoview(["turn", "snapshot", "--label", "shift lines", "--json"], root);
  await store.load();
  const moved = store.data.threads.find((t) => t.id === "cf-t1");
  assert.strictEqual(moved.anchor.startLine, 2, "thread did not follow its lines");
  assert.strictEqual(moved.outdated, false);
  fs.writeFileSync(path.join(root, "code.txt"), "intro\nalpha\nBETA!\ngamma\n");
  octoview(["turn", "snapshot", "--label", "edit anchored line", "--json"], root);
  await store.load();
  const gone = store.data.threads.find((t) => t.id === "cf-t1");
  assert.strictEqual(gone.outdated, true, "changed lines must mark the thread outdated");
  console.log("carry-forward + outdated             ok");

  // 16. Two real writer processes lose no updates (the §12.1 lock), and two
  //     concurrent snapshots of the same change produce exactly one turn.
  const worker = `
    const { resolveLane } = require(process.argv[1]);
    const { Store } = require(process.argv[2]);
    (async () => {
      const lane = await resolveLane(process.argv[3]);
      const store = new Store(lane);
      for (let i = 0; i < 20; i++) {
        await store.withLock((state) => { state.reviewed[process.argv[4] + ":" + i] = i; });
      }
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const lanesJs = path.join(__dirname, "..", "out", "lanes.js");
  const stateJs = path.join(__dirname, "..", "out", "state.js");
  const [wa, wb] = await Promise.all([
    collect(spawn(process.execPath, ["-e", worker, lanesJs, stateJs, root, "A"])),
    collect(spawn(process.execPath, ["-e", worker, lanesJs, stateJs, root, "B"])),
  ]);
  assert.strictEqual(wa.code, 0, `writer A failed: ${wa.out}`);
  assert.strictEqual(wb.code, 0, `writer B failed: ${wb.out}`);
  await store.load();
  const keys = Object.keys(store.data.reviewed);
  assert.strictEqual(keys.filter((k) => k.startsWith("A:")).length, 20, "writer A lost updates");
  assert.strictEqual(keys.filter((k) => k.startsWith("B:")).length, 20, "writer B lost updates");

  const turnsBefore = store.data.turns.length;
  fs.writeFileSync(path.join(root, "race.txt"), "r\n");
  const [ra, rb] = await Promise.all([
    collect(spawn(process.execPath, [cliPath, "turn", "snapshot", "--label", "race", "--json"], { cwd: root })),
    collect(spawn(process.execPath, [cliPath, "turn", "snapshot", "--label", "race", "--json"], { cwd: root })),
  ]);
  assert.strictEqual(ra.code, 0);
  assert.strictEqual(rb.code, 0);
  const createdFlags = [JSON.parse(ra.out).created, JSON.parse(rb.out).created].sort();
  assert.deepStrictEqual(createdFlags, [false, true], "exactly one of two racing snapshots must win");
  await store.load();
  assert.strictEqual(store.data.turns.length, turnsBefore + 1);
  console.log("lock: no lost updates, one winner    ok");

  // 17. The Claude Stop hook path: repo and session come from the hook payload
  //     on stdin, the label from the transcript's last assistant text.
  const transcript = path.join(parent, "transcript.jsonl");
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "fix it" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I fixed strip_markdown to keep code fences.\n\nDetails follow." }] } }),
      "not json at all",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, "hooked.txt"), "h\n");
  const hookRun = octoview(
    ["turn", "snapshot", "--from-stop-hook", "--json"],
    parent, // deliberately not the repo: the repo must come from the payload's cwd
    JSON.stringify({ session_id: "sess-123", transcript_path: transcript, cwd: root }),
  );
  assert.strictEqual(hookRun.status, 0, hookRun.stderr);
  const hp = JSON.parse(hookRun.stdout);
  assert.strictEqual(hp.created, true);
  assert.strictEqual(hp.repo, root);
  assert.strictEqual(hp.turn.agent, "claude");
  assert.strictEqual(hp.turn.session, "sess-123");
  assert.strictEqual(hp.turn.label, "I fixed strip_markdown to keep code fences.");
  console.log("stop hook: repo/session/label        ok");

  fs.rmSync(parent, { recursive: true, force: true });
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
