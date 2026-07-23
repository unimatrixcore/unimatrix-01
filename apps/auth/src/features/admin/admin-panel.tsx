import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RiSearchLine } from "@remixicon/react";

import { ApiClientError } from "@unimatrix/api-client";
import type { PermissionsMap, UserSummary } from "@unimatrix/shared";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@unimatrix/ui";

import { useApiClient } from "@/lib/api-client";
import {
  APP_SLUGS,
  ROLES,
  hasMatrixPermission,
  toggleMatrixPermission,
  type AppSlug,
  type Role,
} from "./permissions-matrix.js";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;
const USERS_QUERY_KEY = "admin-users";

function userDisplayName(user: UserSummary): string {
  const nameParts = [user.firstName, user.lastName].filter(
    (part): part is string => Boolean(part),
  );

  if (nameParts.length > 0) {
    return nameParts.join(" ");
  }

  return user.username ?? user.primaryEmailAddress ?? user.id;
}

export function AdminPanel() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setQuery(searchInput.trim());
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [searchInput]);

  const usersQuery = useQuery({
    queryFn: () =>
      apiClient.listUsers({
        limit: PAGE_SIZE,
        offset,
        ...(query.length > 0 ? { query } : {}),
      }),
    queryKey: [USERS_QUERY_KEY, query, offset],
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: (input: { userId: string; permissions: PermissionsMap }) =>
      apiClient.updateUserPermissions(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [USERS_QUERY_KEY] });
    },
  });

  const handleToggle = (user: UserSummary, appSlug: AppSlug, role: Role) => {
    updatePermissionsMutation.mutate({
      permissions: toggleMatrixPermission(user.permissions, appSlug, role),
      userId: user.id,
    });
  };

  const totalCount = usersQuery.data?.totalCount ?? 0;
  const hasNextPage = offset + PAGE_SIZE < totalCount;
  const hasPreviousPage = offset > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
          Admin
        </h1>
        <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
          Search users and manage per-app permissions. Changes take effect
          immediately.
        </p>
      </div>

      <div className="relative max-w-sm">
        <RiSearchLine
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          className="pl-8"
          onChange={(event) => {
            setSearchInput(event.target.value);
          }}
          placeholder="Search users by name, email, or username"
          value={searchInput}
        />
      </div>

      {updatePermissionsMutation.isError ? (
        <MutationErrorBanner error={updatePermissionsMutation.error} />
      ) : null}

      {usersQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading users…</p>
      ) : usersQuery.isError ? (
        <QueryErrorBanner error={usersQuery.error} />
      ) : (
        <Card className="site-panel overflow-hidden px-0 py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                {APP_SLUGS.map((appSlug) => (
                  <TableHead key={appSlug}>{appSlug}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {usersQuery.data.users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={APP_SLUGS.length + 1} className="text-center text-muted-foreground">
                    No users found.
                  </TableCell>
                </TableRow>
              ) : (
                usersQuery.data.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="font-medium text-foreground">{userDisplayName(user)}</span>
                        {user.primaryEmailAddress ? (
                          <span className="text-xs text-muted-foreground">{user.primaryEmailAddress}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    {APP_SLUGS.map((appSlug) => (
                      <TableCell key={appSlug}>
                        <div className="flex flex-col gap-1.5">
                          {ROLES.map((role) => (
                            <label
                              className="flex items-center gap-1.5 text-xs text-muted-foreground"
                              key={role}
                            >
                              <Checkbox
                                checked={hasMatrixPermission(user.permissions, appSlug, role)}
                                disabled={updatePermissionsMutation.isPending}
                                onCheckedChange={() => {
                                  handleToggle(user, appSlug, role);
                                }}
                              />
                              {role}
                            </label>
                          ))}
                        </div>
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <Badge variant="secondary">
          {totalCount} user{totalCount === 1 ? "" : "s"}
        </Badge>
        <div className="flex gap-2">
          <Button
            disabled={!hasPreviousPage}
            onClick={() => {
              setOffset((current) => Math.max(0, current - PAGE_SIZE));
            }}
            size="sm"
            variant="outline"
          >
            Previous
          </Button>
          <Button
            disabled={!hasNextPage}
            onClick={() => {
              setOffset((current) => current + PAGE_SIZE);
            }}
            size="sm"
            variant="outline"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function QueryErrorBanner({ error }: { error: unknown }) {
  if (error instanceof ApiClientError && error.status === 403) {
    return (
      <Card className="site-panel border-destructive/40 px-5 py-4">
        <p className="text-sm text-destructive">
          You do not have permission to view this data.
        </p>
      </Card>
    );
  }

  return (
    <Card className="site-panel border-destructive/40 px-5 py-4">
      <p className="text-sm text-destructive">
        Something went wrong loading users. Try again shortly.
      </p>
    </Card>
  );
}

function MutationErrorBanner({ error }: { error: unknown }) {
  if (error instanceof ApiClientError && error.status === 403) {
    return (
      <Card className="site-panel border-destructive/40 px-5 py-4">
        <p className="text-sm text-destructive">
          You do not have permission to change that user&apos;s permissions.
        </p>
      </Card>
    );
  }

  return (
    <Card className="site-panel border-destructive/40 px-5 py-4">
      <p className="text-sm text-destructive">
        Something went wrong updating permissions. Try again shortly.
      </p>
    </Card>
  );
}
