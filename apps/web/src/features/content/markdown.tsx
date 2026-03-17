import type * as React from "react";
import { Link } from "@tanstack/react-router";

export function renderPublicMarkdownInternalLink({
  children,
  className,
  href,
}: {
  children: React.ReactNode;
  className: string;
  href: string;
}): React.ReactElement {
  return (
    <Link className={className} to={href as never}>
      {children}
    </Link>
  );
}
