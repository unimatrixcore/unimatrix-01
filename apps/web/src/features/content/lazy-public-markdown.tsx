import type { ReactElement, ReactNode } from "react";
import {
  Component,
  Suspense,
  lazy,
} from "react";

const PublicMarkdown = lazy(async () => {
  const module = await import("@unimatrix/ui/public");

  return { default: module.PublicMarkdown };
});

export interface LazyPublicMarkdownProps {
  className?: string;
  markdown: string;
  renderInternalLink?: (props: {
    href: string;
    children: ReactNode;
    className: string;
  }) => ReactElement;
}

export function LazyPublicMarkdown(props: LazyPublicMarkdownProps) {
  return (
    <LazyPublicMarkdownErrorBoundary resetKey={props.markdown}>
      <Suspense fallback={<LazyPublicMarkdownFallback />}>
        <PublicMarkdown {...props} />
      </Suspense>
    </LazyPublicMarkdownErrorBoundary>
  );
}

interface LazyPublicMarkdownErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface LazyPublicMarkdownErrorBoundaryState {
  hasError: boolean;
}

class LazyPublicMarkdownErrorBoundary extends Component<
  LazyPublicMarkdownErrorBoundaryProps,
  LazyPublicMarkdownErrorBoundaryState
> {
  state: LazyPublicMarkdownErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): LazyPublicMarkdownErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidUpdate(
    prevProps: Readonly<LazyPublicMarkdownErrorBoundaryProps>,
  ) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({
        hasError: false,
      });
    }
  }

  render() {
    if (this.state.hasError) {
      return <LazyPublicMarkdownErrorState />;
    }

    return this.props.children;
  }
}

function LazyPublicMarkdownErrorState() {
  return (
    <div
      role="status"
      className="border border-border/60 bg-background/35 px-4 py-4 text-sm leading-7 text-muted-foreground"
    >
      Markdown content could not be loaded right now. Refresh the page or try again in a moment.
    </div>
  );
}

function LazyPublicMarkdownFallback() {
  return (
    <div aria-hidden="true" className="grid gap-4">
      <div className="h-5 w-40 animate-pulse bg-muted/55" />
      <div className="grid gap-3">
        <div className="h-4 w-full animate-pulse bg-muted/40" />
        <div className="h-4 w-[92%] animate-pulse bg-muted/40" />
        <div className="h-4 w-[88%] animate-pulse bg-muted/40" />
      </div>
    </div>
  );
}
