// Headless check of the review core — the modules that do not import vscode:
// lane resolution, git snapshot plumbing and the per-lane store. Run with
// `node test/smoke.js`.
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Git } = require("../out/git");
const { resolveLane } = require("../out/lanes");
const { Repos } = require("../out/repos");
const { makeAnchor, snapshotTurn } = require("../out/review");
const { Store } = require("../out/state");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "octoview-"));
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

async function main() {
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "a.py"), "def f(x: int) -> int:\n    return x\n");
  fs.writeFileSync(path.join(root, "b.py"), "KEEP = 1\n");
  // Tracked *and* gitignored, which real repos do (kraken pins .python-version this
  // way). An empty private index would skip it and report it deleted every turn.
  fs.writeFileSync(path.join(root, ".python-version"), "3.13\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".python-version\n");
  git(["add", "-f", "."]);
  git(["commit", "-qm", "base"]);

  // The user has staged b.py — their review progress marker. It must survive.
  fs.writeFileSync(path.join(root, "b.py"), "KEEP = 2\n");
  git(["add", "b.py"]);
  const statusBefore = git(["status", "--porcelain"]);
  const headBefore = git(["rev-parse", "HEAD"]).trim();

  const g = new Git(root);
  const lane = await resolveLane(root);
  const store = new Store(lane);
  await store.load();

  // Turn 1: agent edits a.py and adds c.py, neither staged.
  fs.writeFileSync(path.join(root, "a.py"), "def f(x: int) -> str:\n    return str(x)\n");
  fs.writeFileSync(path.join(root, "c.py"), "NEW = True\n");
  const r1 = await snapshotTurn(g, store, { label: "changed signature", agent: "manual" });
  assert.strictEqual(r1.created, true);
  assert.strictEqual(r1.turn.parent, headBefore, "turn 1 must diff against HEAD");

  // Turn 2: agent touches a.py again and adds d.py.
  fs.writeFileSync(path.join(root, "a.py"), "def f(x: int) -> str:\n    return f'{x}'\n");
  fs.writeFileSync(path.join(root, "d.py"), "LATER = 1\n");
  const r2 = await snapshotTurn(g, store, { label: "use f-string", agent: "manual" });
  assert.strictEqual(r2.created, true);

  // 1. The user's index and HEAD are untouched.
  assert.strictEqual(git(["status", "--porcelain"]).includes("M  b.py"), true, "staged b.py lost");
  assert.strictEqual(git(["rev-parse", "HEAD"]).trim(), headBefore, "HEAD moved");
  assert.strictEqual(git(["branch", "--list"]).trim(), "* main", "a branch appeared");
  console.log("index/HEAD untouched                 ok");
  console.log("  before:", JSON.stringify(statusBefore.trim().split("\n")));

  // 2. Turn-over-turn diff is the turn's own change, not the whole branch.
  const turn1 = r1.files.map((f) => f.path).sort();
  const turn2 = r2.files.map((f) => f.path).sort();
  assert.deepStrictEqual(turn1, ["a.py", "b.py", "c.py"], "a tracked-but-ignored file must not show as deleted");
  assert.deepStrictEqual(turn2, ["a.py", "d.py"], "turn 2 should not re-show turn 1 files");
  assert.strictEqual(await g.fileAt(r2.turn.sha, ".python-version"), "3.13\n", "tracked-but-ignored file dropped from the snapshot");
  console.log("turn 1 changed:", turn1.join(", "));
  console.log("turn 2 changed:", turn2.join(", "), "  <- c.py correctly absent");

  // 3. Revision content is retrievable for the diff's left-hand side.
  const atTurn1 = await g.fileAt(r1.turn.sha, "a.py");
  assert.ok(atTurn1.includes("return str(x)"), "turn 1 content wrong");
  assert.strictEqual(await g.fileAt(headBefore, "d.py"), "", "missing file should read empty");
  console.log("revision content + missing-file      ok");

  // 4. The Reviewable rule: reviewing at turn 1 does not carry into turn 2.
  await store.withLock((state) => {
    state.reviewed["a.py"] = 1;
  });
  assert.strictEqual(store.isReviewed("a.py", 1), true, "should be reviewed at turn 1");
  assert.strictEqual(store.isReviewed("a.py", 2), false, "turn 2 must reopen a.py");
  assert.strictEqual(store.isReviewed("d.py", 2), false);
  await store.withLock((state) => {
    state.reviewed["a.py"] = 2;
  });
  assert.strictEqual(store.isReviewed("a.py", 2), true);
  console.log("review state resets on later turn    ok");

  // 5. Submitting writes one batch and flips the drafts.
  const aLines = fs.readFileSync(path.join(root, "a.py"), "utf8").split("\n");
  const dLines = fs.readFileSync(path.join(root, "d.py"), "utf8").split("\n");
  const now = new Date().toISOString();
  const threadA = {
    id: "t1",
    anchor: await makeAnchor(g, r2.turn.sha, "a.py", 1, 1, aLines),
    turn: 2,
    state: "draft",
    outdated: false,
    comments: [{ body: "why f-string?", author: "me", at: now }],
  };
  const threadD = {
    id: "t2",
    anchor: await makeAnchor(g, r2.turn.sha, "d.py", 0, 0, dLines),
    turn: 2,
    state: "draft",
    outdated: false,
    comments: [{ body: "is this needed?", author: "me", at: now }],
  };
  await store.withLock((state) => {
    state.threads.push(threadA, threadD);
  });
  assert.strictEqual(store.pending.length, 2);
  const result = await store.submit();
  assert.strictEqual(result.count, 2);
  assert.strictEqual(store.pending.length, 0, "submit did not clear drafts");
  const written = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.strictEqual(written.comments.length, 2);
  assert.strictEqual(written.comments[0].line, 2, "line should be 1-based on the wire");
  assert.strictEqual(written.lane, "main", "the batch must say which lane it reviews");
  console.log("batch submit                         ok ->", path.basename(result.path));

  // 6. State survives a reload.
  const reloaded = new Store(lane);
  await reloaded.load();
  assert.strictEqual(reloaded.data.turns.length, 2);
  assert.strictEqual(reloaded.isReviewed("a.py", 2), true);
  assert.strictEqual(reloaded.data.threads.length, 2);
  console.log("state round-trips through disk       ok");

  // 7. Nothing leaked into the working tree, and the lock is not left behind.
  assert.strictEqual(git(["status", "--porcelain"]).includes("octoview"), false, "state leaked into git status");
  assert.strictEqual(fs.existsSync(store.lockFile), false, "lock file left behind");
  console.log("no working-tree pollution            ok");

  // 8. A workspace of several clones: every repo is its own review unit, and a
  //    folder that is not a repo root still resolves to the repo containing it.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "octoview-other-"));
  const og = (args) => execFileSync("git", args, { cwd: other, encoding: "utf8" });
  og(["init", "-q", "-b", "main", "."]);
  og(["config", "user.email", "t@t"]);
  og(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(other, "z.ts"), "export const z = 1;\n");
  og(["add", "."]);
  og(["commit", "-qm", "base"]);

  // git reports the physical path, so compare against that rather than the
  // possibly-symlinked temp path the OS handed us.
  const rootReal = fs.realpathSync(root);
  const otherReal = fs.realpathSync(other);

  const repos = new Repos();
  // The nested folder is deliberate: a `.vscode` directory added as its own
  // workspace folder must fold into its repo instead of being dropped or duplicated.
  fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
  await repos.discover([root, path.join(root, ".vscode"), other]);
  assert.deepStrictEqual(repos.all.map((r) => r.root).sort(), [otherReal, rootReal].sort(), "folders did not dedupe to two repos");
  console.log("workspace folders → repos            ok");

  const hit = repos.locate(path.join(rootReal, "a.py"));
  assert.strictEqual(hit.repo.root, rootReal, "a.py resolved to the wrong repo");
  assert.strictEqual(hit.rel, "a.py");
  assert.strictEqual(repos.locate(path.join(otherReal, "z.ts")).repo.root, otherReal, "z.ts resolved to the wrong repo");
  assert.strictEqual(repos.locate("/nowhere/x.py"), undefined, "a path outside every repo must not resolve");
  console.log("path → repo lookup                   ok");

  // 9. Turn history is per repo: the second clone starts empty even though the
  //    first has two turns, which is the bug a single global store produced.
  const first = repos.all.find((r) => r.root === rootReal);
  const second = repos.all.find((r) => r.root === otherReal);
  assert.strictEqual(first.store.data.turns.length, 2, "first repo lost its turns");
  assert.strictEqual(second.store.data.turns.length, 0, "second repo inherited the first repo's turns");

  fs.writeFileSync(path.join(other, "z.ts"), "export const z = 2;\n");
  const zResult = await snapshotTurn(second.git, second.store, { label: "bump z", agent: "manual" });
  assert.deepStrictEqual(zResult.files.map((f) => f.path), ["z.ts"]);
  assert.strictEqual(first.store.data.turns.length, 2, "snapshotting one repo disturbed another");
  console.log("per-repo turns stay isolated         ok");

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
