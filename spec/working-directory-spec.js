const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");

describe("Tasks working directory placeholders", () => {
  let directory, editor, main;
  beforeEach(async () => {
    jasmine.useRealClock();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-cwd-owned-"));
    await fs.mkdir(path.join(directory, "source"));
    await fs.mkdir(path.join(directory, ".lumine"));
    await fs.writeFile(path.join(directory, "source", "main.js"), "// owned file\n");
    lumine.project.setPaths([directory]);
    lumine.config.set("tasks.saveOnBuild", false);
    editor = await lumine.workspace.open(path.join(directory, "source", "main.js"));
    main = (await lumine.packages.activatePackage("tasks")).mainModule;
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("tasks");
    editor.destroy();
    lumine.project.setPaths([]);
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith("tasks-cwd-owned-")
    ) {
      throw new Error("Unsafe working directory fixture cleanup");
    }
    await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  for (const [cwd, expected] of [
    ["{PROJECT_PATH}", ""],
    ["{FILE_ACTIVE_PATH}", "source"],
    ["source", "source"],
  ]) {
    it(`runs the actual Node target in ${cwd}`, async () => {
      await fs.writeFile(
        path.join(directory, ".lumine/tasks.json"),
        JSON.stringify({
          name: "Owned cwd",
          cmd: "node",
          args: ["-e", "process.stdout.write(process.cwd())"],
          cwd,
        }),
      );
      await main.refreshTargets();
      const job = await main.runTarget(main.targets[0]);
      await job.completion;
      expect(job.state).toBe("passed");
      const actual = job.stdout;
      if (job.code === 0) {
        expect(await fs.realpath(actual)).toBe(await fs.realpath(path.join(directory, expected)));
      }
    });
  }
});
