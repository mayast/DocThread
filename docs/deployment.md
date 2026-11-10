# Deployment

Azure Static Web Apps (SWA) is the sole supported hosted target for the secure MVP. The former
GitHub Pages workflow is retired because its origin is not registered on the single-tenant Entra
app and it depended on a second, separately operated OAuth topology.

## Canonical host and base path

- **Live URL (canonical):** <https://wonderful-water-098ab6803.7.azurestaticapps.net/> — Azure SWA.
- **GitHub Pages is disabled at the repo level and must stay disabled.** It is not just
  "no workflow" — Pages was left enabled once and kept serving a stale build at
  `https://probable-fishstick-8g44g6k.pages.github.io/`, which rendered a blank page because that
  artifact's `index.html` requested `/DocThread/assets/*` (404) while the files were served from
  `/assets/*`. That is the base-path mismatch tracked in issue #103. Do **not** re-enable Pages: its
  origin is not registered on the single-tenant Entra app.
- **Base path per target** (`base` in `vite.config.ts`, overridable via `VITE_BASE`):
  - Default is **relative (`./`)** so an ad-hoc build is path-agnostic and cannot blank-page from a
    base mismatch, regardless of where it is served.
  - Hosted SWA (and the SWA pipeline template) build with **`VITE_BASE=/`** because SWA serves at the
    domain root.
  - There is no supported sub-path deployment; if one is ever added, set `VITE_BASE` to that exact
    sub-path (e.g. `/DocThread/`) so `index.html` asset references match how the site is served.

## Hosted Capability Matrix

| Capability | Secure hosted setting | Credential authority |
| --- | --- | --- |
| Public GitHub read | Always available | Public raw content |
| Private/write GitHub | Device flow, `repo read:org` | Visitor GitHub token |
| Entra people search | `VITE_GRAPH_TRANSPORT=msal` | Visitor Graph token |
| Azure Repos / ADO source | `VITE_ADO_TRANSPORT=off` | Disabled until explicitly delegated |
| Custom email | Not present | Disabled |
| Server-token proxies | Not present | Disabled |

The managed API upload must contain only:

```text
POST /api/device/code
POST /api/oauth/token
```

## Entra Registration

The PM Copilot deployment uses a public single-tenant SPA with no client secret:

```text
Client ID: 3a9dd418-f26a-4e43-b3bb-30a5c89b251a
Tenant ID: 72f988bf-86f1-41af-91ab-2d7cd011db47
Delegated Graph permission: User.ReadBasic.All
```

Registered redirects include `http://localhost:5173/` and the current SWA root. The application
requests Graph only when `VITE_GRAPH_TRANSPORT=msal`. The presence of a client ID never implies
Azure DevOps access.

## Local Deployment Script

Prerequisites:

- Node.js 22 and PowerShell 7.
- Azure CLI authenticated with `az login`.
- Permission to create the resource group and `Microsoft.Web/staticSites` resource.
- A globally unique SWA name.

```powershell
.\scripts\deploy-swa.ps1 `
  -Subscription '<subscription name or ID>' `
  -ResourceGroup 'rg-docthread' `
  -Location 'westeurope' `
  -AppName 'docthread-example' `
  -Sku Free `
  -GitHubClientId '<GitHub OAuth client ID>' `
  -GraphTransport Msal
```

`-Subscription` is mandatory. `-GraphTransport Msal` requires a non-empty public client ID and an
explicit tenant GUID; `Off` omits Graph registration values from the build. Hosted ADO transport
is fixed to `off`.

The script provisions the existing Bicep topology, runs `npm ci`, the full test suite, and the
production build, then deploys `dist/` and `api/`. It prints the non-secret capability matrix
before upload. It does not deploy or delete resources without the operator's explicit command.

## Continuous Deployment

- GitHub: `.github/workflows/deploy-swa.yml` — runs automatically on every **push to `main`**
  (i.e. every merged PR), and can also be run manually via **workflow_dispatch**. A `concurrency`
  group cancels an in-flight deploy when a newer commit lands so two uploads never race.
  > **Why auto-deploy:** the workflow was previously `workflow_dispatch`-only, so merges to `main`
  > did **not** reach the hosted SWA until someone remembered to dispatch a deploy. That left the
  > live site serving a stale build after a merge (observed after #104/#106). Deploying on push
  > keeps the live site in lockstep with `main`.
- Azure Repos template: `templates/azure-repos/azure-pipelines-swa.yml`

Both use the same public Entra client/tenant, Graph `msal`, and ADO `off` settings. Store only the
SWA deployment token as a pipeline secret. `VITE_GH_CLIENT_ID` is a public repository/pipeline
variable. GitHub scope and the direct `api.github.com` base are fixed in code to prevent drift.

Production builds fail when Graph MSAL lacks an explicit tenant/client or when hosted ADO is not
`off`. The build prints, for example:

```text
[DocThread capabilities] github=device-flow/direct graph=msal ado=off
```

## Live Setting Cleanup

Before deploying this build, remove any legacy application settings or Worker secrets:

```text
NOTIFY_WEBHOOK_URL
GH_SERVER_TOKEN
ADO_PAT
ADO_BEARER
ADO_ALLOWED_ORGANIZATIONS
REVIEW_REPO
```

The source tree no longer contains notify, GitHub bridge, or ADO bridge Functions. Validation must
inspect the upload artifact as well as source paths.

## Content Repository Installation

Install the reporting-only analyzer into each content repository:

```powershell
.\scripts\install-content-repo.ps1 `
  -Provider Auto `
  -AppUrl 'https://<your-swa-host>/' `
  -TargetPath 'C:\src\content'
```

The installer copies the dependency-free analyzer plus the provider workflow/pipeline wrapper.
Rerun it in every existing content repository before the first schema-v2 sidecar lands. The
analyzer checks `.docthread/v2/**` first, retains exact read-only v1 fallback, ignores tombstones,
and reports legacy collision/reconciliation warnings.

## Deep Links And Permissions

Generated GitHub links use `targetVersion=1&target=<base64url canonical JSON>` and are verified
against the exact ref and file before use. The encoding is transport, not a signature. Legacy
blob URLs are bounded and resolved against every possible branch/tag/path boundary; ambiguity
requires user choice.

| Operation | GitHub branch | GitHub tag/commit | Azure Repos branch | ADO work item |
| --- | --- | --- | --- | --- |
| Read source | Repository read | Repository read | Explicit ADO transport | Explicit ADO transport |
| Save shared review | Contents write | Local only | Contribute | Local only until #15 |
| Edit source | Contents write | Local only | Contribute | Local dev only |
| Native notification | Issues write | No remote dispatch | Not in hosted MVP | #15 backend required |

## Mandatory Release Gates

Deleting the real ADO snapshot from HEAD is complete, but sensitive content remains in historical
Git/GitHub references. Before release:

1. Freeze writes and inventory branches, tags, PR refs, forks, collaborators, and protection.
2. In a fresh restricted mirror, run `git-filter-repo >= 2.47` with
   `--sensitive-data-removal --invert-paths --path .docthread-reviews/ado/`.
3. Verify all rewritten refs and run the identity/PII scan.
4. Coordinate the force push, restore protection, and require collaborators to reclone.
5. Ask GitHub Support to dereference PR refs, clear cached views, and run garbage collection.
6. Record clean-ref, fork, collaborator, protection, and Support evidence without retaining data.

There is no accepted-retention release path. Hosted ADO work-item collaboration is separately
blocked by issue #15 until per-item caller authorization and CAS-backed storage are implemented.

Use the `azure-validate` workflow before any production deployment. This implementation task does
not deploy Azure resources or remove live settings automatically.