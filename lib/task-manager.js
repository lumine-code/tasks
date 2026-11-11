const path = require("node:path");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { Emitter, Disposable, CompositeDisposable, watchFile } = require("lumine");
const TaskOutput = require("./task-output");
const TaskSources = require("./task-sources");

const ACTIVE_STATES = new Set(["preparing", "running", "collecting"]);
const canonical = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const validPathString = (value) =>
  typeof value === "string" && value.trim().length > 0 && !value.includes("\0");

async function abortable(value, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([value, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

class TaskManager {
  constructor() {
    this.emitter = new Emitter();
    this.providers = new Map();
    this.jobs = [];
    this.latest = new Map();
    this.reports = new Map();
    this.observed = new Map();
    this.artifactTargets = new Map();
    this.targets = [];
    this.nextId = 0;
    this.destroyed = false;
    this.disposing = false;
  }

  onDidStartJob(callback) {
    return this.emitter.on("did-start-job", callback);
  }
  onDidChangeJob(callback) {
    return this.emitter.on("did-change-job", callback);
  }
  onDidFinishJob(callback) {
    return this.emitter.on("did-finish-job", callback);
  }
  onDidChangeObserved(callback) {
    return this.emitter.on("did-change-observed", callback);
  }
  onDidChangeProviders(callback) {
    return this.emitter.on("did-change-providers", callback);
  }
  onDidChangeTargets(callback) {
    return this.emitter.on("did-change-targets", callback);
  }
  onDidChangeArtifactTargets(callback) {
    return this.emitter.on("did-change-artifact-targets", callback);
  }

  associateArtifact(request, artifactPath) {
    if (
      this.destroyed ||
      this.disposing ||
      !request ||
      typeof request.providerId !== "string" ||
      !validPathString(request.filePath) ||
      !validPathString(artifactPath)
    )
      return false;
    const record = this.providers.get(request.providerId);
    if (!record || record.disposed) return false;
    const filePath = path.resolve(request.filePath);
    const outputPath = path.resolve(artifactPath);
    const key = canonical(outputPath);
    const previous = this.artifactTargets.get(key);
    if (previous?.record === record && canonical(previous.filePath) === canonical(filePath))
      return false;
    this.artifactTargets.set(key, {
      artifactPath: outputPath,
      providerId: request.providerId,
      filePath,
      record,
    });
    this.artifactTargetChanged(outputPath, { providerId: request.providerId, filePath });
    return true;
  }

  getArtifactTarget(artifactPath) {
    if (this.destroyed || this.disposing || !validPathString(artifactPath)) return null;
    const association = this.artifactTargets.get(canonical(artifactPath));
    if (
      !association ||
      association.record.disposed ||
      this.providers.get(association.providerId) !== association.record
    )
      return null;
    return { providerId: association.providerId, filePath: association.filePath };
  }

  artifactTargetChanged(artifactPath, target) {
    this.emitter.emit("did-change-artifact-targets", { artifactPath, target });
    lumine.commands.invalidateAvailability();
  }

  clearArtifactTargets(record = null) {
    for (const [key, association] of [...this.artifactTargets]) {
      if (
        (record && association.record !== record) ||
        this.artifactTargets.get(key) !== association
      )
        continue;
      this.artifactTargets.delete(key);
      this.artifactTargetChanged(association.artifactPath, null);
    }
  }

  associateJobArtifacts(job) {
    for (const artifact of job.artifacts) {
      if (!this.current(job) || this.providers.get(job.providerId) !== job.record) return;
      this.associateArtifact({ providerId: job.providerId, filePath: job.filePath }, artifact.path);
    }
  }

  getTargets() {
    return this.targets.slice();
  }
  setTargets(targets) {
    if (this.destroyed || this.disposing) return;
    const identities = new Set();
    for (const target of targets) {
      if (!target.id || identities.has(target.id))
        throw new Error("Tasks targets require unique identities.");
      identities.add(target.id);
    }
    this.targets = targets.slice();
    this.emitter.emit("did-change-targets", {
      targets: this.getTargets(),
    });
    lumine.commands.invalidateAvailability();
  }
  registerProvider(provider) {
    if (this.destroyed || this.disposing) return new Disposable();
    if (
      !provider ||
      typeof provider.id !== "string" ||
      !provider.id ||
      typeof provider.name !== "string" ||
      typeof provider.supports !== "function" ||
      typeof provider.prepare !== "function"
    )
      throw new TypeError("Invalid build provider.");
    if (this.providers.has(provider.id))
      throw new Error(`Tasks provider ${provider.id} is already registered.`);
    const record = { provider, disposed: false };
    this.providers.set(provider.id, record);
    this.emitter.emit("did-change-providers", { providerId: provider.id });
    return new Disposable(() => {
      if (record.disposed) return;
      this.clearObserved({ providerId: provider.id });
      record.disposed = true;
      if (this.providers.get(provider.id) === record) this.providers.delete(provider.id);
      this.clearArtifactTargets(record);
      this.stopAll({ providerId: provider.id });
      this.clearMessages({ providerId: provider.id });
      for (const [key, report] of this.reports) {
        if (report.job.record !== record) continue;
        report.sources?.dispose();
        this.reports.delete(key);
      }
      if (!this.destroyed) this.emitter.emit("did-change-providers", { providerId: provider.id });
    });
  }

  resolve(providerId, filePath) {
    const record = this.providers.get(providerId);
    if (!record || record.disposed || !filePath) return null;
    const absolute = path.resolve(filePath);
    if (!record.provider.supports(absolute)) return null;
    return path.resolve(record.provider.resolve?.(absolute) || absolute);
  }

  key(providerId, filePath) {
    return JSON.stringify([providerId, canonical(filePath)]);
  }

  getJob({ providerId, filePath }) {
    return filePath ? (this.latest.get(this.key(providerId, filePath)) ?? null) : null;
  }

  getJobs({ providerId, filePath, activeOnly = false } = {}) {
    return this.jobs.filter(
      (job) =>
        (!providerId || job.providerId === providerId) &&
        (!filePath || canonical(job.filePath) === canonical(filePath)) &&
        (!activeOnly || ACTIVE_STATES.has(job.state)),
    );
  }

  getLogs() {
    return this.getJobs().slice().reverse();
  }

  run({ providerId, filePath, reason = "manual" }) {
    if (this.destroyed || this.disposing) return null;
    const record = this.providers.get(providerId);
    const resolved = this.resolve(providerId, filePath);
    if (!resolved || this.destroyed || this.disposing || this.providers.get(providerId) !== record)
      return null;
    const key = this.key(providerId, resolved);
    const previous = this.latest.get(key);
    if (
      previous &&
      previous.record === record &&
      !previous.controller.signal.aborted &&
      ACTIVE_STATES.has(previous.state)
    ) {
      if (reason === "save") previous.rerun = true;
      return previous;
    }
    const controller = new AbortController();
    let complete;
    const job = {
      id: `tasks-${++this.nextId}`,
      targetId: key,
      providerId,
      filePath: resolved,
      reason,
      name: record.provider.name,
      source: this.targets.find((target) => target.id === key)?.source || resolved,
      state: "preparing",
      startedAt: Date.now(),
      finishedAt: null,
      elapsedTime: 0,
      stdout: "",
      stderr: "",
      diagnostics: [],
      artifacts: [],
      code: null,
      signal: null,
      error: null,
      outputTruncated: false,
      log: new TaskOutput(),
      completion: new Promise((resolve) => {
        complete = resolve;
      }),
      stop: () => this.stopJob(job),
    };
    Object.defineProperties(job, {
      controller: { value: controller },
      complete: { value: complete },
      record: { value: record },
    });
    this.jobs.push(job);
    this.latest.set(key, job);
    this.reports.get(key)?.sources?.dispose();
    this.reports.set(key, { job, messages: [], sources: null });
    job.log.start(job.name);
    this.changed(job);
    Promise.resolve()
      .then(() => this.execute(job))
      .catch((error) => this.finish(job, { error }));
    this.prune();
    return job;
  }

  current(job) {
    return (
      !this.destroyed &&
      !job.record.disposed &&
      !job.controller.signal.aborted &&
      !job.finishedAt &&
      this.latest.get(this.key(job.providerId, job.filePath)) === job
    );
  }

  changed(job) {
    if (this.destroyed) return;
    job.elapsedTime = (job.finishedAt || Date.now()) - job.startedAt;
    this.emitter.emit("did-change-job", job);
    lumine.commands.invalidateAvailability();
  }

  normalizeArtifacts(artifacts, job, cwd) {
    return (artifacts || []).map((artifact) => {
      if (!artifact || typeof artifact.path !== "string" || typeof artifact.kind !== "string")
        throw new TypeError("Tasks artifacts require path and kind.");
      return {
        ...artifact,
        path: path.resolve(cwd, artifact.path),
        sourcePath: artifact.sourcePath || job.filePath,
      };
    });
  }

  sourcePaths(job, diagnostics = []) {
    return [
      job.filePath,
      ...(job.record.provider.getWatchPaths?.(job.filePath) || []),
      ...diagnostics.map((message) => message.location?.file),
    ];
  }

  async trackSources(job) {
    const report = this.reports.get(job.targetId);
    if (!report || report.job !== job || !this.current(job)) return;
    const sources = new TaskSources(
      () => {
        if (this.destroyed || this.reports.get(job.targetId) !== report) return;
        report.messages = [];
        this.changed(job);
      },
      (error) => {
        if (this.destroyed || this.disposing || this.reports.get(job.targetId) !== report) return;
        lumine.notifications.addError("Unable to track task sources.", { detail: error.message });
      },
    );
    report.sources = sources;
    const paths = this.sourcePaths(job);
    if (!this.current(job)) return sources.dispose();
    await abortable(sources.add(paths), job.controller.signal);
  }

  async execute(job) {
    if (!this.current(job)) return;
    const plan = await abortable(
      job.record.provider.prepare(
        { filePath: job.filePath, reason: job.reason },
        job.controller.signal,
      ),
      job.controller.signal,
    );
    if (!this.current(job)) return;
    if (
      !plan ||
      typeof plan.cmd !== "string" ||
      !plan.cmd ||
      (plan.args != null &&
        (!Array.isArray(plan.args) || plan.args.some((argument) => typeof argument !== "string")))
    )
      throw new TypeError("A build plan requires cmd and an array of string args.");
    const cwd = path.resolve(plan.cwd || path.dirname(job.filePath));
    job.plan = { ...plan, cwd, args: plan.args || [] };
    // Preparation may save source editors. Arm and snapshot their resulting
    // on-disk contents before the compiler can read them.
    await this.trackSources(job);
    if (!this.current(job)) return;
    job.name = plan.name || job.name;
    job.log.targetName = job.name;
    job.artifacts = this.normalizeArtifacts(plan.artifacts, job, cwd);
    this.associateJobArtifacts(job);
    if (!this.current(job)) return;
    this.emitter.emit("did-start-job", job);
    if (!this.current(job)) return;
    job.state = "running";
    job.log.append(`> ${plan.cmd} ${job.plan.args.join(" ")}\n`, "command");
    this.changed(job);
    if (!this.current(job)) return;
    const stdout = new StringDecoder("utf8");
    const stderr = new StringDecoder("utf8");
    let child;
    try {
      child = childProcess.spawn(plan.cmd, job.plan.args, {
        cwd,
        env: { ...process.env, ...plan.env },
        shell: Boolean(plan.shell),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      return this.finish(job, { error });
    }
    job.process = child;
    child.on("error", (error) => {
      job.processError = error;
    });
    child.stdout?.on("data", (data) => {
      if (this.current(job)) this.append(job, stdout.write(data), "stdout");
    });
    child.stderr?.on("data", (data) => {
      if (this.current(job)) this.append(job, stderr.write(data), "stderr");
    });
    child.once("close", (code, signal) => {
      this.append(job, stdout.end(), "stdout");
      this.append(job, stderr.end(), "stderr");
      this.finish(job, { code, signal, error: job.processError });
    });
    if (!this.current(job)) this.killTree(job);
  }

  append(job, text, stream) {
    if (!text || job.finishedAt || this.destroyed) return;
    const limit = lumine.config.get("tasks.maxOutputCharacters") || 2000000;
    const combined = job[stream] + text;
    job.outputTruncated ||= combined.length > limit;
    job[stream] = combined.slice(-limit);
    job.log.append(text, stream);
    this.changed(job);
  }

  async finish(job, { code = null, signal = null, error = null } = {}) {
    if (job.finishedAt || job.finishing) return;
    job.finishing = true;
    clearTimeout(job.killTimer);
    if (job.terminationGroup) {
      // The group can outlive its leader. Reap it while handling that leader's
      // close event, before releasing its identity or retaining a delayed kill.
      const group = job.terminationGroup;
      job.terminationGroup = null;
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // ESRCH means the complete group has already exited.
      }
    }
    job.process = null;
    job.code = code;
    job.signal = signal;
    job.error = error;
    if (job.plan && this.current(job)) {
      job.state = "collecting";
      this.changed(job);
      try {
        const result = await abortable(
          job.record.provider.collectResult?.(
            {
              job,
              filePath: job.filePath,
              plan: job.plan,
              stdout: job.stdout,
              stderr: job.stderr,
              code,
              signal,
              error,
            },
            job.controller.signal,
          ),
          job.controller.signal,
        );
        if (this.current(job) && result) {
          job.diagnostics = result.diagnostics || [];
          const report = this.reports.get(job.targetId);
          const paths = this.sourcePaths(job, job.diagnostics);
          if (this.current(job) && report?.job === job && report.sources) {
            await abortable(report.sources.add(paths), job.controller.signal);
            const valid = await abortable(report.sources.verify(), job.controller.signal);
            if (this.current(job) && this.reports.get(job.targetId) === report && valid)
              report.messages = job.diagnostics;
          }
          if (this.current(job)) {
            if (result.artifacts)
              job.artifacts = this.normalizeArtifacts(result.artifacts, job, job.plan.cwd);
            this.associateJobArtifacts(job);
            if (result.failed) job.resultFailed = true;
          }
        }
      } catch (collectionError) {
        if (this.current(job)) job.error = collectionError;
      }
    }
    const cancelled = job.controller.signal.aborted || job.record.disposed || this.destroyed;
    job.state = cancelled
      ? "cancelled"
      : job.error || job.resultFailed || (code != null && code !== 0)
        ? "failed"
        : signal
          ? "cancelled"
          : "passed";
    if (cancelled) job.diagnostics = [];
    const report = this.reports.get(job.targetId);
    if (report?.job === job && (cancelled || !report.messages.length)) {
      report.messages = [];
      report.sources?.dispose();
    }
    if (job.error) job.log.append(`${job.error.message}\n`, "stderr");
    job.finishedAt = Date.now();
    job.elapsedTime = job.finishedAt - job.startedAt;
    job.log.finish(job.state === "cancelled" ? "stopped" : job.state, {
      code,
      signal,
      error: job.error,
    });
    job.complete(job);
    if (!this.destroyed) {
      this.changed(job);
      this.emitter.emit("did-finish-job", job);
      this.refreshObservation(job.providerId, job.filePath);
    }
    if (
      job.rerun &&
      !cancelled &&
      !this.destroyed &&
      this.providers.get(job.providerId) === job.record &&
      this.latest.get(this.key(job.providerId, job.filePath)) === job &&
      this.automaticAllowed(job.providerId, job.filePath)
    )
      this.run({ providerId: job.providerId, filePath: job.filePath, reason: "save" });
    this.prune();
  }

  stopJob(job) {
    if (!job || !ACTIVE_STATES.has(job.state) || job.controller.signal.aborted) return false;
    job.rerun = false;
    job.controller.abort();
    if (job.process) this.killTree(job);
    else if (!job.finishing) this.finish(job);
    this.changed(job);
    return true;
  }

  killTree(job) {
    const child = job.process;
    if (!child) return;
    if (process.platform === "win32" && child.pid) {
      const killer = childProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      killer.on("error", () => child.kill("SIGKILL"));
      killer.on("close", (code) => {
        if (code && job.process === child) child.kill("SIGKILL");
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
        job.terminationGroup = child.pid;
      } catch {
        child.kill("SIGTERM");
      }
    }
    clearTimeout(job.killTimer);
    if (job.process !== child) return;
    job.killTimer = setTimeout(() => {
      if (job.process !== child) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    }, 2000);
    job.killTimer.unref?.();
  }

  stop(request) {
    return this.stopJob(this.getJob(request));
  }
  stopAll({ providerId } = {}) {
    return this.getJobs({ providerId, activeOnly: true }).filter((job) => this.stopJob(job)).length;
  }

  getMessages({ providerId, filePath } = {}) {
    return [...this.reports.values()]
      .filter(
        ({ job }) =>
          (!providerId || job.providerId === providerId) &&
          (!filePath || canonical(job.filePath) === canonical(filePath)),
      )
      .flatMap((report) => report.messages);
  }

  clearMessages({ providerId, filePath } = {}) {
    for (const report of this.reports.values()) {
      const { job } = report;
      if (providerId && job.providerId !== providerId) continue;
      if (
        filePath &&
        canonical(job.filePath) !== canonical(this.resolve(job.providerId, filePath) || filePath)
      )
        continue;
      if (report.messages.length) {
        report.messages = [];
        if (!ACTIVE_STATES.has(job.state)) report.sources?.dispose();
        this.changed(job);
      }
    }
  }

  getArtifacts(filePath) {
    return [...this.latest.values()]
      .filter(
        (job) =>
          canonical(job.filePath) === canonical(this.resolve(job.providerId, filePath) || filePath),
      )
      .flatMap((job) => job.artifacts);
  }

  automaticAllowed(providerId, filePath) {
    const rootPath = this.resolve(providerId, filePath) || filePath;
    let hasOpenEditor = false;
    for (const editor of lumine.workspace.getTextEditors()) {
      if (editor.isDestroyed()) continue;
      const candidate = editor.getPath();
      if (
        !candidate ||
        canonical(this.resolve(providerId, candidate) || candidate) !== canonical(rootPath)
      )
        continue;
      if (editor.getGrammar() === lumine.grammars.nullGrammar) return false;
      hasOpenEditor = true;
    }
    return (
      hasOpenEditor ||
      lumine.grammars.getGrammarScore(lumine.grammars.nullGrammar, rootPath, "") <= 0
    );
  }

  setObserved({ providerId, filePath }, enabled) {
    const resolved = enabled ? this.resolve(providerId, filePath) : path.resolve(filePath);
    if (!resolved || this.destroyed || (enabled && this.disposing)) return false;
    const key = this.key(providerId, resolved);
    if (enabled === this.observed.has(key)) return false;
    if (!enabled) {
      const entry = this.observed.get(key);
      this.observed.delete(key);
      clearTimeout(entry.timer);
      entry.subscriptions.dispose();
      const job = this.getJob({ providerId, filePath: resolved });
      if (job) job.rerun = false;
    } else {
      const entry = { providerId, filePath: resolved, subscriptions: new CompositeDisposable() };
      this.observed.set(key, entry);
      try {
        this.observePaths(entry);
      } catch (error) {
        this.observed.delete(key);
        entry.subscriptions.dispose();
        throw error;
      }
    }
    this.emitter.emit("did-change-observed", { providerId, filePath: resolved, enabled });
    lumine.commands.invalidateAvailability();
    return true;
  }

  observePaths(entry) {
    const record = this.providers.get(entry.providerId);
    if (!record) return;
    const paths = new Set([
      entry.filePath,
      ...(record.provider.getWatchPaths?.(entry.filePath) || []),
    ]);
    entry.subscriptions.dispose();
    entry.subscriptions = new CompositeDisposable();
    for (const filePath of paths) {
      if (!fs.existsSync(filePath)) continue;
      const file = watchFile(filePath);
      const schedule = () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (
            this.observed.get(this.key(entry.providerId, entry.filePath)) !== entry ||
            !this.automaticAllowed(entry.providerId, entry.filePath)
          )
            return;
          this.run({ providerId: entry.providerId, filePath: entry.filePath, reason: "save" });
        }, 150);
      };
      entry.subscriptions.add(
        file,
        file.onDidChange(schedule),
        file.onDidInvalidate(schedule),
        file.onDidError((error) =>
          lumine.notifications.addError("Unable to observe build source.", {
            detail: error.message,
          }),
        ),
      );
    }
  }

  refreshObservation(providerId, filePath) {
    const entry = this.observed.get(this.key(providerId, filePath));
    if (entry) {
      try {
        this.observePaths(entry);
      } catch (error) {
        lumine.notifications.addError("Unable to refresh build sources.", {
          detail: error.message,
        });
      }
    }
  }

  getObserved({ providerId } = {}) {
    return [...this.observed.values()]
      .filter((entry) => !providerId || entry.providerId === providerId)
      .map(({ providerId, filePath }) => ({ providerId, filePath }));
  }

  clearObserved({ providerId } = {}) {
    for (const entry of [...this.observed.values()]) {
      if (providerId && entry.providerId !== providerId) continue;
      this.setObserved(entry, false);
    }
  }

  reconcileEditor(editor) {
    const filePath = editor.getPath();
    if (!filePath || editor.getGrammar() !== lumine.grammars.nullGrammar) return;
    for (const entry of this.observed.values()) {
      if (
        canonical(this.resolve(entry.providerId, filePath) || filePath) !==
        canonical(this.resolve(entry.providerId, entry.filePath) || entry.filePath)
      )
        continue;
      clearTimeout(entry.timer);
    }
    for (const job of this.getJobs({ activeOnly: true })) {
      const resolved = this.resolve(job.providerId, filePath) || filePath;
      if (canonical(resolved) === canonical(job.filePath) && this.getJob(job) === job)
        this.stopJob(job);
    }
  }

  removeLog(id) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || ACTIVE_STATES.has(job.state)) return false;
    this.jobs.splice(this.jobs.indexOf(job), 1);
    job.log.destroy();
    job.stdout = job.stderr = "";
    this.changed(job);
    return true;
  }

  prune() {
    const limit = lumine.config.get("tasks.maxHistory") || 50;
    const finished = this.jobs.filter((job) => !ACTIVE_STATES.has(job.state));
    for (const job of finished.slice(0, Math.max(0, finished.length - limit)))
      this.removeLog(job.id);
  }

  dispose() {
    if (this.destroyed || this.disposing) return;
    this.disposing = true;
    for (const report of this.reports.values()) report.sources?.dispose();
    this.reports.clear();
    this.clearArtifactTargets();
    this.clearObserved();
    this.stopAll();
    this.destroyed = true;
    for (const record of this.providers.values()) record.disposed = true;
    this.providers.clear();
    for (const job of this.jobs) job.log.destroy();
    this.jobs.length = 0;
    this.latest.clear();
    this.targets = [];
    this.emitter.dispose();
  }
}

TaskManager.ACTIVE_STATES = ACTIVE_STATES;
module.exports = TaskManager;
