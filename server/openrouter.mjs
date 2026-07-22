const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// OpenRouter принимает не более 3 моделей в одном поле "models" (проверено эмпирически —
// запрос с 4 моделями отклоняется с 400 "'models' array must have 3 items or fewer").
// Поэтому 4-й пункт списка (openrouter/free, раздел 3 ТЗ) — это отдельный запрос-подстраховка,
// а не часть того же вызова.
const MAX_MODELS_PER_REQUEST = 3;

// fetch() без таймаута может зависнуть навсегда, если OpenRouter/провайдер не отвечает —
// тогда пользователь бесконечно видит "Анализирую данные…" без единой ошибки. Некоторые модели
// "думают" подолгу (наблюдались ответы с 1500+ токенами рассуждений и десятками секунд) — таймаут
// увеличен с 45 до 60с, чтобы не рвать по-настоящему медленные, но живые ответы.
const REQUEST_TIMEOUT_MS = 60_000;

// Приоритетный список сильных бесплатных моделей с tool calling (раздел 3 ТЗ).
// Сужен по итогам живого тестирования: qwen/qwen3-coder:free и google/gemma-4-31b-it:free почти
// всегда получали upstream-ограничение "temporarily rate-limited" от своих провайдеров (Venice /
// Google AI Studio) — впустую тратили первую попытку. Важный нюанс, выявленный позже: когда
// nemotron-3-super-120b сама недоступна, запрос молча проваливается в openrouter/free — а это
// не "запасная модель", а рандомный выбор ЛЮБОЙ бесплатной модели из пула OpenRouter, включая
// совсем слабые/маленькие (nemotron-nano-9b, poolside/laguna-xs и т.п.) — отсюда скачки качества
// и смешение языков в ответах.
// Вторым номером ВРЕМЕННО стоит nvidia/nemotron-3-ultra-550b-a55b:free (550B, ещё крупнее
// nemotron-3-super-120b) вместо ранее использовавшейся openai/gpt-oss-20b:free — пробуем, не
// станет ли реже скатываться в лотерею openrouter/free за счёт более крупной второй модели.
// Живьём не тестировано (не тратим квоту пользователя на проверку) — если 550B-модель окажется
// медленнее/чаще перегружена, откатить второй пункт обратно на "openai/gpt-oss-20b:free".
export const DEFAULT_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/free",
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class OpenRouterClient {
  constructor({ apiKey, models, onLog }) {
    this.apiKey = apiKey;
    this.models = models && models.length ? models : DEFAULT_MODELS;
    this.onLog = onLog ?? (() => {});
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async chatCompletion({ messages, tools, toolChoice, modelsOverride }) {
    if (!this.apiKey) {
      const err = new Error("OPENROUTER_NOT_CONFIGURED");
      err.friendlyMessage =
        "Ключ OpenRouter не настроен. Добавьте OPENROUTER_API_KEY в файл .env и перезапустите сервер.";
      throw err;
    }

    const allModels = modelsOverride && modelsOverride.length ? modelsOverride : this.models;
    const chunks = chunk(allModels, MAX_MODELS_PER_REQUEST);

    let lastErr;
    for (const models of chunks) {
      try {
        return await this.#requestOnce({ messages, tools, toolChoice, models });
      } catch (err) {
        lastErr = err;
        if (err.status === 401) throw err; // неверный ключ — повторять бессмысленно
      }
    }
    throw lastErr;
  }

  async #requestOnce({ messages, tools, toolChoice, models }) {
    const body = {
      models,
      messages,
      ...(tools?.length ? { tools, tool_choice: toolChoice ?? "auto" } : {}),
    };

    const startedAt = Date.now();
    this.onLog({
      type: "llm_request",
      models,
      messageCount: messages.length,
      toolCount: tools?.length ?? 0,
    });

    let response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Title": "Bank Product & Anomaly Agent",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
      this.onLog({ type: "llm_error", models, error: isTimeout ? "timeout" : err.message });
      const wrapped = new Error(isTimeout ? "OPENROUTER_TIMEOUT" : "OPENROUTER_NETWORK_ERROR");
      wrapped.friendlyMessage = isTimeout
        ? `OpenRouter не ответил за ${REQUEST_TIMEOUT_MS / 1000} секунд. Возможно, выбранная модель перегружена — попробуйте ещё раз.`
        : "Не удалось связаться с OpenRouter. Проверьте подключение к интернету и попробуйте ещё раз.";
      throw wrapped;
    }

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      this.onLog({
        type: "llm_error",
        models,
        status: response.status,
        durationMs,
        body: errText.slice(0, 500),
      });

      if (response.status === 429) {
        const err = new Error("OPENROUTER_RATE_LIMIT");
        err.friendlyMessage =
          "Дневной лимит бесплатных запросов OpenRouter исчерпан (или превышен лимит 20 запросов/минуту). " +
          "Попробуйте позже, либо пополните баланс OpenRouter для увеличения лимита (50 → 1000 запросов/день).";
        err.status = 429;
        throw err;
      }
      if (response.status === 401) {
        const err = new Error("OPENROUTER_UNAUTHORIZED");
        err.friendlyMessage = "Ключ OpenRouter недействителен. Проверьте OPENROUTER_API_KEY в .env.";
        err.status = 401;
        throw err;
      }
      const err = new Error("OPENROUTER_ERROR");
      err.friendlyMessage = `OpenRouter вернул ошибку (${response.status}). Попробуйте ещё раз позже.`;
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    if (data.error) {
      this.onLog({ type: "llm_error", models, durationMs, error: data.error });
      const err = new Error("OPENROUTER_ERROR");
      err.friendlyMessage = `OpenRouter вернул ошибку: ${data.error.message ?? "неизвестная ошибка"}.`;
      err.status = data.error.code;
      throw err;
    }

    this.onLog({
      type: "llm_response",
      durationMs,
      model: data.model,
      usage: data.usage,
      finishReason: data.choices?.[0]?.finish_reason,
    });
    return data;
  }
}
