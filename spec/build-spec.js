const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ipcRenderer } = require("electron");

describe("Tasks workspace integration", () => {
  let main, directory, editor, previousPaths, previousWorkspaceHeight;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    previousWorkspaceHeight = lumine.workspace.getElement().style.height;
    if (lumine.packages.isPackageActive("tasks")) await lumine.packages.deactivatePackage("tasks");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-tasks-"));
    fs.writeFileSync(path.join(directory, "first.txt"), "first\n");
    previousPaths = lumine.project.getPaths();
    lumine.project.setPaths([directory]);
    lumine.config.set("tasks.saveOnBuild", false);
    editor = await lumine.workspace.open(path.join(directory, "first.txt"));
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
  });
  afterEach(async () => {
    const jobs = main.manager.getJobs({ activeOnly: true });
    main.manager.stopAll();
    await Promise.all(jobs.map((job) => job.completion));
    await lumine.packages.deactivatePackage("tasks");
    lumine.workspace.getElement().style.height = previousWorkspaceHeight;
    for (const item of lumine.workspace.getTextEditors())
      if (item.getPath()?.startsWith(directory + path.sep)) item.destroy();
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("tasks-tasks-")
    )
      throw new Error("Unsafe fixture cleanup.");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  async function configure(targets) {
    fs.mkdirSync(path.join(directory, ".lumine"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, ".lumine/tasks.json"),
      JSON.stringify({ tasks: targets }),
    );
    await main.refreshTargets();
  }
  const target = (name, output) => ({
    name,
    cmd: "node",
    args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
  });

  async function nativeKey(keyCode) {
    const types = keyCode === "Enter" ? ["keyDown", "char", "keyUp"] : ["keyDown", "keyUp"];
    for (const type of types)
      await ipcRenderer.invoke("lumine:window", "sendInputEvent", { type, keyCode });
    await settleInput();
  }

  async function nativeClick(element) {
    const rect = element.getBoundingClientRect();
    for (const type of ["mouseMove", "mouseDown", "mouseUp"])
      await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
        type,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        button: "left",
        clickCount: 1,
      });
    await settleInput();
  }

  async function settleInput() {
    for (let frame = 0; frame < 2; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function attachPickerControls() {
    const panel = main.ensurePanel();
    panel.element.style.cssText =
      "position:fixed;left:20px;top:40px;width:800px;height:200px;z-index:100000";
    lumine.workspace.getElement().style.height = "400px";
    lumine.workspace.getElement().append(panel.element);
    return panel;
  }

  it("runs actual project commands and keeps their logs separately", async () => {
    await configure([target("First", "one"), target("Second", "two")]);
    const first = await main.runTarget(main.targets[0]);
    await first.completion;
    const second = await main.runTarget(main.targets[1]);
    await second.completion;
    expect(first.stdout).toBe("one");
    expect(second.stdout).toBe("two");
    expect(first.name).toBe("First");
    expect(second.name).toBe("Second");
    expect(main.manager.getLogs()).toEqual([second, first]);
    const panel = main.ensurePanel();
    expect(panel.mode).toBe("list");
    panel.selectJob(second);
    expect(panel.getSelectedJob()).toBe(second);
  });

  it("runs the confirmed native-picker task immediately without a remembered default", async () => {
    await configure([target("First", "one"), target("Second", "two")]);
    await lumine.commands.dispatch(lumine.workspace.getElement(), "tasks:run-task");
    expect(main.manager.getJobs()).toEqual([]);
    expect(main.selectListHost.isVisible()).toBe(true);
    const picker = main.selectListHost.getModel();
    const chosen = main.targets.find((entry) => entry.name === "Second");
    await picker.selectItemById(chosen.id);
    await picker.confirmSelection();
    const jobs = main.manager.getJobs();
    expect(jobs.length).toBe(1);
    await jobs[0].completion;
    expect(jobs[0].name).toBe("Second");
    expect(jobs[0].stdout).toBe("two");
    expect(main.selectListHost.isVisible()).toBe(false);
    await lumine.commands.dispatch(lumine.workspace.getElement(), "tasks:run-task");
    expect(main.selectListHost.isVisible()).toBe(true);
    expect(main.manager.getJobs()).toEqual(jobs);
  });

  it("opens the task picker from the history Run icon and starts only the confirmed task", async () => {
    await configure([target("First", "one"), target("Second", "two")]);
    const panel = main.ensurePanel();
    await panel.show();
    panel.runButton.click();
    await window.conditionPromise(
      () =>
        main.selectListHost?.isVisible() && main.selectListHost.getModel().getItems().length === 2,
      "the task picker to load its choices",
    );
    expect(main.manager.getJobs()).toEqual([]);
    expect(panel.list.children.length).toBe(0);
    const picker = main.selectListHost.getModel();
    const chosen = main.targets.find((entry) => entry.name === "Second");
    await picker.selectItemById(chosen.id);
    await picker.confirmSelection();
    const [job] = main.manager.getJobs();
    await job.completion;
    expect(job.stdout).toBe("two");
    expect(panel.list.children.length).toBe(1);
    expect(panel.mode).toBe("list");
  });

  it("runs a confirmed picker task without opening Tasks or moving focus from its source", async () => {
    await configure([
      {
        name: "Failure",
        cmd: "node",
        args: ["-e", "process.stdout.write('failed output');process.exitCode=1"],
      },
    ]);
    const dock = lumine.workspace.getBottomDock();
    dock.hide();
    editor.getElement().focus();
    const ensurePanel = spyOn(main, "ensurePanel").and.callThrough();
    await main.selectTask();
    const picker = main.selectListHost.getModel();
    await picker.selectItemById(main.targets[0].id);
    await picker.confirmSelection();
    const [job] = main.manager.getJobs();
    expect(main.selectListHost.isVisible()).toBeFalse();
    expect(dock.isVisible()).toBeFalse();
    expect(ensurePanel).not.toHaveBeenCalled();
    await job.completion;
    expect(job.state).toBe("failed");
    expect(main.isTasksPanelVisible()).toBeFalse();
    expect(ensurePanel).not.toHaveBeenCalled();
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusNewIndicator.hidden).toBeFalse();
    await window.conditionPromise(
      () => editor.getElement().contains(document.activeElement),
      "focus to return to the source after confirming the task",
    );
    expect(main.manager.getJobs()).toEqual([job]);
  });

  it("returns pointer-opened pickers to the source without a keyboard ring on their icons", async () => {
    await configure([target("Compile", "done")]);
    const panel = attachPickerControls();
    editor.getElement().focus();
    for (const [button, getHost] of [
      [panel.runButton, () => main.selectListHost],
      [panel.observedButton, () => main.observedList?.selectListHost],
    ]) {
      await nativeClick(button);
      await window.conditionPromise(() => getHost()?.isVisible(), "the picker to open");
      await nativeKey("Escape");
      await window.conditionPromise(
        () => !getHost().isVisible() && editor.getElement().contains(document.activeElement),
        "focus to return to the source after closing a pointer-opened picker",
      );
      expect(button.matches(":focus")).toBeFalse();
      expect(button.matches(":focus-visible")).toBeFalse();
    }
    expect(main.manager.getJobs()).toEqual([]);
  });

  it("preserves keyboard focus and native activation on the picker icons", async () => {
    await configure([target("Compile", "done")]);
    const panel = attachPickerControls();
    for (const [button, getHost, key] of [
      [panel.runButton, () => main.selectListHost, "Space"],
      [panel.observedButton, () => main.observedList?.selectListHost, "Enter"],
    ]) {
      button.focus();
      expect(document.activeElement).toBe(button);
      await nativeKey(key);
      await window.conditionPromise(
        () => getHost()?.isVisible(),
        `${button.getAttribute("aria-label")} to open with ${key}`,
        1000,
      );
      await nativeKey("Escape");
      await window.conditionPromise(
        () => !getHost().isVisible() && document.activeElement === button,
        "focus to return to the keyboard-activated picker icon",
      );
      expect(button.matches(":focus-visible")).toBeTrue();
    }
    expect(main.manager.getJobs()).toEqual([]);
  });

  it("runs independent targets from one project at the same time", async () => {
    await configure([
      { name: "Watch", cmd: "node", args: ["-e", "setTimeout(()=>{},5000)"] },
      target("Tests", "checked"),
    ]);
    const watch = await main.runTarget(main.targets[0]);
    const tests = await main.runTarget(main.targets[1]);
    await tests.completion;
    expect(tests).not.toBe(watch);
    expect(tests.stdout).toBe("checked");
    expect(main.isActive(watch)).toBeTrue();
    watch.stop();
    await watch.completion;
  });

  it("keeps the first request's substitutions when a duplicate arrives before preparation", async () => {
    await configure([
      {
        name: "Selection",
        cmd: "node",
        args: ["-e", "process.stdout.write(process.argv[1])", "{SELECTION}"],
      },
    ]);
    editor.setText("first second");
    editor.setSelectedBufferRange([
      [0, 0],
      [0, 5],
    ]);
    const first = main.runTarget(main.targets[0]);
    editor.setSelectedBufferRange([
      [0, 6],
      [0, 12],
    ]);
    const duplicate = main.runTarget(main.targets[0]);
    const job = await first;
    expect(await duplicate).toBe(job);
    await job.completion;
    expect(job.stdout).toBe("first");
  });

  it("rejects target command collisions and retires the previous configuration commands", async () => {
    await configure([{ ...target("Custom", "custom"), commandName: "tasks:custom-task" }]);
    const element = lumine.workspace.getElement();
    expect(lumine.commands.canDispatch(element, "tasks:custom-task")).toBeTrue();
    await configure([{ ...target("Reserved", "bad"), commandName: "tasks:stop" }]);
    expect(main.targets).toEqual([]);
    expect(lumine.commands.canDispatch(element, "tasks:custom-task")).toBeFalse();
  });

  it("keeps an explicitly dispatched target and substitutions while its editor save waits", async () => {
    await configure([
      {
        name: "Snapshot",
        cmd: "node",
        args: ["-e", "process.stdout.write(process.argv[1])", "{FILE_ACTIVE}"],
      },
      target("Other", "other"),
    ]);
    lumine.config.set("tasks.saveOnBuild", true);
    let release,
      waiting = false;
    const saved = new Promise((resolve) => {
      release = resolve;
    });
    const lease = editor.getBuffer().onWillSave(() => {
      waiting = true;
      return saved;
    });
    editor.setText("modified");
    const requestedTarget = main.targets[0];
    const pending = main.runTarget(requestedTarget);
    try {
      while (!waiting) await new Promise((resolve) => setTimeout(resolve, 0));
      const other = main.targets[1];
      await configure([other, main.targets[0]]);
      fs.writeFileSync(path.join(directory, "second.txt"), "second");
      await lumine.workspace.open(path.join(directory, "second.txt"));
      release();
      const job = await pending;
      await job.completion;
      expect(job.name).toBe("Snapshot");
      expect(job.stdout).toBe(editor.getPath());
    } finally {
      release();
      lease.dispose();
    }
  });

  it("keeps pending source saves owned by the activation that requested them", async () => {
    await configure([target("Saved", "saved")]);
    lumine.config.set("tasks.saveOnBuild", true);
    editor.setText("modified");
    let releaseOld, releaseCurrent;
    const oldSave = new Promise((resolve) => {
      releaseOld = resolve;
    });
    const currentSave = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    spyOn(editor, "save").and.returnValues(oldSave, currentSave);
    const retiredManager = main.manager;
    const stale = main.runTarget(main.targets[0]);
    await lumine.packages.deactivatePackage("tasks");
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    await main.refreshTargets();
    const currentManager = main.manager;
    const pending = main.runTarget(main.targets[0]);
    let currentSettled = false;
    pending.then(() => {
      currentSettled = true;
    });
    try {
      releaseOld();
      expect(await stale).toBeNull();
      expect(retiredManager.getJobs()).toEqual([]);
      expect(currentManager.getJobs()).toEqual([]);
      expect(currentSettled).toBe(false);
      releaseCurrent();
      const job = await pending;
      await job.completion;
      expect(job.state).toBe("passed");
      expect(job.stdout).toBe("saved");
      expect(currentManager.getJobs()).toEqual([job]);
    } finally {
      releaseOld();
      releaseCurrent();
    }
  });

  it("includes document providers for standalone files without a project", async () => {
    lumine.project.setPaths([]);
    const lease = main.manager.registerProvider({
      id: "document",
      name: "Document",
      supports: (file) => file.endsWith(".txt"),
      prepare: () => ({ cmd: "node", args: ["-e", "process.stdout.write('standalone')"] }),
    });
    try {
      await main.refreshTargets();
      expect(main.targets.length).toBe(1);
      expect(main.targets[0].providerId).toBe("document");
      const job = await main.runTarget(main.targets[0]);
      await job.completion;
      expect(job.stdout).toBe("standalone");
    } finally {
      lease.dispose();
    }
  });

  it("publishes diagnostics without allowing the linter to mutate service results", async () => {
    const registry = main.consumeLinterRegistry(() => ({
      setAllMessages(messages) {
        if (messages[0]) {
          messages[0].location.position = "mutated";
          messages[0].linterName = "Tasks";
        }
      },
      dispose() {},
    }));
    const lease = main.manager.registerProvider({
      id: "diagnostic",
      name: "Diagnostic",
      supports: () => true,
      prepare: () => ({ cmd: "node", args: ["-e", ""] }),
      collectResult: () => ({
        diagnostics: [
          {
            severity: "error",
            excerpt: "range",
            location: {
              file: editor.getPath(),
              position: [
                [0, 3],
                [1, 1],
              ],
            },
          },
        ],
      }),
    });
    try {
      const job = main.manager.run({ providerId: "diagnostic", filePath: editor.getPath() });
      await job.completion;
      expect(job.diagnostics[0].location.position).toEqual([
        [0, 3],
        [1, 1],
      ]);
      expect(job.diagnostics[0].linterName).toBeUndefined();
    } finally {
      lease.dispose();
      registry.dispose();
    }
  });

  it("keeps log selection and focus while another active task streams output", async () => {
    await configure([
      target("First", "first"),
      {
        name: "Held",
        cmd: "node",
        args: [
          "-e",
          "console.log('started');setTimeout(()=>console.log('later'),100);setTimeout(()=>{},5000)",
        ],
      },
    ]);
    const first = await main.runTarget(main.targets[0]);
    await first.completion;
    const second = await main.runTarget(main.targets[1]);
    const panel = main.ensurePanel();
    await panel.show();
    panel.selectJob(first);
    editor.getElement().focus();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(panel.getSelectedJob()).toBe(first);
    expect(editor.getElement().contains(document.activeElement)).toBeTrue();
    second.stop();
    await second.completion;
  });

  it("reopens the dock with retained logs after closing its tab", async () => {
    await configure([target("Persistent", "retained")]);
    const job = await main.runTarget(main.targets[0]);
    await job.completion;
    const first = main.ensurePanel();
    await first.show();
    await lumine.workspace.paneForItem(first).destroyItem(first, true);
    const panel = main.ensurePanel();
    await panel.show();
    expect(panel).not.toBe(first);
    expect(panel.mode).toBe("list");
    panel.selectJob(job);
    expect(panel.getText()).toContain("retained");
    expect(main.manager.getJobs()).toEqual([job]);
  });

  it("publishes its service synchronously and retires the previous generation", async () => {
    const service = main.provideTasks();
    expect(service).toBe(main.manager);
    await lumine.packages.deactivatePackage("tasks");
    expect(service.destroyed).toBeTrue();
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    expect(main.provideTasks()).not.toBe(service);
    expect(service.run({ providerId: "project", filePath: directory })).toBeNull();
  });

  it("restores its dock shell before activation without creating another manager", async () => {
    await lumine.packages.deactivatePackage("tasks");
    const panel = main.deserializeTasksPanel();
    const service = main.provideTasks();
    await lumine.workspace.open(panel, { activatePane: false });
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    expect(main.ensurePanel()).toBe(panel);
    expect(main.provideTasks()).toBe(service);
    expect(panel.getText()).toBe("");
  });
});
