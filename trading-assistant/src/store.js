import fs from "fs";
import path from "path";

/**
 * Tiny JSON-file persistence so rules, chat history and the activity log
 * survive restarts. Single-user app -> a file is plenty; writes are atomic
 * (write temp file, then rename).
 */
export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, "state.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = {
      rules: [],        // standing instructions (auto-outbid etc.)
      messages: [],     // chat history (Anthropic message format)
      activity: [],     // human-readable activity log
      counters: { rule: 0 },
    };
    this._load();
    this._writeTimer = null;
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.state = { ...this.state, ...raw };
      }
    } catch (err) {
      console.error(`[store] could not read ${this.file}, starting fresh:`, err.message);
    }
  }

  save() {
    // debounce bursts of writes
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      try {
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error("[store] save failed:", err.message);
      }
    }, 150);
  }

  saveNow() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nextRuleId() {
    this.state.counters.rule += 1;
    this.save();
    return `rule-${this.state.counters.rule}`;
  }

  addActivity(kind, text, meta = {}) {
    const entry = { ts: new Date().toISOString(), kind, text, ...meta };
    this.state.activity.push(entry);
    if (this.state.activity.length > 500) {
      this.state.activity = this.state.activity.slice(-500);
    }
    this.save();
    return entry;
  }
}
