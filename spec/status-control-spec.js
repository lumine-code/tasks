const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

describe("Shared Tasks status control", () => {
  let main, bar, directory, source, leases, children;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const status = await lumine.packages.activatePackage("status-bar");
    bar = status.mainModule.statusBar;
    lumine.config.set("tasks.statusBar", true);
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-indicator-"));
    source = path.join(directory, "source.txt");
    fs.writeFileSync(source, "source\n");
    leases = [];
    children = [];
    const realSpawn = childProcess.spawn.bind(childProcess);
    spyOn(childProcess, "spawn").and.callFake((command, args, options) => {
      if (command !== "fixture") return realSpawn(command, args, options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        child.emit("close", null, "SIGTERM");
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
      !path.basename(owned).startsWith("tasks-indicator-")
    )
      throw new Error("Unsafe indicator fixture cleanup.");
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const tiles = () =>
    bar.getLeftTiles().filter((tile) => tile.getItem().matches?.(".tasks-status"));
  function provider(id, options = {}) {
    leases.push(
      main.manager.registerProvider({
        id,
        name: id,
        supports: () => true,
        prepare: () => ({ cmd: "fixture", cwd: directory, args: [] }),
        ...options,
      }),
    );
  }
  async function complete(id = "first", code = 0) {
    const job = main.manager.run({ providerId: id, filePath: source });
    await started(job);
    job.process.emit("close", code, null);
    await job.completion;
    return job;
  }
  const started = (job) =>
    window.conditionPromise(() => Boolean(job.process), "the status fixture to start");

  it("owns one themed tools icon across multiple document providers", () => {
    provider("first");
    provider("second");
    expect(tiles().length).toBe(1);
    const element = tiles()[0].getItem();
    expect(element.tagName).toBe("STATUS-BAR-TILE");
    expect(element.classList.contains("status-bar-item")).toBeTrue();
    expect(element.querySelector(".icon-tools.is-icon-only")).not.toBeNull();
    expect(element.getAttribute("role")).toBe("button");
    expect(element.tabIndex).toBe(0);
    expect(main.statusNewIndicator.tagName).toBe("SUP");
    expect(main.statusNewIndicator.textContent).toBe("");
    expect(main.statusObservedCount.tagName).toBe("SUB");
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.statusObservedCount.hidden).toBeTrue();
    expect(element.dataset.state).toBe("idle");
    expect(element.dataset.running).toBe("false");
    const commands = lumine.contextMenu.templateForElement(element).map((item) => item.command);
    expect(commands.slice(0, 2)).toEqual(["tasks:toggle", "tasks:toggle-focus"]);
    expect(commands).not.toContain("tasks:show-tasks");
    expect(commands).not.toContain("tasks:toggle-panel");
    expect(commands).not.toContain("tasks:refresh-targets");
    expect(commands).not.toContain("tasks:refresh-tasks");
  });

  it("adds only the focus shortcut and follows keymap overrides when reopened", () => {
    const [tooltip] = lumine.tooltips.findTooltips(main.statusElement);
    const content = () => {
      const element = document.createElement("div");
      element.innerHTML = tooltip.getTitle();
      return element;
    };
    const label = process.platform === "darwin" ? "⌥B" : "Alt+B";
    expect(content().textContent).toBe(`${main.statusDescription} ${label}`);
    expect(content().querySelector(".keystroke").textContent).toBe(label);
    const keys = lumine.keymaps.add("tasks-status-tooltip-spec", {
      ".tasks-status": { "alt-b": "native!", "alt-shift-b": "tasks:toggle-focus" },
    });
    try {
      expect(content().querySelector(".keystroke").textContent).toBe(
        process.platform === "darwin" ? "⌥⇧B" : "Alt+Shift+B",
      );
    } finally {
      keys.dispose();
    }
    expect(content().querySelector(".keystroke").textContent).toBe(label);
  });

  it("dispatches toggle on click and hides the panel on another click without toggling focus", async () => {
    const dispatch = spyOn(lumine.commands, "dispatch").and.callThrough();
    const toggleCall = () =>
      dispatch.calls
        .all()
        .filter((call) => call.args[1] === "tasks:toggle")
        .at(-1);
    const focus = spyOn(main, "toggleFocus").and.callThrough();
    const select = spyOn(main, "selectTask").and.callThrough();
    main.statusElement.click();
    await toggleCall().returnValue;
    const panel = main.ensurePanel();
    expect(lumine.workspace.getBottomDock().isVisible()).toBeTrue();
    expect(lumine.workspace.getBottomDock().getActivePaneItem()).toBe(panel);
    main.statusElement.click();
    await toggleCall().returnValue;
    expect(lumine.workspace.getBottomDock().isVisible()).toBeFalse();
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(
      lumine.workspace
        .getBottomDock()
        .getPaneItems()
        .filter((item) => item === panel).length,
    ).toBe(1);
  });

  it("toggles the Tasks view through the two public visibility commands", async () => {
    const workspace = lumine.workspace.getElement();
    expect(lumine.commands.canDispatch(workspace, "tasks:show-tasks")).toBeFalse();
    expect(lumine.commands.canDispatch(workspace, "tasks:toggle-panel")).toBeFalse();
    await lumine.commands.dispatch(workspace, "tasks:toggle");
    const panel = main.ensurePanel();
    const dock = lumine.workspace.getBottomDock();
    expect(dock.getActivePaneItem()).toBe(panel);
    expect(dock.isVisible()).toBeTrue();
    await lumine.commands.dispatch(workspace, "tasks:toggle");
    expect(dock.isVisible()).toBeFalse();
    await lumine.commands.dispatch(workspace, "tasks:toggle");
    expect(main.ensurePanel()).toBe(panel);
    expect(dock.isVisible()).toBeTrue();
  });

  it("toggles focus with Alt+B between Tasks and the center editor without hiding the panel", async () => {
    const editor = await lumine.workspace.open(source);
    try {
      const toggle = spyOn(main, "toggleFocus").and.callThrough();
      lumine.keymaps.handleKeyboardEvent(
        lumine.keymaps.constructor.buildKeydownEvent("b", {
          alt: true,
          target: editor.getElement(),
        }),
      );
      expect(toggle).toHaveBeenCalledTimes(1);
      await toggle.calls.mostRecent().returnValue;
      const panel = main.ensurePanel();
      expect(panel.element.contains(document.activeElement)).toBeTrue();
      lumine.keymaps.handleKeyboardEvent(
        lumine.keymaps.constructor.buildKeydownEvent("b", {
          alt: true,
          target: panel.element,
        }),
      );
      expect(toggle).toHaveBeenCalledTimes(2);
      await toggle.calls.mostRecent().returnValue;
      expect(editor.getElement().contains(document.activeElement)).toBeTrue();
      expect(lumine.workspace.getBottomDock().isVisible()).toBeTrue();
    } finally {
      editor.destroy();
    }
  });

  it("dispatches toggle with Enter and Space", () => {
    const dispatch = spyOn(lumine.commands, "dispatch").and.resolveTo();
    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      main.statusElement.dispatchEvent(event);
      expect(event.defaultPrevented).toBeTrue();
    }
    expect(dispatch).toHaveBeenCalledTimes(2);
    for (const [target, command] of dispatch.calls.allArgs()) {
      expect(target).toBe(main.statusElement);
      expect(command).toBe("tasks:toggle");
    }
  });

  it("aggregates provider activity and observation without adding extra controls", async () => {
    provider("first");
    provider("second");
    main.manager.setObserved({ providerId: "first", filePath: source }, true);
    main.manager.setObserved({ providerId: "second", filePath: source }, true);
    const first = main.manager.run({ providerId: "first", filePath: source });
    const second = main.manager.run({ providerId: "second", filePath: source });
    expect(main.statusElement.dataset.running).toBe("true");
    await Promise.all([started(first), started(second)]);
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.statusElement.dataset.state).toBe("idle");
    expect(main.statusElement.dataset.observed).toBe("1");
    expect(main.statusObservedCount.textContent).toBe("1");
    expect(main.statusObservedCount.hidden).toBeFalse();
    expect(main.statusElement.getAttribute("aria-label")).toContain(
      "2 active tasks, 1 observed document",
    );
    expect(tiles().length).toBe(1);
    first.process.emit("close", 1, null);
    await first.completion;
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusElement.dataset.state).toBe("failed");
    expect(main.statusElement.dataset.running).toBe("true");
    second.process.emit("close", 0, null);
    await second.completion;
    expect(main.statusElement.dataset.new).toBe("2");
    expect(main.statusElement.dataset.state).toBe("failed");
    expect(main.statusElement.dataset.running).toBe("false");
    expect(main.statusIcon.classList.contains("is-icon-only")).toBeTrue();
    main.manager.clearObserved();
    expect(main.statusElement.dataset.observed).toBe("0");
    expect(main.statusObservedCount.hidden).toBeTrue();
  });

  it("acknowledges all new logs when the history list opens and keeps retained failures neutral afterwards", async () => {
    provider("first");
    const iconColor = getComputedStyle(main.statusIcon).color;
    const passed = await complete();
    expect(main.statusElement.dataset.state).toBe("passed");
    const passedColor = getComputedStyle(main.statusNewIndicator).color;
    const cancelled = main.manager.run({ providerId: "first", filePath: source });
    await started(cancelled);
    cancelled.stop();
    await cancelled.completion;
    expect(main.statusElement.dataset.state).toBe("cancelled");
    const cancelledColor = getComputedStyle(main.statusNewIndicator).color;
    expect(cancelledColor).not.toBe(passedColor);
    const failed = await complete("first", 1);
    expect(main.statusElement.dataset.new).toBe("3");
    expect(main.statusElement.dataset.state).toBe("failed");
    expect(getComputedStyle(main.statusNewIndicator).color).not.toBe(cancelledColor);
    expect(getComputedStyle(main.statusIcon).color).toBe(iconColor);
    expect(main.statusNewIndicator.textContent).toBe("3");
    expect(main.statusElement.getAttribute("aria-label")).toContain(
      "3 new logs: 1 failed, 1 cancelled, 1 passed.",
    );
    await main.ensurePanel().show();
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.statusNewIndicator.textContent).toBe("");
    expect(main.statusElement.dataset.state).toBe("idle");
    expect(getComputedStyle(main.statusIcon).color).toBe(iconColor);
    expect(main.manager.getJobs()).toEqual([passed, cancelled, failed]);
    main.panel.hide();
    expect(main.statusElement.dataset.state).toBe("idle");
    main.manager.removeLog(passed.id);
    expect(main.statusElement.dataset.state).toBe("idle");
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.manager.getJobs()).toEqual([cancelled, failed]);
  });

  it("reads only visible execution details and acknowledges the remaining results on Back", async () => {
    provider("first");
    const passed = await complete();
    const cancelled = main.manager.run({ providerId: "first", filePath: source });
    await started(cancelled);
    cancelled.stop();
    await cancelled.completion;
    const failed = await complete("first", 1);
    const originalLogs = [passed, cancelled, failed].map((job) => job.log.getText());
    const failedColor = getComputedStyle(main.statusNewIndicator).color;
    expect(main.statusElement.dataset.new).toBe("3");
    expect(main.statusElement.dataset.state).toBe("failed");

    const panel = main.ensurePanel();
    expect(panel.showJob(failed.id)).toBeTrue();
    expect(main.isTasksPanelVisible()).toBeFalse();
    expect(main.statusElement.dataset.new).toBe("3");
    await panel.show();

    expect(panel.getSelectedJob()).toBe(failed);
    expect(main.statusElement.dataset.new).toBe("2");
    expect(main.statusNewIndicator.textContent).toBe("2");
    expect(main.statusElement.dataset.state).toBe("cancelled");
    const cancelledColor = getComputedStyle(main.statusNewIndicator).color;
    expect(cancelledColor).not.toBe(failedColor);
    panel.showJob(passed.id);
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusElement.dataset.state).toBe("cancelled");

    const later = await complete("first", 1);
    const laterLog = later.log.getText();
    expect(panel.getSelectedJob()).toBe(passed);
    expect(main.statusElement.dataset.new).toBe("2");
    expect(main.statusNewIndicator.textContent).toBe("2");
    expect(main.statusElement.dataset.state).toBe("failed");
    expect(getComputedStyle(main.statusNewIndicator).color).toBe(failedColor);
    panel.showJob(cancelled.id);
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusElement.dataset.state).toBe("failed");

    panel.backButton.click();

    expect(panel.mode).toBe("list");
    expect(main.statusElement.dataset.new).toBe("0");
    expect(main.statusElement.dataset.state).toBe("idle");
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.manager.getJobs()).toEqual([passed, cancelled, failed, later]);
    expect(main.manager.getJobs().map((job) => job.log.getText())).toEqual([
      ...originalLogs,
      laterLog,
    ]);
    for (const job of main.manager.getJobs()) expect(job.log.destroyed).toBeFalse();
  });

  it("acknowledges a restored visible history list without requiring panel focus", async () => {
    provider("first");
    const editor = await lumine.workspace.open(source);
    try {
      const first = await complete("first", 1);
      const second = await complete();
      const panel = main.deserializeTasksPanel();
      expect(panel.mode).toBe("list");
      expect(main.statusElement.dataset.new).toBe("2");

      await lumine.workspace.open(panel, {
        location: "bottom",
        activatePane: false,
        pending: false,
      });
      lumine.workspace.getBottomDock().show();
      editor.getElement().focus();

      expect(main.isTasksPanelVisible()).toBeTrue();
      expect(panel.element.contains(document.activeElement)).toBeFalse();
      expect(main.statusElement.dataset.new).toBe("0");
      expect(main.statusNewIndicator.hidden).toBeTrue();
      expect(main.manager.getJobs()).toEqual([first, second]);
    } finally {
      editor.destroy();
    }
  });

  it("clears completed logs from the status menu without creating a panel or stopping active work", async () => {
    provider("first");
    const dock = lumine.workspace.getBottomDock();
    dock.hide();
    const ensurePanel = spyOn(main, "ensurePanel").and.callThrough();
    const command = "tasks:clear-logs";
    const menu = lumine.contextMenu.templateForElement(main.statusElement);
    expect(menu.find((item) => item.command === command).label).toBe("Clear All Logs");
    expect(lumine.commands.canDispatch(main.statusElement, command)).toBeFalse();
    const passed = await complete();
    const failed = await complete("first", 1);
    const cancelled = main.manager.run({ providerId: "first", filePath: source });
    await started(cancelled);
    cancelled.stop();
    await cancelled.completion;

    let releasePreparation, releaseCollection;
    provider("preparing", {
      prepare: () => new Promise((resolve) => (releasePreparation = resolve)),
    });
    provider("collecting", {
      collectResult: () => new Promise((resolve) => (releaseCollection = resolve)),
    });
    const preparing = main.manager.run({ providerId: "preparing", filePath: source });
    const running = main.manager.run({ providerId: "first", filePath: source });
    const collecting = main.manager.run({ providerId: "collecting", filePath: source });
    const active = [preparing, running, collecting];
    try {
      await window.conditionPromise(
        () => Boolean(collecting.process),
        "the collecting fixture to start",
      );
      collecting.process.emit("close", 0, null);
      await window.conditionPromise(
        () => Boolean(releaseCollection),
        "the result collector to wait",
      );
      expect(active.map((job) => job.state)).toEqual(["preparing", "running", "collecting"]);
      expect(lumine.commands.canDispatch(main.statusElement, command)).toBeTrue();
      expect(main.statusElement.dataset.new).toBe("3");

      await lumine.commands.dispatch(main.statusElement, command);

      expect(main.manager.getJobs()).toEqual(active);
      for (const job of [passed, failed, cancelled]) expect(job.log.destroyed).toBeTrue();
      expect(active.map((job) => job.state)).toEqual(["preparing", "running", "collecting"]);
      expect(lumine.commands.canDispatch(main.statusElement, command)).toBeFalse();
      expect(main.statusNewIndicator.hidden).toBeTrue();
      expect(main.statusElement.dataset.running).toBe("true");
      expect(main.panel).toBeNull();
      expect(ensurePanel).not.toHaveBeenCalled();
      expect(dock.isVisible()).toBeFalse();
    } finally {
      main.manager.stopAll();
      releasePreparation?.({ cmd: "fixture", cwd: directory, args: [] });
      releaseCollection?.({});
      await Promise.all(active.map((job) => job.completion));
    }
  });

  it("keeps service-started provider results in the background", async () => {
    provider("first");
    const ensurePanel = spyOn(main, "ensurePanel").and.callThrough();
    const job = await complete("first", 1);
    expect(ensurePanel).not.toHaveBeenCalled();
    expect(main.isTasksPanelVisible()).toBeFalse();
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusElement.dataset.state).toBe("failed");
    expect(main.manager.getJobs()).toEqual([job]);
  });

  it("keeps external observed-file changes in the background", async () => {
    provider("first");
    const handles = [];
    const watchFile = lumine.fileWatchClient.watchFile.bind(lumine.fileWatchClient);
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((filePath) => {
      const handle = watchFile(filePath);
      if (filePath === source) handles.push(handle);
      return handle;
    });
    main.manager.setObserved({ providerId: "first", filePath: source }, true);
    expect(handles.length).toBe(1);
    await handles[0].ready;
    const ensurePanel = spyOn(main, "ensurePanel").and.callThrough();
    fs.writeFileSync(source, "changed externally\n");
    await window.conditionPromise(() => children.length === 1, "an observed build to start");
    const [job] = main.manager.getJobs();
    expect(job.reason).toBe("save");
    expect(main.statusElement.dataset.running).toBe("true");
    expect(ensurePanel).not.toHaveBeenCalled();
    children[0].emit("close", 1, null);
    await job.completion;
    expect(ensurePanel).not.toHaveBeenCalled();
    expect(main.isTasksPanelVisible()).toBeFalse();
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusElement.dataset.state).toBe("failed");
    expect(main.statusObservedCount.textContent).toBe("1");
    expect(main.manager.getJobs()).toEqual([job]);
  });

  it("shows no new-log color or count for completions while the history list is visible", async () => {
    provider("first");
    await main.ensurePanel().show();
    const failed = await complete("first", 1);
    const passed = await complete();
    expect(main.manager.getJobs()).toEqual([failed, passed]);
    expect(main.statusElement.dataset.state).toBe("idle");
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.statusElement.dataset.running).toBe("false");
    main.panel.hide();
    await complete();
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusElement.dataset.state).toBe("passed");
  });

  it("counts a cancelled completion once and does not count individual output chunks", async () => {
    provider("first");
    const job = main.manager.run({ providerId: "first", filePath: source });
    await started(job);
    children[0].stdout.emit("data", Buffer.from("one"));
    children[0].stdout.emit("data", Buffer.from("two"));
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.statusElement.dataset.running).toBe("true");
    job.stop();
    await job.completion;
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusElement.dataset.state).toBe("cancelled");
    expect(main.statusElement.dataset.running).toBe("false");
    main.manager.removeLog(job.id);
    expect(main.statusNewIndicator.hidden).toBeTrue();
    expect(main.statusElement.dataset.state).toBe("idle");
  });

  it("acknowledges new logs when returning to the Tasks tab in an already open dock", async () => {
    provider("first");
    await main.ensurePanel().show();
    const panel = main.panel;
    const otherElement = document.createElement("div");
    const other = {
      getTitle: () => "Other",
      getElement: () => otherElement,
      getDefaultLocation: () => "bottom",
      getAllowedLocations: () => ["bottom"],
    };
    await lumine.workspace.open(other, { location: "bottom", activatePane: false });
    try {
      expect(lumine.workspace.getBottomDock().isVisible()).toBeTrue();
      expect(main.isTasksPanelVisible()).toBeFalse();
      await complete("first", 1);
      expect(main.statusElement.dataset.new).toBe("1");
      lumine.workspace.paneForItem(panel).activateItem(panel);
      expect(main.statusNewIndicator.hidden).toBeTrue();
      expect(main.statusElement.dataset.state).toBe("idle");
    } finally {
      await lumine.workspace.paneForItem(other)?.destroyItem(other, true);
    }
  });

  it("treats Tasks as visible in a split dock even when another pane is active", async () => {
    provider("first");
    await main.ensurePanel().show();
    const otherElement = document.createElement("div");
    const other = {
      getTitle: () => "Other",
      getElement: () => otherElement,
      getDefaultLocation: () => "bottom",
      getAllowedLocations: () => ["bottom"],
    };
    const otherPane = lumine.workspace.paneForItem(main.panel).splitRight({ items: [other] });
    otherPane.activate();
    try {
      expect(lumine.workspace.getBottomDock().getActivePaneItem()).toBe(other);
      expect(main.isTasksPanelVisible()).toBeTrue();
      await complete("first", 1);
      expect(main.statusNewIndicator.hidden).toBeTrue();
      expect(main.statusElement.dataset.state).toBe("idle");
    } finally {
      otherPane.destroy();
    }
  });

  it("reads only the selected details in a split dock without requiring their pane to be active", async () => {
    provider("first");
    const first = await complete("first", 1);
    const second = await complete();
    const panel = main.ensurePanel();
    panel.showJob(first.id);
    await panel.show();
    expect(main.statusElement.dataset.new).toBe("1");
    expect(main.statusElement.dataset.state).toBe("passed");
    const otherElement = document.createElement("div");
    const other = {
      getTitle: () => "Other",
      getElement: () => otherElement,
      getDefaultLocation: () => "bottom",
      getAllowedLocations: () => ["bottom"],
    };
    const otherPane = lumine.workspace.paneForItem(panel).splitRight({ items: [other] });
    otherPane.activate();
    try {
      expect(main.isTasksPanelVisible()).toBeTrue();
      expect(lumine.workspace.getBottomDock().getActivePaneItem()).toBe(other);

      panel.showJob(second.id);

      expect(lumine.workspace.getBottomDock().getActivePaneItem()).toBe(other);
      expect(main.statusNewIndicator.hidden).toBeTrue();
      const later = await complete("first", 1);
      expect(panel.getSelectedJob()).toBe(second);
      expect(main.statusElement.dataset.new).toBe("1");
      expect(main.statusElement.dataset.state).toBe("failed");
      expect(main.manager.getJobs()).toEqual([first, second, later]);
    } finally {
      otherPane.destroy();
    }
  });

  it("keeps its icon when disabled and re-enabled without registering another tile", () => {
    const element = main.statusElement;
    lumine.config.set("tasks.statusBar", false);
    expect(tiles().length).toBe(0);
    lumine.config.set("tasks.statusBar", true);
    expect(tiles().map((tile) => tile.getItem())).toEqual([element]);
  });

  it("leaves old icon callbacks inert after a new activation starts", async () => {
    const oldElement = main.statusElement;
    await lumine.packages.deactivatePackage("tasks");
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    const dispatch = spyOn(lumine.commands, "dispatch").and.resolveTo();
    oldElement.click();
    oldElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(dispatch).not.toHaveBeenCalled();
    main.statusElement.click();
    expect(dispatch).toHaveBeenCalledOnceWith(main.statusElement, "tasks:toggle");
    expect(tiles().length).toBe(1);
  });

  it("targets the focused history row when a workspace action is dispatched", async () => {
    provider("first");
    const first = main.manager.run({ providerId: "first", filePath: source });
    await started(first);
    children[0].stdout.emit("data", Buffer.from("first output"));
    children[0].emit("close", 0, null);
    await first.completion;
    const second = main.manager.run({ providerId: "first", filePath: source });
    await started(second);
    children[1].stdout.emit("data", Buffer.from("second output"));
    const panel = main.ensurePanel();
    await panel.show();
    const firstRow = panel.rows.get(first.id).element;
    const secondRow = panel.rows.get(second.id).element;
    expect(lumine.commands.canDispatch(firstRow, "tasks:stop")).toBeFalse();
    expect(lumine.commands.canDispatch(secondRow, "tasks:stop")).toBeTrue();
    expect(lumine.commands.canDispatch(firstRow, "tasks:clear")).toBeFalse();
    expect(lumine.commands.canDispatch(firstRow, "tasks:clear-log")).toBeFalse();
    expect(first.log.getText()).toContain("first output");
    expect(second.log.getText()).toContain("second output");
    lumine.commands.dispatch(secondRow, "tasks:stop");
    await second.completion;
    expect(second.state).toBe("cancelled");
  });
});
