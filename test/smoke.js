// Headless check of the review core — the modules that do not import vscode:
// lane resolution, git snapshot plumbing and the per-lane store. Run with
// `node test/smoke.js`.
const assert = require("assert");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Git, baseRef, snapshotRef } = require("../out/git");
const { resolveLane } = require("../out/lanes");
const { RepoSelection, Repos } = require("../out/repos");
const {
  adoptLane,
  clearLane,
  committableRun,
  dropSnapshot,
  foreignPaths,
  landedCommits,
  landedSnapshots,
  makeAnchor,
  revertPaths,
  stashedSince,
  sweepLanes,
  takeSnapshot,
} = require("../out/review");
const { Store } = require("../out/state");
const { codeReferences, labelOf, noteBody } = require("../out/transcript");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-"));
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

async function main() {
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "a.py"), "def f(x: int) -> int:\n    return x\n");
  fs.writeFileSync(path.join(root, "b.py"), "KEEP = 1\n");
  // Tracked *and* gitignored, which real repos do (kraken pins .python-version this
  // way). An empty private index would skip it and report it deleted every snapshot.
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

  // Snapshot 1: agent edits a.py and adds c.py, neither staged.
  fs.writeFileSync(path.join(root, "a.py"), "def f(x: int) -> str:\n    return str(x)\n");
  fs.writeFileSync(path.join(root, "c.py"), "NEW = True\n");
  const r1 = await takeSnapshot(g, store, { label: "changed signature", agent: "manual" });
  assert.strictEqual(r1.created, true);
  assert.strictEqual(r1.snapshot.parent, headBefore, "snapshot 1 must diff against HEAD");

  // Snapshot 2: agent touches a.py again and adds d.py.
  fs.writeFileSync(path.join(root, "a.py"), "def f(x: int) -> str:\n    return f'{x}'\n");
  fs.writeFileSync(path.join(root, "d.py"), "LATER = 1\n");
  const r2 = await takeSnapshot(g, store, { label: "use f-string", agent: "manual" });
  assert.strictEqual(r2.created, true);

  // 1. The user's index and HEAD are untouched.
  assert.strictEqual(git(["status", "--porcelain"]).includes("M  b.py"), true, "staged b.py lost");
  assert.strictEqual(git(["rev-parse", "HEAD"]).trim(), headBefore, "HEAD moved");
  assert.strictEqual(git(["branch", "--list"]).trim(), "* main", "a branch appeared");
  console.log("index/HEAD untouched                  ok");
  console.log("  before:", JSON.stringify(statusBefore.trim().split("\n")));

  // 2. Snapshot-over-snapshot diff is the snapshot's own change, not the whole branch.
  const snapshot1 = r1.files.map((f) => f.path).sort();
  const snapshot2 = r2.files.map((f) => f.path).sort();
  assert.deepStrictEqual(snapshot1, ["a.py", "b.py", "c.py"], "a tracked-but-ignored file must not show as deleted");
  assert.deepStrictEqual(snapshot2, ["a.py", "d.py"], "snapshot 2 should not re-show snapshot 1 files");
  assert.strictEqual(await g.fileAt(r2.snapshot.sha, ".python-version"), "3.13\n", "tracked-but-ignored file dropped from the snapshot");
  console.log("snapshot 1 changed:", snapshot1.join(", "));
  console.log("snapshot 2 changed:", snapshot2.join(", "), "  <- c.py correctly absent");

  // 3. Revision content is retrievable for the diff's left-hand side.
  const atSnapshot1 = await g.fileAt(r1.snapshot.sha, "a.py");
  assert.ok(atSnapshot1.includes("return str(x)"), "snapshot 1 content wrong");
  assert.strictEqual(await g.fileAt(headBefore, "d.py"), "", "missing file should read empty");
  console.log("revision content + missing-file       ok");

  // 4. Marking a file read is off (MARKING, in state.ts). The marks already on
  //    disk are left exactly where they are — nothing is thrown away — and nothing
  //    reads them, so no file is hidden from a review or ticked in a tree row.
  await store.withLock((state) => {
    state.reviewed["a.py"] = 2;
  });
  assert.strictEqual(store.data.reviewed["a.py"], 2, "a mark is still recorded");
  assert.strictEqual(store.isReviewed("a.py", 2), false, "and is not read while marking is off");
  assert.strictEqual(store.isReviewed("a.py", 1), false);
  console.log("marking is off, marks are kept        ok");

  // 5. Submitting writes one batch and flips the drafts.
  const aLines = fs.readFileSync(path.join(root, "a.py"), "utf8").split("\n");
  const dLines = fs.readFileSync(path.join(root, "d.py"), "utf8").split("\n");
  const now = new Date().toISOString();
  const threadA = {
    id: "t1",
    anchor: await makeAnchor(g, r2.snapshot.sha, "a.py", 1, 1, aLines),
    snapshot: 2,
    state: "draft",
    outdated: false,
    comments: [{ body: "why f-string?", author: "me", at: now }],
  };
  const threadD = {
    id: "t2",
    anchor: await makeAnchor(g, r2.snapshot.sha, "d.py", 0, 0, dLines),
    snapshot: 2,
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
  assert.strictEqual(reloaded.data.snapshots.length, 2);
  assert.strictEqual(reloaded.data.reviewed["a.py"], 2);
  assert.strictEqual(reloaded.data.threads.length, 2);
  console.log("state round-trips through disk        ok");

  // 7. Nothing leaked into the working tree, and the lock is not left behind.
  assert.strictEqual(git(["status", "--porcelain"]).includes("debrief"), false, "state leaked into git status");
  assert.strictEqual(fs.existsSync(store.lockFile), false, "lock file left behind");
  console.log("no working-tree pollution             ok");

  // 8. A workspace of several clones: every repo is its own review unit, and a
  //    folder that is not a repo root still resolves to the repo containing it.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-other-"));
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
  console.log("workspace folders → repos             ok");

  const hit = repos.locate(path.join(rootReal, "a.py"));
  assert.strictEqual(hit.repo.root, rootReal, "a.py resolved to the wrong repo");
  assert.strictEqual(hit.rel, "a.py");
  assert.strictEqual(repos.locate(path.join(otherReal, "z.ts")).repo.root, otherReal, "z.ts resolved to the wrong repo");
  assert.strictEqual(repos.locate("/nowhere/x.py"), undefined, "a path outside every repo must not resolve");
  console.log("path → repo lookup                    ok");

  // The repository selector remembers what is *hidden*, so a repo it has never
  // been told about is shown — which is what makes a clone added tomorrow arrive
  // visible rather than silently absent.
  const rootRepo = repos.all.find((r) => r.root === rootReal);
  const otherRepo = repos.all.find((r) => r.root === otherReal);
  const showing = new RepoSelection();
  assert.ok(showing.shows(rootRepo) && showing.shows(otherRepo), "a fresh selection must show every repo");
  showing.set(otherReal, false);
  assert.ok(showing.shows(rootRepo), "hiding one repo hid another with it");
  assert.ok(!showing.shows(otherRepo), "the unchecked repo is still shown");
  assert.deepStrictEqual(showing.hiddenRoots, [otherReal], "the unchecked root was not remembered");
  // The workspace-state round trip: what was remembered is all it takes to restore.
  const restored = new RepoSelection(showing.hiddenRoots);
  assert.ok(!restored.shows(otherRepo), "the selection did not survive a reload");
  assert.ok(restored.shows(rootRepo), "a reload hid a repo that was never unchecked");
  restored.set(otherReal, true);
  assert.deepStrictEqual(restored.hiddenRoots, [], "checking a repo back on left its root behind");
  console.log("repository selector                   ok");

  // Which repos the tree draws — and the same set the badge counts over, which is
  // why it is one method. Both subtractions apply: the second clone is checked
  // here and still left out, because it has no snapshots to show.
  const fresh = new RepoSelection();
  assert.deepStrictEqual(repos.drawn(fresh).map((r) => r.root), [rootReal], "a repo with no snapshots was drawn");
  fresh.set(rootReal, false);
  assert.deepStrictEqual(repos.drawn(fresh), [], "unchecking the only repo with snapshots still drew it");
  console.log("drawn repos: shown, and non-empty     ok");

  // 9. Snapshot history is per repo: the second clone starts empty even though the
  //    first has two snapshots, which is the bug a single global store produced.
  const first = repos.all.find((r) => r.root === rootReal);
  const second = repos.all.find((r) => r.root === otherReal);
  assert.strictEqual(first.store.data.snapshots.length, 2, "first repo lost its snapshots");
  assert.strictEqual(second.store.data.snapshots.length, 0, "second repo inherited the first repo's snapshots");

  fs.writeFileSync(path.join(other, "z.ts"), "export const z = 2;\n");
  const zResult = await takeSnapshot(second.git, second.store, { label: "bump z", agent: "manual" });
  assert.deepStrictEqual(zResult.files.map((f) => f.path), ["z.ts"]);
  assert.strictEqual(first.store.data.snapshots.length, 2, "snapshotting one repo disturbed another");
  console.log("per-repo snapshots stay isolated      ok");

  // 10. Revert is offered only on the row whose version is still the one on disk,
  //     so the stack unwinds one snapshot at a time.
  const intact2 = await g.unchangedSince(r2.snapshot.sha, ["a.py", "d.py"]);
  assert.strictEqual(intact2.has("a.py"), true, "snapshot 2 holds a.py; its row should offer revert");
  assert.strictEqual(intact2.has("d.py"), true, "an untracked file the snapshot added counts as intact");
  const intact1 = await g.unchangedSince(r1.snapshot.sha, ["a.py", "c.py"]);
  assert.strictEqual(intact1.has("a.py"), false, "snapshot 2 wrote over snapshot 1's a.py");
  assert.strictEqual(intact1.has("c.py"), true, "nothing touched c.py since snapshot 1");

  await g.restoreFile(r2.snapshot.parent, "a.py");
  const reverted = fs.readFileSync(path.join(root, "a.py"), "utf8");
  assert.ok(reverted.includes("return str(x)"), "revert should land on snapshot 1's version");
  assert.strictEqual(
    (await g.unchangedSince(r2.snapshot.sha, ["a.py"])).has("a.py"),
    false,
    "snapshot 2's row must stop offering revert once undone",
  );
  assert.strictEqual(
    (await g.unchangedSince(r1.snapshot.sha, ["a.py"])).has("a.py"),
    true,
    "snapshot 1's row becomes the revertable one",
  );

  // A file the snapshot added is reverted by ceasing to exist.
  await g.restoreFile(r2.snapshot.parent, "d.py");
  assert.strictEqual(fs.existsSync(path.join(root, "d.py")), false, "added file should be removed");

  // The same on an untracked file the snapshot *changed* — git is picky about paths
  // it does not have in the index, and c.py has never been staged.
  fs.writeFileSync(path.join(root, "c.py"), "NEW = 'edited'\n");
  await g.restoreFile(r1.snapshot.sha, "c.py");
  assert.strictEqual(
    fs.readFileSync(path.join(root, "c.py"), "utf8"),
    "NEW = True\n",
    "an untracked file must revert to its snapshot content",
  );

  assert.strictEqual(git(["status", "--porcelain"]).includes("M  b.py"), true, "revert hit the index");
  console.log("revert unwinds one snapshot at a time ok");

  // A file back at the snapshot's starting point has had that snapshot's change undone,
  // so its row goes — measured against the snapshot's *parent* rather than its sha.
  // Snapshot 2's two files have both been put back, which leaves it showing nothing.
  const undone2 = await g.unchangedSince(r2.snapshot.parent, ["a.py", "d.py"]);
  assert.strictEqual(undone2.has("a.py"), true, "a reverted file still reads as changed");
  assert.strictEqual(undone2.has("d.py"), true, "a snapshot-added file, deleted again, is undone");
  const stillThere = await g.unchangedSince(r1.snapshot.parent, ["c.py"]);
  assert.strictEqual(stillThere.has("c.py"), false, "snapshot 1's c.py is untouched and must stay");

  // The count the snapshot row freezes on: files still differing from what the snapshot
  // started from. Snapshot 2 has been reverted away entirely; snapshot 1 has not.
  const liveOf = async (snapshot) => {
    const files = await g.changedFiles(snapshot.parent, snapshot.sha);
    const paths = files.map((f) => f.path);
    const [before, disk] = await Promise.all([g.blobsAt(snapshot.parent, paths), g.blobsOnDisk(paths)]);
    return paths.filter((p) => before.get(p) !== disk.get(p)).length;
  };
  assert.strictEqual(await liveOf(r2.snapshot), 0, "snapshot 2 should be frozen once reverted away");
  assert.strictEqual(await liveOf(r1.snapshot), 3, "snapshot 1 still owns a.py, b.py and c.py");
  // Second pass runs entirely off the caches; the answers must not move.
  assert.strictEqual(await liveOf(r2.snapshot), 0, "cached pass disagreed with the cold one");
  console.log("undone files drop out of the snapshot ok");

  // 11. Undoing a snapshot takes the snapshot itself off the stack, not just its files:
  //     ref, record, and the review marks it made. Its number comes back.
  assert.strictEqual(git(["rev-parse", "--verify", "-q", snapshotRef("main", 2)]).trim(), r2.snapshot.sha);
  assert.strictEqual(store.data.reviewed["a.py"], 2, "a.py was marked reviewed at snapshot 2");
  await dropSnapshot(g, store, 2);
  assert.deepStrictEqual(store.data.snapshots.map((t) => t.n), [1], "snapshot 2 still recorded");
  assert.throws(
    () => git(["rev-parse", "--verify", "-q", snapshotRef("main", 2)]),
    "snapshot 2's ref survived",
  );
  assert.strictEqual(store.data.reviewed["a.py"], undefined, "a review mark made at snapshot 2 outlived it");
  // Both threads were opened at snapshot 2 and submitted; the snapshot going takes them
  // with it, because a comment on a change that no longer exists is about nothing.
  assert.strictEqual(store.data.threads.length, 0, "threads outlived the snapshot they were about");
  // The batch already written stays: it is output that was handed over, and the
  // comment it carried is still in it.
  assert.strictEqual(JSON.parse(fs.readFileSync(result.path, "utf8")).comments.length, 2);

  // The next snapshot takes the number back, so the lane has no gap.
  fs.writeFileSync(path.join(root, "a.py"), "def f(x: int) -> str:\n    return repr(x)\n");
  const r3 = await takeSnapshot(g, store, { label: "after the undo", agent: "manual" });
  assert.strictEqual(r3.snapshot.n, 2, "numbering did not follow the stack down");
  assert.strictEqual(r3.snapshot.parent, r1.snapshot.sha, "the new snapshot 2 must build on snapshot 1");
  console.log("undo drops the snapshot, number returns ok");

  // 12. A snapshot in the middle can go too, as long as no later snapshot wrote over the
  //     files it changed. Snapshot 3 below touches only e.py, so snapshot 2's a.py is
  //     still snapshot 2's to give back — and dropping snapshot 2 must not disturb snapshot 3.
  fs.writeFileSync(path.join(root, "e.py"), "SEP = 1\n");
  const r4 = await takeSnapshot(g, store, { label: "disjoint file", agent: "manual" });
  assert.deepStrictEqual(r4.files.map((f) => f.path), ["e.py"]);
  assert.strictEqual(r4.snapshot.parent, r3.snapshot.sha, "snapshot 3 builds on snapshot 2");
  await store.withLock((state) => {
    state.reviewed["e.py"] = 3;
  });

  const midIntact = await g.unchangedSince(r3.snapshot.sha, ["a.py"]);
  assert.strictEqual(midIntact.has("a.py"), true, "no later snapshot touched a.py, so snapshot 2 can go");
  const midFiles = await g.changedFiles(r3.snapshot.parent, r3.snapshot.sha);
  await g.restoreFiles(r3.snapshot.parent, midFiles);
  await revertPaths(g, store, 2, midFiles.map((f) => f.path));
  await dropSnapshot(g, store, 2);
  assert.deepStrictEqual(store.data.snapshots.map((t) => t.n), [1, 3], "the gap should be honest");

  // The rewrite moved snapshot 3's sha, so read it back rather than trusting the
  // object the snapshot handed us — `withLock` reloads, and those are stale now.
  const snapshot3 = store.data.snapshots.find((t) => t.n === 3);
  // The dropped snapshot's commit survives as snapshot 3's git parent, so snapshot 3's own
  // diff still resolves — the reason a middle snapshot is safe to remove at all.
  assert.strictEqual(git(["cat-file", "-t", snapshot3.parent]).trim(), "commit");
  assert.deepStrictEqual(
    (await g.changedFiles(snapshot3.parent, snapshot3.sha)).map((f) => f.path),
    ["e.py"],
    "snapshot 3 lost its diff when the snapshot before it went",
  );
  assert.strictEqual(store.data.reviewed["e.py"], 3, "a later snapshot's review mark was cleared");
  console.log("a middle snapshot drops cleanly       ok");

  // 13. A revert must leave the newest snapshot agreeing with disk, or the next
  //     snapshot opens by recording the reviewer's revert as the agent's own work —
  //     the "D playground.md I never deleted" bug.
  fs.writeFileSync(path.join(root, "g.py"), "GONE = 1\n");
  fs.writeFileSync(path.join(root, "h.py"), "KEPT = 1\n");
  const added = await takeSnapshot(g, store, { label: "adds two files", agent: "manual" });
  fs.writeFileSync(path.join(root, "h.py"), "KEPT = 2\n");
  const later = await takeSnapshot(g, store, { label: "touches only h.py", agent: "manual" });

  // Revert g.py out of the *earlier* snapshot, with a later snapshot sitting on top of it.
  await g.restoreFile(added.snapshot.parent, "g.py");
  await revertPaths(g, store, added.snapshot.n, ["g.py"]);
  assert.strictEqual(fs.existsSync(path.join(root, "g.py")), false, "g.py should be gone");

  const rewritten = store.data.snapshots.find((t) => t.n === added.snapshot.n);
  const after = store.data.snapshots.find((t) => t.n === later.snapshot.n);
  assert.deepStrictEqual(
    (await g.changedFiles(rewritten.parent, rewritten.sha)).map((f) => f.path),
    ["h.py"],
    "the reverted file should be out of the snapshot that added it",
  );
  assert.deepStrictEqual(
    (await g.changedFiles(after.parent, after.sha)).map((f) => f.path),
    ["h.py"],
    "a later snapshot's own diff must survive the rewrite untouched",
  );
  assert.strictEqual(after.parent, rewritten.sha, "the chain must follow the new shas");
  assert.strictEqual(git(["cat-file", "-t", after.sha]).trim(), "commit");

  // The point of all of it: the next snapshot sees nothing to record.
  const nothing = await takeSnapshot(g, store, { label: "should not exist", agent: "manual" });
  assert.strictEqual(nothing.created, false, "the revert leaked into the next snapshot");
  console.log("revert stays out of the next snapshot ok");

  // 14. The review header's numbers. `--numstat -z` writes a rename as an empty
  //     path field followed by the old and new paths, which naive parsing reads
  //     as one record and gets the counts of the file after it.
  fs.writeFileSync(path.join(root, "h.py"), "KEPT = 3\nMORE = 1\n");
  fs.renameSync(path.join(root, "b.py"), path.join(root, "moved.py"));
  const counted = await takeSnapshot(g, store, { label: "edit and rename", agent: "manual" });
  const stat = await g.diffStat(counted.snapshot.parent, counted.snapshot.sha);
  assert.deepStrictEqual(stat.get("h.py"), { added: 2, deleted: 1 });
  assert.deepStrictEqual(stat.get("moved.py"), { added: 0, deleted: 0 }, "pure rename: no lines");
  assert.strictEqual(stat.has(""), false, "a rename must not be read as an empty path");
  console.log("diff stat counts, renames included    ok");

  // 15. Which snapshots a commit lands. The Snapshots view derives it rather than
  //     recording it: a file is committed when disk matches HEAD, and a snapshot is
  //     landed when every file it still *owns* is. Owns, not touched — otherwise
  //     a later snapshot editing the same file again would un-land a committed snapshot.
  const landedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-landed-"));
  const lg = (args) => execFileSync("git", args, { cwd: landedRoot, encoding: "utf8" });
  lg(["init", "-q", "-b", "main", "."]);
  lg(["config", "user.email", "t@t"]);
  lg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(landedRoot, "base.txt"), "0\n");
  lg(["add", "."]);
  lg(["commit", "-qm", "base"]);
  const lgit = new Git(landedRoot);
  const lstore = new Store(await resolveLane(landedRoot));
  const taken = [];
  fs.writeFileSync(path.join(landedRoot, "a.txt"), "a1\n");
  taken.push((await takeSnapshot(lgit, lstore, { label: "adds a", agent: "manual" })).snapshot);
  fs.writeFileSync(path.join(landedRoot, "b.txt"), "b1\n");
  taken.push((await takeSnapshot(lgit, lstore, { label: "adds b", agent: "manual" })).snapshot);

  // The reviewer commits snapshot 1's file only — the partial commit that makes
  // "which snapshots are committed" a real question.
  lg(["add", "a.txt"]);
  lg(["commit", "-qm", "land snapshot 1"]);

  const landedNow = async () => landedSnapshots(lgit, lstore.data.snapshots, await lgit.head());
  // What the activity-bar badge shows: the snapshots no commit has taken, which
  // is the Open area exactly. It has to fall to nothing once the lane has landed,
  // or the number never drops and stops being worth reading.
  const openNow = async () => {
    const done = await landedNow();
    return lstore.data.snapshots.filter((snapshot) => !done.has(snapshot.n)).length;
  };
  let landed = await landedNow();
  assert.deepStrictEqual([...landed], [1], "only snapshot 1's file is committed");
  assert.strictEqual(await openNow(), 1, "the badge must not count the snapshot already committed");

  // A third snapshot rewrites snapshot 1's file and is not committed. Snapshot 1 no longer
  // owns a.txt, so it stays landed — judging it on what it touched would flip it
  // back to open over work that is not its own.
  fs.writeFileSync(path.join(landedRoot, "a.txt"), "a2\n");
  await takeSnapshot(lgit, lstore, { label: "edits a again", agent: "manual" });
  landed = await landedNow();
  assert.strictEqual(landed.has(1), true, "a committed snapshot must not un-land");
  assert.strictEqual(landed.has(3), false, "the snapshot that owns a.txt now is open");
  assert.strictEqual(await openNow(), 2, "a new snapshot must put the badge back up");

  // `snapshot commit` is the same answer from the other side: commit through snapshot 3
  // and every snapshot lands, with the working tree never having moved.
  await lgit.commitSnapshot(lstore.data.snapshots[2].sha, "land everything");
  assert.deepStrictEqual([...(await landedNow())].sort(), [1, 2, 3], "all snapshots land");
  assert.strictEqual(lg(["status", "--porcelain"]).trim(), "", "the commit must match disk");
  assert.strictEqual(await openNow(), 0, "a fully committed lane must leave no badge");
  console.log("commit lands the snapshots it covers  ok");

  // 16. How far the Reviewed area can be committed from. A commit is a prefix of
  //     the lane, so an unbroken run from the earliest snapshot is the whole rule —
  //     and adjacency is in the list, never in the numbering, or one dropped snapshot
  //     would block committing for the rest of the lane's life.
  const run = (spec) => committableRun(spec.map(([n, reviewed]) => ({ n, reviewed })));
  assert.deepStrictEqual(run([]), { through: undefined, blocked: [] });
  assert.deepStrictEqual(run([[1, true], [2, true], [3, true]]), { through: 3, blocked: [] });
  assert.deepStrictEqual(run([[1, false], [2, true]]), { through: undefined, blocked: [2] });
  assert.deepStrictEqual(run([[1, true], [2, false], [3, true], [4, true]]), {
    through: 1,
    blocked: [3, 4],
  });
  // Snapshot 2 was dropped; 1 and 3 are adjacent in the list and commit together.
  assert.deepStrictEqual(run([[1, true], [3, true]]), { through: 3, blocked: [] });
  console.log("committable run is a list prefix      ok");

  // 17. The regression the screenshot caught: a snapshot whose files a later snapshot
  //     rewrote owns nothing, and "every file it owns matches HEAD" is vacuously
  //     true — which read as committed in a repo with no commits of its own.
  const neverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-never-"));
  const ng = (args) => execFileSync("git", args, { cwd: neverRoot, encoding: "utf8" });
  ng(["init", "-q", "-b", "main", "."]);
  ng(["config", "user.email", "t@t"]);
  ng(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(neverRoot, "x.txt"), "0\n");
  ng(["add", "."]);
  ng(["commit", "-qm", "base"]);
  const ngit = new Git(neverRoot);
  const nstore = new Store(await resolveLane(neverRoot));
  fs.writeFileSync(path.join(neverRoot, "x.txt"), "1\n");
  await takeSnapshot(ngit, nstore, { label: "sets x to 1", agent: "manual" });
  fs.writeFileSync(path.join(neverRoot, "x.txt"), "2\n");
  await takeSnapshot(ngit, nstore, { label: "sets x to 2", agent: "manual" });
  assert.deepStrictEqual(
    [...(await landedSnapshots(ngit, nstore.data.snapshots, await ngit.head()))],
    [],
    "no commit was made, so no snapshot may read as committed",
  );
  fs.rmSync(neverRoot, { recursive: true, force: true });
  console.log("a superseded snapshot is not committed ok");

  // 18. Two commits, read back as two groups. A commit made from a snapshot's
  //     snapshot has that snapshot's tree, so which snapshots it took is recognised
  //     rather than recorded — and committing through 2 then through 4 must not
  //     collapse into one run of four.
  const twoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-two-"));
  const tg = (args) => execFileSync("git", args, { cwd: twoRoot, encoding: "utf8" });
  tg(["init", "-q", "-b", "main", "."]);
  tg(["config", "user.email", "t@t"]);
  tg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(twoRoot, "base.txt"), "0\n");
  tg(["add", "."]);
  tg(["commit", "-qm", "base"]);
  const tgit = new Git(twoRoot);
  const tstore = new Store(await resolveLane(twoRoot));
  for (const n of [1, 2, 3, 4]) {
    fs.writeFileSync(path.join(twoRoot, `f${n}.txt`), `${n}\n`);
    await takeSnapshot(tgit, tstore, { label: `snapshot ${n}`, agent: "manual" });
  }
  await tgit.commitSnapshot(tstore.data.snapshots[1].sha, "first batch\n\nwith a body line");
  await tgit.commitSnapshot(tstore.data.snapshots[3].sha, "second batch");
  const groups = await landedCommits(tgit, tstore.data.snapshots, await tgit.head());
  assert.strictEqual(groups.length, 2, "two commits must read back as two groups");
  assert.deepStrictEqual(groups[0].snapshots, [1, 2], "the older commit took snapshots 1-2");
  assert.deepStrictEqual(groups[1].snapshots, [3, 4], "the newer commit took only 3-4");
  assert.strictEqual(groups[0].message.split("\n")[0], "first batch", "subject is the first line");
  assert.ok(groups[0].message.includes("with a body line"), "the full message is carried");
  fs.rmSync(twoRoot, { recursive: true, force: true });
  console.log("commits read back as their own groups ok");

  // 19. The reviewer's own workflow: stage what you have read, commit that, keep
  //     going. Such a commit holds no snapshot's tree, so tree equality saw none
  //     of them — a lane could be committed to the last file and still read as
  //     entirely uncommitted (docs/GIT.md D1).
  const handRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-hand-"));
  const hg = (args) => execFileSync("git", args, { cwd: handRoot, encoding: "utf8" });
  hg(["init", "-q", "-b", "main", "."]);
  hg(["config", "user.email", "t@t"]);
  hg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(handRoot, "base.txt"), "0\n");
  hg(["add", "."]);
  hg(["commit", "-qm", "base"]);
  const hgit = new Git(handRoot);
  const hstore = new Store(await resolveLane(handRoot));
  const wrote = (file, text) => fs.writeFileSync(path.join(handRoot, file), text);
  wrote("a.txt", "a1\n");
  wrote("b.txt", "b1\n");
  await takeSnapshot(hgit, hstore, { label: "writes a and b", agent: "manual" });
  wrote("b.txt", "b2\n");
  await takeSnapshot(hgit, hstore, { label: "writes b again", agent: "manual" });
  const handLanded = async () =>
    [...(await landedSnapshots(hgit, hstore.data.snapshots, await hgit.head()))];

  // Half of snapshot 1 committed. Its own work is not all in, so it has not landed.
  hg(["add", "a.txt"]);
  hg(["commit", "-qm", "the half I had read"]);
  assert.deepStrictEqual(await handLanded(), [], "a half-committed snapshot has not landed");

  // The rest. Snapshot 1's b.txt is committed as snapshot 2 left it, not as
  // snapshot 1 left it — a change written over by later work still reached the
  // branch, so both snapshots land, and they land together.
  hg(["add", "b.txt"]);
  hg(["commit", "-qm", "the rest"]);
  assert.deepStrictEqual(await handLanded(), [1, 2], "the rest lands both snapshots");
  const handGroups = await landedCommits(hgit, hstore.data.snapshots, await hgit.head());
  assert.strictEqual(handGroups.length, 1, "one commit completed them, so one group");
  assert.strictEqual(
    handGroups[0].message.split("\n")[0],
    "the rest",
    "credited to the commit that completed them, not the one that started",
  );
  fs.rmSync(handRoot, { recursive: true, force: true });
  console.log("a hand-staged commit lands its work  ok");

  // 20. Lanes follow branches (docs/GIT.md D2, D4). A branch cut mid-review is the
  //     same work under a new name, so the review comes with it; a branch that has
  //     moved since it was created is its own line of work and must inherit
  //     nothing; a rename moves the lane rather than abandoning it; and a detached
  //     HEAD gets a lane of its own instead of borrowing the directory's name.
  const cutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-cut-"));
  const cg = (args) => execFileSync("git", args, { cwd: cutRoot, encoding: "utf8" });
  cg(["init", "-q", "-b", "main", "."]);
  cg(["config", "user.email", "t@t"]);
  cg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(cutRoot, "x.txt"), "0\n");
  cg(["add", "."]);
  cg(["commit", "-qm", "base"]);
  const cgit = new Git(cutRoot);
  const cmain = new Store(await resolveLane(cutRoot));
  for (const text of ["1\n", "2\n"]) {
    fs.writeFileSync(path.join(cutRoot, "x.txt"), text);
    await takeSnapshot(cgit, cmain, { label: `sets x to ${text.trim()}`, agent: "manual" });
  }
  await cmain.withLock((state) => {
    state.reviewed["x.txt"] = 1;
  });

  cg(["switch", "-qc", "feat/carry"]);
  const carried = await resolveLane(cutRoot);
  assert.strictEqual(carried.name, "feat/carry", "the lane is the new branch");
  await adoptLane(cgit, carried);
  const cstore = new Store(carried);
  await cstore.load();
  assert.strictEqual(cstore.data.snapshots.length, 2, "a cut branch inherits the lane");
  assert.strictEqual(cstore.data.reviewed["x.txt"], 1, "and what had already been read");
  assert.strictEqual(
    cg(["rev-parse", snapshotRef("feat/carry", 2)]).trim(),
    cstore.data.snapshots[1].sha,
    "with refs pointing at the same commits, not rebuilt ones",
  );

  // A branch with a commit of its own is no longer where it was cut.
  cg(["switch", "-qc", "feat/moved"]);
  fs.writeFileSync(path.join(cutRoot, "y.txt"), "y\n");
  cg(["add", "."]);
  cg(["commit", "-qm", "its own work"]);
  const movedLane = await resolveLane(cutRoot);
  await adoptLane(cgit, movedLane);
  const mstore = new Store(movedLane);
  await mstore.load();
  assert.strictEqual(mstore.data.snapshots.length, 0, "a branch that moved on inherits nothing");

  // A rename takes the lane with it and leaves nothing under the old name.
  cg(["switch", "-q", "feat/carry"]);
  cg(["branch", "-m", "feat/carry", "feat/renamed"]);
  const renamedLane = await resolveLane(cutRoot);
  assert.strictEqual(renamedLane.name, "feat/renamed");
  await adoptLane(cgit, renamedLane);
  const rstore = new Store(renamedLane);
  await rstore.load();
  assert.strictEqual(rstore.data.snapshots.length, 2, "a rename moves the lane");
  assert.ok(
    !fs.existsSync(path.join(cutRoot, ".git", "debrief", "feat", "carry")),
    "and leaves no state behind under the old name",
  );
  assert.strictEqual(
    cg(["for-each-ref", "--format=%(refname)", "refs/debrief/snapshots/feat/carry"]).trim(),
    "",
    "nor any refs",
  );

  cg(["switch", "-q", "--detach", "HEAD"]);
  assert.strictEqual(
    (await resolveLane(cutRoot)).name,
    `detached/${cg(["rev-parse", "--short", "HEAD"]).trim()}`,
    "a detached HEAD is its own lane, named by the commit it sits on",
  );
  fs.rmSync(cutRoot, { recursive: true, force: true });
  console.log("lanes follow branches                 ok");

  // 21. Retention is git's, not ours (docs/GIT.md D2). A snapshot ref is a GC
  //     root, so a lane left behind by a deleted branch pins its objects against
  //     even `gc --prune=now`. Letting go of the ref is the whole act; from there
  //     git decides, and a real cleanup takes branch and snapshots together.
  const gcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-gc-"));
  const gg = (args) => execFileSync("git", args, { cwd: gcRoot, encoding: "utf8" });
  gg(["init", "-q", "-b", "main", "."]);
  gg(["config", "user.email", "t@t"]);
  gg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(gcRoot, "f.txt"), "0\n");
  gg(["add", "."]);
  gg(["commit", "-qm", "base"]);
  const ggit = new Git(gcRoot);
  gg(["switch", "-qc", "doomed"]);
  const doomed = await resolveLane(gcRoot);
  fs.writeFileSync(path.join(gcRoot, "f.txt"), "1\n");
  const dsnap = await takeSnapshot(ggit, new Store(doomed), { label: "work", agent: "manual" });
  const common = doomed.commonDir;

  assert.deepStrictEqual(
    await sweepLanes(ggit, common, false),
    { closed: [], collected: [], stray: [] },
    "a lane whose branch is alive is never swept",
  );

  gg(["switch", "-q", "main"]);
  gg(["branch", "-qD", "doomed"]);
  gg(["gc", "--prune=now", "-q"]);
  assert.strictEqual(
    await ggit.has(dsnap.snapshot.sha),
    true,
    "our ref is a GC root — git cannot collect the snapshot while we hold it",
  );

  assert.deepStrictEqual(
    await sweepLanes(ggit, common, false),
    { closed: ["doomed"], collected: [], stray: [] },
    "the dead lane is found",
  );
  assert.strictEqual(
    await ggit.refExists(snapshotRef("doomed", 1)),
    true,
    "and a dry run changes nothing",
  );

  await sweepLanes(ggit, common, true);
  assert.strictEqual(await ggit.refExists(snapshotRef("doomed", 1)), false, "the ref is let go");
  assert.strictEqual(
    await ggit.has(dsnap.snapshot.sha),
    true,
    "but nothing is deleted — the snapshot is an ordinary unreachable object now",
  );
  assert.ok(
    fs.existsSync(path.join(doomed.dir, "state.json")),
    "and the record stays, holding the sha the lane could be put back from",
  );

  gg(["gc", "--prune=now", "-q"]);
  assert.strictEqual(await ggit.has(dsnap.snapshot.sha), false, "the real cleanup takes it");
  assert.deepStrictEqual(
    await sweepLanes(ggit, common, true),
    { closed: [], collected: ["doomed"], stray: [] },
    "and only then is there nothing left to review",
  );
  assert.ok(!fs.existsSync(doomed.dir), "so the record goes with its snapshots");
  fs.rmSync(gcRoot, { recursive: true, force: true });
  console.log("retention is git's, not ours          ok");

  // 22. Attribution (docs/GIT.md D3). A snapshot diffs against the snapshot before
  //     it, never against HEAD, so anything that moves HEAD in between is invisible
  //     in the diff — which is how a `git pull` ends up recorded as the agent's
  //     work. HEAD is on the record now, and a worktree part-way through a merge
  //     is not anybody's work yet, so it is refused rather than captured.
  const midRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-mid-"));
  const mg = (args) => execFileSync("git", args, { cwd: midRoot, encoding: "utf8" });
  mg(["init", "-q", "-b", "main", "."]);
  mg(["config", "user.email", "t@t"]);
  mg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(midRoot, "shared.txt"), "base\n");
  mg(["add", "."]);
  mg(["commit", "-qm", "base"]);
  const mgit = new Git(midRoot);
  const mstore2 = new Store(await resolveLane(midRoot));
  fs.writeFileSync(path.join(midRoot, "agent.txt"), "agent work\n");
  const before = await takeSnapshot(mgit, mstore2, { label: "agent work", agent: "manual" });
  assert.strictEqual(before.created, true);
  assert.strictEqual(before.snapshot.head, mg(["rev-parse", "HEAD"]).trim(), "HEAD is recorded");

  // Someone else's commit arrives while the agent is working.
  mg(["switch", "-qc", "theirs", "HEAD"]);
  fs.writeFileSync(path.join(midRoot, "shared.txt"), "theirs\n");
  mg(["commit", "-qam", "their change"]);
  mg(["switch", "-q", "main"]);
  mg(["merge", "-q", "--no-edit", "theirs"]);
  fs.writeFileSync(path.join(midRoot, "agent.txt"), "more agent work\n");
  const merged = await takeSnapshot(mgit, mstore2, { label: "more", agent: "manual" });
  assert.strictEqual(merged.created, true);
  assert.notStrictEqual(
    merged.snapshot.head,
    before.snapshot.head,
    "the merge moved HEAD under snapshot 2, and the record says so",
  );

  // A conflicted merge: the worktree is git's, not the agent's.
  mg(["switch", "-qc", "conflict", "HEAD~1"]);
  fs.writeFileSync(path.join(midRoot, "shared.txt"), "conflicting\n");
  mg(["commit", "-qam", "conflicting change"]);
  const merge = spawnSync("git", ["merge", "--no-edit", "main"], { cwd: midRoot, encoding: "utf8" });
  assert.notStrictEqual(merge.status, 0, "the merge must actually conflict for this to test anything");
  assert.strictEqual(await mgit.operationInProgress(), "a merge");
  const refused = await takeSnapshot(mgit, new Store(await resolveLane(midRoot)), {
    label: "should not happen",
    agent: "manual",
  });
  assert.strictEqual(refused.created, false, "no snapshot is taken mid-merge");
  assert.strictEqual(refused.reason, "mid-operation", "and the reason is not 'unchanged'");
  mg(["merge", "--abort"]);
  assert.strictEqual(await mgit.operationInProgress(), undefined, "and it clears when git is done");
  mg(["switch", "-q", "main"]);

  // 23. The subtraction (docs/GIT.md D3b). shared.txt arrived with the merge and
  //     the snapshot holds it exactly as the merge left it, so it is not the
  //     agent's. agent.txt the agent wrote itself. A file the agent edited *after*
  //     the merge stays theirs — the top layer is the one that counts, since
  //     hiding a real edit is the failure worth avoiding.
  const all2 = mstore2.data.snapshots;
  const brought = await foreignPaths(mgit, all2, all2[1]);
  assert.ok(brought.has("shared.txt"), "the merge's file is not the agent's");
  assert.ok(!brought.has("agent.txt"), "the agent's own file stays theirs");
  assert.deepStrictEqual(
    [...(await foreignPaths(mgit, all2, all2[0]))],
    [],
    "nothing is foreign when HEAD did not move",
  );

  fs.writeFileSync(path.join(midRoot, "shared.txt"), "agent edited the merged file\n");
  const third = await takeSnapshot(mgit, mstore2, { label: "edit after merge", agent: "manual" });
  assert.strictEqual(third.created, true);
  assert.deepStrictEqual(
    [...(await foreignPaths(mgit, mstore2.data.snapshots, third.snapshot))],
    [],
    "HEAD did not move under snapshot 3, so nothing there is the merge's",
  );
  fs.rmSync(midRoot, { recursive: true, force: true });
  console.log("mid-merge is nobody's work            ok");

  // 24. `git stash` is the one thing that makes every snapshot look reverted
  //     without anything being reverted (docs/GIT.md D5's residue). Debrief cannot
  //     tell it from a real revert by looking at the tree, so it asks the one
  //     question it can answer: has the stash moved since the last snapshot?
  const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-stash-"));
  const sg = (args) => execFileSync("git", args, { cwd: stashRoot, encoding: "utf8" });
  sg(["init", "-q", "-b", "main", "."]);
  sg(["config", "user.email", "t@t"]);
  sg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(stashRoot, "s.txt"), "base\n");
  sg(["add", "."]);
  sg(["commit", "-qm", "base"]);
  const sgit = new Git(stashRoot);
  const sstore = new Store(await resolveLane(stashRoot));
  fs.writeFileSync(path.join(stashRoot, "s.txt"), "agent work\n");
  const stashed = await takeSnapshot(sgit, sstore, { label: "work", agent: "manual" });
  assert.strictEqual(stashed.created, true);
  assert.strictEqual(stashed.snapshot.stash, "", "no stash yet, and that is not the same as unknown");
  assert.strictEqual(await stashedSince(sgit, sstore), false, "nothing has happened yet");

  sg(["stash", "-q"]);
  assert.strictEqual(
    (await sgit.unchangedSince(stashed.snapshot.parent, ["s.txt"])).has("s.txt"),
    true,
    "the stash put the file back — which is exactly what a revert looks like",
  );
  assert.strictEqual(await stashedSince(sgit, sstore), true, "but the stash moved, and that shows");

  sg(["stash", "pop", "-q"]);
  assert.strictEqual(
    await stashedSince(sgit, sstore),
    false,
    "popping empties the stash back to where the snapshot found it",
  );

  // A snapshot from before the field exists says nothing rather than guessing: a
  // false alarm on every old lane would teach people to ignore the real one.
  await sstore.withLock((state) => {
    delete state.snapshots[state.snapshots.length - 1].stash;
  });
  sg(["stash", "-q"]);
  assert.strictEqual(
    await stashedSince(sgit, sstore),
    false,
    "an unrecorded stash tip is unknown, not zero",
  );
  fs.rmSync(stashRoot, { recursive: true, force: true });
  console.log("a stash is not a revert               ok");
  console.log("a merge's files are not the agent's   ok");

  // 25. Letting go of the lane you are standing on. The sweep waits for a branch
  //     to die; this is the same act asked for outright, and it goes further —
  //     the record is emptied too, so nothing anywhere remembers the shas. What it
  //     still does not do is delete an object: git decides that, as always.
  const clearRoot = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-clear-"));
  const clg = (args) => execFileSync("git", args, { cwd: clearRoot, encoding: "utf8" });
  clg(["init", "-q", "-b", "main", "."]);
  clg(["config", "user.email", "t@t"]);
  clg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(clearRoot, "c.txt"), "base\n");
  clg(["add", "."]);
  clg(["commit", "-qm", "base"]);
  const clgit = new Git(clearRoot);
  const clane = await resolveLane(clearRoot);
  const clstore = new Store(clane);
  // Work already in the tree and nothing to do with any agent — the shape that
  // made this a bug: it must not turn up in the next snapshot after a clear.
  fs.writeFileSync(path.join(clearRoot, "d.txt"), "mine, from before\n");
  fs.writeFileSync(path.join(clearRoot, "c.txt"), "one\n");
  const c1 = await takeSnapshot(clgit, clstore, { label: "one", agent: "manual" });
  fs.writeFileSync(path.join(clearRoot, "c.txt"), "two\n");
  const c2 = await takeSnapshot(clgit, clstore, { label: "two", agent: "manual" });
  await clstore.withLock((state) => {
    state.reviewed["c.txt"] = 1;
    state.threads.push({
      id: "t1",
      anchor: { file: "c.txt", startLine: 0, endLine: 0, blobSha: "", contentHash: "" },
      snapshot: 1,
      state: "draft",
      outdated: false,
      comments: [],
    });
  });

  assert.deepStrictEqual(
    await clearLane(clgit, clstore),
    { dropped: 2, based: true },
    "both snapshots are let go, and the dirty tree leaves a starting point behind",
  );
  assert.strictEqual(await clgit.refExists(snapshotRef(clane.name, 1)), false, "ref 1 is gone");
  assert.strictEqual(await clgit.refExists(snapshotRef(clane.name, 2)), false, "ref 2 is gone");
  assert.deepStrictEqual(clstore.data.snapshots, [], "and the record with them");
  assert.deepStrictEqual(clstore.data.reviewed, {}, "marks that name no snapshot are not kept");
  assert.deepStrictEqual(clstore.data.threads, [], "nor threads anchored to one");
  assert.strictEqual(
    await clgit.has(c2.snapshot.sha),
    true,
    "debrief deleted no object — the commits are unreachable, not gone",
  );
  clg(["gc", "--prune=now", "-q"]);
  assert.strictEqual(await clgit.has(c1.snapshot.sha), false, "git is what collects them");

  // The clearing left one thing: where the lane now starts. Without it the next
  // snapshot falls back to HEAD and opens by claiming every uncommitted change
  // already in the tree — which is what a Stop hook did to a cleared lane holding
  // a branch's worth of work in progress.
  assert.strictEqual(
    await clgit.refExists(baseRef(clane.name)),
    true,
    "the base ref survives a gc, exactly as a snapshot ref does",
  );
  assert.strictEqual(await clgit.has(clstore.data.base), true, "and so does what it points at");

  fs.writeFileSync(path.join(clearRoot, "c.txt"), "three\n");
  const c3 = await takeSnapshot(clgit, clstore, { label: "three", agent: "manual" });
  assert.strictEqual(c3.snapshot.n, 1, "an empty lane numbers from 1 again");
  assert.strictEqual(c3.snapshot.parent, clstore.data.base, "but it starts from the clearing");
  assert.notStrictEqual(
    c3.snapshot.parent,
    clg(["rev-parse", "HEAD"]).trim(),
    "and not from HEAD, which is the whole point",
  );
  assert.deepStrictEqual(
    c3.files.map((f) => f.path),
    ["c.txt"],
    "so it holds what changed since the clearing, and not d.txt, which was already there",
  );

  // A clean tree has nothing to record: HEAD already says where the lane starts.
  clg(["add", "."]);
  clg(["commit", "-qm", "land it"]);
  assert.deepStrictEqual(
    await clearLane(clgit, clstore),
    { dropped: 1, based: false },
    "a clean tree needs no baseline",
  );
  assert.strictEqual(clstore.data.base, undefined, "and does not keep one");
  assert.strictEqual(
    await clgit.refExists(baseRef(clane.name)),
    false,
    "the previous lane's baseline goes with the clearing that replaces it",
  );
  fs.rmSync(clearRoot, { recursive: true, force: true });
  console.log("a lane can be let go on purpose       ok");

  // 26. The label is its own sentence, so a note shows it above the message. Every
  //     snapshot recorded before that — and every one the hook still scrapes, since
  //     a transcript offers nothing else — has the label as its own first line, and
  //     would say it twice the moment the two are shown together.
  assert.strictEqual(
    noteBody("feat: the row says what it did", "feat: the row says what it did\n\nWhy: it did not.\n"),
    "Why: it did not.",
    "a message that opens with its own label loses that line",
  );
  assert.strictEqual(
    noteBody("feat: written separately", "Why: the row said nothing.\nTests: 47 pass."),
    "Why: the row said nothing.\nTests: 47 pass.",
    "a label the message does not open with leaves it whole",
  );
  const wordy = "x".repeat(100);
  assert.strictEqual(
    noteBody(labelOf(`${wordy}\n\nbody`), `${wordy}\n\nbody`),
    "body",
    "and a label cut at 72 characters is still recognised as its own first line",
  );
  assert.strictEqual(noteBody("anything", undefined), "", "no message, no body");
  console.log("a label is not the message's first line ok");

  // 27. The note is plain text because a diff row renders no markdown, so a
  //     reference is written `src/cli.ts:220` and found afterwards rather than
  //     written as a link. Prose is full of colons followed by digits, and none
  //     of them are files.
  const prose =
    "Purpose: the row said nothing.\n\n" +
    "Verification: 48 checks pass (26 smoke + 22 cli) at 11:53, ratio 3:14.\n\n" +
    "Risks: src/cli.ts:220, and src/review.ts:270-275 (see package.json:3).\n" +
    "Not https://example.com:8080.";
  assert.deepStrictEqual(
    codeReferences(prose).map((r) => `${r.file}:${r.line}`),
    ["src/cli.ts:220", "src/review.ts:270", "package.json:3"],
    "a reference needs a path with an extension, and a host with a port is not one",
  );
  const span = codeReferences(prose)[0];
  assert.strictEqual(
    prose.slice(span.start, span.end),
    "src/cli.ts:220",
    "the span covers the reference and nothing around it",
  );
  const range = codeReferences("see src/review.ts:270-275 there")[0];
  assert.strictEqual(
    "see src/review.ts:270-275 there".slice(range.start, range.end),
    "src/review.ts:270-275",
    "a line range underlines whole and opens at its first line",
  );
  console.log("a plain reference is still a link      ok");

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
