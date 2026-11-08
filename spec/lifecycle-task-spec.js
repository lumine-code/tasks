const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

describe("Tasks task generation and shutdown", () => {
  let manager, provider, registration, children, spawn;
  const source = path.join(__dirname, "lifecycle.source");
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    jasmine.useRealClock();
    manager = new (require("../lib/task-manager"))();
    children = [];
    spawn = spyOn(childProcess, "spawn").and.callFake(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = jasmine.createSpy("request termination").and.returnValue(true);
      children.push(child);
      return child;
    });
    provider = {
      id: "lifecycle",
      name: "Lifecycle",
      supports: () => true,
      prepare: () => ({ cmd: "fixture", args: [], cwd: __dirname }),
      collectResult: () => ({ diagnostics: [] }),
    };
    registration = manager.registerProvider(provider);
  });

  afterEach(async () => {
    manager.dispose();
    for (const child of children) {
      child.emit("close", null, "SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
    }
    await tick();
  });

  const run = () => manager.run({ providerId: "lifecycle", filePath: source });

  it("starts a replacement provider while the previous generation is still terminating", async () => {
    const old = run();
    await tick();
    registration.dispose();
    const newer = manager.registerProvider({ ...provider, name: "New generation" });
    const current = run();
    expect(current).not.toBe(old);
    expect(current.name).toBe("New generation");
    await tick();
    expect(children.length).toBe(2);
    children[0].emit("close", 1, null);
    await old.completion;
    expect(old.state).toBe("cancelled");
    expect(manager.getJob({ providerId: "lifecycle", filePath: source })).toBe(current);
    expect(current.state).toBe("running");
    children[1].emit("close", 0, null);
    await current.completion;
    expect(current.state).toBe("passed");
    newer.dispose();
  });

  it("starts a new manual request after cancellation before the old transport closes", async () => {
    const old = run();
    await tick();
    old.stop();
    const next = run();
    expect(next).not.toBe(old);
    await tick();
    expect(children.length).toBe(2);
    children[0].emit("close", null, "SIGTERM");
    children[1].emit("close", 0, null);
    await Promise.all([old.completion, next.completion]);
    expect(next.state).toBe("passed");
  });

  it("declines callback-created jobs and providers while disposal settles accepted work", async () => {
    let attempted = "not called";
    let replacement;
    manager.onDidFinishJob(() => {
      attempted = run();
      replacement = manager.registerProvider({ ...provider, id: "replacement" });
    });
    const job = run();
    manager.dispose();
    await job.completion;
    await tick();
    expect(attempted).toBeNull();
    expect(manager.getJobs()).toEqual([]);
    expect(manager.providers.size).toBe(0);
    expect(job.state).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
    replacement.dispose();
  });

  it("does not add a queued save to a newer job accepted by a terminal listener", async () => {
    const first = run();
    await tick();
    manager.run({ providerId: "lifecycle", filePath: source, reason: "save" });
    let next;
    const lease = manager.onDidFinishJob((job) => {
      if (job === first) next = run();
    });
    children[0].emit("close", 0, null);
    await first.completion;
    await tick();
    expect(next).not.toBe(first);
    children[1].emit("close", 0, null);
    await next.completion;
    await tick();
    expect(children.length).toBe(2);
    lease.dispose();
  });

  it("does not let observation callbacks reopen watchers during disposal", () => {
    const request = { providerId: "lifecycle", filePath: source };
    expect(manager.setObserved(request, true)).toBeTrue();
    let attempted;
    manager.onDidChangeObserved(({ enabled }) => {
      if (!enabled) attempted = manager.setObserved(request, true);
    });
    manager.dispose();
    expect(attempted).toBeFalse();
    expect(manager.getObserved()).toEqual([]);
  });

  it("kills a POSIX descendant that ignores SIGTERM after its compiler parent exits", async () => {
    if (process.platform === "win32") {
      pending("POSIX process groups are exercised on Linux and macOS.");
      return;
    }
    spawn.and.callThrough();
    const descendantSource = [
      "process.on('SIGTERM',()=>{});",
      "process.stdout.write('ready\\n');",
      "setInterval(()=>{},1000);",
    ].join("\n");
    provider.prepare = () => ({
      cmd: "node",
      args: [
        "-e",
        [
          "const cp = require('node:child_process');",
          `const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {stdio:['ignore','pipe','ignore']});`,
          "child.stdout.once('data',()=>{console.log(child.pid);child.stdout.destroy()});",
          "setInterval(()=>{},1000)",
        ].join(""),
      ],
    });
    const job = run();
    let descendant;
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await window.conditionPromise(
        () => /^\d+\r?\n/.test(job.stdout),
        "compiler descendant ready",
      );
      descendant = Number.parseInt(job.stdout, 10);
      expect(alive(descendant)).toBeTrue();
      job.stop();
      await job.completion;
      await window.conditionPromise(() => !alive(descendant), "SIGTERM-resistant descendant exit");
      expect(job.state).toBe("cancelled");
    } finally {
      job.stop();
      if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
    }
  });
});
