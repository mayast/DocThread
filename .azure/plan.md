# DocThread Secure Identity MVP Plan

Status: Validated locally; Azure control-plane validation and production release remain blocked
Mode: MODIFY
Recipe: Existing Bicep plus Azure Static Web Apps deployment paths
Approved: 2026-08-23

## Objective

Deliver the approved identity-aware review MVP on Azure Static Web Apps without anonymous relays,
server credentials, invented email destinations, lossy sidecar addressing, or ambiguous source
identity.

The detailed behavioral and security contract is
[`docs/identity-design.md`](../docs/identity-design.md).

## Approved Architecture

| Component | Decision |
| --- | --- |
| Hosted target | Azure Static Web Apps only |
| GitHub auth | Visitor device-flow token, direct API, `repo read:org` |
| People search | Graph SPA with delegated `User.ReadBasic.All` |
| Graph registration | Client `3a9dd418-f26a-4e43-b3bb-30a5c89b251a`, tenant `72f988bf-86f1-41af-91ab-2d7cd011db47` |
| Hosted ADO transport | Off |
| Managed API | Device-code and token relays only |
| Notifications | Native GitHub issue mention after durable attempt claim |
| Repository state | Schema-v2 sidecar, strict decoder, merge plus provider CAS |
| ADO work-item shared state | Disabled pending issue #15 |

The existing Bicep topology remains one resource group plus one
`Microsoft.Web/staticSites` resource. This change does not provision, modify, or delete Azure
resources.

## Implemented Work

- Provider-backed identity autocomplete shared by new comments and replies.
- Stable GitHub/Entra keys, friendly display names, structured mention spans, and stable waiting-on.
- Custom email and every anonymous/server-token relay removed.
- Graph and ADO transports split; production capability matrix fails closed.
- V2 sidecar address, decoder, migration quarantine, merge clocks, tombstones, and dispatch state.
- GitHub and Azure Repos branch-head CAS behavior.
- Exact GitHub ref/path resolution and canonical deep links.
- Typed ADO HTML/sign-in classification and explicit GitHub device-flow UX.
- Pages release workflow retired; SWA scripts/workflows aligned.
- Production-derived ADO snapshot deleted from HEAD and replaced by synthetic test data.
- Distributed review analyzer updated for v2 with exact v1 fallback.

## Validation Plan

1. Run clean `npm ci` through the configured Microsoft package proxy.
2. Run the complete Node and PowerShell suites with `npm test`.
3. Run the secure production build and verify:
   `github=device-flow/direct graph=msal ado=off`.
4. Compile Bicep and run ARM validation/what-if against an explicitly approved subscription and
   location before any deployment.
5. Browser-test desktop/mobile sample, autocomplete, reply picker, device flow, source ambiguity,
   local-only boundaries, and configured Graph/GitHub paths.
6. Inspect `dist/` plus `api/` and assert only the two OAuth Functions are deployable.
7. Run secret/PII and obsolete-capability scans.

## External Release Gates

- Remove legacy live SWA settings and any Worker secrets listed in `docs/deployment.md`.
- Confirm GitHub organization approval and obtain a fresh `repo read:org` visitor token.
- Roll the updated analyzer into every content repository before v2 sidecars land.
- Complete the coordinated `.docthread-reviews/ado/` all-history purge, force-push, protection
  restoration, collaborator/fork cleanup, and GitHub Support cache/PR-ref cleanup.
- Keep hosted ADO/Azure Repos transport off. Issue #15 must provide per-item caller authorization
  and CAS-backed storage before hosted ADO work-item collaboration can release.

Deleting the snapshot from HEAD is not history-purge evidence. No production deployment or live
setting deletion is claimed by this implementation.

## Validation Proof

Validated locally on 2026-08-23 without provisioning or modifying Azure resources:

| Check | Result |
| --- | --- |
| Dependency install | `npm ci` passed through the configured package proxy; 0 vulnerabilities |
| Complete suite | `npm test` passed: 105 Node tests plus GitHub and Azure Repos installer/in-place analyzer checks |
| Secure hosted build | Passed with `github=device-flow/direct graph=msal ado=off` |
| Type/editor diagnostics | No workspace diagnostics |
| Bicep | `az bicep build --file infra/main.bicep --stdout` passed; only a newer CLI-version notice |
| Deployment script | PowerShell parser reported no syntax errors |
| Browser, desktop | 1443x967, no horizontal overflow, shared full-name mention session, no console warnings/errors or failed requests |
| Browser, mobile | 390x844, no horizontal overflow or incoherent overlap |
| Device flow | Synthetic hosted-mode check proved code-first UI, explicit Copy acknowledgement, countdown, no automatic tab, and visible blocked-popup fallback |
| Security surface | Deployable API contains only device-code and token relays; obsolete route/config scan passed |
| Review | Repeated adversarial reviews found no remaining P0/P1 release blockers; final P2 findings were fixed and covered |

ARM validation/what-if was not rerun because no Azure subscription context was requested for this
PR-only task. Run it against an explicitly approved subscription and location before deployment.

## Approval

The user approved the final identity design and requested implementation, validation, and a pull
request to `main`. Azure deployment remains a separate operator action after validation and the
external release gates above.

## 2026-09-11 Security Audit Follow-Up

Status: Repository/public audit completed; hosted behavior changes and Azure configuration audit
scope await confirmation. Production release remains blocked.

The owner requested a read-only live audit and appropriate amendments to PR #151 before merging,
including whether any tracked variable values belong in local environment files or secret stores.
This is not authorization to rewrite history, delete live settings, or deploy.

Verified so far:

- The only tracked environment template is `.env.example`; it defines public build configuration,
  not credential entries. `.npmrc` has no authentication assignments. Local `.env` files are
  ignored. This amendment also ignores Functions `local.settings.json` and Worker `.dev.vars`
  files while keeping safe templates trackable. No values were relocated.
- GitHub Actions stores `AZURE_STATIC_WEB_APPS_API_TOKEN` as a secret. Repository variables are
  `VITE_APP_URL`, `VITE_GH_CLIENT_ID`, and `VITE_REVIEW_REPO`; no values were displayed.
- Secretlint 13.0.5 with its recommended preset found no secret-pattern matches in 148 tracked
  text files, the three repository variables, or the live root HTML and directly referenced
  JavaScript/CSS. Binary files, Git history, ignored local files, and Azure/Worker settings were
  not scanned. These are scoped results, not a guarantee that no sensitive content exists.
- GitHub secret-scanning status was not disclosed and its open-alert endpoint returned HTTP 404.
  This is unavailable evidence, not proof that the repository has no secrets.
- Contrary to the older OAuth-only deployment contract, `api/notify/function.json` declares an
  anonymous POST endpoint. Its handler can forward email or Teams payloads using server webhook
  settings. A recipient domain allowlist does not authenticate the caller.

Amendment status:

1. Completed without changing application behavior: keep public OAuth client and tenant identifiers
  in public configuration, exclude local credential files from Git, and document that private
  values must never use `VITE_`.
  Preserve shared non-secret defaults in versioned templates. Any required secret relocation
  must include contributor setup/migration instructions, the approved secret-store owner and
  access process, and a retrieval/import step that does not print values. GitHub Actions secrets
  are for CI, not a downloadable contributor configuration store. Do not invent a vault or
  distribute credential-bearing files through Git, PR comments, or chat.
2. Partially completed: repository/GitHub checks and GET-only public endpoint/asset checks have
  redacted results in the [validation handoff](../docs/review-ui-validation.md#security-audit).
  Azure configuration inspection awaits subscription confirmation. Inventory any legacy Worker
  only if its scope and access are known; no live secrets were read or changed.
3. Pending confirmation: restore the approved OAuth-only hosted API by removing the anonymous email/Teams relay from the
   deployable API and disable hosted dispatch to it, retaining local development behavior.
   Cover the artifact boundary and production configuration with focused regression checks.
  Alternatively, the owner must approve an authenticated delivery design before retaining it.
4. Record verified findings, amendments, remaining blockers, and scan limitations in the validation
  handoff and PR. Keep the history-purge and release holds in place.

Contributor compatibility is an acceptance gate for any configuration move: verify a fresh clone
and an existing developer setup, preserve existing ignored local values, and never overwrite a
local configuration file during bootstrap. Basic development must remain usable without shared
production credentials; optional integrations must fail closed with clear configuration feedback.
If required secret access cannot be provided to contributors, do not remove the existing setup
path or declare the migration ready to merge.

The documented bootstrap was executed in disposable fresh and existing setups: the fresh setup
used the tracked template, and the existing local file was preserved byte-for-byte. No actual
contributor environment files were read or modified. Basic startup and all configuration values
remain unchanged; there is no new contributor secret-access dependency.

Azure subscription and existing resource region must be confirmed before configuration inspection.
No Azure resource, live application setting, GitHub secret, or branch protection has been changed.