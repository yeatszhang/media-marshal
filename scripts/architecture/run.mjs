import { resolve } from "node:path";
import { run } from "./check.mjs";
import { verifyCatalog } from "./catalog.mjs";

const root = resolve(import.meta.dirname, "../..");
try {
  const result = await run(root, process.argv[2] ?? "all");
  const tables = await verifyCatalog(root);
  console.log(JSON.stringify({ ...result, registeredTables: tables }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
