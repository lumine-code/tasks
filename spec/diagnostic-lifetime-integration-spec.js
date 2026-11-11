const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { CompositeDisposable } = require("lumine");

describe("Compiler diagnostic lifetime through the linter service", () => {
  let main, linter, directory, source, editor, split, overview, leases;
  let children, handles, provider, hub, panelMessages;
  const originalText = "broken source\nunchanged line\n";
  const replacementText = "new document\nunchanged line\n";

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.set("core.closeDeletedFileTabs", false);
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    lumine.config.set("tasks.showNotifications", false);
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    linter = (await lumine.packages.activatePackage("linter")).mainModule;
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "tasks-diagnostic-lifetime-")),
    );
    source = path.join(directory, "source.txt");
    fs.writeFileSync(source, originalText);
    leases = new CompositeDisposable();
    children = [];
    handles = [];
    panelMessages = [];
    const watchFile = lumine.fileWatchClient.watchFile.bind(lumine.fileWatchClient);
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((filePath) => {
      const handle = watchFile(filePath);
      if (filePath === source) handles.push(handle);
      return handle;
    });
    const spawn = childProcess.spawn.bind(childProcess);
    spyOn(childProcess, "spawn").and.callFake((command, args, options) => {
      if (command !== "diagnostic-lifetime-fixture") return spawn(command, args, options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => {
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      children.push(child);
      return child;
    });
    leases.add(
      linter.consumeLinterUI({
        name: "Compiler lifetime reader",
        attach: (value) => {
          hub = value;
        },
        render: ({ messages }) => {
          panelMessages = messages;
        },
      }),
    );
    editor = await lumine.workspace.open(source);
    await editor.whenGrammarSettled();
    split = editor.copy();
    leases.add(linter.provideLinterEditors()(split, { lint: false }));
    for (const view of [editor.getElement(), split.getElement()]) {
      view.style.height = "600px";
      view.style.width = "800px";
      jasmine.attachToDOM(view);
    }
    const props = linter.provideMarkerLayer();
    overview = {
      editor,
      props,
      cache: new Map(),
      disposables: new CompositeDisposable(),
      update() {},
    };
    props.initialize(overview);
    leases.add(overview.disposables);
    provider = {
      id: "diagnostic-lifetime",
      name: "Compiler lifetime",
      supports: (filePath) => filePath === source,
      prepare: () => ({ cmd: "diagnostic-lifetime-fixture", args: [], cwd: directory }),
      collectResult: () => ({ diagnostics: diagnostics() }),
    };
    leases.add(main.manager.registerProvider(provider));
  });

  afterEach(async () => {
    leases?.dispose();
    await lumine.packages.deactivatePackage("tasks");
    await lumine.packages.deactivatePackage("linter");
    for (const child of children || []) child.emit("close", null, "SIGTERM");
    split?.destroy();
    editor?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      const resolved = fs.realpathSync.native(directory);
      const relative = path.relative(fs.realpathSync.native(os.tmpdir()), resolved);
      if (
        resolved !== directory ||
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !path.basename(resolved).startsWith("tasks-diagnostic-lifetime-")
      )
        throw new Error("Refusing cleanup outside the owned compiler diagnostic fixture.");
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    for (const key of [
      "core.closeDeletedFileTabs",
      "linter.lintOnOpen",
      "linter.lintOnChange",
      "tasks.showNotifications",
    ])
      lumine.config.unset(key);
  });

  function diagnostics() {
    return [
      {
        severity: "error",
        tags: ["unnecessary", "deprecated"],
        excerpt: "Diagnostic from the deleted source",
        location: {
          file: source,
          position: [
            [0, 0],
            [0, 6],
          ],
        },
      },
    ];
  }

  async function start() {
    const job = main.manager.run({ providerId: provider.id, filePath: source });
    await window.conditionPromise(() => job.state === "running", "the fixture compiler to start");
    await Promise.all(handles.map((handle) => handle.ready));
    return job;
  }

  function painted(target) {
    const view = target.getElement();
    view.getComponent().updateSync();
    return view.querySelectorAll(
      ".linter-text, .linter-line-number, .linter-tag-unnecessary, .linter-tag-deprecated",
    ).length;
  }

  function expectCleared() {
    expect(main.manager.getMessages()).toEqual([]);
    expect(hub.getMessages()).toEqual([]);
    expect(hub.getCurrentMessages()).toEqual([]);
    expect(panelMessages).toEqual([]);
    expect(linter.provideMcpTools()[0].execute({ filePath: source }).messages).toEqual([]);
    expect(linter.provideContextHelp().getHelp(editor, [0, 1])).toBeNull();
    const state = editor.getBuffer().linterUI;
    expect(state.markerMap.size).toBe(0);
    for (const layer of [...Object.values(state.severityLayers), ...Object.values(state.tagLayers)])
      expect(layer.getMarkerCount()).toBe(0);
    expect(painted(editor)).toBe(0);
    expect(painted(split)).toBe(0);
    expect(overview.props.getItems(overview) ?? []).toEqual([]);
  }

  async function recreate() {
    fs.writeFileSync(source, replacementText);
    await window.conditionPromise(
      () => editor.getText() === replacementText,
      "the recreated source to reload",
    );
    main.publishDiagnostics();
    expectCleared();
  }

  it("withdraws a completed compiler report from every surface and does not restore it for a recreated source", async () => {
    const job = await start();
    job.process.stdout.emit("data", Buffer.from("Old compiler output\n"));
    job.process.emit("close", 1, null);
    await job.completion;
    expect(main.manager.getObserved()).toEqual([]);
    expect(hub.getMessages().length).toBe(1);
    expect(panelMessages.length).toBe(1);
    expect(linter.provideMcpTools()[0].execute({ filePath: source }).messages.length).toBe(1);
    expect(linter.provideContextHelp().getHelp(editor, [0, 1])).not.toBeNull();
    expect(painted(editor)).toBeGreaterThan(0);
    expect(painted(split)).toBeGreaterThan(0);
    expect(overview.props.getItems(overview).length).toBeGreaterThan(0);

    fs.unlinkSync(source);
    await window.conditionPromise(
      () => main.manager.getMessages().length === 0,
      "the deleted source's compiler report to retire",
    );
    expectCleared();
    await recreate();
    expect(children.length).toBe(1);
    expect(main.manager.getLogs()).toContain(job);
    expect(job.log.getText()).toContain("Old compiler output");
  }, 30000);

  it("rejects a late collected report after deletion and recreation of its source", async () => {
    let release;
    provider.collectResult = () => new Promise((resolve) => (release = resolve));
    const job = await start();
    job.process.emit("close", 1, null);
    await window.conditionPromise(() => Boolean(release), "result collection to begin");
    fs.unlinkSync(source);
    await window.conditionPromise(
      () => editor.getFileState() === "removed",
      "source deletion to reach the open document",
    );
    await recreate();
    release({ diagnostics: diagnostics() });
    await job.completion;
    main.publishDiagnostics();
    expectCleared();
    expect(children.length).toBe(1);
  }, 30000);

  it("retires a closed document's report before reopening a new file at the same path", async () => {
    const job = await start();
    job.process.emit("close", 1, null);
    await job.completion;
    split.destroy();
    editor.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    expect(hub.getMessages().length).toBe(1);

    fs.unlinkSync(source);
    await window.conditionPromise(
      () => main.manager.getMessages().length === 0,
      "the closed source's compiler report to retire",
    );
    fs.writeFileSync(source, replacementText);
    editor = await lumine.workspace.open(source);
    await editor.whenGrammarSettled();
    main.publishDiagnostics();
    expect(editor.getText()).toBe(replacementText);
    expect(hub.getMessages()).toEqual([]);
    expect(panelMessages).toEqual([]);
    expect(linter.provideMcpTools()[0].execute({ filePath: source }).messages).toEqual([]);
    expect(editor.getBuffer().linterUI.markerMap.size).toBe(0);
    expect(painted(editor)).toBe(0);
    expect(children.length).toBe(1);
  }, 30000);
});
