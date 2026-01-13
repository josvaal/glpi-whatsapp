import { run } from "./app";

run().catch((err) => {
  const messageText = err instanceof Error ? err.message : String(err);
  console.error(`Error fatal: ${messageText}`);
  process.exit(1);
});
