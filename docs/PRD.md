# Debrief — Product Requirements

**Status:** draft · **Owner:** Lu Hui · **Last updated:** 2026-08-04

Snapshot-by-snapshot review of agent changes, in the editor where the language server
already runs.

**Positioning — the one sentence everything else serves:** Debrief is a
**pre-commit, pre-PR, human-in-the-loop review tool.** It reviews work that is
not committed yet, in the window between the agent finishing and me deciding, and
a human makes every decision in it. Anything that only works after a commit, only
works after a push, or decides on my behalf is out of scope by construction.

---

## 1. The problem

### 1.1 The headache

I review everything. During planning and during code changes, I leave a lot of
comments — and most of my repos have no CI, so my review is the only gate there
is. That makes review the bottleneck in every session I run with an agent, and
the tools I have make it worse in four specific ways.

**Batch commenting doesn't exist.** No agent surface in VS Code — Claude, Codex,
Copilot — lets me accumulate a set of comments and submit them as one reply. I
end up typing one thought at a time into a chat box, losing the shape of the
review, or writing the whole thing into a scratch file by hand.

**There is no review layer before the PR.** By the time a change reaches a GitHub
PR it is a squashed lump, and the moment to catch a wrong turn was twenty minutes
earlier. Copilot's per-turn change review is the right shape, and it's the one
thing in that product I actually want.

**I re-read what I already cleared.** Reviewing snapshot N against the branch base
means every file I read at snapshot 2 comes back at snapshot 3, unchanged, demanding to
be skimmed again. This is the single biggest waste in my current loop.

**Per-edit approval is worse than useless.** As agents get better, approving each
edit degrades into "approve all" — the same failure as auto mode, with more
clicking. The unit has to be big enough that reading it is a real decision.

### 1.2 Why a diff viewer is not enough

My [AGENTS.md](../../inky/AGENTS.md) is strict in ways a diff hunk cannot answer:
no `Any`, precise collection types, pyright-clean, helpers must have an owner.
"Does this call site still hold?" is a jump-to-definition question, and a Python
hunk routinely does not show the types of what it touches. **Language services
are load-bearing for my review, not a comfort.**

Language services attach to *real files*. Diff two virtual snapshots and neither
side gets Pylance. That single fact drives most of this design:

- Review happens **in the editor**, not in a web app — a web app would mean
  operating a language-server hosting platform as a side effect of wanting to
  read diffs.
- Review happens **at the turn boundary, against the working tree** — for the
  newest snapshot the right-hand side is the real file on disk, so hover, types and
  go-to-definition work while I read. Historical snapshots degrade to read-only by
  nature. Live review is the real mode; design for that.

### 1.3 The invariant everything else bends around

**The git index is mine.** I stage files as I finish reviewing them, so the
staged set is my progress marker. A tool that runs `git add`, moves `HEAD`, or
creates branches on my behalf destroys the thing the review exists to protect.
No feature is worth violating this.

---

## 2. Goals and non-goals

### Goals

- Make **the agent turn** the unit of review, with snapshot-over-snapshot diffs.
- Never re-present work I already cleared, and reopen it the moment it changes.
- Batch comments and deliver them back to the agent that wrote the code.
- Keep the language server attached while I read.
- Work with any coding agent in any VS Code-like IDE, and later outside it.
- Leave git — index, HEAD, branches, worktree — exactly as I left it.

### Non-goals

- **Not** a replacement for GitHub PR review. This sits *in front* of it.
- **Not** per-edit approve/reject. That is the failure mode, not the feature.
  Per-edit *provenance* — explaining a hunk without asking me to rule on it — is
  in scope, and §4.9 keeps the two apart.
- **Not** an agent runtime. Debrief never runs a model; it hands work to agents.
- **Not** an MCP server shipped inside the extension. An MCP→CLI adapter can be
  added later for a host that genuinely benefits, but the core never depends on
  MCP.
- **Not** a long-running daemon or local service, until something forces one.
- **Not** a second conversation model. Octomate already owns threads, runs and
  history; Debrief does not re-invent them.

---

## 3. Users and use cases

The user is one person reviewing their own agent's work, in their own repos,
with no CI. Everything below is written for that case first; team use arrives
only with Octomate sync (§5.6, M5).

### UC-1 — Review a snapshot while the agent keeps working (primary)

The agent finishes a turn. A snapshot is taken automatically. The Snapshots view
shows the changed files for that snapshot only. I open one, read it with Pylance
attached, leave three comments on specific lines, mark two other files reviewed,
and submit. The agent picks the batch up as its next input and continues.

### UC-2 — Interrupt mid-turn

Something looks wrong, or I want to stop and think. I interrupt the agent,
run **Take Snapshot** manually, review what exists so far, then let the agent
continue. Manual snapshot is not a fallback for missing automation — it is a
first-class entry point for exactly this.

### UC-3 — Catch up after several snapshots

I stepped away and the agent ran four snapshots. Files I cleared at snapshot 2 and that
nobody touched since stay cleared. Files touched at snapshot 4 are open again. I read
the delta, not the branch.

### UC-4 — Consult the agent inline about its own change

Reading a hunk, I do not understand why a call site changed. From the comment
thread I ask the agent that wrote it — in its own session, with its own history —
and get an answer next to the code rather than in a chat panel scrolled away from
the diff.

### UC-5 — Review a GitHub PR with the same ritual

A PR arrives. I pull it into the same review surface, it appears as a single
snapshot, and I use the same diff view, the same comment batching, and the same
helper agent. Submitting posts the batch as a GitHub PR review.

### UC-6 — Review across several repos at once

The workspace holds four clones. Work that touched two of them produces a snapshot
in each; the two it did not touch get nothing. Each repo keeps its own numbering
and its own state.

---

## 4. Review model

### 4.1 Snapshot

A **snapshot** records one agent turn, and is the unit of review. Each is a real git
commit capturing the working tree at the moment the turn ended.

| Field | Meaning |
|---|---|
| `lane` | The line of work this snapshot belongs to (§4.2) |
| `n` | Per-lane sequence number |
| `sha` | Snapshot commit |
| `parent` | Previous snapshot's `sha`, or `HEAD` for snapshot 1 |
| `label` | What the snapshot did |
| `at` | Timestamp |
| `agent` | Which agent produced it (`claude`, `codex`, `copilot`, `manual`) |
| `session` | That agent's session id, when the host exposes one |
| `plan` | The lane's active plan revision at snapshot time (§4.7), if any |

`diff(parent, sha)` is exactly that snapshot's change. `agent` and `session` are what
make §7 possible — they are captured at snapshot time because that is the only
moment they are reliably known.

### 4.2 Lane — snapshots align with branches and worktrees

A **lane** is a line of work, identified by the checked-out branch. Snapshot
numbering, review state and comments are all per-lane.

This is not a concurrency feature bolted on; it is a correctness fix the POC
needs regardless:

- **Refs are shared across worktrees.** A linked worktree writes to the same
  `refs/` as its main tree, so `refs/debrief/snapshots/<n>` collides between two
  worktrees of one clone — verified, not assumed.
- **`.git` is a *file* in a linked worktree**, not a directory. The POC's
  `mkdir .git/debrief` fails with `ENOTDIR`, so both snapshotting and review
  state are broken in any worktree today.

Resolution:

| Concern | Rule |
|---|---|
| Lane id | Current branch. A detached HEAD is `detached/<sha>` — its own lane, since the worktree's name is shared by every detached checkout in the clone; a pulled PR is `pr/<number>` |
| Snapshot refs | `refs/debrief/snapshots/<lane>/<n>` |
| State | `<git-common-dir>/debrief/<lane>/state.json`, resolved via `git rev-parse --git-common-dir` so every worktree agrees |

Branch is the lane key rather than worktree path because git already forbids the
same branch in two worktrees, so branch → at most one worktree, and a branch
survives a worktree being thrown away. Switching to a different branch mid-session
puts you in that branch's lane, which is correct: the work changed.

**A lane follows its branch** (owner decision 2026-08-06, docs/GIT.md D2).
Cutting a branch mid-review is the same work under a new name, so `git switch -c`
carries the review onto it: snapshots, what has been read, and the open threads,
with the snapshot refs re-pointed at the same commits. `git branch -m` moves the
lane outright. Both are read from the branch's own reflog, and both apply only
while the new branch still stands exactly where it was created — once it has a
commit of its own it is a line of work of its own, and inherits nothing.

**A lane ends the way its branch ends** — when the branch is deleted, and only
then. A merged branch still exists, and git keeps its objects, so debrief keeps
the lane; the reviewer deleting the branch is the signal, not a status debrief
infers. A closed lane is handed back to git (§4.8).

**Concurrent agents** follow from this. Two agents working at once belong in two
worktrees on two branches, which is two lanes with independent numbering and no
interleaved attribution. Two agents in *one* worktree remain ambiguous — but that
is now a supported alternative rather than an unanswered question.

### 4.3 Snapshotting without touching git state

```
GIT_INDEX_FILE=<common>/debrief/<lane>/index  git read-tree <parent>
                                               git add -A
                                               git write-tree
                                               git commit-tree <tree> -p <parent>
                                               git update-ref refs/debrief/snapshots/<lane>/<n> <sha>
```

- The private index means the staged set I curate is never read or written.
- `refs/debrief/` is outside `refs/heads`, so `git branch` never lists a snapshot.
- **The `read-tree` seed is required, not an optimization.** Without it `add -A`
  starts from an empty index, where a file that is tracked *and* matched by
  `.gitignore` looks like a new ignored file — so it is skipped and every snapshot
  reports it deleted. This is not hypothetical: `kraken` pins `.python-version`
  that way, and the POC's first snapshot reported it deleted.
- A repo the work did not change gets **no snapshot**. An empty one would put a
  repo's numbering out of step with the work it describes.
- **Everything debrief records about a repo lives in that repo's own `.git`** —
  refs under `refs/debrief/`, state and batches under
  `<git-common-dir>/debrief/<lane>/`. The tool keeps no central store:
  reviewing four repos writes four repos' `.git` and nothing anywhere else,
  so a clone carries its own review history and deleting a clone deletes it.

### 4.4 Review state

`reviewed[file] >= snapshot` is the entire rule. Mark a file reviewed at snapshot 2, the
agent touches it at snapshot 4, it is unreviewed again. No bookkeeping, no matrix to
maintain, and it directly attacks UC-3.

Borrowed from Reviewable's per-file/per-revision model — **agent turns are
revisions** — with none of its product around it.

**Switched off in the current build (2026-08-07).** Built, used, and turned off
after use: the rule is cheap to compute and expensive to *follow* — a file
cleared at snapshot 2 reopening at snapshot 5, thirty snapshots deep, is more
state than a reader carries. The implementation and the recorded marks are kept;
one constant (`MARKING`, `src/state.ts`) ignores them. This is a finding about the
requirement, not a bug in it — see WORKFLOWS §5.2 for what came off with it, and
treat the design above as unproven rather than as shipped.

### 4.5 Comments

A thread anchors to `(file, line range, blob sha, content hash of the anchored
lines)`. Threads **carry forward** into later snapshots by locating the same content,
so a review conversation behaves the way a conversation should. If the anchored
lines themselves changed, the thread is marked **outdated** but stays visible and
open — GitHub's semantics, which I already have in my hands.

States: `draft → submitted → resolved`, with `outdated` as an orthogonal flag.

Threads batch as drafts and submit as one payload. That payload is the product's
actual output.

### 4.6 Evidence

The agent owns the explanation; **Debrief owns the evidence.** When an agent
claims "all tests pass", the claim is text; the CLI attaches the command, exit
code, output summary and the snapshot sha it ran against. A report carries both,
and they are distinguishable.

### 4.7 Artifacts — plans are reviewable too

The original motivation was commenting on **plans** as much as on code, and plan
review is where a wrong turn is cheapest to catch. A plan is therefore a
first-class reviewable artifact, not a chat message.

An artifact is text with revisions. It is stored as a **git blob**, kept alive by
a ref, and diffed with git:

```
git hash-object -w --stdin                                    # object store only
git update-ref refs/debrief/artifacts/<lane>/<slug> <blob>   # refs may point at blobs
git diff <blobA> <blobB>                                      # a real diff
```

Verified: `update-ref` accepts a blob, and `git diff` between two blobs produces
a normal unified diff. This writes nothing to the index, HEAD, a branch, or the
working tree — so §1.3 holds for plans exactly as it does for code.

Consequences that fall out for free:

- The **same** comment model applies. An anchor is `(container, line range,
  content hash)`; a container is a file path *or* an artifact slug. Carry-forward
  and outdated-marking (§4.5) work unchanged.
- A plan revision belongs to a snapshot, so "the agent revised the plan after my
  comments" is a snapshot like any other, and the plan's history sits beside the
  code's.
- Review of a plan produces the same batch, delivered by the same round-trip
  (§7), so plan review is not a second pipeline.

Artifacts are not limited to plans — a change report or a design note uses the
same path — but plans are the only one in scope.

**A lane has at most one active plan.** A branch is one piece of work, so it gets
one plan, and "which plan does this snapshot belong to?" stops being a question worth
modelling.

**A snapshot records the plan revision current when it was taken** —
`plan: {slug, blob}` on the snapshot. The CLI reads it from the lane's active
artifact ref at snapshot time, so it costs nothing and depends on no agent
remembering to declare anything. That single field buys:

- which plan revision each snapshot was working from, in the snapshot list;
- "the plan was revised at snapshot 5", visible because snapshots 5+ cite a different
  blob;
- the plan diff across whatever range of snapshots I am reviewing.

**Drift is evidence, not a verdict.** The `verify-change-evidence` skill asks the
agent to explain how a snapshot follows the plan; the CLI supplies the facts —
the plan revision, the files each snapshot changed, and the changed paths the plan
text never mentions. That last one is a crude token match, and it is stated as
"the plan does not mention these paths", never as "the agent drifted". The agent
owns the explanation, Debrief owns the facts (§4.6), and a fuzzy signal is
honest as long as it is labelled as one.

Deliberately deferred: structured plan steps with stable ids and per-step
coverage. It gives real bidirectional drift detection — planned-but-unimplemented
as well as implemented-but-unplanned — but it forces a plan format and needs the
agent to keep a checklist honest. Not worth it until plan review has been used
enough to prove it is missed.

### 4.8 Retention and cleanup

**Debrief has no retention policy** (owner decision 2026-08-06, docs/GIT.md D2).
It has exactly one rule, and the rest is git's:

| | |
|---|---|
| A lane whose branch no longer exists | **Let go of its refs.** Nothing else |
| A lane whose snapshots git has since collected | Forget it — there is nothing left to review |

That is the whole of `debrief gc`. No age window, no per-lane cap, no notion of
a lane being stale on debrief's own authority.

The reason is mechanical rather than tasteful. **A snapshot ref is a GC root**, so
while debrief holds one, `git gc --prune=now` cannot touch that snapshot — a lane
left behind by `git branch -d` pins its objects forever, which is the actual leak.
Letting the ref go is the entire act: from that moment the snapshot is an ordinary
unreachable object and git's own retention decides when it goes. A real cleanup
then takes the branch and its snapshots together, which is what a reviewer means
by cleaning up.

It is not quite the grace a deleted branch gets, and the difference is worth
knowing. A branch's commits stay named in HEAD's reflog for
`gc.reflogExpireUnreachable` (90 days by default), while a snapshot commit was
never on a branch and `core.logAllRefUpdates` does not cover `refs/debrief/` —
verified, not assumed — so nothing names it once the ref is gone. **`state.json`
is what stands in for the reflog:** it keeps every snapshot's sha, so while the
objects last a lane can be restored with `git update-ref`. Widening that window is
`gc.pruneExpire`, git's own knob rather than one debrief invents.

Debrief never deletes an object and never runs `git gc` for you. Deleting a ref
it created itself is the only destructive git command it will run.

### 4.9 Edit provenance inside a snapshot

A snapshot is the unit of *review*, but its diff can still leave "why did this
line change?" unanswered — and until now this document had no answer at all. The
snapshot granularity is deliberate; the silence below it was not.

**Provenance, not approval.** §2 rejects per-edit approve/reject because it
degrades to "approve all". Provenance is the opposite kind of thing: it asks me
to decide nothing. It explains a hunk while I read the snapshot I was already going
to read. The distinction is written down here precisely because the two look
similar in a UI mock and must not drift together.

**Every tool call is already on disk.** Claude Code's transcript records each
`Edit` with `file_path`, `old_string`, `new_string`, `replace_all` and a stable
`tool_use` id, and each `Write` with full content — verified against a real
session, not assumed. Nothing needs capturing that is not already captured.

**Reconstruct at snapshot time; do not intercept.** A `PostToolUse` hook per edit
puts a process spawn on the hot path of every agent turn. The `Stop` hook that
already fires for the snapshot (§6) reads the transcript once and derives the
snapshot's edit list from it. Interception is the fallback if reconstruction ever
proves lossy, not the design.

**Read the transcript directly, never through Octomate.** The moment provenance
needs Octomate's database, the feature works only while Octomate is running and
tailing, and the extension stops being agent-agnostic — §5.3 undone by a feature.
The transcripts are plain files. The CLI reads them; Octomate reads the same
files for its own purposes. Two consumers of one source, neither depending on the
other.

**Scope: a per-file ordered edit list per snapshot**, each entry carrying the tool
call and the agent's surrounding text. Line-level attribution — replaying edits
over the base blob to colour individual lines — is deferred: it is real work, and
genuinely ambiguous once a later edit rewrites an earlier one. Add it only if its
absence is actually felt.

This is what no other tool does. VS Code, Zed, Cline and the third-party
hunk-review extensions all keep a *baseline copy* and recompute hunks against it,
so "per-edit" in their UIs means per-hunk of the accumulated diff, attributable
to nothing. Reading the transcript is what makes a hunk traceable to the decision
that produced it.

Two things fall out of the same read: the auto-snapshot label (§6), and the
evidence half of §4.6 — the tool call is the fact, the assistant's text around it
is the claim.

Host coverage follows §6's order: Claude first, Codex next. Copilot exposes no
comparable transcript, so its snapshots carry diffs without provenance.

---

## 5. Architecture

```
  skills / hooks / agents ──► debrief CLI ──┐
                                             ├──► review core ──► git + <repo>/.git/debrief
  Debrief UI (VS Code) ── in-process ───────┘
                                  │
                                  └── sync (M5) ──► Octomate API ──► Web UI
```

### 5.1 Review core (TypeScript)

Owns every invariant: private-index snapshotting, snapshot identity, base/head shas,
stale-review detection, comment anchoring and carry-forward, state transitions,
report and evidence schemas, locking.

It is a library of editor-free TypeScript modules (`lanes`, `git`, `state`,
`review`, `transcript`) in the debrief repo. The extension imports it
in-process; the `debrief` CLI is a thin bin over the same modules and is the
contract everything that is not the extension talks through. **One language for
core, CLI and extension** replaced the original Python-core plan (owner
decision, 2026-08-04): the POC's tested plumbing carried forward instead of
being rewritten, and the "same git logic in two languages" risk disappeared
outright.

### 5.2 CLI — the integration contract

The CLI is the stable public interface for every local surface. Rules for every
machine-facing command:

- `--json` with a versioned schema (`schemaVersion` in every payload)
- data on stdout, diagnostics on stderr
- stable exit codes
- explicit `--repo`
- structured input over stdin or a file
- idempotent where retries are plausible — `snapshot` with nothing changed
  creates no snapshot, exits 0, and reports `{"created": false}`

**v1 surface, deliberately small:**

| Command | Purpose |
|---|---|
| `debrief snapshot` | Capture a snapshot. `--label`, `--agent`, `--session`; `--from-stop-hook` reads Claude's Stop payload (session id, transcript path, project cwd) from stdin |
| `debrief status` | Lanes, snapshots, changed files, review state |
| `debrief diff <snapshot>` | Changed files for a snapshot |
| `debrief show <rev> <path>` | File content at a revision |
| `debrief plan put` / `plan show` | Write and read a plan artifact revision (§4.7) |
| `debrief review submit` | Emit the comment batch |
| `debrief review batch` | Read the latest batch (for agents) |
| `debrief gc` | Prune spent lanes and snapshots (§4.8) |

Every command takes `--repo` and `--lane`; both default to the current directory
and its checked-out branch. As of M1 all of these exist except `plan put/show`
(lands with M2's artifacts) and `gc`, which is designed (§4.8) but unbuilt.

Not in v1, each arriving with the milestone that needs it: `snapshot edits` (§4.9,
M2), `feedback list/reply` (M2), `evidence attach` (M2), `pr pull` (M4), `sync`
(M5), and `events --follow --jsonl` only if polling and file-watching prove
inadequate. A large surface with versioned schemas is a lot of contract for one
client; it grows when a milestone pulls on it, not in advance.

**`show` is on the v1 list on purpose.** If the extension keeps its own git
plumbing to render the diff's left-hand side, snapshot logic exists in two
languages — the exact failure this architecture is meant to prevent. The POC has
already produced two git-knowledge bugs (a rename-record parse error and a crash
on an unborn HEAD); neither should ever need fixing twice.

### 5.3 Distribution — where the decoupling actually lives

**The `debrief` CLI ships as its own installable and must not import
`octomate`.** This is the decision that determines whether the extension works
with Copilot or Cursor; the architecture diagram does not. If the CLI lands
inside the octomate package, the tool is re-coupled through the back door.

Repo layout: CLI and extension in the `debrief` repo (one pnpm package, the
CLI as its `bin`), released separately when release time comes. Dev install is
`pnpm link --global`, or an absolute `node <repo>/out/cli.js` path in hook
configs.

### 5.4 Extension — deliberately dumb

The extension renders core output and drives VS Code's Comments API, diff
editor, tree view and decorations. It holds no review policy, no snapshot
logic, and never parses human-oriented output.

With core and extension in one language the boundary is enforced by module
ownership rather than a process hop: the UI modules (`extension`, `snapshots`,
`comments`, `diff`) execute no git and hold no review state of their own —
git runs only inside the core's `git` module, and every mutation goes through
the same locked store the CLI uses. A second IDE client still needs only
process execution of the CLI plus JSON rendering.

All the VS Code APIs used are finalized and stable, with no Copilot involvement
and no model API. Debrief does not plug into VS Code's agent system: that would
mean adopting a second conversation model from a vendor whose product competes
with Octomate's.

### 5.5 Skills — workflow, not enforcement

Skills own judgment: when to snapshot, how to prepare a change report, how to
organize it in my review order (schema → managers → call sites), how to respond
to comments, what evidence to collect, what "ready for human review" means.

Planned: `prepare-change-review`, `address-review-feedback`, `independent-review`,
`verify-change-evidence`, `propose-review-guideline`.

Built alongside them, `recover-change-context` reads the record the other way:
the snapshot messages are the best account of a branch's work that survives a
session, so an agent that has lost the thread — a compaction, a crash, a fresh
window on the same branch — recovers it from the CLI rather than from the human.
Deliberately lazy: entered only when the tree holds work the agent cannot
account for, and left as soon as it can act.

**Skills invoke the CLI. Skills never write `.git/debrief/` directly.**

A skill is model-selected: the agent may forget it, decline to load it, or use it
wrong. So the CLI computes the git facts, validates payloads and refuses invalid
transitions; hooks capture turn boundaries deterministically; the skill supplies
rationale, risk and response.

Canonical workflow in the open Agent Skills format, delivered per host:

```
skills/prepare-change-review/SKILL.md      canonical, git-tracked in this repo
~/.claude/skills/prepare-change-review  →  symlink to the canonical dir: every
                                           Claude Code session in every repo,
                                           iterating live with this repo
.codex/…                                   Codex discovery (M3)
.github/agents/reviewer.agent.md           Copilot persona (M4)
```

A repo-local `.claude/skills/` wrapper was tried first and dropped (2026-08-04):
it only reached sessions opened in the debrief repo itself — exactly where the
skill is least needed. When delivery has to reach beyond this machine, the
packaged form is a Claude Code plugin: one install carrying the skill *and* the
Stop hook, replacing the per-repo `settings.local.json` wiring.

If logic starts accumulating in a wrapper, it belongs back in the skill or CLI.

### 5.6 Octomate — narrowed, and not in v1

The CLI owns local review execution. The Octomate API owns synchronization,
identity, collaboration, remote runs and shared history. Octomate already tails
Claude and Codex transcripts and tracks external runs with session identity, so
the sync layer joins on something that exists rather than inventing a new key.

---

## 6. Snapshot triggering

**Automatic is the target state; manual is permanent.**

**Automatic (preferred).** A stop-time hook fires when a turn ends and calls the
CLI. Claude Code's `Stop` hook and Codex's stop-time hooks both support this
without another protocol server anywhere. The hook passes `--agent` and
`--session`, which is what makes §7 work.

**Label without prompting.** A hook cannot ask me for a label. The CLI derives it
from the transcript the hook already points at — the agent's own closing
summary — falling back to `snapshot <n>`.

**Manual (UC-2).** `debrief snapshot`, and a VS Code command bound to it.
Required for the interrupt case, and the only path on hosts without hooks.

**Host order is Claude, then Codex, then Copilot.** The loop is proven end to end
on one agent before it is widened; a half-working round-trip on three hosts
teaches less than a complete one on a single host. Claude Code is first because
its `Stop` hook and `--resume` cover both §6 and §7 without a gap.

**Copilot custom agents** have no verified stop hook, and that verification is
postponed rather than blocking. Until it happens, Copilot snapshots are manual —
which UC-2 already makes a first-class path, so nothing is unusable meanwhile.

---

## 7. Agent integration

### 7.1 Feedback round-trip

Submitting a batch delivers it to the agent that wrote the snapshot, **preferring
that agent's own session** so it answers with its reasoning history intact:
`claude --resume <session>` and the Codex equivalent, keyed on the `agent` and
`session` recorded at snapshot time.

**When resume is unavailable** — Copilot today, or a manual snapshot with no
session recorded — Debrief starts a **fresh session with the same agent and
model**, seeded with the snapshot diff, the comment batch and the agent's closing
summary. History is lost; the agent is not.

### 7.2 Inline consult (UC-4)

From a comment thread, ask the authoring agent about that hunk, with the file,
the snapshot diff and the thread as context. Same preference order as §7.1. The
answer lands in the thread, next to the code.

### 7.3 Human-only actions — advisory, and honestly so

Approve, waive and mark-reviewed are mine. **This is not enforceable by a CLI:
the agent has the same shell I do and can run any command I can.** Skills
instruct agents not to call them, and the CLI records `--actor` so the action is
auditable after the fact.

Decision: **advisory only**, documented as such. Hook-based blocking is available
later if an agent actually self-approves, but shipping enforcement theatre that
only works on two of four hosts is worse than a stated limit.

---

## 8. GitHub PR review (UC-5)

`debrief pr pull <number>` fetches the PR into its own lane, `pr/<number>`, and
presents it as a **single snapshot**: `parent` = `merge-base(target, head)`, `sha` =
PR head. Everything downstream — diff view, review state, comment batching,
helper agent — is unchanged, and the lane keeps it clear of my own work.

**Real files, because §1.2 applies here too.** Default is a git worktree under
`.git/debrief/pr/<n>`: the language server attaches, my main tree and index are
untouched, and it is disposable. `--in-place` checks the PR out in the main tree
for people who prefer what the official GitHub extension does.

`debrief review submit --to github` posts the batch as a PR review through the
`gh` CLI, reusing its authentication rather than shipping a GitHub client.

**Future — shared snapshots.** If the PR author also uses Debrief, their snapshot
history could be published so a reviewer reads snapshot-by-snapshot instead of one
squashed diff. Transport is undecided: `refs/notes/debrief` is attractive
because notes anchor to commits and never touch the index, but it only works for
*committed* work. Deferred until the single-user loop is proven.

---

## 9. Milestones

| | Scope | Exit criteria |
|---|---|---|
| **M0** ✅ | POC extension: snapshot, snapshot tree, snapshot-over-snapshot diff, comments, batch submit, multi-repo | Done. 30 assertions across 9 headless check groups passing |
| **M1** ◐ | TypeScript core + CLI; lanes (§4.2), which also fixes worktrees; extension becomes a core client; Claude `Stop` hook auto-snapshot; `prepare-change-review` skill | Landed at `733bc0b` (2026-08-04), 109 assertions across 26 headless groups. Verified: UI modules hold zero git logic; two worktrees of one clone review independently. Still to demonstrate by hand: a full snapshot reviewed end to end in the editor, and a hook-driven snapshot appearing unprompted |
| **M2** | **Claude end to end**: feedback round-trip via `--resume`, inline consult, plan artifacts (§4.7) and plan-revision citation, edit provenance (§4.9) | UC-1 and UC-4 complete on Claude alone. A plan reviewed, revised, and implemented through the same batch. A hunk traceable to the tool call that wrote it |
| **M3** | Widen to Codex — stop hook, session resume — against the loop M2 proved | UC-1 and UC-4 on Codex with no core changes. Adding a host is configuration, not architecture |
| **M4** | PR import, GitHub submit; Copilot hook support verified | UC-5 end to end |
| **M5** | Octomate sync, read-only web view | A review readable outside the machine that produced it |

M2 finishing on a single agent is the point, not a compromise: it is what proves
adding the second host costs nothing structural.

---

## 10. Success criteria

1. **Zero mutations of my git state.** No change to index, HEAD, branches or
   worktree, ever. Asserted in tests, not asserted in prose.
2. Files cleared at snapshot N and untouched since never reappear.
3. A snapshot is reviewed and answered without leaving the editor.
4. Review comments reach the authoring agent with its history intact, on every
   host that supports resume.
5. Adding a second IDE client requires no review logic — only process execution,
   JSON rendering and editor APIs.

---

## 11. Risks

- **~~Two languages~~ — closed 2026-08-04.** Core, CLI and extension are all
  TypeScript now. What the risk was really about — the same git logic existing
  twice — is guarded instead by module ownership (git executes only in the
  core's `git` module) and by the headless suite.
- **Hook coverage is uneven.** Claude and Codex yes, Copilot unverified. Manual
  snapshot keeps every host usable; automation is a per-host upgrade.
- **Anchor drift.** Carry-forward matching will sometimes mis-locate. The
  outdated flag is the safety valve — a wrong anchor is visible, not silent.
- **Snapshot cost on large repos.** Seeding the private index each snapshot costs the
  stat cache a full re-hash. Correct but O(tree); measure before assuming it
  scales, and revisit only with numbers.
- **Advisory boundaries.** An agent can self-approve. Accepted, documented,
  auditable via `--actor`.
- **Overlap with VS Code's Agents Window — the largest open risk.** VS Code
  Preview now ships range-anchored feedback comments batched behind a *Submit
  Feedback* action, *Mark as Reviewed*, and a reviewed state that "clears" when a
  later agent turn changes the file — the same rule as §4.4. That covers a
  meaningful part of UC-1, UC-3 and UC-4 natively.

  What it does **not** cover, and what Debrief's value now rests on:

  - **Durability.** VS Code's snapshots are per-request and explicitly temporary,
    designed to "complement Git but not replace it". Debrief's snapshots are git
    commits, reviewable days later and after a restart.
  - **The index invariant.** Staging in the Source Control view *auto-accepts*
    pending edits, and discarding discards them — VS Code's edit state is coupled
    to the staging area I use as my review progress marker (§1.3).
  - **Agent reach.** The feature works "for agents that run through an agent host
    provider". Whether locally-run Claude Code and Codex qualify is unverified
    and is the single fact that most changes this product's value.
  - **Reach beyond one editor** — CLI, JetBrains, PR review, cross-repo, plans.

  This must be settled by a hands-on check before M1 starts, not argued from
  documentation.

---

## 12. Open questions

Resolved: concurrent agents → lanes keyed to branches and worktrees (§4.2); lane
lifecycle → closes when its branch is deleted or merged (§4.2); plan review →
plans are git-blob artifacts sharing the comment model (§4.7); plan-to-code
linkage → the snapshot cites the plan revision, drift is evidence rather than a
verdict (§4.7); retention → `debrief gc`, never pruning open review work (§4.8);
host order → Claude end to end first, Copilot postponed (§6); implementation
language → TypeScript end to end (§5.1, 2026-08-04); concurrent writers → an
advisory lock file around every read-modify-write, one implementation covering
every writer including the hook, exercised by two real spawned processes in the
test suite (2026-08-04); how the UI learns a snapshot happened → a debounced file
watch on the lane's state directory, no daemon (2026-08-04); the two POC bugs →
fixed in M1's git layer with regression tests (rename records parsed as the
three fields they carry; an unborn HEAD snapshots against the empty tree).

Still open:

1. **Label quality from the transcript.** §6 derives a snapshot's label from the
   agent's closing summary. Whether that reads well enough to navigate by is an
   empirical question, answerable only once M1 produces real snapshots.
2. **Snapshot cost at scale.** Seeding the private index each snapshot re-hashes the
   tree. Fine on a 284-file repo; unmeasured on a large one. Needs numbers before
   it needs a solution.

---

## Appendix — POC findings that shaped this document

| Finding | Consequence |
|---|---|
| Language services attach only to real files | Editor-first, not web-first; review at the turn boundary |
| Reviewable's file×revision state | `reviewed[file] >= snapshot` |
| Per-edit approval degrades to "approve all" | Snapshot is the unit |
| Claude transcripts already carry every `Edit` with `old_string`/`new_string` and a stable `tool_use` id | Edit provenance needs no new capture, and no Octomate dependency (§4.9) |
| VS Code, Zed, Cline and hunk-review extensions all diff against a *baseline copy* | Their "per-edit" is per-hunk, attributable to nothing; transcript-derived provenance is unoccupied ground |
| Tracked-but-ignored files vanish from a virgin index | `read-tree` seed is mandatory |
| Refs are shared across a clone's worktrees | Snapshot refs must be lane-scoped |
| `.git` is a file in a linked worktree — `mkdir .git/debrief` gives `ENOTDIR` | State lives under `--git-common-dir`; worktrees are broken in the POC |
| `update-ref` accepts a blob, and `git diff` works between two blobs | Plans can be pure git objects, touching nothing |
| `--name-status -z` rename records have three fields | Parser bug; fixed in M1, regression-tested |
| `commit-tree -p` fails on an unborn HEAD | A fresh `git init` repo cannot be snapshotted; fixed in M1 via the empty-tree base, regression-tested |
| Cline, Cursor and Zed all do checkpoints; none do comments | Comments differentiate against *those* tools |
| VS Code's Agents Window (Preview, 1.120+) ships batched feedback comments, mark-as-reviewed, and reviewed-state reset on a later agent turn | **Comments alone are no longer the differentiator** — see §11 |
