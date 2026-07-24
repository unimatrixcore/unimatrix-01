import { RiFilterLine } from "@remixicon/react";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unimatrix/ui/public";

export type CaseFilterMode = "all" | "onlyLearned";

export interface CaseCategoryFilterProps {
  groups: string[];
  mode: CaseFilterMode;
  onModeChange: (mode: CaseFilterMode) => void;
  onSelectedGroupsChange: (groups: string[]) => void;
  selectedGroups: string[];
}

export function CaseCategoryFilter({
  groups,
  mode,
  onModeChange,
  onSelectedGroupsChange,
  selectedGroups,
}: CaseCategoryFilterProps) {
  function toggleGroup(group: string, checked: boolean) {
    onSelectedGroupsChange(
      checked ? [...selectedGroups, group] : selectedGroups.filter((entry) => entry !== group),
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="gap-1.5" variant="outline">
          <RiFilterLine aria-hidden="true" className="size-3.5" />
          Filter
          {selectedGroups.length > 0 ? ` (${selectedGroups.length})` : ""}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            onModeChange(value as CaseFilterMode);
          }}
          value={mode}
        >
          <DropdownMenuRadioItem value="all">All cases</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="onlyLearned">Only learned cases</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Categories</DropdownMenuLabel>
        {groups.map((group) => (
          <DropdownMenuCheckboxItem
            checked={selectedGroups.includes(group)}
            key={group}
            onCheckedChange={(checked) => {
              toggleGroup(group, checked === true);
            }}
            onSelect={(event) => {
              event.preventDefault();
            }}
          >
            {group}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
