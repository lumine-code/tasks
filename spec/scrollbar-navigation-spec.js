const fs = require("node:fs");
const path = require("node:path");
const { Emitter } = require("lumine");
const { ipcRenderer } = require("electron");

describe("Tasks scrollbar navigation", () => {
  let panel, events, jobs, outputs, manager, controllers, stylesheet, actions, bindings;

  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("tasks.scrollToEnd", false);
    bindings = lumine.keymaps.add(
      "tasks-scrollbar-keyboard-spec",
      lumine.keymaps.readKeymap(path.join(__dirname, "../keymaps/main.json")),
    );
    const TasksPanel = require("../lib/tasks-panel");
    const TaskOutput = require("../lib/task-output");
    events = new Emitter();
    const definition = {
      id: "scrollbar-task",
      providerId: "scrollbar-fixture",
      name: "Compile",
      filePath: path.resolve("scrollbar-fixture.source"),
    };
    jobs = Array.from({ length: 24 }, (_, index) => {
      const log = new TaskOutput();
      log.start(definition.name);
      log.append(Array.from({ length: 60 }, (_, line) => `Output ${line}`).join("\n"));
      log.finish("passed");
      return {
        id: String(index),
        targetId: definition.id,
        providerId: definition.providerId,
        filePath: definition.filePath,
        name: definition.name,
        startedAt: index * 1000,
        elapsedTime: 100,
        state: "passed",
        log,
        stop: jasmine.createSpy("stop"),
      };
    });
    outputs = jobs.map((job) => job.log);
    manager = {
      getTargets: () => [definition],
      getJobs: () => jobs.slice(),
      getActions: () => [],
      onDidChangeTargets: (callback) => events.on("targets", callback),
      onDidChangeJob: (callback) => events.on("change", callback),
      onDidFinishJob: (callback) => events.on("finish", callback),
      onDidChangeProviders: (callback) => events.on("providers", callback),
      removeLog: jasmine.createSpy("removeLog"),
    };
    actions = { runTarget: jasmine.createSpy("runTarget") };
    panel = new TasksPanel(manager, actions);
    stylesheet = document.createElement("style");
    stylesheet.textContent = fs.readFileSync(path.join(__dirname, "../styles/main.css"), "utf8");
    document.head.append(stylesheet);
    const fixture = document.createElement("div");
    fixture.style.cssText = "width:1100px;height:320px;position:relative";
    fixture.append(panel.element);
    jasmine.attachToDOM(fixture);
    controllers = [panel.list, panel.output].map((element) =>
      lumine.scrollbars.attach(element, {
        kind: "panel",
        layout: "overlay",
        policy: "hover",
        focusOwner: panel.element,
      }),
    );
    await window.waitForFrames(
      () =>
        controllers[0].publicGeometry?.canScrollVertically &&
        controllers[0].geometry.visible &&
        controllers[1].geometry?.visible === false,
      { description: "the visible history and hidden output scrollports to be measured" },
    );
  });

  afterEach(() => {
    panel?.destroy();
    for (const controller of controllers ?? []) controller.dispose();
    stylesheet?.remove();
    bindings?.dispose();
    document.getSelection().removeAllRanges();
    events?.dispose();
    for (const output of outputs ?? []) output.destroy();
  });

  function row() {
    return panel.list.firstElementChild;
  }

  async function expectActivity(controller) {
    await window.waitForFrames(() => controller.activity?.active, {
      description: "handled navigation to reveal the newly visible scrollport",
    });
    expect(controller.layer.classList.contains("is-revealed")).toBeTrue();
  }

  async function focusForKeyboard(element) {
    await ipcRenderer.invoke("lumine:window", "focus");
    await window.waitForFrames(() => document.hasFocus(), {
      description: "trusted Tasks keyboard input to belong to the spec window",
    });
    element.focus({ preventScroll: true });
    expect(document.activeElement).toBe(element);
  }

  async function key(keyCode, modifiers = [], character = false) {
    for (const type of character ? ["keyDown", "char", "keyUp"] : ["keyDown", "keyUp"])
      await ipcRenderer.invoke("lumine:window", "sendInputEvent", { type, keyCode, modifiers });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function showOutput() {
    panel.showJob(row().dataset.jobId);
    await window.waitForFrames(() => controllers[1].publicGeometry?.canScrollVertically, {
      description: "the selected log to have measured overflowing content",
    });
    await focusForKeyboard(panel.output);
  }

  it("handles physical history arrows and Enter, including the unchanged first-row boundary", async () => {
    const rows = [...panel.list.children];
    await focusForKeyboard(panel.list);
    const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();
    const top = panel.list.scrollTop;

    await key("Down");
    expect(document.activeElement).toBe(rows[0]);
    expect(panel.list.scrollTop).toBe(top);
    expect(reveal).toHaveBeenCalledOnceWith(panel.list);
    await expectActivity(controllers[0]);

    controllers[0].activity.clear();
    reveal.calls.reset();
    await key("Up");
    expect(document.activeElement).toBe(rows[0]);
    expect(panel.list.scrollTop).toBe(top);
    expect(reveal).toHaveBeenCalledOnceWith(panel.list);
    await expectActivity(controllers[0]);

    await key("Down");
    expect(document.activeElement).toBe(rows[1]);
    reveal.calls.reset();
    await key("Enter");
    expect(panel.mode).toBe("details");
    expect(panel.selectedJob.id).toBe(rows[1].dataset.jobId);
    expect(reveal).toHaveBeenCalledOnceWith(panel.output);
    await expectActivity(controllers[1]);
  });

  const logKeys = [
    ["Up", [], -1, "line"],
    ["Down", [], 1, "line"],
    ["PageUp", [], -1, "page"],
    ["PageDown", [], 1, "page"],
    [" ", [], 1, "page"],
    [" ", ["shift"], -1, "page"],
    ["Home", [], -1, "edge"],
    ["End", [], 1, "edge"],
    ...(process.platform === "darwin"
      ? [
          ["Up", ["meta"], -1, "edge"],
          ["Down", ["meta"], 1, "edge"],
        ]
      : [
          ["Home", ["control"], -1, "edge"],
          ["End", ["control"], 1, "edge"],
        ]),
  ];
  for (const [keyCode, modifiers, direction, unit] of logKeys) {
    it(`scrolls the log and reveals its unchanged boundary for ${[...modifiers, keyCode === " " ? "Space" : keyCode].join("+")}`, async () => {
      await showOutput();
      const maximum = panel.output.scrollHeight - panel.output.clientHeight;
      panel.output.scrollTop = Math.floor(maximum / 2);
      const start = panel.output.scrollTop;
      controllers[1].activity.clear();
      const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();

      await key(keyCode, modifiers);

      const moved = panel.output.scrollTop;
      if (direction < 0) expect(moved).toBeLessThan(start);
      else expect(moved).toBeGreaterThan(start);
      if (unit === "edge") expect(moved).toBe(direction < 0 ? 0 : maximum);
      expect(reveal).toHaveBeenCalledOnceWith(panel.output);
      await expectActivity(controllers[1]);

      const boundary = direction < 0 ? 0 : maximum;
      panel.output.scrollTop = boundary;
      controllers[1].activity.clear();
      reveal.calls.reset();
      await key(keyCode, modifiers);

      expect(panel.output.scrollTop).toBe(boundary);
      expect(reveal).toHaveBeenCalledOnceWith(panel.output);
      await expectActivity(controllers[1]);
    });
  }

  it("keeps physical header activation and source-link Enter separate from history selection", async () => {
    const header = panel.headers.get("target").button;
    const previousDirection = panel.sortDirection;
    const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();
    await focusForKeyboard(header);

    await key("Down");
    expect(document.activeElement).toBe(header);
    await key("Enter", [], true);
    expect(panel.sortDirection).not.toBe(previousDirection);
    expect(panel.mode).toBe("list");
    expect(reveal).not.toHaveBeenCalled();

    const selected = jobs.find((job) => job.id === row().dataset.jobId);
    const sourceLink = panel.rows.get(selected.id).sourceLink;
    const open = spyOn(lumine.workspace, "open").and.resolveTo();
    await focusForKeyboard(sourceLink);
    await key("Enter");
    expect(open).toHaveBeenCalledOnceWith(selected.filePath, { searchAllPanes: true });
    expect(panel.mode).toBe("list");
    expect(reveal).toHaveBeenCalledOnceWith(panel.list);
  });

  it("leaves log text selection, native copy and details inputs outside navigation activity", async () => {
    await showOutput();
    const text = panel.output.firstChild.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(6, text.length));
    document.getSelection().addRange(range);
    const selected = document.getSelection().toString();
    expect(selected.length).toBeGreaterThan(0);
    const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();

    await key("C", [process.platform === "darwin" ? "meta" : "control"]);
    expect(lumine.clipboard.read()).toBe(selected);
    expect(document.getSelection().toString()).toBe(selected);
    await key("Down", ["shift"]);
    expect(reveal).not.toHaveBeenCalled();

    const input = document.createElement("input");
    input.value = "native text";
    panel.detailsView.append(input);
    await focusForKeyboard(input);
    input.setSelectionRange(0, 0);
    await key("End");
    expect(input.selectionStart).toBe(input.value.length);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("keeps streamed follow-output scrolling quiet without renewing an earlier navigation pulse", async () => {
    await showOutput();
    lumine.config.set("tasks.scrollToEnd", true);
    const controller = controllers[1];
    controller.activity.clear();
    const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();

    panel.model.append("\nNew streamed output\n");
    await window.waitForFrames(
      () => panel.output.scrollTop === panel.output.scrollHeight - panel.output.clientHeight,
      { description: "follow-output to reveal the actual appended log tail" },
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(panel.output.scrollTop).toBeGreaterThan(0);
    expect(reveal).not.toHaveBeenCalled();
    expect(controller.activity.active).toBeFalse();

    await key("End");
    const deadline = controller.activity.deadline;
    panel.model.append("Another streamed output\n");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(reveal).toHaveBeenCalledOnceWith(panel.output);
    expect(controller.activity.deadline).toBe(deadline);
  });

  for (const command of ["tasks:open-details", "core:confirm"]) {
    it(`reveals the newly visible output once for ${command} without scrolling it`, async () => {
      const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();
      const position = [panel.output.scrollTop, panel.output.scrollLeft];

      await lumine.commands.dispatch(row(), command);

      expect(panel.mode).toBe("details");
      expect(reveal).toHaveBeenCalledOnceWith(panel.output);
      await expectActivity(controllers[1]);
      expect([panel.output.scrollTop, panel.output.scrollLeft]).toEqual(position);
    });
  }

  for (const command of ["tasks:back-to-history", "core:cancel"]) {
    it(`reveals the newly visible history once for ${command} without scrolling it`, async () => {
      panel.showJob(row().dataset.jobId);
      await window.waitForFrames(
        () => controllers[1].geometry?.visible && controllers[0].geometry?.visible === false,
        { description: "the output and hidden history geometry to settle before returning" },
      );
      const position = [panel.list.scrollTop, panel.list.scrollLeft];
      const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();

      await lumine.commands.dispatch(panel.output, command);

      expect(panel.mode).toBe("list");
      expect(reveal).toHaveBeenCalledOnceWith(panel.list);
      await expectActivity(controllers[0]);
      expect([panel.list.scrollTop, panel.list.scrollLeft]).toEqual(position);
    });
  }

  it("reveals the output once when a history row is clicked", async () => {
    const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();

    row().click();

    expect(panel.mode).toBe("details");
    expect(reveal).toHaveBeenCalledOnceWith(panel.output);
    await expectActivity(controllers[1]);
  });

  for (const gesture of ["Enter", "Space", "click"]) {
    it(`reveals history once when Back is activated with native ${gesture}`, async () => {
      panel.showJob(row().dataset.jobId);
      await window.waitForFrames(
        () => controllers[1].geometry?.visible && controllers[0].geometry?.visible === false,
        { description: "details to settle before activating the native Back button" },
      );
      if (gesture !== "click") {
        await ipcRenderer.invoke("lumine:window", "focus");
        await window.waitForFrames(() => document.hasFocus(), {
          description: "native keyboard input to belong to the spec window",
        });
        panel.backButton.focus({ preventScroll: true });
        expect(document.activeElement).toBe(panel.backButton);
      }
      const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();

      if (gesture !== "click") {
        for (const type of ["keyDown", "char", "keyUp"])
          await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
            type,
            keyCode: gesture === "Space" ? " " : "Enter",
          });
      } else panel.backButton.click();

      await window.waitForFrames(() => panel.mode === "list", {
        description: "native Back activation to return to history",
      });
      expect(reveal).toHaveBeenCalledOnceWith(panel.list);
      await expectActivity(controllers[0]);
    });
  }

  it("keeps cancellation in history quiet while returning focus to the workspace", async () => {
    const activate = jasmine.createSpy("activate center");
    spyOn(lumine.workspace.getCenter(), "getActivePane").and.returnValue({ activate });
    const reveal = spyOn(lumine.scrollbars, "reveal");

    await lumine.commands.dispatch(panel.list, "core:cancel");

    expect(activate).toHaveBeenCalledTimes(1);
    expect(panel.mode).toBe("list");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("does not reveal for empty or invalid history confirmation", async () => {
    jobs = [];
    events.emit("change");
    expect(panel.list.children.length).toBe(0);
    const reveal = spyOn(lumine.scrollbars, "reveal");

    await lumine.commands.dispatch(panel.list, "core:confirm");
    await lumine.commands.dispatch(panel.list, "tasks:open-details");

    expect(panel.mode).toBe("list");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("preserves native row links and details input cancellation without activity", async () => {
    const sourceLink = panel.rows.get(row().dataset.jobId).sourceLink;
    const reveal = spyOn(lumine.scrollbars, "reveal");
    expect(lumine.commands.canDispatch(sourceLink, "core:confirm")).toBeFalse();
    await lumine.commands.dispatch(sourceLink, "core:confirm");
    panel.showJob(row().dataset.jobId);
    const input = document.createElement("input");
    panel.detailsView.append(input);
    expect(lumine.commands.canDispatch(input, "core:cancel")).toBeFalse();
    await lumine.commands.dispatch(input, "core:cancel");

    expect(panel.mode).toBe("details");
    expect(reveal).not.toHaveBeenCalled();
  });

  for (const gesture of ["Enter", "click"]) {
    it(`reveals history once when a source link is opened with native ${gesture}`, async () => {
      const selected = jobs.find((job) => job.id === row().dataset.jobId);
      const sourceLink = panel.rows.get(selected.id).sourceLink;
      const open = spyOn(lumine.workspace, "open").and.resolveTo();
      const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();
      const position = [panel.list.scrollTop, panel.list.scrollLeft];
      sourceLink.focus();

      if (gesture === "Enter")
        sourceLink.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      else sourceLink.click();

      expect(open).toHaveBeenCalledOnceWith(selected.filePath, { searchAllPanes: true });
      expect(reveal).toHaveBeenCalledOnceWith(panel.list);
      await expectActivity(controllers[0]);
      expect(panel.mode).toBe("list");
      expect(panel.getSelectedJob()).toBeNull();
      expect([panel.list.scrollTop, panel.list.scrollLeft]).toEqual(position);
    });
  }

  it("does not reveal for a missing source file or a stale source row", async () => {
    const selected = jobs[0];
    selected.filePath = null;
    const open = spyOn(lumine.workspace, "open");
    const reveal = spyOn(lumine.scrollbars, "reveal");

    await panel.openSource(selected.id);
    await panel.openSource("removed-job");

    expect(open).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("keeps programmatic view changes and job refreshes quiet", () => {
    const reveal = spyOn(lumine.scrollbars, "reveal");
    panel.showJob(row().dataset.jobId);
    events.emit("change");
    panel.showList();
    events.emit("targets");

    expect(panel.mode).toBe("list");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("does not reveal for task controls, sorting or clearing history", async () => {
    const selected = jobs.find((job) => job.id === row().dataset.jobId);
    selected.state = "running";
    events.emit("change");
    const reveal = spyOn(lumine.scrollbars, "reveal");
    await lumine.commands.dispatch(row(), "tasks:stop-task");
    panel.headers.get("target").button.click();
    panel.runButton.click();
    await lumine.commands.dispatch(panel.list, "tasks:clear-list");

    expect(selected.stop).toHaveBeenCalledTimes(1);
    expect(manager.removeLog).toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });
});
