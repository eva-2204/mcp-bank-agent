import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Wraps the official MCP SQLite server (spawned via `uvx mcp-server-sqlite`).
// All database access in this app goes exclusively through this client — no
// direct sqlite driver is used anywhere else.
export class McpSqliteClient {
  constructor({ dbPath, onLog }) {
    this.dbPath = dbPath;
    this.onLog = onLog ?? (() => {});
    this.client = null;
    this.tools = [];
    this.connectError = null;
  }

  async connect() {
    const transport = new StdioClientTransport({
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", this.dbPath],
      stderr: "pipe",
    });

    this.client = new Client({ name: "bank-agent", version: "1.0.0" }, { capabilities: {} });

    try {
      await this.client.connect(transport);
      const { tools } = await this.client.listTools();
      this.tools = tools;
      this.connectError = null;
      this.onLog({
        type: "mcp_connected",
        tools: tools.map((t) => t.name),
      });
    } catch (err) {
      this.connectError = err.message ?? String(err);
      this.onLog({ type: "mcp_error", error: this.connectError });
      throw err;
    }
    return this.tools;
  }

  isConnected() {
    return this.client !== null && this.connectError === null;
  }

  // Converts MCP tool definitions into OpenAI-style tool specs for the LLM.
  // allowedNames restricts exposure to a read-only subset (agent must never
  // mutate the client's data), independent of what the MCP server offers.
  toOpenAiTools(allowedNames) {
    const tools = allowedNames ? this.tools.filter((t) => allowedNames.includes(t.name)) : this.tools;
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }

  async callTool(name, args) {
    const startedAt = Date.now();
    this.onLog({ type: "mcp_call_start", tool: name, arguments: args });
    try {
      const rawResult = await this.client.callTool({ name, arguments: args });
      const result = truncateResult(rawResult);
      this.onLog({
        type: "mcp_call_result",
        tool: name,
        arguments: args,
        durationMs: Date.now() - startedAt,
        result,
      });
      return result;
    } catch (err) {
      const error = err.message ?? String(err);
      this.onLog({
        type: "mcp_call_error",
        tool: name,
        arguments: args,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw err;
    }
  }
}

const MAX_RESULT_CHARS = 6000;

// SELECT-запросы без LIMIT на таблице trans (1M+ строк) могут вернуть
// огромный результат — обрезаем его и просим модель сузить запрос.
function truncateResult(result) {
  if (!result?.content) return result;
  const content = result.content.map((item) => {
    if (item.type === "text" && typeof item.text === "string" && item.text.length > MAX_RESULT_CHARS) {
      return {
        ...item,
        text:
          item.text.slice(0, MAX_RESULT_CHARS) +
          `\n… [результат обрезан: всего ${item.text.length} символов. Сузьте запрос через WHERE/LIMIT/агрегацию]`,
      };
    }
    return item;
  });
  return { ...result, content };
}
