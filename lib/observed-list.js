const path = require("node:path");
const { CompositeDisposable } = require("lumine");

function itemId(item) {
  const filePath = path.resolve(item.filePath);
  return JSON.stringify([
    item.providerId,
    process.platform === "win32" ? filePath.toLowerCase() : filePath,
  ]);
}

class ObservedList {
  constructor(manager) {
    this.manager = manager;
    this.window = lumine.workspace.getFocusedWindow() ?? lumine.workspace.getMainWindow();
    this.items = [];
    this.destroyed = false;
    this.updateId = 0;
    this.selectListHost = lumine.workspace.addSelectList(
      {
        emptyMessage: "No documents observed for compile-on-save",
        getItemId: itemId,
        source: { mode: "snapshot", load: () => this.loadItems() },
        search: { getFilterText: (item) => `${item.displayPath} ${item.providerName}` },
        renderItem: (item, { highlight }) => ({
          primary: highlight(item.displayPath),
          secondary: item.providerName,
          didRender: (element) =>
            lumine.icons.applyTo(
              element.querySelector(".primary-line"),
              { path: item.filePath, context: "tasks-observed-files", hints: { directory: false } },
              { setData: false },
            ),
        }),
        commands: {
          "tasks:open-observed-file": {
            description: "Open the selected observed source in the editor.",
            isAvailable: ({ detail }) =>
              Boolean(detail?.item ?? this.selectList?.getSelectedItem()),
            didDispatch: (event) => this.openObservedFile(event.detail?.item, event.detail ?? {}),
          },
          "tasks:unobserve-selected-file": {
            description: "Stop compiling the selected document when its files change.",
            isAvailable: ({ detail }) =>
              Boolean(detail?.item ?? this.selectList?.getSelectedItem()),
            didDispatch: (event) => this.unobserveSelectedFile(event.detail?.item),
          },
        },
        actions: [
          {
            command: "tasks:open-observed-file",
            context: "item",
            primary: true,
            group: "Document",
            disposition: "close",
            dispatch: "local",
          },
          {
            command: "tasks:unobserve-selected-file",
            context: "item",
            group: "Document",
            disposition: "stay",
            dispatch: "local",
          },
          {
            command: "tasks:clear-observed",
            context: "dialog",
            when: () => this.items.length > 0,
            group: "Observations",
            tone: "danger",
            disposition: "stay",
            dispatch: "workspace",
          },
        ],
      },
      { window: this.window, className: "tasks-observed-files", crumb: "Observed Documents" },
    );
    this.selectList = this.selectListHost.getModel();
    this.subscriptions = new CompositeDisposable(
      manager.onDidChangeObserved(() => this.update()),
      manager.onDidChangeProviders(() => this.update()),
    );
  }

  loadItems() {
    if (this.destroyed) return [];
    this.items = this.manager
      .getObserved()
      .map((entry) => {
        const [projectPath, relativePath] = lumine.project.relativizePath(entry.filePath);
        return {
          ...entry,
          providerName:
            this.manager.providers.get(entry.providerId)?.provider.name ?? entry.providerId,
          displayPath: projectPath && relativePath ? relativePath : entry.filePath,
        };
      })
      .sort(
        (left, right) =>
          left.providerName.localeCompare(right.providerName) ||
          left.displayPath.localeCompare(right.displayPath),
      );
    return this.items;
  }

  update() {
    if (this.destroyed) return Promise.resolve();
    const generation = ++this.updateId;
    const query = this.selectList.getQuery();
    const previous = this.selectList.getSelectedItem();
    const index = this.selectList.getSelectedIndex();
    let updating;
    try {
      const items = this.loadItems();
      updating = this.selectList.setItems(items).then(() => {
        if (this.destroyed || generation !== this.updateId || this.selectList.getQuery() !== query)
          return;
        if (previous && items.some((item) => itemId(item) === itemId(previous))) return;
        const count = this.selectList.getMatchCount();
        if (count > 0 && index >= 0) return this.selectList.selectIndex(Math.min(index, count - 1));
      });
    } catch (error) {
      updating = Promise.reject(error);
    }
    this.pendingUpdate = updating.catch((error) => {
      if (
        this.destroyed ||
        generation !== this.updateId ||
        error?.name === "AbortError" ||
        this.selectList.getQuery() !== query
      )
        return;
      lumine.notifications.addError("Unable to refresh observed documents.", {
        detail: error.message,
      });
    });
    return this.pendingUpdate;
  }

  openObservedFile(item = this.selectList.getSelectedItem(), context = {}) {
    if (this.destroyed || !item) return;
    context.signal?.throwIfAborted();
    return lumine.workspace.open(item.filePath, {
      pane: this.window.getEditorContainer().getActivePane(),
      pending: lumine.config.get("core.allowPendingPaneItems"),
      searchAllPanes: true,
      signal: context.signal,
    });
  }

  unobserveSelectedFile(item = this.selectList.getSelectedItem()) {
    if (this.destroyed || !item) return;
    const changed = this.manager.setObserved(item, false);
    return changed ? this.pendingUpdate : this.update();
  }

  show() {
    if (this.destroyed) return Promise.resolve();
    return this.selectListHost.show();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.updateId++;
    this.subscriptions.dispose();
    return this.selectListHost.destroy();
  }
}

module.exports = ObservedList;
