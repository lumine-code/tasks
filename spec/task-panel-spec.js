const path = require("node:path");
const fs = require("node:fs");
const { Emitter } = require("lumine");
const ACTIVE = new Set(["preparing", "running", "collecting"]);

describe("Tasks execution history and details", () => {
  let manager, targets, jobs, events, panel, TasksPanel, TaskOutput, actions, nextId, stylesheet;
  let contextMenu;
  beforeEach(() => {
    TasksPanel = require("../lib/tasks-panel");
    TaskOutput = require("../lib/task-output");
    contextMenu = lumine.contextMenu.add(
      JSON.parse(fs.readFileSync(path.join(__dirname, "..", "menus", "main.json"), "utf8"))[
        "context-menu"
      ],
    );
    events = new Emitter();
    targets = [];
    jobs = [];
    nextId = 0;
    manager = {
      getTargets: () => targets.slice(),
      getJobs: () => jobs.slice(),
      onDidChangeTargets: (callback) => events.on("targets", callback),
      onDidChangeJob: (callback) => events.on("change", callback),
      onDidFinishJob: (callback) => events.on("finish", callback),
      removeLog: jasmine.createSpy("removeLog").and.callFake((id) => {
        const index = jobs.findIndex((job) => job.id === id);
        if (index < 0 || ACTIVE.has(jobs[index].state)) return false;
        const [job] = jobs.splice(index, 1);
        job.log.destroy();
        events.emit("change", job);
        return true;
      }),
    };
    actions = {
      runTarget: jasmine.createSpy("runTarget").and.callFake(async (target) => addJob(target)),
    };
    lumine.config.set("tasks.maxOutputLines", 10000);
    lumine.config.set("tasks.scrollToEnd", true);
  });
  afterEach(() => {
    panel?.destroy();
    contextMenu.dispose();
    stylesheet?.remove();
    events.dispose();
    for (const job of jobs) job.log.destroy();
  });
  function target(name) {
    const definition = {
      id: "target:" + name,
      providerId: "fixture:" + name,
      name,
      filePath: path.resolve(name.toLowerCase() + ".source"),
      source: ".lumine/tasks.json",
    };
    targets.push(definition);
    events.emit("targets");
    return definition;
  }
  function addJob(
    definition,
    state = "running",
    text = `${definition.name} output\n`,
    startedAt = nextId * 1000,
  ) {
    const job = {
      id: String(++nextId),
      targetId: definition.id,
      providerId: definition.providerId,
      name: definition.name,
      state,
      filePath: definition.filePath,
      startedAt,
      elapsedTime: nextId * 100,
      log: new TaskOutput(),
      stop: jasmine.createSpy(`stop ${definition.name}`),
    };
    job.log.start(definition.name);
    if (text) job.log.append(text);
    if (!ACTIVE.has(state)) job.log.finish(state);
    jobs.push(job);
    events.emit("change", job);
    return job;
  }
  function openPanel() {
    panel = new TasksPanel(manager, actions);
    jasmine.attachToDOM(panel.element);
    return panel;
  }
  const rowIds = () => [...panel.list.children].map((row) => row.dataset.jobId);
  const tooltipTitle = (element) => {
    const [tooltip] = lumine.tooltips.findTooltips(element);
    const content = document.createElement("div");
    content.innerHTML = tooltip.getTitle();
    content.querySelector(".key-bindings")?.remove();
    return content.textContent.trim();
  };

  it("keeps potential targets out of history and adds accepted preparations immediately", () => {
    const definition = target("Compile");
    target("Never run");
    openPanel();
    expect(panel.list.children.length).toBe(0);
    expect(panel.listEmpty.hidden).toBeFalse();
    expect(panel.element.classList.contains("tab-content-separated")).toBeTrue();
    expect(
      panel.listEmpty.querySelector("background-tips > ul.background-message.centered > li")
        .textContent,
    ).toBe("No build executions");
    expect(panel.heading.hidden).toBeTrue();
    const job = addJob(definition, "preparing", "");
    expect(panel.list.children.length).toBe(1);
    expect(rowIds()).toEqual([job.id]);
    expect(panel.rows.get(job.id).state.textContent).toBe("Preparing");
    expect(panel.mode).toBe("list");
    expect(panel.element.classList.contains("tab-content-separated")).toBeTrue();
    expect(panel.getSelectedJob()).toBeNull();
    expect(panel.title.textContent).toBe("");
    expect(panel.title.hidden).toBeTrue();
    expect(panel.detailsView.hidden).toBeTrue();
  });
  it("keeps every execution of the same target as its own row", () => {
    const definition = target("Compile");
    const first = addJob(definition, "passed");
    const second = addJob(definition, "failed");
    openPanel();
    expect(rowIds()).toEqual([second.id, first.id]);
    expect(panel.rows.get(first.id).state.textContent).toBe("Passed");
    expect(panel.rows.get(second.id).state.textContent).toBe("Failed");
    expect(panel.element.querySelector(".tasks-target-activate")).toBeNull();
    expect([...panel.headers.keys()]).toEqual([
      "status",
      "started",
      "duration",
      "target",
      "source",
    ]);
    expect([...panel.rows.get(first.id).element.children].map((cell) => cell.className)).toEqual([
      "tasks-run-state",
      "tasks-run-started",
      "tasks-run-duration",
      "tasks-run-name",
      "tasks-run-source",
    ]);
  });
  it("sorts every visible column in both directions with accessible indicators", () => {
    const first = addJob(target("Zulu"), "passed", "", 1000);
    const second = addJob(target("Alpha"), "failed", "", 2000);
    openPanel();
    expect(rowIds()).toEqual([second.id, first.id]);
    expect(panel.headers.get("started").cell.getAttribute("aria-sort")).toBe("descending");
    for (const [column, ascending] of [
      ["status", [second.id, first.id]],
      ["target", [second.id, first.id]],
      ["source", [second.id, first.id]],
      ["started", [first.id, second.id]],
      ["duration", [first.id, second.id]],
    ]) {
      const header = panel.headers.get(column);
      header.button.click();
      expect(header.cell.getAttribute("aria-sort")).toBe("ascending");
      expect(header.cell.scope).toBe("col");
      expect(header.button.matches("button.data-table-sort[type='button']")).toBeTrue();
      expect(header.button.textContent).toBe(header.label);
      expect(rowIds()).toEqual(ascending);
      header.button.click();
      expect(header.cell.getAttribute("aria-sort")).toBe("descending");
      expect(rowIds()).toEqual(ascending.slice().reverse());
    }
  });
  it("keeps sorting on native header buttons separate from execution actions", async () => {
    const first = addJob(target("Zulu"), "passed");
    const second = addJob(target("Alpha"), "passed");
    openPanel();
    const header = panel.headers.get("target");
    header.button.focus();
    for (const command of ["core:confirm", "core:move-up", "core:move-down", "tasks:open-details"])
      expect(lumine.commands.canDispatch(header.button, command)).toBeFalse();
    await lumine.commands.dispatch(header.button, "core:confirm");
    expect(panel.mode).toBe("list");
    expect(panel.getSelectedJob()).toBeNull();
    header.button.click();
    expect(rowIds()).toEqual([second.id, first.id]);
    expect(document.activeElement).toBe(header.button);
    header.button.click();
    expect(rowIds()).toEqual([first.id, second.id]);
    expect(document.activeElement).toBe(header.button);
    expect(actions.runTarget).not.toHaveBeenCalled();
  });
  it("breaks equal start times by creation order independently of the job ID text", () => {
    const definition = target("Compile");
    const first = addJob(definition, "passed", "", 1000);
    const second = addJob(definition, "passed", "", 1000);
    first.id = "tasks-10";
    second.id = "tasks-2";
    openPanel();
    expect(rowIds()).toEqual([second.id, first.id]);
  });

  it("preserves the focused execution when live duration sorting changes its position", () => {
    const definition = target("Compile");
    const running = addJob(definition, "running", "", Date.now());
    const complete = addJob(definition, "passed", "", Date.now() - 10000);
    complete.elapsedTime = 1000;
    openPanel();
    panel.setSort("duration");
    const row = panel.rows.get(running.id).element;
    row.focus();
    expect(rowIds()).toEqual([running.id, complete.id]);
    window.advanceClock(2000);
    expect(rowIds()).toEqual([complete.id, running.id]);
    expect(document.activeElement).toBe(row);
  });

  it("restores the history sort and scroll position after inspecting an execution", () => {
    const definition = target("Compile");
    for (let index = 0; index < 30; index++) addJob(definition, "passed");
    openPanel();
    stylesheet = document.createElement("style");
    stylesheet.textContent = fs.readFileSync(
      path.join(__dirname, "..", "styles", "main.css"),
      "utf8",
    );
    document.head.append(stylesheet);
    panel.element.style.height = "180px";
    panel.element.style.width = "800px";
    panel.setSort("duration");
    expect(panel.list.scrollHeight).toBeGreaterThan(panel.list.clientHeight);
    panel.list.scrollTop = 120;
    const scroll = panel.list.scrollTop;
    expect(scroll).toBeGreaterThan(0);
    panel.rows.get(jobs[12].id).element.click();
    addJob(definition, "passed");
    panel.backButton.click();
    expect(panel.sortBy).toBe("duration");
    expect(panel.sortDirection).toBe("ascending");
    expect(panel.list.scrollTop).toBe(scroll);
  });

  it("opens the exact clicked execution and returns with Back without starting a task", () => {
    const definition = target("Inspect");
    const earlier = addJob(definition, "failed", "earlier failure\n");
    addJob(definition, "passed", "newer output\n");
    openPanel();
    const row = panel.rows.get(earlier.id);
    row.element.click();
    expect(panel.mode).toBe("details");
    expect(panel.element.classList.contains("tab-content-separated")).toBeFalse();
    expect(panel.getSelectedJob()).toBe(earlier);
    expect(panel.output.textContent).toBe("earlier failure\n");
    expect(panel.title.textContent).toBe("Inspect");
    expect(panel.element.querySelector("select")).toBeNull();
    expect(actions.runTarget).not.toHaveBeenCalled();
    expect(panel.backButton.textContent).toBe("Back");
    expect(document.activeElement).toBe(panel.backButton);
    panel.backButton.click();
    expect(panel.mode).toBe("list");
    expect(panel.element.classList.contains("tab-content-separated")).toBeTrue();
    expect(panel.getSelectedJob()).toBeNull();
    expect(document.activeElement).toBe(panel.list);
    expect(row.element.matches(":focus")).toBeFalse();
    expect(panel.getSelectedJob()).toBeNull();
    expect(actions.runTarget).not.toHaveBeenCalled();
  });
  it("opens the clicked source link without opening details or running a task", () => {
    const job = addJob(target("Compile"), "passed");
    openPanel();
    const row = panel.rows.get(job.id);
    const open = spyOn(lumine.workspace, "open").and.resolveTo();
    expect(row.source.querySelector("a")).toBe(row.sourceLink);
    expect(row.sourceLink.getAttribute("aria-label")).toBe(job.filePath);
    row.sourceLink.click();
    expect(open).toHaveBeenCalledOnceWith(job.filePath, { searchAllPanes: true });
    expect(panel.mode).toBe("list");
    expect(panel.getSelectedJob()).toBeNull();
    expect(actions.runTarget).not.toHaveBeenCalled();
    manager.removeLog(job.id);
    row.sourceLink.click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps history cells and headers free of hover titles while retaining accessible labels", () => {
    const job = addJob(target("Compile"), "passed");
    job.filePath = path.join(
      path.resolve("example"),
      "long-directory-".repeat(10),
      "compile.source",
    );
    openPanel();
    panel.setSort("target");
    events.emit("change", job);
    expect(
      panel.listView.querySelector(".tasks-run-list [title], th[title], .data-table-sort[title]"),
    ).toBeNull();
    const row = panel.rows.get(job.id);
    expect(row.element.getAttribute("aria-label")).toContain("Compile");
    expect(row.sourceLink.getAttribute("aria-label")).toBe(job.filePath);
    expect(panel.headers.get("target").cell.getAttribute("aria-sort")).toBe("ascending");
    expect(panel.runButton.getAttribute("aria-label")).toBe("Run task");
    expect(tooltipTitle(panel.runButton)).toBe("Run task…");
    expect(tooltipTitle(panel.observedButton)).toBe("Observed documents…");
    expect(tooltipTitle(panel.clearListButton)).toBe("Clear list (completed executions)");
    for (const [status, input] of panel.statusFilters)
      expect(tooltipTitle(input.parentElement)).toBe(`Toggle ${status} executions`);
    for (const element of panel.listControls.querySelectorAll("[title]"))
      expect(element.title).toBe("");
    expect(panel.clearListButton.getAttribute("aria-label")).toBe("Clear list");
    expect(panel.statusFilters.get("running").getAttribute("aria-label")).toBe(
      "Show running executions",
    );
  });

  it("opens a source link with Enter and preserves link focus through live updates", async () => {
    const definition = target("Compile");
    const job = addJob(definition);
    openPanel();
    const row = panel.rows.get(job.id);
    const open = spyOn(lumine.workspace, "open").and.resolveTo();
    row.sourceLink.focus();
    addJob(definition, "passed");
    panel.setSort("duration");
    expect(document.activeElement).toBe(row.sourceLink);
    expect(lumine.commands.canDispatch(row.sourceLink, "core:confirm")).toBeFalse();
    await lumine.commands.dispatch(row.sourceLink, "core:confirm");
    row.sourceLink.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(open).toHaveBeenCalledOnceWith(job.filePath, { searchAllPanes: true });
    expect(panel.mode).toBe("list");
    expect(panel.getSelectedJob()).toBeNull();
  });

  it("keeps source labels without a file as plain text", () => {
    const job = addJob(target("Compile"), "passed");
    job.filePath = null;
    job.source = "Compiler";
    openPanel();
    const row = panel.rows.get(job.id);
    const open = spyOn(lumine.workspace, "open").and.resolveTo();
    expect(row.source.textContent).toBe("Compiler");
    expect(row.source.querySelector("a")).toBeNull();
    row.source.click();
    expect(panel.getSelectedJob()).toBe(job);
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the list header hidden while retaining the sortable column headings", () => {
    openPanel();
    expect(panel.heading.hidden).toBeTrue();
    expect(panel.element.querySelectorAll(".tasks-run-columns th").length).toBe(5);
    expect(panel.element.querySelector(".tasks-run-table").closest("[hidden]")).toBeNull();
    expect(actions.runTarget).not.toHaveBeenCalled();
    expect(panel.mode).toBe("list");
    panel.focus();
    expect(document.activeElement).toBe(panel.element);
  });
  it("places the status filters and icon actions at the end of the Source column header", () => {
    openPanel();
    const source = panel.headers.get("source");
    expect([...source.cell.children]).toEqual([source.button, panel.listControls]);
    expect([...panel.listControls.children]).toEqual([
      panel.runButton,
      panel.clearListButton,
      panel.observedButton,
      panel.filterGroup,
    ]);
    expect([...panel.statusFilters.keys()]).toEqual(["running", "passed", "failed", "cancelled"]);
    for (const input of panel.statusFilters.values()) {
      expect(input.type).toBe("checkbox");
      expect(input.checked).toBeTrue();
      expect(input.getAttribute("aria-label")).toBeTruthy();
    }
    expect(panel.runButton.classList.contains("icon-playback-play")).toBeTrue();
    expect(panel.clearListButton.classList.contains("icon-x")).toBeTrue();
    expect(panel.clearListButton.disabled).toBeTrue();
    expect(panel.runButton.disabled).toBeFalse();
  });
  it("filters all running phases together and toggles terminal statuses without deleting logs", () => {
    const definition = target("Compile");
    const executions = new Map(
      ["preparing", "running", "collecting", "passed", "failed", "cancelled"].map((state) => [
        state,
        addJob(definition, state),
      ]),
    );
    openPanel();
    expect(panel.list.children.length).toBe(6);
    panel.statusFilters.get("running").click();
    expect(rowIds()).toEqual(
      ["cancelled", "failed", "passed"].map((state) => executions.get(state).id),
    );
    panel.statusFilters.get("failed").click();
    expect(rowIds()).toEqual([executions.get("cancelled").id, executions.get("passed").id]);
    panel.setSort("status");
    panel.statusFilters.get("running").click();
    expect(panel.list.children.length).toBe(5);
    expect(rowIds()).not.toContain(executions.get("failed").id);
    panel.statusFilters.get("failed").click();
    expect(panel.list.children.length).toBe(6);
    expect(manager.getJobs().length).toBe(6);
    expect(manager.removeLog).not.toHaveBeenCalled();
    for (const job of executions.values()) expect(job.log.destroyed).toBeFalse();
    expect(actions.runTarget).not.toHaveBeenCalled();
  });
  it("keeps a displayed execution open when it finishes into a hidden status", () => {
    const job = addJob(target("Compile"), "preparing");
    openPanel();
    panel.statusFilters.get("passed").click();
    panel.showJob(job.id);
    job.state = "passed";
    job.log.finish("passed");
    events.emit("finish", job);
    expect(panel.mode).toBe("details");
    expect(panel.getSelectedJob()).toBe(job);
    expect(panel.output.textContent).toContain("Compile output");
    panel.backButton.click();
    expect(panel.mode).toBe("list");
    expect(panel.statusFilters.get("passed").checked).toBeFalse();
    expect(panel.list.children.length).toBe(0);
    expect(panel.listEmptyTitle.textContent).toBe("No matching build executions");
    expect(panel.clearListButton.disabled).toBeFalse();
    panel.statusFilters.get("passed").click();
    expect(rowIds()).toEqual([job.id]);
  });
  it("updates the filtered list as executions change status without moving filter focus", () => {
    const job = addJob(target("Compile"));
    openPanel();
    const toggle = panel.statusFilters.get("running");
    toggle.focus();
    toggle.click();
    expect(panel.listEmptyTitle.textContent).toBe("No matching build executions");
    expect(document.activeElement).toBe(toggle);
    job.state = "failed";
    job.log.finish("failed");
    events.emit("finish", job);
    expect(rowIds()).toEqual([job.id]);
    expect(document.activeElement).toBe(toggle);
    expect(panel.rows.get(job.id).state.textContent).toBe("Failed");
  });
  it("clears all completed history including hidden rows and preserves running phases", () => {
    const definition = target("Compile");
    const active = ["preparing", "running", "collecting"].map((state) => addJob(definition, state));
    const complete = ["passed", "failed", "cancelled"].map((state) => addJob(definition, state));
    openPanel();
    panel.statusFilters.get("failed").click();
    expect(panel.clearListButton.disabled).toBeFalse();
    expect(lumine.commands.canDispatch(panel.element, "tasks:clear-list")).toBeTrue();
    panel.clearListButton.click();
    expect(manager.removeLog.calls.allArgs().map(([id]) => id)).toEqual(
      complete.map((job) => job.id),
    );
    expect(manager.getJobs()).toEqual(active);
    expect(rowIds()).toEqual(active.map((job) => job.id).reverse());
    for (const job of complete) expect(job.log.destroyed).toBeTrue();
    for (const job of active) {
      expect(job.log.destroyed).toBeFalse();
      expect(job.stop).not.toHaveBeenCalled();
    }
    expect(panel.clearListButton.disabled).toBeTrue();
    expect(lumine.commands.canDispatch(panel.element, "tasks:clear-list")).toBeFalse();
    panel.selectJob(active[0]);
    expect(lumine.commands.canDispatch(panel.element, "tasks:clear-list")).toBeFalse();
  });
  it("shows the empty-history message after clearing every completed execution", () => {
    addJob(target("Compile"), "failed");
    openPanel();
    panel.clearListButton.click();
    expect(panel.list.children.length).toBe(0);
    expect(panel.listEmpty.hidden).toBeFalse();
    expect(panel.listEmptyTitle.textContent).toBe("No build executions");
    expect(panel.clearListButton.disabled).toBeTrue();
    expect(panel.runButton.disabled).toBeFalse();
  });
  it("preserves list focus and execution rows through state and output updates", () => {
    const definition = target("Compile");
    const first = addJob(definition, "preparing", "");
    openPanel();
    const row = panel.rows.get(first.id);
    row.element.focus();
    first.state = "running";
    first.log.append("compiler output\n");
    events.emit("change", first);
    addJob(definition);
    expect(panel.rows.get(first.id)).toBe(row);
    expect(document.activeElement).toBe(row.element);
    expect(panel.mode).toBe("list");
    expect(row.element.dataset.state).toBe("running");
  });
  it("streams only the exact selected log while later executions arrive", () => {
    const definition = target("Compile");
    const first = addJob(definition, "passed");
    const recent = addJob(definition);
    openPanel();
    panel.selectJob(first);
    recent.log.append("unselected output", "stderr");
    expect(panel.output.textContent).not.toContain("unselected output");
    first.log.append("selected warning", "stderr");
    expect(panel.output.querySelector(".task-output-stderr").textContent).toBe("selected warning");
    addJob(definition);
    expect(panel.getSelectedJob()).toBe(first);
    expect(panel.list.children.length).toBe(3);
  });
  it("stops, copies and hides only the selected execution without deleting output", () => {
    const first = addJob(target("First"));
    const second = addJob(target("Second"));
    openPanel();
    panel.selectJob(first);
    const copy = spyOn(lumine.clipboard, "write");
    panel.stopButton.click();
    panel.copyButton.click();
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledOnceWith(first.log.getText());
    panel.toggleLogButton.click();
    expect(first.log.getText()).toBe("First output\n");
    expect(second.log.getText()).toBe("Second output\n");
    expect(panel.output.hidden).toBeTrue();
    expect(panel.emptyTitle.textContent).toBe("The log is hidden");
    expect(panel.toggleLogButton.textContent).toBe("Show log");
    expect(tooltipTitle(panel.toggleLogButton)).toBe("Show log");
    expect(panel.toggleLogButton.getAttribute("aria-expanded")).toBe("false");
    expect(panel.toggleLogButton.getAttribute("aria-controls")).toBe(panel.output.id);
    expect(panel.copyButton.disabled).toBeFalse();
    first.log.append("more output\n", "stderr");
    expect(panel.output.hidden).toBeTrue();
    copy.calls.reset();
    panel.copyButton.click();
    expect(copy).toHaveBeenCalledOnceWith("First output\nmore output\n");
    panel.toggleLogButton.click();
    expect(panel.output.hidden).toBeFalse();
    expect(panel.output.textContent).toBe("First output\nmore output\n");
    expect(panel.toggleLogButton.textContent).toBe("Hide log");
    expect(tooltipTitle(panel.toggleLogButton)).toBe("Hide log");
    expect(panel.toggleLogButton.getAttribute("aria-expanded")).toBe("true");
    expect(panel.removeLog()).toBeFalse();
  });

  it("retains each execution's log visibility when navigating details and history", () => {
    const definition = target("Compile");
    const first = addJob(definition, "passed");
    const second = addJob(definition, "failed");
    openPanel();
    panel.selectJob(first);
    panel.toggleLogButton.click();
    panel.backButton.click();
    expect(lumine.commands.canDispatch(panel.list, "tasks:toggle-log")).toBeFalse();
    panel.selectJob(second);
    expect(panel.output.hidden).toBeFalse();
    panel.selectJob(first);
    expect(panel.output.hidden).toBeTrue();
    expect(panel.toggleLogButton.textContent).toBe("Show log");
    expect(first.log.getText()).toBe("Compile output\n");
    expect(second.log.getText()).toBe("Compile output\n");
  });

  it("keeps streaming, trimming and completion working while the log is hidden", () => {
    const job = addJob(target("Compile"));
    openPanel();
    panel.selectJob(job);
    panel.toggleLogButton.click();
    lumine.config.set("tasks.maxOutputLines", 100);
    job.log.append(Array.from({ length: 120 }, (_, index) => `line ${index}\n`).join(""));
    const retained = job.log.getText();
    expect(retained).not.toContain("Compile output");
    expect(retained).toContain("line 119");
    expect(panel.output.hidden).toBeTrue();
    expect(panel.output.textContent).toBe(retained);
    job.state = "passed";
    job.log.finish("passed");
    events.emit("finish", job);
    expect(panel.output.hidden).toBeTrue();
    expect(panel.copyButton.disabled).toBeFalse();
    panel.toggleLogButton.click();
    expect(panel.output.hidden).toBeFalse();
    expect(panel.output.textContent).toBe(retained);
    expect(job.log.getText()).toBe(retained);
  });

  it("waits for output before allowing log hiding and removes destructive clear commands", () => {
    const job = addJob(target("Compile"), "running", "");
    openPanel();
    panel.selectJob(job);
    expect(panel.toggleLogButton.disabled).toBeTrue();
    expect(panel.emptyTitle.textContent).toBe("Waiting for output…");
    expect(lumine.commands.canDispatch(panel.output, "tasks:clear-log")).toBeFalse();
    expect(lumine.commands.canDispatch(panel.output, "tasks:toggle-log")).toBeFalse();
    job.log.append("ready\n");
    expect(panel.toggleLogButton.disabled).toBeFalse();
    expect(lumine.commands.canDispatch(panel.output, "tasks:toggle-log")).toBeTrue();
  });

  it("offers native context actions for the clicked row without opening or selecting it", async () => {
    const definition = target("Compile");
    const first = addJob(definition, "failed", "first output\n");
    const second = addJob(definition, "passed", "second output\n");
    openPanel();
    const row = panel.rows.get(first.id);
    panel.rows.get(second.id).element.focus();
    const items = lumine.contextMenu.templateForElement(row.source);
    expect(
      items.filter((item) => item.command?.startsWith("tasks:")).map((item) => item.command),
    ).toEqual([
      "tasks:open-details",
      "tasks:rerun-task",
      "tasks:stop-task",
      "tasks:copy-log",
      "tasks:remove-log",
    ]);
    expect(panel.mode).toBe("list");
    expect(panel.getSelectedJob()).toBeNull();
    expect(actions.runTarget).not.toHaveBeenCalled();
    const copy = spyOn(lumine.clipboard, "write");
    await lumine.commands.dispatch(row.source, "tasks:copy-log");
    expect(copy).toHaveBeenCalledOnceWith("first output\n");
    expect(first.log.getText()).toBe("first output\n");
    expect(second.log.getText()).toBe("second output\n");
    expect(lumine.commands.canDispatch(row.source, "tasks:copy-log")).toBeTrue();
    expect(lumine.commands.canDispatch(row.source, "tasks:clear-log")).toBeFalse();
    expect(lumine.commands.canDispatch(row.source, "tasks:toggle-log")).toBeFalse();
    expect(panel.mode).toBe("list");
    expect(panel.getSelectedJob()).toBeNull();
    await lumine.commands.dispatch(row.source, "tasks:open-details");
    expect(panel.getSelectedJob()).toBe(first);
    expect(document.activeElement).toBe(panel.backButton);
  });

  it("reruns the clicked execution using its current definition and stays in history", async () => {
    const definition = target("Compile");
    const first = addJob(definition, "failed");
    addJob(target("Other"), "passed");
    openPanel();
    const row = panel.rows.get(first.id);
    const current = { ...definition, name: "Updated compiler" };
    targets[0] = current;
    events.emit("targets");
    await lumine.commands.dispatch(row.name, "tasks:rerun-task");
    expect(actions.runTarget).toHaveBeenCalledOnceWith(current);
    expect(panel.mode).toBe("list");
    expect(panel.getSelectedJob()).toBeNull();
    expect(panel.list.children.length).toBe(3);
    expect(lumine.commands.canDispatch(row.name, "tasks:rerun-task")).toBeFalse();
  });

  for (const state of ["preparing", "running", "collecting"])
    it(`stops only the context ${state} execution and disables rerun and removal`, async () => {
      const first = addJob(target("First"), state);
      const second = addJob(target("Second"));
      openPanel();
      const row = panel.rows.get(first.id);
      expect(lumine.commands.canDispatch(row.name, "tasks:stop-task")).toBeTrue();
      expect(lumine.commands.canDispatch(row.name, "tasks:rerun-task")).toBeFalse();
      expect(lumine.commands.canDispatch(row.name, "tasks:remove-log")).toBeFalse();
      await lumine.commands.dispatch(row.name, "tasks:stop-task");
      await lumine.commands.dispatch(row.name, "tasks:remove-log");
      expect(first.stop).toHaveBeenCalledTimes(1);
      expect(second.stop).not.toHaveBeenCalled();
      expect(manager.removeLog).not.toHaveBeenCalled();
      first.state = "passed";
      events.emit("finish", first);
      expect(lumine.commands.canDispatch(row.name, "tasks:stop-task")).toBeFalse();
      expect(lumine.commands.canDispatch(row.name, "tasks:remove-log")).toBeTrue();
      await lumine.commands.dispatch(row.name, "tasks:stop-task");
      expect(first.stop).toHaveBeenCalledTimes(1);
      expect(panel.mode).toBe("list");
    });

  it("removes only the context completed log and ignores a stale menu target", async () => {
    const definition = target("Compile");
    const first = addJob(definition, "failed");
    const second = addJob(definition, "passed");
    openPanel();
    const row = panel.rows.get(first.id);
    targets = [];
    events.emit("targets");
    expect(lumine.commands.canDispatch(row.source, "tasks:rerun-task")).toBeFalse();
    expect(lumine.commands.canDispatch(row.source, "tasks:stop-task")).toBeFalse();
    expect(lumine.commands.canDispatch(row.source, "tasks:remove-log")).toBeTrue();
    await lumine.commands.dispatch(row.source, "tasks:remove-log");
    expect(manager.removeLog).toHaveBeenCalledOnceWith(first.id);
    expect(rowIds()).toEqual([second.id]);
    expect(panel.mode).toBe("list");
    panel.selectJob(second);
    const copy = spyOn(lumine.clipboard, "write");
    await lumine.commands.dispatch(row.source, "tasks:copy-log");
    await lumine.commands.dispatch(row.source, "tasks:rerun-task");
    expect(copy).not.toHaveBeenCalled();
    expect(second.log.getText()).toBe("Compile output\n");
    expect(panel.getSelectedJob()).toBe(second);
    expect(actions.runTarget).not.toHaveBeenCalled();
  });

  it("does not expose row actions on the history background or after panel destruction", () => {
    const job = addJob(target("Compile"), "passed");
    openPanel();
    const commands = [
      "tasks:open-details",
      "tasks:rerun-task",
      "tasks:stop-task",
      "tasks:copy-log",
      "tasks:remove-log",
    ];
    for (const command of commands)
      expect(lumine.commands.canDispatch(panel.list, command)).toBeFalse();
    expect(
      lumine.contextMenu
        .templateForElement(panel.list)
        .some((item) => commands.includes(item.command)),
    ).toBeFalse();
    const row = panel.rows.get(job.id).element;
    panel.destroy();
    for (const command of commands) expect(lumine.commands.canDispatch(row, command)).toBeFalse();
  });
  it("removes the middle-clicked completed log without opening details or running a task", () => {
    const definition = target("Compile");
    const first = addJob(definition, "failed");
    const second = addJob(definition, "passed");
    openPanel();
    const row = panel.rows.get(first.id);
    const down = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    row.sourceLink.dispatchEvent(down);
    expect(down.defaultPrevented).toBeTrue();
    row.sourceLink.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true }));
    row.element.dispatchEvent(new MouseEvent("click", { button: 1, bubbles: true }));
    expect(manager.removeLog).toHaveBeenCalledOnceWith(first.id);
    expect(rowIds()).toEqual([second.id]);
    expect(panel.mode).toBe("list");
    expect(actions.runTarget).not.toHaveBeenCalled();
    expect(first.stop).not.toHaveBeenCalled();
  });

  for (const state of ["preparing", "running", "collecting"])
    it(`keeps a middle-clicked ${state} execution without stopping it or opening details`, () => {
      const job = addJob(target("Compile"), state);
      openPanel();
      const row = panel.rows.get(job.id).element;
      row.dispatchEvent(
        new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true }),
      );
      row.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true }));
      row.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { button: 1, bubbles: true }));
      expect(manager.removeLog).not.toHaveBeenCalled();
      expect(job.stop).not.toHaveBeenCalled();
      expect(actions.runTarget).not.toHaveBeenCalled();
      expect(rowIds()).toEqual([job.id]);
      expect(panel.mode).toBe("list");
    });

  it("leaves non-middle gestures and empty history background defaults unchanged", () => {
    const job = addJob(target("Compile"), "passed");
    openPanel();
    const row = panel.rows.get(job.id).element;
    const left = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    row.dispatchEvent(left);
    expect(left.defaultPrevented).toBeFalse();
    const background = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    panel.list.dispatchEvent(background);
    panel.list.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true }));
    expect(background.defaultPrevented).toBeFalse();
    expect(manager.removeLog).not.toHaveBeenCalled();
  });

  it("removes only the selected completed execution and returns to surviving history", () => {
    const definition = target("Compile");
    const first = addJob(definition, "failed");
    const second = addJob(definition, "passed");
    openPanel();
    panel.selectJob(first);
    panel.removeButton.click();
    expect(manager.removeLog).toHaveBeenCalledOnceWith(first.id);
    expect(panel.mode).toBe("list");
    expect(panel.element.classList.contains("tab-content-separated")).toBeTrue();
    expect(rowIds()).toEqual([second.id]);
    expect(panel.showJob(first.id)).toBeFalse();
    expect(panel.getSelectedJob()).toBeNull();
  });
  it("allows rerun only through a still-available matching catalog definition", async () => {
    const other = target("Other");
    const definition = target("Inspect");
    const job = addJob(definition, "failed");
    openPanel();
    panel.selectJob(job);
    targets = [other];
    events.emit("targets");
    expect(panel.output.textContent).toBe("Inspect output\n");
    expect(panel.rerunButton.disabled).toBeTrue();
    expect(tooltipTitle(panel.rerunButton)).toBe("The execution's task is unavailable");
    expect(panel.stopButton.disabled).toBeTrue();
    expect(panel.copyButton.disabled).toBeFalse();
    targets.push(definition);
    events.emit("targets");
    expect(panel.rerunButton.disabled).toBeFalse();
    expect(tooltipTitle(panel.rerunButton)).toBe("Run Inspect again");
    const rerun = await panel.rerunTask();
    expect(actions.runTarget).toHaveBeenCalledOnceWith(definition);
    expect(panel.getSelectedJob()).toBe(rerun);
    expect(targets).toContain(other);
  });
  it("navigates the displayed sort order with arrows and keeps native log and input keys", async () => {
    const definition = target("Compile");
    const first = addJob(definition, "passed");
    const second = addJob(definition, "passed");
    openPanel();
    panel.list.focus();
    await lumine.commands.dispatch(panel.list, "core:move-down");
    expect(document.activeElement).toBe(panel.rows.get(second.id).element);
    await lumine.commands.dispatch(panel.rows.get(second.id).element, "core:move-down");
    expect(document.activeElement).toBe(panel.rows.get(first.id).element);
    await lumine.commands.dispatch(panel.rows.get(first.id).element, "core:confirm");
    expect(panel.getSelectedJob()).toBe(first);
    expect(lumine.commands.canDispatch(panel.output, "core:move-down")).toBeFalse();
    const input = document.createElement("input");
    panel.detailsView.append(input);
    expect(lumine.commands.canDispatch(input, "core:cancel")).toBeFalse();
    await lumine.commands.dispatch(panel.output, "core:cancel");
    expect(panel.mode).toBe("list");
    expect(document.activeElement).toBe(panel.list);
  });
  it("updates active duration without output and stops presentation timers when the view closes", () => {
    const job = addJob(target("Slow"), "running", "", Date.now());
    openPanel();
    expect(panel.rows.get(job.id).duration.textContent).toBe("0 ms");
    window.advanceClock(1000);
    expect(panel.rows.get(job.id).duration.textContent).toBe("1.0 s");
    panel.selectJob(job);
    expect(panel.summary.textContent).toContain("1.0 s");
    const row = panel.rows.get(job.id).element;
    panel.destroy();
    window.advanceClock(1000);
    expect(row.textContent).toContain("1.0 s");
  });
  it("retains executions when the dock view closes and recreates the history list", () => {
    const job = addJob(target("Compile"), "passed");
    openPanel();
    panel.selectJob(job);
    const previous = panel;
    const text = panel.output.textContent;
    const controls = [
      ...panel.listControls.querySelectorAll("button, label"),
      ...panel.toolbar.children,
    ];
    panel.destroy();
    for (const control of controls) expect(lumine.tooltips.findTooltips(control)).toEqual([]);
    job.log.append("retained after closing\n");
    expect(previous.output.textContent).toBe(text);
    expect(job.log.destroyed).toBeFalse();
    expect(job.stop).not.toHaveBeenCalled();
    openPanel();
    expect(panel.mode).toBe("list");
    panel.rows.get(job.id).element.click();
    expect(panel.output.textContent).toContain("retained after closing");
    expect(panel.getURI()).toBe("lumine://tasks");
    expect(panel.serialize()).toEqual({ deserializer: "tasks/TasksPanel" });
  });
  it("adapts header controls and shows truncation only for the selected execution", () => {
    const job = addJob(target("Verbose"), "passed");
    job.outputTruncated = true;
    openPanel();
    panel.selectJob(job);
    expect(panel.summary.textContent).toContain("Output truncated");
    expect(panel.copyButton.hidden).toBeFalse();
    expect(panel.heading.hidden).toBeFalse();
    expect(panel.rerunButton.hidden).toBeFalse();
    expect(panel.detailsView.querySelector(".tasks-panel-source")).toBeNull();
    expect(panel.title.title).toBe(job.filePath);
    panel.showList();
    expect(panel.copyButton.hidden).toBeTrue();
    expect(panel.stopButton.hidden).toBeTrue();
    expect(panel.heading.hidden).toBeTrue();
    expect(panel.rerunButton.hidden).toBeTrue();
    expect(panel.title.textContent).toBe("");
    expect(panel.title.hidden).toBeTrue();
  });
});
