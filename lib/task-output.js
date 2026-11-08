const { Emitter } = require("lumine");

// Retained for the package generation, including while the dock tab is closed.
class TaskOutput {
  constructor() {
    this.emitter = new Emitter();
    this.chunks = [];
    this.text = "";
    this.state = "idle";
    this.targetName = "";
    this.summary = "";
    this.startedAt = null;
    this.destroyed = false;
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  getText() {
    return this.text;
  }

  start(targetName) {
    this.state = "running";
    this.targetName = targetName;
    this.startedAt = Date.now();
    this.summary = "Running…";
    this.emitter.emit("did-change", { type: "state" });
  }

  finish(state, { code, signal, error } = {}) {
    this.state = state;
    const outcome = error
      ? "Unable to start"
      : signal
        ? signal
        : code != null
          ? `Exit code ${code}`
          : "";
    const duration =
      this.startedAt == null ? "" : `${((Date.now() - this.startedAt) / 1000).toFixed(1)} s`;
    this.summary = [outcome, duration].filter(Boolean).join(" · ");
    this.emitter.emit("did-change", { type: "state" });
  }

  clear() {
    this.chunks = [];
    this.text = "";
    this.emitter.emit("did-change", { type: "reset" });
  }

  append(text, stream = "stdout") {
    if (!text || this.destroyed) return;
    const chunk = { text, stream };
    this.chunks.push(chunk);
    this.text += text;
    const characterLimit = lumine.config.get("tasks.maxOutputCharacters") || 2000000;
    const originalLength = this.text.length;
    this.text = this.text.slice(-characterLimit);
    const lines = this.text.split("\n");
    const limit = lumine.config.get("tasks.maxOutputLines");
    const trimmed = lines.length > limit || originalLength > characterLimit;
    if (trimmed) {
      const retained = lines.slice(-limit).join("\n");
      let removed = originalLength - retained.length;
      this.text = retained;
      while (removed > 0 && this.chunks.length) {
        const first = this.chunks[0];
        if (first.text.length <= removed) {
          removed -= first.text.length;
          this.chunks.shift();
        } else {
          this.chunks[0] = { ...first, text: first.text.slice(removed) };
          removed = 0;
        }
      }
    }
    this.emitter.emit("did-change", { type: "append", chunk, trimmed });
  }

  destroy() {
    this.destroyed = true;
    this.emitter.dispose();
    this.chunks = [];
    this.text = "";
  }
}

module.exports = TaskOutput;
