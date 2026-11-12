import { Camera } from "lucide-react";
import { cn } from "@unimatrix/ui/public";
import "./capture_empty_state.css";

/** OCR Data's empty capture surface, reused by Gameplay. */
export function CaptureEmptyState({
  id,
  title,
  description,
  className,
}: {
  id?: string;
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div id={id} className={cn("placeholder-box capture-empty-state", className)}>
      <Camera size={48} strokeWidth={1.5} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
