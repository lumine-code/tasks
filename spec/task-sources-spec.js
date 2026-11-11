const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Disposable } = require("lumine");

describe("Task source snapshots", () => {
  let directory, source, child, snapshots, handles, invalidated, errors, readiness;
  const contents = "original\n";
  const deferred = () => {
    let resolve;
    const promise = new Promise((value) => {
      resolve = value;
    });
    return { promise, resolve };
  };

  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "task-sources-")));
    source = path.join(directory, "source.txt");
    child = path.join(directory, "child.txt");
    fs.writeFileSync(source, contents);
    handles = [];
    readiness = Promise.resolve();
    invalidated = jasmine.createSpy("invalidated");
    errors = jasmine.createSpy("errors");
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((filePath) => {
      const listeners = {};
      const handle = {
        filePath,
        ready: readiness,
        onDidChange: (callback) => {
          listeners.change = callback;
          return new Disposable();
        },
        onDidInvalidate: (callback) => {
          listeners.invalidate = callback;
          return new Disposable();
        },
        onDidError: (callback) => {
          listeners.error = callback;
          return new Disposable();
        },
        dispose: jasmine.createSpy("dispose"),
        change: (action = "updated") => listeners.change([{ action, path: filePath }]),
        recover: () => listeners.invalidate({ path: filePath, generation: 2 }),
        fail: (error) => listeners.error(error),
      };
      handles.push(handle);
      return handle;
    });
    snapshots = new (require("../lib/task-sources"))(invalidated, errors);
  });

  afterEach(async () => {
    snapshots.dispose();
    const resolved = fs.realpathSync.native(directory);
    if (
      path.dirname(resolved) !== fs.realpathSync.native(os.tmpdir()) ||
      !path.basename(resolved).startsWith("task-sources-")
    )
      throw new Error("Unsafe fixture cleanup.");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("withdraws a deleted and recreated source even when delivery is one update", async () => {
    await snapshots.add([source]);
    fs.unlinkSync(source);
    fs.writeFileSync(source, "new document\n");
    handles[0].change();
    expect(await snapshots.verify()).toBeFalse();
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(handles[0].dispose).toHaveBeenCalledTimes(1);
    fs.writeFileSync(source, contents);
    handles[0].change();
    expect(await snapshots.verify()).toBeFalse();
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it("keeps an identical atomic replacement and ignores timestamp changes", async () => {
    await snapshots.add([source]);
    const replacement = path.join(directory, "replacement");
    fs.writeFileSync(replacement, contents);
    fs.renameSync(replacement, source);
    handles[0].change();
    expect(await snapshots.verify()).toBeTrue();
    expect(invalidated).not.toHaveBeenCalled();
  });

  it("detects changed bytes with preserved size and modification time", async () => {
    await snapshots.add([source]);
    const stat = fs.statSync(source);
    fs.writeFileSync(source, "modified\n");
    fs.utimesSync(source, stat.atime, stat.mtime);
    handles[0].change();
    expect(await snapshots.verify()).toBeFalse();
  });

  it("tracks dependencies and missing diagnostic targets, deduplicating paths", async () => {
    await snapshots.add([source, child, path.join(directory, ".", "source.txt")]);
    expect(handles.length).toBe(2);
    expect(await snapshots.verify()).toBeTrue();
    fs.writeFileSync(child, "created\n");
    handles[1].change("created");
    expect(await snapshots.verify()).toBeFalse();
    expect(handles.every((handle) => handle.dispose.calls.count() === 1)).toBeTrue();
  });

  it("does not miss a source replacement while observation is arming", async () => {
    const armed = deferred();
    readiness = armed.promise;
    const createReadStream = fs.createReadStream.bind(fs);
    let initialRead;
    spyOn(fs, "createReadStream").and.callFake((filePath, options) => {
      const stream = createReadStream(filePath, options);
      initialRead ||= new Promise((resolve, reject) => {
        stream.once("end", resolve);
        stream.once("error", reject);
      });
      return stream;
    });
    const added = snapshots.add([source]);
    // The initial read starts in add(), before readiness resolves.
    await initialRead;
    fs.writeFileSync(source, "replacement\n");
    armed.resolve();
    await added;
    expect(await snapshots.verify()).toBeFalse();
  });

  it("withdraws reports across watcher recovery even when bytes stayed equal", async () => {
    await snapshots.add([source]);
    handles[0].recover();
    expect(await snapshots.verify()).toBeFalse();
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it("does not revive or notify after disposal or late watcher callbacks", async () => {
    await snapshots.add([source]);
    snapshots.dispose();
    handles[0].change("deleted");
    handles[0].recover();
    handles[0].fail(new Error("late error"));
    expect(await snapshots.verify()).toBeFalse();
    expect(invalidated).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(handles[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("settles active and queued source reads when their owner retires", async () => {
    const inputs = Array.from({ length: 12 }, (_, index) => path.join(directory, `${index}.pdf`));
    for (const input of inputs) fs.writeFileSync(input, "compiler input\n");
    const streams = spyOn(fs, "createReadStream").and.callThrough();
    const adding = snapshots.add(inputs);
    expect(streams.calls.count()).toBeGreaterThan(0);
    expect(streams.calls.count()).toBeLessThan(inputs.length);
    snapshots.dispose();
    await adding;
    expect(await snapshots.verify()).toBeFalse();
    expect(invalidated).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(handles.every((handle) => handle.dispose.calls.count() === 1)).toBeTrue();
  });

  it("withdraws and reports a failed watcher without an unhandled ready rejection", async () => {
    const failure = new Error("observation failed");
    readiness = Promise.reject(failure);
    await snapshots.add([source]);
    expect(await snapshots.verify()).toBeFalse();
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledOnceWith(failure);
  });
});
