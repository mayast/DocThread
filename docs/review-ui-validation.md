# Review UI Validation And Integration

Owner: `rosacek_microsoft`. Updated: 11 September 2026.

## Current Candidate

The reviewed combined candidate is in `.worktrees/issue-149-150`, on delivery branch
`issue/149-150-review-navigation`, based on `f24823387fa1c122028246577a56b63b72483ea4`
(the refreshed `origin/main`). It includes fixes for
[#149](https://github.com/gim-home/DocThread/issues/149),
[#150](https://github.com/gim-home/DocThread/issues/150), ordered passage/card alignment, quiet
paired navigation, unboxed comment labels and primary/overflow actions, plus the session-only
first increment of #114/#120.
The owner accepted the design, then authorized finalizing, validating and merging all pending
changes on 11 September 2026. The former primary-checkout backlog is now included in this
delivery in [PR #151](https://github.com/gim-home/DocThread/pull/151). A remote main merge remains blocked by the existing mandatory sensitive-history
release gate; this authorization does not waive that gate or authorize destructive history
rewriting, protection changes, or deletion of live settings.

- Quote overflow previously overrode a two-line clamp. Clamping now belongs to an unpadded
  inner span so neither overflow nor a partial third line can cover metadata.
- A separate CSS Custom Highlight follows the draft anchor after native selection/focus changes.
  It is cleared on cancellation/posting/source changes and restored only with its source's draft.
- Cards default to Passage order using rendered anchor positions. All interleaves open and
  resolved cards in that order; drafts join the same sequence. Selecting a comment respects an
  explicit Newest, Oldest or Blocking first sort instead of overriding it with passage geometry.
- The approved priority is stable order, no overlap, then closest passage alignment. In the
  side-by-side layout, a selected card or composer uses its passage row only when preceding
  cards fit above. Otherwise it moves down to the closest available row, retaining a 12px gap.
  DOM and numerical order never shuffle on selection, margin markers stay put, and reply drafts
  survive resizing/repacking. This supersedes the earlier exact-row-first behavior.
- Hover and keyboard focus quietly pair the passage, marker and card without activation,
  scrolling or repacking. Previous/Next arrows traverse the current filtered/sorted sequence,
  preserve search, and stop at the first/last visible comment.
- Explicit navigation scrolls only as much as needed. A visible pair stays stationary, even
  after scrolling well down the page. Off-screen links reveal both ends when they fit; otherwise
  they prioritize the requested card or its header. Narrow layouts retain normal page flow.
- Show passage offers Back to comment only while the originating card header is off-screen.
  One subtle connector identifies a displaced active pair on desktop; it is clipped to the
  review area, hidden on narrow layouts, and cannot enlarge the page or intercept input.
- Numbered margin links pair with card quote controls and active styling. Numbers survive
  filtering/sorting, shared anchors remain individually reachable, and orphans stay unlinked.
- Question, Suggestion and Blocking use compact icon/text labels with no pill background or
  border. Unverified aliases use amber text, an explicit status and a dotted inline underline;
  resolved mentions retain their existing identity state. This does not change notification rules.
- Reply, Resolve/Reopen and Show passage are always visible together. Copy link, Delete and
  eligible AI drafting live in the kebab menu. Its portal does not resize or move the card, and
  stays within the viewport at narrow widths and zoom.
- The menu supports arrow keys, Home/End, Escape, Tab and outside dismissal. Copy success is
  announced; clipboard failure opens the selectable-link dialog and restores trigger focus.
  Delete requires confirmation, and existing shared-review/local-only permission checks remain.
- Browser testing also found and fixed a phantom mention query at caret zero that moved Cancel
  on blur, and low-contrast resolved cards caused by whole-card opacity.

## Verification

| Gate | Current result |
| --- | --- |
| Clean install | `npm ci` through the configured package proxy passed; zero reported vulnerabilities |
| Unit/contract/installer tests | 333 passed: 36 UI/insights contract tests and 297 other tests; installer checks passed |
| Typecheck and production build | Passed; `github=public-only graph=off ado=off` |
| Chromium combined browser gate | 30 scenario groups passed, including passive pairing, ordered crowded cards and contextual return |
| Local Chromium/Firefox/WebKit matrix | 30 groups per engine; 90 passing runs, zero escaped provider requests; captured before the Linux WebKit correction below |
| Local accessibility | 73 axe WCAG A/AA scans per engine; 219 total, zero violations |
| Local WebKit correction | 30 groups and 74 axe scans passed after whole-button wrapping, including the new 320px wider-font regression; zero violations |
| Integration tree | Local history added only the prototype and ignore-file newline to `d270dda`; subsequent CI correction changes primary-action wrapping and its regression checks only |
| Linux CI confirmation | `9a0414c` passed build, all three browser engines, review status and security; 90 scenario runs and 222 axe scans, zero violations ([run 34586233206](https://github.com/gim-home/DocThread/actions/runs/34586233206)) |
| Retained checkpoint prototype | All 12 scenarios passed at 1440px and 390px; zero JavaScript errors or outbound requests; original bytes preserved |
| Patch integrity | CRLF-aware tracked whitespace/conflict check passed |
| Production release | Blocked: original sensitive snapshot additions remain reachable in `origin/main` history |

The retained baseline engine runs were executed separately with no concurrent terminal commands
and each completed successfully. These receipts supersede the earlier 29-group/68-scan reports. Earlier
interrupted or failed attempts are not counted. The final runs include the narrow-layout
connector overflow fix and return-button checks based on actual originating-header visibility.
Retained baseline receipts, before the Linux correction:
[Chromium](prototypes/review-ui-validation/chromium-results.json),
[Firefox](prototypes/review-ui-validation/firefox-results.json), and
[WebKit](prototypes/review-ui-validation/webkit-results.json).

Visual evidence:
[quiet paired navigation](prototypes/review-ui-validation/chromium-quiet-paired-navigation-desktop.png),
[crowded cards in numerical order](prototypes/review-ui-validation/chromium-crowded-selection-numerical-order.png),
[composer in an ordered crowded stack](prototypes/review-ui-validation/chromium-crowded-draft-ordered-stack.png),
[320px dark-mode passage return](prototypes/review-ui-validation/chromium-passage-return-320px-1x-dark.png),
[unboxed labels and primary actions](prototypes/review-ui-validation/chromium-unboxed-card-actions-1280px-1x-light.png),
[320px dark-mode labels and actions](prototypes/review-ui-validation/chromium-unboxed-card-actions-320px-1x-dark.png),
and [320px dark-mode comments](prototypes/review-ui-validation/webkit-shared-passage-comments-dark-320px.png).

### PR #151 Before And After

Matched captures compare the actual PR base `f24823387fa1c122028246577a56b63b72483ea4` with
implementation `ae459c08b7c1521ed8afbc2df05c9c2b0d1f74dc`, not the older #128 redesign. Both use
the same installed dependency set, Chromium 153.0.8010.12 on Windows, light theme, 1x scale,
fixed clock, and synthetic fixture data. No UI styling was changed for these captures. All seven
images were inspected; there were no page errors or escaped provider requests. Capture servers
and the temporary base-source snapshot were stopped/removed afterward.

| View | Before | After |
| --- | --- | --- |
| Desktop comments, 1280x900 | [Overlapping long quotes](prototypes/review-ui-validation/pr151-before-cards-1280.png) | [Clipped quotes, numbered passages, clear actions](prototypes/review-ui-validation/pr151-after-cards-1280.png) |
| Mobile comments, 390px panel crop | [Quote text covers labels and actions](prototypes/review-ui-validation/pr151-before-cards-390.png) | [Readable labels and primary actions](prototypes/review-ui-validation/pr151-after-cards-390.png) |
| Composer focused, 1280x900 | [Passage highlight is lost](prototypes/review-ui-validation/pr151-before-draft-1280.png) | [Draft passage remains highlighted](prototypes/review-ui-validation/pr151-after-draft-1280.png) |

The mobile images crop the comments panel; its search/filter controls moved to the shared toolbar,
shown in the desktop comparison. Draft captures use the same selected passage and focused text
input with the native selection cleared; the after capture retains the independent draft highlight.
The [new session insights view](prototypes/review-ui-validation/pr151-after-insights-1280.png) is an
after-only 1280x1080 capture, shown after opt-in with synthetic outcomes. It remains off by default;
the counts do not claim source-save success or notification delivery.

[Capture metadata and image hashes](prototypes/review-ui-validation/pr151-comparison.json) record
the exact revisions, dimensions, paired fixture-state hashes, and observed highlight/quote states.
The PR embeds these images with commit-pinned URLs. Issues #114/#120/#149/#150 use the existing
`status:implemented-needs-validation` label: code complete, with live/release verification still
separate. They remain open until merge.

The browser gate covers quote clipping, draft focus/cancel/post/source restoration, real passage
geometry, keyboard/mouse links, alternate sorting, reply growth, shared/resolved/orphaned anchors,
light/dark themes, 320/390/900px layouts and 200% CSS zoom. Navigation checks assert stable card
and marker order, open/resolved interleaving, passive hover/focus geometry, filtered traversal
and boundaries, closest feasible alignment, minimal scrolling, a single displaced-pair connector,
and keyboard passage return only when needed. Other checks cover unboxed label styles,
resolved/unverified alias distinction, primary-action clipping, menu focus/placement, copy
success/fallback, canceled/confirmed deletion and read-only permissions. It also exercises
GitHub/ADO recovery, suggestion provenance and draft protection, plus #114/#120 opt-in, actual
outcomes, stale async results, account/source invalidation, privacy, export retry and whole-run
capacity refusal. Desktop, crowded, mobile dark-mode and 200% CSS-zoom screenshots were visually
inspected as well as checked through browser geometry assertions.

These are isolated synthetic-provider scenarios with egress guards, not live provider, human
screen-reader, native-browser zoom or uncoached-user evidence. The production build retains the
existing bundle-size and mixed static/dynamic review-policy import warnings.

### Linux WebKit Correction

PR #151's Linux WebKit run exposed a real 320px issue that Windows WebKit did not reproduce:
the Show passage label wrapped to 36px high while its inline-flex button remained 32px high.
The page width and unboxed label styling passed; detailed child/button bounds isolated vertical
overflow. Internal grid sizing and a native-appearance reset did not resolve the Linux failure.
The action row now wraps complete buttons instead of squeezing labels into fractional columns.
Each label stays on one line, and Show passage moves to a full-width second row when necessary.
The existing strict containment thresholds are unchanged, with richer failure diagnostics and a
permanent wider-font regression. Temporary style-variant probes were removed.

The corrected local WebKit suite passed 30 scenario groups and 74 axe scans. Its 320px dark-mode,
wider-font check keeps all three buttons at 32px high, with every icon and label contained and no
horizontal overflow or unexpected provider requests. Normal-font and wider-font screenshots were
visually inspected. Windows results alone did not prove the Linux correction.

Linux confirmation passed on code/test commit `9a0414cdde3624cb25e0b6a4716d8ae32d4fae44` in
[CI run 34586233206](https://github.com/gim-home/DocThread/actions/runs/34586233206). Downloaded
reports confirm 30 scenario groups and 74 axe scans per engine across Chromium, Firefox and
WebKit, with zero violations. Build, review status and GitOps/AdvancedSecurity also passed;
DocThread review was neutral, not a human approval. Later documentation-only commits must retain
this source/test tree and pass their own final-head checks. The release hold below is unchanged.

## #114 / #120 Integration

PR #142's head is `1490a717aa3ad8004ad204b650e624bda3b4e69b`. It was merged into the old
`issue/128-review-first` branch on 9 September. Its build, Chromium/Firefox/WebKit and security
checks passed; no submitted PR review was found. Its features are absent from fetched `main`.

Do not directly merge the old stack: a normal merge-tree probe conflicts in nine files because
#128 was independently squash-merged. Using verified #128 head
`75da35e33aec9949f82404e1c5f50f0f7b2116cd` as the explicit feature base produces a clean
feature-only tree `efc6f263d2b20a1cdcbd46ca920707c8e3786f73` on current main. That exact delta
was applied to this isolated candidate, with the shared gutter explicitly reconciled to preserve
both insights and the UI fixes. No old branch or primary-checkout files were replaced with it.

The selected increment remains session-only and off by default. Uptake excludes pending and
does not claim correctness, readiness lift, source-save success, adoption or ROI. The archived
durable/executive roadmaps are outside the owner-approved closure scope. #114/#120 now close with
PR #151 for the validated session capture and summary/export only. Broader analytics requires
demonstrated production need and new approval, not automatic follow-up issues. The
[locked scope and evidence](114-120-session-insights.md#locked-scope-and-closure) supersede the
earlier parent-issue keep-open instructions; the release hold is unchanged.

## Workspace Cleanup

- Finalized the primary checkout's old merge as `bc1d780`, with exactly the previously staged
  tree `8e60e5736606fa05023c1b4f84e4285153a20d85` and parents `7dd8970` / `6bd519f`.
  The 114 staged paths were existing merge content, not new application edits.
- Committed the existing [checkpoint comparison prototype](prototypes/128-ui/checkpoint-comparison.html)
  unchanged as `d50d7aa`. Its SHA256 is
  `50e42598c5c8e3e20e10e882c2f73e288e6c1fd10c3e5ce1815f707a8e358eca`.
- Integrated that local history into the delivery branch. The only conflict was the final
  newline of `.gitignore`; both parents' identical rules are preserved. The old local
  workspace-ignore commit `7dd8970` is included by ancestry, not duplicated application changes.
- Preserved all ignored review/environment data and the existing worktree/Playwright rules.
- Removed `.worktrees/issue-128-review-first` only after verifying a clean tree, exact equality
  to merged #128, no active Node process, and only ignored build/dependency artifacts.
  Its branch history is retained. The original #114/#120 worktree and this candidate remain.

### Remaining Release Blocker

The 11 September audit refreshed `origin`, found no open PRs before integration, and checked
every worktree and local branch. The old #114/#120 worktree is clean, all previously separate
local work is represented in the combined delivery, and there are no stashes.

The [mandatory deployment gates](deployment.md#mandatory-release-gates) prohibit release while
the original `.docthread-reviews/ado/` snapshots remain in history. A metadata-only check of
`origin/main` still finds original additions in `e0042d4` (20 August) and `d6305ef` (26 August).
No snapshot content was opened or copied for this audit. Deletion from HEAD is not a history
purge, and a successful build cannot satisfy this gate.

The existing SWA workflow deploys every push to `main`, so the integration PR must not merge
until the coordinated cleanup and remaining provider/human release evidence are complete.
No force push, protection change, live-setting deletion, remote main merge or deployment was
performed as part of this local finalization.

## Security Audit

The owner requested a live/repository audit and safe PR amendments on 11 September, then required
any configuration relocation to preserve contributor setup. The audit used the published
`0bc3e0f` code/test candidate; this amendment changes only ignore rules and documentation.

| Check | Observed result |
| --- | --- |
| Tracked text scan | Secretlint 13.0.5 and recommended preset 13.0.5: 148 text files out of 171 tracked files, zero secret-pattern matches; 23 binary PNGs excluded |
| Scanner redaction | Synthetic private-key detection passed; reports retained only locations/rule identifiers, never raw matched content |
| Public configuration | The tracked environment template contains public configuration; no npm authentication assignments; no value relocation identified |
| GitHub secret storage | One repository Actions secret: `AZURE_STATIC_WEB_APPS_API_TOKEN`; no secret value requested |
| Repository variables | `VITE_APP_URL`, `VITE_GH_CLIENT_ID`, `VITE_REVIEW_REPO` scanned in memory; zero matches; values not reported or retained |
| GitHub alert visibility | Secret-scanning status unavailable; open-alert API returned 404. This is not a clean alert inventory |
| Live public assets | GET of canonical root HTML and its directly referenced JS/CSS returned 200 with `nosniff`; scans found zero matches |
| Public file probes | `/.env`, `/.env.local`, and `/.git/config` returned the exact index fallback, not configuration contents; `/api/local.settings.json` returned 404 |
| Public API probes | GET of legacy bridges, notify, and both OAuth routes returned 404. The known Functions are POST-only, so GET results do not establish whether those routes are deployed |
| Deployment context | Latest successful [SWA workflow run 34404481391](https://github.com/gim-home/DocThread/actions/runs/34404481391) was for `f248233` on 9 September; this audit did not deploy |
| Contributor bootstrap | The exact README command passed in disposable fresh/existing setups; existing local values were preserved byte-for-byte |
| Ignore boundaries | Local environment, Functions settings, and Worker secret files are ignored; placeholder template paths remain trackable |

The scan does not cover Git history, binary-image contents, ignored local environment files,
Azure application settings, Worker secrets, organization/environment-level GitHub secrets, or
every dynamically loaded asset. Pattern matching cannot establish that no sensitive data exists.
No authenticated live API request, POST, notification, control-plane mutation, or secret deletion
was performed. The selected Azure CLI subscription was discovered but not confirmed for this
audit, so its live configuration was not inspected.

### Findings And Scope

- The source still deploys an anonymous `POST /api/notify` function that can use server-side email
  or Teams webhooks. A recipient allowlist restricts destinations, not callers. The older
  OAuth-only deployment guide and current source/tests disagree. Hosted notification removal or
  an authenticated replacement requires owner confirmation; this amendment changes neither.
- The former README internal-use exception contradicted the mandatory deployment gates. The
  README now points to those gates without claiming snapshot content was independently examined
  or that repository visibility waives cleanup.
- No secret value was identified for relocation. Public IDs/defaults remain shared in the tracked
  template. [Contributor guidance](../README.md#shared-configuration-and-secrets) now explains
  secret-store access, browser-visible `VITE_` values, and non-overwriting setup. GitHub Secrets
  are not presented as a mechanism for contributors to download credentials.
- Azure app-setting inventory, legacy Worker inventory, and history cleanup remain open. Candidate
  legacy setting names include `NOTIFY_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`, `GH_SERVER_TOKEN`,
  `ADO_PAT`, `ADO_BEARER`, `ADO_ALLOWED_ORGANIZATIONS`, and `REVIEW_REPO`; their live presence
  has not been established. Do not delete them based solely on this list.

## Next Action

**Scope locked, 11 September:** the [minimal product design](review-insights-design.md)
replaces the unapproved durable-analytics proposal with the core open/comment/respond/share flow.
Review rounds, role collection, telemetry storage, and cross-repository reporting are not proposed
for the next release. Keep the existing session insights optional. Validate onboarding, actual
shared persistence, and recovery; create a second PR only for demonstrated gaps. The owner has
approved closing #114/#120 on PR #151's merge for the validated session-only scope, with no required
analytics follow-ups. Finish the scope/evidence commit and verify closing links for all four issues.
Production must demonstrate broader needs before further analytics is designed or implemented.
This approval does not authorize merging/deployment or waive the release gates below.

**Recommendation:** keep the validated combined delivery on `issue/149-150-review-navigation`
while the release hold is addressed. Code/test candidate `9a0414c` has green Linux CI; this does
not satisfy the history-cleanup or provider/human gates. Do not directly merge the old stacked
#128 branch or treat its old CI as CI for this candidate.

Owner `rosacek_microsoft`: confirm whether the existing SWA should be inspected in subscription
`ICX Localization Growth Analytics` (`757ae7ca-0b13-4bb7-a4bd-26080be6736f`), retaining its existing
region, or provide the correct scope. Decide whether to remove hosted anonymous notifications or
approve an authenticated design. Then complete the names-only settings audit and obtain explicit
authorization for any live deletions. No relocation may introduce a required contributor secret
without a working access/migration path.

Owner `rosacek_microsoft` with the repository/security administrator: coordinate the mandatory
history purge, including the write freeze, authorized ref rewrite, protection restoration,
collaborator/fork cleanup and GitHub Support evidence listed in the deployment guide. This
requires separate destructive-operation confirmation; the agent must not infer it from the
request to merge pending changes. Record clean-ref and external cleanup receipts without
retaining sensitive data, then rerun the exact-head CI and approved provider/human checks.

Completion criteria before a main merge: the candidate includes #128 exactly once, preserves
all four issue scopes, has green remote CI at its exact proposed head, and has the required
history-cleanup, provider/human acceptance and deployment evidence. Main merges deploy
automatically. After those gates pass, merge the integration PR and perform live smoke checks;
the linked issues close for their explicitly agreed scope. Do not describe those closures as
delivery of the out-of-scope durable/executive analytics or as live/human validation evidence.

Local preview: <http://127.0.0.1:5182/>. The preview is public-only; session capture is intentionally
unavailable for the sample/signed-out state. Authenticated insights flows are verified in fixtures.
