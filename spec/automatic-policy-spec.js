const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("Shared document build policy for the None grammar", () => {
  let manager, editor, directory, rootPath, childPath, otherPath, grammar;

  beforeEach(async () => {
    jasmine.useRealClock();
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    const pack = await lumine.packages.activatePackage("tasks");
    const Manager = require(path.join(pack.path, "lib", "task-manager"));
    manager = new Manager();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tasks-policy-")));
    rootPath = path.join(directory, "root.buildpolicy");
    childPath = path.join(directory, "child.buildpolicy");
    otherPath = path.join(directory, "other.buildpolicy");
    for (const file of [rootPath, childPath, otherPath]) fs.writeFileSync(file, "source\n");
    manager.registerProvider({
      id: "policy",
      name: "Policy",
      supports: () => true,
      resolve: (filePath) => (filePath === childPath ? rootPath : filePath),
      prepare: () => new Promise(() => {}),
    });
    editor = await lumine.workspace.open(childPath);
    grammar = lumine.grammars.grammarForScopeName("text.plain");
    editor.setGrammar(grammar);
  });

  afterEach(async () => {
    manager?.dispose();
    editor?.destroy();
    lumine.config.unset("core.customFileTypes");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (!directory) return;
    const resolved = fs.realpathSync.native(directory);
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe build policy fixture cleanup");
    await fs.promises.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  it("pauses automatic builds for a closed None association and honors an open explicit grammar", () => {
    lumine.config.set("core.customFileTypes", {
      [lumine.grammars.nullGrammar.scopeName]: ["buildpolicy"],
    });
    editor.setGrammar(grammar);
    expect(manager.automaticAllowed("policy", rootPath)).toBeTrue();
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(manager.automaticAllowed("policy", rootPath)).toBeFalse();
    editor.destroy();
    expect(manager.automaticAllowed("policy", rootPath)).toBeFalse();
    lumine.config.unset("core.customFileTypes");
    expect(manager.automaticAllowed("policy", rootPath)).toBeTrue();
  });

  it("cancels only the matching accepted jobs and leaves an explicit later build available", async () => {
    const running = manager.run({ providerId: "policy", filePath: rootPath, reason: "save" });
    const unrelated = manager.run({ providerId: "policy", filePath: otherPath });
    editor.setGrammar(lumine.grammars.nullGrammar);
    manager.reconcileEditor(editor);
    await running.completion;
    expect(running.state).toBe("cancelled");
    expect(unrelated.state).toBe("preparing");
    const explicit = manager.run({ providerId: "policy", filePath: rootPath, reason: "manual" });
    expect(explicit).not.toBe(running);
    expect(explicit.state).toBe("preparing");
  });

  it("uses the current root when a source acquires its root association after observation", () => {
    let rootFound = false;
    manager.registerProvider({
      id: "dynamic-policy",
      name: "Dynamic Policy",
      supports: () => true,
      resolve: (filePath) => (rootFound && filePath === childPath ? rootPath : filePath),
      prepare: () => new Promise(() => {}),
    });
    editor.getBuffer().setPath(rootPath);
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(manager.automaticAllowed("dynamic-policy", childPath)).toBeTrue();
    rootFound = true;
    expect(manager.automaticAllowed("dynamic-policy", childPath)).toBeFalse();
  });

  it("does not cancel a replacement started synchronously by a terminal callback", async () => {
    const first = manager.run({ providerId: "policy", filePath: rootPath, reason: "save" });
    let replacement;
    const lease = manager.onDidFinishJob((job) => {
      if (job === first)
        replacement = manager.run({ providerId: "policy", filePath: rootPath, reason: "manual" });
    });
    editor.setGrammar(lumine.grammars.nullGrammar);
    manager.reconcileEditor(editor);
    await first.completion;
    expect(replacement).toBeTruthy();
    expect(replacement.state).toBe("preparing");
    lease.dispose();
  });
});
