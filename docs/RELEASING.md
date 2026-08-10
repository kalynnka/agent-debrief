# Releasing

Two artifacts, one version, and a publish that only happens when you say so.

| artifact | goes to | published by |
|---|---|---|
| `agent-debrief-<v>.vsix` | VS Code Marketplace | `publish-vsix` |
| `agent-debrief` tarball | npm | `publish-npm` |

`.github/workflows/release.yml` runs on **every push to main**, and publishes on almost
none of them. [release-please][rp] keeps one pull request open — `chore(main): release
x.y.z` — that accumulates every conventional commit since the last release. **Merging
that pull request is the gate**, and it is the only one: the version, the tag, the
changelog and the GitHub release are all written by the merge, and the publish happens
in the same run.

You never type a version number, and a tag or a release cut by hand does nothing.

[rp]: https://github.com/googleapis/release-please

---

## One-time setup

Three accounts and **one** required secret. Nothing in the workflow works until they
exist, and the `publish-vsix` job says so rather than failing blank.

| registry | credential | where it comes from |
|---|---|---|
| Marketplace | `MARKETPLACE_PAT`, an Azure DevOps PAT scoped **Marketplace → Manage** | [2](#2-the-pat-that-publishes-it--marketplace_pat) |
| npm | `NPM_TOKEN`, a granular access token | [3](#3-npm-publishes-on-a-token) |
| — | `RELEASE_PLEASE_TOKEN`, optional, quality-of-life only | [4](#4-release_please_token-optional) |

The PAT goes in **Settings → Secrets and variables → Actions**. `.env.example` carries the
name for a local copy — `.env` itself is gitignored and excluded from both published
artifacts, because a tarball is public and permanent.

### 1. The Marketplace publisher

The Marketplace runs on Azure DevOps infrastructure — that is the whole reason Azure
appears below. You never use it for anything else.

1. Sign in at **https://marketplace.visualstudio.com/manage** with a Microsoft account.
2. **Create publisher.** The **ID** is permanent and cannot be changed afterwards.
3. It has to equal `publisher` in `package.json`, now `kalynnka`. A mismatch is refused
   at upload, which is the cheapest failure here — nothing is published.

The extension's public page will be
`https://marketplace.visualstudio.com/items?itemName=kalynnka.agent-debrief`.

### 2. The PAT that publishes it — `MARKETPLACE_PAT`

The Marketplace accepts no token of its own; it takes an Azure DevOps one.

1. Go to **https://dev.azure.com** and sign in with **the same Microsoft account**. If you
   have no organization it offers to make one — accept, the name does not matter.
2. Top right, the **gear/avatar** → **Personal access tokens** → **New Token**.

The dialog has four fields, and the two that matter are not the ones you would guess.
**Organization is its own dropdown between Name and Expiration — it is not one of the
scopes**, which is where people go looking for it:

```
Name          [ agent-debrief release        ]
Organization  [ All accessible organizations ]  <- 3
Expiration    [ 90 days                      ]
Scopes        ( ) Full access
              (o) Custom defined
                  └─ Marketplace  [ ] Read  [x] Manage   <- 4
```

3. **Organization: "All accessible organizations."** ← *The usual failure.* Left on a
   single organization — which is the default, since you are signed in to one — the token
   is refused with **401**, because the Marketplace sits outside your organization rather
   than inside it. If the dropdown does not offer it, an organization policy is
   restricting multi-org tokens.
4. **Scopes: "Custom defined"** → scroll to **Marketplace** → tick **Manage**. ←
   *The other usual failure.* The default scope set does not include Marketplace at all.
5. Set an expiration you will remember, and **copy the token now** — it is shown once.
6. GitHub → the repo → **Settings → Secrets and variables → Actions → New repository
   secret** → name it exactly **`MARKETPLACE_PAT`**. The workflow hands it to vsce
   as the `VSCE_PAT` environment variable it expects.

> **This expires twice.** Once on the date you chose, and once for good: global PATs
> retire **1 December 2026**. See [After the PAT](#after-the-pat) — but not yet.

### 3. npm publishes on a token

No Azure anywhere in this one. `publish-npm` authenticates as `NPM_TOKEN`, a granular
access token from **npmjs.com → your avatar → Access Tokens → Generate New Token →
Granular Access Token**:

| field | value |
|---|---|
| Expiration | your call, but it is a real expiry and a release is where you find out |
| Packages and scopes | **Read and write**, on `agent-debrief` |
| Bypass two-factor authentication | ticked — a CI publish has nobody to prompt |

Two things the workflow does for it, both easy to undo by accident:

- **`registry-url: https://registry.npmjs.org` on `actions/setup-node`.** It is what writes
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`, and that line is the
  whole of the credential.
- **`NODE_AUTH_TOKEN` in the environment of every step that reaches the registry.** The
  `.npmrc` line expands against it. Unset, it expands to an empty string, npm reads that as
  *auth is already configured*, and you get `ENEEDAUTH` ([actions/setup-node#1551][sn]) — a
  message about `npm adduser` that has nothing to do with what went wrong.

No `--provenance`: it needs `id-token: write` and an OIDC identity, which is the other path.

#### The other path, when you want it

**Trusted publishing** replaces the token with an OIDC exchange. `publish-npm` asks GitHub
for a token, hands it to the registry, and gets back a credential good for this one package
for a few minutes. Nothing is stored, so there is nothing to rotate, leak or watch expire —
and it is narrower than any token, because the registry grants the exchange to one
repository and one **workflow filename** and refuses everything else.

It was tried for `0.1.1` and failed with `ENEEDAUTH`, for a reason worth writing down:
**the exchange falls back to ordinary auth in silence when the package has no trusted
publisher configured**, and the error names neither OIDC nor the missing config. Setting it
up is a browser job at **npmjs.com → Packages → agent-debrief → Settings → Trusted
publishing** — Publisher *GitHub Actions*, owner `kalynnka`, repository `agent-debrief`,
workflow filename `release.yml` (the filename alone, no path), environment empty, allowed
action `npm publish`. It has to be done signed in with 2FA: since 31 July 2026 a
bypass-2FA token may not change trusted-publishing config, so the token cannot do it for
you.

Nor could it have been set up before the first release. npm has no way to pre-register a
publisher for a name that has never been published ([npm/cli#8544][oidc]) — the settings
page does not exist until the package does, which is why `0.1.0` went out on a token in the
first place.

Switching over is four edits to `publish-npm`: restore `id-token: write`, take
`registry-url` off `setup-node`, drop every `NODE_AUTH_TOKEN`, and put `node-version` back
to 24 — trusted publishing needs npm >= 11.5.1 and Node 20 ships npm 10. Then delete the
`NPM_TOKEN` secret and **revoke the token on npmjs.com**: deleting the secret removes the
pipeline's copy, not the credential.

> Direct publishing from bypass-2FA tokens is [due to stop in January 2027][gat], so the
> token path has an expiry date of its own whatever you set on the token.

[gat]: https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/
[oidc]: https://github.com/npm/cli/issues/8544
[sn]: https://github.com/actions/setup-node/issues/1551

### 4. `RELEASE_PLEASE_TOKEN`, optional

Events made with the default `GITHUB_TOKEN` never start another workflow. The release
pull request is one such event, so it opens with **no CI run against it** — the checks
sit there unstarted, and a manual close-and-reopen is what kicks them off. A
fine-grained PAT avoids that. The workflow falls back to `github.token` when the secret
is absent, so skipping this costs two clicks per release and nothing else.

Nothing to do with Azure or npm; this one is GitHub's own, and it is a *fine-grained*
token rather than the classic kind.

1. **https://github.com/settings/personal-access-tokens/new** — or by hand: your avatar,
   top right → **Settings** → **Developer settings**, at the very bottom of the left
   sidebar → **Personal access tokens** → **Fine-grained tokens** → **Generate new
   token**.
2. Fill in four fields:

```
Token name          [ agent-debrief release-please ]
Resource owner      [ kalynnka                     ]
Expiration          [ 90 days                      ]
Repository access   ( ) All repositories
                    (o) Only select repositories  →  [ agent-debrief ]   <- 3
```

3. **Repository access: "Only select repositories" → `agent-debrief`.** The default is
   "Public repositories", which grants read and nothing else — a token made that way
   fails at the same call the missing setting does, and looks identical.
4. **Repository permissions** — two, and they are a long alphabetical list to scroll:

   | permission | level | what needs it |
   |---|---|---|
   | **Contents** | Read and write | the release branch, the tag, the release |
   | **Pull requests** | Read and write | opening and updating the release pull request |

   *Metadata: Read-only* is added for you and cannot be removed.
5. **Generate token**, and copy it now — it is shown once.
6. GitHub → the repo → **Settings → Secrets and variables → Actions → New repository
   secret** → name it exactly **`RELEASE_PLEASE_TOKEN`**.

There is a second way past the same failure, and this repository has it switched on as
well: **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to
create and approve pull requests."** Off by default, and without either that or the PAT
release-please builds the whole release commit and is refused at the last call with
*GitHub Actions is not permitted to create or approve pull requests*. The setting alone
is enough to open the pull request; only the PAT also gets CI to run on it.

---

## Cutting a release

There is no step where you decide a version.

0. **Check the PAT first.** Actions → **Credentials** → *Run workflow*. It asks the
   Marketplace whether the stored PAT is accepted and publishes nothing. Worth a click
   after the PAT is rotated or expires — otherwise it is first exercised by the release
   itself, which is a bad moment to discover it was scoped to one organization.
1. **Land conventional commits on main.** That is the whole of the day-to-day part.
   Pushing straight to main, the commit subjects are what release-please reads. Through
   a squash-merged pull request, the **pull request title** is what it reads — the
   branch's own commits are discarded by the squash — which is what `pr-title-lint.yml`
   guards. A title that does not parse is work that bumps nothing and appears nowhere.
2. **release-please opens or updates a pull request** titled `chore(main): release
   x.y.z`. It carries the version bump in `package.json` and `.claude-plugin/plugin.json`,
   and the `CHANGELOG.md` entry it built from your commit subjects. Read that changelog —
   it is the release notes, and this is the moment to fix a commit subject that reads
   badly by editing the file in the pull request.
3. **Merge it.** The merge writes the tag, publishes the GitHub release, and runs the
   publish in the same job graph.

What decides the number, while the version is below 1.0.0:

| commit | bump | example |
|---|---|---|
| `fix:` | patch | `0.1.1` → `0.1.2` |
| `feat:` | patch, not minor | `0.1.1` → `0.1.2` |
| `feat!:` or a `BREAKING CHANGE:` footer | minor, not major | `0.1.1` → `0.2.0` |
| `docs:`, `refactor:`, `perf:`, `revert:` | none on their own, but they appear in the changelog | |
| `chore:`, `test:`, `ci:`, `build:` | none, and hidden from the changelog | |

Two options hold that shape, and both are deliberate for something this young.
`bump-minor-pre-major` stops a breaking change reaching `1.0.0`, and
`bump-patch-for-minor-pre-major` stops a feature reaching `0.2.0` — so the minor slot
means "something broke" rather than "something was added", and the patch counter carries
ordinary work. Turning the second one off is the move once the shape of the thing has
settled; nothing else changes with it.

The changelog sections and their order are set explicitly in
`release-please-config.json` rather than left to the default, because this repository's
history is heavily `docs:` and the default hides those.

Then, on the merge commit, `release.yml` in this order:

| job | |
|---|---|
| `release-please` | writes the tag and the GitHub release, and reports `release_created` |
| `guard` | refuses unless the tag, `package.json` and `plugin.json` agree — before anything is built |
| `build` | lint, types, tests, then the `.vsix`, attached to the release |
| `publish-npm` | `npm publish`, authenticated as `NPM_TOKEN` |
| `publish-vsix` | `vsce publish --packagePath`, the same file the release carries |

Every job after the first checks out the **tag**, not `main`, so what is published is
what the release says it is even if `main` has moved on. And `guard` survives
release-please rather than being made redundant by it: the version reaching
`plugin.json` depends on one `extra-files` entry in the config, a typo away from
silently doing nothing, and the failure mode is plugin users never being offered the
update.

**npm goes first on purpose.** It is the credential with no pre-flight — the PAT has
step 0 and `NPM_TOKEN` has nothing, so the release is where it is first exercised.
Failing the unchecked one before anything is public is what keeps a release from ending
up on the Marketplace and not on npm, which is where `0.1.0` spent an afternoon and where
`0.1.1` stalled from the other side. Both wait for `build`, so a failing suite publishes
nothing at all.

That ordering is only safe because `publish-npm` checks the registry first and skips a
version it already has, instead of failing on it. Re-running a release after a half-failure
therefore reaches `publish-vsix`.

## When it goes wrong

| symptom | cause |
|---|---|
| no release pull request appears | every commit since the last release is a type that bumps nothing — `chore`, `test`, `ci`, `build`. Nothing to release is the correct answer. |
| work landed but the changelog does not mention it | a squash merge whose pull request title was not conventional. The branch's own commits were discarded; only the title survived. `pr-title-lint.yml` is meant to catch this before the merge. |
| release-please is refused *GitHub Actions is not permitted to create or approve pull requests* | neither the repository setting nor `RELEASE_PLEASE_TOKEN` is in place. §4. |
| the release pull request has no checks | expected without `RELEASE_PLEASE_TOKEN`. Close and reopen it, or §4. |
| a release published by hand does nothing | it is meant to. release-please owns the tag and the release; a hand-cut one triggers no workflow. Merge the release pull request instead. |
| `guard` fails naming two versions | release-please wrote one file and not the other. Check the `extra-files` entry in `release-please-config.json`. Nothing was published. |
| `publish-vsix` fails asking for a credential | `MARKETPLACE_PAT` is unset. §2. |
| 401 from the Marketplace | the PAT was scoped to one organization, not all. §2, step 3. |
| 403 from the Marketplace | the PAT lacks **Marketplace → Manage**. §2, step 4. |
| npm `ENEEDAUTH`, or a 404 on a package that plainly exists | there is no credential. `.npmrc` says `_authToken=${NODE_AUTH_TOKEN}` and the variable is unset on that step, so it expands to nothing and npm reads it as auth already configured. §3. |
| npm **403** naming two-factor authentication | the token does not have **Bypass two-factor authentication** ticked, or it has expired and npm is describing the wrong thing. §3. |
| npm publishes but carries no provenance | provenance is not generated for private repositories, whatever the package's own visibility. |
| `You cannot publish over the previously published versions` | that version is already on the registry, and `publish-npm` should have skipped it. Versions are permanent — bump and cut another. |

A failed publish is safe to re-run: re-running the workflow on the same release repeats the
whole thing, `publish-npm` steps over a version npm already has, and the Marketplace
rejects a duplicate rather than taking it twice.

---

## After the PAT

Global PATs retire **1 December 2026**. Microsoft's replacement is
[secure automated publishing][sap] — Entra ID with workload identity federation.

**That page is an Azure Pipelines recipe.** Five of its eight steps are Azure DevOps
plumbing with no GitHub Actions equivalent: the ARM service connection, the federated
credential linking Azure DevOps to Azure, granting pipelines access to the connection,
the Azure CLI task that looks up a resource ID, and the pipeline YAML. Read it for step 6
and skip the rest.

From GitHub Actions the shape is smaller, and the bridge is different from the one the
docs describe:

1. **An Entra identity** with a federated credential trusting GitHub's OIDC issuer for
   this repository, rather than trusting an Azure DevOps service connection.
2. **Add it as a member of the publisher, role Contributor** — the Marketplace management
   page, step 6, and the only step that actually grants publishing. Everything else is
   about proving who you are.
3. **In the workflow**, swap the `VSCE_PAT` env for `azure/login@v3` with
   `permissions: id-token: write`, and add `--azure-credential` to the publish. No
   service connection, and no token to store: `azure/login` leaves the Azure CLI
   authenticated on the runner, and vsce's credential chain is
   `Environment → **AzureCli** → ManagedIdentity → AzurePowerShell → AzureDeveloperCli`,
   so it picks that session up on its own.

**Why this is not worth doing yet.** A *user-assigned managed identity*, which is what
step 6 wants, is an Azure resource — so it needs an **Azure subscription**, which the PAT
path does not. That is more Azure, not less. Whether a plain Entra app registration works
instead, needing no subscription, is the open question: the docs say to add the identity
"using its resource ID", which is managed-identity language, and it is unverified here.

Nothing in §1 is wasted either way — both paths need the same publisher.

[sap]: https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace
