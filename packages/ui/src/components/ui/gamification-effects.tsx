import { useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { ComponentProps, Ref } from "react";
import {
  createGamificationEffects,
  formatGamificationPoints,
  gamificationFeedbackSymbol,
  gamificationFeedbackLabel,
  getGamificationFeedbackColor,
} from "../../lib/gamification-effects.js";
import type {
  GamificationEffects,
  GamificationEffectsOptions,
  GamificationFeedback,
} from "../../lib/gamification-effects.js";
import { cn } from "../../lib/utils.js";
import { ModelIcon } from "./model-icon.js";

export interface ScoreFeedbackProps extends GamificationFeedback {
  className?: string;
  reducedMotion?: boolean;
}

export function ScoreFeedback({
  className,
  reducedMotion = false,
  ...feedback
}: ScoreFeedbackProps) {
  return (
    <span
      role="img"
      className={cn("um-game-feedback", className)}
      data-kind={feedback.kind ?? "score"}
      data-motion={reducedMotion ? "reduced" : "full"}
      style={{ color: getGamificationFeedbackColor(feedback.points, feedback.kind) }}
      aria-label={gamificationFeedbackLabel(feedback)}
    >
      <span className="um-game-feedback-symbol" aria-hidden="true">
        {feedback.kind === "model_accept" ? <ModelIcon /> : gamificationFeedbackSymbol(feedback)}
      </span>
      <span className="um-game-feedback-points" aria-hidden="true">
        {formatGamificationPoints(feedback.points)}
      </span>
    </span>
  );
}

export interface GamificationEffectsLayerProps extends Omit<ComponentProps<"div">, "ref"> {
  ref?: Ref<GamificationEffects>;
  /** Read once on mount; remount the layer to replace controller options. */
  options?: GamificationEffectsOptions;
}

export function GamificationEffectsLayer({
  ref,
  options,
  className,
  ...props
}: GamificationEffectsLayerProps) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<GamificationEffects | null>(null);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    if (!host.current) return;
    const effects = createGamificationEffects(host.current, optionsRef.current);
    controller.current = effects;
    return () => {
      effects.dispose();
      controller.current = null;
    };
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      emit: (feedback) => controller.current?.emit(feedback),
      clear: () => controller.current?.clear(),
      dispose: () => controller.current?.dispose(),
    }),
    [],
  );
  return <div {...props} ref={host} className={cn("um-game-effects-host", className)} />;
}
