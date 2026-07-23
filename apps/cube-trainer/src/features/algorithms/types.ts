export type AlgorithmSetId = "oll" | "pll";

export interface AlgorithmCase {
  id: string;
  displayName: string;
  group: string;
  algorithms: string[];
  probabilityWeight: number;
}

export interface AlgorithmSet {
  id: AlgorithmSetId;
  label: string;
  description: string;
  groupOrder: string[];
  cases: AlgorithmCase[];
}
