const { CompositeDisposable, Emitter } = require("lumine");

const URI = "lumine://tasks";
const ACTIVE_STATES = new Set(["preparing", "running", "collecting"]);
const STATE_LABELS = {
  preparing: "Preparing",
  running: "Running",
  collecting: "Collecting",
  passed: "Passed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const STATUS_FILTERS = [
  ["running", "Running"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];
const COLUMNS = [
  ["status", "Status"],
  ["started", "Started"],
  ["duration", "Duration"],
  ["target", "Target"],
  ["source", "Source"],
];
let nextOutputId = 0;

// The list owns execution history; the task picker starts a chosen definition.
class TasksPanel {
  constructor(manager, actions = {}) {
    this.manager = manager;
    this.actions = actions;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable(this.emitter);
    this.rows = new Map();
    this.sortBy = "started";
    this.sortDirection = "descending";
    this.hiddenStatuses = new Set();
    this.hiddenLogs = new WeakSet();
    this.mode = "list";
    this.selectedJob = null;
    this.destroyed = false;
    this.element = this.node("section", "tasks-panel native-key-bindings");
    this.element.tabIndex = -1;
    this.element.setAttribute("aria-label", "Tasks execution history");

    this.heading = this.node("header", "tasks-panel-header");
    this.backButton = this.button("Back", () => this.dispatch("tasks:back-to-history"));
    this.backButton.classList.add("tasks-panel-back", "icon", "icon-arrow-left");
    this.backButton.title = "Back to history";
    this.backButton.setAttribute("aria-label", "Back to history");
    this.state = this.node("span", "tasks-panel-state");
    this.state.setAttribute("role", "status");
    const dot = this.node("span", "tasks-panel-state-dot");
    dot.setAttribute("aria-hidden", "true");
    this.stateLabel = this.node("span", "tasks-panel-state-label");
    this.state.append(dot, this.stateLabel);
    this.title = this.node("span", "tasks-panel-title");
    this.summary = this.node("span", "tasks-panel-summary");
    this.toolbar = this.node("div", "tasks-panel-actions");
    this.rerunButton = this.button("Run again", () => this.dispatch("tasks:rerun-task"));
    this.rerunButton.classList.add("btn-primary");
    this.stopButton = this.button("Stop", () => this.dispatch("tasks:stop-task"));
    this.toggleLogButton = this.button("Hide log", () => this.dispatch("tasks:toggle-log"));
    this.copyButton = this.button("Copy", () => this.dispatch("tasks:copy-log"));
    this.removeButton = this.button("Remove log", () => this.dispatch("tasks:remove-log"));
    this.tooltip(this.stopButton, "Stop task", "tasks:stop-task");
    this.tooltip(this.toggleLogButton, () => this.toggleLogButton.textContent, "tasks:toggle-log");
    this.tooltip(this.copyButton, "Copy log", "tasks:copy-log");
    this.tooltip(this.removeButton, "Remove log", "tasks:remove-log");
    this.tooltip(
      this.rerunButton,
      () => {
        const target = this.targetForRerun();
        return target ? `Run ${target.name} again` : "The execution's task is unavailable";
      },
      "tasks:rerun-task",
    );
    this.toolbar.append(
      this.stopButton,
      this.toggleLogButton,
      this.copyButton,
      this.removeButton,
      this.rerunButton,
    );
    this.heading.append(this.backButton, this.state, this.title, this.summary, this.toolbar);

    this.listView = this.node("div", "tasks-panel-list-view");
    const table = this.node("table", "tasks-run-table data-table");
    table.setAttribute("aria-label", "Tasks executions");
    const head = this.node("thead", "");
    const headerRow = this.node("tr", "tasks-run-columns");
    this.headers = new Map();
    for (const [key, label] of COLUMNS) {
      const cell = this.node("th", "tasks-run-column-" + key);
      cell.scope = "col";
      const button = this.button("", () => this.setSort(key));
      button.className = "data-table-sort";
      const text = this.node("span", "data-table-sort-label");
      text.textContent = label;
      button.append(text);
      cell.append(button);
      headerRow.append(cell);
      this.headers.set(key, { cell, button, label });
    }
    this.listControls = this.node("span", "tasks-run-controls");
    this.filterGroup = this.node("span", "tasks-run-filters");
    this.filterGroup.setAttribute("role", "group");
    this.filterGroup.setAttribute("aria-label", "Filter executions by status");
    this.statusFilters = new Map();
    for (const [status, label] of STATUS_FILTERS) {
      const toggle = this.node("label", "tasks-status-filter input-label");
      toggle.dataset.status = status;
      this.tooltip(toggle, `Toggle ${label.toLowerCase()} executions`);
      const input = this.node("input", "input-toggle");
      input.type = "checkbox";
      input.checked = true;
      input.setAttribute("aria-label", `Show ${label.toLowerCase()} executions`);
      input.addEventListener("change", () => this.setStatusVisible(status, input.checked));
      toggle.append(input);
      this.filterGroup.append(toggle);
      this.statusFilters.set(status, input);
    }
    this.clearListButton = this.button("", () => this.dispatch("tasks:clear-list"));
    this.clearListButton.className =
      "tasks-list-action tasks-clear-list native-key-bindings icon icon-x";
    this.tooltip(this.clearListButton, "Clear list (completed executions)", "tasks:clear-list");
    this.clearListButton.setAttribute("aria-label", "Clear list");
    this.runButton = this.button("", () => this.dispatch("tasks:run-task"));
    this.runButton.className =
      "tasks-list-action tasks-run-task native-key-bindings icon icon-playback-play";
    this.tooltip(this.runButton, "Run task…", "tasks:run-task");
    this.runButton.setAttribute("aria-label", "Run task");
    this.observedButton = this.button("", () => this.dispatch("tasks:observed-files"));
    this.observedButton.className =
      "tasks-list-action tasks-observed-documents native-key-bindings icon icon-eye";
    this.tooltip(this.observedButton, "Observed documents…", "tasks:observed-files");
    this.observedButton.setAttribute("aria-label", "Observed documents");
    // Pointer-opened pickers return focus to the previous surface. Keyboard
    // activation keeps the icon focused so the picker can return to it.
    for (const button of [this.runButton, this.observedButton])
      button.addEventListener("mousedown", (event) => {
        if (event.button === 0) event.preventDefault();
      });
    this.listControls.append(
      this.runButton,
      this.clearListButton,
      this.observedButton,
      this.filterGroup,
    );
    this.headers.get("source").cell.append(this.listControls);
    head.append(headerRow);
    this.list = this.node("tbody", "tasks-run-list");
    this.list.tabIndex = 0;
    this.list.setAttribute("data-scrollbar", "auto");
    this.list.addEventListener("mousedown", (event) => {
      if (event.button === 1 && event.target.closest(".tasks-run-row")) event.preventDefault();
    });
    this.list.addEventListener("mouseup", (event) => {
      if (event.button !== 1 || this.mode !== "list") return;
      const id = event.target.closest(".tasks-run-row")?.dataset.jobId;
      const job = this.manager.getJobs().find((candidate) => candidate.id === id);
      if (job && !ACTIVE_STATES.has(job.state)) this.manager.removeLog(job.id);
    });
    table.append(head, this.list);
    this.listEmpty = this.node("div", "tasks-panel-empty panel-empty-state");
    const listTips = this.node("background-tips", "");
    const listMessage = this.node("ul", "centered background-message");
    this.listEmptyTitle = this.node("li", "");
    listMessage.append(this.listEmptyTitle);
    listTips.append(listMessage);
    this.listEmpty.append(listTips);
    this.listView.append(table, this.listEmpty);
    this.detailsView = this.node("div", "tasks-panel-details");
    this.output = this.node("pre", "task-output");
    this.output.id = `task-output-${++nextOutputId}`;
    this.output.tabIndex = 0;
    this.output.setAttribute("aria-label", "Selected execution log");
    this.output.setAttribute("data-scrollbar", "auto");
    this.toggleLogButton.setAttribute("aria-controls", this.output.id);
    this.empty = this.node("div", "tasks-panel-empty panel-empty-state");
    const outputTips = this.node("background-tips", "");
    const outputMessage = this.node("ul", "centered background-message");
    this.emptyTitle = this.node("li", "");
    outputMessage.append(this.emptyTitle);
    outputTips.append(outputMessage);
    this.empty.append(outputTips);
    this.detailsView.append(this.output, this.empty);
    this.element.append(this.heading, this.listView, this.detailsView);

    this.subscriptions.add(
      manager.onDidChangeTargets(() => this.refreshJobs()),
      manager.onDidChangeJob(() => this.refreshJobs()),
      manager.onDidFinishJob(() => this.refreshJobs()),
      lumine.commands.add(this.element, {
        "tasks:clear-list": {
          description: "Remove all completed execution logs from history.",
          isAvailable: () => this.mode === "list" && this.hasCompletedJobs(),
          didDispatch: () => this.clearList(),
        },
        "tasks:open-details": {
          description: "Inspect this execution's output and controls.",
          isAvailable: (event) => this.mode === "list" && Boolean(this.jobForEvent(event)),
          didDispatch: (event) => {
            const job = this.jobForEvent(event);
            if (this.mode === "list" && job) this.showJob(job.id, { focus: true });
          },
        },
        "tasks:rerun-task": {
          description: "Rerun this execution's currently available task definition.",
          isAvailable: (event) => this.canRerun(this.jobForEvent(event)),
          didDispatch: (event) => this.rerunTask(this.jobForEvent(event)),
        },
        "tasks:back-to-history": {
          description: "Return to the execution history.",
          isAvailable: () => this.mode === "details",
          didDispatch: () => this.showList({ focus: true }),
        },
        "tasks:stop-task": {
          description: "Stop the selected execution.",
          isAvailable: (event) => this.isActive(this.jobForEvent(event)),
          didDispatch: (event) => {
            const job = this.jobForEvent(event);
            if (this.isActive(job)) job.stop();
          },
        },
        "tasks:toggle-log": {
          description: "Hide or show the displayed execution log without removing its output.",
          isAvailable: () => this.canToggleLog(),
          didDispatch: () => this.toggleLog(),
        },
        "tasks:copy-log": {
          description: "Copy the selected execution log.",
          isAvailable: (event) => this.getText(this.jobForEvent(event)).length > 0,
          didDispatch: (event) => {
            const text = this.getText(this.jobForEvent(event));
            if (text) lumine.clipboard.write(text);
          },
        },
        "tasks:remove-log": {
          description: "Remove the selected completed execution log.",
          isAvailable: (event) => {
            const job = this.jobForEvent(event);
            return Boolean(job && !this.isActive(job));
          },
          didDispatch: (event) => this.removeLog(this.jobForEvent(event)),
        },
        "core:move-up": {
          isAvailable: (event) => this.isListNavigation(event),
          didDispatch: (event) => {
            event.stopPropagation();
            this.moveFocus(-1);
          },
        },
        "core:move-down": {
          isAvailable: (event) => this.isListNavigation(event),
          didDispatch: (event) => {
            event.stopPropagation();
            this.moveFocus(1);
          },
        },
        "core:confirm": {
          isAvailable: (event) =>
            this.isListNavigation(event) && !event.target?.closest?.("a, button"),
          didDispatch: (event) => {
            event.stopPropagation();
            const id =
              event.target.closest(".tasks-run-row")?.dataset.jobId ||
              this.list.firstElementChild?.dataset.jobId;
            if (id) this.showJob(id, { focus: true });
          },
        },
        "core:cancel": {
          isAvailable: (event) =>
            !event.target?.closest?.(
              "select, input, textarea, [contenteditable]:not([contenteditable='false'])",
            ),
          didDispatch: (event) => {
            event.stopPropagation();
            if (this.mode === "details") this.showList({ focus: true });
            else lumine.workspace.getCenter().getActivePane()?.activate();
          },
        },
      }),
    );
    this.refreshJobs();
  }

  node(tagName, className) {
    const element = document.createElement(tagName);
    element.className = className;
    return element;
  }

  button(label, action) {
    const button = this.node("button", "btn");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (!this.destroyed) action();
    });
    return button;
  }

  tooltip(element, title, keyBindingCommand) {
    this.subscriptions.add(
      lumine.tooltips.add(element, {
        html: false,
        title,
        keyBindingCommand,
        keyBindingTarget: element,
      }),
    );
  }

  duration(job) {
    if (ACTIVE_STATES.has(job.state)) return Math.max(0, Date.now() - job.startedAt);
    return Math.max(0, job.elapsedTime ?? (job.finishedAt ?? job.startedAt) - job.startedAt);
  }

  formatDuration(job) {
    const duration = this.duration(job);
    return duration < 1000 ? `${Math.round(duration)} ms` : `${(duration / 1000).toFixed(1)} s`;
  }

  sourceFor(job) {
    if (!job.filePath) return job.source || "";
    const [, relative] = lumine.project.relativizePath(job.filePath);
    return relative || job.filePath;
  }

  sortedJobs() {
    const jobs = this.manager.getJobs().slice();
    const creationOrder = new Map(jobs.map((job, index) => [job.id, index]));
    const direction = this.sortDirection === "ascending" ? 1 : -1;
    const text = (left, right) =>
      String(left || "").localeCompare(String(right || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    const compare = (left, right) => {
      switch (this.sortBy) {
        case "status":
          return text(STATE_LABELS[left.state], STATE_LABELS[right.state]);
        case "target":
          return text(left.name || left.providerId, right.name || right.providerId);
        case "source":
          return text(this.sourceFor(left), this.sourceFor(right));
        case "duration":
          return this.duration(left) - this.duration(right);
        default:
          return left.startedAt - right.startedAt;
      }
    };
    return jobs.sort(
      (left, right) =>
        direction * compare(left, right) ||
        right.startedAt - left.startedAt ||
        creationOrder.get(right.id) - creationOrder.get(left.id),
    );
  }

  setSort(key) {
    if (!this.headers.has(key)) return;
    this.sortDirection =
      this.sortBy === key && this.sortDirection === "ascending" ? "descending" : "ascending";
    this.sortBy = key;
    this.refreshJobs();
  }

  statusFor(job) {
    return ACTIVE_STATES.has(job.state) ? "running" : job.state;
  }

  setStatusVisible(status, visible) {
    if (this.destroyed || !this.statusFilters.has(status)) return;
    if (visible) this.hiddenStatuses.delete(status);
    else this.hiddenStatuses.add(status);
    this.statusFilters.get(status).checked = visible;
    this.refreshJobs();
  }

  hasCompletedJobs() {
    return this.manager.getJobs().some((job) => !this.isActive(job));
  }

  clearList() {
    if (this.destroyed || this.mode !== "list") return;
    for (const job of this.manager.getJobs()) {
      if (!this.isActive(job)) this.manager.removeLog(job.id);
    }
  }

  jobRow(job) {
    let row = this.rows.get(job.id);
    if (!row) {
      const element = this.node("tr", "tasks-run-row data-table-row");
      element.tabIndex = 0;
      element.addEventListener("click", (event) => {
        if (event.button === 0 && !event.target.closest("a, button"))
          this.showJob(row.job.id, { focus: true });
      });
      const state = this.node("td", "tasks-run-state");
      const name = this.node("td", "tasks-run-name");
      const source = this.node("td", "tasks-run-source");
      const sourceLink = this.node("a", "");
      sourceLink.tabIndex = 0;
      sourceLink.setAttribute("role", "link");
      sourceLink.addEventListener("click", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.openSource(row.job.id);
      });
      sourceLink.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        this.openSource(row.job.id);
      });
      const started = this.node("td", "tasks-run-started");
      const duration = this.node("td", "tasks-run-duration");
      element.append(state, started, duration, name, source);
      row = { element, state, name, source, sourceLink, started, duration };
      this.rows.set(job.id, row);
    }
    row.job = job;
    row.element.dataset.jobId = job.id;
    row.element.dataset.state = job.state;
    row.element.setAttribute(
      "aria-label",
      [
        job.name || job.providerId,
        STATE_LABELS[job.state],
        this.sourceFor(job),
        "Open execution details",
      ].join(" · "),
    );
    row.state.textContent = STATE_LABELS[job.state] || job.state;
    row.name.textContent = job.name || job.providerId;
    if (job.filePath) {
      row.sourceLink.textContent = this.sourceFor(job);
      row.sourceLink.setAttribute("aria-label", job.filePath);
      if (row.sourceLink.parentElement !== row.source) row.source.replaceChildren(row.sourceLink);
    } else {
      row.source.textContent = this.sourceFor(job);
    }
    row.started.textContent = new Date(job.startedAt).toLocaleTimeString();
    row.duration.textContent = this.formatDuration(job);
    return row;
  }

  refreshJobs() {
    if (this.destroyed) return;
    const jobs = this.sortedJobs();
    const available = new Set(jobs.map((job) => job.id));
    const visibleJobs = jobs.filter((job) => !this.hiddenStatuses.has(this.statusFor(job)));
    const visible = new Set(visibleJobs.map((job) => job.id));
    const focusedElement = document.activeElement;
    const focusedId = this.list.contains(focusedElement)
      ? focusedElement.closest(".tasks-run-row")?.dataset.jobId
      : null;
    for (const [id, row] of this.rows) {
      if (!visible.has(id)) row.element.remove();
      if (!available.has(id)) this.rows.delete(id);
    }
    visibleJobs.forEach((job, index) => {
      const row = this.jobRow(job);
      if (this.list.children[index] !== row.element)
        this.list.insertBefore(row.element, this.list.children[index] || null);
    });
    if (focusedId && this.mode === "list") {
      const focusTarget = visible.has(focusedId)
        ? focusedElement
        : visible.size > 0
          ? this.list
          : this.element;
      focusTarget.focus({ preventScroll: true });
    }
    for (const [key, header] of this.headers) {
      const sorted = key === this.sortBy;
      header.cell.setAttribute("aria-sort", sorted ? this.sortDirection : "none");
    }
    this.listEmpty.hidden = visibleJobs.length > 0;
    this.listEmptyTitle.textContent = jobs.length
      ? "No matching build executions"
      : "No build executions";
    this.listView.classList.toggle("is-empty", visibleJobs.length === 0);
    this.list.hidden = visibleJobs.length === 0;
    if (this.selectedJob && !available.has(this.selectedJob.id))
      return this.showList({ focus: true });
    const running = jobs.some((job) => ACTIVE_STATES.has(job.state));
    if (running && !this.timer) this.timer = setInterval(() => this.refreshJobs(), 1000);
    else if (!running && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.update({ type: "state" });
  }

  showJob(id, { focus = false } = {}) {
    const job = this.manager.getJobs().find((candidate) => candidate.id === id);
    if (this.destroyed || !job || job.log.destroyed) return false;
    if (this.mode === "list") this.listScrollTop = this.list.scrollTop;
    this.mode = "details";
    if (job !== this.selectedJob) {
      this.logSubscription?.dispose();
      this.selectedJob = job;
      this.model = job.log;
      this.logSubscription = this.model.onDidChange((change) => this.update(change));
    }
    this.update({ type: "reset" });
    if (focus) this.backButton.focus({ preventScroll: true });
    return true;
  }

  showList({ focus = false } = {}) {
    if (this.destroyed) return;
    this.mode = "list";
    this.logSubscription?.dispose();
    this.logSubscription = null;
    this.selectedJob = this.model = null;
    for (const row of this.rows.values()) {
      row.element.classList.remove("selected", "current", "focused");
      row.element.removeAttribute("aria-selected");
    }
    this.update({ type: "reset" });
    this.list.scrollTop = this.listScrollTop || 0;
    if (focus)
      ((this.list.firstElementChild && this.list) || this.element).focus({ preventScroll: true });
  }

  selectJob(job) {
    return Boolean(job && this.showJob(job.id));
  }

  getSelectedJob() {
    return this.selectedJob;
  }

  jobForEvent(event) {
    if (this.destroyed) return null;
    const row = event.target?.closest?.(".tasks-run-row");
    if (row) {
      if (this.mode !== "list" || row.parentElement !== this.list) return null;
      return this.manager.getJobs().find((job) => job.id === row.dataset.jobId) || null;
    }
    return this.mode === "details" ? this.selectedJob : null;
  }

  isActive(job = this.selectedJob) {
    return Boolean(job && ACTIVE_STATES.has(job.state));
  }

  targetForRerun(job = this.selectedJob) {
    return this.manager.getTargets().find((target) => target.id === job?.targetId);
  }

  canRerun(job = this.selectedJob) {
    const target = this.targetForRerun(job);
    return (
      !this.destroyed &&
      !this.runningRequest &&
      typeof this.actions.runTarget === "function" &&
      Boolean(target) &&
      !this.manager
        .getJobs()
        .some((job) => job.targetId === target.id && ACTIVE_STATES.has(job.state))
    );
  }

  async rerunTask(source = this.selectedJob) {
    if (!this.canRerun(source)) return null;
    const target = this.targetForRerun(source);
    this.runningRequest = true;
    this.update({ type: "state" });
    try {
      const job = await this.actions.runTarget(target);
      if (this.destroyed) return job;
      if (job && this.mode === "details" && this.selectedJob === source) this.selectJob(job);
      this.refreshJobs();
      return job;
    } finally {
      this.runningRequest = false;
      if (!this.destroyed) this.update({ type: "state" });
    }
  }

  reportError(error) {
    if (!this.destroyed)
      lumine.notifications.addError("Unable to complete the build action.", {
        detail: error.message,
      });
  }

  isListNavigation(event) {
    return (
      this.mode === "list" &&
      (event.target === this.list || Boolean(event.target?.closest?.(".tasks-run-row")))
    );
  }

  moveFocus(direction) {
    const rows = [...this.list.children];
    const index = rows.indexOf(document.activeElement?.closest?.(".tasks-run-row"));
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + direction))];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: "nearest" });
  }

  removeLog(job = this.selectedJob) {
    if (job && !this.isActive(job)) return this.manager.removeLog(job.id);
    return false;
  }

  async openSource(id) {
    const job = this.manager.getJobs().find((candidate) => candidate.id === id);
    if (this.destroyed || !job?.filePath) return;
    try {
      return await lumine.workspace.open(job.filePath, { searchAllPanes: true });
    } catch (error) {
      this.reportError(error);
    }
  }

  canToggleLog() {
    return (
      this.mode === "details" &&
      Boolean(this.selectedJob) &&
      (this.hiddenLogs.has(this.selectedJob) || this.getText().length > 0)
    );
  }

  toggleLog() {
    if (this.destroyed || !this.canToggleLog()) return;
    const job = this.selectedJob;
    if (this.hiddenLogs.has(job)) this.hiddenLogs.delete(job);
    else this.hiddenLogs.add(job);
    this.update({ type: "state" });
    this.followOutput();
  }

  dispatch(command, target = this.element) {
    const dispatched = lumine.commands.dispatch(target, command);
    return dispatched?.catch?.((error) => this.reportError(error));
  }

  getElement() {
    return this.element;
  }

  getTitle() {
    return "Tasks";
  }

  getURI() {
    return URI;
  }

  getSingletonKey() {
    return URI;
  }

  getIconName() {
    return "tools";
  }

  getDefaultLocation() {
    return "bottom";
  }

  getAllowedLocations() {
    return ["bottom"];
  }

  getDefaultVisibility() {
    return "visible";
  }

  getPreferredHeight() {
    return 300;
  }

  serialize() {
    return { deserializer: "tasks/TasksPanel" };
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  isDestroyed() {
    return this.destroyed;
  }

  async show() {
    if (this.destroyed) return;
    if (this.opening) return this.opening;
    const controller = new AbortController();
    this.openController = controller;
    const opening = lumine.workspace.open(this, {
      searchAllPanes: true,
      activatePane: false,
      pending: false,
      signal: controller.signal,
    });
    this.opening = opening;
    try {
      const item = await opening;
      if (!item || this.destroyed || controller.signal.aborted) return;
      lumine.workspace.getBottomDock().show();
      this.followOutput();
      return item;
    } finally {
      if (this.opening === opening) {
        this.opening = null;
        this.openController = null;
      }
    }
  }

  hide() {
    this.openController?.abort();
    this.openController = null;
    this.opening = null;
    lumine.workspace.hide(this);
  }

  toggle() {
    const pane = lumine.workspace.paneForItem(this);
    if (
      this.opening ||
      (pane?.getActiveItem() === this && lumine.workspace.getBottomDock().isVisible())
    ) {
      this.hide();
    } else {
      return this.show();
    }
  }

  focus() {
    if (this.mode === "list")
      (this.list.firstElementChild || this.element).focus({ preventScroll: true });
    else (this.output.hidden ? this.backButton : this.output).focus({ preventScroll: true });
  }

  appendChunk(chunk) {
    const element = this.output.ownerDocument.createElement("span");
    element.className = `task-output-${chunk.stream}`;
    element.textContent = chunk.text;
    this.output.appendChild(element);
  }

  update(change) {
    if (this.destroyed) return;
    if (change.type === "append" && !change.trimmed) this.appendChunk(change.chunk);
    else if (change.type === "reset" || change.trimmed) {
      this.output.replaceChildren();
      for (const chunk of this.model?.chunks || []) this.appendChunk(chunk);
    }
    const details = this.mode === "details";
    this.element.classList.toggle("tab-content-separated", !details);
    const job = this.selectedJob;
    this.element.dataset.mode = this.mode;
    this.element.dataset.state = details ? job?.state || "idle" : "idle";
    this.heading.hidden = !details;
    this.clearListButton.disabled = !this.hasCompletedJobs();
    this.listView.hidden = details;
    this.detailsView.hidden = !details;
    this.backButton.hidden = !details;
    this.state.hidden = !details;
    this.stateLabel.textContent = STATE_LABELS[job?.state] || "";
    this.title.textContent = details ? job?.name || job?.providerId || "Tasks execution" : "";
    this.title.hidden = !details;
    this.title.title = details ? job?.filePath || this.title.textContent : "";
    this.summary.textContent = details
      ? [
          job && this.formatDuration(job),
          job?.code != null ? `Exit code ${job.code}` : null,
          job?.outputTruncated ? "Output truncated" : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    const empty = this.getText().length === 0;
    const hidden = this.hiddenLogs.has(job);
    this.empty.hidden = !empty && !hidden;
    this.output.hidden = empty || hidden;
    this.emptyTitle.textContent = hidden
      ? "The log is hidden"
      : this.isActive()
        ? "Waiting for output…"
        : "The log is empty";
    this.rerunButton.hidden = !details;
    this.rerunButton.disabled = !this.canRerun();
    this.stopButton.hidden = !details;
    this.toggleLogButton.hidden = !details;
    this.toggleLogButton.textContent = hidden ? "Show log" : "Hide log";
    this.toggleLogButton.setAttribute("aria-expanded", String(!this.output.hidden));
    this.copyButton.hidden = !details;
    this.removeButton.hidden = !details;
    this.stopButton.disabled = !this.isActive();
    this.toggleLogButton.disabled = !this.canToggleLog();
    this.copyButton.disabled = empty;
    this.removeButton.disabled = !job || this.isActive();
    lumine.commands.invalidateAvailability({ target: this.element });
    if (change.type !== "state") this.followOutput();
  }

  followOutput() {
    if (this.mode === "details" && !this.output.hidden && lumine.config.get("tasks.scrollToEnd"))
      this.output.scrollTop = this.output.scrollHeight;
  }
  getText(job = this.selectedJob) {
    return job?.log.getText() || "";
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    this.openController?.abort();
    this.logSubscription?.dispose();
    this.element.remove();
    this.emitter.emit("did-destroy");
    this.subscriptions.dispose();
    this.rows.clear();
  }
}

TasksPanel.URI = URI;
module.exports = TasksPanel;
