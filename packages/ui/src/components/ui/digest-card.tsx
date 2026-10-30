import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { Card, CardContent, CardHeader, CardTitle, type CardProps } from "./card.js";

export type DigestCardProps = {
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  action?: ReactNode;
  size?: CardProps["size"];
  height?: CardProps["height"];
  className?: string;
} & (
  | { primary: ReactNode; supporting?: ReactNode; meta?: ReactNode; children?: never }
  | { children: ReactNode; primary?: never; supporting?: never; meta?: never }
);

export function DigestCard({
  icon,
  label,
  badge,
  action,
  size = "sm",
  height = "summary",
  className,
  ...body
}: DigestCardProps) {
  return (
    <Card
      className={cn(
        "min-w-0 gap-3 rounded-none border-0 bg-black/25 px-0 py-3.5 shadow-none",
        className,
      )}
      size={size}
      height={height}
    >
      <CardHeader className="flex min-h-7 shrink-0 items-center gap-3 pb-1">
        <span aria-hidden="true" className="shrink-0 text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <CardTitle className="shrink-0 text-xs font-bold tracking-wide text-muted-foreground uppercase">
          {label}
        </CardTitle>
        {badge}
        <span className="flex-1" />
        {action}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
        {"children" in body ? (
          body.children
        ) : (
          <>
            <div>{body.primary}</div>
            {body.supporting == null ? null : <div>{body.supporting}</div>}
            {body.meta == null ? null : <div className="mt-auto">{body.meta}</div>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
