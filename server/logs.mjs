import { EventEmitter } from "node:events";

const MAX_LOGS = 500;

// Единый журнал шагов агента (запросы к MCP и к LLM) для панели логов в UI.
// Хранится в памяти процесса — для MVP этого достаточно, персистентность не требуется.
class LogStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.entries = [];
    this.nextId = 1;
  }

  add(entry) {
    const record = { id: this.nextId++, ts: new Date().toISOString(), ...entry };
    this.entries.push(record);
    if (this.entries.length > MAX_LOGS) {
      this.entries.shift();
    }
    this.emit("entry", record);
    return record;
  }

  list(sinceId = 0) {
    return this.entries.filter((e) => e.id > sinceId);
  }
}

export const logStore = new LogStore();
