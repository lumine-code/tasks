const fs = require("node:fs");
const path = require("node:path");
const { Emitter } = require("lumine");
const { ipcRenderer } = require("electron");

describe("Tasks scrollbar navigation", () => {
  let panel, events, jobs, outputs, manager, controllers, stylesheet, actions;

  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("tasks.scrollToEnd", false);
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
      onDidChangeTargets: (callback) => events.on("targets", callback),
      onDidChangeJob: (callback) => events.on("change", callback),
      onDidFinishJob: (callback) => events.on("finish", callback),
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

  for (const gesture of ["Enter", "click"]) {
    it(`reveals history once when Back is activated with native ${gesture}`, async () => {
      panel.showJob(row().dataset.jobId);
      await window.waitForFrames(
        () => controllers[1].geometry?.visible && controllers[0].geometry?.visible === false,
        { description: "details to settle before activating the native Back button" },
      );
      if (gesture === "Enter") {
        await ipcRenderer.invoke("lumine:window", "focus");
        await window.waitForFrames(() => document.hasFocus(), {
          description: "native keyboard input to belong to the spec window",
        });
        panel.backButton.focus({ preventScroll: true });
        expect(document.activeElement).toBe(panel.backButton);
      }
      const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();

      if (gesture === "Enter") {
        for (const type of ["keyDown", "char", "keyUp"])
          await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
            type,
            keyCode: "Enter",
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
