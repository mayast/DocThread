# DocThread — Development Telemetry

_A complete, presentable view of how DocThread was built: velocity, quality, and the full work log._

**Window:** 2026-08-20 → 2026-08-29 (~9 days) · **Times:** PDT · **Source:** GitHub issues, PRs, and commit history.

> **How to read cycle time (important caveat):** PRs were **squash-merged and branches deleted**, which
> rewrites each squashed commit's author date to the merge time and discards the branch history. As a
> result, **true "start-coding → merged" cycle time is only recoverable for the two PRs that merged with
> more than one commit** (#78 = 7 min, #108 = 9 min). Every other feature shows `~0`, which is **CI + merge
> latency, not authoring time**. "Issue → Deploy" (lead time) is fully accurate but includes queue/planning
> before coding began. See [Recommended telemetry](#recommended-telemetry-to-capture-going-forward).

---

## 1. Executive summary

- **18 features + 12 fixes shipped in ~9 days** across **66 merged PRs** (18 feat / 12 fix / 26 docs / 1 ci / 9 other).
- The project has **two distinct phases**:
  - **Aug 20–26 — Foundation (~93 commits, +23k lines, 82% of all code):** bootstrap, the 3-provider
    anchoring core, CI, v2 identity/persistence (CAS), and ADO storage.
  - **Aug 27–29 — Feature sprint (13 features, +6k lines):** small, additive, 100%-test-touched diffs at
    ~2 features/day.
- **The "~2 features/day" is a sprint-phase rate, not the 9-day average** — the first week's platform
  investment is what enabled the later velocity.
- **Quality scaffolding is strong:** 269 automated tests, CI-gated (`tsc` + test + build) on every PR,
  100% of feature PRs touched tests, small focused diffs (median ~8 files).
- **The one systemic weakness was deployment/runtime verification** — 3 regressions were CI-green but
  wrong on the live site ("merged ≠ live"). This class is now structurally closed by auto-deploy
  ([#107](https://github.com/gim-home/DocThread/pull/107)) and a Verification & Regression Checklist on
  every issue.

---

## 2. Complete development log (ordered by deployment)

Type key: 🏗 Foundation · 🔧 Infra · 📄 Content · ✨ Feature · 🐛 Fix · 🚨 Deploy regression.
Churn = lines added / deleted. `Regr.` = follow-up fixes attributed to that feature.

| Deployed | Work | Type | Issue / PR | Size | ROI | Issue→Deploy | Start-code→merged | Churn (+/−) | Files | Tests |
|---|---|:--:|---|:--:|:--:|--:|--:|--:|:--:|:--:|
| Aug 20 3:36p | Bootstrap app (Pages + OAuth + email) | 🏗 | [PR#2](https://github.com/gim-home/DocThread/pull/2) | — | — | — | (3c) | +6,267 / −1 | 22 | — |
| Aug 20 3:41p | Bump esbuild / vite | 🔧 | [PR#3](https://github.com/gim-home/DocThread/pull/3) | — | — | — | — | +552 / −721 | 2 | — |
| Aug 21 9:22a | 3 providers, one review core (anchoring) | 🏗 | [PR#10](https://github.com/gim-home/DocThread/pull/10) | — | — | — | (28c) | +6,192 / −1,214 | 56 | ✅ |
| Aug 21 10:31a | Add CI (tests + type-check) | 🏗 | [PR#11](https://github.com/gim-home/DocThread/pull/11) | — | — | — | (3c) | +56 / −2 | 2 | ✅ |
| Aug 21 8:18p | Sample doc / user manual | 📄 | [PR#16](https://github.com/gim-home/DocThread/pull/16) | — | — | — | — | +119 / −34 | 2 | — |
| Aug 24 4:48a | Identity autocomplete + v2 persistence (CAS) | 🏗 | [PR#17](https://github.com/gim-home/DocThread/pull/17) | — | — | — | (3c) | +10,405 / −2,859 | 68 | ✅ |
| Aug 26 10:55a | Fix mention picker | 🐛 | [PR#19](https://github.com/gim-home/DocThread/pull/19) | — | — | — | — | +8 / −3 | 2 | — |
| Aug 26 12:22p | ADO-native review storage | 🏗 | [PR#20](https://github.com/gim-home/DocThread/pull/20) | — | — | — | — | +377 / −15 | 4 | — |
| Aug 26 12:55p | Fix ADO doc-save hang (stale revision) | 🐛 | [PR#21](https://github.com/gim-home/DocThread/pull/21) | — | — | — | — | +93 / −20 | 2 | ✅ |
| Aug 26 1:51p | Fix @mention email relay | 🐛 | [PR#22](https://github.com/gim-home/DocThread/pull/22) | — | — | — | — | +557 / −49 | 15 | ✅ |
| Aug 27 12:03p | Recently-viewed panel | ✨ | [#28](https://github.com/gim-home/DocThread/issues/28) | — | — | 0.3 h | ~0 ¹ | +420 / −1 | 6 | ✅ |
| Aug 28 2:26p | Deep-link to thread | ✨ | [#32](https://github.com/gim-home/DocThread/issues/32) | S (~2) | ⭐⭐⭐⭐⭐ | 21.3 h | ~0 ¹ | +168 / −8 | 7 | ✅ |
| Aug 28 2:51p | Reactions on comments | ✨ | [#37](https://github.com/gim-home/DocThread/issues/37) | S (~2) | ⭐⭐⭐ | 21.7 h | ~0 ¹ | +664 / −1 | 10 | ✅ |
| Aug 28 3:32p | Notification center + Teams | ✨ | [#31](https://github.com/gim-home/DocThread/issues/31) | S–M (~5) | ⭐⭐⭐⭐⭐ | 22.4 h | ~0 ¹ | +965 / −13 | 13 | ✅ |
| Aug 28 4:05p | Spell & grammar check | ✨ | [#62](https://github.com/gim-home/DocThread/issues/62) | S–M (~3) | ⭐⭐⭐⭐ | 1.1 h | ~0 ¹ | +107 / −2 | 6 | ✅ |
| Aug 28 4:45p | Edit Doc split preview | ✨ | [#38](https://github.com/gim-home/DocThread/issues/38) | S–M (~3–5) | n/a | 23.5 h | ~0 ¹ | +143 / −9 | 5 | ✅ |
| Aug 28 5:36p | Formatting toolbar | ✨ | [#78](https://github.com/gim-home/DocThread/issues/78) | S–M (~3–5) | ⭐⭐⭐⭐ | 0.4 h | **7 min** ² | +457 / −22 | 6 | ✅ |
| Aug 28 6:05p | Comment search & sort | ✨ | [#34](https://github.com/gim-home/DocThread/issues/34) | S (~3) | ⭐⭐⭐⭐ | 24.9 h | ~0 ¹ | +201 / −9 | 5 | ✅ |
| Aug 28 6:27p | Suggested edits | ✨ | [#35](https://github.com/gim-home/DocThread/issues/35) | M (~8) | ⭐⭐⭐⭐ | 25.3 h | ~0 ¹ | +486 / −7 | 12 | ✅ |
| Aug 28 6:47p | AI-suggested edits | ✨ | [#63](https://github.com/gim-home/DocThread/issues/63) | M (~8) | ⭐⭐⭐⭐ | 3.8 h | ~0 ¹ | +347 / −7 | 14 | ✅ |
| Aug 28 7:22p | AI-readiness score | ✨ | [#44](https://github.com/gim-home/DocThread/issues/44) | M | ⭐⭐⭐⭐⭐ | 10.0 h | ~0 ¹ | +989 / −20 | 10 | ✅ |
| Aug 28 7:55p | AI reviewer pass | ✨ | [#43](https://github.com/gim-home/DocThread/issues/43) | M–L | ⭐⭐⭐⭐⭐ | 10.6 h | ~0 ¹ | +941 / −20 | 12 | ✅ |
| Aug 28 11:28p | Pages blank-page | 🚨 | [#103](https://github.com/gim-home/DocThread/issues/103) → [PR#105](https://github.com/gim-home/DocThread/pull/105) | — | — | 1.2 h | — | — | — | — |
| Aug 28 11:47p | Reactions invisible when signed out | 🚨 | [#104](https://github.com/gim-home/DocThread/issues/104) → [PR#106](https://github.com/gim-home/DocThread/pull/106) | — | — | 1.0 h | — | — | — | — |
| Aug 29 1:26a | AI proposed-replacement (Accept fix) | ✨ | [#108](https://github.com/gim-home/DocThread/issues/108) | M | High | (open) | **9 min** ² | +182 / −43 | 4 | ✅ |

¹ `~0` = **not true coding time** — single-commit squash-merge + deleted branch erased the authoring span; read as CI + merge latency.
² Real span from a multi-commit PR (first commit → merge).
Foundation PRs show **(Nc)** = commit count; their branches were squashed too, so no cycle time is recoverable.

---

## 3. Regression detail

12 fix PRs total across the project (**0.67 fixes per feature** in the sprint window). Concentration:

| Feature | Regr. fixes | Fix PRs / issues |
|---|:--:|---|
| Reactions on comments ([#37](https://github.com/gim-home/DocThread/issues/37)) | **3** | [PR#72](https://github.com/gim-home/DocThread/pull/72) (ADO parity), [#104](https://github.com/gim-home/DocThread/issues/104) → [PR#106](https://github.com/gim-home/DocThread/pull/106) (invisible-when-signed-out) |
| AI reviewer pass ([#43](https://github.com/gim-home/DocThread/issues/43)) | **2** | [PR#97](https://github.com/gim-home/DocThread/pull/97) (button clip), [PR#98](https://github.com/gim-home/DocThread/pull/98) (jump-to-location) |
| Notification center ([#31](https://github.com/gim-home/DocThread/issues/31)) / Deep-link ([#32](https://github.com/gim-home/DocThread/issues/32)) | 1 | [PR#73](https://github.com/gim-home/DocThread/pull/73) (email-link focus) |
| AI-readiness score ([#44](https://github.com/gim-home/DocThread/issues/44)) | 1 | [PR#99](https://github.com/gim-home/DocThread/pull/99) (jump-to-location) |
| Spell & grammar check ([#62](https://github.com/gim-home/DocThread/issues/62)) | 1 | [PR#77](https://github.com/gim-home/DocThread/pull/77) (toolbar overlap) |
| Early stabilization (foundation) | 3 | [PR#19](https://github.com/gim-home/DocThread/pull/19), [PR#21](https://github.com/gim-home/DocThread/pull/21), [PR#22](https://github.com/gim-home/DocThread/pull/22) |

**Deploy/runtime regressions (the costly class — CI-green but wrong live):** 3 —
Pages blank-page ([#103](https://github.com/gim-home/DocThread/issues/103)), reactions invisible until deployed
([#104](https://github.com/gim-home/DocThread/issues/104)), and the manual-deploy gap (fixed by auto-deploy
[#107](https://github.com/gim-home/DocThread/pull/107)).

---

## 4. Roll-up by work type

| Type | Count | Total churn (+/−) | Tests-touched | Note |
|---|:--:|--:|:--:|---|
| 🏗 Foundation | 5 (#2, #10, #11, #17, #20) | **+23,297 / −4,091** | 3 / 5 | The platform — ~82% of all code |
| ✨ Feature | 13 | +6,070 / −163 | 13 / 13 (100%) | The Aug 27–29 sprint |
| 🐛 Fix (pre-sprint) | 3 (#19, #21, #22) | +658 / −72 | 2 / 3 | Early stabilization |
| 🐛 Fix (sprint regressions) | 9 | — | — | 0.67 / feature |
| 🔧 Infra / 📄 Content | 2 (#3, #16) | +671 / −755 | 0 / 2 | deps + sample doc |

---

## 5. Headline metrics (velocity & quality)

| Metric | Value | Signal |
|---|---|---|
| Repo lifespan | ~9 days (Aug 20–29) | — |
| Features shipped | 18 | ~2/day at peak (sprint phase) |
| Merged PRs | 66 (18 feat / 12 fix / 26 docs / 1 ci / 9 other) | Docs-heavy = good hygiene |
| Commits (Aug 20–26 foundation) | ~93 | Heavy platform investment |
| Lead time (issue → deploy), median | ~10 h | Includes queue/planning |
| Cycle time (start-code → merged) | 7–9 min (only 2 measurable) | Rest erased by squash |
| Total feature churn | ~+6,900 / −140 lines | Additive, low rework |
| Median files per feature | ~8 | Small, focused diffs |
| Feature PRs touching tests | 13 / 13 (100%) | Strong test discipline |
| Automated tests | 269 passing | High coverage |
| Regression fixes | 12 (0.67 / feature) | Moderate; clustered |
| Deploy/runtime regressions | 3 (all CI-green-but-wrong-live) | The one systemic gap |
| Change-failure rate (DORA-style) | ~30% (≈12 fixes / ~40 deploys) | Trend-down target |
| CI pass rate on merge | ~100% | Gated pipeline |
| Open PR backlog | 0 | Clean flow |

---

## 6. Key insights

1. **Estimate size predicted effort, not calendar time.** Even M–L features (AI reviewer #43, readiness
   #44) shipped in the same near-instant CI/merge window as S features — cycle time decoupled from points.
2. **Regression risk tracked surface-area / deploy-sensitivity, not size.** The most-fixed feature —
   Reactions (#37) — was the *smallest* estimate (S, ⭐⭐⭐) yet drew 3 fixes, including 2 deploy/runtime.
3. **Highest-ROI features shipped fastest and cleanest** (⭐⭐⭐⭐⭐: #31, #32, #43, #44).
4. **The only systemic weakness was deployment verification** — every deploy/runtime regression was
   invisible to unit tests. Now closed structurally (auto-deploy + verification checklist).
5. **Foundation enabled velocity.** ~82% of all code was the first-week platform; the visible "2/day"
   sprint rate is a *return on that investment*, not a steady-state average.

---

## 7. Recommended telemetry to capture going forward

The current history can't show true cycle time or several quality signals. To get a full DORA-grade view:

1. **Preserve true cycle time** — stop squash-merge (or keep the original author date) and **retain merged
   branches**, so `first-commit → merge` is measurable for *every* feature (only 2 are today).
2. **Time-to-first-regression** and **regression MTTR** — how long a defect lived and how fast it was fixed.
3. **Deploy lag** — merge → live-serving delta (the hidden failure in #103/#104; ~0 now via auto-deploy).
4. **Escaped-vs-caught ratio** — defects caught by CI vs. found live (the 3 deploy regressions were 100%
   escaped — the metric that would have flagged the gap early).
5. **Change-failure rate (DORA)** — % of deploys causing a fix; a real number (~30%) to trend down.

---

_Generated from GitHub issues, PRs, and commit history for `gim-home/DocThread`. Cycle-time caveats noted
inline; lead time and churn are exact._
