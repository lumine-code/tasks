/* global advanceClock */
const path = require("node:path");
const childProcess = require("node:child_process");
const { Disposable, CompositeDisposable } = require("lumine");
const windowService = require("./helpers/window-service");

describe("Tasks consumed service ownership", () => {
  let main, leases, bars, StatusBarView;
  const tiles = (bar) =>
    bar.getLeftTiles().filter((tile) => tile.getItem().matches?.(".tasks-status"));

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const status = await lumine.packages.activatePackage("status-bar");
    StatusBarView = status.mainModule.statusBar.constructor;
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
    spyOn(main, "refreshTargets").and.resolveTo([]);
    lumine.config.set("tasks.statusBar", false);
    leases = new CompositeDisposable();
    bars = [];
  });

  afterEach(async () => {
    leases.dispose();
    await lumine.packages.deactivatePackage("tasks");
    for (const bar of bars) bar.destroy();
  });

  function bar() {
    const value = new StatusBarView();
    bars.push(value);
    jasmine.attachToDOM(value.element);
    return value;
  }

  function consumeStatus(value) {
    const lease = main.consumeStatusBar(windowService(value));
    leases.add(lease);
    return lease;
  }

  function work() {
    return {
      add: jasmine.createSpy("add busy work"),
      dispose: jasmine.createSpy("dispose busy work"),
    };
  }

  function indie() {
    return {
      setAllMessages: jasmine.createSpy("set indie messages"),
      dispose: jasmine.createSpy("dispose indie"),
    };
  }

  function start(manager = main.manager, id = "controlled-job") {
    const job = { id, name: "Controlled", state: "running" };
    manager.emitter.emit("did-start-job", job);
    return job;
  }

  it("keeps one tile for a shared bar and restores the latest surviving A-B-A edge", () => {
    lumine.config.set("tasks.statusBar", true);
    const a = bar(),
      b = bar();
    const first = consumeStatus(a);
    const middle = consumeStatus(b);
    const last = consumeStatus(a);
    expect(tiles(a).length).toBe(1);
    expect(tiles(b).length).toBe(0);
    last.dispose();
    expect(tiles(a).length).toBe(0);
    expect(tiles(b).length).toBe(1);
    middle.dispose();
    expect(tiles(a).length).toBe(1);
    const duplicate = consumeStatus(a);
    first.dispose();
    expect(tiles(a).length).toBe(1);
    duplicate.dispose();
    expect(tiles(a).length).toBe(0);
  });

  it("retires a staged tile before a reentrant provider moves the shared element", () => {
    lumine.config.set("tasks.statusBar", true);
    const a = bar(),
      b = bar();
    const add = a.addLeftTile.bind(a);
    spyOn(a, "addLeftTile").and.callFake((options) => {
      const tile = add(options);
      consumeStatus(b);
      return tile;
    });
    consumeStatus(a);
    expect(tiles(a).length).toBe(0);
    expect(tiles(b).length).toBe(1);
    expect(main.statusTile.getItem()).toBe(main.statusElement);
    expect(main.statusElement.closest("status-bar")).toBe(b.element);
  });

  it("ignores a retained window observer from an activation that has retired", () => {
    let callback;
    leases.add(
      main.consumeStatusBar({
        observeWindows(create) {
          callback = create;
          return new Disposable();
        },
      }),
    );
    main.deactivate();
    main.activate();
    const edges = main.statusEdges.length;
    const staleBar = bar();
    leases.add(callback(staleBar));
    expect(main.statusEdges.length).toBe(edges);
    expect(tiles(staleBar).length).toBe(0);
  });

  it("keeps active work until a shared busy payload's final lease retires", () => {
    const busy = work();
    const value = { create: jasmine.createSpy("create busy").and.returnValue(busy) };
    const first = main.consumeBusySignal(value);
    const second = main.consumeBusySignal(value);
    leases.add(first, second);
    start();
    expect(value.create).toHaveBeenCalledTimes(1);
    second.dispose();
    expect(busy.dispose).not.toHaveBeenCalled();
    first.dispose();
    expect(busy.dispose).toHaveBeenCalledTimes(1);
  });

  for (const boundary of ["create", "add"]) {
    it(`releases staged busy work when ${boundary} retires its activation`, () => {
      const manager = main.manager;
      const busy = work();
      const retire = () => {
        main.deactivate();
        main.activate();
      };
      if (boundary === "add") busy.add.and.callFake(retire);
      leases.add(
        main.consumeBusySignal({
          create: () => {
            if (boundary === "create") retire();
            return busy;
          },
        }),
      );
      start(manager);
      expect(busy.dispose).toHaveBeenCalledTimes(1);
      expect(main.busyJobs.size).toBe(0);
      if (boundary === "create") expect(busy.add).not.toHaveBeenCalled();
    });
  }

  it("does not let old busy completion cleanup remove a new generation's job", () => {
    const manager = main.manager;
    const old = work();
    const replacement = work();
    leases.add(main.consumeBusySignal({ create: () => old }));
    const job = start(manager, "same-id");
    old.dispose.and.callFake(() => {
      main.deactivate();
      main.activate();
      leases.add(main.consumeBusySignal({ create: () => replacement }));
      start(main.manager, "same-id");
    });
    job.state = "passed";
    manager.emitter.emit("did-finish-job", job);
    expect(main.busyJobs.size).toBe(1);
    expect(replacement.dispose).not.toHaveBeenCalled();
  });

  it("keeps new busy work when a finishing status refresh replaces its activation", () => {
    const manager = main.manager;
    const old = work();
    const replacement = work();
    leases.add(main.consumeBusySignal({ create: () => old }));
    const job = start(manager, "tasks-1");
    let replaced = false;
    let replacementJob;
    const availability = lumine.commands.onDidChange(() => {
      if (replaced || job.state !== "passed") return;
      replaced = true;
      availability.dispose();
      main.deactivate();
      main.activate();
      leases.add(main.consumeBusySignal({ create: () => replacement }));
      replacementJob = start(main.manager, "tasks-1");
    });
    leases.add(availability);

    job.state = "passed";
    manager.emitter.emit("did-finish-job", job);

    expect(replaced).toBeTrue();
    expect(main.manager).not.toBe(manager);
    expect(replacementJob.id).toBe(job.id);
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(main.busyJobs.size).toBe(1);
    expect(main.busyJobs.get(replacementJob.id)?.busy).toBe(replacement);
    expect(replacement.dispose).not.toHaveBeenCalled();
  });

  it("creates one indie for a shared registry and owns distinct registry resources", () => {
    const one = indie(),
      two = indie();
    const register = jasmine.createSpy("register indie").and.returnValue(one);
    const first = main.consumeLinterRegistry(register);
    const second = main.consumeLinterRegistry(register);
    leases.add(
      first,
      second,
      main.consumeLinterRegistry(() => two),
    );
    expect(register).toHaveBeenCalledTimes(1);
    first.dispose();
    expect(one.dispose).not.toHaveBeenCalled();
    second.dispose();
    expect(one.dispose).toHaveBeenCalledTimes(1);
    main.deactivate();
    expect(one.dispose).toHaveBeenCalledTimes(1);
    expect(two.dispose).toHaveBeenCalledTimes(1);
  });

  it("releases an indie returned after its factory retires the owner", () => {
    const delegate = indie();
    leases.add(
      main.consumeLinterRegistry(() => {
        main.deactivate();
        main.activate();
        return delegate;
      }),
    );
    expect(delegate.dispose).toHaveBeenCalledTimes(1);
    expect(delegate.setAllMessages).not.toHaveBeenCalled();
    expect(main.linterEdges.length).toBe(0);
  });

  it("publishes detached diagnostic snapshots and skips unchanged message references", () => {
    const diagnostic = {
      severity: "warning",
      excerpt: "Original",
      location: {
        file: path.resolve("source.tex"),
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    spyOn(main.manager, "getMessages").and.returnValue([diagnostic]);
    const delegate = indie();
    delegate.setAllMessages.and.callFake((messages) => {
      messages[0].excerpt = "Consumer edit";
    });
    leases.add(main.consumeLinterRegistry(() => delegate));
    main.publishDiagnostics();
    expect(delegate.setAllMessages).toHaveBeenCalledTimes(1);
    expect(diagnostic.excerpt).toBe("Original");
  });

  it("restarts publication with the newest diagnostics after a reentrant update", () => {
    let messages = [];
    spyOn(main.manager, "getMessages").and.callFake(() => messages);
    const one = indie(),
      two = indie();
    leases.add(
      main.consumeLinterRegistry(() => one),
      main.consumeLinterRegistry(() => two),
    );
    one.setAllMessages.and.callFake((snapshot) => {
      if (snapshot[0]?.excerpt === "Intermediate") {
        messages = [{ excerpt: "Newest" }];
        main.publishDiagnostics();
      }
    });
    messages = [{ excerpt: "Intermediate" }];
    main.publishDiagnostics();
    expect(two.setAllMessages.calls.mostRecent().args).toEqual([[{ excerpt: "Newest" }]]);
    expect(two.setAllMessages.calls.allArgs()).not.toContain([[{ excerpt: "Intermediate" }]]);
  });

  it("does not start compilers or busy work while binding services and querying state", () => {
    const spawn = spyOn(childProcess, "spawn");
    const create = jasmine.createSpy("create busy").and.returnValue(work());
    const prepare = jasmine.createSpy("prepare plan");
    const manager = main.provideTasks();
    leases.add(
      manager.registerProvider({
        id: "query-only",
        name: "Query only",
        supports: () => true,
        prepare,
      }),
    );
    leases.add(
      main.consumeBusySignal({ create }),
      main.consumeLinterRegistry(() => indie()),
    );
    manager.getJobs();
    manager.getLogs();
    manager.getMessages();
    manager.getObserved();
    manager.getArtifacts(path.resolve("query.tex"));
    main.publishDiagnostics();
    expect(prepare).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not register editor listeners through a copied retired observation callback", () => {
    const observe = lumine.workspace.observeTextEditors.bind(lumine.workspace);
    let callback;
    spyOn(lumine.workspace, "observeTextEditors").and.callFake((create) => {
      callback = create;
      return observe(create);
    });
    main.deactivate();
    main.activate();
    const retired = callback;
    main.deactivate();
    main.activate();
    const editor = lumine.workspace.buildTextEditor();
    const grammar = spyOn(editor, "onDidChangeGrammar").and.callThrough();
    try {
      retired(editor);
      expect(grammar).not.toHaveBeenCalled();
      callback(editor);
      expect(grammar).toHaveBeenCalledTimes(1);
    } finally {
      editor.destroy();
    }
  });

  it("ignores copied configuration callbacks and queued refreshes from a retired activation", () => {
    let callback;
    spyOn(lumine.project, "onDidChangeFiles").and.callFake((changed) => {
      callback = changed;
      return new Disposable();
    });
    main.deactivate();
    main.activate();
    const retired = callback;
    const events = [{ path: path.resolve("nested", ".lumine/tasks.json") }];
    retired(events);
    main.deactivate();
    main.activate();
    const current = callback;
    main.refreshTargets.calls.reset();
    advanceClock(150);
    expect(main.refreshTargets).not.toHaveBeenCalled();
    retired(events);
    advanceClock(150);
    expect(main.refreshTargets).not.toHaveBeenCalled();
    current(events);
    advanceClock(150);
    expect(main.refreshTargets).toHaveBeenCalledTimes(1);
    expect(main.refreshTargets).toHaveBeenCalledWith();
  });

  it("suppresses a rejected status toggle after its activation is replaced", async () => {
    const notify = spyOn(lumine.notifications, "addError");
    const panel = main.ensurePanel();
    let reject;
    const opening = new Promise((_resolve, fail) => {
      reject = fail;
    });
    spyOn(panel, "toggle").and.returnValue(opening);
    main.statusElement.click();
    main.deactivate();
    main.activate();
    reject(new Error("Obsolete panel toggle"));
    await opening.catch(() => {});
    expect(notify).not.toHaveBeenCalled();
  });
});
