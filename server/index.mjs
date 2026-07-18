import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { McpSqliteClient } from "./mcpClient.mjs";
import { OpenRouterClient, DEFAULT_MODELS } from "./openrouter.mjs";
import { Agent } from "./agent.mjs";
import { logStore } from "./logs.mjs";
import { buildRouter } from "./routes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "berka.db");
const models = process.env.OPENROUTER_MODELS
  ? process.env.OPENROUTER_MODELS.split(",").map((m) => m.trim()).filter(Boolean)
  : DEFAULT_MODELS;

const mcpClient = new McpSqliteClient({ dbPath: DB_PATH, onLog: (e) => logStore.add(e) });
const openRouterClient = new OpenRouterClient({
  apiKey: process.env.OPENROUTER_API_KEY,
  models,
  onLog: (e) => logStore.add(e),
});
const agent = new Agent({ mcpClient, openRouterClient, onLog: (e) => logStore.add(e) });

const app = express();
app.use(express.json());
app.use("/api", buildRouter({ mcpClient, openRouterClient, agent }));
app.use(express.static(path.join(__dirname, "..", "public")));

try {
  await mcpClient.connect();
  console.log(`MCP SQLite server подключен (${DB_PATH}), инструменты: ${mcpClient.tools.map((t) => t.name).join(", ")}`);
} catch (err) {
  console.error("Не удалось подключиться к MCP-серверу при старте:", err.message ?? err);
  console.error("Сервер продолжит работу, но /api/chat будет возвращать ошибку до восстановления соединения.");
}

if (!openRouterClient.isConfigured()) {
  console.warn("OPENROUTER_API_KEY не задан — добавьте его в .env, иначе чат работать не будет.");
}

app.listen(PORT, () => {
  console.log(`Bank agent запущен: http://localhost:${PORT}`);
});
