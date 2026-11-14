import type { ReactNode } from "react";
import { RiArrowDownSLine } from "@remixicon/react";
import { Card, CardContent, Button } from "@unimatrix/ui/editor";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "@unimatrix/ui/public";
export function TrainingSetupPanel({
  choices,
  controls,
  blockedReason,
  readiness,
  compute,
  selectedCount,
  counts,
}: {
  choices: ReactNode;
  controls: ReactNode;
  blockedReason: string;
  readiness: ReactNode;
  compute: ReactNode;
  selectedCount: number;
  counts: ReactNode;
}) {
  return (
    <Card className="training-setup-panel" size="sm">
      <CardContent>
        <div className="training-setup-top">
          <div className="training-setup-title">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  Collections · {selectedCount}
                  <RiArrowDownSLine aria-hidden="true" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="training-collection-popover">
                {choices}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="training-setup-actions">
            {readiness}
            {blockedReason && <span className="training-start-reason">{blockedReason}</span>}
            {controls}
          </div>
        </div>
        <div className="training-setup-bottom">
          <span className="training-selection-counts" aria-label="Selected data counts">
            {counts}
          </span>
          {compute}
        </div>
      </CardContent>
    </Card>
  );
}
