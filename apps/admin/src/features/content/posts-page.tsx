import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  RiAddLine,
  RiArticleLine,
  RiCloseLine,
  RiCodeSSlashLine,
  RiDeleteBinLine,
  RiEditLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
} from "@remixicon/react";

import {
  formatPublishedDate,
  type ContentPostSummary,
  type ContentPostType,
} from "@unimatrix/shared";
import {
  ActionTooltip,
  Card,
  CardHeader,
  CardTitle,
  ScrollArea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useIsMobile,
} from "@unimatrix/ui/editor";
import { useMemo, useState } from "react";

import { useApiClient } from "@/lib/api-client";

import { adminPostsQueryOptions } from "./queries";
import { useDeletePosts, useSetPostsState, describeAdminError } from "./mutations";

const COLLECTIONS: readonly { type: ContentPostType; title: string; newLabel: string }[] = [
  { type: "blog", title: "Blog posts", newLabel: "New blog post" },
  { type: "project", title: "Projects", newLabel: "New project" },
];

export function PostsPage() {
  const client = useApiClient();
  const { data, error, isPending } = useQuery(adminPostsQueryOptions(client));
  const posts = useMemo(() => data?.posts ?? [], [data]);
  const [collection, setCollection] = useState<ContentPostType>("blog");
  return (
    <Card
      role="region"
      aria-label="Content"
      size="sm"
      height="fill"
      className="min-w-0 gap-0 rounded-none p-0 shadow-none ring-0"
    >
      <CardHeader className="flex h-11 shrink-0 flex-row items-center px-3 pt-4 pb-1">
        <CardTitle className="text-lg leading-none font-semibold tracking-[-0.03em]">
          <h1>Content</h1>
        </CardTitle>
      </CardHeader>
      <Tabs
        value={collection}
        onValueChange={(value) => {
          setCollection(value as ContentPostType);
        }}
        className="grid min-h-0 flex-1 px-3 pt-3 pb-4 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:grid-rows-[auto_minmax(0,1fr)]"
      >
        <TabsList
          variant="line"
          className="col-start-1 row-start-1 ml-auto w-fit min-w-0 justify-end px-3 lg:col-start-2"
        >
          <TabsTrigger value="blog">
            <RiArticleLine aria-hidden="true" className="size-4" />
            Blog posts
          </TabsTrigger>
          <TabsTrigger value="project">
            <RiCodeSSlashLine aria-hidden="true" className="size-4" />
            Projects
          </TabsTrigger>
        </TabsList>
        {COLLECTIONS.map((item) => (
          <TabsContent
            key={item.type}
            value={item.type}
            hidden={collection !== item.type}
            forceMount
            className="contents data-[state=inactive]:hidden"
          >
            <PostBulkTable
              collection={item}
              error={error}
              isPending={isPending}
              posts={posts.filter((post) => post.type === item.type)}
            />
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  );
}

function StateBadge({ className, post }: { className?: string; post: ContentPostSummary }) {
  return (
    <Badge
      className={className}
      variant={post.publicationState === "published" ? "secondary" : "outline"}
    >
      {post.publicationState}
    </Badge>
  );
}

function RowActions({
  isBusy,
  onDelete,
  post,
}: {
  isBusy: boolean;
  onDelete: () => void;
  post: ContentPostSummary;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-1">
      {post.publicationState === "published" ? (
        <ActionTooltip label="View">
          <Button aria-label={`View ${post.title}`} asChild size="icon-sm" variant="ghost">
            <a
              href={`https://unimatrix-01.dev/${post.type === "blog" ? "blog" : "projects"}/${post.slug}`}
            >
              <RiExternalLinkLine aria-hidden="true" className="size-4" />
            </a>
          </Button>
        </ActionTooltip>
      ) : null}
      <ActionTooltip label="Edit">
        <Button aria-label={`Edit ${post.title}`} asChild size="icon-sm" variant="ghost">
          <Link search={{ id: post.id }} to="/content/posts/edit">
            <RiEditLine aria-hidden="true" className="size-4" />
          </Link>
        </Button>
      </ActionTooltip>

      <ActionTooltip label="Delete">
        <Button
          aria-label={`Delete ${post.title}`}

          className="text-destructive hover:text-destructive"
          disabled={isBusy}
          onClick={onDelete}
          size="icon-sm"
          variant="ghost"
        >
          <RiDeleteBinLine aria-hidden="true" className="size-4" />
        </Button>
      </ActionTooltip>
    </div>
  );
}

function PostBulkTable({
  collection,
  error,
  isPending,
  posts,
}: {
  collection: (typeof COLLECTIONS)[number];
  error: Error | null;
  isPending: boolean;
  posts: readonly ContentPostSummary[];
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const [pendingDelete, setPendingDelete] = useState<readonly ContentPostSummary[] | null>(null);
  const setPostsState = useSetPostsState();
  const deletePosts = useDeletePosts();
  const isMobile = useIsMobile();

  const selected = useMemo(
    () => posts.filter((post) => selectedIds.has(post.id)),
    [posts, selectedIds],
  );

  const allSelected = posts.length > 0 && selected.length === posts.length;
  const isBusy = setPostsState.isPending || deletePosts.isPending;
  const selectionState = allSelected ? true : selected.length > 0 ? "indeterminate" : false;
  const hasSelection = selected.length > 0;
  const targeted = pendingDelete ?? [];

  function toggle(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }

      return next;
    });
  }

  return (
    <section aria-label={collection.title} className="contents">
      <div
        data-content-controls
        className="col-start-1 row-start-2 flex min-h-9 min-w-0 flex-wrap items-center gap-3 px-3 lg:col-start-1 lg:row-start-1"
      >
        <Button asChild className="shrink-0" size="sm" variant="outline">
          <Link search={{ type: collection.type }} to="/content/posts/new">
            <RiAddLine aria-hidden="true" className="size-4" />
            {collection.newLabel}
          </Link>
        </Button>
        {isMobile ? (
          <Checkbox
            aria-label="Select all rows"
            checked={selectionState}
            disabled={isBusy}
            onCheckedChange={(checked) => {
              setSelectedIds(checked === true ? new Set(posts.map((post) => post.id)) : new Set());
            }}
          />
        ) : null}
        {hasSelection ? (
          <div
            role="toolbar"
            aria-label="Selection actions"
            className="flex min-h-8 flex-wrap items-center gap-3 text-sm text-muted-foreground"
          >
            <div className="flex shrink-0 items-center gap-1">
              <ActionTooltip label="Publish selected">
                <Button
                  aria-label="Publish selected"
                  disabled={isBusy || !hasSelection}
                  onClick={() => {
                    setPostsState.mutate({
                      ids: selected.map((post) => post.id),
                      publicationState: "published",
                    });
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <RiEyeLine aria-hidden="true" className="size-4" />
                </Button>
              </ActionTooltip>
              <ActionTooltip label="Unpublish selected">
                <Button
                  aria-label="Unpublish selected"
                  disabled={isBusy || !hasSelection}
                  onClick={() => {
                    setPostsState.mutate({
                      ids: selected.map((post) => post.id),
                      publicationState: "draft",
                    });
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <RiEyeOffLine aria-hidden="true" className="size-4" />
                </Button>
              </ActionTooltip>
              <ActionTooltip label="Delete selected">
                <Button
                  aria-label="Delete selected"
                  className="text-destructive hover:text-destructive"
                  disabled={isBusy || !hasSelection}
                  onClick={() => {
                    setPendingDelete(selected);
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <RiDeleteBinLine aria-hidden="true" className="size-4" />
                </Button>
              </ActionTooltip>
              <ActionTooltip label="Clear selection">
                <Button
                  aria-label="Clear selection"
                  disabled={isBusy || !hasSelection}
                  onClick={() => {
                    setSelectedIds(new Set());
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <RiCloseLine aria-hidden="true" className="size-4" />
                </Button>
              </ActionTooltip>
            </div>
            <span aria-live="polite" className="whitespace-nowrap">
              {selected.length} selected
            </span>
          </div>
        ) : null}
      </div>
      <ScrollArea
        variant="overlay"
        orientation="both"
        className="col-start-1 row-start-3 min-h-0 lg:col-span-2 lg:row-start-2"
        viewportProps={{ "aria-label": "Collection rows", tabIndex: 0 }}
      >
        <div>
          {error !== null ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Posts could not be loaded.</EmptyTitle>
                <EmptyDescription>{describeAdminError(error)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : isPending ? (
            <div className="grid gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : posts.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing here yet.</EmptyTitle>
                <EmptyDescription>Create one to see it listed here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : isMobile ? (
            <ul className="divide-y divide-border px-3">
              {posts.map((post) => (
                <li className="flex items-center gap-3 py-2" key={post.id}>
                  <Checkbox
                    aria-label={`Select ${post.title}`}
                    disabled={isBusy}
                    checked={selectedIds.has(post.id)}
                    onCheckedChange={(checked) => {
                      toggle(post.id, checked === true);
                    }}
                  />

                  <div className="min-w-0 flex-1">
                    <p title={post.title} className="truncate text-sm font-medium text-foreground">
                      {post.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {post.publicationState}
                    </p>
                  </div>
                  <RowActions
                    isBusy={isBusy}
                    onDelete={() => {
                      setPendingDelete([post]);
                    }}
                    post={post}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all rows"
                      disabled={isBusy}
                      checked={selectionState}
                      onCheckedChange={(checked) => {
                        setSelectedIds(
                          checked === true ? new Set(posts.map((post) => post.id)) : new Set(),
                        );
                      }}
                    />
                  </TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="w-24">State</TableHead>
                  <TableHead className="w-28">Published</TableHead>

                  <TableHead className="w-28">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {posts.map((post) => (
                  <TableRow
                    data-state={selectedIds.has(post.id) ? "selected" : undefined}
                    key={post.id}
                  >
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${post.title}`}
                        disabled={isBusy}
                        checked={selectedIds.has(post.id)}
                        onCheckedChange={(checked) => {
                          toggle(post.id, checked === true);
                        }}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <span className="block truncate" title={post.title}>
                        {post.title}
                      </span>
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        title={post.slug}
                      >
                        {post.slug}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StateBadge post={post} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatPublishedDate(post.publishedAt) || "—"}
                    </TableCell>
                    <TableCell>
                      <RowActions
                        isBusy={isBusy}
                        onDelete={() => {
                          setPendingDelete([post]);
                        }}
                        post={post}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </ScrollArea>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
        open={pendingDelete !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {targeted.length} {targeted.length === 1 ? "post" : "posts"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {targeted.length === 1
                ? `"${targeted[0]?.title ?? ""}" will be removed from the site and from the admin list.`
                : "They will be removed from the site and from the admin list."}{" "}
              This cannot be undone from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>

            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const deletedIds = targeted.map((post) => post.id);

                deletePosts.mutate(
                  { ids: deletedIds },
                  {
                    onSuccess: () => {
                      setSelectedIds((current) => {
                        const next = new Set(current);

                        for (const id of deletedIds) {
                          next.delete(id);
                        }

                        return next;
                      });
                    },
                  },
                );
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
