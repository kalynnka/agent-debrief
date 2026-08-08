// Headless check of lane resolution and the CLI contract, neither of which
// imports vscode. Run with `node test/cli.js`.
const assert = require("assert");
const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Git } = require("../out/git");
const { resolveLane } = require("../out/lanes");
const { hashLines, renderHistory, stackedHistory } = require("../out/review");
const { Store } = require("../out/state");

const cliPath = path.join(__dirname, "..", "out", "cli.js");
const debrief = (args, cwd, input) =>
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
const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "debrief-cli-")));
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
  console.log("main tree: lane = branch              ok");

  // 2. A linked worktree gets its own lane but the clone's shared .git — the
  //    foundation for lane-scoped refs not colliding across worktrees.
  const worktree = path.join(parent, "feature-wt");
  git(["worktree", "add", "-q", "-b", "feature", worktree]);
  const worktreeLane = await resolveLane(worktree);
  assert.strictEqual(worktreeLane.name, "feature");
  assert.strictEqual(worktreeLane.root, worktree);
  assert.strictEqual(worktreeLane.commonDir, path.join(root, ".git"));
  console.log("linked worktree: own lane, shared .git ok");

  // 3. Detached HEAD is a lane of its own, named by the commit. The directory
  //    name — what this used to fall back to — is the same for every detached
  //    checkout in a clone, so a `git bisect` run piled its steps into one lane,
  //    and a clone whose directory shares a name with a branch piled them into
  //    that branch's.
  git(["checkout", "-q", "--detach"]);
  assert.strictEqual(
    (await resolveLane(root)).name,
    `detached/${git(["rev-parse", "--short", "HEAD"]).trim()}`,
  );
  git(["checkout", "-q", "main"]);
  console.log("detached HEAD -> its own lane         ok");

  // 4. An unborn HEAD (fresh `git init`, no commits) still resolves its init
  //    branch — debrief's own repo is in exactly this state.
  const fresh = path.join(parent, "fresh");
  fs.mkdirSync(fresh);
  git(["init", "-q", "-b", "main", "."], fresh);
  assert.strictEqual((await resolveLane(fresh)).name, "main");
  console.log("unborn HEAD: init branch              ok");

  // 5. An explicit lane wins, and a non-repo is refused with a clear error.
  assert.strictEqual((await resolveLane(root, "pr/7")).name, "pr/7");
  const empty = path.join(parent, "empty");
  fs.mkdirSync(empty);
  await assert.rejects(resolveLane(empty), /not a git repository/);
  console.log("override + non-repo refusal           ok");

  // 6. The JSON envelope: exact shape, data on stdout, nothing on stderr.
  const json = debrief(["status", "--repo", root, "--json"], parent);
  assert.strictEqual(json.status, 0);
  assert.strictEqual(json.stderr, "");
  assert.deepStrictEqual(JSON.parse(json.stdout), {
    schemaVersion: 5,
    repo: root,
    lane: "main",
    snapshots: [],
  });
  console.log("status --json envelope                ok");

  // 7. The human summary, and --lane plumbed through to the payload.
  const human = debrief(["status"], root);
  assert.strictEqual(human.status, 0);
  assert.strictEqual(human.stdout.includes("lane:      main"), true);
  const overridden = debrief(["status", "--repo", root, "--lane", "pr/7", "--json"], root);
  assert.strictEqual(JSON.parse(overridden.stdout).lane, "pr/7");
  console.log("summary + --lane flag                 ok");

  // 8. Documented exit codes: 3 for an unresolvable repo (stderr only), 2 for
  //    usage errors.
  const notRepo = debrief(["status", "--json"], empty);
  assert.strictEqual(notRepo.status, 3);
  assert.strictEqual(notRepo.stdout, "");
  assert.strictEqual(notRepo.stderr.includes("not a git repository"), true);
  const unknownCommand = debrief(["bogus"], root);
  assert.strictEqual(unknownCommand.status, 2);
  const unknownFlag = debrief(["status", "--bogus"], root);
  assert.strictEqual(unknownFlag.status, 2);
  assert.strictEqual(unknownFlag.stderr.includes("usage:"), true);
  console.log("exit codes 3 and 2                    ok");

  // 9. Snapshot from the CLI: creates snapshot 1, is idempotent, shows up in status,
  //    and leaves the user's index, HEAD and branch list byte-identical — the
  //    §1.3 invariant with a staged file in play.
  fs.writeFileSync(path.join(root, "staged.txt"), "s\n");
  git(["add", "staged.txt"]);
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  const statusBefore = git(["status", "--porcelain"]);
  const headBefore = git(["rev-parse", "HEAD"]).trim();
  const branchesBefore = git(["branch", "--list"]);
  const snap1 = debrief(["snapshot", "--label", "add b", "--json"], root);
  assert.strictEqual(snap1.status, 0);
  const p1 = JSON.parse(snap1.stdout);
  assert.strictEqual(p1.created, true);
  assert.strictEqual(p1.snapshot.n, 1);
  assert.deepStrictEqual(p1.snapshot.files.map((f) => f.path).sort(), ["b.txt", "staged.txt"]);
  const again = JSON.parse(debrief(["snapshot", "--json"], root).stdout);
  assert.strictEqual(again.created, false, "an unchanged tree must not create a snapshot");
  const status9 = JSON.parse(debrief(["status", "--repo", root, "--json"], parent).stdout);
  assert.strictEqual(status9.snapshots.length, 1);
  assert.strictEqual(status9.snapshots[0].label, "add b");
  assert.strictEqual(status9.snapshots[0].agent, "manual");
  assert.strictEqual(git(["status", "--porcelain"]), statusBefore, "user's index/worktree disturbed");
  assert.strictEqual(git(["rev-parse", "HEAD"]).trim(), headBefore, "HEAD moved");
  assert.strictEqual(git(["branch", "--list"]), branchesBefore, "branch list changed");
  console.log("CLI snapshot + idempotence + invariant ok");

  // 10. A linked worktree snapshots through the clone's shared .git (the
  //     `.git`-is-a-file ENOTDIR bug), with its own numbering and its own refs.
  fs.writeFileSync(path.join(worktree, "wt.txt"), "w\n");
  const wsnap = JSON.parse(debrief(["snapshot", "--label", "wt change", "--json"], worktree).stdout);
  assert.strictEqual(wsnap.created, true);
  assert.strictEqual(wsnap.lane, "feature");
  assert.strictEqual(wsnap.snapshot.n, 1, "worktree numbering must be independent");
  const refs = git(["for-each-ref", "refs/debrief/snapshots", "--format=%(refname)"]);
  assert.strictEqual(refs.includes("refs/debrief/snapshots/main/1"), true);
  assert.strictEqual(refs.includes("refs/debrief/snapshots/feature/1"), true);
  assert.strictEqual(
    fs.existsSync(path.join(root, ".git", "debrief", "feature", "state.json")),
    true,
    "worktree state must live under the shared common dir",
  );
  console.log("worktree snapshot, lane-scoped refs   ok");

  // 11. A rename is one record carrying both paths, not a silently dropped pair.
  fs.renameSync(path.join(root, "a.txt"), path.join(root, "renamed.txt"));
  const rsnap = JSON.parse(debrief(["snapshot", "--label", "rename a", "--json"], root).stdout);
  assert.strictEqual(rsnap.snapshot.files.length, 1);
  assert.strictEqual(rsnap.snapshot.files[0].status, "R");
  assert.strictEqual(rsnap.snapshot.files[0].oldPath, "a.txt");
  assert.strictEqual(rsnap.snapshot.files[0].path, "renamed.txt");
  console.log("rename record: three fields           ok");

  // 12. show: content at a snapshot number, empty for a file absent there.
  const shown = debrief(["show", "1", "b.txt", "--repo", root], parent);
  assert.strictEqual(shown.status, 0);
  assert.strictEqual(shown.stdout, "b\n");
  const missing = debrief(["show", "1", "nope.txt", "--repo", root], parent);
  assert.strictEqual(missing.status, 0);
  assert.strictEqual(missing.stdout, "");
  const badSnapshot = debrief(["diff", "9", "--repo", root], parent);
  assert.strictEqual(badSnapshot.status, 3);
  console.log("show + missing file + bad snapshot    ok");

  // 13. A repo with no commits can be snapshotted: snapshot 1 has no commit parent,
  //     diffs against the empty tree, and still creates no branch.
  fs.writeFileSync(path.join(fresh, "first.txt"), "hello\n");
  const fsnap = JSON.parse(debrief(["snapshot", "--label", "first files", "--json"], fresh).stdout);
  assert.strictEqual(fsnap.created, true);
  assert.deepStrictEqual(fsnap.snapshot.files.map((f) => `${f.status} ${f.path}`), ["A first.txt"]);
  assert.strictEqual(git(["branch", "--list"], fresh).trim(), "", "a branch appeared in the unborn repo");
  const fagain = JSON.parse(debrief(["snapshot", "--json"], fresh).stdout);
  assert.strictEqual(fagain.created, false);
  console.log("unborn HEAD snapshot                  ok");

  // 14. Review round-trip at the CLI: a draft thread submits as one batch and
  //     comes back through `review batch`; a second submit has nothing to send.
  const g = new Git(root);
  const lane = await resolveLane(root);
  const store = new Store(lane);
  const blob = await g.blobAt(rsnap.snapshot.sha, "renamed.txt");
  await store.withLock((state) => {
    state.threads.push({
      id: "cli-t1",
      anchor: { file: "renamed.txt", startLine: 0, endLine: 0, blobSha: blob, contentHash: hashLines(["a"]) },
      snapshot: rsnap.snapshot.n,
      state: "draft",
      outdated: false,
      comments: [{ body: "why rename?", author: "me", at: new Date().toISOString() }],
    });
  });
  const draftOpen = JSON.parse(debrief(["review", "open", "--repo", root, "--json"], parent).stdout);
  assert.deepStrictEqual(
    draftOpen.threads.map((t) => t.id),
    ["cli-t1"],
    "a comment waits on the agent from the moment it is written, submitted or not",
  );
  const sub = JSON.parse(debrief(["review", "submit", "--repo", root, "--json"], parent).stdout);
  assert.strictEqual(sub.submitted, 1);
  const batch = JSON.parse(debrief(["review", "batch", "--repo", root, "--json"], parent).stdout);
  assert.strictEqual(batch.batch.comments.length, 1);
  assert.strictEqual(batch.batch.comments[0].file, "renamed.txt");
  assert.strictEqual(batch.batch.comments[0].line, 1);
  const subAgain = JSON.parse(debrief(["review", "submit", "--repo", root, "--json"], parent).stdout);
  assert.strictEqual(subAgain.submitted, 0);
  console.log("review submit -> batch round-trip     ok");

  // 14b. `review open` answers what one batch cannot: everything still waiting on
  //      the agent, however many submits it arrived over. `review resolve` is what
  //      makes that set shrink — without it the same comments print forever.
  const waiting = JSON.parse(debrief(["review", "open", "--repo", root, "--json"], parent).stdout);
  assert.deepStrictEqual(waiting.threads.map((t) => t.id), ["cli-t1"], "a submitted thread is open");
  const rendered = debrief(["review", "open", "--repo", root], parent).stdout;
  assert.ok(rendered.includes("renamed.txt:1  ["), "the reference is path:line, and 1-based");
  assert.ok(rendered.includes("  me: why rename?"), "with the comment under it");
  assert.ok(!rendered.includes("@renamed.txt"), "never the @-mention form — it types badly");

  const closed = JSON.parse(
    debrief(["review", "resolve", "cli-t1", "--repo", root, "--json"], parent).stdout,
  );
  assert.deepStrictEqual(closed.resolved, ["cli-t1"]);
  assert.deepStrictEqual(closed.unknown, []);
  const settled = JSON.parse(debrief(["review", "open", "--repo", root, "--json"], parent).stdout);
  assert.deepStrictEqual(settled.threads, [], "a resolved thread stops waiting");
  const reclosed = JSON.parse(
    debrief(["review", "resolve", "cli-t1", "nope", "--repo", root, "--json"], parent).stdout,
  );
  assert.deepStrictEqual(reclosed.resolved, [], "closing what is closed changes nothing");
  assert.deepStrictEqual(reclosed.unknown, ["cli-t1", "nope"], "a stale id is reported, not fatal");
  assert.strictEqual(
    debrief(["review", "resolve", "--repo", root], parent).status,
    2,
    "resolve with no id is a usage error",
  );
  console.log("review open -> resolve                ok");

  // 15. Carry-forward: a thread follows its lines when they move, and goes
  //     outdated when the lines themselves change.
  fs.writeFileSync(path.join(root, "code.txt"), "alpha\nbeta\ngamma\n");
  const csnap = JSON.parse(debrief(["snapshot", "--label", "add code", "--json"], root).stdout);
  const codeBlob = await g.blobAt(csnap.snapshot.sha, "code.txt");
  await store.withLock((state) => {
    state.threads.push({
      id: "cf-t1",
      anchor: { file: "code.txt", startLine: 1, endLine: 1, blobSha: codeBlob, contentHash: hashLines(["beta"]) },
      snapshot: csnap.snapshot.n,
      state: "draft",
      outdated: false,
      comments: [{ body: "beta?", author: "me", at: new Date().toISOString() }],
    });
  });
  fs.writeFileSync(path.join(root, "code.txt"), "intro\nalpha\nbeta\ngamma\n");
  debrief(["snapshot", "--label", "shift lines", "--json"], root);
  await store.load();
  const moved = store.data.threads.find((t) => t.id === "cf-t1");
  assert.strictEqual(moved.anchor.startLine, 2, "thread did not follow its lines");
  assert.strictEqual(moved.outdated, false);
  fs.writeFileSync(path.join(root, "code.txt"), "intro\nalpha\nBETA!\ngamma\n");
  debrief(["snapshot", "--label", "edit anchored line", "--json"], root);
  await store.load();
  const gone = store.data.threads.find((t) => t.id === "cf-t1");
  assert.strictEqual(gone.outdated, true, "changed lines must mark the thread outdated");
  console.log("carry-forward + outdated              ok");

  // 16. Two real writer processes lose no updates (the §12.1 lock), and two
  //     concurrent captures of the same change produce exactly one snapshot.
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

  const snapshotsBefore = store.data.snapshots.length;
  fs.writeFileSync(path.join(root, "race.txt"), "r\n");
  const [ra, rb] = await Promise.all([
    collect(spawn(process.execPath, [cliPath, "snapshot", "--label", "race", "--json"], { cwd: root })),
    collect(spawn(process.execPath, [cliPath, "snapshot", "--label", "race", "--json"], { cwd: root })),
  ]);
  assert.strictEqual(ra.code, 0);
  assert.strictEqual(rb.code, 0);
  const createdFlags = [JSON.parse(ra.out).created, JSON.parse(rb.out).created].sort();
  assert.deepStrictEqual(createdFlags, [false, true], "exactly one of two racing snapshots must win");
  await store.load();
  assert.strictEqual(store.data.snapshots.length, snapshotsBefore + 1);
  console.log("lock: no lost updates, one winner     ok");

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
  const hookRun = debrief(
    ["snapshot", "--from-stop-hook", "--json"],
    parent, // deliberately not the repo: the repo must come from the payload's cwd
    JSON.stringify({ session_id: "sess-123", transcript_path: transcript, cwd: root }),
  );
  assert.strictEqual(hookRun.status, 0, hookRun.stderr);
  const hp = JSON.parse(hookRun.stdout);
  assert.strictEqual(hp.created, true);
  assert.strictEqual(hp.repo, root);
  assert.strictEqual(hp.snapshot.agent, "claude");
  assert.strictEqual(hp.snapshot.session, "sess-123");
  assert.strictEqual(hp.snapshot.label, "I fixed strip_markdown to keep code fences.");
  const full = "I fixed strip_markdown to keep code fences.\n\nDetails follow.";
  await store.load();
  assert.strictEqual(
    store.data.snapshots.find((t) => t.n === hp.snapshot.n).message,
    full,
    "the whole message is kept, not only the line the label is cut from",
  );

  //     A label given on the command line wins, and the message is read anyway:
  //     the label can be the caller's, but the message is the agent's own.
  fs.writeFileSync(path.join(root, "hooked-again.txt"), "h\n");
  const labelled = debrief(
    ["snapshot", "--from-stop-hook", "--label", "mine", "--json"],
    parent,
    JSON.stringify({ session_id: "sess-123", transcript_path: transcript, cwd: root }),
  );
  assert.strictEqual(labelled.status, 0, labelled.stderr);
  const lp = JSON.parse(labelled.stdout);
  assert.strictEqual(lp.snapshot.label, "mine");
  await store.load();
  assert.strictEqual(store.data.snapshots.find((t) => t.n === lp.snapshot.n).message, full);
  console.log("stop hook: session, label, message    ok");

  //     The payload's own closing text is preferred over the transcript, and is
  //     enough on its own: a host that sends `last_assistant_message` never has
  //     its transcript opened. Both are sent here, and the payload's wins.
  const closingText = "chore: said in the payload\n\nPurpose: no file was read for this.";
  fs.writeFileSync(path.join(root, "spoken.txt"), "s\n");
  const fromPayload = debrief(
    ["snapshot", "--from-stop-hook", "--json"],
    parent,
    JSON.stringify({
      session_id: "sess-123",
      transcript_path: transcript,
      cwd: root,
      last_assistant_message: closingText,
    }),
  );
  assert.strictEqual(fromPayload.status, 0, fromPayload.stderr);
  const pp = JSON.parse(fromPayload.stdout);
  assert.strictEqual(pp.snapshot.label, "chore: said in the payload");
  await store.load();
  const payloadSnapshot = store.data.snapshots.find((t) => t.n === pp.snapshot.n);
  assert.strictEqual(payloadSnapshot.message, closingText, "the transcript was read instead");
  assert.strictEqual(
    payloadSnapshot.described,
    "transcript",
    "answered for by the hook however it was carried, so it must not read as the agent's own",
  );

  //     With no transcript_path at all — the shape a host that carries only the
  //     closing text sends — the snapshot is still named.
  fs.writeFileSync(path.join(root, "pathless.txt"), "p\n");
  const pathless = debrief(
    ["snapshot", "--from-stop-hook", "--json"],
    parent,
    JSON.stringify({ session_id: "sess-123", cwd: root, last_assistant_message: closingText }),
  );
  assert.strictEqual(pathless.status, 0, pathless.stderr);
  assert.strictEqual(JSON.parse(pathless.stdout).snapshot.label, "chore: said in the payload");

  //     An empty closing text names nothing, so it falls through to the scrape
  //     rather than leaving the snapshot with no sentence on it.
  fs.writeFileSync(path.join(root, "blank.txt"), "b\n");
  const blank = debrief(
    ["snapshot", "--from-stop-hook", "--json"],
    parent,
    JSON.stringify({
      session_id: "sess-123",
      transcript_path: transcript,
      cwd: root,
      last_assistant_message: "   \n",
    }),
  );
  assert.strictEqual(blank.status, 0, blank.stderr);
  assert.strictEqual(
    JSON.parse(blank.stdout).snapshot.label,
    "I fixed strip_markdown to keep code fences.",
  );
  console.log("stop hook: payload text beats scrape   ok");

  // 18. Stacked history: every line's lifecycle rendered in place as unified
  //     diff — a replaced value reads +bbb then -bbb where it lived, so the
  //     flow of the selected snapshots is readable top to bottom.
  const stack = path.join(parent, "stack");
  fs.mkdirSync(stack);
  git(["init", "-q", "-b", "main", "."], stack);
  git(["config", "user.email", "t@t"], stack);
  git(["config", "user.name", "t"], stack);
  fs.writeFileSync(path.join(stack, "f.txt"), "x\naaa\ny\n");
  git(["add", "."], stack);
  git(["commit", "-qm", "base"], stack);
  const stackHead = git(["rev-parse", "HEAD"], stack).trim();
  fs.writeFileSync(path.join(stack, "f.txt"), "x\nbbb\ny\n");
  const s1 = JSON.parse(debrief(["snapshot", "--label", "t1", "--json"], stack).stdout);
  fs.writeFileSync(path.join(stack, "f.txt"), "x\nn\nccc\ny\n");
  const s2 = JSON.parse(debrief(["snapshot", "--label", "t2", "--json"], stack).stdout);
  const stackGit = new Git(stack);
  const single = await stackedHistory(stackGit, "f.txt", stackHead, [s1.snapshot]);
  assert.strictEqual(
    renderHistory(single),
    " x\n-aaa\n+bbb\n y\n",
    "one snapshot renders as its plain diff",
  );
  const both = await stackedHistory(stackGit, "f.txt", stackHead, [s1.snapshot, s2.snapshot]);
  assert.strictEqual(
    renderHistory(both),
    " x\n-aaa\n+bbb\n-bbb\n+n\n+ccc\n y\n",
    "a superseded intermediate shows its arrival and its departure in place",
  );
  console.log("stacked history rendering             ok");

  // 19. `snapshot commit n`: snapshots 1..n become one commit, later snapshots stay on disk,
  //     the message is required, and staged work is protected without --force.
  fs.writeFileSync(path.join(stack, "later.txt"), "later\n");
  JSON.parse(debrief(["snapshot", "--label", "t3", "--json"], stack).stdout);
  const noMsg = debrief(["snapshot", "commit", "2"], stack);
  assert.strictEqual(noMsg.status, 2, "a commit without a message is a usage error");
  const noSnapshot = debrief(["snapshot", "commit", "99", "-m", "x"], stack);
  assert.strictEqual(noSnapshot.status, 3, "committing a snapshot that does not exist must fail");

  fs.writeFileSync(path.join(stack, "mine.txt"), "staged by the human\n");
  git(["add", "mine.txt"], stack);
  const refused = debrief(["snapshot", "commit", "2", "-m", "land t1-t2"], stack);
  assert.strictEqual(refused.status, 3, "staged work must not be silently replaced");
  assert.ok(refused.stderr.includes("--force"), "the refusal must name the way through");
  git(["restore", "--staged", "mine.txt"], stack);

  const landedOut = JSON.parse(
    debrief(["snapshot", "commit", "2", "-m", "land t1-t2", "--json"], stack).stdout,
  );
  assert.deepStrictEqual(landedOut.landed, [1, 2], "snapshots 1-2 land, snapshot 3 does not");
  assert.strictEqual(
    git(["show", "HEAD:f.txt"], stack),
    "x\nn\nccc\ny\n",
    "the commit holds snapshot 2's snapshot",
  );
  assert.strictEqual(
    fs.existsSync(path.join(stack, "later.txt")),
    true,
    "snapshot 3's file must stay in the working tree, uncommitted",
  );
  assert.strictEqual(
    git(["status", "--porcelain"], stack).includes("?? later.txt"),
    true,
    "snapshot 3 is what is left to commit",
  );
  console.log("snapshot commit lands a prefix        ok");

  // 20. The agent describes its own snapshot, and the hook is the backstop rather
  //     than the author: an agent-given message survives the hook firing after
  //     it, because an unchanged tree is never captured at all. And a
  //     snapshot recorded badly — the interrupted case, where the transcript's last
  //     word was a sentence from the middle of the work — can be said again
  //     afterwards without disturbing the snapshot.
  const told = path.join(parent, "told");
  fs.mkdirSync(told);
  git(["init", "-q", "-b", "main", "."], told);
  git(["config", "user.email", "t@t"], told);
  git(["config", "user.name", "t"], told);
  fs.writeFileSync(path.join(told, "f.txt"), "one\n");
  const spokenLabel = "feat: the snapshot says what it did";
  const spoken = "Why: the row said nothing.\nTests: 47 checks pass.";
  assert.strictEqual(
    debrief(["snapshot", "-m", spoken], told).status,
    2,
    "a message with no label is a usage error — a label is written, not sliced",
  );
  const own = JSON.parse(
    debrief(["snapshot", "--label", spokenLabel, "-m", spoken, "--json"], told).stdout,
  );
  assert.strictEqual(own.created, true);
  assert.strictEqual(own.snapshot.label, spokenLabel, "the label is the sentence that was given");
  assert.strictEqual(own.snapshot.message, spoken, "the message is kept whole, and holds no label");

  // The hook fires next, on a tree the agent already snapshotted: no second
  // snapshot, and nothing of what the agent said is overwritten.
  const transcript2 = path.join(parent, "told.jsonl");
  fs.writeFileSync(
    transcript2,
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Now the manifest —" }] },
    }),
  );
  const after = JSON.parse(
    debrief(
      ["snapshot", "--from-stop-hook", "--json"],
      parent,
      JSON.stringify({ session_id: "s", transcript_path: transcript2, cwd: told }),
    ).stdout,
  );
  assert.strictEqual(after.created, false, "the hook must pass through a snapshot already taken");
  const toldStore = new Store(await resolveLane(told));
  await toldStore.load();
  assert.strictEqual(toldStore.data.snapshots.length, 1, "no second snapshot for an unchanged tree");
  assert.strictEqual(toldStore.data.snapshots[0].message, spoken);

  // Now the interrupted shape: the hook takes the snapshot, and the transcript's
  // last word is mid-work. The next run says it properly.
  fs.writeFileSync(path.join(told, "f.txt"), "two\n");
  const cut = JSON.parse(
    debrief(
      ["snapshot", "--from-stop-hook", "--json"],
      parent,
      JSON.stringify({ session_id: "s", transcript_path: transcript2, cwd: told }),
    ).stdout,
  );
  assert.strictEqual(cut.snapshot.label, "Now the manifest —");
  const saidLabel = "fix: put the manifest clauses back";
  const said = "Why: the hook caught a sentence from the middle of the work.";
  assert.strictEqual(
    debrief(["snapshot", "describe", String(cut.snapshot.n), "-m", said], told).status,
    2,
    "describe needs a label too — it is the way back from a scraped one",
  );
  const fixed = JSON.parse(
    debrief(
      ["snapshot", "describe", String(cut.snapshot.n), "--label", saidLabel, "-m", said, "--json"],
      told,
    ).stdout,
  );
  assert.strictEqual(fixed.snapshot.label, saidLabel);
  assert.strictEqual(fixed.snapshot.message, said);
  assert.strictEqual(fixed.snapshot.sha, cut.snapshot.sha, "describing a snapshot must not move its snapshot");
  assert.strictEqual(fixed.snapshot.parent, cut.snapshot.parent);
  const absent = debrief(["snapshot", "describe", "999", "--label", "x", "-m", "x"], told);
  assert.strictEqual(absent.status, 3, "describing a snapshot that does not exist is a resolution error");
  const noMessage = debrief(["snapshot", "describe", "1"], told);
  assert.strictEqual(noMessage.status, 2, "describe without a message is a usage error");
  console.log("agent describes, hook backstops       ok");

  // 21. Provenance is what stands between a cut-off snapshot and a commit. A snapshot
  //     the hook answered for may be work in the middle of being done, and a
  //     commit takes its snapshot exactly as it stands — so committing one is
  //     refused until somebody has stood behind it.
  assert.strictEqual(own.snapshot.described, "agent", "an agent-given message is the agent's");
  assert.strictEqual(cut.snapshot.described, "transcript", "a scraped message is the hook's");
  assert.strictEqual(fixed.snapshot.described, "agent", "describing a snapshot answers for it");
  fs.writeFileSync(path.join(told, "f.txt"), "three\n");
  const scraped = JSON.parse(
    debrief(
      ["snapshot", "--from-stop-hook", "--json"],
      parent,
      JSON.stringify({ session_id: "s", transcript_path: transcript2, cwd: told }),
    ).stdout,
  );
  const blocked = debrief(["snapshot", "commit", String(scraped.snapshot.n), "-m", "x"], told);
  assert.strictEqual(blocked.status, 3, "committing an undescribed snapshot must be refused");
  assert.strictEqual(blocked.stderr.includes("cut off mid-change"), true, blocked.stderr);
  const commit = ["snapshot", "commit", String(scraped.snapshot.n), "-m", "x"];
  const forced = debrief([...commit, "--force", "--json"], told);
  assert.strictEqual(forced.status, 0, forced.stderr);
  // And the same snapshot, once described, needs no override at all.
  fs.writeFileSync(path.join(told, "f.txt"), "four\n");
  const nextCut = JSON.parse(
    debrief(
      ["snapshot", "--from-stop-hook", "--json"],
      parent,
      JSON.stringify({ session_id: "s", transcript_path: transcript2, cwd: told }),
    ).stdout,
  );
  debrief(
    [
      "snapshot",
      "describe",
      String(nextCut.snapshot.n),
      "--label",
      "chore: said properly",
      "-m",
      "Why: the hook had nothing better to go on.",
    ],
    told,
  );
  const allowed = debrief(["snapshot", "commit", String(nextCut.snapshot.n), "-m", "y", "--json"], told);
  assert.strictEqual(allowed.status, 0, allowed.stderr);
  console.log("a cut-off snapshot cannot land unseen ok");

  fs.rmSync(parent, { recursive: true, force: true });
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
