import type { ReactNode } from "react";
import { RiArrowDownSLine } from "@remixicon/react";
import { Card, CardContent, Button } from "@unimatrix/ui/editor";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "@unimatrix/ui/public";
export type TrainingSetupPanelProps = {
  choices: ReactNode;
  controls: ReactNode;
  compute: ReactNode;
  selectedCount: number;
  counts: ReactNode;
};
export function TrainingSetupPanel({
  choices,
  controls,
  compute,
  selectedCount,
  counts,
}: TrainingSetupPanelProps) {
  return (
    <Card className="training-setup-panel" size="sm">
      <CardContent>
        <div className="training-setup-title">
          <span className="training-selection-counts" aria-label="Selected data counts">
            {counts}
          </span>
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
          {compute}
          {controls}
        </div>
      </CardContent>
    </Card>
  );
}
