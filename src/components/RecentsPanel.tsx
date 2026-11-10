import type { RecentEntry } from '../recents';

interface RecentsPanelProps {
  entries: RecentEntry[];
  /** Canonical key of the currently loaded source, if any. */
  currentKey: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (entry: RecentEntry) => void;
}

/**
 * Collapsible left panel listing recently viewed documents. Purely presentational:
 * it renders the list and a toggle; loading and persistence live in the caller.
 * Collapsing shows a thin rail with a reopen affordance so it never traps the user
 * and returns the freed width to the document/review area.
 */
export function RecentsPanel({
  entries,
  currentKey,
  collapsed,
  onToggle,
  onOpen,
}: RecentsPanelProps) {
  if (collapsed) {
    return (
      <div className="recents collapsed" data-docthread-ui>
        <button
          type="button"
          className="recents-toggle"
          title="Show recently viewed files"
          aria-label="Show recently viewed files"
          aria-expanded={false}
          onClick={onToggle}
        >
          <span aria-hidden>»</span>
          <span className="recents-rail-label">Recent</span>
        </button>
      </div>
    );
  }

  return (
    <div className="recents" data-docthread-ui>
      <div className="recents-header">
        <h2>Recently viewed</h2>
        <button
          type="button"
          className="recents-toggle"
          title="Hide recently viewed files"
          aria-label="Hide recently viewed files"
          aria-expanded={true}
          onClick={onToggle}
        >
          <span aria-hidden>«</span>
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="recents-empty">
          Documents you open will appear here for quick access.
        </p>
      ) : (
        <ul className="recents-list">
          {entries.map((entry) => {
            const isCurrent = entry.key === currentKey;
            return (
              <li
                key={entry.key}
                className={isCurrent ? 'recents-item current' : 'recents-item'}
              >
                <button
                  type="button"
                  className="recents-link"
                  title={entry.url}
                  disabled={isCurrent}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => onOpen(entry)}
                >
                  <span className="recents-doc">{entry.docLabel}</span>
                  <span className="recents-meta">
                    {entry.repoLabel}
                    {entry.refLabel ? ` · ${entry.refLabel}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
