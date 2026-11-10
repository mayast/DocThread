import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors so a single bad thread, corrupt localStorage
 * entry, or anchoring failure can never leave the user staring at a blank page.
 * Shows the error plus a one-click way to clear local DocThread data and reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('DocThread crashed:', error, info);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  private clearLocalAndReload = () => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('docthread:'))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
    location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 640, margin: '48px auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
          <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
          <p>
            DocThread hit an error while rendering. This is usually caused by stale
            or corrupt saved comments for this document.
          </p>
          <pre
            style={{
              background: '#fff5f5',
              border: '1px solid #f5c2c7',
              color: '#842029',
              padding: 12,
              borderRadius: 6,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={this.clearLocalAndReload}>Clear saved comments &amp; reload</button>
            <button onClick={this.reset}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
