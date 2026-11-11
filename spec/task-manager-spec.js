const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

describe("Shared build tasks", () => {
  let manager, children, spawn, provider, registration;
  const source = path.join(__dirname, "first.source");
  const second = path.join(__dirname, "second.source");
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  function transport() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jasmine.createSpy("kill").and.callFake((signal) => {
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    });
    children.push(child);
    return child;
  }
  beforeEach(() => {
    jasmine.useRealClock();
    manager = new (require("../lib/task-manager"))();
    children = [];
    spawn = spyOn(childProcess, "spawn").and.callFake(transport);
    provider = {
      id: "fixture",
      name: "Fixture",
      supports: () => true,
      prepare: ({ filePath }) => ({
        cmd: "fixture",
        args: [filePath],
        cwd: __dirname,
        artifacts: [{ path: filePath + ".pdf", kind: "pdf" }],
      }),
      collectResult: () => ({ diagnostics: [], artifacts: [] }),
    };
    registration = manager.registerProvider(provider);
  });
  afterEach(async () => {
    manager.dispose();
    await lumine.fileWatchClient.settlePendingTeardown();
    await tick();
  });
  function run(filePath = source, reason = "manual") {
    return manager.run({ providerId: "fixture", filePath, reason });
  }
  async function started(filePath = source) {
    const job = run(filePath);
    await window.conditionPromise(() => Boolean(job.process), "the task fixture to start");
    expect(job.state).toBe("running");
    return job;
  }

  it("declares artifacts before spawning and completes after output closes", async () => {
    const start = manager.onDidStartJob((job) => {
      expect(spawn).not.toHaveBeenCalled();
      expect(job.artifacts[0].path).toBe(source + ".pdf");
    });
    const job = await started();
    children[0].stdout.write(Buffer.from("actual output"));
    children[0].emit("exit", 0, null);
    expect(job.state).toBe("running");
    children[0].emit("close", 0, null);
    expect(await job.completion).toBe(job);
    expect(job.state).toBe("passed");
    expect(job.stdout).toBe("actual output");
    expect(job.log.getText()).toContain("actual output");
    expect(manager.getLogs()).toEqual([job]);
    start.dispose();
  });

  it("runs independent documents concurrently and deduplicates one document", async () => {
    const first = await started();
    expect(run()).toBe(first);
    const other = await started(second);
    expect(manager.getJobs({ activeOnly: true })).toEqual([first, other]);
    children[0].emit("close", 1, null);
    children[1].emit("close", 0, null);
    await Promise.all([first.completion, other.completion]);
    expect(first.state).toBe("failed");
    expect(other.state).toBe("passed");
  });

  it("canonicalizes roots before deduplicating child documents", async () => {
    provider.resolve = () => source;
    const job = await started();
    expect(run(second)).toBe(job);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retains separate stderr and decodes split UTF-8 bytes", async () => {
    const job = await started();
    const bytes = Buffer.from("żółć ┌─");
    for (const byte of bytes) children[0].stderr.write(Buffer.from([byte]));
    children[0].emit("close", 0, null);
    await job.completion;
    expect(job.stderr).toBe("żółć ┌─");
    expect(job.stdout).toBe("");
  });

  it("keeps diagnostics of other documents when one task starts again", async () => {
    provider.collectResult = ({ filePath }) => ({
      diagnostics: [
        {
          severity: "error",
          excerpt: filePath,
          location: {
            file: filePath,
            position: [
              [0, 0],
              [0, 1],
            ],
          },
        },
      ],
    });
    const first = await started();
    children[0].emit("close", 0, null);
    await first.completion;
    const other = await started(second);
    children[1].emit("close", 0, null);
    await other.completion;
    expect(manager.getMessages().length).toBe(2);
    run();
    expect(manager.getMessages().map((message) => message.excerpt)).toEqual([second]);
  });

  it("reports preparation failures as finished logs without launching", async () => {
    provider.prepare = () => {
      throw new Error("No compiler");
    };
    const job = run();
    await job.completion;
    expect(job.state).toBe("failed");
    expect(job.log.getText()).toContain("No compiler");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("settles cancellation while preparation ignores the abort signal", async () => {
    let release;
    provider.prepare = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const job = run();
    await tick();
    expect(job.stop()).toBeTrue();
    await job.completion;
    expect(job.state).toBe("cancelled");
    release({ cmd: "late compiler" });
    await tick();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("settles cancellation while result collection ignores the abort signal", async () => {
    let release;
    provider.collectResult = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const job = await started();
    children[0].emit("close", 0, null);
    await tick();
    expect(job.state).toBe("collecting");
    job.stop();
    await job.completion;
    release({ diagnostics: [{ excerpt: "stale" }] });
    await tick();
    expect(job.state).toBe("cancelled");
    expect(job.diagnostics).toEqual([]);
  });

  it("cancels a reentrant start before it can acquire a process", async () => {
    manager.onDidStartJob(() => registration.dispose());
    const job = run();
    await job.completion;
    expect(job.state).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("removes only the disposed provider's jobs and diagnostics", async () => {
    const secondRegistration = manager.registerProvider({ ...provider, id: "other" });
    const job = await started();
    const other = manager.run({ providerId: "other", filePath: second });
    await window.conditionPromise(() => Boolean(other.process), "the other provider to start");
    registration.dispose();
    await job.completion;
    expect(job.state).toBe("cancelled");
    expect(other.state).toBe("running");
    secondRegistration.dispose();
    await other.completion;
  });

  it("coalesces saves during a task into one rerun", async () => {
    const job = await started();
    for (let index = 0; index < 4; index++) expect(run(source, "save")).toBe(job);
    children[0].emit("close", 0, null);
    await job.completion;
    await window.conditionPromise(() => children.length === 2, "the queued save to start");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(manager.getJobs().length).toBe(2);
  });

  it("keeps completed history bounded without discarding active tasks", async () => {
    lumine.config.set("tasks.maxHistory", 1);
    const active = await started(second);
    const first = await started();
    children[1].emit("close", 0, null);
    await first.completion;
    const next = await started();
    children[2].emit("close", 0, null);
    await next.completion;
    expect(manager.getJobs()).toEqual([active, next]);
    expect(manager.removeLog(active.id)).toBeFalse();
    expect(manager.removeLog(next.id)).toBeTrue();
    lumine.config.unset("tasks.maxHistory");
  });

  it("bounds logs even when the compiler never writes a newline", async () => {
    lumine.config.set("tasks.maxOutputCharacters", 1000);
    const job = await started();
    children[0].stdout.write("a".repeat(20000));
    expect(job.stdout.length).toBe(1000);
    expect(job.log.getText().length).toBeLessThanOrEqual(1000);
    expect(job.outputTruncated).toBeTrue();
    lumine.config.unset("tasks.maxOutputCharacters");
  });

  it("keeps command availability lookups free of provider filesystem work", () => {
    provider.resolve = jasmine.createSpy("resolve").and.throwError("Filesystem query");
    expect(manager.getJob({ providerId: "fixture", filePath: source })).toBeNull();
    expect(manager.getMessages({ providerId: "fixture", filePath: source })).toEqual([]);
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it("associates a known custom output without provider callbacks or filesystem discovery", () => {
    const artifactPath = path.join(__dirname, "custom-output", "preview.pdf");
    provider.resolve = jasmine.createSpy("resolve").and.throwError("No root discovery");
    provider.supports = jasmine.createSpy("supports").and.throwError("No provider predicate");
    const changed = jasmine.createSpy("artifact association changed");
    const lease = manager.onDidChangeArtifactTargets(changed);
    const invalidate = spyOn(lumine.commands, "invalidateAvailability").and.callThrough();
    const target = { providerId: "fixture", filePath: source };
    expect(manager.associateArtifact(target, artifactPath)).toBeTrue();
    expect(manager.getArtifactTarget(artifactPath)).toEqual(target);
    const retained = manager.getArtifactTarget(artifactPath);
    retained.filePath = second;
    expect(manager.getArtifactTarget(artifactPath)).toEqual(target);
    expect(
      manager.associateArtifact(target, path.join(__dirname, "custom-output", ".", "preview.pdf")),
    ).toBeFalse();
    if (process.platform === "win32") {
      expect(manager.getArtifactTarget(artifactPath.toUpperCase())).toEqual(target);
      expect(
        manager.associateArtifact({ ...target, filePath: source.toUpperCase() }, artifactPath),
      ).toBeFalse();
    }
    expect(manager.associateArtifact(null, artifactPath)).toBeFalse();
    expect(manager.associateArtifact({ ...target, filePath: "" }, artifactPath)).toBeFalse();
    expect(manager.associateArtifact(target, "bad\0path")).toBeFalse();
    expect(
      manager.associateArtifact({ ...target, providerId: "missing" }, artifactPath),
    ).toBeFalse();
    expect(manager.getArtifactTarget(null)).toBeNull();
    expect(manager.getArtifactTarget(" ")).toBeNull();
    expect(changed).toHaveBeenCalledOnceWith({ artifactPath, target });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(provider.resolve).not.toHaveBeenCalled();
    expect(provider.supports).not.toHaveBeenCalled();
    lease.dispose();
  });

  it("dispatches each artifact through its associated provider and source", async () => {
    const otherRegistration = manager.registerProvider({
      ...provider,
      id: "other",
      name: "Other compiler",
    });
    const firstOutput = path.join(__dirname, "first-custom.pdf");
    const secondOutput = path.join(__dirname, "second-custom.pdf");
    const firstTarget = { providerId: "fixture", filePath: source };
    const otherTarget = { providerId: "other", filePath: second };
    expect(manager.associateArtifact(firstTarget, firstOutput)).toBeTrue();
    expect(manager.associateArtifact(otherTarget, secondOutput)).toBeTrue();
    const first = manager.run(manager.getArtifactTarget(firstOutput));
    const other = manager.run(manager.getArtifactTarget(secondOutput));
    await window.conditionPromise(
      () => Boolean(first.process && other.process),
      "both artifact targets to start",
    );
    expect(first.providerId).toBe("fixture");
    expect(first.filePath).toBe(source);
    expect(other.providerId).toBe("other");
    expect(other.filePath).toBe(second);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.calls.allArgs().map((args) => args[1])).toEqual(
      jasmine.arrayContaining([[source], [second]]),
    );
    children[0].emit("close", 0, null);
    children[1].emit("close", 0, null);
    await Promise.all([first.completion, other.completion]);
    otherRegistration.dispose();
  });

  it("keeps the latest artifact mapping and never falls back to an earlier provider", () => {
    const otherRegistration = manager.registerProvider({ ...provider, id: "other" });
    const output = path.join(__dirname, "shared.pdf");
    expect(
      manager.associateArtifact({ providerId: "fixture", filePath: source }, output),
    ).toBeTrue();
    const target = { providerId: "other", filePath: second };
    expect(manager.associateArtifact(target, output)).toBeTrue();
    registration.dispose();
    expect(manager.getArtifactTarget(output)).toEqual(target);
    otherRegistration.dispose();
    expect(manager.getArtifactTarget(output)).toBeNull();
  });

  it("publishes normalized artifacts before start and after collection, without output-event duplicates", async () => {
    const prepared = path.join(__dirname, "custom", "preview.pdf");
    const collected = path.join(__dirname, "custom", "final.pdf");
    const target = { providerId: "fixture", filePath: source };
    provider.prepare = () => ({
      cmd: "fixture",
      cwd: __dirname,
      artifacts: [{ path: path.join("custom", "preview.pdf"), kind: "pdf", sourcePath: second }],
    });
    provider.collectResult = () => ({
      artifacts: [{ path: path.join("custom", "final.pdf"), kind: "pdf" }],
    });
    const changes = [];
    const lease = manager.onDidChangeArtifactTargets((change) => changes.push(change));
    const startLease = manager.onDidStartJob(() => {
      expect(manager.getArtifactTarget(prepared)).toEqual(target);
    });
    const job = await started();
    children[0].stdout.write("first output\n");
    children[0].stderr.write("second output\n");
    expect(changes).toEqual([{ artifactPath: prepared, target }]);
    children[0].emit("close", 0, null);
    await job.completion;
    expect(changes).toEqual([
      { artifactPath: prepared, target },
      { artifactPath: collected, target },
    ]);
    expect(manager.removeLog(job.id)).toBeTrue();
    expect(manager.getArtifactTarget(collected)).toEqual(target);
    expect(changes.length).toBe(2);
    startLease.dispose();
    lease.dispose();
  });

  it("retains associations when history pruning removes a completed log", async () => {
    lumine.config.set("tasks.maxHistory", 1);
    const first = await started();
    children[0].emit("close", 0, null);
    await first.completion;
    const other = await started(second);
    children[1].emit("close", 0, null);
    await other.completion;
    expect(first.log.destroyed).toBeTrue();
    expect(manager.getArtifactTarget(source + ".pdf")).toEqual({
      providerId: "fixture",
      filePath: source,
    });
    lumine.config.unset("tasks.maxHistory");
  });

  it("clears exact provider generations and emits removal when the manager is disposed", () => {
    const output = source + ".custom.pdf";
    const changes = [];
    manager.onDidChangeArtifactTargets((change) => changes.push(change));
    const firstTarget = { providerId: "fixture", filePath: source };
    const nextTarget = { providerId: "fixture", filePath: second };
    manager.associateArtifact(firstTarget, output);
    registration.dispose();
    expect(manager.getArtifactTarget(output)).toBeNull();
    const nextRegistration = manager.registerProvider({ ...provider });
    expect(manager.getArtifactTarget(output)).toBeNull();
    manager.associateArtifact(nextTarget, output);
    registration.dispose();
    expect(manager.getArtifactTarget(output)).toEqual(nextTarget);
    manager.dispose();
    expect(manager.getArtifactTarget(output)).toBeNull();
    expect(manager.associateArtifact(nextTarget, output)).toBeFalse();
    expect(changes).toEqual([
      { artifactPath: output, target: firstTarget },
      { artifactPath: output, target: null },
      { artifactPath: output, target: nextTarget },
      { artifactPath: output, target: null },
    ]);
    nextRegistration.dispose();
  });

  it("does not publish a late artifact from cancelled preparation", async () => {
    let release;
    const output = source + ".late.pdf";
    provider.prepare = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const job = run();
    await tick();
    job.stop();
    await job.completion;
    release({ cmd: "fixture", artifacts: [{ path: output, kind: "pdf" }] });
    await tick();
    expect(manager.getArtifactTarget(output)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not publish a late artifact from cancelled result collection", async () => {
    let release;
    const output = source + ".late.pdf";
    provider.collectResult = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const job = await started();
    children[0].emit("close", 0, null);
    await tick();
    job.stop();
    await job.completion;
    release({ artifacts: [{ path: output, kind: "pdf" }] });
    await tick();
    expect(manager.getArtifactTarget(output)).toBeNull();
  });

  it("does not let retired collection overwrite an association from a replacement provider", async () => {
    let release;
    const output = source + ".replacement.pdf";
    provider.collectResult = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const job = await started();
    children[0].emit("close", 0, null);
    await tick();
    registration.dispose();
    const nextRegistration = manager.registerProvider({ ...provider });
    const target = { providerId: "fixture", filePath: second };
    manager.associateArtifact(target, output);
    await job.completion;
    release({ artifacts: [{ path: output, kind: "pdf" }] });
    await tick();
    expect(manager.getArtifactTarget(output)).toEqual(target);
    expect(manager.getArtifactTarget(source + ".pdf")).toBeNull();
    nextRegistration.dispose();
  });

  it("stops associating prepared artifacts when a change listener replaces its provider", async () => {
    const firstOutput = source + ".first.pdf";
    const secondOutput = source + ".second.pdf";
    provider.prepare = () => ({
      cmd: "fixture",
      artifacts: [
        { path: firstOutput, kind: "pdf" },
        { path: secondOutput, kind: "pdf" },
      ],
    });
    let replacement;
    const target = { providerId: "fixture", filePath: second };
    manager.onDidChangeArtifactTargets(({ artifactPath, target: current }) => {
      if (artifactPath !== firstOutput || !current || replacement) return;
      registration.dispose();
      replacement = manager.registerProvider({ ...provider });
      manager.associateArtifact(target, secondOutput);
    });
    const job = run();
    await job.completion;
    expect(job.state).toBe("cancelled");
    expect(manager.getArtifactTarget(firstOutput)).toBeNull();
    expect(manager.getArtifactTarget(secondOutput)).toEqual(target);
    expect(spawn).not.toHaveBeenCalled();
    replacement.dispose();
  });

  it("stops an actual compiler and its descendant process", async () => {
    spawn.and.callThrough();
    provider.prepare = () => ({
      cmd: "node",
      args: [
        "-e",
        "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)",
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
      const deadline = Date.now() + 5000;
      while (!/^\d+\r?\n/.test(job.stdout)) {
        if (Date.now() > deadline) throw new Error("Compiler did not report its descendant.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      descendant = Number.parseInt(job.stdout, 10);
      expect(alive(descendant)).toBeTrue();
      job.stop();
      await job.completion;
      while (alive(descendant) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(job.state).toBe("cancelled");
      expect(alive(descendant)).toBeFalse();
    } finally {
      job.stop();
      if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
    }
  });

  it("closes noninteractive standard input instead of leaving a compiler waiting", async () => {
    spawn.and.callThrough();
    provider.prepare = () => ({
      cmd: "node",
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('eof'))",
      ],
    });
    const job = run();
    await job.completion;
    expect(job.state).toBe("passed");
    expect(job.stdout).toBe("eof");
  });

  it("keeps a target's latest result after its retained log is removed", async () => {
    const id = manager.key("fixture", source);
    const target = { id, name: "Fixture", providerId: "fixture", filePath: source, source };
    manager.setTargets([target]);
    const job = await started();
    children[0].emit("close", 0, null);
    await job.completion;
    expect(manager.removeLog(job.id)).toBeTrue();
    expect(manager.getJob({ providerId: "fixture", filePath: source })).toBe(job);
    expect(job.state).toBe("passed");
    expect(manager.getJobs()).toEqual([]);
    expect(manager.getTargets()).toEqual([target]);
  });
});
