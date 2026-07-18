const chatEl = document.getElementById("chat");
const composerEl = document.getElementById("composer");
const inputEl = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const accountContextEl = document.getElementById("accountContext");
const statusMcpEl = document.getElementById("statusMcp");
const statusLlmEl = document.getElementById("statusLlm");
const toggleLogsBtn = document.getElementById("toggleLogsBtn");
const logsPanel = document.getElementById("logsPanel");
const logsListEl = document.getElementById("logsList");

const SESSION_KEY = "bank-agent-session-id";
let sessionId = localStorage.getItem(SESSION_KEY) || null;

function twemojify(el) {
  if (window.twemoji) window.twemoji.parse(el, { folder: "svg", ext: ".svg" });
}

// ---------- Статус подключения ----------

async function refreshStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    if (data.mcp.connected) {
      statusMcpEl.textContent = `MCP: подключен (${data.mcp.tools.length} инстр.)`;
      statusMcpEl.className = "status-pill status-pill--ok";
    } else {
      statusMcpEl.textContent = "MCP: недоступен";
      statusMcpEl.className = "status-pill status-pill--error";
      statusMcpEl.title = data.mcp.error ?? "";
    }

    if (data.openrouter.configured) {
      statusLlmEl.textContent = "OpenRouter: настроен";
      statusLlmEl.className = "status-pill status-pill--ok";
    } else {
      statusLlmEl.textContent = "OpenRouter: нет ключа";
      statusLlmEl.className = "status-pill status-pill--error";
    }
  } catch {
    statusMcpEl.textContent = "MCP: нет связи с сервером";
    statusMcpEl.className = "status-pill status-pill--error";
    statusLlmEl.textContent = "OpenRouter: нет связи с сервером";
    statusLlmEl.className = "status-pill status-pill--error";
  }
}

refreshStatus();
setInterval(refreshStatus, 15000);

// ---------- Чат ----------

function addMessage({ role, text, pending, error }) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg--${role}${pending ? " msg--pending" : ""}${error ? " msg--error" : ""}`;
  const bubble = document.createElement("div");
  bubble.className = "msg__bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  twemojify(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return wrap;
}

function renderCards(cards) {
  if (!cards) return null;
  const products = cards.products ?? [];
  const anomalies = cards.anomalies ?? [];
  if (!products.length && !anomalies.length) return null;

  const wrap = document.createElement("div");
  wrap.className = "cards";

  for (const p of products) {
    const card = document.createElement("div");
    card.className = "card card--product";
    card.innerHTML = `
      <div class="card__title">💳 ${escapeHtml(p.title ?? "Продукт")}</div>
      <div class="card__body">${escapeHtml(p.reason ?? "")}</div>
      ${p.confidence ? `<div class="card__meta">Уверенность: ${escapeHtml(p.confidence)}</div>` : ""}
    `;
    wrap.appendChild(card);
  }

  for (const a of anomalies) {
    const card = document.createElement("div");
    card.className = "card card--anomaly";
    const metaParts = [];
    if (a.amount != null) metaParts.push(`${a.amount} Kč`);
    if (a.date) metaParts.push(a.date);
    card.innerHTML = `
      <div class="card__title">⚠️ ${escapeHtml(a.summary ?? "Аномалия")}</div>
      <div class="card__body">${escapeHtml(a.verdict ?? "")}</div>
      ${metaParts.length ? `<div class="card__meta">${escapeHtml(metaParts.join(" · "))}</div>` : ""}
    `;
    wrap.appendChild(card);
  }

  chatEl.appendChild(wrap);
  twemojify(wrap);
  return wrap;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

async function sendMessage(text) {
  if (!text.trim()) return;

  addMessage({ role: "user", text });
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;

  const pendingEl = addMessage({ role: "agent", text: "Анализирую данные…", pending: true });

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        message: text,
        accountContext: accountContextEl.value.trim() || null,
      }),
    });
    const data = await res.json();

    pendingEl.remove();

    if (!res.ok) {
      addMessage({ role: "agent", text: data.error ?? "Произошла ошибка.", error: true });
      return;
    }

    if (data.sessionId) {
      sessionId = data.sessionId;
      localStorage.setItem(SESSION_KEY, sessionId);
    }

    addMessage({ role: "agent", text: data.text || "(пустой ответ)" });
    renderCards(data.cards);
  } catch (err) {
    pendingEl.remove();
    addMessage({ role: "agent", text: "Не удалось связаться с сервером агента. Проверьте, что backend запущен.", error: true });
  } finally {
    sendBtn.disabled = false;
  }
}

composerEl.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(inputEl.value);
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    inputEl.value = chip.dataset.prompt || "";
    inputEl.focus();
  });
});

// ---------- Панель логов ----------

let logsOpen = false;
let logsSource = null;

const LOG_LABELS = {
  mcp_connected: { badge: "MCP", cls: "mcp", title: "MCP-сервер подключен" },
  mcp_call_start: { badge: "MCP →", cls: "mcp", title: "Вызов инструмента" },
  mcp_call_result: { badge: "MCP ←", cls: "mcp", title: "Результат от MCP" },
  mcp_call_error: { badge: "MCP ✗", cls: "error", title: "Ошибка MCP" },
  mcp_error: { badge: "MCP ✗", cls: "error", title: "Ошибка подключения MCP" },
  llm_request: { badge: "LLM →", cls: "llm", title: "Запрос к OpenRouter" },
  llm_response: { badge: "LLM ←", cls: "llm", title: "Ответ OpenRouter" },
  llm_error: { badge: "LLM ✗", cls: "error", title: "Ошибка OpenRouter" },
  local_tool_call: { badge: "TOOL →", cls: "mcp", title: "Локальный инструмент" },
  local_tool_result: { badge: "TOOL ←", cls: "mcp", title: "Результат инструмента" },
  agent_error: { badge: "AGENT ✗", cls: "error", title: "Ошибка агента" },
};

function renderLogEntry(entry) {
  const meta = LOG_LABELS[entry.type] ?? { badge: entry.type, cls: "", title: entry.type };
  const el = document.createElement("div");
  el.className = "log-entry";

  const time = new Date(entry.ts).toLocaleTimeString("ru-RU");
  const { id, ts, type, ...rest } = entry;

  el.innerHTML = `
    <div class="log-entry__head">
      <span><span class="log-entry__badge log-entry__badge--${meta.cls}">${escapeHtml(meta.badge)}</span> ${escapeHtml(meta.title)}</span>
      <span class="log-entry__time">${escapeHtml(time)}</span>
    </div>
  `;

  if (Object.keys(rest).length) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(rest, null, 2);
    el.appendChild(pre);
  }

  logsListEl.appendChild(el);
  logsListEl.scrollTop = logsListEl.scrollHeight;
}

function connectLogsStream() {
  if (logsSource) return;
  logsSource = new EventSource("/api/logs/stream");
  logsSource.onmessage = (e) => {
    try {
      renderLogEntry(JSON.parse(e.data));
    } catch {
      /* игнорируем некорректные события */
    }
  };
}

toggleLogsBtn.addEventListener("click", () => {
  logsOpen = !logsOpen;
  logsPanel.hidden = !logsOpen;
  toggleLogsBtn.setAttribute("aria-expanded", String(logsOpen));
  if (logsOpen) connectLogsStream();
});
