const path = require("node:path");
const { createHash } = require("node:crypto");
const { CompositeDisposable, Disposable } = require("lumine");
const {
  DEFAULT_CONFIG_PATH,
  expandTarget,
  isConfigPath,
  loadConfigTargets,
  normalizeConfigFiles,
} = require("./target-loader");
const identityPath = (value) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const RESERVED_COMMANDS = new Set(
  [
    "stop",
    "stop-all",
    "toggle",
    "toggle-focus",
    "refresh-tasks",
    "next-error",
    "previous-error",
    "choose-task",
    "stop-task",
    "toggle-log",
    "clear-list",
    "clear-logs",
    "copy-log",
    "remove-log",
    "observed-files",
    "clear-observed",
    "open-observed-file",
    "unobserve-selected-file",
    "run-task",
    "rerun-task",
    "back-to-history",
    "open-details",
  ].map((name) => "tasks:" + name),
);

module.exports = {
  get targets() {
    return this.manager?.getTargets() || [];
  },
  set targets(targets) {
    this.manager?.setTargets(targets);
  },
  initialize() {
    if (this.manager && !this.manager.destroyed) return;
    this.manager = new (require("./task-manager"))();
    this.panel = null;
  },
  provideTasks() {
    this.initialize();
    return this.manager;
  },
  provideBackgroundTips() {
    return {
      packageName: "tasks",
      tips: [
        "{% if keys['tasks:run-task'] %}Choose and run a task with {{ 'tasks:run-task' | keystroke }}.{% else %}Tasks keeps task execution history and logs together in the bottom dock.{% endif %}",
      ],
    };
  },

  activate() {
    this.initialize();
    const manager = this.manager;
    const owner = (this.subscriptions = new CompositeDisposable());
    const configRefresh = { timer: null };
    this.configPromise = null;
    this.configRootsKey = null;
    this.configFiles = [DEFAULT_CONFIG_PATH];
    this.refreshTask = null;
    this.targets = [];
    this.targetCommands = new CompositeDisposable();
    this.statusEdges = [];
    this.linterEdges = [];
    this.busyEdges = [];
    this.busyJobs = new Map();
    this.unseenJobs = new Map();
    this.projectRequests = new Map();
    this.projectPlans = new WeakMap();
    this.projectProviders = new Map();
    this.statusElement = document.createElement("status-bar-tile");
    this.statusElement.className = "tasks-status";
    this.statusElement.setAttribute("data-context-menu-boundary", "");
    this.statusElement.setAttribute("role", "button");
    this.statusElement.tabIndex = 0;
    this.statusIcon = document.createElement("span");
    this.statusIcon.className = "icon icon-tools is-icon-only";
    this.statusIcon.setAttribute("aria-hidden", "true");
    this.statusNewIndicator = document.createElement("sup");
    this.statusNewIndicator.className = "tasks-status-new-indicator";
    this.statusNewIndicator.setAttribute("aria-hidden", "true");
    this.statusObservedCount = document.createElement("sub");
    this.statusObservedCount.className = "tasks-status-observed-count";
    this.statusObservedCount.setAttribute("aria-hidden", "true");
    this.statusElement.append(this.statusIcon, this.statusNewIndicator, this.statusObservedCount);
    const toggleFromStatus = () => {
      if (this.subscriptions !== owner || owner.disposed) return;
      const dispatched = lumine.commands.dispatch(this.statusElement, "tasks:toggle");
      dispatched?.catch((error) => {
        if (this.subscriptions === owner && !owner.disposed)
          lumine.notifications.addError("Unable to toggle Tasks.", { detail: error.message });
      });
    };
    this.statusElement.addEventListener("click", (event) => {
      if (event.button !== 0 || (process.platform === "darwin" && event.ctrlKey)) return;
      toggleFromStatus();
    });
    this.statusElement.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (this.subscriptions !== owner || owner.disposed) return;
      event.preventDefault();
      event.stopPropagation();
      toggleFromStatus();
    });
    owner.add(
      this.targetCommands,
      new Disposable(() => clearTimeout(configRefresh.timer)),
      manager.onDidChangeTargets(() => {
        if (this.subscriptions === owner && !owner.disposed) this.updateStatus();
      }),
      lumine.tooltips.add(this.statusElement, {
        html: false,
        title: () => this.statusDescription,
        keyBindingCommand: "tasks:toggle-focus",
        keyBindingTarget: this.statusElement,
      }),
      manager.onDidChangeObserved(() => {
        if (this.subscriptions === owner && !owner.disposed) this.updateStatus();
      }),
      manager.onDidChangeProviders(({ providerId }) => {
        if (!providerId.startsWith("project:") && this.subscriptions === owner && !owner.disposed)
          this.refreshTargets({ reloadConfig: false });
      }),
      manager.onDidChangeJob(() => {
        if (this.subscriptions !== owner) return;
        this.publishDiagnostics();
        if (this.subscriptions !== owner || owner.disposed) return;
        this.updateStatus();
      }),
      manager.onDidStartJob((job) => {
        if (this.subscriptions === owner) this.startBusyJob(job, this.serviceState());
      }),
      manager.onDidFinishJob((job) => {
        if (this.subscriptions !== owner) return;
        if (!this.isTasksPanelVisible()) this.unseenJobs.set(job.id, job);
        this.updateStatus();
        if (this.subscriptions !== owner || owner.disposed) return;
        const services = this.serviceState();
        this.releaseBusyJob(services, job.id);
        if (this.subscriptions !== owner) return;
        this.retireProjectProviders();
      }),
      lumine.commands.add("lumine-workspace", {
        "tasks:run-task": {
          description: "Choose a document or project task and run it.",
          didDispatch: () => this.selectTask(),
        },
        "tasks:stop": {
          description: "Stop the task whose log is selected.",
          isAvailable: (event) => this.isActive(this.selectedJob(event)),
          didDispatch: (event) => this.selectedJob(event)?.stop(),
        },
        "tasks:stop-all": {
          description: "Stop every active build task.",
          isAvailable: () => manager.getJobs({ activeOnly: true }).length > 0,
          didDispatch: () => manager.stopAll(),
        },
        "tasks:clear-logs": {
          description: "Remove every completed execution log while keeping running tasks.",
          isAvailable: () => manager.getJobs().some((job) => !this.isActive(job)),
          didDispatch: () => {
            for (const job of manager.getJobs()) {
              if (this.subscriptions !== owner || owner.disposed) return;
              if (!this.isActive(job)) manager.removeLog(job.id);
            }
          },
        },
        "tasks:toggle": { didDispatch: () => this.ensurePanel().toggle() },
        "tasks:toggle-focus": { didDispatch: () => this.toggleFocus() },
        "tasks:observed-files": {
          description: "Manage documents observed by every build provider.",
          didDispatch: () => this.showObservedFiles(),
        },
        "tasks:clear-observed": {
          description: "Stop automatic builds for all observed documents.",
          isAvailable: () => manager.getObserved().length > 0,
          didDispatch: () => manager.clearObserved(),
        },
        "tasks:next-error": {
          description: "Open the next diagnostic in the selected build log.",
          isAvailable: (event) => Boolean(this.selectedJob(event)?.diagnostics.length),
          didDispatch: (event) => this.openError(1, event),
        },
        "tasks:previous-error": {
          description: "Open the previous diagnostic in the selected build log.",
          isAvailable: (event) => Boolean(this.selectedJob(event)?.diagnostics.length),
          didDispatch: (event) => this.openError(-1, event),
        },
      }),
      lumine.contextMenu.add({
        ".tasks-status": {
          commandTarget: "focus",
          items: [
            { label: "Toggle Tasks", command: "tasks:toggle" },
            { label: "Toggle Tasks Focus", command: "tasks:toggle-focus" },
            { type: "separator" },
            { label: "Run Task…", command: "tasks:run-task" },
            { label: "Stop All Tasks", command: "tasks:stop-all" },
            { type: "separator" },
            { label: "Observed Documents…", command: "tasks:observed-files" },
            { label: "Stop Observing All Documents", command: "tasks:clear-observed" },
            { type: "separator" },
            { label: "Clear All Logs", command: "tasks:clear-logs" },
          ],
        },
      }),
      lumine.project.onDidChangePaths(() => this.refreshTargets()),
      lumine.config.onDidChange("tasks.additionalConfigFiles", () => {
        if (this.subscriptions === owner && !owner.disposed) this.refreshTargets();
      }),
      lumine.workspace.onDidChangeActiveTextEditor(() =>
        this.refreshTargets({ reloadConfig: false }),
      ),
      lumine.workspace
        .getCenter()
        .onDidChangeActivePaneItem(() => this.refreshTargets({ reloadConfig: false })),
      lumine.project.onDidChangeFiles((events) => {
        if (
          this.subscriptions !== owner ||
          owner.disposed ||
          !events.some((event) => isConfigPath(event.path, this.configFiles))
        )
          return;
        clearTimeout(configRefresh.timer);
        configRefresh.timer = setTimeout(() => {
          if (this.subscriptions === owner && !owner.disposed) this.refreshTargets();
        }, 100);
      }),
      lumine.workspace.observeTextEditors((editor) => {
        if (this.subscriptions !== owner || owner.disposed) return;
        const subscriptions = new CompositeDisposable(
          editor.onDidChangeGrammar(() => {
            if (this.subscriptions === owner && !owner.disposed) manager.reconcileEditor(editor);
          }),
          editor.onDidDestroy(() => {
            owner.remove(subscriptions);
            subscriptions.dispose();
          }),
        );
        owner.add(subscriptions);
      }),
      lumine.config.onDidChange("tasks.statusBar", () => this.updateStatusTile()),
      lumine.config.onDidChange("tasks.statusBarPriority", () => this.updateStatusTile()),
      lumine.workspace.addOpener((uri) =>
        uri === "lumine://tasks" ? this.ensurePanel() : undefined,
      ),
    );
    const dock = lumine.workspace.getBottomDock();
    const updateVisibility = () => {
      if (this.subscriptions === owner && !owner.disposed) this.updateStatus();
    };
    owner.add(
      dock.onDidChangeVisible(updateVisibility),
      dock.observePanes((pane) => {
        const paneSubscriptions = new CompositeDisposable(
          pane.onDidChangeActiveItem(updateVisibility),
          pane.onDidDestroy(() => {
            owner.remove(paneSubscriptions);
            paneSubscriptions.dispose();
            updateVisibility();
          }),
        );
        owner.add(paneSubscriptions);
      }),
    );
    this.refreshTargets();
    this.updateStatus();
  },

  deactivate() {
    const owner = this.subscriptions;
    const manager = this.manager;
    const panel = this.panel;
    const host = this.selectListHost;
    const observedList = this.observedList;
    const statusElement = this.statusElement;
    const busyJobs = this.busyJobs;
    this.subscriptions = null;
    this.manager = null;
    this.panel = null;
    this.selectListHost = null;
    this.statusTile = null;
    this.statusElement = null;
    this.statusIcon = this.statusNewIndicator = this.statusObservedCount = null;
    this.unseenJobs?.clear();
    this.observedList = null;
    this.refreshGeneration = (this.refreshGeneration || 0) + 1;
    this.refreshController?.abort();
    observedList?.destroy();
    manager?.dispose();
    owner?.dispose();
    for (const { busy } of busyJobs?.values() || []) busy.dispose();
    busyJobs?.clear();
    host?.destroy();
    panel?.destroy();
    statusElement?.remove();
  },
  isActive(job) {
    return Boolean(job && ["preparing", "running", "collecting"].includes(job.state));
  },
  selectedJob(event) {
    const target = event?.target;
    if (target && this.panel?.getElement().contains(target)) {
      const id = target.closest?.("[data-job-id]")?.dataset.jobId;
      if (id) return this.manager.getJobs().find((job) => job.id === id) || null;
    }
    return this.panel?.getSelectedJob() || this.manager.getJobs().at(-1);
  },
  ensurePanel() {
    this.initialize();
    if (!this.panel || this.panel.isDestroyed()) {
      const panel = new (require("./tasks-panel"))(this.manager, {
        runTarget: (target) => this.runTarget(target),
      });
      panel.onDidDestroy(() => {
        if (this.panel === panel) {
          this.panel = null;
          this.updateStatus();
        }
      });
      this.panel = panel;
    }
    return this.panel;
  },
  deserializeTasksPanel() {
    return this.ensurePanel();
  },
  toggleFocus() {
    const panel = this.ensurePanel();
    if (panel.getElement().contains(document.activeElement))
      lumine.workspace.getCenter().getActivePane()?.activate();
    else return panel.show().then(() => panel.focus());
  },

  projectPathForEditor(editor) {
    const filePath = editor?.getPath();
    if (!filePath) return null;
    return (
      lumine.project
        .getPaths()
        .slice()
        .sort((a, b) => b.length - a.length)
        .find((root) => filePath === root || filePath.startsWith(root + path.sep)) || null
    );
  },
  context(editor = lumine.workspace.getActiveTextEditor()) {
    const centerItem = lumine.workspace.getCenter().getActivePaneItem();
    if (!editor || editor.isMini?.())
      editor = lumine.workspace.isTextEditor(centerItem) ? centerItem : null;
    let filePath = editor?.getPath() || null;
    if (!filePath && centerItem?.getPath?.()) {
      filePath = this.manager?.getArtifactTarget(centerItem.getPath())?.filePath || null;
    }
    return {
      editor,
      filePath,
      projectPath: this.projectPathForEditor(editor) || lumine.project.getPaths()[0] || null,
    };
  },
  async refreshTargets(options = {}) {
    const owner = this.subscriptions;
    if (!owner) return [];
    let request = this.refreshTargetSnapshot(options);
    this.refreshTask = request;
    let targets = await request;
    while (this.subscriptions === owner && this.refreshTask !== request) {
      request = this.refreshTask;
      targets = await request;
    }
    return this.subscriptions === owner && !owner.disposed ? targets : [];
  },
  async refreshTargetSnapshot({ updateList = true, reloadConfig = true } = {}) {
    const owner = this.subscriptions;
    if (!owner) return [];
    const roots = [...new Set(lumine.project.getPaths().map((root) => path.resolve(root)))];
    const additionalFiles = lumine.config.get("tasks.additionalConfigFiles") ?? [];
    const rootsKey = JSON.stringify([roots.map(identityPath), additionalFiles]);
    if (reloadConfig || !this.configPromise || this.configRootsKey !== rootsKey) {
      this.refreshController?.abort();
      const controller = (this.refreshController = new AbortController());
      this.configRootsKey = rootsKey;
      this.configPromise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        const configFiles = normalizeConfigFiles(additionalFiles);
        if (this.subscriptions === owner && !owner.disposed) this.configFiles = configFiles;
        return Promise.all(
          roots.map((root) =>
            loadConfigTargets(root, { signal: controller.signal, additionalFiles }),
          ),
        );
      });
    }
    const controller = this.refreshController;
    const generation = (this.refreshGeneration = (this.refreshGeneration || 0) + 1);
    const context = this.context();
    try {
      const configured = (await this.configPromise).flat();
      if (this.subscriptions !== owner || owner.disposed || this.refreshGeneration !== generation)
        return this.targets;
      const configurations = new Map();
      for (const target of configured) {
        const configPath = target.configPath;
        const key = identityPath(configPath);
        const existing = configurations.get(key);
        if (existing && existing.root !== target.projectPath) {
          if (existing.root.length > target.projectPath.length) continue;
          configurations.set(key, { root: target.projectPath, targets: [] });
        }
        if (!configurations.has(key))
          configurations.set(key, { root: target.projectPath, targets: [] });
        configurations.get(key).targets.push(target);
      }
      const targets = [];
      for (const config of configurations.values()) {
        const occurrences = new Map();
        for (const target of config.targets) {
          const occurrence = occurrences.get(target.name) || 0;
          occurrences.set(target.name, occurrence + 1);
          const signature = createHash("sha256")
            .update(JSON.stringify([identityPath(target.configPath), target.name, occurrence]))
            .digest("hex");
          const providerId = "project:" + signature;
          targets.push({
            ...target,
            providerId,
            id: this.manager.key(providerId, target.configPath),
            filePath: target.configPath,
            canonicalPath: target.configPath,
            source:
              roots.length > 1
                ? `${path.basename(target.projectPath)}/${target.source}`
                : target.source,
          });
        }
      }
      if (context.filePath)
        for (const { provider } of this.manager.providers.values()) {
          if (!provider.id.startsWith("project:") && provider.supports(context.filePath)) {
            const canonicalPath = this.manager.resolve(provider.id, context.filePath);
            targets.push({
              id: this.manager.key(provider.id, canonicalPath),
              providerId: provider.id,
              name: provider.name,
              source: context.filePath,
              filePath: context.filePath,
              canonicalPath,
            });
          }
        }
      const commandNames = new Set(RESERVED_COMMANDS);
      for (const target of targets) {
        if (!target.commandName) continue;
        if (!/^tasks:[a-z0-9-]+$/u.test(target.commandName) || commandNames.has(target.commandName))
          throw new Error("Target commands require unique, unreserved tasks: names.");
        commandNames.add(target.commandName);
      }
      this.manager.setTargets(targets);
      this.retireProjectProviders();
      this.targetCommands.dispose();
      owner.remove(this.targetCommands);
      this.targetCommands = new CompositeDisposable();
      owner.add(this.targetCommands);
      for (const target of targets)
        if (target.commandName && /^tasks:[a-z0-9-]+$/u.test(target.commandName)) {
          this.targetCommands.add(
            lumine.commands.add("lumine-workspace", target.commandName, {
              didDispatch: () => {
                return this.runTarget(target);
              },
            }),
          );
        }
      if (updateList) this.selectListHost?.getModel().setItems(targets);
      this.updateStatus();
      return targets;
    } catch (error) {
      if (
        controller.signal.aborted ||
        this.subscriptions !== owner ||
        this.refreshGeneration !== generation
      )
        return [];
      this.targets = [];
      this.targetCommands.dispose();
      this.selectListHost?.getModel().setItems([]);
      lumine.notifications.addError("Unable to load build targets.", { detail: error.message });
      return [];
    }
  },
  selectTask() {
    if (!this.selectListHost)
      this.selectListHost = lumine.workspace.addSelectList(
        {
          emptyMessage: "No build tasks found",
          getItemId: (target) => target.id,
          search: { getFilterText: (target) => target.name + " " + target.source },
          renderItem: (target) => ({
            primary: target.name,
            secondary: target.source,
          }),
          source: {
            mode: "snapshot",
            loadingMessage: "Loading build tasks…",
            load: () => this.refreshTargets({ updateList: false }),
          },
          commands: {
            "tasks:choose-task": {
              description: "Run the selected document or project task.",
              didDispatch: (event) => this.runTarget(event.detail.item),
            },
            "tasks:refresh-tasks": {
              description: "Reload the available document and project tasks.",
              didDispatch: ({ detail }) => detail.dialog.reload(),
            },
          },
          actions: [
            {
              command: "tasks:choose-task",
              context: "item",
              primary: true,
              disposition: "close",
              dispatch: "local",
            },
            {
              command: "tasks:refresh-tasks",
              context: "dialog",
              group: "List",
              disposition: "stay",
              dispatch: "local",
            },
          ],
        },
        { className: "tasks-targets", crumb: "Run task" },
      );
    return this.selectListHost.show();
  },
  showObservedFiles() {
    if (!this.observedList) this.observedList = new (require("./observed-list"))(this.manager);
    return this.observedList.show();
  },
  async runTarget(requestedTarget, { reason = "manual", editor } = {}) {
    const owner = this.subscriptions;
    if (!owner || owner.disposed) return null;
    const id = typeof requestedTarget === "string" ? requestedTarget : requestedTarget?.id;
    const target = this.targets.find((candidate) => candidate.id === id);
    if (!target) return null;
    const context = this.context(editor);
    let projectPlan;
    if (!target.projectPath && reason === "manual" && lumine.config.get("tasks.saveOnBuild")) {
      const sourceEditor = lumine.workspace
        .getTextEditors()
        .find((item) => item.getPath() === target.filePath);
      if (sourceEditor && sourceEditor.getFileState() !== "unmodified") await sourceEditor.save();
      if (
        this.subscriptions !== owner ||
        owner.disposed ||
        sourceEditor?.isDestroyed() ||
        (sourceEditor && sourceEditor.getPath() !== target.filePath)
      )
        return null;
    }
    if (target.projectPath) {
      const plan = expandTarget(target, { ...context, projectPath: target.projectPath });
      projectPlan = plan;
      if (lumine.config.get("tasks.saveOnBuild") && reason !== "save") {
        await Promise.all(
          lumine.workspace
            .getTextEditors()
            .filter((item) => item.getFileState() !== "unmodified")
            .map((item) => item.save()),
        );
      }
      if (this.subscriptions !== owner || owner.disposed) return null;
      this.projectRequests.set(target.providerId, plan);
      this.ensureProjectProvider(target);
    }
    const job = this.manager.run({
      providerId: target.providerId,
      filePath: target.filePath,
      reason,
    });
    if (this.subscriptions !== owner || owner.disposed) return job;
    if (job && projectPlan && !this.projectPlans.has(job)) this.projectPlans.set(job, projectPlan);
    return job;
  },
  ensureProjectProvider(target) {
    if (this.projectProviders.has(target.providerId)) return;
    const requests = this.projectRequests;
    const plans = this.projectPlans;
    const manager = this.manager;
    const registration = this.manager.registerProvider({
      id: target.providerId,
      name: target.name,
      supports: () => true,
      prepare: ({ filePath }) => {
        const request =
          plans.get(manager.getJob({ providerId: target.providerId, filePath })) ||
          requests.get(target.providerId);
        if (!request) throw new Error("No project target was selected.");
        return request;
      },
      collectResult: ({ job, plan, stdout, stderr }) => {
        const { parseErrors, toLinterMessages } = require("./error-parser");
        return {
          diagnostics: toLinterMessages(parseErrors(stdout + stderr, plan.errorMatch, plan.cwd)),
          artifacts: job.artifacts,
        };
      },
    });
    this.projectProviders.set(target.providerId, registration);
    this.subscriptions.add(registration);
  },
  retireProjectProviders() {
    if (!this.subscriptions) return;
    const available = new Set(
      this.targets.filter((target) => target.projectPath).map((target) => target.providerId),
    );
    for (const [id, registration] of [...this.projectProviders]) {
      if (available.has(id) || this.manager.getJobs({ providerId: id, activeOnly: true }).length)
        continue;
      this.projectProviders.delete(id);
      this.projectRequests.delete(id);
      this.subscriptions.remove(registration);
      registration.dispose();
    }
  },
  async openError(direction, event) {
    const job = this.selectedJob(event);
    if (!job?.diagnostics.length) return;
    job.errorIndex =
      ((job.errorIndex ?? -1) + direction + job.diagnostics.length) % job.diagnostics.length;
    const diagnostic = job.diagnostics[job.errorIndex];
    const [row, column] = diagnostic.location.position[0];
    return lumine.workspace.open(diagnostic.location.file, {
      initialLine: row,
      initialColumn: column,
      searchAllPanes: true,
    });
  },
  serviceState() {
    const owner = this.subscriptions;
    if (!owner || owner.disposed) return null;
    if (owner.buildServices) return owner.buildServices;
    const services = {
      owner,
      manager: this.manager,
      element: this.statusElement,
      disposed: false,
      maps: { status: new Map(), busy: new Map(), linter: new Map() },
      edges: { status: this.statusEdges, busy: this.busyEdges, linter: this.linterEdges },
      jobs: this.busyJobs,
      attachment: { tile: null, record: null, priority: null, attaching: false, requested: false },
      publishing: false,
      publishRequested: false,
    };
    owner.buildServices = services;
    owner.add(
      new Disposable(() => {
        services.disposed = true;
        const tile = services.attachment.tile;
        services.attachment.tile = services.attachment.record = null;
        if (this.statusTile === tile) this.statusTile = null;
        const linters = [...services.maps.linter.values()].map((record) => record.resource);
        for (const map of Object.values(services.maps)) map.clear();
        for (const edges of Object.values(services.edges)) edges.length = 0;
        const work = [...services.jobs.values()];
        services.jobs.clear();
        tile?.destroy();
        for (const entry of work) this.disposeBusyEntry(entry);
        for (const linter of linters) linter?.dispose();
      }),
    );
    return services;
  },
  ownsServices(services) {
    return Boolean(
      services &&
      !services.disposed &&
      !services.owner.disposed &&
      this.subscriptions === services.owner,
    );
  },
  consumeService(services, kind, value, create) {
    if (!this.ownsServices(services)) return new Disposable();
    const map = services.maps[kind],
      edges = services.edges[kind];
    let record = map.get(value);
    const fresh = !record;
    if (fresh) {
      record = { value, refs: 0, resource: null, messages: null };
      map.set(value, record);
    }
    record.refs++;
    const edge = { record, value };
    edges.push(edge);
    const lease = new Disposable(() => {
      if (services.disposed || map.get(value) !== record) return;
      const index = edges.indexOf(edge);
      if (index !== -1) edges.splice(index, 1);
      record.refs--;
      if (record.refs === 0) {
        map.delete(value);
        const resource = record.resource;
        record.resource = null;
        if (kind === "busy") {
          for (const [id, entry] of [...services.jobs])
            if (entry.record === record) this.releaseBusyJob(services, id, entry);
        }
        resource?.dispose();
      }
      if (!this.ownsServices(services)) return;
      if (kind === "status") this.updateStatusTile(services);
      else if (kind === "busy") this.reconcileBusyJobs(services);
      else this.publishDiagnostics(services);
    });
    try {
      if (fresh && create) {
        const resource = create();
        if (this.ownsServices(services) && map.get(value) === record) record.resource = resource;
        else resource?.dispose();
      }
      if (!this.ownsServices(services)) return lease;
      if (kind === "status") this.updateStatusTile(services);
      else if (kind === "busy") this.reconcileBusyJobs(services);
      else this.publishDiagnostics(services);
      return lease;
    } catch (error) {
      lease.dispose();
      throw error;
    }
  },
  consumeStatusBar(service) {
    const services = this.serviceState();
    if (!services) return new Disposable();
    return service.observeWindows((bar) => this.consumeService(services, "status", bar));
  },
  updateStatusTile(services = this.serviceState()) {
    if (!this.ownsServices(services)) return;
    const attachment = services.attachment;
    attachment.requested = true;
    if (attachment.attaching) return;
    attachment.attaching = true;
    try {
      while (attachment.requested && this.ownsServices(services)) {
        attachment.requested = false;
        const record = services.edges.status.at(-1)?.record;
        const enabled = lumine.config.get("tasks.statusBar");
        const priority = lumine.config.get("tasks.statusBarPriority");
        if (
          enabled &&
          attachment.tile &&
          attachment.record === record &&
          attachment.priority === priority
        )
          continue;
        const previous = attachment.tile;
        attachment.tile = attachment.record = null;
        if (this.statusTile === previous) this.statusTile = null;
        previous?.destroy();
        if (!this.ownsServices(services) || attachment.requested) continue;
        if (!enabled || !record) continue;
        const tile = record.value.addLeftTile({ item: services.element, priority });
        if (
          !this.ownsServices(services) ||
          attachment.requested ||
          services.edges.status.at(-1)?.record !== record ||
          !lumine.config.get("tasks.statusBar")
        ) {
          tile?.destroy();
          continue;
        }
        attachment.tile = tile;
        attachment.record = record;
        attachment.priority = priority;
        this.statusTile = tile;
      }
    } finally {
      attachment.attaching = false;
    }
  },
  updateStatus() {
    if (!this.manager || !this.statusElement) return;
    const jobs = this.manager.getJobs();
    const active = jobs.filter((job) => this.isActive(job));
    const observed = new Set(
      this.manager.getObserved().map((entry) => identityPath(entry.filePath)),
    ).size;
    const retainedIds = new Set(jobs.map((job) => job.id));
    for (const id of this.unseenJobs.keys()) {
      if (!retainedIds.has(id)) this.unseenJobs.delete(id);
    }
    if (this.isTasksPanelVisible()) this.unseenJobs.clear();
    const unseen = [...this.unseenJobs.values()];
    const outcomes = ["failed", "cancelled", "passed"];
    this.statusElement.dataset.state =
      outcomes.find((state) => unseen.some((job) => job.state === state)) || "idle";
    this.statusElement.dataset.running = String(active.length > 0);
    this.statusElement.dataset.new = String(unseen.length);
    this.statusElement.dataset.observed = String(observed);
    this.statusNewIndicator.textContent = unseen.length ? String(unseen.length) : "";
    this.statusNewIndicator.hidden = unseen.length === 0;
    this.statusObservedCount.textContent = observed ? String(observed) : "";
    this.statusObservedCount.hidden = observed === 0;
    const activity = `${active.length} active task${active.length === 1 ? "" : "s"}`;
    const observations = `${observed} observed document${observed === 1 ? "" : "s"}`;
    this.statusDescription = [
      `Tasks: ${activity}, ${observations}.`,
      unseen.length
        ? `${unseen.length} new log${unseen.length === 1 ? "" : "s"}: ${outcomes
            .map((state) => {
              const count = unseen.filter((job) => job.state === state).length;
              return count ? `${count} ${state}` : null;
            })
            .filter(Boolean)
            .join(", ")}.`
        : "No new logs.",
      unseen.length ? "Click to open Tasks and mark new logs as seen." : "Click to toggle Tasks.",
    ]
      .filter(Boolean)
      .join("\n");
    this.statusElement.setAttribute("aria-label", this.statusDescription);
    lumine.commands.invalidateAvailability();
  },
  isTasksPanelVisible() {
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return false;
    const pane = lumine.workspace.paneForItem(panel);
    return lumine.workspace.getBottomDock().isVisible() && pane?.getActiveItem() === panel;
  },
  consumeBusySignal(value) {
    return this.consumeService(this.serviceState(), "busy", value);
  },
  reconcileBusyJobs(services) {
    if (!this.ownsServices(services)) return;
    for (const job of services.manager.getJobs({ activeOnly: true }))
      this.startBusyJob(job, services);
  },
  disposeBusyEntry(entry) {
    const busy = entry.busy;
    entry.busy = null;
    busy?.dispose();
  },
  releaseBusyJob(services, id, entry = services?.jobs.get(id)) {
    if (!entry) return;
    if (services.jobs.get(id) === entry) services.jobs.delete(id);
    this.disposeBusyEntry(entry);
  },
  startBusyJob(job, services) {
    if (!this.ownsServices(services) || !this.isActive(job) || services.jobs.has(job.id)) return;
    const record = services.edges.busy.at(-1)?.record;
    if (!record) return;
    const entry = { record, busy: null };
    services.jobs.set(job.id, entry);
    const current = () =>
      this.ownsServices(services) &&
      this.isActive(job) &&
      services.jobs.get(job.id) === entry &&
      services.maps.busy.get(record.value) === record;
    try {
      entry.busy = record.value.create();
      if (!current()) {
        this.releaseBusyJob(services, job.id, entry);
        return;
      }
      entry.busy.add("Building " + job.name);
      if (!current()) this.releaseBusyJob(services, job.id, entry);
    } catch (error) {
      this.releaseBusyJob(services, job.id, entry);
      throw error;
    }
  },
  consumeLinterRegistry(registerIndie) {
    return this.consumeService(this.serviceState(), "linter", registerIndie, () =>
      registerIndie({ name: "Tasks", markerInvalidation: "never" }),
    );
  },
  publishDiagnostics(services = this.serviceState()) {
    if (!this.ownsServices(services)) return;
    services.publishRequested = true;
    if (services.publishing) return;
    services.publishing = true;
    try {
      while (services.publishRequested && this.ownsServices(services)) {
        services.publishRequested = false;
        const messages = services.manager.getMessages();
        for (const record of [...services.maps.linter.values()]) {
          if (!this.ownsServices(services) || services.publishRequested) break;
          if (services.maps.linter.get(record.value) !== record || !record.resource) continue;
          if (
            record.messages?.length === messages.length &&
            record.messages.every((message, index) => message === messages[index])
          )
            continue;
          record.messages = messages;
          try {
            record.resource.setAllMessages(structuredClone(messages));
          } catch (error) {
            record.messages = null;
            throw error;
          }
        }
      }
    } finally {
      services.publishing = false;
    }
  },
};
