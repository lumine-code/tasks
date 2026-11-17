const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

describe("Task execution actions", () => {
  let manager, provider, registration, children, spawn, reportError;
  const source = path.join(__dirname, "action.source");
  const secondSource = path.join(__dirname, "second-action.source");
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const plan = () => ({ cmd: "task-action-fixture", args: [], cwd: __dirname });
  const descriptor = (run = jasmine.createSpy("run execution action")) => ({
    id: "open-result",
    label: "Open result",
    description: "Open this execution's output.",
    run,
  });

  beforeEach(() => {
    jasmine.useRealClock();
    manager = new (require("../lib/task-manager"))();
    children = [];
    const realSpawn = childProcess.spawn.bind(childProcess);
    spawn = spyOn(childProcess, "spawn").and.callFake((command, args, options) => {
      if (command !== "task-action-fixture") return realSpawn(command, args, options);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      children.push(child);
      return child;
    });
    reportError = spyOn(lumine.notifications, "addError");
    provider = {
      id: "task-action-fixture",
      name: "Action fixture",
      supports: () => true,
      prepare: jasmine.createSpy("prepare execution").and.callFake(plan),
      collectResult: jasmine.createSpy("collect result").and.returnValue({}),
    };
    registration = manager.registerProvider(provider);
  });

  afterEach(async () => {
    manager.dispose();
    for (const child of children) child.emit("close", 0, null);
    await lumine.fileWatchClient.settlePendingTeardown();
    await tick();
  });

  function run(filePath = source) {
    return manager.run({ providerId: provider.id, filePath });
  }

  async function started(filePath = source) {
    const job = run(filePath);
    await window.conditionPromise(() => Boolean(job.process), "the action fixture to start");
    return job;
  }

  async function complete(filePath = source, { code = 0, signal = null } = {}) {
    const job = await started(filePath);
    job.process.emit("close", code, signal);
    await job.completion;
    return job;
  }

  it("exposes detached metadata without exposing callbacks or performing work during queries", async () => {
    const action = descriptor();
    provider.collectResult.and.returnValue({ actions: [action] });
    const job = await complete();
    const metadata = manager.getActions(job);
    expect(metadata).toEqual([
      {
        id: "open-result",
        label: "Open result",
        description: "Open this execution's output.",
      },
    ]);
    expect(job.actions).toBeUndefined();
    expect(metadata[0].run).toBeUndefined();
    metadata[0].label = "Consumer replacement";
    metadata.push({ id: "injected", label: "Injected action" });
    expect(manager.getActions(job)).toEqual([
      {
        id: "open-result",
        label: "Open result",
        description: "Open this execution's output.",
      },
    ]);
    expect(provider.prepare).toHaveBeenCalledTimes(1);
    expect(provider.collectResult).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(action.run).not.toHaveBeenCalled();
  });

  const invalidActions = [
    ["a non-array action list", () => ({ id: "open-result" })],
    ["an empty descriptor", () => [null]],
    ["a sparse action list", () => new Array(1)],
    ["a missing action id", () => [{ ...descriptor(), id: undefined }]],
    ["an empty action id", () => [{ ...descriptor(), id: "" }]],
    ["an empty label", () => [{ ...descriptor(), label: "" }]],
    ["a non-string description", () => [{ ...descriptor(), description: 123 }]],
    ["a missing callback", () => [{ ...descriptor(), run: undefined }]],
    ["duplicate action ids", () => [descriptor(), descriptor()]],
  ];
  for (const [name, actions] of invalidActions) {
    it(`rejects ${name} without publishing a partial action list`, async () => {
      provider.collectResult.and.callFake(() => ({ actions: actions() }));
      const job = await complete();
      expect(job.state).toBe("failed");
      expect(job.error).toEqual(jasmine.any(Error));
      expect(job.error.message).toMatch(/action/i);
      expect(manager.getActions(job)).toEqual([]);
      expect(await manager.runAction(job, "open-result")).toBeFalse();
    });
  }

  it("does not expose or dispatch actions until execution and result collection finish", async () => {
    let releasePreparation, releaseCollection;
    const action = descriptor();
    provider.prepare.and.callFake(() => new Promise((resolve) => (releasePreparation = resolve)));
    provider.collectResult.and.callFake(
      () => new Promise((resolve) => (releaseCollection = resolve)),
    );
    const job = run();
    expect(job.state).toBe("preparing");
    expect(manager.getActions(job)).toEqual([]);
    expect(await manager.runAction(job, action.id)).toBeFalse();
    await tick();
    releasePreparation(plan());
    await window.conditionPromise(() => Boolean(job.process), "preparation to complete");
    expect(job.state).toBe("running");
    expect(manager.getActions(job)).toEqual([]);
    expect(await manager.runAction(job, action.id)).toBeFalse();
    job.process.emit("close", 0, null);
    await window.conditionPromise(() => Boolean(releaseCollection), "collection to wait");
    expect(job.state).toBe("collecting");
    expect(manager.getActions(job)).toEqual([]);
    expect(await manager.runAction(job, action.id)).toBeFalse();
    releaseCollection({ actions: [action] });
    await job.completion;
    expect(await manager.runAction(job, action.id)).toBeTrue();
    expect(action.run).toHaveBeenCalledTimes(1);
  });

  it("runs the retained historical execution's action after a newer execution replaces the latest result", async () => {
    const received = [];
    provider.collectResult.and.callFake(({ job }) => ({
      actions: [descriptor((selected) => received.push([job, selected]))],
    }));
    const first = await complete();
    const second = await complete();
    expect(manager.getJob({ providerId: provider.id, filePath: source })).toBe(second);
    expect(await manager.runAction(first, "open-result")).toBeTrue();
    expect(await manager.runAction(second, "open-result")).toBeTrue();
    expect(received).toEqual([
      [first, first],
      [second, second],
    ]);
    expect(manager.getJobs()).toEqual([first, second]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("rejects a copied job or unknown action instead of resolving another execution by id", async () => {
    const action = descriptor();
    provider.collectResult.and.returnValue({ actions: [action] });
    const job = await complete();
    const copy = { ...job };
    expect(manager.getActions(copy)).toEqual([]);
    expect(await manager.runAction(copy, action.id)).toBeFalse();
    expect(await manager.runAction(job, "unknown-action")).toBeFalse();
    expect(action.run).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not revive old actions when a replacement provider reuses the same id", async () => {
    const oldAction = descriptor();
    provider.collectResult.and.returnValue({ actions: [oldAction] });
    const previous = await complete();
    registration.dispose();
    const replacementAction = descriptor();
    registration = manager.registerProvider({
      ...provider,
      collectResult: () => ({ actions: [replacementAction] }),
    });
    const current = await complete();

    expect(manager.getJobs()).toContain(previous);
    expect(manager.getActions(previous)).toEqual([]);
    expect(await manager.runAction(previous, oldAction.id)).toBeFalse();
    expect(oldAction.run).not.toHaveBeenCalled();
    expect(replacementAction.run).not.toHaveBeenCalled();
    expect(await manager.runAction(current, replacementAction.id)).toBeTrue();
    expect(replacementAction.run).toHaveBeenCalledTimes(1);
  });

  it("preserves a replacement provider's work when an abort listener registers it during unregistration", async () => {
    let replacementJob,
      listening = false;
    const diagnostic = {
      severity: "warning",
      excerpt: "Replacement report",
      location: {
        file: source,
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    const replacement = {
      ...provider,
      name: "Replacement provider",
      collectResult: () => ({ diagnostics: [diagnostic] }),
    };
    const action = descriptor((_job, signal) => {
      signal.addEventListener("abort", () => {
        registration = manager.registerProvider(replacement);
        replacementJob = run();
      });
      listening = true;
      return new Promise(() => {});
    });
    provider.collectResult.and.returnValue({ actions: [action] });
    const previous = await complete();
    const pending = manager.runAction(previous, action.id);
    await window.conditionPromise(() => listening, "the action's abort listener to attach");

    registration.dispose();

    expect(replacementJob).toBeDefined();
    expect(replacementJob.state).toBe("preparing");
    expect(await pending).toBeFalse();
    await window.conditionPromise(
      () => Boolean(replacementJob.process || replacementJob.finishedAt),
      "the replacement execution to start or finish",
    );
    expect(replacementJob.state).toBe("running");
    replacementJob.process?.emit("close", 0, null);
    await replacementJob.completion;
    expect(replacementJob.state).toBe("passed");
    expect(manager.providers.get(provider.id).provider).toBe(replacement);
    expect(manager.getMessages()).toEqual([diagnostic]);
    expect(manager.getActions(previous)).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("invokes one pending action once when both presentation surfaces request it", async () => {
    let release;
    const callback = jasmine
      .createSpy("open result")
      .and.callFake(() => new Promise((resolve) => (release = resolve)));
    const action = descriptor(callback);
    provider.collectResult.and.returnValue({ actions: [action] });
    const job = await complete();
    const pending = manager.runAction(job, action.id);
    await window.conditionPromise(() => Boolean(release), "the first action invocation to wait");

    expect(await manager.runAction(job, action.id)).toBeFalse();
    expect(callback).toHaveBeenCalledTimes(1);
    release();
    expect(await pending).toBeTrue();
    callback.and.returnValue(undefined);
    expect(await manager.runAction(job, action.id)).toBeTrue();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("allows an unavailable handler to return false without reporting an error or consuming its action", async () => {
    const callback = jasmine.createSpy("open result").and.returnValues(false, true);
    const action = descriptor(callback);
    provider.collectResult.and.returnValue({ actions: [action] });
    const job = await complete();

    expect(await manager.runAction(job, action.id)).toBeFalse();
    expect(manager.getActions(job).map((metadata) => metadata.id)).toEqual([action.id]);
    expect(await manager.runAction(job, action.id)).toBeTrue();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(job.state).toBe("passed");
    expect(reportError).not.toHaveBeenCalled();
  });

  for (const retirement of ["log removal", "history pruning", "provider retirement", "disposal"]) {
    it(`aborts pending actions on ${retirement} and ignores a later handler rejection`, async () => {
      let reject, actionSignal;
      const action = descriptor((_job, signal) => {
        actionSignal = signal;
        return new Promise((_resolve, fail) => (reject = fail));
      });
      provider.collectResult.and.returnValue({ actions: [action] });
      const job = await complete();
      const pending = manager.runAction(job, action.id);
      await window.conditionPromise(() => Boolean(actionSignal), "the action callback to start");
      expect(actionSignal.aborted).toBeFalse();

      if (retirement === "log removal") expect(manager.removeLog(job.id)).toBeTrue();
      else if (retirement === "history pruning") {
        lumine.config.set("tasks.maxHistory", 1);
        await complete(secondSource);
      } else if (retirement === "provider retirement") registration.dispose();
      else manager.dispose();

      expect(actionSignal.aborted).toBeTrue();
      expect(await pending).toBeFalse();
      expect(manager.getActions(job)).toEqual([]);
      expect(await manager.runAction(job, action.id)).toBeFalse();
      reject(new Error("Retired action failed later"));
      await tick();
      expect(reportError).not.toHaveBeenCalled();
    });
  }

  it("reports synchronous and asynchronous action failures without changing the completed job", async () => {
    const synchronous = {
      ...descriptor(() => {
        throw new Error("Synchronous output failure");
      }),
      id: "sync-failure",
    };
    const asynchronous = {
      ...descriptor(() => Promise.reject(new Error("Asynchronous output failure"))),
      id: "async-failure",
    };
    provider.collectResult.and.returnValue({ actions: [synchronous, asynchronous] });
    const job = await complete();
    const text = job.log.getText();

    expect(await manager.runAction(job, synchronous.id)).toBeFalse();
    expect(await manager.runAction(job, asynchronous.id)).toBeFalse();

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError.calls.argsFor(0)[1].detail).toContain("Synchronous output failure");
    expect(reportError.calls.argsFor(1)[1].detail).toContain("Asynchronous output failure");
    expect(job.state).toBe("passed");
    expect(job.error).toBeNull();
    expect(job.log.getText()).toBe(text);
    expect(manager.getJobs()).toEqual([job]);
  });

  it("reports a null throw as an action failure instead of rejecting the dispatch promise", async () => {
    const action = descriptor(() => {
      throw null;
    });
    provider.collectResult.and.returnValue({ actions: [action] });
    const job = await complete();

    expect(await manager.runAction(job, action.id)).toBeFalse();

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.calls.mostRecent().args[1].detail).toBe("null");
    expect(job.state).toBe("passed");
    expect(job.error).toBeNull();
  });

  it("allows a collected cancelled result action with a signal separate from process execution", async () => {
    const action = descriptor();
    provider.collectResult.and.returnValue({ actions: [action] });
    const job = await complete(source, { code: null, signal: "SIGTERM" });
    expect(job.state).toBe("cancelled");

    expect(await manager.runAction(job, action.id)).toBeTrue();

    expect(action.run).toHaveBeenCalledTimes(1);
    const [selected, signal] = action.run.calls.mostRecent().args;
    expect(selected).toBe(job);
    expect(signal).not.toBe(job.controller.signal);
    expect(signal.aborted).toBeFalse();
    expect(reportError).not.toHaveBeenCalled();
  });
});
