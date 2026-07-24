export interface ParsedContentDocument<TFrontmatter> {
  filePath: string;
  slug: string;
  frontmatter: TFrontmatter;
  body: string;
  excerpt: string;
}

export interface HomePageFrontmatter {
  title: string;
  intro: string;
  summary: string;
  mission?: string;
}

export interface ProjectFrontmatter {
  title: string;
  slug: string;
  publishedAt: string;
  summary: string;
  status: string;
  repoUrl?: string;
  liveUrl?: string;
  featured: boolean;
}

export interface BlogFrontmatter {
  title: string;
  slug: string;
  publishedAt: string;
  summary: string;
  description?: string;
}

export type HomePageContent = ParsedContentDocument<HomePageFrontmatter>;
export type ProjectEntry = ParsedContentDocument<ProjectFrontmatter>;
export type BlogEntry = ParsedContentDocument<BlogFrontmatter>;

export interface SiteContent {
  home: HomePageContent;
  projects: ProjectEntry[];
  blog: BlogEntry[];
}
