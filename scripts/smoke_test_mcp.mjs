import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpSqliteClient } from "../server/mcpClient.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data", "berka.db");

const client = new McpSqliteClient({
  dbPath,
  onLog: (entry) => console.log("[log]", JSON.stringify(entry).slice(0, 300)),
});

const tools = await client.connect();
console.log(
  "Available MCP tools:",
  tools.map((t) => t.name)
);

const countTool = tools.find((t) => /query|read/i.test(t.name)) ?? tools[0];
console.log("Using tool:", countTool.name);

const result = await client.callTool(countTool.name, {
  query: "SELECT COUNT(*) AS trans_count FROM trans",
});

console.log("Result:", JSON.stringify(result, null, 2));
process.exit(0);
