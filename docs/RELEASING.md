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
| npm | none — a trusted publisher, configured once on npmjs.com | [3](#3-npm-keeps-no-secret) |
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

### 3. npm keeps no secret

No Azure anywhere in this one, and no token either. `publish-npm` asks GitHub for an OIDC
token, hands it to the registry, and gets back a credential that is good for this one
package for a few minutes — **trusted publishing**. Nothing is stored, so there is nothing
to rotate, leak or watch expire.

It is configured per package, once, at **npmjs.com → Packages → agent-debrief → Settings →
Trusted publishing**:

| field | value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `kalynnka` |
| Repository | `agent-debrief` |
| Workflow filename | `release.yml` — the filename alone, no path |
| Environment | leave empty |
| Allowed actions | `npm publish` |

**The workflow filename is matched exactly, and that is load-bearing.** The registry grants
the exchange to that file and nothing else, which is what makes an OIDC identity narrower
than any token: a publish from another workflow in this same repository is refused. It is
also why there is no npm pre-flight — see [Cutting a release](#cutting-a-release).

Two things the workflow does for it, both easy to undo by accident:

- **No `registry-url` on `actions/setup-node`.** It writes
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`, and with no token in
  the environment that line expands to an empty credential. npm reads it as *auth is
  already configured*, skips the exchange, and fails with `ENEEDAUTH`
  ([actions/setup-node#1551][sn]). The default registry is registry.npmjs.org regardless.
- **No `--provenance`.** Trusted publishing attests on its own; passing the flag is how you
  get told so.

> **Why `0.1.0` went out on a token instead.** npm has no way to pre-register a trusted
> publisher for a name that has never been published ([npm/cli#8544][oidc]) — the settings
> page does not exist until the package does. So the first release used a granular token
> with **Bypass two-factor authentication** ticked, which is a credential that publishes as
> you with the one control that would stop a thief switched off. It was a bootstrap: one
> release, then gone. If you ever have to do that again for a *new* package, note that the
> token also needs **All packages** rather than "Only select packages" — a token scoped to
> a list cannot create a package that is not on it yet — and that direct publishing from
> bypass-2FA tokens is [due to stop in January 2027][gat] anyway.

**Retiring that token is three clicks and not optional**, because the workflow no longer
reads it and an unused publish credential is the worst kind:

1. Configure the trusted publisher above. Do it in the browser, signed in with 2FA —
   since 31 July 2026 a bypass-2FA token may not change trusted-publishing config, so the
   token cannot do this even if you wanted it to.
2. Delete the `NPM_TOKEN` repository secret.
3. **Revoke the token on npmjs.com.** Deleting the secret removes the pipeline's copy, not
   the credential; it stays valid until you revoke it or its expiry catches up.

[gat]: https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/
[oidc]: https://github.com/npm/cli/issues/8544
[sn]: https://github.com/actions/setup-node/issues/1551

### 4. `RELEASE_PLEASE_TOKEN`, optional

Events made with the default `GITHUB_TOKEN` never start another workflow. The release
pull request is one such event, so it opens with **no CI run against it** — the checks
sit there unstarted, and a manual close-and-reopen is what kicks them off.

A fine-grained PAT on this repository with **contents: write** and **pull requests:
write**, stored as `RELEASE_PLEASE_TOKEN`, fixes that. The workflow falls back to
`github.token` when the secret is absent, so skipping this costs two clicks per release
and nothing else.

---

## Cutting a release

There is no step where you decide a version.

0. **Check the PAT first.** Actions → **Credentials** → *Run workflow*. It asks the
   Marketplace whether the stored PAT is accepted and publishes nothing. Worth a click
   after the PAT is rotated or expires — otherwise it is first exercised by the release
   itself, which is a bad moment to discover it was scoped to one organization.
1. **Write conventional commits and push to main.** That is the whole of the day-to-day
   part, and it is what the repository already does.
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
| `fix:` | patch | `0.1.0` → `0.1.1` |
| `feat:` | minor | `0.1.0` → `0.2.0` |
| `feat!:` or a `BREAKING CHANGE:` footer | minor, not major | `0.1.0` → `0.2.0` |
| `docs:`, `refactor:`, `perf:`, `revert:` | none on their own, but they appear in the changelog | |
| `chore:`, `test:`, `ci:`, `build:` | none, and hidden from the changelog | |

`bump-minor-pre-major` is what holds a breaking change down to a minor: nothing reaches
`1.0.0` by accident. The sections and their order are set explicitly in
`release-please-config.json` rather than left to the default, because this repository's
history is heavily `docs:` and the default hides those.

Then, on the merge commit, `release.yml` in this order:

| job | |
|---|---|
| `release-please` | writes the tag and the GitHub release, and reports `release_created` |
| `guard` | refuses unless the tag, `package.json` and `plugin.json` agree — before anything is built |
| `build` | lint, types, tests, then the `.vsix`, attached to the release |
| `publish-npm` | `npm publish`, on an OIDC identity minted for this run |
| `publish-vsix` | `vsce publish --packagePath`, the same file the release carries |

Every job after the first checks out the **tag**, not `main`, so what is published is
what the release says it is even if `main` has moved on. And `guard` survives
release-please rather than being made redundant by it: the version reaching
`plugin.json` depends on one `extra-files` entry in the config, a typo away from
silently doing nothing, and the failure mode is plugin users never being offered the
update.

**npm goes first on purpose.** It is the credential with no pre-flight — the exchange only
succeeds from `release.yml`, so the release is the only place it can be tested — while the
PAT has step 0. Failing the untestable one before anything is public is what keeps a
release from ending up on the Marketplace and not on npm, which is where `0.1.0` spent an
afternoon. Both wait for `build`, so a failing suite publishes nothing at all.

That ordering is only safe because `publish-npm` checks the registry first and skips a
version it already has, instead of failing on it. Re-running a release after a half-failure
therefore reaches `publish-vsix`.

## When it goes wrong

| symptom | cause |
|---|---|
| no release pull request appears | every commit since the last release is a type that bumps nothing — `chore`, `test`, `ci`, `build`. Nothing to release is the correct answer. |
| the release pull request has no checks | expected without `RELEASE_PLEASE_TOKEN`. Close and reopen it, or §4. |
| a release published by hand does nothing | it is meant to. release-please owns the tag and the release; a hand-cut one triggers no workflow. Merge the release pull request instead. |
| `guard` fails naming two versions | release-please wrote one file and not the other. Check the `extra-files` entry in `release-please-config.json`. Nothing was published. |
| `publish-vsix` fails asking for a credential | `MARKETPLACE_PAT` is unset. §2. |
| 401 from the Marketplace | the PAT was scoped to one organization, not all. §2, step 3. |
| 403 from the Marketplace | the PAT lacks **Marketplace → Manage**. §2, step 4. |
| npm `ENEEDAUTH`, or a 404 on a package that plainly exists | the OIDC exchange was skipped. Almost always `registry-url` back on `actions/setup-node`, writing an empty `_authToken` into `.npmrc`. §3. |
| npm **403** naming two-factor authentication | the trusted publisher does not match this run. Check the three fields it matches on — owner, repository, and **workflow filename**, which must still be `release.yml`. §3. |
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
