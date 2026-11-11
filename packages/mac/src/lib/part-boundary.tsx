import { Component, type ErrorInfo, type ReactNode } from 'react';
import { type WindowCrash, crashOf } from './crash-model.js';

interface PartBoundaryProps {
  /** Which part this is, for the black box ("notifications", "window"). */
  readonly part: string;
  /** Tell the daemon (diagnostics.windowCrash); never throws. */
  readonly onCrash: (crash: WindowCrash) => void;
  /** What shows in its place: the error, and a way to draw it again. */
  readonly fallback: (error: Error, retry: () => void) => ReactNode;
  readonly children: ReactNode;
}

/**
 * A part of the window that throws while drawing shows what went wrong in its place, instead of
 * React taking the whole window down to grey (BLG-905), and says so to the black box, so Report
 * a Problem shows the error and where it came from (the app you ship has no developer tools).
 */
export class PartBoundary extends Component<PartBoundaryProps, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      this.props.onCrash(crashOf(this.props.part, error, info.componentStack));
    } catch {
      // Noting it is best effort: what shows in its place matters more.
    }
  }

  private readonly retry = (): void => this.setState({ error: undefined });

  override render(): ReactNode {
    const { error } = this.state;
    return error ? this.props.fallback(error, this.retry) : this.props.children;
  }
}
