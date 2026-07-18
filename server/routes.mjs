import { Router } from "express";
import { logStore } from "./logs.mjs";

export function buildRouter({ mcpClient, openRouterClient, agent }) {
  const router = Router();

  router.get("/status", (req, res) => {
    res.json({
      mcp: {
        connected: mcpClient.isConnected(),
        error: mcpClient.connectError,
        tools: mcpClient.tools.map((t) => t.name),
      },
      openrouter: {
        configured: openRouterClient.isConfigured(),
        models: openRouterClient.models,
      },
    });
  });

  router.post("/chat", async (req, res) => {
    const { sessionId, message, accountContext } = req.body ?? {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Пустое сообщение" });
    }

    if (!openRouterClient.isConfigured()) {
      return res.status(503).json({
        error: "Ключ OpenRouter не настроен. Добавьте OPENROUTER_API_KEY в .env и перезапустите сервер.",
      });
    }
    if (!mcpClient.isConnected()) {
      return res.status(503).json({
        error:
          "MCP-сервер базы данных недоступен: " +
          (mcpClient.connectError ?? "нет соединения") +
          ". Проверьте, что uvx/mcp-server-sqlite установлены и путь к базе верен.",
      });
    }

    const sid = sessionId || agent.createSessionId();

    try {
      const { text, cards } = await agent.handleTurn({
        sessionId: sid,
        userText: message.trim(),
        accountContext: accountContext || null,
      });
      res.json({ sessionId: sid, text, cards });
    } catch (err) {
      const friendly = err.friendlyMessage ?? "Произошла ошибка на стороне агента. Попробуйте ещё раз.";
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      logStore.add({ type: "agent_error", error: err.message, sessionId: sid });
      res.status(status).json({ sessionId: sid, error: friendly });
    }
  });

  router.get("/logs", (req, res) => {
    const since = parseInt(req.query.since, 10) || 0;
    res.json(logStore.list(since));
  });

  router.get("/logs/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for (const entry of logStore.list(0)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const onEntry = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    logStore.on("entry", onEntry);

    req.on("close", () => {
      logStore.off("entry", onEntry);
    });
  });

  return router;
}
