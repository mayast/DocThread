# DocThread: Minimal Product And Next Release

Status: Lean product scope and session-only #114/#120 closure approved by the owner.
Owner: `rosacek_microsoft`. Updated: 11 September 2026.
Code/test baseline: PR #151, `052d14ecb21d567ebb39ee7a575a8f1619d61fab`.

This scope lock authorizes fixing demonstrated gaps within the session-only #114/#120 contract
and linking both issues for closure by PR #151. It does not authorize broader analytics, unrelated
product expansion, merging, deployment, or a waiver of the existing release gates.

## Product Decision

DocThread helps people review a document where it already lives: open it, comment on a passage,
discuss a change, and share the result. A non-technical reviewer should not need to understand Git,
configure telemetry, or learn a separate review-management process to participate.

The previous draft overreached. Durable metrics, review rounds, role collection, a retry outbox,
and a cross-repository reporter would create a second product before demonstrating demand for it.
Those are removed from the locked release scope, not merely hidden behind optional UI.
Do not build analytics infrastructure just to close #114/#120.

"Fully functional" means two authorized people can complete the core review workflow with clear,
trustworthy results. It does not mean every roadmap idea has been implemented.

## Essential Feature Set

| User need | Minimum product behavior |
| --- | --- |
| Open a document | A shared link opens the intended document and discussion. Without a link, offer the existing sample and a discoverable Open document action |
| Get access | Ask for the relevant provider sign-in only when required; return to the same document afterward |
| Leave feedback | Select text, type, post; keep the passage highlighted and show whether feedback is shared or only local |
| Respond | Reply, resolve/reopen, and navigate between a comment and its passage; show existing open/resolved counts |
| Make a change | The author can preview/apply an existing suggestion and explicitly save the source through the existing flow |
| Bring in a reviewer | Copy a link to the same document or comment; make clear that the link does not grant repository access |

These are acceptance targets for the integrated product, not claims that every real-provider or
human test has already passed. Much of this is already implemented in the current candidate.

## Easy Onboarding

The invited reviewer's path is:

1. Open the shared document link.
2. Sign in only if this document or posting feedback requires it.
3. Select a passage and leave a comment; see an unambiguous result.

No DocThread account creation, role questionnaire, workspace wizard, API key, or repository
installation is required from an ordinary hosted reviewer. The document is the first screen,
not a dashboard or feature tour. Basic reviewing must not require AI configuration.

The owner prepares access once before inviting reviewers. Keep hosting/OAuth and any content-repo
setup in operator documentation, not in the everyday review flow. Keep hosted GitHub support
explicit; do not present local-only ADO support as available on the hosted site.

Access is the main product risk to validate. Current [capability handling](../src/App.tsx) separates
local commenting from repository persistence; signing in or reading a public document is not proof
that a shared write will succeed. A lack of permission must not silently turn "Post" into feedback
that only the reviewer can see. Preserve the draft, identify the missing access, and offer a clear
next action. Local-only practice/drafts remain useful when explicitly labeled as not shared.

Use an approved repository and a realistic non-author account to test this. If that reviewer cannot
publish feedback with acceptable permissions, resolve that specific access/workflow problem before
calling onboarding complete. Do not bypass repository authorization with a shared server token.

## Progressive Disclosure

Keep the document, comments, sharing, and relevant sign-in/save state visible. Keep editor settings,
advanced provider details, and optional tools out of the default review path. Preserve the existing
visual conventions rather than introducing a new navigation system.

- AI Review stays optional in the existing Tools surface. Users can act on findings or ignore it.
  Built-in checks remain usable without endpoint setup; distinguish those from a configured AI service.
- The existing review summary and open/resolved counts answer "what needs attention?" without a
  new dashboard, formal completion step, or timer.
- The [session-only insights increment](114-120-session-insights.md) stays off by default and out
  of onboarding. Do not extend it into durable capture, or require users to enable it to review.

This design does not remove already implemented features. It limits new investment and avoids
making optional features prerequisites for ordinary work.

## Do Not Add Now

- Formal review rounds, start/finish ceremonies, or a new Mark reviewed workflow for measurement.
- Reviewer-role collection, participation profiling, or before/after executive metrics.
- Durable verdict/event storage, a telemetry schema, an IndexedDB metrics queue, or new consent flows.
- Cross-repository analytics jobs, a reporting CLI, generated dashboards, or policy/model comparisons.
- New hosted providers, backend services, or credentials solely to support these analytics.

Revisit broader analytics only when production use demonstrates a repeated unmet user need. Record
the observed problem, the decision the measurement would support, and why existing review data or
manual evidence is insufficient; obtain explicit scope approval before building. Archived issue
ideas are not delivery commitments, and issue closure is not evidence of product demand.

## Narrow Next PR

First validate the core flow in PR #151. A second PR should contain only demonstrated friction or
correctness gaps, in this order:

1. Shared-link and sign-in continuity: correct document, relevant account, preserved context.
2. Commenting and save clarity: obvious passage association, local versus shared state, useful
   permission/error feedback, and recovery without retyping or duplicating an action.
3. Default-screen clarity: remove any need to hunt for the next core action, without a broad redesign.

Do not manufacture a second PR if the flow already passes. No new analytics architecture, sidecar
migration, or contributor configuration is required by this scope. If a concrete correctness
bug requires an internal change, fix its owning code with a focused regression test; do not replace
the whole storage or authentication system preemptively.

## Reliability Is Essential

Simplicity reduces features, not trustworthiness. Preserve anchored discussions, existing drafts
and recovery, permissions, and safe source edits. A shared save needs provider acknowledgement;
local acceptance is not proof of a remote save or notification. Two concurrent reviewers must not
lose each other's comments. Retries must not duplicate comments, source changes, or messages.

Reuse the current review schema and save paths. The [GitHub writer](../src/github.ts) and
[merge code](../src/reviewPersistence.ts) need a two-client lost-update check as part of core
reliability; an analytics ledger would not fix a lost comment. Failure handling belongs beside
the action it affects, with a clear retry or access path and preserved user input.

## Release Acceptance

| Check | Observable completion criterion |
| --- | --- |
| First review | A representative first-time reviewer opens an approved link and posts anchored feedback without coaching or developer setup |
| Shared result | A second authorized account sees that feedback after reload, replies, and resolves it; both accounts see the same result |
| Access denial | A signed-out or read-only account gets a clear sign-in/access/local-only state, never a false shared-success message |
| Safe edits | A suggestion changes only the intended draft; saving source remains explicit and its destination/result is clear |
| Failure and contention | Network/auth/storage failure preserves input; retry is idempotent; two simultaneous reviewers retain both changes |
| Usability | Core actions work by keyboard, screen reader, and at narrow widths/zoom; no overlapping or hidden essential controls |
| Contributor continuity | Existing local configuration is preserved and the documented fresh-clone setup still works without new shared secrets |

Use existing automated fixtures for repeatable regressions and an approved disposable repo for
real-provider evidence. Observe a short uncoached reviewer/author trial; record where people get
blocked and what they expected. That supplies actionable onboarding evidence without building a
telemetry system. Do not claim human or live checks from browser automation alone.

## Issue And Release Boundaries

The owner has explicitly narrowed #114 to optional, memory-only session decision capture and #120
to the same session's aggregate summary and manual JSON export. Both are off the default review
path, require no new permissions or service, and preserve the existing capture/privacy boundaries.
Their implemented scope is mapped to tests in the [session evidence](114-120-session-insights.md).

PR #151 should close #114 and #120 on merge after this scope lock and exact-head checks are recorded.
That closure means the session-only product is complete, not that durable storage, reviewer roles,
cycle-time/readiness-lift reporting, cross-repository analytics, or model improvement shipped.
Preserve the original proposals as explicitly out-of-scope historical context. Do not create
replacement follow-up issues unless production evidence and a later approved decision justify them.

The [current security and release gates](review-ui-validation.md#security-audit) remain in force.
Reducing product scope does not authorize history rewriting, weaken caller authorization, or imply
that live configuration is clean. Nothing is merged or deployed by this design revision.

## Next Action

Complete the scoped validation/wording commit and verify that PR #151 closes #114, #120, #149, and
#150. The release owner then resolves the separately tracked security/provider/human gates before
merging. Observe the core-flow trial under its approved account/repository scope; turn only actual
blockers into further work. Keep session insights optional and require production evidence before
any analytics expansion.