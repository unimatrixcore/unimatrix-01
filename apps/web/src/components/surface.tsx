import type { ComponentPropsWithoutRef } from "react";

type SurfaceProps = ComponentPropsWithoutRef<"section">;

export function Surface({ className, ...props }: SurfaceProps) {
  const surfaceClassName = className
    ? `surface ${className}`
    : "surface";

  return <section className={surfaceClassName} {...props} />;
}
