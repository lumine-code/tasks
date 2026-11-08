const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Emitter, CompositeDisposable } = require("lumine");

describe("Tasks observed document list", () => {
  let directory, manager, events, entries, list, subscriptions, ObservedList;

  beforeEach(() => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    ObservedList = require("../lib/observed-list");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-observed-list-"));
    lumine.project.setPaths([directory]);
    events = new Emitter();
    entries = [];
    subscriptions = new CompositeDisposable(events);
    manager = {
      providers: new Map([
        ["latex-tools", { provider: { name: "LaTeX" } }],
        ["typst-tools", { provider: { name: "Typst" } }],
      ]),
      getObserved: () => entries.slice(),
      onDidChangeObserved: (callback) => events.on("observed", callback),
      onDidChangeProviders: (callback) => events.on("providers", callback),
      setObserved: jasmine.createSpy("set observed").and.callFake((entry, enabled) => {
        const index = entries.findIndex(
          (value) => value.providerId === entry.providerId && value.filePath === entry.filePath,
        );
        if (enabled || index < 0) return false;
        entries.splice(index, 1);
        events.emit("observed", { ...entry, enabled: false });
        return true;
      }),
      clearObserved: () => {
        for (const entry of entries.slice()) manager.setObserved(entry, false);
      },
    };
    subscriptions.add(
      lumine.commands.add("lumine-workspace", "tasks:clear-observed", () =>
        manager.clearObserved(),
      ),
    );
  });

  afterEach(async () => {
    await list?.destroy();
    subscriptions.dispose();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Unsafe observed-list fixture cleanup");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function source(name, providerId = "latex-tools") {
    const filePath = path.join(directory, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "A real observed source.\n");
    const entry = { providerId, filePath };
    entries.push(entry);
    return entry;
  }

  it("renders and searches mixed providers using project-relative source paths", async () => {
    source("documents/report.tex");
    source("documents/report.typ", "typst-tools");
    list = new ObservedList(manager);
    await list.update();
    const rows = list.selectList.getItems();
    expect(rows.map((item) => item.providerName)).toEqual(["LaTeX", "Typst"]);
    expect(rows[0].displayPath).toBe(path.join("documents", "report.tex"));
    const element = list.selectList.getElement();
    expect(element.textContent).toContain("LaTeX");
    expect(element.textContent).toContain("Typst");

    await list.selectList.setQuery("typst");

    expect(list.selectList.getMatchCount()).toBe(1);
    expect(list.selectList.getSelectedItem().providerId).toBe("typst-tools");
  });

  it("gives the same source separate stable identities for different providers", async () => {
    const first = source("shared.tex");
    entries.push({ ...first, providerId: "typst-tools" });
    list = new ObservedList(manager);
    await list.update();
    const rows = list.selectList.getItems();
    expect(rows.length).toBe(2);
    expect(list.selectList.getItemId(rows[0])).not.toBe(list.selectList.getItemId(rows[1]));
  });

  it("opens the selected source through its owning editor pane", async () => {
    const entry = source("report.tex");
    list = new ObservedList(manager);
    await list.show();
    const pane = list.window.getEditorContainer().getActivePane();
    const open = spyOn(lumine.workspace, "open").and.resolveTo(null);

    await list.selectList.runAction("tasks:open-observed-file");

    expect(open).toHaveBeenCalledTimes(1);
    const [filePath, options] = open.calls.mostRecent().args;
    expect(filePath).toBe(entry.filePath);
    expect(options.pane).toBe(pane);
    expect(options.searchAllPanes).toBe(true);
  });

  it("keeps the list open and selects the adjacent row after removing a document", async () => {
    source("a.tex");
    const middle = source("b.tex");
    const last = source("c.tex");
    list = new ObservedList(manager);
    await list.show();
    await list.selectList.selectIndex(1);

    await list.selectList.runAction("tasks:unobserve-selected-file");

    const [removed, enabled] = manager.setObserved.calls.mostRecent().args;
    expect(removed.providerId).toBe(middle.providerId);
    expect(removed.filePath).toBe(middle.filePath);
    expect(enabled).toBe(false);
    expect(list.selectListHost.isVisible()).toBe(true);
    expect(list.selectList.getSelectedItem().filePath).toBe(last.filePath);
    await list.selectList.runAction("tasks:unobserve-selected-file");
    await list.selectList.runAction("tasks:unobserve-selected-file");
    expect(list.selectList.getItemCount()).toBe(0);
    expect(list.selectListHost.isVisible()).toBe(true);
  });

  it("preserves a surviving selection and query when observations change", async () => {
    source("a.tex");
    const selected = source("b.tex");
    list = new ObservedList(manager);
    await list.show();
    await list.selectList.setQuery(".tex");
    await list.selectList.selectIndex(1);
    source("c.tex");
    events.emit("observed", { enabled: true });
    await list.pendingUpdate;
    expect(list.selectList.getSelectedItem().filePath).toBe(selected.filePath);
    expect(list.selectList.getQuery()).toBe(".tex");
  });

  it("refreshes mixed-provider entries when one provider disappears", async () => {
    source("latex.tex");
    const remaining = source("typst.typ", "typst-tools");
    list = new ObservedList(manager);
    await list.show();
    manager.providers.delete("latex-tools");
    entries = entries.filter((entry) => entry.providerId !== "latex-tools");
    events.emit("providers", { providerId: "latex-tools" });
    await list.pendingUpdate;
    expect(list.selectList.getItemCount()).toBe(1);
    expect(list.selectList.getItems()[0].filePath).toBe(remaining.filePath);
    expect(list.selectList.getItems()[0].providerName).toBe("Typst");
    expect(list.selectList.getSelectedItem().providerId).toBe("typst-tools");
  });

  it("uses the workspace clear action and leaves an empty observed-document list", async () => {
    source("latex.tex");
    source("typst.typ", "typst-tools");
    list = new ObservedList(manager);
    await list.show();
    expect(list.selectList.getAvailableActions().map((action) => action.command)).toContain(
      "tasks:clear-observed",
    );

    await list.selectList.runAction("tasks:clear-observed");
    await list.pendingUpdate;

    expect(entries.length).toBe(0);
    expect(list.selectList.getItemCount()).toBe(0);
    expect(list.selectListHost.isVisible()).toBe(true);
    expect(list.selectList.getAvailableActions().map((action) => action.command)).not.toContain(
      "tasks:clear-observed",
    );
  });

  it("releases observers and ignores retained list operations after destruction", async () => {
    source("report.tex");
    list = new ObservedList(manager);
    await list.update();
    await list.destroy();
    const update = spyOn(list, "update").and.callThrough();
    events.emit("observed", { enabled: false });
    events.emit("providers", { providerId: "latex-tools" });
    const open = spyOn(lumine.workspace, "open");
    list.openObservedFile(entries[0]);
    list.unobserveSelectedFile(entries[0]);
    expect(update).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(manager.setObserved).not.toHaveBeenCalled();
  });

  it("owns a pending refresh rejection when the list is destroyed", async () => {
    source("report.tex");
    list = new ObservedList(manager);
    await list.update();
    const pending = Promise.withResolvers();
    spyOn(list.selectList, "setItems").and.returnValue(pending.promise);
    const notify = spyOn(lumine.notifications, "addError");
    const updating = list.update();
    await list.destroy();
    pending.reject(new DOMException("The list closed", "AbortError"));
    await expectAsync(updating).toBeResolved();
    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores an obsolete refresh failure after the query changes", async () => {
    source("report.tex");
    list = new ObservedList(manager);
    await list.update();
    const pending = Promise.withResolvers();
    spyOn(list.selectList, "setItems").and.returnValue(pending.promise);
    const notify = spyOn(lumine.notifications, "addError");
    const updating = list.update();
    await list.selectList.setQuery("report");
    pending.reject(new Error("The previous snapshot was superseded"));
    await expectAsync(updating).toBeResolved();
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a current refresh failure once through the package error channel", async () => {
    source("report.tex");
    list = new ObservedList(manager);
    await list.update();
    const failure = new Error("The observation snapshot could not be rendered");
    spyOn(list.selectList, "setItems").and.rejectWith(failure);
    const notify = spyOn(lumine.notifications, "addError");
    events.emit("observed", { enabled: true });
    await expectAsync(list.pendingUpdate).toBeResolved();
    expect(notify).toHaveBeenCalledOnceWith("Unable to refresh observed documents.", {
      detail: failure.message,
    });
  });
});
