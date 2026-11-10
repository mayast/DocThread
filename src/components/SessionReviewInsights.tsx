import { useState } from 'react';
import { Dialog } from './Dialog';
import {
  exportReviewSessionInsights,
  summarizeReviewSessionInsights,
  type ReviewSessionInsights,
  type SessionDecisionCounts,
} from '../reviewSessionInsights';

interface Props {
  session: ReviewSessionInsights;
  canCapture: boolean;
  onCaptureChange: (enabled: boolean) => void;
  onClear: () => void;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  local: 'Local', ai: 'AI', unknown: 'Unknown', compliance: 'Compliance',
  security: 'Security', readiness: 'Readiness', other: 'Other',
};

function uptake(counts: SessionDecisionCounts): string {
  return counts.rate === null ? 'No decisions yet'
    : `${Math.round(counts.rate * 100)}% (${counts.numerator}/${counts.denominator})`;
}

function Breakdown({ label, buckets }: { label: string; buckets: Record<string, SessionDecisionCounts> }) {
  return (
    <table>
      <caption>{label}</caption>
      <thead><tr><th scope="col">Category</th><th scope="col">Observed</th><th scope="col">Uptake</th></tr></thead>
      <tbody>
        {Object.entries(buckets).map(([category, counts]) => (
          <tr key={category}>
            <th scope="row">{CATEGORY_LABELS[category]}</th>
            <td>{counts.observed}</td><td>{uptake(counts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SessionReviewInsights({ session, canCapture, onCaptureChange, onClear, onClose, returnFocusTo }: Props) {
  const [downloadNotice, setDownloadNotice] = useState('');
  const summary = summarizeReviewSessionInsights(session);
  const exportSummary = () => {
    let downloadUrl: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      downloadUrl = URL.createObjectURL(new Blob([exportReviewSessionInsights(session)], { type: 'application/json' }));
      link = document.createElement('a');
      link.href = downloadUrl;
      link.download = 'docthread-session-review-insights.json';
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      setDownloadNotice('Summary download requested. Downloaded exports cannot be recalled.');
    } catch {
      setDownloadNotice('Download failed. Captured data is still in memory. Retry export before leaving.');
    } finally {
      link?.remove();
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    }
  };

  return (
    <Dialog labelledBy="session-insights-title" onClose={onClose} className="session-insights" returnFocusTo={returnFocusTo}>
      <h3 id="session-insights-title">Session review insights</h3>
      <p>Capture decisions in this tab for this document. Nothing is sent or saved; reloading or switching documents clears it. Export a summary before leaving if needed.</p>
      <p className="session-insights-note">Turning capture off or clearing removes captured data immediately. Source or account changes, sign-out, closing this app, and reload clear it and turn capture off. No retroactive capture. Downloaded exports cannot be recalled.</p>
      <label className="session-insights-toggle">
        <input type="checkbox" checked={session.status !== 'off'} disabled={!canCapture}
          onChange={event => { setDownloadNotice(''); onCaptureChange(event.target.checked); }} />
        Capture session decisions
      </label>
      {!canCapture && <p className="session-insights-note">Capture requires an authenticated source with shared-review write access. It is unavailable for samples, signed-out or read-only sources, and unavailable transports.</p>}
      <p role="status" className="session-insights-status">
        {session.status === 'paused'
          ? `Capture paused at the 1,000-observation limit. The entire run of ${summary.coverage.omitted_observations_capacity} findings was omitted. Review is unaffected. Export remains available. Clear captured data to resume capture.`
          : session.status === 'capturing' ? 'Capture on for new review runs.' : 'Capture off. No captured data.'}
      </p>
      <section aria-labelledby="session-uptake-title">
        <h4 id="session-uptake-title">Session decision uptake</h4>
        <p className="session-uptake" data-session-uptake>{uptake(summary.counts)}</p>
        <dl className="session-insights-counts">
          {(['observed', 'pending', 'posted', 'applied', 'dismissed'] as const).map(count => (
            <div key={count}><dt>{count[0].toUpperCase() + count.slice(1)}</dt><dd data-session-count={count}>{summary.counts[count]}</dd></div>
          ))}
        </dl>
        <p className="session-insights-note">(Posted + applied) / (posted + applied + dismissed). Pending is excluded. Uptake is not correctness, AI quality, source-save success, or notification delivery.</p>
        <Breakdown label="By origin" buckets={summary.by_origin} />
        <Breakdown label="By pass" buckets={summary.by_pass} />
      </section>
      <p className="session-insights-note">{summary.coverage.captured_runs} captured runs. {summary.coverage.omitted_runs_capacity} whole runs omitted at capacity; {summary.coverage.runs_started_while_paused} runs started while paused.</p>
      <details>
        <summary>Coverage and limits</summary>
        <p>Opt-in and final displayed cohorts only: policy-hidden and capped findings are excluded. Repeated runs count as observations, not unique findings, reviewers or documents.</p>
        <p>Cycle time, reviewer reach and roles, readiness lift, policy and skill comparisons, and saved-change success are not collected.</p>
      </details>
      {downloadNotice && <p role="status" className="session-insights-status">{downloadNotice}</p>}
      <div className="modal-actions">
        <button type="button" onClick={() => { setDownloadNotice(''); onClear(); }} disabled={session.status === 'off'}>Clear captured data</button>
        <button type="button" onClick={exportSummary} disabled={session.status === 'off'}>Export JSON</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}