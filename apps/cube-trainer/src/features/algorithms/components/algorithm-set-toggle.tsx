import { RiShapeLine, RiShapesLine } from "@remixicon/react";
import { ToggleGroup, ToggleGroupItem } from "@unimatrix/ui/public";

import type { AlgorithmSetId } from "@/features/algorithms/types";

const SET_OPTIONS: { icon: typeof RiShapeLine; id: AlgorithmSetId; label: string }[] = [
  { icon: RiShapeLine, id: "oll", label: "OLL" },
  { icon: RiShapesLine, id: "pll", label: "PLL" },
];

export interface AlgorithmSetToggleProps {
  onChange: (setId: AlgorithmSetId) => void;
  setId: AlgorithmSetId;
}

export function AlgorithmSetToggle({ onChange, setId }: AlgorithmSetToggleProps) {
  return (
    <ToggleGroup
      onValueChange={(value) => {
        if (value) onChange(value as AlgorithmSetId);
      }}
      type="single"
      value={setId}
      variant="outline"
    >
      {SET_OPTIONS.map(({ icon: Icon, id, label }) => (
        <ToggleGroupItem aria-label={label} key={id} value={id}>
          <Icon aria-hidden="true" className="size-3.5" />
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
