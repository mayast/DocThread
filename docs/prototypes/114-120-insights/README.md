# Session Insights Browser Evidence

Generated from the isolated local implementation on 9 September 2026 with the existing Playwright
fixture and fail-closed network guards. All identities, sources and finding text are synthetic.
These are not credentialed provider, human usability or deployed-site observations.

| Evidence | File |
| --- | --- |
| Complete three-engine report: 60 scenario runs, 99 axe scans, no violations or escaped requests | [results.json](results.json) |
| Desktop: actual posted/applied/dismissed outcomes and 75% uptake (7 pending in this browser fixture) | [chromium-insights-actual-outcomes-desktop.png](chromium-insights-actual-outcomes-desktop.png) |
| Narrow 320px view, WebKit | [webkit-insights-narrow-320.png](webkit-insights-narrow-320.png) |
| Narrow 390px view, Chromium | [chromium-insights-narrow-390.png](chromium-insights-narrow-390.png) |
| Whole-run capacity refusal with retained prior observations | [chromium-insights-capacity-paused.png](chromium-insights-capacity-paused.png) |

The exact requested 2 posted / 1 applied / 1 dismissed / 6 pending example is separately asserted by
the pure accumulator test; both it and the browser fixture produce numerator 3, denominator 4, rate 0.75.
Tall dialog content scrolls vertically, with keyboard-reachable controls. Viewport screenshots do not
represent offscreen content or prove human screen-reader usability. See the
[per-issue handoff](../../114-120-session-insights.md) for complete scope, limitations and next action.