import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reloadOnceForStaleAssets, isChunkLoadError } from '../lib/staleAssets';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render and lazy-chunk failures below the shell so a stale build
 * (tab open across an update) shows a recoverable message, not a blank screen.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] render error:', error, info.componentStack);
    if (isChunkLoadError(error)) reloadOnceForStaleAssets();
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card mx-auto mt-20 max-w-md text-center">
        <h2 className="text-lg font-semibold text-content-primary">Something went wrong</h2>
        <p className="mt-2 text-sm text-content-muted">
          {isChunkLoadError(this.state.error)
            ? 'A new version of Overwatch may have been installed. Reload to get the latest version.'
            : 'This page failed to render. Reloading usually fixes it.'}
        </p>
        <button className="btn btn-primary mt-4" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
