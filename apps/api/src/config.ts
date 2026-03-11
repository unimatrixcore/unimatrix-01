export interface ApiRuntimeConfig {
  host: string;
  port: number;
  nodeEnv: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_NODE_ENV = "development";
const DEFAULT_PORT = 3001;

export function loadApiRuntimeConfig(): ApiRuntimeConfig {
  const parsedPort = Number(process.env.PORT);

  return {
    host: process.env.HOST || DEFAULT_HOST,
    port:
      Number.isInteger(parsedPort) && parsedPort > 0
        ? parsedPort
        : DEFAULT_PORT,
    nodeEnv: process.env.NODE_ENV || DEFAULT_NODE_ENV,
  };
}
