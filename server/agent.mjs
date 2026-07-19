import { randomUUID } from "node:crypto";
import { buildSystemPrompt } from "./systemPrompt.mjs";
import { decodeBirthNumber } from "./birthNumber.mjs";

const READ_ONLY_MCP_TOOLS = ["read_query", "list_tables", "describe_table"];
const MAX_TOOL_ITERATIONS = 12;
const MAX_HISTORY_MESSAGES = 24; // не считая system-сообщения

const DECODE_BIRTH_TOOL = {
  type: "function",
  function: {
    name: "decode_birth_number",
    description:
      "Декодирует поле client.birth_number в дату рождения, пол и возраст (относительно конца датасета). " +
      "Всегда используй перед тем как сообщить клиенту возраст или пол.",
    parameters: {
      type: "object",
      properties: {
        birth_number: { type: "string", description: "Сырое значение client.birth_number, например '706213'" },
      },
      required: ["birth_number"],
    },
  },
};

// Держит историю диалога по сессиям в памяти процесса — персистентность не требуется для MVP.
const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [{ role: "system", content: buildSystemPrompt() }],
      lastAccountContext: null,
    });
  }
  return sessions.get(sessionId);
}

function trimHistory(messages) {
  // messages[0] — системный промпт, его не трогаем
  if (messages.length <= MAX_HISTORY_MESSAGES + 1) return messages;
  const system = messages[0];
  const tail = messages.slice(-MAX_HISTORY_MESSAGES);
  return [system, ...tail];
}

// Некоторые бесплатные модели (например nemotron) иногда не оформляют вызов инструмента
// в структурированное поле tool_calls, а пишут его как псевдо-XML прямо в тексте:
// <tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>.
// Разбираем такой текст как обычный tool call — это устойчивее, чем считать его финальным ответом.
function parsePseudoToolCalls(content) {
  if (!content || !content.includes("<tool_call>")) return null;
  const calls = [];
  const callRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let callMatch;
  while ((callMatch = callRe.exec(content))) {
    const block = callMatch[1];
    const fnMatch = block.match(/<function=([\w.-]+)>/);
    if (!fnMatch) continue;
    const name = fnMatch[1];
    const args = {};
    const paramRe = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRe.exec(block))) {
      const [, key, rawValue] = paramMatch;
      const value = rawValue.trim();
      try {
        args[key] = JSON.parse(value);
      } catch {
        args[key] = value;
      }
    }
    calls.push({ id: `pseudo_${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  }
  return calls.length ? calls : null;
}

// Модели не всегда точно следуют инструкции про метку ```agent-cards — некоторые
// помечают блок как обычный ```json. Принимаем оба варианта, лишь бы форма JSON совпадала.
function extractCards(text) {
  const match = text.match(/```(?:agent-cards|json)\s*([\s\S]*?)```/);
  if (!match) return { text: text.trim(), cards: null };
  try {
    const parsed = JSON.parse(match[1].trim());
    if (!parsed || typeof parsed !== "object" || (!("products" in parsed) && !("anomalies" in parsed))) {
      return { text: text.trim(), cards: null };
    }
    const cleanText = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
    return { text: cleanText, cards: parsed };
  } catch {
    // если модель прислала невалидный JSON — просто отдаём текст без карточек
    return { text: text.trim(), cards: null };
  }
}

export class Agent {
  constructor({ mcpClient, openRouterClient, onLog }) {
    this.mcpClient = mcpClient;
    this.openRouterClient = openRouterClient;
    this.onLog = onLog ?? (() => {});
  }

  createSessionId() {
    return randomUUID();
  }

  async handleTurn({ sessionId, userText, accountContext }) {
    const session = getOrCreateSession(sessionId);

    // Переключение на другого клиента (account_id изменился) — старые вопросы/ответы про
    // предыдущего клиента не просто бесполезны, а активно путают слабые модели (наблюдался
    // реальный кейс: модель повторила анализ прошлого клиента вместо нового). Начинаем
    // диалог с этим клиентом с чистого листа.
    if (accountContext && session.lastAccountContext && accountContext !== session.lastAccountContext) {
      session.messages = [session.messages[0]];
      this.onLog({
        type: "context_reset",
        reason: "account_switch",
        from: session.lastAccountContext,
        to: accountContext,
      });
    }
    if (accountContext) session.lastAccountContext = accountContext;

    let userContent = userText;
    if (accountContext) {
      userContent = `[Контекст: выбран account_id=${accountContext}. Если явно не указано иное, анализируй именно этот счёт. Не используй цифры/факты из предыдущих ответов про другие счета.]\n${userText}`;
    }
    session.messages.push({ role: "user", content: userContent });

    const mcpTools = this.mcpClient.isConnected() ? this.mcpClient.toOpenAiTools(READ_ONLY_MCP_TOOLS) : [];
    const tools = [...mcpTools, DECODE_BIRTH_TOOL];

    let finalMessage = null;
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.openRouterClient.chatCompletion({
        messages: session.messages,
        tools,
      });

      const choice = response.choices?.[0];
      const message = choice?.message;
      if (!message) {
        throw new Error("OpenRouter вернул пустой ответ");
      }

      session.messages.push(message);

      const toolCalls = message.tool_calls?.length ? message.tool_calls : parsePseudoToolCalls(message.content);

      if (!toolCalls?.length) {
        finalMessage = message;
        break;
      }

      for (const toolCall of toolCalls) {
        const result = await this.executeTool(toolCall);
        session.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
    }

    if (!finalMessage) {
      // исчерпан лимит итераций tool-calling — просим модель ответить без новых вызовов
      const response = await this.openRouterClient.chatCompletion({
        messages: [
          ...session.messages,
          { role: "user", content: "Дай финальный ответ прямо сейчас, без новых вызовов инструментов." },
        ],
      });
      finalMessage = response.choices?.[0]?.message;
      if (finalMessage) session.messages.push(finalMessage);
    }

    session.messages = trimHistory(session.messages);

    const content = finalMessage?.content ?? "";
    const { text, cards } = extractCards(content);
    return { text, cards };
  }

  async executeTool(toolCall) {
    const name = toolCall.function?.name;
    let args = {};
    try {
      args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      return { error: "Некорректный JSON аргументов инструмента" };
    }

    if (name === "decode_birth_number") {
      this.onLog({ type: "local_tool_call", tool: name, arguments: args });
      try {
        const decoded = decodeBirthNumber(args.birth_number);
        this.onLog({ type: "local_tool_result", tool: name, result: decoded });
        return decoded;
      } catch (err) {
        return { error: err.message };
      }
    }

    if (READ_ONLY_MCP_TOOLS.includes(name)) {
      try {
        return await this.mcpClient.callTool(name, args);
      } catch (err) {
        return { error: err.message ?? String(err) };
      }
    }

    return { error: `Инструмент "${name}" недоступен агенту` };
  }
}
