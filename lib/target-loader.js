const fs = require("node:fs/promises");
const path = require("node:path");
const { MAX_STRING_LENGTH } = require("node:buffer").constants;
const yamlLoader = new (require("./yaml-loader"))();

const DEFAULT_CONFIG_PATH = ".lumine/tasks.json";
const identityPath = (value) => (process.platform === "win32" ? value.toLowerCase() : value);

function normalizeConfigFiles(additionalFiles = []) {
  if (!Array.isArray(additionalFiles))
    throw new TypeError("additionalFiles must be an array of relative configuration file paths");
  const result = [DEFAULT_CONFIG_PATH];
  const known = new Set([identityPath(DEFAULT_CONFIG_PATH)]);
  for (const [index, entry] of additionalFiles.entries()) {
    const invalid = () =>
      new TypeError(
        `additionalFiles[${index}] must be a relative file path without absolute roots, '..' or globs`,
      );
    if (typeof entry !== "string" || !entry.trim() || /[\0:*?[\]{}<>"|]/u.test(entry))
      throw invalid();
    const value = entry.trim().replace(/\\/g, "/");
    if (value.startsWith("/") || value.endsWith("/") || value.split("/").includes(".."))
      throw invalid();
    const normalized = value
      .split("/")
      .filter((segment) => segment && segment !== ".")
      .join("/");
    if (!normalized) throw invalid();
    const key = identityPath(normalized);
    if (!known.has(key)) {
      known.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function isConfigPath(candidate, configFiles = [DEFAULT_CONFIG_PATH]) {
  if (typeof candidate !== "string") return false;
  const value = identityPath(candidate.replace(/\\/g, "/").replace(/\/{2,}/g, "/"));
  return configFiles.some((configPath) => {
    const suffix = identityPath(configPath);
    return value === suffix || value.endsWith(`/${suffix}`);
  });
}

const IGNORED_DIRECTORIES = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".bzr",
  "_darcs",
  "CVS",
  ".jj",
  ".pijul",
];
const ignoredDirectoryNames = new Set(
  IGNORED_DIRECTORIES.map((name) => (process.platform === "win32" ? name.toLowerCase() : name)),
);

async function findConfigs(projectPath, { signal, additionalFiles = [] } = {}) {
  signal?.throwIfAborted();
  const configFiles = normalizeConfigFiles(additionalFiles);
  const root = path.resolve(projectPath);
  const directories = new Map();
  const isPhysicalDirectory = async (directory) => {
    if (!directories.has(directory)) {
      directories.set(
        directory,
        fs
          .lstat(directory)
          .then((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .catch((error) => {
            if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
            throw error;
          }),
      );
    }
    const physical = await directories.get(directory);
    signal?.throwIfAborted();
    return physical;
  };
  if (!(await isPhysicalDirectory(root))) return [];
  const candidates = new Map();
  // A positive inclusion glob overrides .gitignore in ripgrep. Keep the
  // editor's complete ignore policy and filter streamed file names here.
  const crawl = lumine.project.crawl({
    directoryPaths: [root],
    inclusion: "**",
    followSymlinks: false,
    ignoredNames: IGNORED_DIRECTORIES,
    didFindPaths(paths) {
      if (signal?.aborted) return;
      for (const candidate of paths) {
        if (!isConfigPath(candidate, configFiles)) continue;
        const absolute = path.resolve(candidate);
        const relative = path.relative(root, absolute);
        if (
          !relative ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          continue;
        candidates.set(identityPath(absolute), absolute);
      }
    },
  });
  let abort;
  const cancelled =
    signal &&
    new Promise((_resolve, reject) => {
      abort = () => {
        try {
          crawl.cancel?.();
        } catch {
          /* Cancellation still rejects with its original reason. */
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  try {
    await (cancelled ? Promise.race([crawl, cancelled]) : crawl);
    signal?.throwIfAborted();
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
  const configs = [];
  for (const candidate of [...candidates.values()].sort()) {
    signal?.throwIfAborted();
    let current = root;
    let physical = true;
    for (const segment of path
      .relative(root, path.dirname(candidate))
      .split(path.sep)
      .filter(Boolean)) {
      const name = process.platform === "win32" ? segment.toLowerCase() : segment;
      current = path.join(current, segment);
      if (ignoredDirectoryNames.has(name) || !(await isPhysicalDirectory(current))) {
        physical = false;
        break;
      }
    }
    if (!physical) continue;
    const file = await fs.lstat(candidate).catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
      throw error;
    });
    signal?.throwIfAborted();
    if (file?.isFile() && !file.isSymbolicLink()) configs.push(candidate);
  }
  return configs;
}

function validateStringArray(value, field, source) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${source}: ${field} must be an array of strings`);
  }
  return value;
}

function normalizeTarget(rawTarget, projectPath, source, index = 0, configPath = null) {
  projectPath = path.resolve(projectPath);
  configPath = configPath ? path.resolve(projectPath, configPath) : null;
  const configDirectory = configPath ? path.dirname(configPath) : projectPath;
  const taskDirectory =
    configPath && isConfigPath(configPath) ? path.dirname(configDirectory) : configDirectory;
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
    throw new TypeError(`${source}: target ${index + 1} must be an object`);
  }
  if (typeof rawTarget.cmd !== "string" || rawTarget.cmd.trim() === "") {
    throw new TypeError(`${source}: target ${index + 1} requires a non-empty cmd`);
  }
  const name = rawTarget.name ?? rawTarget.cmd;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`${source}: target ${index + 1} requires a non-empty name`);
  }
  if (
    rawTarget.env != null &&
    (typeof rawTarget.env !== "object" || Array.isArray(rawTarget.env))
  ) {
    throw new TypeError(`${source}: env must be an object`);
  }
  const env = {};
  for (const [key, value] of Object.entries(rawTarget.env ?? {})) {
    if (typeof value !== "string")
      throw new TypeError(`${source}: environment values must be strings`);
    env[key] = value;
  }
  const cwd = rawTarget.cwd ?? ".";
  if (typeof cwd !== "string") throw new TypeError(`${source}: cwd must be a string`);

  return {
    name,
    cmd: rawTarget.cmd,
    args: validateStringArray(rawTarget.args, "args", source),
    cwd: /\{[A-Z_]+\}/u.test(cwd) ? cwd : path.resolve(taskDirectory, cwd),
    env,
    shell: Boolean(rawTarget.shell),
    commandName: typeof rawTarget.commandName === "string" ? rawTarget.commandName : null,
    errorMatch: rawTarget.errorMatch ?? null,
    source,
    projectPath,
    configPath,
    configDirectory,
    taskDirectory,
  };
}

function targetsFromDocument(document, projectPath, source, configPath = null) {
  const rawTargets = Array.isArray(document)
    ? document
    : document && typeof document === "object" && Object.hasOwn(document, "tasks")
      ? document.tasks
      : [document];
  if (!Array.isArray(rawTargets)) throw new TypeError(`${source}: tasks must be an array`);
  return rawTargets.map((target, index) =>
    normalizeTarget(target, projectPath, source, index, configPath),
  );
}

async function loadConfigTargets(projectPath, { signal, additionalFiles = [] } = {}) {
  const root = path.resolve(projectPath);
  const configPaths = await findConfigs(root, { signal, additionalFiles });
  const targets = [];
  for (const configPath of configPaths) {
    signal?.throwIfAborted();
    const source = path.relative(root, configPath).split(path.sep).join("/");
    const contents = await fs.readFile(configPath, { encoding: "utf8", signal });
    signal?.throwIfAborted();
    let document;
    try {
      if (/\.ya?ml$/i.test(configPath)) {
        const parser = await yamlLoader.load();
        signal?.throwIfAborted();
        document = parser.parse(contents);
      } else document = JSON.parse(contents);
    } catch (error) {
      signal?.throwIfAborted();
      throw new SyntaxError(`${source}: ${error.message}`, { cause: error });
    }
    signal?.throwIfAborted();
    targets.push(...targetsFromDocument(document, root, source, configPath));
  }
  return targets;
}

function replaceVariables(value, variables) {
  return value.replace(/\{([A-Z_]+)\}/g, (match, name) =>
    Object.hasOwn(variables, name) ? variables[name] : match,
  );
}

function expandTarget(target, context) {
  const editor = context.editor;
  const filePath = editor?.getPath() ?? "";
  const cursor = editor?.getCursorBufferPosition();
  let selectedText;
  const variables = {
    PROJECT_PATH: context.projectPath ?? target.projectPath ?? "",
    CONFIG_PATH: target.configPath ?? "",
    CONFIG_DIRECTORY: target.configDirectory ?? context.projectPath ?? target.projectPath ?? "",
    FILE_ACTIVE: filePath,
    FILE_ACTIVE_PATH: filePath ? path.dirname(filePath) : "",
    FILE_ACTIVE_NAME: filePath ? path.basename(filePath) : "",
    get SELECTION() {
      if (selectedText !== undefined) return selectedText;
      const range = editor?.getSelectedBufferRange?.();
      const buffer = editor?.getBuffer?.();
      if (range && buffer?.characterIndexForPosition) {
        const length =
          buffer.characterIndexForPosition(range.end) -
          buffer.characterIndexForPosition(range.start);
        if (length > MAX_STRING_LENGTH)
          throw Object.assign(
            new RangeError(
              "The selected text exceeds the runtime string limit and cannot be expanded into a build command.",
            ),
            { code: "ERR_BUILD_SELECTION_TOO_LARGE", length, limit: MAX_STRING_LENGTH },
          );
      }
      return (selectedText = editor?.getSelectedText() ?? "");
    },
    ROW: cursor ? String(cursor.row + 1) : "",
    COLUMN: cursor ? String(cursor.column + 1) : "",
  };
  return {
    ...target,
    cmd: replaceVariables(target.cmd, variables),
    args: target.args.map((argument) => replaceVariables(argument, variables)),
    cwd: path.resolve(
      target.taskDirectory ??
        target.configDirectory ??
        context.projectPath ??
        target.projectPath ??
        ".",
      replaceVariables(target.cwd, variables),
    ),
    env: Object.fromEntries(
      Object.entries(target.env).map(([key, value]) => [key, replaceVariables(value, variables)]),
    ),
  };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  normalizeConfigFiles,
  isConfigPath,
  expandTarget,
  findConfigs,
  loadConfigTargets,
  normalizeTarget,
  targetsFromDocument,
};
