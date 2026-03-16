declare module "node:assert/strict" {
  const assert: {
    deepEqual(actual: unknown, expected: unknown): void;
    equal(actual: unknown, expected: unknown): void;
    match(actual: string, expected: RegExp): void;
    ok(value: unknown): void;
    throws(
      value: () => unknown,
      expected?: RegExp | { message?: RegExp; name?: string },
    ): void;
  };

  export default assert;
}

declare module "node:fs" {
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): void;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
  export function rmSync(
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ): void;
  export function statSync(path: string): {
    isFile(): boolean;
  };
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export const sep: string;
}

declare module "node:test" {
  export interface TestContext {
    after(callback: () => void): void;
  }

  export function describe(name: string, run: () => void): void;
  export function it(
    name: string,
    run: (context: TestContext) => Promise<void> | void,
  ): void;
}

declare const process: {
  cwd(): string;
};