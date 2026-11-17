const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { Disposable } = require("lumine");

describe("Settled task source observation", () => {
  let manager, directory, source, dependency, pdf, provider, handles, children, errors, readiness;
  const pause = (milliseconds = 350) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const key = (filePath) => {
    const absolute = path.resolve(filePath);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };

  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "task-observation-")));
    source = path.join(directory, "document.tex");
    dependency = path.join(directory, "chapter.tex");
    pdf = path.join(directory, "generated.pdf");
    fs.writeFileSync(source, "original source\n");
    fs.writeFileSync(dependency, "original chapter\n");
    fs.writeFileSync(pdf, "original generated output\n");
    handles = [];
    children = [];
    readiness = Promise.resolve();
    errors = spyOn(lumine.notifications, "addError");
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((filePath) => {
      const events = new EventEmitter();
      let disposed = false;
      const subscribe = (type, callback) => {
        events.on(type, callback);
        return new Disposable(() => events.off(type, callback));
      };
      const handle = {
        path: filePath,
        ready: readiness,
        closed: Promise.resolve(),
        onDidChange: (callback) => subscribe("change", callback),
        onDidInvalidate: (callback) => subscribe("invalidate", callback),
        onDidError: (callback) => subscribe("error", callback),
        dispose: () => {
          disposed = true;
          events.removeAllListeners();
        },
        change: (action = "updated") => {
          if (!disposed) events.emit("change", [{ action, path: filePath }]);
        },
        recover: () => {
          if (!disposed) events.emit("invalidate", { path: filePath, generation: 2 });
        },
        get disposed() {
          return disposed;
        },
      };
      handles.push(handle);
      return handle;
    });
    const realSpawn = childProcess.spawn.bind(childProcess);
    spyOn(childProcess, "spawn").and.callFake((command, args, options) => {
      if (command !== "observation-fixture") return realSpawn(command, args, options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => {
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      children.push(child);
      return child;
    });
    manager = new (require("../lib/task-manager"))();
    spyOn(manager, "automaticAllowed").and.returnValue(true);
    provider = {
      id: "observation-fixture",
      name: "Observation fixture",
      supports: () => true,
      prepare: () => ({ cmd: "observation-fixture", args: [], cwd: directory }),
      collectResult: () => ({}),
    };
    manager.registerProvider(provider);
  });

  afterEach(async () => {
    manager.dispose();
    for (const child of children) child.emit("close", 0, null);
    await pause(0);
    const owned = fs.realpathSync.native(directory);
    if (
      path.dirname(owned) !== fs.realpathSync.native(os.tmpdir()) ||
      !path.basename(owned).startsWith("task-observation-")
    )
      throw new Error("Unsafe task-observation fixture cleanup.");
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function hint(filePath = source, action = "updated") {
    for (const handle of [...handles])
      if (key(handle.path) === key(filePath)) handle.change(action);
  }

  function write(filePath, contents, action = "updated") {
    fs.writeFileSync(filePath, contents);
    hint(filePath, action);
  }

  async function observe() {
    expect(manager.setObserved({ providerId: provider.id, filePath: source }, true)).toBeTrue();
    const entry = manager.observed.get(manager.key(provider.id, source));
    await entry.observation.ready;
    await entry.observation.acknowledge();
    return entry;
  }

  async function nextExecution(count = 1) {
    await window.conditionPromise(
      () => children.length === count,
      "an observed execution to start",
    );
    const job = manager.getJobs().at(-1);
    expect(job.reason).toBe("save");
    expect(job.state).toBe("running");
    return job;
  }

  async function finish(job) {
    job.process.emit("close", 0, null);
    await job.completion;
  }

  async function changedExecution() {
    write(source, "first revision\n");
    return nextExecution();
  }

  function rewrite(change, contents) {
    if (change === "same-byte save") fs.writeFileSync(source, contents);
    else if (change === "timestamp touch") {
      const stat = fs.statSync(source);
      fs.utimesSync(source, stat.atime, new Date(stat.mtimeMs + 2000));
    } else {
      const replacement = path.join(directory, "replacement.tex");
      fs.writeFileSync(replacement, contents);
      fs.renameSync(replacement, source);
    }
    hint();
  }

  for (const change of ["same-byte save", "timestamp touch", "atomic replacement"]) {
    for (const running of [false, true]) {
      it(`runs once for a ${change} ${running ? "after the current execution" : "while idle"}`, async () => {
        await observe();
        const first = running ? await changedExecution() : null;
        rewrite(change, running ? "first revision\n" : "original source\n");
        if (first) {
          await pause(250);
          expect(children.length).toBe(1);
          await finish(first);
        }
        const next = await nextExecution(running ? 2 : 1);
        hint();
        await pause(200);
        await finish(next);
        await pause();
        expect(children.length).toBe(running ? 2 : 1);
        expect(manager.getJobs()).toEqual(first ? [first, next] : [next]);
        expect(errors).not.toHaveBeenCalled();
      });
    }
  }

  for (const recovery of [false, true]) {
    it(`ignores ${recovery ? "watcher recovery" : "reads and duplicate or delayed hints"} without a new source revision`, async () => {
      await observe();
      const job = await changedExecution();
      if (recovery) handles.find((handle) => key(handle.path) === key(source)).recover();
      else {
        fs.readFileSync(source, "utf8");
        hint();
      }
      await pause(200);
      hint();
      await pause(200);
      await finish(job);
      await pause();
      expect(children.length).toBe(1);
      expect(manager.getJobs()).toEqual([job]);
      expect(errors).not.toHaveBeenCalled();
    });
  }

  for (const transient of ["missing", "empty", "partial"]) {
    for (const completesDuringSave of [false, true]) {
      it(`coalesces a transient ${transient} write burst with identical final bytes ${completesDuringSave ? "across completion" : "during execution"}`, async () => {
        await observe();
        const job = await changedExecution();
        if (transient === "missing") fs.unlinkSync(source);
        else fs.writeFileSync(source, transient === "empty" ? "" : "first");
        hint();
        await pause(40);
        const completion = completesDuringSave ? finish(job) : null;
        if (completesDuringSave) await pause(40);
        write(source, "first revision\n", transient === "missing" ? "created" : "updated");
        if (completion) await completion;
        else {
          await pause(250);
          await finish(job);
        }
        expect(fs.readFileSync(source, "utf8")).toBe("first revision\n");
        const next = await nextExecution(2);
        hint();
        await finish(next);
        await pause();
        expect(children.length).toBe(2);
        expect(manager.getJobs()).toEqual([job, next]);
        expect(errors).not.toHaveBeenCalled();
      });
    }
  }

  it("runs exactly once more for real edits received while the current execution is running", async () => {
    await observe();
    const first = await changedExecution();
    write(source, "second revision\n");
    write(source, "third revision\n");
    await pause(250);
    expect(children.length).toBe(1);
    await finish(first);
    const second = await nextExecution(2);
    hint();
    await pause(200);
    await finish(second);
    await pause();
    expect(children.length).toBe(2);
    expect(manager.getJobs()).toEqual([first, second]);
  });

  it("retains a settled write during execution when the source returns to its previous contents", async () => {
    const entry = await observe();
    const first = await changedExecution();
    write(source, "transient changed revision\n");
    await pause(200);
    expect(await entry.observation.hasChanges()).toBeTrue();
    write(source, "first revision\n");
    await pause(200);
    expect(children.length).toBe(1);
    await finish(first);
    const second = await nextExecution(2);
    await finish(second);
    await pause();
    expect(children.length).toBe(2);
    expect(manager.getJobs()).toEqual([first, second]);
  });

  for (const running of [false, true]) {
    it(`optionally ignores a same-byte save ${running ? "during execution" : "while idle"} while accepting content edits`, async () => {
      provider.observationMode = "content";
      await observe();
      const first = running ? await changedExecution() : null;
      write(source, running ? "first revision\n" : "original source\n");
      await pause(250);
      if (first) await finish(first);
      await pause();
      expect(children.length).toBe(running ? 1 : 0);
      write(source, "new content in optional content mode\n");
      const next = await nextExecution(running ? 2 : 1);
      await finish(next);
      await pause();
      expect(manager.getJobs()).toEqual(first ? [first, next] : [next]);
    });
  }

  it("keeps per-task modes independent and resets only an explicitly changed task", async () => {
    provider.observationMode = "content";
    await observe();
    const request = { providerId: provider.id, filePath: dependency };
    expect(manager.setObserved({ ...request, observationMode: "write" }, true)).toBeTrue();
    let entry = manager.observed.get(manager.key(provider.id, dependency));
    await entry.observation.ready;
    await entry.observation.acknowledge();
    expect(manager.setObserved(request, true)).toBeFalse();
    write(source, "original source\n");
    write(dependency, "original chapter\n");
    const first = await nextExecution();
    expect(first.filePath).toBe(dependency);
    await finish(first);
    await pause();
    expect(children.length).toBe(1);
    expect(manager.setObserved({ ...request, observationMode: "content" }, true)).toBeTrue();
    entry = manager.observed.get(manager.key(provider.id, dependency));
    await entry.observation.ready;
    write(dependency, "original chapter\n");
    await pause();
    expect(children.length).toBe(1);
    write(source, "a real change in the other task\n");
    const second = await nextExecution(2);
    expect(second.filePath).toBe(source);
    await finish(second);
    await pause();
    expect(manager.getJobs()).toEqual([first, second]);
  });

  it("consumes a preparation save before spawning even when its hint arrives afterwards", async () => {
    let release;
    provider.prepare = () =>
      new Promise((resolve) => {
        release = () => {
          fs.writeFileSync(source, "saved during preparation\n");
          resolve({ cmd: "observation-fixture", args: [], cwd: directory });
        };
      });
    await observe();
    write(source, "edited before preparation\n");
    await window.conditionPromise(() => Boolean(release), "provider preparation to wait");
    release();
    const job = await nextExecution();
    hint();
    await pause(200);
    await finish(job);
    await pause();
    expect(children.length).toBe(1);
    expect(manager.getJobs()).toEqual([job]);
  });

  for (const changed of [false, true]) {
    it(`${changed ? "keeps a real edit" : "ignores an unchanged hint"} pending across execution completion`, async () => {
      await observe();
      const first = await changedExecution();
      if (changed) fs.writeFileSync(source, "changed immediately before close\n");
      hint();
      await finish(first);
      if (changed) {
        const second = await nextExecution(2);
        await finish(second);
      }
      await pause();
      expect(children.length).toBe(changed ? 2 : 1);
      expect(manager.getJobs().length).toBe(changed ? 2 : 1);
    });
  }

  it("starts from a missing observed source when it is created", async () => {
    fs.unlinkSync(source);
    await observe();
    expect(handles.some((handle) => key(handle.path) === key(source))).toBeTrue();
    write(source, "created source\n", "created");
    const job = await nextExecution();
    await finish(job);
    await pause();
    expect(children.length).toBe(1);
  });

  it("re-enables observation with a fresh baseline instead of replaying disabled changes", async () => {
    await observe();
    write(source, "pending disabled revision\n");
    expect(manager.setObserved({ providerId: provider.id, filePath: source }, false)).toBeTrue();
    await pause();
    expect(children.length).toBe(0);
    write(source, "changed while disabled\n");
    await observe();
    await pause(200);
    expect(children.length).toBe(0);
    const job = await changedExecution();
    await finish(job);
    await pause();
    expect(children.length).toBe(1);
  });

  it("disabling observation drops queued edits without stopping the current execution", async () => {
    await observe();
    const job = await changedExecution();
    write(source, "queued revision\n");
    await pause(200);
    manager.setObserved({ providerId: provider.id, filePath: source }, false);
    expect(job.state).toBe("running");
    await finish(job);
    await pause();
    expect(job.state).toBe("passed");
    expect(children.length).toBe(1);
  });

  it("does not retry a stopped execution for already-observed edits but accepts a later change", async () => {
    const entry = await observe();
    const stopped = await changedExecution();
    write(source, "changed before stopping\n");
    expect(await entry.observation.hasChanges()).toBeTrue();
    await pause(200);

    stopped.stop();
    await stopped.completion;
    await pause();

    expect(stopped.state).toBe("cancelled");
    expect(children.length).toBe(1);
    expect(manager.getJobs()).toEqual([stopped]);
    hint();
    await pause(200);
    expect(children.length).toBe(1);
    write(source, "a new change after stopping\n");
    const next = await nextExecution(2);
    await finish(next);
    await pause();
    expect(children.length).toBe(2);
    expect(manager.getJobs()).toEqual([stopped, next]);
  });

  it("accepts a new source save immediately after an execution is stopped", async () => {
    await observe();
    const stopped = await changedExecution();
    write(source, "changed before stopping\n");
    await pause(200);
    stopped.stop();
    write(source, "a new change immediately after stopping\n");
    await stopped.completion;
    await pause();
    expect(children.length).toBe(2);
    if (children.length !== 2) return;
    const next = manager.getJobs().at(-1);
    expect(next.reason).toBe("save");
    await finish(next);
    await pause();
    expect(stopped.state).toBe("cancelled");
    expect(manager.getJobs()).toEqual([stopped, next]);
  });

  for (const savesAfterStop of [false, true]) {
    it(`${savesAfterStop ? "accepts a new save" : "does not replay an old save"} when a stopped source watcher becomes ready`, async () => {
      let arm, readFinished;
      readiness = new Promise((resolve) => {
        arm = resolve;
      });
      const initialRead = new Promise((resolve) => {
        readFinished = resolve;
      });
      const stat = fs.promises.stat.bind(fs.promises);
      let captured = false;
      spyOn(fs.promises, "stat").and.callFake(async (...args) => {
        const revision = await stat(...args);
        if (!captured && key(args[0]) === key(source)) {
          captured = true;
          readFinished();
        }
        return revision;
      });
      manager.setObserved({ providerId: provider.id, filePath: source }, true);
      const stopped = manager.run({ providerId: provider.id, filePath: source });
      await initialRead;
      expect(stopped.state).toBe("preparing");
      write(source, "changed while watcher was arming\n");
      stopped.stop();
      if (savesAfterStop) write(source, "a new change after stopping during startup\n");
      arm();
      await stopped.completion;
      await pause();
      expect(stopped.state).toBe("cancelled");
      expect(children.length).toBe(savesAfterStop ? 1 : 0);
      if (savesAfterStop && children.length === 1) {
        const next = manager.getJobs().at(-1);
        expect(next.reason).toBe("save");
        await finish(next);
        await pause();
        expect(manager.getJobs()).toEqual([stopped, next]);
      } else expect(manager.getJobs()).toEqual([stopped]);
      expect(errors).not.toHaveBeenCalled();
    });
  }

  it("ignores queued and retained watcher callbacks after disposal", async () => {
    await observe();
    write(source, "pending revision\n");
    manager.dispose();
    hint();
    await pause();
    expect(children.length).toBe(0);
    expect(handles.every((handle) => handle.disposed)).toBeTrue();
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps diagnostic dependencies out of automatic source triggers", async () => {
    provider.getDiagnosticPaths = () => [dependency];
    await observe();
    expect(handles.some((handle) => key(handle.path) === key(dependency))).toBeFalse();
    write(dependency, "changed chapter\n");
    await pause();
    expect(children.length).toBe(0);
  });

  it("reports automatic request failures without losing the pending source change", async () => {
    await observe();
    manager.automaticAllowed.and.throwError("Source lookup failed");
    write(source, "a pending source revision\n");
    await pause();
    expect(children.length).toBe(0);
    expect(errors).toHaveBeenCalledWith("Unable to check observed task source.", {
      detail: "Source lookup failed",
    });
    manager.automaticAllowed.and.returnValue(true);
    hint();
    const job = await nextExecution();
    await finish(job);
    await pause();
    expect(children.length).toBe(1);
  });

  it("observes only the canonical source while tracking chapter and PDF diagnostic inputs", async () => {
    provider.getDiagnosticPaths = () => [dependency, pdf];
    await observe();
    expect(handles.some((handle) => key(handle.path) === key(dependency))).toBeFalse();
    expect(handles.some((handle) => key(handle.path) === key(pdf))).toBeFalse();
    write(dependency, "changed chapter\n");
    await pause(200);
    expect(children.length).toBe(0);
    const job = await changedExecution();
    expect(handles.some((handle) => key(handle.path) === key(dependency))).toBeTrue();
    expect(handles.some((handle) => key(handle.path) === key(pdf))).toBeTrue();
    write(dependency, "chapter updated during compilation\n");
    write(pdf, "regenerated PDF input\n");
    await pause(200);
    await finish(job);
    await pause();
    expect(children.length).toBe(1);
    expect(manager.getJobs()).toEqual([job]);
  });
});
