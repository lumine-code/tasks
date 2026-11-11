const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { CompositeDisposable, watchFile } = require("lumine");

const pathKey = (filePath) => {
  const absolute = path.resolve(filePath);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

async function fingerprint(filePath, signal) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath, { signal })) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

// Owns the inputs of one execution's current report, independently of the
// process and its retained history. A report never becomes current again once
// its input snapshot is lost, even if the original contents later return.
class TaskSources {
  constructor(onInvalidate, onError) {
    this.onInvalidate = onInvalidate;
    this.onError = onError;
    this.paths = new Map();
    this.valid = true;
    this.disposed = false;
    this.controller = new AbortController();
    this.readQueue = [];
    this.reading = 0;
    this.subscriptions = new CompositeDisposable();
  }

  read(filePath) {
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.readQueue.push({ filePath, resolve, reject });
      this.drainReads();
    });
  }

  drainReads() {
    // Compiler inputs can include large images and PDFs. Bound both open
    // streams and memory instead of materializing every input at once.
    while (!this.disposed && this.reading < 4 && this.readQueue.length) {
      const read = this.readQueue.shift();
      this.reading++;
      fingerprint(read.filePath, this.controller.signal)
        .then(read.resolve, read.reject)
        .finally(() => {
          this.reading--;
          this.drainReads();
        });
    }
  }

  invalidate(error) {
    if (!this.valid || this.disposed) return;
    this.valid = false;
    this.dispose();
    this.onInvalidate();
    if (error) this.onError(error);
  }

  async add(filePaths) {
    if (!this.valid || this.disposed) return;
    for (const filePath of filePaths) {
      if (!this.valid || this.disposed) break;
      if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) continue;
      const key = pathKey(filePath);
      if (this.paths.has(key)) continue;
      try {
        const absolute = path.resolve(filePath);
        const file = watchFile(absolute);
        const entry = { filePath: absolute };
        this.paths.set(key, entry);
        this.subscriptions.add(file);
        this.subscriptions.add(
          file.onDidChange((events) => {
            if (events.some((event) => event.action === "deleted")) this.invalidate();
            else this.check(entry);
          }),
          // Recovery cannot establish that this execution's inputs survived
          // the delivery gap. Keep its history, but withdraw the current report.
          file.onDidInvalidate(() => this.invalidate()),
          file.onDidError((error) => this.invalidate(error)),
        );
        // Capture before readiness, then read again after arming: a change in
        // the subscription startup gap must not become an accepted baseline.
        const baseline = this.read(absolute);
        entry.pending = Promise.all([file.ready, baseline])
          .then(async ([, value]) => {
            entry.fingerprint = value;
            if (this.valid && !this.disposed && (await this.read(absolute)) !== value)
              this.invalidate();
          })
          .catch((error) => this.invalidate(error));
      } catch (error) {
        this.invalidate(error);
        break;
      }
    }
    await Promise.all([...this.paths.values()].map((entry) => entry.pending));
  }

  check(entry) {
    if (!this.valid || this.disposed) return Promise.resolve();
    entry.pending = entry.pending
      .then(async () => {
        if (!this.valid || this.disposed) return;
        if ((await this.read(entry.filePath)) !== entry.fingerprint) this.invalidate();
      })
      .catch((error) => this.invalidate(error));
    return entry.pending;
  }

  async verify() {
    await Promise.all([...this.paths.values()].map((entry) => this.check(entry)));
    return this.valid && !this.disposed;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const read of this.readQueue.splice(0)) read.resolve(null);
    this.subscriptions.dispose();
  }
}

module.exports = TaskSources;
