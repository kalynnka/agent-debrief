# Releasing

Two artifacts, one version, and a publish that only happens when you say so.

| artifact | goes to | published by |
|---|---|---|
| `agent-debrief-<v>.vsix` | VS Code Marketplace | `publish-vsix` |
| `agent-debrief` tarball | npm | `publish-npm` |

`.github/workflows/release.yml` runs on a **published GitHub release** — not on a tag.
Pushing `v0.1.0` on its own does nothing at all; clicking **Publish release** is the gate.

---

## One-time setup

Three accounts and two secrets. Nothing in the workflow works until they exist, and the
`publish-vsix` job says so rather than failing blank.

| GitHub secret | is | where it comes from |
|---|---|---|
| `MARKETPLACE_PAT` | Azure DevOps PAT, scope **Marketplace → Manage** | [2](#2-the-pat-that-publishes-it--marketplace_pat) |
| `NPM_TOKEN` | npm granular or Automation token | [3](#3-the-npm-token--npm_token) |

Both go in **Settings → Secrets and variables → Actions**. `.env.example` carries the same
two names for a local copy — `.env` itself is gitignored and excluded from both published
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
3. **Organization: "All accessible organizations."** ← *The usual failure.* Left on a
   single organization, the token authenticates but publishing returns 401, because the
   Marketplace is not inside your organization.
4. **Scopes: "Custom defined"** → scroll to **Marketplace** → tick **Manage**. ←
   *The other usual failure.* The default scope set does not include Marketplace at all.
5. Set an expiration you will remember, and **copy the token now** — it is shown once.
6. GitHub → the repo → **Settings → Secrets and variables → Actions → New repository
   secret** → name it exactly **`MARKETPLACE_PAT`**. The workflow hands it to vsce
   as the `VSCE_PAT` environment variable it expects.

> **This expires twice.** Once on the date you chose, and once for good: global PATs
> retire **1 December 2026**. See [After the PAT](#after-the-pat) — but not yet.

### 3. The npm token — `NPM_TOKEN`

No Azure anywhere in this one.

1. Sign up at **https://www.npmjs.com/signup** and turn on 2FA.
2. **Access Tokens → Generate New Token → Granular Access Token.**
3. **Read and write** on packages. Scope it to `agent-debrief` once that exists; until
   then it has to be account-wide, which is a reason to replace it soon — see below.
4. **Expiration: as short as you can stand.** Seven days is enough to publish `0.1.0` and
   switch to Trusted Publishing, and an expired token is one that cannot be stolen.
5. Tick **Bypass two-factor authentication (2FA)**, and read the next paragraph.
6. GitHub secret named exactly **`NPM_TOKEN`**.

> **npm warns about that checkbox in red, and it is right.** Ticking it produces a
> credential that publishes as you with the one control that would stop a thief switched
> off. Leaving it unticked is not an option either: `npm publish` then asks for a one-time
> password, and no CI run can answer. That is the whole reason the warning points at
> Trusted Publishing — which you cannot use yet. So the honest position is that this token
> is a **bootstrap credential**: short expiry, one release, then deleted.

**Trusted Publishing is the real answer, and you cannot start with it.** It swaps the
stored token for OIDC — GitHub Actions proves its identity to npm directly, with a
short-lived credential scoped to this repository and workflow, and nothing kept anywhere.
It is configured per-package under **npmjs.com → Packages → agent-debrief → Settings →
Trusted publishing**, and that page does not exist until the package does. npm has no
pre-registration for a name that has never been published ([npm/cli#8544][oidc]), so the
first release goes out on the token above, and then:

1. Configure the trusted publisher: GitHub Actions, repo `kalynnka/agent-debrief`,
   workflow `release.yml`.
2. Delete the `NPM_TOKEN` secret and the `NODE_AUTH_TOKEN` env from `publish-npm`.
3. Drop `--provenance` — trusted publishing attests automatically.
4. **Revoke the bootstrap token on npmjs.com.** Deleting the GitHub secret removes the
   pipeline's copy, not the credential; the token stays valid until you revoke it or its
   expiry catches up.

The alternative, if you would rather never mint a 2FA-bypass token at all: publish `0.1.0`
by hand from your terminal, where the 2FA prompt is answerable, then configure trusted
publishing and let CI take every release after it. The cost is that `publish-npm` fails on
that first release — the version is already on the registry by then — so it is a trade of
one failed job against one short-lived credential.

`publish-npm` is already prepared for it: it requests `id-token: write`, and it runs on
Node 24 rather than the 20 the rest of the workflow uses, because trusted publishing needs
npm ≥ 11.5.1 and Node 20 ships npm 10.

[oidc]: https://github.com/npm/cli/issues/8544

---

## Cutting a release

1. **Bump `version` in `package.json`,** and `version` in
   `.claude-plugin/plugin.json` to match — that second one is what decides when plugin
   users are offered the update.
2. Commit and push.
3. GitHub → **Releases → Draft a new release.** Create the tag `v<version>` from `main`,
   write the notes, **Publish release**.

Then `release.yml`:

| job | |
|---|---|
| `guard` | refuses unless the tag matches `package.json` — before anything is built |
| `build` | lint, types, tests, then the `.vsix`, attached to the release |
| `publish-vsix` | `vsce publish --packagePath`, the same file the release carries |
| `publish-npm` | `npm publish --provenance` |

Both publishers wait for `build`, so a failing suite cannot leave one registry with the
release and the other without it.

## When it goes wrong

| symptom | cause |
|---|---|
| `guard` fails naming two versions | the tag and `package.json` disagree. Nothing was published; fix and re-run. |
| `publish-vsix` fails asking for a credential | `MARKETPLACE_PAT` is unset. §2. |
| 401 from the Marketplace | the PAT was scoped to one organization, not all. §2, step 3. |
| 403 from the Marketplace | the PAT lacks **Marketplace → Manage**. §2, step 4. |
| `npm publish` asks for a one-time password | the token was made without **Bypass 2FA** ticked. §3, step 5. |
| 401 from npm | the token expired. It was meant to be short-lived; §3's switch to Trusted Publishing is the fix, not a longer one. |
| `You cannot publish over the previously published versions` | that version is already on the registry. Versions are permanent — bump and cut another. |

A failed publish is safe to re-run: re-running the workflow on the same release repeats
the whole thing, and a registry that already has the version rejects it rather than
duplicating it.

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
