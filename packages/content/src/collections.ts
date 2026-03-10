export type ContentCollectionKey = "blog" | "projects" | "docs" | "notes";

export interface ContentCollectionDefinition {
  key: ContentCollectionKey;
  title: string;
  description?: string;
}

export const defaultContentCollections = [
  {
    key: "blog",
    title: "Blog",
  },
  {
    key: "projects",
    title: "Projects",
  },
  {
    key: "docs",
    title: "Docs",
  },
  {
    key: "notes",
    title: "Notes",
  },
] satisfies ContentCollectionDefinition[];
