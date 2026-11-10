# Session Review Insights: #114 / #120

Owner: `rosacek_microsoft`. Updated: 11 September 2026.

## Locked Scope And Closure

The owner approved the [lean product scope](review-insights-design.md) and narrowed
[#114](https://github.com/gim-home/DocThread/issues/114) and
[#120](https://github.com/gim-home/DocThread/issues/120) to the implemented session-only contract:

- #114: optional, default-off, memory-only capture of final displayed findings/gaps and actual
  first decisions, with bounded metadata, lifecycle resets, and no new persistent/network activity.
- #120: one optional surface using the same accumulator for accurate counts, bounded breakdowns,
  and manual aggregate JSON export with coverage, privacy, and missing-metric disclosures.

The current approval supersedes the historical keep-open direction below. Both issues are to close
on PR #151's merge for this scope only. Original durable/executive analytics proposals are retained
as out-of-scope history, not required follow-ups. Build broader analytics only if production use
demonstrates a repeated unmet need, the decision/value is documented, and a new scope is approved.

## Current Validation

The current implementation was reviewed against all five scoped acceptance criteria per issue.
No additional product/UX gap was identified within #114/#120; do not invent runtime changes merely
to close the issues. The per-criterion mapping below remains the implementation evidence.

| Check | Result on code/test baseline `052d14e` |
| --- | --- |
| Focused accumulator/export tests | All 16 passed |
| Exact-head Linux CI | [Run 34590689773](https://github.com/gim-home/DocThread/actions/runs/34590689773): build, Chromium, Firefox, WebKit and security passed |
| Insights-only browser evidence | 13 scenario groups per engine, 39 passing executions |
| Insights-only accessibility | 19 axe scans per engine, 57 total, zero violations; keyboard and narrow-layout assertions passed |
| Complete regression suite | 333 tests plus installer checks passed in the validated candidate |

Evidence notes: [#114](https://github.com/gim-home/DocThread/issues/114#issuecomment-5633426453)
and [#120](https://github.com/gim-home/DocThread/issues/120#issuecomment-5633426444). Those notes
predate the scope lock; their full-parent keep-open conclusion is superseded by this approval.
Synthetic fixtures do not establish credentialed-provider, human screen-reader/native-zoom/user,
or deployed-site acceptance. Those release gates remain separate and unchanged. See the
[current handoff](review-ui-validation.md) for release ownership and pending actions.

## Historical Base And Authority

The following base/authority record describes 9 September, not the current PR or closure authority.
PR #142 was subsequently merged into the old #128 branch; its feature-only delta was reconciled
into PR #151 after #128's squash merge. No duplicate #128 runtime was reintroduced.

| Item | Verified state |
| --- | --- |
| Implementation branch | `issue/114-120-session-insights` |
| Pull request | Open [#142](https://github.com/gim-home/DocThread/pull/142), covering both session-only increments |
| Isolated worktree | `.worktrees/issue-114-120-session-insights` |
| Base | Open [PR #141](https://github.com/gim-home/DocThread/pull/141), `75da35e33aec9949f82404e1c5f50f0f7b2116cd` |
| PR target | `issue/128-review-first`, stacked on #141; not main |
| Remote main at start | `6bd519f7bb7f4db117adae4a385cd31538265b6b` |
| Existing checkout | Its conflicted merge and unrelated changes were not edited |
| Authorized work | Commit and push this isolated branch, open a PR covering both increments, and maintain #114/#120 ownership/status |
| Issue status | Both open, assigned to `rosacek_microsoft`, labelled `status:implemented-needs-validation`; scope-limited validation notes posted |
| Not authorized/performed | Merge, deployment, issue closure; no modifications to #141's branch |

The authorized PR targets #141's branch so its diff contains only this increment. Do not retarget to
main while that would duplicate #141's changes. Before later integration, recheck #141 and main and
reconcile the stack as needed. Main merges deploy automatically; PR approval is not deployment approval.
PR #141 was rechecked after validation and remains open at the same head/base. The original checkout's
index and `MERGE_HEAD` witnesses remain unchanged, including its pre-existing merge conflict.
Issue updates: [#114 validation note](https://github.com/gim-home/DocThread/issues/114#issuecomment-5605178439)
and [#120 validation note](https://github.com/gim-home/DocThread/issues/120#issuecomment-5605178442).

## Contract And Code

No material product contradiction was found. `CommentGutter` owns unified review completion and actions;
`App` owns their actual successful local transitions. Its boolean acceptance callback needed a minimal
typed result. Existing source identity and account keys are used only as runtime invalidation guards,
never as insight records. Shared-review eligibility uses the existing review persistence capability,
authenticated identity and transport availability, not source-edit permission alone.

- One pure accumulator holds normalized origin/pass/severity and opaque internal run/observation handles.
  Only the final displayed cohort is frozen. A run begun while capture is off cannot acquire records later.
- First successful outcome wins: `posted_as_thread`, `applied_to_draft`, or `dismissed`. Failed local
  persistence stays pending. Combined post/apply is one applied decision; a successful thread post with
  an unmatchable fix is posted only. Later sidecar/source-save/notification results are not these metrics.
- Off/clear invalidates in-flight generations. Source/account changes, sign-out, teardown and reload
  clear and disable capture. Draft changes invalidate obsolete async review results without erasing
  previous completed observations for the same source. No document or thread draft is cleared by insights.
- The 1,000-observation limit includes pending. An overflowing run is entirely omitted, previous data
  remains, and capture pauses. Existing review actions keep working. Clear starts an empty cohort.
- Manual JSON export reconstructs allowed aggregates only, with no source/user coordinates, prose,
  replacements, names, policy/skill text, raw events, IDs or exact timestamps. No storage, telemetry
  request, log, sidecar field, backend, permission or dependency was introduced.
- Uptake is `(posted + applied) / (posted + applied + dismissed)`, excluding pending. Empty denominators
  produce `null` / "No decisions yet". Local, AI and unknown origins and bounded pass/severity buckets
  remain separate. Repeated runs count as observations, not unique findings, reviewers or documents.
- Export includes opt-in/displayed-cohort bias, captured/omitted/paused run coverage, and explicit
  `not_collected` for cycle time, reviewer reach/roles, readiness lift, policy/skill comparison and
  saved-change success. Uptake is not correctness, AI quality, approval, ROI or recipient delivery.
- The optional dialog reuses Primer styles and the existing `Dialog`. Its explicit Tools focus-return
  target addresses WebKit click-focus behavior. The findings scan also exposed existing nested-button
  list semantics and badge contrast; the touched panel now uses a native passage-title button, ordinary
  list items and existing high-contrast palette tokens. Keyboard Accept/Dismiss no longer gets intercepted.

## #114 AC Evidence

| AC | Implementation and automated evidence | Boundary / remaining evidence |
| --- | --- | --- |
| Final displayed findings/gaps; reruns and stale results | `onRunReview` snapshots after policy filtering. Unit tests cover unique handles, repeat completion and no retroactivity. Browser groups cover reruns, hidden/capped/unanchorable findings, delayed source results and newer draft runs. | Only unified findings/gaps; standalone suggestion lifecycle remains deferred. |
| Actual failed/posted/applied outcomes | `acceptReviewFinding` returns a typed runtime outcome. Browser tests cover failed local storage, double callbacks, keyboard actions, combined apply and stale-fix posted fallback, with no source PUT before confirmation. | A successful local transition is not confirmation of sidecar/source persistence or delivery. |
| Pure bounded accumulator | [16 focused tests](../tests/reviewSessionInsights.test.ts) cover opt-in, frozen metadata-only cohorts, generation invalidation, first-outcome idempotency, unknown categories, exact capacity and whole-run refusal. | No cross-session dedupe or durable events. |
| Lifecycle and disabled capabilities | [Browser scenarios](../tests/reviewSessionInsights.browser.js) cover source switch/teardown, reload, off/clear, delayed completion, sign-out and replacement-account sign-in; sample, signed-out, read-only and unavailable paths cannot capture. | Account replacement is exercised through the existing fixture sign-out/sign-in path, not a credentialed provider account change. |
| Privacy exclusions | Sentinel prose/email/URL/path/skill text cannot enter normalized records or JSON. Browser checks compare storage/review snapshots, unchanged off/on request sequences, no inspect/export calls and no sentinel logs. | Fixtures only; no live telemetry or raw event export is added. |

## #120 AC Evidence

| AC | Implementation and automated evidence | Boundary / remaining evidence |
| --- | --- | --- |
| Same accumulator and correct arithmetic | `summarizeReviewSessionInsights` reuses #114 observations. Exact unit witness: 2 posted, 1 applied, 1 dismissed, 6 pending => numerator 3, denominator 4, rate 0.75. Null, origin/pass/severity and rerun cases also pass. | Uptake is not correctness or unique-reviewer adoption. |
| One optional surface | Tools entry opens [SessionReviewInsights](../src/components/SessionReviewInsights.tsx); checkbox, clear and manual export only. Keyboard focus/return and 320/390px layout assertions run per engine. | No dashboard, onboarding, role questions or new default commenting controls. |
| Allowed-field aggregate JSON | Exact export keys/categories and uncollected fields are asserted in unit tests; browser download is parsed and checked for private text/IDs. Coverage and interpretation limits are visible in the dialog. | No raw records, clocks, skill/policy comparisons, readiness lift or executive estimates. |
| Inspect/export is read-only; failures and capacity | Browser snapshots show no review/storage mutation or new calls during inspection/export. Forced download failure preserves counts and retry succeeds. Overflow retains prior records; export/reset remain usable. | A requested browser download cannot prove a human retained the file. Exported files cannot be recalled. |
| Documentation and regression | [README](../README.md) and [regression checklist](REGRESSION-CHECKLIST.md) document lifetime, bias, pending exclusion and missing measures. Required local gates below. | Human, real-provider and post-deployment checks remain separate. |

## Historical Validation (9 September)

| Gate | Result |
| --- | --- |
| `npm ci` | Passed through configured proxy; 198 packages installed, no reported vulnerabilities |
| `npm test` | 323 passing tests: 36 pretests including 16 new accumulator/export tests, plus 287 existing tests |
| Installer checks | Passed for GitHub and Azure Repos content repository installation/idempotence |
| Production build | Final rebuild passed with `github=public-only graph=off ado=off` |
| Full browser matrix | 20 scenario groups in each of Chromium, Firefox and WebKit: 60 passing runs |
| Automated accessibility | 33 axe WCAG A/AA scans per engine: 99 total, zero violations |
| Keyboard / layout | Enter-to-post, Space-to-dismiss, Tab wrapping, Escape focus return, 320/390px insights and existing narrow/CSS-zoom recovery checks passed |
| Network boundaries | Fixture rejects unknown provider/API requests; outer context aborts escaped origins, protected endpoints and writes |
| Existing warnings | Retained dynamic/static review-policy import and bundle-size warnings; no bundling refactor |

The complete [browser report](prototypes/114-120-insights/results.json) and selected
[screenshots](prototypes/114-120-insights/README.md) are retained in the repository worktree.
The report has no unexpected or escaped provider requests. The screenshot review additionally caught
and corrected inherited modal-width specificity that a no-overflow assertion alone did not detect.

Local production preview: <http://127.0.0.1:5194/>. It uses the validated public-only build, not credentialed
development transports. Capture is intentionally unavailable for the sample and signed-out preview;
the authenticated outcome/capacity flows are exercised by the isolated synthetic browser matrix.

These are automated synthetic-provider fixtures, not credentialed provider, screen-reader, user-study
or live deployment evidence. Existing #128 completion/release gates remain open. Required before release:
approved disposable provider/account combinations and recipients; real save/notification/recovery
observations; human screen-reader/native zoom and uncoached reviewer checks; integration/deployment
approval followed by live smoke verification. No real provider data or recipients were used here.

## Changed Files

- [reviewSessionInsights.ts](../src/reviewSessionInsights.ts): pure accumulator, counts, categories and JSON.
- [App.tsx](../src/App.tsx): actual outcomes and existing source/auth capability boundary.
- [CommentGutter.tsx](../src/components/CommentGutter.tsx): run snapshots, action verdicts, lifecycle, Tools host and accessible finding controls.
- [SessionReviewInsights.tsx](../src/components/SessionReviewInsights.tsx), [Dialog.tsx](../src/components/Dialog.tsx), [styles.css](../src/styles.css): optional dialog, explicit focus return and scoped layout/contrast.
- [reviewSessionInsights.test.ts](../tests/reviewSessionInsights.test.ts), [reviewSessionInsights.browser.js](../tests/reviewSessionInsights.browser.js): pure and browser evidence.
- [reviewUi.fixture.js](../tests/reviewUi.fixture.js), [test-browser.mjs](../scripts/test-browser.mjs), [package.json](../package.json): reuse fixture/matrix, isolated synthetic AI responses, default test gate.
- [README](../README.md), [regression checklist](REGRESSION-CHECKLIST.md), this handoff: session contract and evidence.
- [Browser evidence](prototypes/114-120-insights/README.md): generated report and selected synthetic desktop/mobile/capacity captures.

## Next Action

Record this scope lock in #114/#120 and PR #151, retain the original proposals as out-of-scope
history, and verify all four closing links after the follow-up commit. The release owner must
still complete the [separate release gates](review-ui-validation.md#next-action) before merging.
No durable telemetry, role collection, broader #33/#46/agent integration, or executive reporting
is required for these scoped closures. Further analytics needs production evidence and approval.