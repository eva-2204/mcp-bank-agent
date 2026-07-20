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
      lastEntityId: null,
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

// Ищет номер клиента/счёта прямо в тексте вопроса (не только в поле account_id сайдбара) —
// "клиенту 180", "счёт 570", "account_id 10451" или короткое сообщение из одной цифры.
function extractMentionedId(text) {
  const patterns = [
    /клиент[а-яё]*\s*(?:№|#|id)?\s*[:=]?\s*(\d{1,8})/i,
    /сч[её]т[а-яё]*\s*(?:№|#|id)?\s*[:=]?\s*(\d{1,8})/i,
    /account[_\s]?id\D{0,5}(\d{1,8})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  const bare = text.trim().match(/^(\d{1,8})[?.!]?$/);
  return bare ? bare[1] : null;
}

// "Мягкий" сброс при смене клиента: убираем сырые tool-call/tool-result сообщения (там были
// конкретные цифры ПРЕДЫДУЩЕГО клиента, которые модель иногда путает с новым), но оставляем
// человекочитаемые вопросы и финальные текстовые ответы — иначе теряется тема разговора
// (например, "а у клиента 10451?" без повтора "есть ли у него проблемы с кредитом").
function softResetHistory(messages) {
  const system = messages[0];
  const kept = messages
    .slice(1)
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.content && !m.tool_calls?.length));
  return [system, ...kept];
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

function isCardsShape(parsed) {
  return Boolean(parsed) && typeof parsed === "object" && (("products" in parsed) || ("anomalies" in parsed));
}

// Модели не всегда точно следуют инструкции про метку ```agent-cards — некоторые
// помечают блок как обычный ```json, а некоторые вообще не оборачивают JSON в кавычки
// (наблюдался живой кейс: JSON просто дописывался в конец ответа как есть — в чате он
// повисал видимым текстом, потому что регэксп с ``` его не находил). Пробуем оба варианта.
function extractCards(text) {
  const fenced = text.match(/```(?:agent-cards|json)\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (isCardsShape(parsed)) {
        const cleanText = (text.slice(0, fenced.index) + text.slice(fenced.index + fenced[0].length)).trim();
        return { text: cleanText, cards: parsed };
      }
    } catch {
      // невалидный JSON внутри блока — идём дальше к фолбэку
    }
  }

  // Фолбэк: JSON-объект без оборачивания, но обязательно в самом конце ответа. Ищем открывающую
  // скобку, парную последней закрывающей, а не просто последнюю "{" — иначе ломается на
  // вложенных объектах (у нас products/anomalies — массивы объектов).
  const trimmed = text.trimEnd();
  if (trimmed.endsWith("}")) {
    let depth = 0;
    let openIndex = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i] === "}") depth++;
      else if (trimmed[i] === "{") {
        depth--;
        if (depth === 0) {
          openIndex = i;
          break;
        }
      }
    }
    if (openIndex !== -1) {
      try {
        const parsed = JSON.parse(trimmed.slice(openIndex));
        if (isCardsShape(parsed)) {
          return { text: trimmed.slice(0, openIndex).trim(), cards: parsed };
        }
      } catch {
        // не похоже на валидный JSON — отдаём как обычный текст
      }
    }
  }

  return { text: text.trim(), cards: null };
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

    // Номер клиента/счёта может прийти из поля сайдбара ИЛИ быть прямо в тексте вопроса
    // ("клиенту 180?") — второе не менее надёжно, сайдбар не обязателен.
    const mentionedId = extractMentionedId(userText);
    const effectiveId = accountContext || mentionedId;

    // Смена клиента — старые ЦИФРЫ путают слабые модели (реальный кейс: ответ про клиента А
    // вместо Б), но полностью стирать историю нельзя — теряется тема разговора ("а у клиента
    // 10451?" без повтора исходного вопроса). "Мягкий" сброс убирает только сырые данные.
    if (effectiveId && session.lastEntityId && effectiveId !== session.lastEntityId) {
      session.messages = softResetHistory(session.messages);
      this.onLog({ type: "context_reset", reason: "id_switch", from: session.lastEntityId, to: effectiveId });
    }
    if (effectiveId) session.lastEntityId = effectiveId;

    let userContent = userText;
    if (effectiveId) {
      userContent =
        `[Контекст: в вопросе фигурирует номер ${effectiveId} — это может быть account_id ИЛИ client_id ` +
        `(это разные поля с разными числами для одного человека). Если запрос по account_id=${effectiveId} ` +
        `не находит данных, проверь через disp, не является ли это client_id: ` +
        `SELECT account_id FROM disp WHERE client_id=${effectiveId}. Не используй цифры/факты из ответов ` +
        `про другие номера ранее в этом диалоге.]\n${userText}`;
    } else if (session.lastEntityId) {
      userContent = `[Контекст: явного номера в этом вопросе нет — продолжай анализировать того же клиента/счёт (номер ${session.lastEntityId}), если из текста не следует другое.]\n${userText}`;
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
