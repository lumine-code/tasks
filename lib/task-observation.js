const fs = require("node:fs");
const path = require("node:path");
const { CompositeDisposable, watchFile } = require("lumine");
const fingerprint = require("./file-fingerprint");

const SETTLE_DELAY = 150;

async function sourceRevision(filePath) {
  try {
    const stat = await fs.promises.stat(filePath, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(":");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

// A source write is an automatic-build request even when its bytes stay the
// same. Compare settled filesystem revisions only to deduplicate delivery;
// access time is excluded so a compiler reading its source cannot trigger it.
class TaskObservation {
  constructor(filePath, onChange, onError, mode = "write") {
    this.filePath = path.resolve(filePath);
    this.onChange = onChange;
    this.onError = onError;
    this.mode = mode;
    this.controller = new AbortController();
    this.epoch = 0;
    this.revision = 0;
    this.dirty = false;
    this.disposed = false;
    this.pending = null;
    this.acknowledgement = null;

    const file = watchFile(this.filePath);
    this.subscriptions = new CompositeDisposable(
      file,
      file.onDidChange(() => this.requestCheck()),
      file.onDidInvalidate(() => this.requestCheck()),
      file.onDidError((error) => this.reportError(error)),
    );
    // Capture before arming, then verify through the same settled pipeline as
    // later hints so subscription startup cannot swallow an actual source edit.
    this.ready = Promise.all([file.ready, this.snapshot(this.controller.signal)])
      .then(([, value]) => {
        if (this.disposed) return false;
        this.baseline = value;
        this.latestSnapshot = value;
        if (this.epoch === 0) this.requestCheck();
        return true;
      })
      .catch((error) => {
        this.reportError(error);
        return false;
      });
  }

  snapshot(signal) {
    return this.mode === "content"
      ? fingerprint(this.filePath, signal)
      : sourceRevision(this.filePath);
  }

  reportError(error) {
    if (!this.disposed && error !== this.lastError) {
      this.lastError = error;
      this.onError(error);
    }
  }

  current(pending, revision) {
    return (
      !this.disposed &&
      this.pending === pending &&
      pending.epoch === this.epoch &&
      revision === this.revision
    );
  }

  requestCheck() {
    if (this.disposed) return Promise.resolve(false);
    let pending = this.pending;
    if (!pending) {
      let resolve;
      pending = {
        epoch: this.epoch,
        promise: new Promise((done) => {
          resolve = done;
        }),
        resolve,
      };
      this.pending = pending;
    }
    clearTimeout(pending.timer);
    pending.controller?.abort();
    const revision = ++this.revision;
    pending.timer = setTimeout(() => this.check(pending, revision), SETTLE_DELAY);
    return pending.promise;
  }

  async check(pending, revision) {
    if (!this.current(pending, revision)) return;
    pending.timer = null;
    const controller = new AbortController();
    pending.controller = controller;
    try {
      if (!(await this.ready)) return this.complete(pending, false);
      if (this.acknowledgement) await this.acknowledgement.promise;
      if (!this.current(pending, revision)) return;
      const value = await this.snapshot(controller.signal);
      if (!this.current(pending, revision)) return;
      this.latestSnapshot = value;
      if (value !== this.baseline) this.dirty = true;
      this.complete(pending, this.dirty);
      if (this.dirty && !this.disposed) this.onChange();
    } catch (error) {
      if (!this.current(pending, revision)) return;
      this.complete(pending, false);
      this.reportError(error);
    }
  }

  complete(pending, changed) {
    if (this.pending !== pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(changed);
  }

  cancelCheck() {
    const pending = this.pending;
    if (!pending) return;
    pending.controller?.abort();
    this.complete(pending, false);
  }

  acknowledge() {
    if (this.disposed) return Promise.resolve(false);
    const epoch = ++this.epoch;
    this.cancelCheck();
    this.acknowledgement?.controller.abort();
    return this.captureBaseline(epoch);
  }

  discardChanges() {
    if (this.disposed) return Promise.resolve(false);
    const epoch = ++this.epoch;
    this.cancelCheck();
    this.acknowledgement?.controller.abort();
    this.baseline = this.latestSnapshot;
    this.dirty = false;
    // Refresh changes which were still pending at Stop, but never consume a
    // subsequent save. Its hint advances the revision before this read commits.
    return this.captureBaseline(epoch, this.revision);
  }

  captureBaseline(epoch, revision) {
    const controller = new AbortController();
    const acknowledgement = { controller };
    const current = () =>
      !this.disposed &&
      this.epoch === epoch &&
      (revision === undefined || this.revision === revision);
    acknowledgement.promise = (async () => {
      if (!(await this.ready) || !current()) return false;
      const value = await this.snapshot(controller.signal);
      if (!current()) return false;
      this.baseline = value;
      this.latestSnapshot = value;
      this.dirty = false;
      return true;
    })()
      .catch((error) => {
        if (current()) this.reportError(error);
        return false;
      })
      .finally(() => {
        if (this.acknowledgement === acknowledgement) this.acknowledgement = null;
      });
    this.acknowledgement = acknowledgement;
    return acknowledgement.promise;
  }

  async hasChanges() {
    if (!(await this.ready)) return false;
    while (!this.disposed) {
      if (this.acknowledgement) await this.acknowledgement.promise;
      else if (this.pending) await this.pending.promise;
      else return this.dirty;
    }
    return false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.cancelCheck();
    this.acknowledgement?.controller.abort();
    this.controller.abort();
    this.subscriptions.dispose();
  }
}

module.exports = TaskObservation;
