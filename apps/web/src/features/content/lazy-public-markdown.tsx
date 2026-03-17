import type { ReactElement, ReactNode } from "react";
import {
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
    <Suspense fallback={<LazyPublicMarkdownFallback />}>
      <PublicMarkdown {...props} />
    </Suspense>
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
