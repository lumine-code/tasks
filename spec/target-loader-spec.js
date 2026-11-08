const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const temp = require("@lumine-code/fs-temp").track();
const YamlLoader = require("../lib/yaml-loader");
const {
  DEFAULT_CONFIG_PATH,
  normalizeConfigFiles,
  isConfigPath,
  expandTarget,
  findConfigs,
  loadConfigTargets,
  normalizeTarget,
  targetsFromDocument,
} = require("../lib/target-loader");

describe("tasks configuration loader", () => {
  let directory;
  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.realpathSync.native(temp.mkdirSync("lumine-tasks-configs-"));
  });

  function writeConfig(relativeDirectory, document, filename = DEFAULT_CONFIG_PATH) {
    const configPath = path.join(directory, relativeDirectory, filename);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      typeof document === "string" ? document : JSON.stringify(document),
    );
    return configPath;
  }

  it("keeps the canonical config first and normalizes unique additional relative paths", () => {
    expect(DEFAULT_CONFIG_PATH).toBe(".lumine/tasks.json");
    expect(normalizeConfigFiles()).toEqual([DEFAULT_CONFIG_PATH]);
    expect(
      normalizeConfigFiles([
        "tasks.json",
        "./config\\tasks.yaml",
        "config/./tasks.yaml",
        DEFAULT_CONFIG_PATH,
      ]),
    ).toEqual([DEFAULT_CONFIG_PATH, "tasks.json", "config/tasks.yaml"]);
    expect(normalizeConfigFiles(["project.tasks"])).toEqual([DEFAULT_CONFIG_PATH, "project.tasks"]);
    if (process.platform === "win32")
      expect(normalizeConfigFiles([".LUMINE/TASKS.JSON"])).toEqual([DEFAULT_CONFIG_PATH]);
  });

  it("rejects invalid additional config settings before discovery", async () => {
    for (const value of [
      null,
      "tasks.json",
      {},
      [null],
      [3],
      [""],
      [" "],
      ["/tasks.json"],
      ["C:\\tasks.json"],
      ["C:tasks.json"],
      ["\\\\server\\tasks.json"],
      ["../tasks.json"],
      ["config/../tasks.json"],
      ["**/tasks.json"],
      ["tasks?.json"],
      ["[tasks].json"],
      ["{tasks,build}.json"],
      ["bad\0.json"],
      ["configs/"],
      ["."],
    ])
      expect(() => normalizeConfigFiles(value)).toThrowError(TypeError, /additionalFiles/);
    const crawl = spyOn(lumine.project, "crawl");
    await expectAsync(
      loadConfigTargets(directory, { additionalFiles: ["../tasks.json"] }),
    ).toBeRejectedWithError(TypeError, /additionalFiles\[0\]/);
    expect(crawl).not.toHaveBeenCalled();
  });

  it("matches exact trailing segments and requires explicit basename matching", () => {
    expect(isConfigPath(path.join(directory, "nested", ".lumine", "tasks.json"))).toBeTrue();
    expect(isConfigPath("C:\\project\\nested\\.lumine\\tasks.json")).toBeTrue();
    for (const candidate of [
      "tasks.json",
      "nested/tasks.json",
      "not.lumine/tasks.json",
      ".lumine/tasks.json.bak",
      ".lumine/nested/tasks.json",
      ".lumine/tasks.json/other",
    ])
      expect(isConfigPath(candidate)).toBeFalse();
    const configured = normalizeConfigFiles(["config/tasks.json"]);
    expect(isConfigPath("nested/config/tasks.json", configured)).toBeTrue();
    expect(isConfigPath("nested/other-config/tasks.json", configured)).toBeFalse();
    expect(isConfigPath("nested/tasks.json", normalizeConfigFiles(["tasks.json"]))).toBeTrue();
    expect(isConfigPath("nested/mytasks.json", normalizeConfigFiles(["tasks.json"]))).toBeFalse();
  });

  it("loads canonical root and nested configurations in deterministic order", async () => {
    writeConfig("z/deep", { tasks: [{ name: "Last", cmd: "node" }] });
    writeConfig("", { name: "Root", cmd: "node" });
    writeConfig("a", [
      { name: "First", cmd: "node" },
      { name: "Second", cmd: "node" },
    ]);
    writeConfig("", "not a configured JSON document", "tasks.json");
    writeConfig("", "not a configured JSON document", ".lumine-build.json");
    const targets = await loadConfigTargets(directory);
    expect(targets.map((target) => target.name)).toEqual(["Root", "First", "Second", "Last"]);
    expect(targets.map((target) => target.source)).toEqual([
      ".lumine/tasks.json",
      "a/.lumine/tasks.json",
      "a/.lumine/tasks.json",
      "z/deep/.lumine/tasks.json",
    ]);
  });

  it("merges every configured file without format precedence or duplicate canonical reads", async () => {
    writeConfig("", { tasks: [{ name: "Canonical root", cmd: "node" }] });
    writeConfig("", { name: "JSON extra", cmd: "node" }, "tasks.json");
    writeConfig("", "tasks:\n  - name: YAML extra\n    cmd: node\n", ".lumine/tasks.yaml");
    writeConfig("nested", { name: "Canonical nested", cmd: "node" });
    writeConfig("nested", { name: "JSON nested extra", cmd: "node" }, "tasks.json");
    const options = { additionalFiles: ["tasks.json", ".lumine/tasks.yaml", DEFAULT_CONFIG_PATH] };
    expect((await findConfigs(directory, options)).length).toBe(5);
    expect((await loadConfigTargets(directory, options)).map((target) => target.name)).toEqual([
      "Canonical root",
      "YAML extra",
      "Canonical nested",
      "JSON nested extra",
      "JSON extra",
    ]);
  });

  it("anchors canonical working directories beside .lumine while preserving physical provenance", async () => {
    const configPath = writeConfig("component", {
      tasks: [
        { name: "Default", cmd: "node" },
        { name: "Relative", cmd: "node", cwd: "../work" },
        {
          name: "Expanded",
          cmd: "node",
          cwd: "{CONFIG_DIRECTORY}/out",
          args: ["{PROJECT_PATH}", "{CONFIG_PATH}", "{CONFIG_DIRECTORY}"],
        },
      ],
    });
    const targets = await loadConfigTargets(directory);
    const taskDirectory = path.join(directory, "component");
    const configDirectory = path.dirname(configPath);
    expect(targets[0].cwd).toBe(taskDirectory);
    expect(targets[1].cwd).toBe(path.join(directory, "work"));
    for (const target of targets) {
      expect(target.configPath).toBe(configPath);
      expect(target.configDirectory).toBe(configDirectory);
      expect(target.taskDirectory).toBe(taskDirectory);
      expect(target.projectPath).toBe(directory);
      expect(target.source).toBe("component/.lumine/tasks.json");
    }
    const expanded = expandTarget(targets[2], { projectPath: directory, editor: null });
    expect(expanded.cwd).toBe(path.join(configDirectory, "out"));
    expect(expanded.args).toEqual([directory, configPath, configDirectory]);
  });

  it("anchors relative expanded cwd to the canonical owning directory", async () => {
    writeConfig("component", { cmd: "node", cwd: "{SELECTION}" });
    const target = (await loadConfigTargets(directory))[0];
    const editor = {
      getPath: () => null,
      getCursorBufferPosition: () => null,
      getSelectedText: () => "chosen",
    };
    expect(expandTarget(target, { projectPath: directory, editor }).cwd).toBe(
      path.join(directory, "component", "chosen"),
    );
  });

  it("anchors additional files to their containing directory", async () => {
    const configPath = writeConfig(
      "component",
      {
        tasks: [
          { name: "Default", cmd: "node" },
          { name: "Relative", cmd: "node", cwd: "../work" },
        ],
      },
      "configs/extra.json",
    );
    const targets = await loadConfigTargets(directory, { additionalFiles: ["configs/extra.json"] });
    expect(targets[0].cwd).toBe(path.dirname(configPath));
    expect(targets[0].taskDirectory).toBe(path.dirname(configPath));
    expect(targets[1].cwd).toBe(path.join(directory, "component", "work"));
  });

  it("rereads config contents and applies changed additional-file settings without stale results", async () => {
    writeConfig("", { tasks: [{ name: "Canonical", cmd: "node" }] });
    const extra = writeConfig("", { name: "Optional", cmd: "node" }, "extra.json");
    expect((await loadConfigTargets(directory)).map((target) => target.name)).toEqual([
      "Canonical",
    ]);
    const options = { additionalFiles: ["extra.json"] };
    expect((await loadConfigTargets(directory, options)).map((target) => target.name)).toEqual([
      "Canonical",
      "Optional",
    ]);
    fs.writeFileSync(extra, JSON.stringify({ tasks: [{ name: "Changed", cmd: "node" }] }));
    expect((await loadConfigTargets(directory, options)).map((target) => target.name)).toEqual([
      "Canonical",
      "Changed",
    ]);
    fs.unlinkSync(extra);
    expect((await loadConfigTargets(directory, options)).map((target) => target.name)).toEqual([
      "Canonical",
    ]);
  });

  it("deduplicates repeated crawl results and excludes paths outside its workspace root", async () => {
    const config = writeConfig("", { cmd: "node" });
    const outside = path.join(path.dirname(directory), ".lumine", "tasks.json");
    spyOn(lumine.project, "crawl").and.callFake(({ didFindPaths }) => {
      didFindPaths([config, outside, config]);
      didFindPaths([config]);
      return Promise.resolve();
    });
    expect(await findConfigs(directory, { additionalFiles: ["tasks.json"] })).toEqual([config]);
  });

  it("honors project ignored-name and VCS-ignore policies for nested canonical configs", async () => {
    fs.mkdirSync(path.join(directory, ".git"));
    fs.writeFileSync(path.join(directory, ".gitignore"), "ignored/\n");
    writeConfig("ignored", { name: "VCS ignored", cmd: "node" });
    writeConfig("generated", { name: "Core ignored", cmd: "node" });
    writeConfig("visible/nested", { name: "Visible", cmd: "node" });
    lumine.config.set("core.ignoredNames", ["generated"]);
    lumine.config.set("core.excludeVcsIgnoredPaths", true);
    expect((await loadConfigTargets(directory)).map((target) => target.name)).toEqual(["Visible"]);
    lumine.config.set("core.excludeVcsIgnoredPaths", false);
    expect((await loadConfigTargets(directory)).map((target) => target.name)).toEqual([
      "VCS ignored",
      "Visible",
    ]);
  });

  it("always excludes dependency and VCS metadata directories", async () => {
    for (const name of [
      "node_modules",
      ".git",
      ".hg",
      ".svn",
      ".bzr",
      "_darcs",
      "CVS",
      ".jj",
      ".pijul",
    ])
      writeConfig(`nested/${name}/internal`, { name, cmd: "node" });
    writeConfig("ordinary", { name: "Ordinary", cmd: "node" });
    lumine.config.set("core.ignoredNames", []);
    lumine.config.set("core.excludeVcsIgnoredPaths", false);
    expect((await loadConfigTargets(directory)).map((target) => target.name)).toEqual(["Ordinary"]);
  });

  it("never follows directory symlinks or Windows junctions even when core follows links", async () => {
    writeConfig("real", { name: "Real", cmd: "node" });
    const outside = fs.realpathSync.native(temp.mkdirSync("lumine-tasks-outside-"));
    fs.mkdirSync(path.join(outside, ".lumine"));
    fs.writeFileSync(
      path.join(outside, ".lumine", "tasks.json"),
      '{"name":"Outside","cmd":"node"}',
    );
    const type = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(path.join(directory, "real"), path.join(directory, "alias"), type);
    fs.symlinkSync(outside, path.join(directory, "outside"), type);
    lumine.config.set("core.followSymlinks", true);
    expect((await loadConfigTargets(directory)).map((target) => target.name)).toEqual(["Real"]);
  });

  it("does not open a symlink config even if a crawler reports it", async () => {
    const config = writeConfig("", { cmd: "node" });
    const nativeLstat = fsPromises.lstat;
    spyOn(fsPromises, "lstat").and.callFake((candidate, ...args) =>
      candidate === config
        ? Promise.resolve({ isFile: () => true, isSymbolicLink: () => true })
        : nativeLstat(candidate, ...args),
    );
    const read = spyOn(fsPromises, "readFile").and.callThrough();
    expect(await loadConfigTargets(directory)).toEqual([]);
    expect(read.calls.allArgs().some(([candidate]) => candidate === config)).toBeFalse();
  });

  it("rejects cancellation before starting discovery", async () => {
    const crawl = spyOn(lumine.project, "crawl");
    const controller = new AbortController();
    controller.abort();
    await expectAsync(findConfigs(directory, { signal: controller.signal })).toBeRejectedWith(
      controller.signal.reason,
    );
    expect(crawl).not.toHaveBeenCalled();
  });

  it("cancels an in-flight project crawl without waiting for it to finish", async () => {
    let entered, release, options;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const crawl = new Promise((resolve) => {
      release = resolve;
    });
    crawl.cancel = jasmine.createSpy("cancel crawl");
    spyOn(lumine.project, "crawl").and.callFake((value) => {
      options = value;
      entered();
      return crawl;
    });
    const controller = new AbortController();
    const pending = findConfigs(directory, { signal: controller.signal });
    await started;
    expect(options.inclusion).toBe("**");
    expect(options.followSymlinks).toBe(false);
    const reason = new Error("Stop configuration discovery");
    controller.abort(reason);
    await expectAsync(pending).toBeRejectedWith(reason);
    expect(crawl.cancel).toHaveBeenCalledTimes(1);
    options.didFindPaths([path.join(directory, ".lumine", "tasks.json")]);
    release();
  });

  it("does not load another config after cancellation during the first read", async () => {
    const first = writeConfig("", { cmd: "node" });
    writeConfig("nested", { cmd: "node" });
    const controller = new AbortController();
    const reason = new Error("Stop reading task configurations");
    const readFile = fsPromises.readFile;
    const reading = spyOn(fsPromises, "readFile").and.callFake(async (...args) => {
      const contents = await readFile(...args);
      if (args[0] === first) controller.abort(reason);
      return contents;
    });
    await expectAsync(loadConfigTargets(directory, { signal: controller.signal })).toBeRejectedWith(
      reason,
    );
    expect(
      reading.calls
        .allArgs()
        .map(([filePath]) => filePath)
        .filter((filePath) => isConfigPath(filePath)),
    ).toEqual([first]);
  });

  it("identifies malformed tasks with their project-relative canonical config path", async () => {
    writeConfig("nested", { tasks: [{ cmd: "node", args: "invalid" }] });
    await expectAsync(loadConfigTargets(directory)).toBeRejectedWithError(
      TypeError,
      /nested\/\.lumine\/tasks\.json.*args/,
    );
  });

  it("loads canonical JSON tasks and validates task collections without a legacy targets wrapper", async () => {
    writeConfig("", {
      tasks: [{ name: "Test", cmd: "node", args: ["--test"], cwd: "sub", env: { MODE: "test" } }],
    });
    const targets = await loadConfigTargets(directory);
    expect(targets[0].name).toBe("Test");
    expect(targets[0].cwd).toBe(path.join(directory, "sub"));
    expect(targets[0].env).toEqual({ MODE: "test" });
    expect(targetsFromDocument({ tasks: [] }, directory, "config")).toEqual([]);
    expect(() => targetsFromDocument({ tasks: {} }, directory, "config")).toThrowError(
      TypeError,
      /tasks must be an array/,
    );
    expect(() =>
      targetsFromDocument({ targets: [{ cmd: "node" }] }, directory, "config"),
    ).toThrowError(TypeError, /cmd/);
    expect(() => targetsFromDocument({ tasks: [null] }, directory, "config")).toThrowError(
      TypeError,
      /must be an object/,
    );
  });

  it("loads only explicitly configured YAML and keeps JSON independent of its parser", async () => {
    const loading = spyOn(YamlLoader.prototype, "load").and.callThrough();
    writeConfig("", { tasks: [{ name: "JSON", cmd: "node" }] });
    writeConfig("", "name: YAML\ncmd: node\n", ".lumine/tasks.yaml");
    expect((await loadConfigTargets(directory)).map((target) => target.name)).toEqual(["JSON"]);
    expect(loading).not.toHaveBeenCalled();
    const targets = await loadConfigTargets(directory, { additionalFiles: [".lumine/tasks.yaml"] });
    expect(targets.map((target) => target.name)).toEqual(["JSON", "YAML"]);
    expect(loading).toHaveBeenCalledTimes(1);
  });

  it("does not parse explicit YAML after cancellation during its import", async () => {
    writeConfig("", "name: YAML\ncmd: node\n", "tasks.yaml");
    let release, entered;
    const importing = new Promise((resolve) => {
      entered = resolve;
    });
    const parser = { parse: jasmine.createSpy("parse") };
    spyOn(YamlLoader.prototype, "load").and.callFake(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const pending = loadConfigTargets(directory, {
      signal: controller.signal,
      additionalFiles: ["tasks.yaml"],
    });
    await importing;
    controller.abort();
    release(parser);
    await expectAsync(pending).toBeRejectedWith(controller.signal.reason);
    expect(parser.parse).not.toHaveBeenCalled();
  });

  it("reports malformed explicit YAML with its relative filename", async () => {
    writeConfig("", "tasks: [\n", ".lumine/tasks.yml");
    await expectAsync(
      loadConfigTargets(directory, { additionalFiles: [".lumine/tasks.yml"] }),
    ).toBeRejectedWithError(SyntaxError, /\.lumine\/tasks.yml:/);
  });

  it("rejects malformed targets with their source name", () => {
    expect(() => normalizeTarget({ name: "Missing command" }, directory, "provider")).toThrowError(
      /provider.*cmd/u,
    );
  });

  it("expands project, editor, selection, and cursor variables", () => {
    const target = normalizeTarget(
      {
        name: "Expand",
        cmd: "run-{ROW}",
        args: ["{PROJECT_PATH}", "{FILE_ACTIVE_NAME}", "{SELECTION}", "{COLUMN}"],
        env: { ROOT: "{FILE_ACTIVE_PATH}" },
      },
      directory,
      "provider",
    );
    const editorPath = path.join(directory, "src", "main.js");
    const editor = {
      getPath: () => editorPath,
      getSelectedText: () => "selected",
      getCursorBufferPosition: () => ({ row: 2, column: 4 }),
    };

    const expanded = expandTarget(target, { projectPath: directory, editor });

    expect(expanded.cmd).toBe("run-3");
    expect(expanded.args).toEqual([directory, "main.js", "selected", "5"]);
    expect(expanded.env.ROOT).toBe(path.dirname(editorPath));
  });

  it("does not read an unrelated selection when the target does not use it", () => {
    const editor = {
      getPath: () => null,
      getCursorBufferPosition: () => null,
      getSelectedText: jasmine
        .createSpy("getSelectedText")
        .and.throwError("unbounded selection read"),
    };
    const target = normalizeTarget({ cmd: "node", args: ["--test"] }, directory, "provider");
    expect(expandTarget(target, { projectPath: directory, editor }).args).toEqual(["--test"]);
    expect(editor.getSelectedText).not.toHaveBeenCalled();
  });

  it("reads a requested selection once across command, args, cwd and environment", () => {
    const editor = {
      getPath: () => null,
      getCursorBufferPosition: () => null,
      getSelectedText: jasmine.createSpy("getSelectedText").and.returnValue("chosen"),
    };
    const target = normalizeTarget(
      {
        cmd: "{SELECTION}",
        args: ["{SELECTION}", "{SELECTION}"],
        cwd: "{SELECTION}",
        env: { VALUE: "{SELECTION}" },
      },
      directory,
      "provider",
    );
    const expanded = expandTarget(target, { projectPath: directory, editor });
    expect(expanded.cmd).toBe("chosen");
    expect(expanded.args).toEqual(["chosen", "chosen"]);
    expect(expanded.cwd).toBe(path.resolve(directory, "chosen"));
    expect(expanded.env.VALUE).toBe("chosen");
    expect(editor.getSelectedText).toHaveBeenCalledTimes(1);
  });

  it("rejects an explicitly requested oversized UTF-16 selection before materialization", () => {
    const limit = require("node:buffer").constants.MAX_STRING_LENGTH;
    const editor = {
      getPath: () => null,
      getCursorBufferPosition: () => null,
      getSelectedBufferRange: () => ({ start: { offset: 7 }, end: { offset: 7 + limit + 1 } }),
      getBuffer: () => ({ characterIndexForPosition: (point) => point.offset }),
      getSelectedText: jasmine
        .createSpy("getSelectedText")
        .and.throwError("unbounded selection read"),
    };
    const target = normalizeTarget({ cmd: "node", args: ["{SELECTION}"] }, directory, "provider");
    let failure;
    try {
      expandTarget(target, { projectPath: directory, editor });
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof RangeError).toBe(true);
    expect(failure.code).toBe("ERR_BUILD_SELECTION_TOO_LARGE");
    expect(failure.length).toBe(limit + 1);
    expect(editor.getSelectedText).not.toHaveBeenCalled();
  });
});
