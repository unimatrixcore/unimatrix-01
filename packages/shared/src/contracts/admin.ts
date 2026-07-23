import {
  listUsersQuerySchema,
  listUsersResponseSchema,
  updateUserPermissionsBodySchema,
  updateUserPermissionsResponseSchema,
} from "../schemas/admin.js";
import { defineApiContract } from "./api-contract.js";

export const listUsersContract = defineApiContract({
  method: "GET",
  path: "/admin/users",
  querySchema: listUsersQuerySchema,
  responseSchema: listUsersResponseSchema,
});

export type ListUsersContract = typeof listUsersContract;

export const updateUserPermissionsContract = defineApiContract({
  method: "PATCH",
  path: "/admin/users",
  bodySchema: updateUserPermissionsBodySchema,
  responseSchema: updateUserPermissionsResponseSchema,
});

export type UpdateUserPermissionsContract = typeof updateUserPermissionsContract;
