# mcp-bank-agent

ИИ-агент для рекомендации банковских продуктов и поиска аномалий в тратах на датасете
[Berka (PKDD'99 Financial)](https://sorry.vse.cz/~berka/challenge/PAST/). Весь доступ к данным идёт
только через официальный MCP SQLite-сервер ([`modelcontextprotocol`](https://github.com/modelcontextprotocol/servers-archived),
пакет `mcp-server-sqlite`), LLM — через OpenRouter с приоритетным списком бесплатных моделей с tool calling.

## Архитектура

```
Браузер (public/) → Express (server/) → MCP SQLite сервер (uvx mcp-server-sqlite) → data/berka.db
                                       → OpenRouter Chat Completions API
```

- `server/mcpClient.mjs` — обёртка над `@modelcontextprotocol/sdk`, поднимает `uvx mcp-server-sqlite`
  как дочерний процесс (stdio transport). Единственная точка доступа к БД во всём приложении.
- `server/openrouter.mjs` — клиент OpenRouter с приоритетным списком моделей (раздел 3 ТЗ). OpenRouter
  принимает не более 3 моделей в одном запросе, поэтому 4-я модель (`openrouter/free`) — это отдельный
  запрос-подстраховка, если первые три не сработали.
- `server/agent.mjs` + `server/systemPrompt.mjs` — оркестратор: системный промпт с бизнес-логикой
  (рекомендации продуктов, поиск аномалий, декодирование `birth_number`), цикл tool calling между LLM и MCP.
- `server/logs.mjs` + `GET /api/logs/stream` — журнал шагов агента (запрос → инструмент → параметры → ответ)
  для панели логов в UI.
- `public/` — фронтенд на чистом HTML/CSS/JS (без сборки): чат, карточки-выводы, сворачиваемая панель логов.

## Установка

Требуется: Node.js 20+, Python 3, [`uv`/`uvx`](https://docs.astral.sh/uv/) (для запуска официального
MCP-сервера).

```bash
npm install
```

### 1. Данные

Датасет Berka не входит в репозиторий (см. `.gitignore`) — положите 8 CSV-файлов
(`account.csv`, `card.csv`, `client.csv`, `disp.csv`, `district.csv`, `loan.csv`, `order.csv`, `trans.csv`,
разделитель `;`) в `data/raw/`, затем соберите SQLite-базу:

```bash
npm run build-db
# соберёт data/berka.db из data/raw/*.csv
```

### 2. Ключ OpenRouter

```bash
cp .env.example .env
# впишите OPENROUTER_API_KEY в .env — файл в .gitignore, в репозиторий не попадёт
```

### 3. Запуск

```bash
npm start
# сервер поднимется на http://localhost:3000 и сам подключится к MCP-серверу через uvx
```

При старте сервер выводит в консоль статус подключения к MCP; то же самое видно в UI (цветные индикаторы
в шапке) и через `GET /api/status`.

## Проверка (smoke-тесты)

```bash
node scripts/smoke_test_mcp.mjs         # MCP: подсчёт строк в trans через read_query
node scripts/smoke_test_openrouter.mjs  # OpenRouter: проверка tool calling для каждой модели из списка
```

## Использование

Откройте `http://localhost:3000`, укажите `account_id` клиента в левой панели (или назовите его прямо в
вопросе) и спросите, например: «какой продукт можно предложить?» или «есть ли аномалии в тратах?». Панель
логов (кнопка «Логи» в шапке) показывает каждый шаг: вызов MCP/LLM, параметры, ответ.

## Ограничения

- Бесплатный тариф OpenRouter: 50 запросов/день (1000 при пополнении от $10), 20 запросов/минуту — при
  исчерпании лимита UI показывает понятное сообщение вместо необработанной ошибки.
- Свободные модели из приоритетного списка не всегда идеально следуют системному промпту (язык ответа,
  формат) — это ограничение конкретных бесплатных моделей, а не приложения; отсюда и цепочка fallback.
- Агент не является реальной антифрод-системой — формулировки по аномалиям намеренно аккуратные
  («похоже, что…», «стоит проверить…»), без категоричных утверждений о мошенничестве.
