// Smoke-тест каждой модели из приоритетного списка (раздел 3 ТЗ):
// проверяет, что модель действительно умеет tool calling.
import "dotenv/config";
import { OpenRouterClient, DEFAULT_MODELS } from "../server/openrouter.mjs";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY не задан в .env — тест не может быть выполнен.");
  process.exit(1);
}

const client = new OpenRouterClient({
  apiKey,
  onLog: () => {},
});

const testTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Возвращает погоду в городе",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const messages = [
  { role: "user", content: "Какая погода в Праге? Используй инструмент get_weather." },
];

for (const model of DEFAULT_MODELS) {
  process.stdout.write(`${model} ... `);
  try {
    const data = await client.chatCompletion({
      messages,
      tools: [testTool],
      modelsOverride: [model],
    });
    const choice = data.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    if (toolCalls?.length) {
      console.log(`OK — вызвала инструмент (${data.model ?? model})`);
    } else {
      console.log(`НЕТ tool calling (finish_reason=${choice?.finish_reason}, ответила текстом)`);
    }
  } catch (err) {
    console.log(`ОШИБКА: ${err.friendlyMessage ?? err.message}`);
  }
}
