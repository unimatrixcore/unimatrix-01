export const CONTENT_ROOT_DIRECTORY = "content";

export type ContentCollectionKey = "home" | "projects" | "blog";

export const deferredContentCollections = ["docs", "notes"] as const;

export type DeferredContentCollectionKey =
  (typeof deferredContentCollections)[number];

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
    description: "Singleton homepage and about copy rooted at content/home.",
    directory: "home",
    entryShape: "singleton",
  },
  {
    key: "projects",
    title: "Projects",
    description:
      "Repo-backed project entries rooted at content/projects for the public site baseline.",
    directory: "projects",
    entryShape: "list",
  },
  {
    key: "blog",
    title: "Blog",
    description:
      "Repo-backed blog entries rooted at content/blog for the public site baseline.",
    directory: "blog",
    entryShape: "list",
  },
] satisfies ContentCollectionDefinition[];
