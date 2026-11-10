import { useEffect, useRef, useState } from 'react';
import type { InboxItem, InboxKind, InboxReadState } from '../inbox';
import { isUnread, unreadCount } from '../inbox';

const KIND_LABEL: Record<InboxKind, string> = {
  mention: 'Mentioned you',
  reply: 'Replied on your thread',
  assignment: 'Waiting on you',
};

function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * Notification center (#31): a bell with an unread badge and a dropdown of the
 * viewer's mentions, replies, and assignments. Clicking an item focuses its
 * thread (and marks it read); "Mark all read" clears the badge.
 */
export function NotificationBell({
  items,
  readState,
  disabled,
  onOpenItem,
  onMarkAllRead,
}: {
  items: InboxItem[];
  readState: InboxReadState;
  disabled: boolean;
  onOpenItem: (item: InboxItem) => void;
  onMarkAllRead: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const unread = unreadCount(items, readState);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const title = disabled
    ? 'Sign in to see notifications'
    : unread > 0
      ? `${unread} unread notification${unread === 1 ? '' : 's'}`
      : 'Notifications';

  return (
    <div className="notif" ref={rootRef}>
      <button
        type="button"
        className="notif-bell"
        aria-label={title}
        title={title}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="menu">
          <div className="notif-head">
            <strong>Notifications</strong>
            <button
              type="button"
              className="notif-mark"
              disabled={unread === 0}
              onClick={() => onMarkAllRead()}
            >
              Mark all read
            </button>
          </div>
          {items.length === 0 ? (
            <p className="notif-empty">You're all caught up.</p>
          ) : (
            <ul className="notif-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`notif-item${isUnread(item, readState) ? ' unread' : ''}`}
                    onClick={() => {
                      onOpenItem(item);
                      setOpen(false);
                    }}
                  >
                    <span className={`notif-kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                    <span className="notif-actor">{item.actor}</span>
                    <span className="notif-snippet">{item.snippet}</span>
                    <span className="notif-time">{relativeTime(item.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
