import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

import { CanvasConnectionError } from "./errors.js";
import {
  abortable,
  checkSignal,
  createCanvasRequester,
  readJson,
  type CanvasBudget,
} from "./request.js";

export { CanvasConnectionError } from "./errors.js";
export type { CanvasConnectionErrorCode } from "./errors.js";
export interface CanvasConnectionStatus {
  connection: "connected";
}

export interface CanvasConnectionOptions {
  userId: string;
  loadCredential: (signal?: AbortSignal) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  onCredentialChange?: () => void;
  deadlineMs?: number;
}

export interface CanvasConnection {
  withSession<T>(
    operation: (session: CanvasSession) => Promise<T>,
    options?: CanvasOperationOptions,
  ): Promise<T>;
  status(signal?: AbortSignal): Promise<CanvasConnectionStatus>;
  withVerifiedCredential<T>(
    operation: (token: string, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

const accountSchema = z.object({ id: z.string().regex(/^[1-9]\d*$/u) });
const ACCOUNT_URL = "https://learn.maricopa.edu/api/v1/users/self";

export interface CanvasSession {
  generation: string;
  budget: CanvasBudget;
  request(url: URL): Promise<Response>;
}
export interface CanvasOperationOptions {
  signal?: AbortSignal;
  maxRequests?: number;
}

export function createCanvasConnection(options: CanvasConnectionOptions): CanvasConnection {
  if (!/^[1-9]\d*$/u.test(options.userId)) {
    throw new Error("Invalid configured Canvas user ID.");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (
    options.deadlineMs !== undefined &&
    (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 10_000)
  )
    throw new Error("Invalid Canvas deadline.");
  const request = createCanvasRequester(fetchImpl);
  const generationKey = randomBytes(32);
  let generation: string | undefined;
  let generationId = "";
  let pending: Promise<void> = Promise.resolve();
  let admitted = 0;

  async function run<T>(
    operation: (token: string, session: CanvasSession) => Promise<T>,
    operationOptions: CanvasOperationOptions = {},
  ): Promise<T> {
    const { signal: callerSignal, maxRequests = 20 } = operationOptions;
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100)
      throw new Error("Invalid Canvas request budget.");
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(options.deadlineMs ?? 10_000)])
      : AbortSignal.timeout(options.deadlineMs ?? 10_000);
    if (admitted >= 64) throw new CanvasConnectionError("CANVAS_BUDGET_EXHAUSTED");
    admitted++;
    const previous = pending;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending = previous
      .then(() => gate)
      .then(() => {
        admitted--;
      });
    try {
      await abortable(previous, signal);
      checkSignal(signal);
      let token: string;
      try {
        token = await abortable(
          Promise.resolve().then(() => options.loadCredential(signal)),
          signal,
        );
      } catch (error) {
        checkSignal(signal);
        if (error instanceof CanvasConnectionError) throw error;
        throw new CanvasConnectionError("CREDENTIAL_UNAVAILABLE");
      }
      checkSignal(signal);
      if (!/^[\x21-\x7e]+$/u.test(token)) throw new CanvasConnectionError("CREDENTIAL_DENIED");
      const current = createHmac("sha256", generationKey).update(token).digest("hex");
      if (current !== generation) {
        options.onCredentialChange?.();
        generation = current;
        generationId = randomBytes(24).toString("base64url");
      }
      const budget: CanvasBudget = { signal, remaining: maxRequests };
      const session: CanvasSession = {
        generation: generationId,
        budget,
        request: (url) => request(url, token, budget),
      };
      let response: Response;
      try {
        response = await session.request(new URL(ACCOUNT_URL));
      } catch (error) {
        if (error instanceof CanvasConnectionError && error.code === "CANVAS_RESOURCE_UNAVAILABLE")
          throw new CanvasConnectionError("CANVAS_CREDENTIAL_REJECTED");
        throw error;
      }
      const parsed = accountSchema.safeParse(await readJson(response, budget, 65_536));
      if (!parsed.success) throw new CanvasConnectionError("CANVAS_INVALID_RESPONSE");
      if (parsed.data.id !== options.userId)
        throw new CanvasConnectionError("CANVAS_ACCOUNT_MISMATCH");
      checkSignal(signal);
      const result = await abortable(operation(token, session), signal);
      checkSignal(signal);
      return result;
    } catch (error) {
      checkSignal(signal);
      if (error instanceof CanvasConnectionError) throw error;
      throw new CanvasConnectionError("CANVAS_REQUEST_FAILED");
    } finally {
      release();
    }
  }

  const withVerifiedCredential: CanvasConnection["withVerifiedCredential"] = (operation, signal) =>
    run(
      (token, session) => operation(token, session.budget.signal),
      signal === undefined ? {} : { signal },
    );
  return {
    withSession: (operation, settings) => run((_token, session) => operation(session), settings),
    withVerifiedCredential,
    status: (signal) =>
      withVerifiedCredential(() => Promise.resolve({ connection: "connected" }), signal),
  };
}

export { createCanvasTransport } from "./transport.js";
export type { CanvasRead } from "./endpoints.js";
export type {
  CanvasReadOptions,
  CanvasSourceResult,
  CanvasTransport,
  CanvasResult,
} from "./transport.js";

export { createCanvasCourseWorkflows } from "./courses.js";
export type {
  CanvasCourse,
  CanvasCourseSource,
  CanvasCourseListResult,
  CanvasCourseResult,
  CanvasCourseContext,
  CanvasCourseListInput,
  CanvasCourseInput,
  CanvasCourseOptions,
  CanvasCourseWorkflows,
} from "./courses.js";

export { createCanvasAssignmentWorkflows } from "./assignments.js";
export type {
  CanvasAssignmentInput,
  CanvasAssignmentListInput,
  CanvasGradesInput,
  CanvasAssignment,
  CanvasAssignmentListResult,
  CanvasAssignmentResult,
  CanvasSubmissionResult,
  CanvasGradesResult,
  CanvasAssignmentWorkflows,
} from "./assignments.js";

export { createCanvasAgendaWorkflows } from "./agenda.js";
export type {
  CanvasAgendaInput,
  CanvasAgendaResult,
  CanvasAgendaWorkflows,
  CanvasAgendaItem,
  CanvasAgendaEvidence,
} from "./agenda.js";

export { createCanvasReadingWorkflows } from "./reading.js";
export type {
  CanvasReadingListInput,
  CanvasSyllabusInput,
  CanvasPageInput,
  CanvasModuleItemsInput,
  CanvasFileInput,
  CanvasAnnouncementsInput,
  CanvasReadingPage,
  CanvasReadingModule,
  CanvasReadingModuleItem,
  CanvasReadingFile,
  CanvasReadingWorkflows,
} from "./reading.js";
