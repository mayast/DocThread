# DocThread

**Comment on your Markdown like it's a Word doc — right on the live file in GitHub, Azure Repos, or an Azure DevOps work item. No export. No forked copy. No pull request to wrangle.** *(That's the mission: a collaboration operating system for documents, where humans and AI review, discuss, and land changes together without ever leaving Docs-as-Code — see the [Plan](#plan) for what's shipped vs. on the roadmap.)*

**Why it matters:** your specs and PRDs belong in Git — diffable, agent-readable, right next to the code they describe. But review still happens in Word, and hand-merging that feedback back into Markdown burns cycles and quietly forks your source of truth. DocThread closes the gap: reviewers (technical or not) comment straight on the live `.md` or work item, an AI pass grades it and drafts fixes inline, and the source never leaves Git/ADO. One document — cheap to keep, ready for both human sign-off and agent consumption.

**▶ Try it live:** **<https://wonderful-water-098ab6803.7.azurestaticapps.net/>** — a hosted demo on Azure Static Web Apps. Public GitHub Markdown works with no sign-in; sign in for private GitHub repos. The AI review features ship with built-in **local fallbacks**, so they work on the live site with **no keys or setup** (only [AI-suggested edits (#63)](https://github.com/gim-home/DocThread/issues/63) needs a configured endpoint). Prefer to run it yourself? See [Get Started](#get-started-run-locally).

> **⚠ Azure DevOps work items are not available on the hosted site.** The deployed Static Web App is **GitHub-only**; pasting an ADO work-item URL shows _"Azure DevOps work item access is not configured on this deployment."_ **ADO users must run DocThread locally** (`VITE_ADO_TRANSPORT=dev-cli`, authenticated with your own `az` identity — see [Get Started](#get-started-run-locally)) until hosted ADO access is enabled. Tracked in [#115](https://github.com/gim-home/DocThread/issues/115) (blocked on [#18](https://github.com/gim-home/DocThread/issues/18)).

## What it does today

Highlight any rendered text on the **live source file** — not a copy — and start a conversation right there. Leave threaded comments, tag each by intent (Question / Suggestion / Blocking), reply, resolve, reopen. Need a change? Edit in place and save it straight back to the source (commit, pull request, or work-item update). Engineers and non-technical stakeholders work side by side on the exact same content: **one review surface, one source of truth.**

**And AI reviews right alongside you — live, no keys required.** One **AI Review** pass grades spec readiness, then drafts text-anchored findings and apply-ready suggestions, optionally grounded by a repo `REVIEW.md` and a skill file so the output speaks your team's standards. Humans stay in the loop; the source stays authoritative.

The payoff: faster reviews, fewer versioning headaches, and non-technical stakeholders finally in the loop. Watch the [demo video](https://innovation-studio.microsoft.com/events/hackathon2026/submissions/projects/proj-99305089-89a0-4c51-9743-87e4ebbb3946) or jump to [Key capabilities](#key-capabilities) for the full feature list.

> **Where it's heading:** humans-and-AI review and skill-aware grounding are live; next is **requesting review by opening a pull request or a child Azure DevOps work item** ([#51](https://github.com/gim-home/DocThread/issues/51)), then a machine-actionable agent API ([#45](https://github.com/gim-home/DocThread/issues/45)). Tracked in the [Plan](#plan).


### Review Controls

Use **Tools > Open document** for a source URL, recently viewed documents, or the sample.
Selecting a passage opens the composer in **Comments**, with all three comment labels directly
available. Search, filter and sort stay in the comments rail; Reply and Resolve remain beside each
thread. **Tools** contains the existing editor, AI Review and Summarize review; **Share** contains
the review link and invitations.

Posting feedback, applying a document draft, saving the source, and sending a notification have
separate outcomes. Document drafts are saved for recovery in the same browser when storage is
available; **Compare draft** appears only after the source is opened with the viewer's access.
Unposted comments/replies stay source-bound within the tab. ADO **Compare feedback** preserves
differing local and saved copies, with explicit reconciliation before publication. See
[the #128 implementation handoff](docs/128-implementation.md) for evidence and completion gates.

### Session Review Insights

**Tools > Session review insights** is optional and off by default. With authenticated shared-review
write access, it counts decisions on newly run, displayed review findings in memory only. Turning it
off or clearing removes the cohort; source/account changes, sign-out, teardown and reload also disable
capture. No source, sidecar, browser storage, network or log telemetry is added.

**Session decision uptake** is `(posted + applied) / (posted + applied + dismissed)`; pending is excluded
and no decisions means no rate, not zero. Repeated runs are observations, not unique findings or people.
Manual **Export JSON** contains only versioned aggregates, separate local/AI/unknown and pass buckets,
and coverage limits. A whole run that cannot fit within 1,000 observations is omitted and capture pauses.
Exports cannot be recalled. Opt-in/displayed-cohort bias applies; correctness, cycle time, reviewer reach,
readiness lift, policy/skill comparison and source-save success are not measured. See the
[session-only #114/#120 handoff](docs/114-120-session-insights.md) for evidence and remaining validation.

The result: faster reviews, fewer versioning headaches, and non-technical stakeholders finally in the loop.
See the [demo video](https://innovation-studio.microsoft.com/events/hackathon2026/submissions/projects/proj-99305089-89a0-4c51-9743-87e4ebbb3946)
and [Key capabilities](#key-capabilities) for the full feature list.

> **Where it's heading:** humans-and-AI review and skill-aware grounding are live; next is **requesting
> review by opening a pull request or a child Azure DevOps work item**
> ([#51](https://github.com/gim-home/DocThread/issues/51)), then a machine-actionable agent API
> ([#45](https://github.com/gim-home/DocThread/issues/45)). Tracked in the [Plan](#plan).

## Where DocThread fits alongside Loop, Word, and Notion

Those are great tools to **author** in — and you can keep using them. DocThread solves a different problem:
**Word-style review on content whose source of truth is Markdown in GitHub / Azure Repos or a description in
Azure DevOps — without forking it into another app.** Markdown has no native comment construct, so
Loop/Word/Notion store your comments in a *copy* of the content and can't write them back to the `.md`;
getting changes back is a manual, lossy re-merge. What DocThread adds:

| | Loop / Word / Notion | GitHub / ADO PR comments | **DocThread** |
|---|---|---|---|
| Reviews the **live** source — no forked, drifting copy | ❌ import = a copy | ✅ | ✅ |
| Friendly for non-technical reviewers (no Git, no diffs) | ✅ | ❌ line-anchored | ✅ |
| Comments stored **with the source**, same access controls | ❌ separate doc | ✅ | ✅ `.docthread` sidecar, in-repo |
| Human **+ AI** review built in (readiness, findings, fixes) | ⚠️ varies | ⚠️ bots | ✅ |

**Markdown is also what your AI agents want.** Coding agents read and reason best over Markdown in Git
and ADO descriptions — it's diffable, lives in their workflow, and keeps acceptance criteria, tables, and
code blocks first-class. A Word `.docx` has to be converted first — which is lossy, forks the source, and
**costs more tokens** (0–15% overhead with a clean extract, up to 3–10×+ if raw OOXML is fed): the same
content re-rendered from Word inflates token usage and can lower answer quality, whereas Markdown/ADO
descriptions feed the model almost as-is. It also carries an **availability risk** Markdown doesn't:
SharePoint sensitivity labels can encrypt a `.docx`, blocking a naive read entirely. Keeping the spec in
Markdown makes it **cheaper, agent-ready, and human-reviewable** — and DocThread adds the review layer on
top, so whether you draft in Word first or write straight in Markdown, the source stays clean, agent-ready,
and reviewable in one place.

<details>
<summary>Reference: Word vs. Markdown vs. ADO description for AI-ready specs</summary>

| Aspect | Word (.docx) | Markdown (in Git) | ADO Description |
|---|---|---|---|
| AI quality / fidelity | ⚠️ Variable — clean if extracted via a proper doc-reader first; lossy if raw OOXML is fed | ✅ Highest — native structure, no conversion layer | ✅ High after normalization — pasted-from-Word HTML needs cleanup first |
| Token cost | ⚠️ 0–15% overhead with a clean extract, 1.2–2× with tables, 3–10×+ if raw OOXML is fed | ✅ Lowest — fed almost as-is | ✅ ≈ Markdown — slight HTML overhead |
| Availability risk | ❌ SharePoint sensitivity labels can encrypt the file, blocking a naive read | ✅ None — plain text, always readable | ✅ None — API read, no encryption layer |
| Velocity / latency | ⚠️ Extra hop — resolve link, decrypt, parse/convert | ✅ Fastest — no conversion needed | ✅ Fast — one API read + light normalize |
| Version control / diffing | ❌ No native diff; disconnected from code PRs | ✅ Full git diff, PR review, blame, history | ⚠️ Revision history exists but is not diff-friendly |
| In agent workflow | ❌ Out-of-band (SharePoint/OneDrive) | ✅ Native — same repo as the code it specs | ✅ In-workflow — same work item the agent touches |

</details>


**Governance is part of this too.** Word and Loop keep data in your Microsoft 365 tenant, while pasting
internal or customer content into **Notion moves it to a third-party service outside Microsoft's
compliance boundary** — which can raise data-residency and sensitivity-label questions. DocThread never
moves the content anywhere: the review layer lives in a `.docthread/` sidecar in the **same GitHub/ADO
repo as the source**, so comments inherit the exact access controls and governance of the content itself,
and the `.md` stays byte-for-byte clean. (Meeting reviewers inside the tools they already use — VS Code,
and a Loop/Word review surface — is on the [Plan](#plan).)

## Key capabilities

**Review content, not code diffs** — highlight any text in a Markdown document, Azure Repos file, or ADO work item and start a threaded discussion right where the feedback belongs. Classify each as **Question / Suggestion / Blocking**; reply, resolve, and reopen without losing context; and edit content directly, then save back to the source, open a **pull request**, or update the work item — all with access controls and secure feedback storage.

**Humans + AI review together** — the review surface is paired with AI passes (each links to its issue for detail):
- [AI reviewer pass (#43)](https://github.com/gim-home/DocThread/issues/43) + [AI-readiness score (#44)](https://github.com/gim-home/DocThread/issues/44) + [REVIEW.md policy (#89)](https://github.com/gim-home/DocThread/issues/89) + [skill grounding (#92)](https://github.com/gim-home/DocThread/issues/92) — **Run AI Review** now runs one unified pass: readiness grade/score first, then anchored findings and proposed replacements. A repo-root or selected `REVIEW.md` governs passes, severity, and nit caps; an optional skill file (any Markdown/text filename) grounds output in team standards. Accept fix → apply/propose the replacement, Dismiss → gone.
- [AI-suggested edits (#63)](https://github.com/gim-home/DocThread/issues/63) & [Suggested edits (#35)](https://github.com/gim-home/DocThread/issues/35) — turn feedback into an apply-ready change in one click, optionally grounded by the active skill.
- [Summarize a review (#30)](https://github.com/gim-home/DocThread/issues/30) — a grouped digest of open threads.

**Collaboration & editor** — [share for review (#111)](https://github.com/gim-home/DocThread/issues/111) hands non-Git stakeholders a stable review link + optional allowlisted email invite (with Invited/Reviewed participation in the panel); plus [notifications + Teams (#31)](https://github.com/gim-home/DocThread/issues/31), [reactions (#37)](https://github.com/gim-home/DocThread/issues/37), [thread deep-links (#32)](https://github.com/gim-home/DocThread/issues/32), and [comment search & sort (#34)](https://github.com/gim-home/DocThread/issues/34); Edit Doc adds a [formatting toolbar (#78)](https://github.com/gim-home/DocThread/issues/78), [live split preview (#38)](https://github.com/gim-home/DocThread/issues/38), and [spell-check (#62)](https://github.com/gim-home/DocThread/issues/62).

> **AI endpoints are opt-in.** Summarize (#30), unified AI Review/readiness (#43/#44/#89/#92) ship with a deterministic **local fallback**, so they're live with zero config — an endpoint only adds AI enrichment. **AI-suggested edits (#63)** has no local fallback, so it's shipped as code but **inactive on the hosted site** until `VITE_SUGGEST_ENDPOINT` is set (see [.env.example](.env.example)).

## Request a review with a GitHub issue

For a GitHub-backed document, sign in, choose **Request review**, preview the issue, and confirm.
This is separate from the document-edit pull-request flow and needs GitHub issue-write access,
not permission to edit the document.

- There is one active request per document and exact typed ref (branch, tag, or commit).
  Repository names are case-insensitive; document paths and refs are case-sensitive.
  Before creating, DocThread checks open issues from **all authors**, including other browsers.
- GitHub is authoritative for **open/closed**. **Hide from this browser** only hides the local
  receipt; it never closes GitHub's issue or permits another active request. **Show hidden requests**
  makes hidden receipts recoverable. Refresh preserves hiding and updates provider observations.
- **Add assignees** adds to the existing issue; it does not replace or remove existing assignees.
  Requested names are separate from assignees verified in GitHub's response; partial assignment
  remains a warning even when issue creation succeeded.
- Discovery is bounded to five pages of 100 repository issue/PR entries. An incomplete scan,
  multiple matches, or a legacy unversioned marker requires manual resolution, not another create.
  Legacy markers cannot safely distinguish branch and tag; hidden legacy requests still block.
- A lost, unreadable, or uncertain creation response retains an **unknown** receipt. Reconciliation
  checks open and closed issues across authors; neither an empty search nor changing accounts
  authorizes a blind retry. If browser storage fails, a known success or uncertainty remains in
  this tab, with a warning. Verify in GitHub before reloading or retrying.
- Source/account changes invalidate pending previews and stale UI updates. Drafts and receipts stay
  with their original source. A synchronous same-tab guard prevents repeated submits, but GitHub
  offers no atomic uniqueness primitive: simultaneous creates from separate tabs or clients can
  still race. This is duplicate detection, not a cross-client atomic guarantee.

## Get Started! Run Locally

**Prerequisites**: Node.js 22 and GitHub CLI. Azure CLI is required only for explicit Azure provider
development.

```powershell
npm ci
npm run dev
```

Open `http://localhost:5173`. GitHub development uses the signed-in `gh` identity through the
local Vite proxy. To opt into local Azure DevOps access, set this in `.env.local`:

```dotenv
VITE_ADO_TRANSPORT=dev-cli
```

That mode uses the signed-in `az` identity and is a development aid, not proof of hosted
least-privilege behavior. To exercise the registered Graph SPA locally, use the client and tenant
values from [.env.example](.env.example) with `VITE_GRAPH_TRANSPORT=msal`.

### Shared Configuration And Secrets

Basic local development does not need a shared production credential or a local environment
file. Keep public client IDs, tenant IDs, feature defaults, and variable descriptions in the
tracked [.env.example](.env.example). These public identifiers are not client secrets. Every
`VITE_` value is browser-visible: never use that prefix for tokens, passwords, webhook secrets,
or URLs containing credentials, even when the value comes from an ignored local file.

For optional configuration, create a local file only if one does not already exist:

```powershell
if (-not (Test-Path .env.local)) {
	Copy-Item .env.example .env.local
}
```

After pulling changes, add newly needed entries from the template individually; do not replace
an existing local file. `.env.local`, Functions `local.settings.json`, and Worker `.dev.vars`
files are ignored. Commit templates with placeholders, never populated credential files.

Use each contributor's `gh` or `az` identity for local provider access. Any optional integration
that needs a shared server credential must document its approved secret-store owner and access
process before the credential becomes required. Retrieve it directly into the local server
environment without printing it or sharing it through Git, PR comments, or chat. GitHub Actions
Secrets supply CI; they are not a downloadable contributor configuration store. Store production
server credentials in the approved hosted secret/configuration store, never in frontend build
variables.

Any future configuration relocation must include a versioned template, setup/migration steps,
and a non-overwriting bootstrap. Validate both a fresh clone and an existing developer setup;
optional integrations must remain optional when credentials are absent. No configuration values
were relocated by the September security audit, so no contributor migration is currently needed.

## Validation

```powershell
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:browser
```

Covers identity, mentions, source canonicalization, schema/merge/dispatch, ADO classification, the notify relay + allowlist, OAuth route governance, and every review/AI feature (reactions, inbox/Teams, summaries, suggested & AI-suggested edits, readiness scoring, REVIEW.md policy, skill grounding, and the AI reviewer pass). See [docs/deployment.md](docs/deployment.md) for full release gates.

`test:browser` starts and stops isolated loopback previews, uses synthetic provider responses, and
runs keyboard, draft/recovery and accessibility checks in Chromium, Firefox and WebKit. No real
provider requests or credentials are used. Results and screenshots are written to
`node_modules/.cache/review-ui/`; CI uploads them per browser. To run one engine, use
`node scripts/test-browser.mjs --browser=chromium`. These checks do not replace the uncoached
reviewer trial, real-provider verification or screen-reader observation.

## Deployment

Hosted on **Azure Static Web Apps** (the sole supported secure host). The managed API provides the GitHub device-code/token relays and the allowlisted `/api/notify` mention-email relay. Deploy with `scripts/deploy-swa.ps1`; set `NOTIFY_WEBHOOK_URL` (and optionally `NOTIFY_ALLOWED_DOMAINS`) as app settings to enable email. Full CI variables, capability validation, and release gates: [docs/deployment.md](docs/deployment.md).

## Documentation

- **[Providers, identity & notifications](docs/providers-and-identity.md)** — GitHub / Azure Repos / ADO source resolution, the identity picker, and @mention email/Teams delivery.
- **[Architecture & persistence](docs/architecture.md)** — module map and the `.docthread` sidecar model.
- **[Roadmap](docs/roadmap.md)** — the full ROI-prioritized backlog (also on the [GitHub Issues board](https://github.com/gim-home/DocThread/issues)).
- **[Deployment](docs/deployment.md)** — hosting, CI variables, and release gates.

## Roadmap

A single, ROI-prioritized backlog spanning the review/collaboration surface and the **AI-native SDLC** capabilities, tracked on the **[GitHub Issues board](https://github.com/gim-home/DocThread/issues)**. Near-term focus: **request review via PR / child ADO work item ([#51](https://github.com/gim-home/DocThread/issues/51))**, a machine-actionable **agent API ([#45](https://github.com/gim-home/DocThread/issues/45))**, and the audit-trail cluster (traceability, provenance, approval gates). See **[docs/roadmap.md](docs/roadmap.md)** for the full table and rationale.

## Housekeeping (before public release)

Early testing committed two sample review files under `.docthread-reviews/ado/`. They hold **test
comments**, but their anchors include real ADO work-item IDs and description snippets. They are
already **removed from `HEAD`**; original additions remain in historical references.

Follow the [mandatory release gates](docs/deployment.md#mandatory-release-gates), including the
coordinated history purge, collaborator/fork cleanup, and GitHub Support cache/PR-ref cleanup.
Internal visibility and a clean scan of current text files do not satisfy those gates. History
rewriting and live-setting deletion require separate authorization. The latest scoped audit and
remaining decisions are recorded in [the validation handoff](docs/review-ui-validation.md#security-audit).
