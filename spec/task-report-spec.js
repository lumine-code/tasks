const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { Disposable } = require("lumine");

describe("Current task reports and execution history", () => {
  let manager, directory, source, child, provider, children, handles;
  const diagnostic = (file) => ({
    severity: "error",
    excerpt: "Compiler diagnostic",
    location: {
      file,
      position: [
        [0, 0],
        [0, 1],
      ],
    },
  });

  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "task-reports-")));
    source = path.join(directory, "source.txt");
    child = path.join(directory, "child.txt");
    fs.writeFileSync(source, "original source\n");
    fs.writeFileSync(child, "original child\n");
    children = [];
    handles = [];
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((filePath) => {
      let change, invalidate;
      const handle = {
        filePath,
        ready: Promise.resolve(),
        onDidChange: (callback) => {
          change = callback;
          return new Disposable();
        },
        onDidInvalidate: (callback) => {
          invalidate = callback;
          return new Disposable();
        },
        onDidError: () => new Disposable(),
        dispose: jasmine.createSpy("dispose"),
        change: (action) => change([{ action, path: filePath }]),
        recover: () => invalidate({ path: filePath, generation: 2 }),
      };
      handles.push(handle);
      return handle;
    });
    spyOn(childProcess, "spawn").and.callFake(() => {
      const process = new EventEmitter();
      process.stdout = new EventEmitter();
      process.stderr = new EventEmitter();
      process.kill = (signal) => queueMicrotask(() => process.emit("close", null, signal));
      children.push(process);
      return process;
    });
    manager = new (require("../lib/task-manager"))();
    provider = {
      id: "report-fixture",
      name: "Report fixture",
      supports: () => true,
      prepare: () => ({ cmd: "report-fixture", cwd: directory }),
      collectResult: () => ({ diagnostics: [diagnostic(source)] }),
    };
    manager.registerProvider(provider);
  });

  afterEach(async () => {
    const active = manager.getJobs({ activeOnly: true });
    manager.dispose();
    await Promise.all(active.map((job) => job.completion));
    const resolved = fs.realpathSync.native(directory);
    if (
      path.dirname(resolved) !== fs.realpathSync.native(os.tmpdir()) ||
      !path.basename(resolved).startsWith("task-reports-")
    )
      throw new Error("Unsafe fixture cleanup.");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function start(filePath = source) {
    const job = manager.run({ providerId: provider.id, filePath });
    await window.conditionPromise(() => job.state === "running", "the task process to start");
    return job;
  }

  async function complete(filePath = source) {
    const job = await start(filePath);
    children.at(-1).emit("close", 1, null);
    await job.completion;
    return job;
  }

  it("retires a deleted source report while retaining its job and log", async () => {
    const job = await complete();
    const historical = job.diagnostics;
    expect(manager.getMessages()).toEqual(historical);
    fs.unlinkSync(source);
    handles[0].change("deleted");
    fs.writeFileSync(source, "replacement source\n");
    expect(manager.getMessages()).toEqual([]);
    expect(manager.getJob({ providerId: provider.id, filePath: source })).toBe(job);
    expect(manager.getLogs()).toEqual([job]);
    expect(job.diagnostics).toBe(historical);
    expect(job.log.getText()).toContain("report-fixture");
    expect(job.state).toBe("failed");
    provider.collectResult = () => ({ diagnostics: [] });
    const replacement = await complete();
    expect(replacement).not.toBe(job);
    expect(manager.getMessages()).toEqual([]);
    expect(job.diagnostics).toBe(historical);
  });

  it("watches diagnostic subjects outside the canonical source", async () => {
    provider.collectResult = () => ({ diagnostics: [diagnostic(child)] });
    const job = await complete();
    fs.unlinkSync(child);
    handles.find((handle) => handle.filePath === child).change("deleted");
    expect(manager.getMessages()).toEqual([]);
    expect(job.diagnostics[0].location.file).toBe(child);
    expect(handles.every((handle) => handle.dispose.calls.count() === 1)).toBeTrue();
  });

  it("verifies known dependencies before publication even before watcher delivery", async () => {
    provider.getWatchPaths = () => [child];
    let release;
    provider.collectResult = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const job = await start();
    children[0].emit("close", 1, null);
    await window.conditionPromise(() => Boolean(release), "result collection to begin");
    fs.writeFileSync(child, "changed during compilation\n");
    release({ diagnostics: [diagnostic(child)] });
    await job.completion;
    expect(manager.getMessages()).toEqual([]);
    expect(job.diagnostics).toEqual([diagnostic(child)]);
    expect(job.state).toBe("failed");
    expect(job.log.state).toBe("failed");
  });

  it("keeps a preparation save as the compiler's initial source snapshot", async () => {
    provider.prepare = () => {
      fs.writeFileSync(source, "saved by preparation\n");
      return { cmd: "report-fixture", cwd: directory };
    };
    const job = await complete();
    expect(manager.getMessages()).toEqual(job.diagnostics);
  });

  it("clears only current messages and releases their observations", async () => {
    const job = await complete();
    const historical = job.diagnostics;
    manager.clearMessages({ providerId: provider.id, filePath: source });
    expect(manager.getMessages()).toEqual([]);
    expect(job.diagnostics).toBe(historical);
    expect(handles[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("retains a valid report after removing its log and releases it on replacement", async () => {
    const job = await complete();
    manager.removeLog(job.id);
    expect(manager.getMessages()).toEqual(job.diagnostics);
    expect(handles[0].dispose).not.toHaveBeenCalled();
    const next = await start();
    expect(handles[0].dispose).toHaveBeenCalledTimes(1);
    handles[0].change("deleted");
    children[1].emit("close", 1, null);
    await next.completion;
    expect(manager.getMessages()).toEqual(next.diagnostics);
  });
});
