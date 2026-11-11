import { GamificationStatus } from "./gamification-status.js";
import type { GamificationStatusIds, GamificationStatusProps } from "./gamification-status.js";

export type ReviewSessionStatusIds = GamificationStatusIds;
export type ReviewSessionStatusProps = Omit<GamificationStatusProps, "ariaLabel" | "labels">;

export function ReviewSessionStatus(props: ReviewSessionStatusProps) {
  return <GamificationStatus {...props} ariaLabel="Review session" />;
}
