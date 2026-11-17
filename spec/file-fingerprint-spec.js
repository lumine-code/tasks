const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fingerprint = require("../lib/file-fingerprint");

describe("Coherent task file fingerprints", () => {
  let directory, source, controller;
  const abcDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const version = (ino, revision = 1n) => ({
    dev: 1n,
    ino,
    size: 3n,
    mtimeNs: revision,
    ctimeNs: revision,
  });

  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "task-fingerprint-")));
    source = path.join(directory, "source.tex");
    fs.writeFileSync(source, "abc");
    controller = new AbortController();
  });

  afterEach(() => {
    controller.abort();
    const owned = fs.realpathSync.native(directory);
    if (
      path.dirname(owned) !== fs.realpathSync.native(os.tmpdir()) ||
      !path.basename(owned).startsWith("task-fingerprint-")
    )
      throw new Error("Unsafe task-fingerprint fixture cleanup.");
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function readable(contents, before, after = before, duringRead = () => {}) {
    let reads = 0;
    return {
      stat: jasmine
        .createSpy("open-file stat")
        .and.callFake(async () => (++reads === 1 ? before : after)),
      createReadStream: jasmine.createSpy("read stream").and.callFake((options) => ({
        on() {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(contents);
          await duringRead(options.signal);
        },
      })),
      close: jasmine.createSpy("close file").and.resolveTo(),
    };
  }

  function intercept(reads, pathVersion) {
    const open = fs.promises.open.bind(fs.promises);
    const stat = fs.promises.stat.bind(fs.promises);
    let next = 0;
    spyOn(fs.promises, "open").and.callFake((filePath, ...options) =>
      filePath === source ? Promise.resolve(reads[next++]) : open(filePath, ...options),
    );
    spyOn(fs.promises, "stat").and.callFake((filePath, ...options) =>
      filePath === source ? Promise.resolve(pathVersion) : stat(filePath, ...options),
    );
  }

  it("returns a stable file's SHA-256 digest", async () => {
    expect(await fingerprint(source, controller.signal)).toBe(abcDigest);
  });

  it("represents a missing file without opening a retained handle", async () => {
    fs.unlinkSync(source);
    expect(await fingerprint(source, controller.signal)).toBeNull();
  });

  it("rereads a replacement instead of accepting the discarded file's contents", async () => {
    const discarded = readable("old", version(1n));
    const replacement = readable("abc", version(2n));
    intercept([discarded, replacement], version(2n));

    expect(await fingerprint(source, controller.signal)).toBe(abcDigest);
    expect(discarded.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it("rereads an in-place write instead of accepting bytes mixed across versions", async () => {
    const interrupted = readable("mix", version(1n), version(1n, 2n));
    const settled = readable("abc", version(1n, 2n));
    intercept([interrupted, settled], version(1n, 2n));

    expect(await fingerprint(source, controller.signal)).toBe(abcDigest);
    expect(interrupted.close).toHaveBeenCalledTimes(1);
    expect(settled.close).toHaveBeenCalledTimes(1);
  });

  it("closes its open handle when cancellation interrupts a read", async () => {
    const interrupted = readable("abc", version(1n), version(1n), (signal) => {
      controller.abort();
      signal.throwIfAborted();
    });
    intercept([interrupted], version(1n));

    await expectAsync(fingerprint(source, controller.signal)).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
    expect(interrupted.close).toHaveBeenCalledTimes(1);
  });

  it("closes an acquired handle when cancellation arrives while opening it", async () => {
    const interrupted = readable("abc", version(1n));
    const open = fs.promises.open.bind(fs.promises);
    spyOn(fs.promises, "open").and.callFake(async (filePath, ...options) => {
      if (filePath !== source) return open(filePath, ...options);
      controller.abort();
      return interrupted;
    });

    await expectAsync(fingerprint(source, controller.signal)).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
    expect(interrupted.stat).not.toHaveBeenCalled();
    expect(interrupted.createReadStream).not.toHaveBeenCalled();
    expect(interrupted.close).toHaveBeenCalledTimes(1);
  });

  it("does not create an already-aborted stream when cancellation arrives during stat", async () => {
    const interrupted = readable("abc", version(1n));
    interrupted.stat.and.callFake(async () => {
      controller.abort();
      return version(1n);
    });
    intercept([interrupted], version(1n));

    await expectAsync(fingerprint(source, controller.signal)).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
    expect(interrupted.createReadStream).not.toHaveBeenCalled();
    expect(interrupted.close).toHaveBeenCalledTimes(1);
  });

  it("closes its open handle and preserves a read failure", async () => {
    const failure = new Error("The source could not be read.");
    const interrupted = readable("abc", version(1n), version(1n), () => {
      throw failure;
    });
    intercept([interrupted], version(1n));

    await expectAsync(fingerprint(source, controller.signal)).toBeRejectedWith(failure);
    expect(interrupted.close).toHaveBeenCalledTimes(1);
  });
});
