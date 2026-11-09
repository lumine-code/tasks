const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

describe("Tasks lifecycle notifications", () => {
  let main, directory, source, children, leases, notices;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const plan = () => ({ cmd: "notifications-fixture", args: [], cwd: directory });

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.unset("tasks.showNotifications");
    notices = Object.fromEntries(
      ["addInfo", "addSuccess", "addError", "addWarning"].map((method) => [
        method,
        spyOn(lumine.notifications, method).and.callFake(() => ({
          dismiss: jasmine.createSpy("dismiss notification"),
        })),
      ]),
    );
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-notifications-"));
    source = path.join(directory, "source.txt");
    fs.writeFileSync(source, "source\n");
    children = [];
    leases = [];
    const realSpawn = childProcess.spawn.bind(childProcess);
    spyOn(childProcess, "spawn").and.callFake((command, args, options) => {
      if (command !== "notifications-fixture") return realSpawn(command, args, options);
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
  });

  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("tasks");
    for (const child of children) child.emit("close", 0, null);
    await lumine.fileWatchClient.settlePendingTeardown();
    const owned = path.resolve(directory);
    if (
      path.dirname(owned) !== path.resolve(os.tmpdir()) ||
      !path.basename(owned).startsWith("tasks-notifications-")
    )
      throw new Error("Unsafe notification fixture cleanup.");
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function provider(options = {}) {
    const lease = main.manager.registerProvider({
      id: "notifications-fixture",
      name: "Fixture",
      supports: () => true,
      prepare: plan,
      ...options,
    });
    leases.push(lease);
    return lease;
  }

  function run(reason = "manual") {
    return main.manager.run({ providerId: "notifications-fixture", filePath: source, reason });
  }

  async function started(reason) {
    const job = run(reason);
    await window.conditionPromise(() => Boolean(job.process), "the notification fixture to start");
    return job;
  }

  async function complete(code = 0, reason) {
    const job = await started(reason);
    job.process.emit("close", code, null);
    await job.completion;
    return job;
  }

  function expectQuiet() {
    for (const notice of Object.values(notices)) expect(notice).not.toHaveBeenCalled();
  }

  function checked() {
    return lumine.commands.getCommandState("tasks:toggle-mute", {
      target: lumine.workspace.getElement(),
    }).checked;
  }

  function button(call, text) {
    return call.args[1].buttons.find((action) => action.text === text);
  }

  function expectMuteControls(panel, muted, selected) {
    for (const control of [panel.listMuteButton, panel.muteButton]) {
      expect(control.classList.contains("icon-mute")).toBe(muted);
      expect(control.classList.contains("icon-unmute")).toBe(!muted);
      expect(control.classList.contains("selected")).toBe(selected);
      expect(control.getAttribute("aria-pressed")).toBe(String(muted));
    }
  }

  it("announces an accepted execution while preparation is pending and completes it once", async () => {
    let release;
    provider({ prepare: () => new Promise((resolve) => (release = resolve)) });
    const job = run();
    expect(job.state).toBe("preparing");
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addInfo.calls.mostRecent().args[0]).toBe("Task started: Fixture");
    expect(notices.addInfo.calls.mostRecent().args[1].detail).toContain(job.filePath);
    expect(notices.addInfo.calls.mostRecent().args[1].buttons.map((action) => action.text)).toEqual(
      ["Open log"],
    );
    expect(run()).toBe(job);
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    await tick();
    expect(children.length).toBe(0);
    expect(notices.addSuccess).not.toHaveBeenCalled();

    release(plan());
    await window.conditionPromise(() => Boolean(job.process), "preparation to release the process");
    job.process.stdout.emit("data", Buffer.from("one\n"));
    job.process.stderr.emit("data", Buffer.from("two\n"));
    job.process.emit("close", 0, null);
    await job.completion;

    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addSuccess).toHaveBeenCalledTimes(1);
    const [message, options] = notices.addSuccess.calls.mostRecent().args;
    expect(message).toBe("Task completed: Fixture");
    expect(options.detail).toContain(job.filePath);
    expect(options.detail).toMatch(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/);
    expect(options.detail).toMatch(/(?:code|exit)[^\n]*0/i);
    expect(options.buttons.map((action) => action.text)).toEqual(["Open log", "Mark as read"]);
    expect(notices.addError).not.toHaveBeenCalled();
    expect(notices.addWarning).not.toHaveBeenCalled();
  });

  it("reports preparation failure even when no compiler process can start", async () => {
    provider({
      prepare: () => {
        throw new Error("Compiler is unavailable");
      },
    });
    const job = run();
    await job.completion;
    expect(job.state).toBe("failed");
    expect(children.length).toBe(0);
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addError).toHaveBeenCalledTimes(1);
    const [message, options] = notices.addError.calls.mostRecent().args;
    expect(message).toBe("Task failed: Fixture");
    expect(options.detail).toContain(job.filePath);
    expect(options.detail).toContain("Compiler is unavailable");
    expect(notices.addSuccess).not.toHaveBeenCalled();
  });

  for (const code of [0, 7]) {
    it(`reports a ${code === 0 ? "semantic" : "process"} failure from the terminal state`, async () => {
      provider({ collectResult: () => ({ failed: code === 0 }) });
      const job = await complete(code);
      expect(job.state).toBe("failed");
      expect(notices.addError).toHaveBeenCalledTimes(1);
      const [message, options] = notices.addError.calls.mostRecent().args;
      expect(message).toBe("Task failed: Fixture");
      expect(options.detail).toContain(job.filePath);
      expect(options.detail).toMatch(new RegExp(`(?:code|exit)[^\\n]*${code}`, "i"));
      expect(notices.addSuccess).not.toHaveBeenCalled();
      expect(notices.addWarning).not.toHaveBeenCalled();
    });
  }

  it("announces cancellation during preparation and ignores its late result", async () => {
    let release;
    provider({ prepare: () => new Promise((resolve) => (release = resolve)) });
    const job = run();
    await tick();
    job.stop();
    await job.completion;
    release(plan());
    await tick();
    expect(job.state).toBe("cancelled");
    expect(children.length).toBe(0);
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addWarning).toHaveBeenCalledTimes(1);
    expect(notices.addWarning.calls.mostRecent().args[0]).toBe("Task cancelled: Fixture");
    expect(notices.addWarning.calls.mostRecent().args[1].detail).toContain(job.filePath);
    expect(notices.addError).not.toHaveBeenCalled();
    expect(notices.addSuccess).not.toHaveBeenCalled();
  });

  it("coalesces duplicate save requests and announces each resulting execution once", async () => {
    provider();
    spyOn(main.manager, "automaticAllowed").and.returnValue(true);
    const first = await started();
    expect(run()).toBe(first);
    expect(run("save")).toBe(first);
    expect(run("save")).toBe(first);
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    first.process.emit("close", 0, null);
    await first.completion;
    await window.conditionPromise(() => children.length === 2, "the coalesced save execution");
    const second = main.manager.getJobs().at(-1);
    expect(second).not.toBe(first);
    expect(second.reason).toBe("save");
    second.process.emit("close", 0, null);
    await second.completion;
    expect(main.manager.getJobs()).toEqual([first, second]);
    expect(notices.addInfo).toHaveBeenCalledTimes(2);
    expect(notices.addSuccess).toHaveBeenCalledTimes(2);
    expect(notices.addError).not.toHaveBeenCalled();
    expect(notices.addWarning).not.toHaveBeenCalled();
  });

  it("keeps the panel closed and the editor focused for manual and save executions", async () => {
    provider();
    const editor = await lumine.workspace.open(source);
    const dock = lumine.workspace.getBottomDock();
    dock.hide();
    const ensurePanel = spyOn(main, "ensurePanel").and.callThrough();
    editor.getElement().focus();
    try {
      await complete();
      await complete(0, "save");
      expect(notices.addInfo).toHaveBeenCalledTimes(2);
      expect(notices.addSuccess).toHaveBeenCalledTimes(2);
      expect(ensurePanel).not.toHaveBeenCalled();
      expect(main.panel).toBeNull();
      expect(dock.isVisible()).toBeFalse();
      expect(editor.getElement().contains(document.activeElement)).toBeTrue();
    } finally {
      editor.destroy();
    }
  });

  it("opens the running execution captured by a start notification rather than another selected log", async () => {
    provider();
    const first = await started();
    first.process.stdout.emit("data", Buffer.from("first execution output\n"));
    const notice = notices.addInfo.calls.mostRecent();
    const secondSource = path.join(directory, "second.txt");
    const second = main.manager.run({
      providerId: "notifications-fixture",
      filePath: secondSource,
    });
    await window.conditionPromise(() => Boolean(second.process), "the second execution to start");
    const panel = main.ensurePanel();
    panel.selectJob(second);
    const dock = lumine.workspace.getBottomDock();
    dock.hide();

    await button(notice, "Open log").onDidClick();

    expect(main.panel).toBe(panel);
    expect(panel.getSelectedJob()).toBe(first);
    expect(panel.mode).toBe("details");
    expect(panel.getText()).toContain("first execution output");
    expect(dock.isVisible()).toBeTrue();
    expect(panel.output.contains(document.activeElement)).toBeTrue();
    expect(notice.returnValue.dismiss).toHaveBeenCalledTimes(1);
    expect(first.state).toBe("running");
    expect(second.state).toBe("running");
    second.process.emit("close", 7, null);
    await second.completion;
    expect([...main.unseenJobs.values()]).toEqual([second]);
    first.process.emit("close", 0, null);
    await first.completion;
    expect([...main.unseenJobs.values()]).toEqual([second]);
  });

  it("opens a finished notification's exact log and acknowledges only that execution", async () => {
    provider();
    const failed = await complete(7);
    const notice = notices.addError.calls.mostRecent();
    const passed = await complete();
    const panel = main.ensurePanel();
    panel.selectJob(passed);
    lumine.workspace.getBottomDock().hide();
    expect(main.unseenJobs.size).toBe(2);

    await button(notice, "Open log").onDidClick();

    expect(panel.getSelectedJob()).toBe(failed);
    expect(panel.mode).toBe("details");
    expect(panel.output.contains(document.activeElement)).toBeTrue();
    expect(main.isTasksPanelVisible()).toBeTrue();
    expect([...main.unseenJobs.values()]).toEqual([passed]);
    expect(main.statusElement.dataset.state).toBe("passed");
    expect(notice.returnValue.dismiss).toHaveBeenCalledTimes(1);
    expect(notices.addSuccess.calls.mostRecent().returnValue.dismiss).not.toHaveBeenCalled();
    expect(main.manager.getJobs()).toEqual([failed, passed]);
  });

  it("marks only the chosen result read and recomputes severity without opening or focusing Tasks", async () => {
    provider();
    const passed = await complete();
    const passedNotice = notices.addSuccess.calls.mostRecent();
    const cancelled = await started();
    cancelled.stop();
    await cancelled.completion;
    const cancelledNotice = notices.addWarning.calls.mostRecent();
    const failed = await complete(7);
    const failedNotice = notices.addError.calls.mostRecent();
    const editor = await lumine.workspace.open(source);
    const dock = lumine.workspace.getBottomDock();
    dock.hide();
    editor.getElement().focus();
    const ensurePanel = spyOn(main, "ensurePanel").and.callThrough();
    const set = spyOn(lumine.config, "set").and.callThrough();
    try {
      expect(main.statusElement.dataset.state).toBe("failed");
      expect(main.statusElement.dataset.new).toBe("3");

      await button(failedNotice, "Mark as read").onDidClick();

      expect([...main.unseenJobs.values()]).toEqual([passed, cancelled]);
      expect(main.statusElement.dataset.state).toBe("cancelled");
      expect(main.statusElement.dataset.new).toBe("2");
      expect(failedNotice.returnValue.dismiss).toHaveBeenCalledTimes(1);
      expect(cancelledNotice.returnValue.dismiss).not.toHaveBeenCalled();
      await button(cancelledNotice, "Mark as read").onDidClick();
      expect([...main.unseenJobs.values()]).toEqual([passed]);
      expect(main.statusElement.dataset.state).toBe("passed");
      expect(main.statusElement.dataset.new).toBe("1");
      expect(cancelledNotice.returnValue.dismiss).toHaveBeenCalledTimes(1);

      passedNotice.returnValue.dismiss();
      expect([...main.unseenJobs.values()]).toEqual([passed]);
      expect(main.manager.getJobs()).toEqual([passed, cancelled, failed]);
      expect(main.panel).toBeNull();
      expect(ensurePanel).not.toHaveBeenCalled();
      expect(dock.isVisible()).toBeFalse();
      expect(editor.getElement().contains(document.activeElement)).toBeTrue();
      expect(set).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
    }
  });

  for (const removal of ["removed", "pruned"]) {
    it(`ignores notification actions after their execution log was ${removal}`, async () => {
      provider();
      const first = await complete();
      const startNotice = notices.addInfo.calls.mostRecent();
      const finishNotice = notices.addSuccess.calls.mostRecent();
      if (removal === "removed") main.manager.removeLog(first.id);
      else lumine.config.set("tasks.maxHistory", 1);
      const current = await complete(7);
      expect(first.log.destroyed).toBeTrue();
      expect(main.manager.getJobs()).not.toContain(first);
      const ensurePanel = spyOn(main, "ensurePanel").and.callThrough();
      lumine.workspace.getBottomDock().hide();

      await button(startNotice, "Open log").onDidClick();
      await button(finishNotice, "Open log").onDidClick();
      await button(finishNotice, "Mark as read").onDidClick();

      expect(main.panel).toBeNull();
      expect(ensurePanel).not.toHaveBeenCalled();
      expect(lumine.workspace.getBottomDock().isVisible()).toBeFalse();
      expect([...main.unseenJobs.values()]).toEqual([current]);
      expect(main.statusElement.dataset.state).toBe("failed");
    });
  }

  it("ignores retained buttons from a retired generation even when the new execution reuses its id", async () => {
    provider();
    const previous = await complete();
    const startNotice = notices.addInfo.calls.mostRecent();
    const finishNotice = notices.addSuccess.calls.mostRecent();
    await lumine.packages.deactivatePackage("tasks");
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    provider();
    const current = await complete(7);
    expect(current.id).toBe(previous.id);
    const ensurePanel = spyOn(main, "ensurePanel").and.callThrough();
    lumine.workspace.getBottomDock().hide();

    await button(startNotice, "Open log").onDidClick();
    await button(finishNotice, "Open log").onDidClick();
    await button(finishNotice, "Mark as read").onDidClick();

    expect(main.panel).toBeNull();
    expect(ensurePanel).not.toHaveBeenCalled();
    expect(lumine.workspace.getBottomDock().isVisible()).toBeFalse();
    expect(main.manager.getJobs()).toEqual([current]);
    expect([...main.unseenJobs.values()]).toEqual([current]);
    expect(main.statusElement.dataset.state).toBe("failed");
  });

  it("does not focus a replacement panel when notification navigation outlives its activation", async () => {
    provider();
    await complete();
    const notice = notices.addSuccess.calls.mostRecent();
    const panel = main.ensurePanel();
    let release;
    const showing = new Promise((resolve) => (release = resolve));
    spyOn(panel, "show").and.returnValue(showing);
    const oldFocus = spyOn(panel, "focus").and.callThrough();

    const opening = button(notice, "Open log").onDidClick();
    expect(panel.show).toHaveBeenCalledTimes(1);
    main.deactivate();
    main.activate();
    const replacement = main.ensurePanel();
    const replacementFocus = spyOn(replacement, "focus").and.callThrough();
    release(panel);
    await opening;
    await tick();

    expect(oldFocus).not.toHaveBeenCalled();
    expect(replacementFocus).not.toHaveBeenCalled();
    expect(replacement.getSelectedJob()).toBeNull();
    expect(replacement.mode).toBe("list");
  });

  it("keeps a result acknowledged when its notification action runs during publication", async () => {
    provider();
    notices.addError.and.callFake((_message, options) => {
      options.buttons.find((action) => action.text === "Mark as read").onDidClick();
      return { dismiss: jasmine.createSpy("dismiss immediate notification") };
    });
    const failed = await complete(7);
    expect(notices.addError).toHaveBeenCalledTimes(1);
    expect(main.manager.getJobs()).toEqual([failed]);
    expect(main.unseenJobs.size).toBe(0);
    expect(main.statusElement.dataset.state).toBe("idle");
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.panel).toBeNull();
  });

  it("starts enabled by default and keeps the checked mute command local", async () => {
    expect(lumine.config.get("tasks.showNotifications")).toBeTrue();
    expect(main.muted).toBeFalse();
    expect(checked()).toBeFalse();
    const set = spyOn(lumine.config, "set").and.callThrough();
    await lumine.commands.dispatch(lumine.workspace.getElement(), "tasks:toggle-mute");
    expect(main.muted).toBeTrue();
    expect(checked()).toBeTrue();
    expect(lumine.config.get("tasks.showNotifications")).toBeTrue();
    main.setMuted(false);
    expect(checked()).toBeFalse();
    expect(set).not.toHaveBeenCalled();
    expect(main.panel).toBeNull();
  });

  it("initializes from disabled notifications and permits a local override", async () => {
    lumine.config.set("tasks.showNotifications", false);
    await lumine.packages.deactivatePackage("tasks");
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    expect(main.muted).toBeTrue();
    const panel = main.ensurePanel();
    expectMuteControls(panel, true, false);
    provider();
    await complete();
    expectQuiet();
    const set = spyOn(lumine.config, "set").and.callThrough();
    main.toggleMute();
    expect(main.muted).toBeFalse();
    expectMuteControls(panel, false, true);
    expect(lumine.config.get("tasks.showNotifications")).toBeFalse();
    await complete();
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addSuccess).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });

  it("resets local overrides when the global setting changes and applies mute at each event", async () => {
    provider();
    const panel = main.ensurePanel();
    expectMuteControls(panel, false, false);
    const first = await started();
    main.setMuted(true);
    expectMuteControls(panel, true, true);
    first.process.emit("close", 0, null);
    await first.completion;
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addSuccess).not.toHaveBeenCalled();
    lumine.config.set("tasks.showNotifications", false);
    expectMuteControls(panel, true, false);
    main.setMuted(false);
    expect(main.muted).toBeFalse();
    expectMuteControls(panel, false, true);
    lumine.config.set("tasks.showNotifications", true);
    expect(main.muted).toBeFalse();
    expectMuteControls(panel, false, false);
    main.setMuted(true);
    lumine.config.set("tasks.showNotifications", false);
    expect(main.muted).toBeTrue();
    expectMuteControls(panel, true, false);
    const second = await started();
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    lumine.config.set("tasks.showNotifications", true);
    expect(main.muted).toBeFalse();
    expectMuteControls(panel, false, false);
    second.process.emit("close", 0, null);
    await second.completion;
    expect(notices.addSuccess).toHaveBeenCalledTimes(1);
  });

  it("retains the local mute choice when the panel is destroyed and recreated", () => {
    main.setMuted(true);
    const first = main.ensurePanel();
    first.destroy();
    const replacement = main.ensurePanel();
    expect(replacement).not.toBe(first);
    expect(main.muted).toBeTrue();
    expect(checked()).toBeTrue();
    main.toggleMute();
    expect(main.muted).toBeFalse();
    expect(checked()).toBeFalse();
  });

  it("does not replay executions completed before activation subscribes", async () => {
    main.deactivate();
    main.provideTasks();
    provider();
    const job = await complete();
    expectQuiet();
    main.activate();
    expect(main.manager.getJobs()).toEqual([job]);
    expectQuiet();
  });

  it("marks a start before notifying so a reentrant stop cannot announce it twice", async () => {
    provider();
    notices.addInfo.and.callFake(() => main.manager.getJobs().at(-1).stop());
    const job = run();
    await job.completion;
    expect(job.state).toBe("cancelled");
    expect(children.length).toBe(0);
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addWarning).toHaveBeenCalledTimes(1);
    expect(notices.addSuccess).not.toHaveBeenCalled();
    expect(notices.addError).not.toHaveBeenCalled();
  });

  it("ignores a retired execution when its start notification replaces the activation", async () => {
    provider();
    const previous = main.manager;
    notices.addInfo.and.callFake(() => {
      main.deactivate();
      main.activate();
    });
    const job = previous.run({ providerId: "notifications-fixture", filePath: source });
    await job.completion;
    await tick();
    expect(main.manager).not.toBe(previous);
    expect(children.length).toBe(0);
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addWarning).not.toHaveBeenCalled();
    expect(notices.addError).not.toHaveBeenCalled();
    expect(notices.addSuccess).not.toHaveBeenCalled();
  });

  it("suppresses teardown and late completion notifications from a replaced generation", async () => {
    provider();
    const oldJob = await started();
    const child = oldJob.process;
    await lumine.packages.deactivatePackage("tasks");
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    child.emit("close", 7, null);
    await oldJob.completion;
    expect(notices.addInfo).toHaveBeenCalledTimes(1);
    expect(notices.addWarning).not.toHaveBeenCalled();
    expect(notices.addError).not.toHaveBeenCalled();
    provider();
    const current = await complete();
    expect(current.id).toBe(oldJob.id);
    expect(notices.addInfo).toHaveBeenCalledTimes(2);
    expect(notices.addSuccess).toHaveBeenCalledTimes(1);
  });
});
