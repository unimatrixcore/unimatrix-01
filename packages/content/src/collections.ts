export const CONTENT_ROOT_DIRECTORY = "content";

export type ContentCollectionKey = "home" | "projects" | "blog";

export const deferredContentCollections = ["docs", "notes"] as const;

export type DeferredContentCollectionKey = (typeof deferredContentCollections)[number];

export interface ContentCollectionDefinition {
  key: ContentCollectionKey;
  title: string;
  description: string;
  directory: string;
  entryShape: "singleton" | "list";
}

export const contentCollections = [
  {
    key: "home",
    title: "Home / About",
    description: "Singleton homepage and about copy.",
    directory: "home",
    entryShape: "singleton",
  },
  {
    key: "projects",
    title: "Projects",
    description: "Authored project entries.",
    directory: "projects",
    entryShape: "list",
  },
  {
    key: "blog",
    title: "Blog",
    description: "Authored blog entries.",
    directory: "blog",
    entryShape: "list",
  },
] satisfies ContentCollectionDefinition[];
