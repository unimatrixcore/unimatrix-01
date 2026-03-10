export interface ContentCollection {
  slug: string;
  title: string;
  description?: string;
}

export const defaultCollections = [
  {
    slug: "blog",
    title: "Blog",
  },
  {
    slug: "projects",
    title: "Projects",
  },
  {
    slug: "notes",
    title: "Notes",
  },
] satisfies ContentCollection[];
