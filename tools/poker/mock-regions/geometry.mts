export type Point = { x: number; y: number };
export type Bounds = { x: number; y: number; width: number; height: number };

export function boundsOf(points: Point[]): Bounds {
  if (points.length < 3 || points.some((p) => !Number.isFinite(p.x + p.y))) {
    throw new Error("A crop needs a finite polygon");
  }
  const x = Math.min(...points.map((p) => p.x));
  const y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) - x,
    height: Math.max(...points.map((p) => p.y)) - y,
  };
}

export function loopbackUrl(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Mock URL must be an unauthenticated HTTP loopback URL");
  }
  return url.href;
}
