/* global conditionPromise */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CompositeDisposable } = require("lumine");

describe("Tasks target catalog and task identity", () => {
  let main, directory, roots, previousPaths, subscriptions;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    if (lumine.packages.isPackageActive("tasks")) await lumine.packages.deactivatePackage("tasks");
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tasks-catalog-")));
    roots = [path.join(directory, "first"), path.join(directory, "second")];
    for (const root of roots) {
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "current.txt"), "Current source.\n");
    }
    previousPaths = lumine.project.getPaths();
    lumine.project.setPaths(roots);
    lumine.config.set("tasks.saveOnBuild", false);
    await lumine.workspace.open(path.join(roots[0], "current.txt"));
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    subscriptions = new CompositeDisposable();
  });

  afterEach(async () => {
    const manager = main.manager;
    if (manager && !manager.destroyed) {
      const running = manager.getJobs({ activeOnly: true });
      manager.stopAll();
      await Promise.all(running.map((job) => job.completion));
    }
    subscriptions.dispose();
    await lumine.packages.deactivatePackage("tasks");
    for (const editor of lumine.workspace.getTextEditors())
      if (editor.getPath()?.startsWith(directory + path.sep)) editor.destroy();
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Unsafe catalog fixture cleanup.");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function configure(configDirectory, targets) {
    fs.mkdirSync(path.join(configDirectory, ".lumine"), { recursive: true });
    const filePath = path.join(configDirectory, ".lumine/tasks.json");
    fs.writeFileSync(filePath, JSON.stringify({ tasks: targets }));
    return filePath;
  }

  function command(name, output, extra = {}) {
    return {
      name,
      cmd: "node",
      args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
      ...extra,
    };
  }

  function canonical(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  it("merges additional configuration files when the setting changes without replacing defaults", async () => {
    configure(roots[0], [command("Check", "default")]);
    const extra = path.join(roots[0], "tasks.json");
    fs.writeFileSync(extra, JSON.stringify({ tasks: [command("Check", "additional")] }));
    await main.refreshTargets();
    expect(main.targets.length).toBe(1);
    const originalId = main.targets[0].id;
    lumine.config.set("tasks.additionalConfigFiles", ["tasks.json"]);
    await conditionPromise(() => main.targets.length === 2, "additional task files to be merged");
    expect(new Set(main.targets.map((target) => target.id)).size).toBe(2);
    expect(main.targets.some((target) => target.id === originalId)).toBeTrue();
    expect(main.targets.some((target) => target.configPath === extra)).toBeTrue();
    expect(main.manager.getJobs()).toEqual([]);
    lumine.config.set("tasks.additionalConfigFiles", []);
    await conditionPromise(() => main.targets.length === 1, "default task files to remain");
    expect(main.targets[0].id).toBe(originalId);
  });

  async function focusSource(root, name = "current.txt") {
    const filePath = path.join(root, name);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "Another source.\n");
    const editor = await lumine.workspace.open(filePath);
    await main.refreshTargets();
    return editor;
  }

  function registerDocumentProvider(options = {}) {
    subscriptions.add(
      main.manager.registerProvider({
        id: "document",
        name: "Document compiler",
        supports: (filePath) => filePath.endsWith(".txt"),
        prepare: ({ filePath }) => ({
          cmd: "node",
          args: ["-e", "process.stdout.write(process.argv[1])", path.basename(filePath)],
        }),
        ...options,
      }),
    );
  }

  it("discovers every project and nested config with its own working directory", async () => {
    const nested = path.join(roots[0], "packages", "engine");
    const task = {
      name: "Check",
      cmd: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
    };
    for (const configRoot of [roots[0], nested, roots[1]]) configure(configRoot, [task]);
    await main.refreshTargets();
    const targets = main.manager.getTargets();
    expect(targets.length).toBe(3);
    expect(new Set(targets.map((target) => target.id)).size).toBe(3);
    expect(targets.map((target) => canonical(target.cwd)).sort()).toEqual(
      [roots[0], nested, roots[1]].map(canonical).sort(),
    );
    expect(main.manager.getJobs().length).toBe(0);
    for (const target of targets) {
      expect(target.id).toBe(main.manager.key(target.providerId, target.filePath));
      expect(canonical(target.projectPath)).toBe(
        canonical(target.cwd).startsWith(canonical(roots[1]))
          ? canonical(roots[1])
          : canonical(roots[0]),
      );
      const job = await main.runTarget(target);
      await job.completion;
      expect(canonical(job.stdout)).toBe(canonical(target.cwd));
    }
  });

  it("keeps a config target's identity stable across order and command argument changes", async () => {
    const first = command("First", "first");
    configure(roots[0], [first, command("Selected", "old")]);
    await main.refreshTargets();
    const selected = main.manager.getTargets().find((target) => target.name === "Selected");
    configure(roots[0], [command("Selected", "new"), first]);
    await main.refreshTargets();
    expect(main.manager.getTargets().find((target) => target.name === "Selected").id).toBe(
      selected.id,
    );
    const job = await main.runTarget(selected);
    await job.completion;
    expect(job.stdout).toBe("new");
    expect(job.targetId).toBe(selected.id);
  });

  it("distinguishes duplicate names and preserves their IDs after unrelated insertions", async () => {
    const first = command("Check", "one"),
      second = command("Check", "two");
    configure(roots[0], [first, second]);
    await main.refreshTargets();
    const original = main.manager.getTargets().filter((target) => target.name === "Check");
    expect(original.length).toBe(2);
    expect(original[0].id).not.toBe(original[1].id);
    configure(roots[0], [command("Unrelated", "extra"), first, second]);
    await main.refreshTargets();
    const refreshed = main.manager.getTargets().filter((target) => target.name === "Check");
    expect(refreshed.map((target) => target.id)).toEqual(original.map((target) => target.id));
    const job = await main.runTarget(refreshed[1]);
    await job.completion;
    expect(job.stdout).toBe("two");
  });

  it("preserves configured definitions while source context and providers change", async () => {
    configure(roots[0], [command("Configured", "configured")]);
    await main.refreshTargets();
    const configured = main.manager.getTargets()[0];
    registerDocumentProvider();
    await focusSource(roots[1]);
    expect(main.manager.getTargets().some((target) => target.providerId === "document")).toBe(true);
    expect(main.manager.getTargets().some((target) => target.id === configured.id)).toBe(true);
    subscriptions.add(
      main.manager.registerProvider({
        id: "unrelated",
        name: "Other compiler",
        supports: () => false,
        prepare: () => ({ cmd: "node", args: ["--version"] }),
      }),
    );
    await main.refreshTargets();
    expect(main.manager.getTargets().some((target) => target.id === configured.id)).toBe(true);
    expect(main.manager.getJobs().length).toBe(0);
    const job = await main.runTarget(configured);
    await job.completion;
    expect(job.stdout).toBe("configured");
  });

  it("updates document choices while retaining the previous source's execution history", async () => {
    registerDocumentProvider();
    await main.refreshTargets();
    const first = main.manager.getTargets().find((target) => target.providerId === "document");
    const job = await main.runTarget(first);
    await job.completion;
    const next = await focusSource(roots[1], "next.txt");
    const current = main.manager.getTargets().find((target) => target.providerId === "document");
    expect(current.filePath).toBe(next.getPath());
    expect(current.id).not.toBe(first.id);
    expect(main.manager.getTargets().some((target) => target.id === first.id)).toBeFalse();
    expect(main.manager.getJobs().find((entry) => entry.targetId === first.id)).toBe(job);
    const choices = main.manager.getTargets().map((target) => target.id);
    main.ensurePanel().selectJob(job);
    expect(main.manager.getTargets().map((target) => target.id)).toEqual(choices);
    expect(main.manager.getJobs().length).toBe(1);
    expect(await main.runTarget(first)).toBeNull();
  });

  it("uses the provider's canonical root for included-source target identity", async () => {
    const root = path.join(roots[0], "current.txt");
    registerDocumentProvider({ resolve: () => root });
    await main.refreshTargets();
    const original = main.manager.getTargets().find((target) => target.providerId === "document");
    const job = await main.runTarget(original);
    await job.completion;
    await focusSource(roots[0], "included.txt");
    const current = main.manager.getTargets().find((target) => target.providerId === "document");
    expect(current.canonicalPath).toBe(root);
    expect(current.id).toBe(original.id);
    expect(main.manager.getJobs({ providerId: "document" })).toEqual([job]);
  });

  it("keeps the center document's target available while the Tasks panel has focus", async () => {
    registerDocumentProvider();
    await main.refreshTargets();
    const target = main.manager
      .getTargets()
      .find((candidate) => candidate.providerId === "document");
    const crawl = spyOn(lumine.project, "crawl").and.callThrough();
    const panel = main.ensurePanel();
    await panel.show();
    panel.focus();
    expect(panel.element.contains(document.activeElement)).toBe(true);
    await main.refreshTargets({ reloadConfig: false });
    expect(main.manager.getTargets().some((candidate) => candidate.id === target.id)).toBe(true);
    expect(crawl).not.toHaveBeenCalled();
    const job = await main.runTarget(target);
    await job.completion;
    expect(job.filePath).toBe(path.join(roots[0], "current.txt"));
    expect(job.stdout).toBe("current.txt");
  });

  it("opens the task picker without execution and runs only the explicitly chosen task", async () => {
    configure(roots[0], [command("First", "one"), command("Second", "two")]);
    await main.refreshTargets();
    const run = spyOn(main, "runTarget").and.callThrough();
    await main.selectTask();
    const picker = main.selectListHost.getModel();
    expect(main.selectListHost.isVisible()).toBe(true);
    expect(picker.getItems().length).toBe(2);
    expect(main.manager.getJobs().length).toBe(0);
    expect(run).not.toHaveBeenCalled();
    const index = picker.getItems().findIndex((target) => target.name === "Second");
    const chosen = picker.getItems()[index];
    await picker.selectIndex(index);
    await picker.runAction("tasks:choose-task");
    expect(run).toHaveBeenCalledTimes(1);
    const requested = run.calls.mostRecent().args[0];
    expect(typeof requested === "string" ? requested : requested.id).toBe(chosen.id);
    const job = main.manager.getJobs()[0];
    await job.completion;
    expect(job.stdout).toBe("two");
    expect(main.selectListHost.isVisible()).toBe(false);
    await main.selectTask();
    expect(main.manager.getJobs().length).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reads fresh task definitions whenever the picker is opened again", async () => {
    configure(roots[0], [command("Original", "old")]);
    await main.selectTask();
    const host = main.selectListHost;
    const picker = host.getModel();
    expect(picker.getItems().map((item) => item.name)).toEqual(["Original"]);
    await host.hide();
    configure(roots[0], [command("Updated", "new")]);
    await main.selectTask();
    expect(main.selectListHost).toBe(host);
    expect(picker.getItems().map((item) => item.name)).toEqual(["Updated"]);
    expect(main.manager.getJobs()).toEqual([]);
  });

  it("offers a local refresh action even when the task list is empty", async () => {
    await main.selectTask();
    const picker = main.selectListHost.getModel();
    expect(picker.getItems()).toEqual([]);
    const refresh = picker
      .getAvailableActions()
      .find((action) => action.command === "tasks:refresh-tasks");
    expect(refresh.context).toBe("dialog");
    expect(refresh.keystrokes).toEqual(["f5"]);
    expect(
      lumine.commands.canDispatch(lumine.workspace.getElement(), "tasks:refresh-tasks"),
    ).toBeFalse();
    expect(
      lumine.commands.canDispatch(lumine.workspace.getElement(), "tasks:refresh-targets"),
    ).toBeFalse();
    configure(roots[0], [command("Discovered", "new")]);
    await picker.runAction("tasks:refresh-tasks");
    expect(picker.getItems().map((item) => item.name)).toEqual(["Discovered"]);
    expect(main.selectListHost.isVisible()).toBeTrue();
    expect(main.manager.getJobs()).toEqual([]);
  });

  it("reloads with F5 inside the picker while preserving the query and execution history", async () => {
    configure(roots[0], [command("Tasks One", "one")]);
    await main.refreshTargets();
    const job = await main.runTarget(main.targets[0]);
    await job.completion;
    await main.selectTask();
    const picker = main.selectListHost.getModel();
    await picker.setQuery("Tasks");
    const input = picker.getQueryEditor().getElement();
    const reload = spyOn(picker, "reload").and.callThrough();
    configure(roots[0], [command("Tasks One", "one"), command("Tasks Two", "two")]);
    lumine.keymaps.handleKeyboardEvent(
      lumine.keymaps.constructor.buildKeydownEvent("f5", { target: input }),
    );
    await conditionPromise(() => reload.calls.count() === 1, "the task picker refresh key binding");
    await reload.calls.mostRecent().returnValue;
    expect(picker.getQuery()).toBe("Tasks");
    expect(picker.getItems().map((item) => item.name)).toEqual(["Tasks One", "Tasks Two"]);
    expect(main.selectListHost.isVisible()).toBeTrue();
    expect(main.manager.getJobs()).toEqual([job]);
    expect(job.log.getText()).toContain("one");
    expect(
      lumine.keymaps.findKeyBindings({
        target: lumine.workspace.getElement(),
        command: "tasks:refresh-tasks",
      }),
    ).toEqual([]);
  });

  it("retires removed config commands while preserving completed tasks and logs", async () => {
    const configPath = configure(roots[0], [
      command("Retained", "retained", { commandName: "tasks:catalog-task" }),
    ]);
    await main.refreshTargets();
    const target = main.manager.getTargets()[0];
    const job = await main.runTarget(target);
    await job.completion;
    expect(lumine.commands.canDispatch(lumine.workspace.getElement(), "tasks:catalog-task")).toBe(
      true,
    );
    fs.unlinkSync(configPath);
    await main.refreshTargets();
    expect(main.manager.getTargets().some((candidate) => candidate.id === target.id)).toBe(false);
    expect(lumine.commands.canDispatch(lumine.workspace.getElement(), "tasks:catalog-task")).toBe(
      false,
    );
    const historical = main.manager.getJobs().find((entry) => entry.targetId === target.id);
    expect(historical).toBe(job);
    expect(historical.state).toBe("passed");
    expect(job.log.getText()).toContain("retained");
    const count = main.manager.getJobs().length;
    expect(await main.runTarget(target)).toBeNull();
    expect(main.manager.getJobs().length).toBe(count);
  });

  it("lets a running removed config task finish under its original provider", async () => {
    const configPath = configure(roots[0], [
      {
        name: "Held",
        cmd: "node",
        args: ["-e", "console.log('started');setTimeout(()=>{},5000)"],
      },
    ]);
    await main.refreshTargets();
    const target = main.manager.getTargets()[0];
    const job = await main.runTarget(target);
    await conditionPromise(
      () => job.stdout.includes("started"),
      "configured process started",
      10000,
    );
    fs.unlinkSync(configPath);
    await main.refreshTargets();
    expect(main.isActive(job)).toBe(true);
    expect(main.manager.getTargets().some((candidate) => candidate.id === target.id)).toBeFalse();
    expect(main.manager.providers.has(target.providerId)).toBe(true);
    job.stop();
    await job.completion;
    await conditionPromise(
      () => !main.manager.providers.has(target.providerId),
      "removed provider retired",
      10000,
    );
    expect(main.manager.getJobs().find((entry) => entry.targetId === target.id)).toBe(job);
    expect(job.state).toBe("cancelled");
  });

  it("keeps a running plan snapshot while the same target definition changes", async () => {
    configure(roots[0], [
      {
        name: "Snapshot",
        cmd: "node",
        args: ["-e", "console.log('started');setTimeout(()=>process.stdout.write('old'),150)"],
      },
    ]);
    await main.refreshTargets();
    const target = main.manager.getTargets()[0];
    const first = await main.runTarget(target);
    await conditionPromise(
      () => first.stdout.includes("started"),
      "snapshot process started",
      10000,
    );
    configure(roots[0], [command("Snapshot", "new")]);
    await main.refreshTargets();
    expect(main.manager.getTargets()[0].id).toBe(target.id);
    await first.completion;
    expect(first.stdout).toBe("started\nold");
    const second = await main.runTarget(target);
    await second.completion;
    expect(second.stdout).toBe("new");
    expect(second.targetId).toBe(first.targetId);
    const history = main.manager.getLogs().filter((job) => job.targetId === target.id);
    expect(history).toEqual([second, first]);
  });
});
