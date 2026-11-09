import { GamificationStatus } from "./gamification-status.js";

export interface ReviewSessionStatusIds {
  score?: string;
  timer?: string;
  streak?: string;
}

export interface ReviewSessionStatusProps {
  points: number;
  streak: number;
  elapsedMs: number;
  clockState: "reading" | "editing" | "paused" | "loading";
  ids?: ReviewSessionStatusIds;
  className?: string;
}

export function ReviewSessionStatus(props: ReviewSessionStatusProps) {
  return <GamificationStatus {...props} ariaLabel="Review session" />;
}
