import { RiImageAddLine, RiLoader4Line } from "@remixicon/react";
import { useAuth } from "@unimatrix/auth/react";
import type {
  ContentPost,
  ContentPostType,
  ContentPublicationState,
  CreatePostBody,
  UpdatePostBody,
} from "@unimatrix/shared";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  ScrollArea,
  ActionTooltip,
  Button,
  Checkbox,
  Input,
  Label,
  MarkdownEditor,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  toast,
  type MarkdownEditorHandle,
} from "@unimatrix/ui/editor";
import { useId, useRef, useState } from "react";

import { ASSET_ACCEPT, assetUrl, uploadAsset } from "./asset-upload";
import { useCreatePost, useUpdatePost } from "./mutations";
import { slugifyTitle } from "./slugify";

const PUBLICATION_STATES: readonly ContentPublicationState[] = ["draft", "published", "archived"];

const STATE_LABELS: Record<ContentPublicationState, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

/**
 * The form's own state, which is all strings and booleans.
 *
 * Deliberately not `CreatePostBody`: a text input's empty value is `""`, and
 * the contract wants `null` for a cleared optional and a real URL or nothing
 * for `repoUrl`. Keeping the two shapes apart means the conversion happens
 * once, in {@link toCreateBody}/{@link toUpdateBody}, rather than at every
 * `onChange`.
 */
interface PostFormState {
  slug: string;
  title: string;
  summary: string;
  description: string;
  body: string;
  publicationState: ContentPublicationState;
  featured: boolean;
  repoUrl: string;
  liveUrl: string;
}

const EMPTY_FORM: PostFormState = {
  slug: "",
  title: "",
  summary: "",
  description: "",
  body: "",
  publicationState: "draft",
  featured: false,
  repoUrl: "",
  liveUrl: "",
};

function toFormState(post: ContentPost): PostFormState {
  return {
    slug: post.slug,
    title: post.title,
    summary: post.summary,
    description: post.description ?? "",
    body: post.body,
    publicationState: post.publicationState,
    featured: post.featured,
    repoUrl: post.repoUrl ?? "",
    liveUrl: post.liveUrl ?? "",
  };
}

/** `""` means "no value" in a text input; the contract spells that `null`. */
function orNull(value: string): string | null {
  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
}

function toCreateBody(form: PostFormState, type: ContentPostType): CreatePostBody {
  return {
    type,
    slug: form.slug.trim(),
    title: form.title.trim(),
    summary: form.summary.trim(),
    description: orNull(form.description),
    body: form.body,
    publicationState: form.publicationState,
    featured: type === "project" && form.featured,
    repoUrl: type === "project" ? orNull(form.repoUrl) : null,
    liveUrl: type === "project" ? orNull(form.liveUrl) : null,
  };
}

/**
 * Built field by field rather than spread from {@link toCreateBody}: the
 * update schema is a `strictObject` without `type`, so an inherited `type`
 * key — even one set to `undefined` — is an unknown key and a 400.
 */
function toUpdateBody(form: PostFormState, post: ContentPost): UpdatePostBody {
  const isProject = post.type === "project";

  return {
    id: post.id,
    slug: form.slug.trim(),
    title: form.title.trim(),
    summary: form.summary.trim(),
    description: orNull(form.description),
    body: form.body,
    publicationState: form.publicationState,
    featured: isProject && form.featured,
    repoUrl: isProject ? orNull(form.repoUrl) : null,
    liveUrl: isProject ? orNull(form.liveUrl) : null,
  };
}

export interface PostFormProps {
  /** The API origin, supplied by the route from the router context. */
  baseUrl: string;
  /** The post being edited, or `null` to create a new one. */
  post: ContentPost | null;
  /** Collection the created post belongs to. Ignored when editing. */
  type: ContentPostType;
  /** Heading for the panel this form renders as. */
  title: string;
  /** Leave the form — called after a successful save and on cancel. */
  onDone: () => void;
}

/**
 * Create/edit form for one post, with the markdown body edited in place.
 *
 * A page rather than a dialog: writing a post is the longest-running thing an
 * admin does here, and a modal caps the editor at a fraction of the viewport
 * while trapping focus. The form is height-agnostic — it fills whatever column
 * it is given and hands the leftover space to the editor — so the route decides
 * how tall it is.
 *
 * Slug is editable while creating and while editing: changing it is a real
 * thing an admin needs to do, and the API enforces `(type, slug)` uniqueness,
 * so a collision comes back as a 400 with a message rather than being
 * prevented by a guess here.
 *
 * Details and the document scroll independently; the submit controls stay above both panes.
 */
export function PostForm({ baseUrl, post, type, title, onDone }: PostFormProps) {
  const effectiveType = post?.type ?? type;
  const [form, setForm] = useState<PostFormState>(() =>
    post === null ? EMPTY_FORM : toFormState(post),
  );
  /**
   * Whether the slug has been typed rather than derived, which stops the title
   * from overwriting it.
   *
   * Starts `true` when editing: an existing post's slug is its published URL,
   * and having a title edit silently rewrite it would break every link to the
   * post. Clearing the field puts it back under the title's control, which is
   * the only way to get the derived value back after typing one by hand.
   */
  const [isSlugEdited, setIsSlugEdited] = useState(post !== null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const { getToken } = useAuth();
  const createPost = useCreatePost();
  const updatePost = useUpdatePost();
  const fieldPrefix = useId();
  const isSaving = createPost.isPending || updatePost.isPending;

  function update<TKey extends keyof PostFormState>(key: TKey, value: PostFormState[TKey]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleUpload(file: File) {
    setIsUploading(true);

    try {
      const asset = await uploadAsset(file, await getToken(), baseUrl);

      editorRef.current?.insertAtCursor(`![${file.name}](${assetUrl(asset.hash, baseUrl)})`);
      toast.success(`${file.name} uploaded.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      if (post === null) {
        await createPost.mutateAsync(toCreateBody(form, effectiveType));
      } else {
        await updatePost.mutateAsync(toUpdateBody(form, post));
      }

      onDone();
    } catch {
      // The mutation's `onError` already raised a toast naming the failure,
      // and the form stays put so the admin keeps what they typed.
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-4"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <Card size="sm" className="shrink-0 gap-0 rounded-none p-0 shadow-none ring-0">
        <CardHeader
          data-editor-header
          className="flex h-14 shrink-0 flex-row items-center justify-between gap-2 px-3 py-4"
        >
          <CardTitle className="min-w-0 text-lg leading-none font-semibold tracking-[-0.03em]">
            <h1 className="truncate" title={title}>
              {title}
            </h1>
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            {" "}
            <Button disabled={isSaving} onClick={onDone} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={isSaving} type="submit">
              {isSaving ? "Saving" : post === null ? "Create" : "Save"}
            </Button>
          </div>
        </CardHeader>
      </Card>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(140px,25%)_minmax(0,1fr)] gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:grid-rows-1">
        <Card
          role="region"
          aria-labelledby={`${fieldPrefix}-details`}
          size="sm"
          height="fill"
          className="gap-0 rounded-none py-0 shadow-none ring-0"
        >
          <CardHeader className="flex min-h-14 shrink-0 items-center border-b border-border/60 px-4 py-3">
            <CardTitle className="text-sm font-bold uppercase">
              <h2 id={`${fieldPrefix}-details`}>Post details</h2>
            </CardTitle>
          </CardHeader>
          <ScrollArea
            variant="overlay"
            orientation="both"
            className="min-h-0 flex-1"
            viewportProps={{ "aria-label": "Post details", tabIndex: 0 }}
          >
            <div className="p-4">
              <div className="grid gap-2">
                {" "}
                <Label htmlFor={`${fieldPrefix}-state`}>Publication state</Label>
                <Select
                  onValueChange={(next) => {
                    update("publicationState", next as ContentPublicationState);
                  }}
                  value={form.publicationState}
                >
                  <SelectTrigger className="w-full" id={`${fieldPrefix}-state`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PUBLICATION_STATES.map((state) => (
                      <SelectItem key={state} value={state}>
                        {STATE_LABELS[state]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="mt-4 grid gap-4">
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor={`${fieldPrefix}-title`}>Title</Label>
                    <Input
                      id={`${fieldPrefix}-title`}
                      maxLength={200}
                      onChange={(event) => {
                        const title = event.target.value;

                        setForm((current) => ({
                          ...current,
                          title,
                          slug: isSlugEdited ? current.slug : slugifyTitle(title),
                        }));
                      }}
                      required
                      value={form.title}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor={`${fieldPrefix}-slug`}>Slug</Label>
                    {/* HTML patterns use the v flag, which requires this escaped hyphen. */}
                    <Input
                      id={`${fieldPrefix}-slug`}
                      onChange={(event) => {
                        const slug = event.target.value;

                        setIsSlugEdited(slug.length > 0);
                        update("slug", slug);
                      }}
                      pattern="[a-z0-9][a-z0-9\-]*"
                      required
                      title="Lowercase letters, numbers and hyphens, not starting with a hyphen."
                      value={form.slug}
                    />
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor={`${fieldPrefix}-summary`}>Summary</Label>
                  <Input
                    id={`${fieldPrefix}-summary`}
                    maxLength={500}
                    onChange={(event) => {
                      update("summary", event.target.value);
                    }}
                    required
                    value={form.summary}
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor={`${fieldPrefix}-description`}>
                    Description <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id={`${fieldPrefix}-description`}
                    maxLength={1000}
                    onChange={(event) => {
                      update("description", event.target.value);
                    }}
                    value={form.description}
                  />
                </div>

                {effectiveType === "project" ? (
                  <>
                    <Separator />

                    <div className="grid gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor={`${fieldPrefix}-repo`}>Repository URL</Label>
                        <Input
                          id={`${fieldPrefix}-repo`}
                          onChange={(event) => {
                            update("repoUrl", event.target.value);
                          }}
                          type="url"
                          value={form.repoUrl}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor={`${fieldPrefix}-live`}>Live URL</Label>
                        <Input
                          id={`${fieldPrefix}-live`}
                          onChange={(event) => {
                            update("liveUrl", event.target.value);
                          }}
                          type="url"
                          value={form.liveUrl}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={form.featured}
                        id={`${fieldPrefix}-featured`}
                        onCheckedChange={(checked) => {
                          update("featured", checked === true);
                        }}
                      />
                      <Label htmlFor={`${fieldPrefix}-featured`}>Feature on the homepage</Label>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </ScrollArea>
        </Card>
        <Card
          role="region"
          aria-label="Markdown body"
          size="sm"
          height="fill"
          className="min-w-0 gap-0 rounded-none py-0 shadow-none ring-0"
        >
          <CardContent className="flex min-h-0 flex-1 flex-col px-0">
            <ScrollArea
              variant="overlay"
              orientation="both"
              className="min-h-0 flex-1"
              viewportProps={{ "aria-label": "Expanded document", className: "[&>div]:h-full" }}
            >
              <MarkdownEditor
                className="h-full min-h-0 flex-1"

                actions={
                  <>
                    <ActionTooltip label={isUploading ? "Uploading image" : "Insert image"}>
                      <Button
                        aria-label={isUploading ? "Uploading image" : "Insert image"}
                        className="size-8"
                        disabled={isUploading}
                        onClick={() => {
                          fileInputRef.current?.click();
                        }}
                        size="icon"
                        title={isUploading ? "Uploading image" : "Insert image"}
                        type="button"
                        variant="ghost"
                      >
                        {isUploading ? (
                          <RiLoader4Line aria-hidden="true" className="size-4 animate-spin" />
                        ) : (
                          <RiImageAddLine aria-hidden="true" className="size-4" />
                        )}
                      </Button>
                    </ActionTooltip>
                    <input
                      accept={ASSET_ACCEPT}
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];

                        event.target.value = "";

                        if (file !== undefined) {
                          void handleUpload(file);
                        }
                      }}
                      ref={fileInputRef}
                      type="file"
                    />
                  </>
                }
                header={
                  <CardTitle className="text-sm font-bold uppercase">
                    <h2>Body</h2>
                  </CardTitle>
                }
                label="Post body"
                onChange={(next) => {
                  update("body", next);
                }}
                placeholder="Write the post in markdown."
                ref={editorRef}
                value={form.body}
              />
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </form>
  );
}
