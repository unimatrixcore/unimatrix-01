import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

export type ServiceTokenCapability = "read" | "manage";

const capabilitySchema = z.enum(["read", "manage"]);
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const issueSchema = z.object({ name: nameSchema, capability: capabilitySchema }).strict();
const summarySchema = z.object({
  id: z.string(),
  name: nameSchema,
  capability: capabilitySchema,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export interface ServiceTokenSummary {
  id: string;
  name: string;
  capability: ServiceTokenCapability;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IssueServiceTokenOptions {
  name: string;
  capability: ServiceTokenCapability;
}

export interface IssuedServiceToken {
  token: string;
  record: ServiceTokenSummary;
}

export interface ServiceTokenStore {
  issue(options: IssueServiceTokenOptions): IssuedServiceToken;
  list(): ServiceTokenSummary[];
  revoke(name: string): ServiceTokenSummary | null;
  authenticate(presented: string): ServiceTokenSummary | null;
  close(): void;
}

const SUMMARY_COLUMNS = `id, name, capability, created_at AS createdAt,
  last_used_at AS lastUsedAt, revoked_at AS revokedAt`;
const TOKEN_PATTERN = /^udt_[A-Za-z0-9_-]{43}$/u;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function openServiceTokenStore(path: string): ServiceTokenStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS deploy_service_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      capability TEXT NOT NULL CHECK (capability IN ('read', 'manage')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS deploy_service_tokens_live_name
      ON deploy_service_tokens(name) WHERE revoked_at IS NULL`);
    const insert = db.prepare(`INSERT INTO deploy_service_tokens
      (id, name, token_hash, capability) VALUES (?, ?, ?, ?) RETURNING ${SUMMARY_COLUMNS}`);
    const list = db.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM deploy_service_tokens ORDER BY name, created_at, id`,
    );
    const revoke = db.prepare(`UPDATE deploy_service_tokens SET revoked_at = CURRENT_TIMESTAMP
      WHERE name = ? AND revoked_at IS NULL RETURNING ${SUMMARY_COLUMNS}`);
    const authenticate =
      db.prepare(`UPDATE deploy_service_tokens SET last_used_at = CURRENT_TIMESTAMP
      WHERE token_hash = ? AND revoked_at IS NULL RETURNING ${SUMMARY_COLUMNS}`);
    const issue = db.transaction((options: IssueServiceTokenOptions): IssuedServiceToken => {
      if (
        db
          .prepare("SELECT id FROM deploy_service_tokens WHERE name = ? AND revoked_at IS NULL")
          .get(options.name)
      ) {
        throw new Error("An active deploy service token already uses that name.");
      }
      const token = `udt_${randomBytes(32).toString("base64url")}`;
      const record = summarySchema.parse(
        insert.get(randomUUID(), options.name, hashToken(token), options.capability),
      );
      return { token, record };
    });
    return {
      issue(options) {
        const parsed = issueSchema.safeParse(options);
        if (!parsed.success)
          throw new Error(
            "A valid caller name and explicit read or manage capability are required.",
          );
        return issue(parsed.data);
      },
      list() {
        return list.all().map((row) => summarySchema.parse(row));
      },
      revoke(name) {
        if (!nameSchema.safeParse(name).success)
          throw new Error("A valid caller name is required.");
        const row = revoke.get(name);
        return row === undefined ? null : summarySchema.parse(row);
      },
      authenticate(presented) {
        if (!TOKEN_PATTERN.test(presented)) return null;
        const row = authenticate.get(hashToken(presented));
        return row === undefined ? null : summarySchema.parse(row);
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
