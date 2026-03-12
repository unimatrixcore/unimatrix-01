import { createSqliteClient } from "./client.js";

const client = createSqliteClient({
  filePath: ":memory:",
});

try {
  const row = client.prepare("select 1 as value").get() as { value: number };

  if (row.value !== 1) {
    throw new Error("sqlite smoke test did not return the expected value");
  }

  console.log("@unimatrix/db smoke test passed");
} finally {
  client.close();
}