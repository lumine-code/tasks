# tasks

Run document and project tasks with shared process control, diagnostics and retained logs.

| Metadata    | Value                               |
| ----------- | ----------------------------------- |
| Version     | `1.0.0`                             |
| Provided by | Task manager packages               |
| Consumed by | Document tools and artifact viewers |
| Owner       | `tasks`                             |

## Registration

Consumers declare `tasks` in `consumedServices` at `^1.0.0`. Tool packages register a provider through the service and return its registration from their consumer callback. A provider describes a document and interprets its results; the task manager owns processes, cancellation, observations, diagnostics and logs.

## Contract

```ts
type JobState = "preparing" | "running" | "collecting" | "passed" | "failed" | "cancelled";
type JobRequest = { providerId: string; filePath: string; reason?: string };
type ProviderFilter = { providerId?: string };
type DocumentFilter = ProviderFilter & { filePath?: string };
type ArtifactTarget = { providerId: string; filePath: string };

interface TaskService {
  registerProvider(provider: TaskProvider): Disposable;
  resolve(providerId: string, filePath: string): string | null;
  run(request: JobRequest): Job | null;
  getTargets(): Target[];
  getJob(request: { providerId: string; filePath: string }): Job | null;
  getJobs(filter?: DocumentFilter & { activeOnly?: boolean }): Job[];
  getLogs(): Job[];
  stop(request: { providerId: string; filePath: string }): boolean;
  stopAll(filter?: ProviderFilter): number;
  removeLog(id: string): boolean;
  getMessages(filter?: DocumentFilter): Diagnostic[];
  clearMessages(filter?: DocumentFilter): void;
  getArtifacts(filePath: string): Artifact[];
  associateArtifact(target: ArtifactTarget, artifactPath: string): boolean;
  getArtifactTarget(artifactPath: string): ArtifactTarget | null;
  setObserved(request: { providerId: string; filePath: string }, enabled: boolean): boolean;
  getObserved(filter?: ProviderFilter): Array<{ providerId: string; filePath: string }>;
  clearObserved(filter?: ProviderFilter): void;
  onDidStartJob(callback: (job: Job) => void): Disposable;
  onDidChangeJob(callback: (job: Job) => void): Disposable;
  onDidFinishJob(callback: (job: Job) => void): Disposable;
  onDidChangeTargets(callback: (change: { targets: Target[] }) => void): Disposable;
  onDidChangeArtifactTargets(
    callback: (change: { artifactPath: string; target: ArtifactTarget | null }) => void,
  ): Disposable;
  onDidChangeProviders(callback: (change: { providerId: string }) => void): Disposable;
  onDidChangeObserved(
    callback: (change: { providerId: string; filePath: string; enabled: boolean }) => void,
  ): Disposable;
}

interface TaskProvider {
  id: string;
  name: string;
  supports(filePath: string): boolean;
  resolve?(filePath: string): string;
  getWatchPaths?(filePath: string): string[];
  prepare(
    request: { filePath: string; reason: string },
    signal: AbortSignal,
  ): TaskPlan | Promise<TaskPlan>;
  collectResult?(
    result: {
      job: Job;
      filePath: string;
      plan: TaskPlan;
      stdout: string;
      stderr: string;
      code: number | null;
      signal: string | null;
      error: Error | null;
    },
    signal: AbortSignal,
  ): TaskResult | Promise<TaskResult>;
}

interface TaskPlan {
  cmd: string;
  name?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  artifacts?: Artifact[];
}

interface TaskResult {
  diagnostics?: Diagnostic[];
  artifacts?: Artifact[];
  failed?: boolean;
}

interface Artifact {
  path: string;
  kind: string;
  sourcePath?: string;
}

interface Diagnostic {
  severity: "error" | "warning" | "info" | "hint";
  excerpt: string;
  location: { file: string; position: [[number, number], [number, number]] };
}

interface Target {
  id: string;
  providerId: string;
  name: string;
  source: string;
  filePath: string;
  canonicalPath: string;
  projectPath?: string;
  configPath?: string;
  configDirectory?: string;
  taskDirectory?: string;
}

interface Job {
  id: string;
  targetId: string;
  providerId: string;
  filePath: string;
  name: string;
  source: string;
  reason: string;
  state: JobState;
  startedAt: number;
  finishedAt: number | null;
  elapsedTime: number;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  error: Error | null;
  outputTruncated: boolean;
  artifacts: Artifact[];
  diagnostics: Diagnostic[];
  log: {
    getText(): string;
    clear(): void;
    onDidChange(callback: (change: unknown) => void): Disposable;
  };
  completion: Promise<Job>;
  stop(): boolean;
}
```

Provider `id`, `name`, `supports` and `prepare` are required. IDs are unique within a task manager. `supports`, `resolve` and `getWatchPaths` are synchronous; `resolve` maps an included document to its canonical root. Providers retain language settings, compiler discovery, argument construction, log parsing and artifact identification. Plans may carry provider-specific data for `collectResult`.

`cmd` is required in each plan. Arguments default to an empty array, the working directory defaults to the source directory, environment values extend the editor's environment and `shell` defaults to `false`. Relative artifact paths resolve against the working directory; omitted `sourcePath` becomes the canonical source path. Common artifact kinds include `pdf`, `png` and `svg`. Diagnostic positions are zero-based and use the linter's shared message shape.

## Minimal example

```js
consumeTasks(tasks) {
  return tasks.registerProvider({
    id: "example-tools",
    name: "Example compiler",
    supports: (filePath) => filePath.endsWith(".example"),
    prepare: ({ filePath }) => ({
      cmd: "example-compiler",
      args: [filePath],
      artifacts: [{ path: filePath + ".pdf", kind: "pdf" }],
    }),
  });
}

async compile(tasks, filePath) {
  const job = tasks.run({ providerId: "example-tools", filePath });
  if (!job) return;
  const result = await job.completion;
  if (result.state === "passed") {
    const pdf = result.artifacts.find((artifact) => artifact.kind === "pdf");
    if (pdf) await lumine.workspace.open(pdf.path);
  }
}
```

## Behavior

Requests always name a provider and source path; the service never substitutes the active editor or a project. Different canonical documents may run concurrently. A second request for a running document returns its existing job. A request with `reason: "save"` also schedules one subsequent run, coalescing further saves until the current run finishes.

Document commands save the requested source before calling `run` when root discovery depends on its contents. The Tasks target command applies Save Before Running before resolving the source. Provider preparation saves any additional canonical source editor required by the compiler and checks its abort signal after asynchronous saves. This keeps synchronous job identity tied to the actual document root.

Jobs progress through `preparing`, `running` and `collecting`, then reach `passed`, `failed` or `cancelled`. `completion` resolves with the terminal job. `collectResult` runs after the child closes and its streams drain. Providers can flag a nonzero semantic result through `failed` even when the process exits successfully. Async preparation and result collection receive an abort signal; cancelled or retired work cannot publish a later result.

Job objects retain their identity and their fields change over time. Consumers treat them as read-only and dispose event subscriptions when the service edge disappears. `onDidChangeJob` includes creation, output and state changes. `onDidStartJob` runs after preparation declares expected artifacts and before spawning the compiler. `onDidFinishJob` reports terminal jobs. Artifact viewers use active jobs and their expected paths to pause file reloads while output is being written, including when the output does not exist yet. Expected artifacts do not guarantee that a failed or cancelled build produced a usable file.

`associateArtifact({ providerId, filePath }, artifactPath)` records a known artifact's build source without running a compiler. Source and artifact paths are normalized to absolute paths; the provider must be registered. The method performs no filesystem discovery and does not call provider predicates or root resolution. It returns `true` when the mapping changes and `false` for invalid requests or an unchanged mapping. The latest association call wins, including automatic association after build phases; there is no fallback to another provider.

Prepared artifacts are associated with their job's canonical `filePath` before `onDidStartJob`, and collected artifacts are associated after current result collection. A provider may explicitly associate a known output when opening it, including a custom PDF path before any build has run. Artifact metadata's optional `sourcePath` does not replace the job's canonical build source for this association.

`getArtifactTarget(artifactPath)` returns a fresh `{ providerId, filePath }` object for the cached association, or `null`. This getter performs no I/O or provider callbacks and can be used by command availability predicates. Associations survive log removal and history pruning. They belong to the exact provider registration generation and are cleared when it retires or the manager is disposed; re-registering the same provider ID does not restore an old association. Cancelled and retired jobs cannot publish late associations.

`onDidChangeArtifactTargets` reports each changed mapping as `{ artifactPath, target }`, using normalized absolute paths. Removal reports `target: null`; unchanged associations emit nothing. Viewers can use this event to update an already-open artifact when a provider explicitly associates it without creating a job. Association changes also invalidate command availability.

`onDidChangeProviders` reports provider registration and removal. Target pickers can rediscover available document actions when providers change; the Tasks view also refreshes its targets when the active editor changes.

`getTargets` returns the current catalog of configured targets and document providers eligible for the current source. Configured targets retain their normalized command fields in addition to the catalog metadata shown above. Their `taskDirectory` anchors default and relative working directories, while `configDirectory` identifies the physical configuration directory. Document target `filePath` identifies the focused source, while `canonicalPath` identifies its provider-resolved root. A target's stable `id` matches `Job.targetId`, combining the provider and canonical source. `onDidChangeTargets` reports catalog updates.

Configured target identity uses the configuration path, target name and occurrence among duplicate names. It does not depend on command arguments or the positions of differently named targets. The catalog supplies a task picker: choosing an entry explicitly starts it. Source-context changes update document-provider choices while configured tasks remain available across their open project roots. Opening a historical execution does not change the catalog or execute a task.

Each call that starts a new execution creates a distinct `Job.id`, even when several runs share the same `targetId`. Execution history displays one row for every retained job from its initial `preparing` state onward. Its details refer to that exact job. Available targets that have never run remain catalog entries for selection. Catalog entries are snapshots; consumers preserve target selection by ID rather than holding a target object across updates.

Configured tasks are merged from every `.lumine/tasks.json` found recursively under the open workspace roots. `tasks.additionalConfigFiles` adds relative file names or path suffixes without replacing the default. Matching files have independent identities and no precedence by format; duplicate paths under overlapping roots are loaded once using the most specific root. Discovery follows the editor's crawl exclusions and skips dependency directories, version-control metadata and symlinks. JSON documents use a `tasks` array, and explicitly configured YAML or YML files use the same shape. For the default file, omitted and relative working directories resolve from the parent of `.lumine`; additional files use their containing directory. `{CONFIG_PATH}` and `{CONFIG_DIRECTORY}` still name the physical file and its directory, while `{PROJECT_PATH}` names its workspace root. Configuration file changes, additional-file setting changes and explicit refreshes reload discovery; source-focus changes reuse the cached catalog.

A configured target removed from discovery becomes unavailable for new requests. Its running process keeps its captured plan, and its temporary provider is retired after active work finishes. Retained runs remain inspectable in execution history. This differs from explicit disposal of an external provider registration, which cancels that provider's work as described below.

`getJobs` returns retained jobs in creation order; `getLogs` returns them newest first, including active jobs. The execution list can sort these jobs by status, start time, duration, target and source; `Job.id` identifies the same execution across sorting and updates. `getJob` queries the latest job by canonical provider and source path, including when its output is no longer retained. `getArtifacts` resolves the supplied source through each provider and returns its latest expected or collected artifacts. `getMessages` returns diagnostics from the latest jobs. Removing a completed log releases its output and removes that execution's history row without cancelling another job or erasing the latest result used by those queries. Active logs cannot be removed. History, displayed log lines and captured stream characters have configurable limits; `outputTruncated` reports stream truncation.

`setObserved` enables compile-on-save for a canonical document and optional `getWatchPaths` dependencies, including when their editors are closed. File changes are debounced; dependency paths are refreshed after each run. An open matching editor using the None grammar suppresses automatic compilation. Disabling observation uses the canonical source path from `getObserved`, clears pending reruns and releases its watchers. It does not interrupt a manually running task.

## Teardown

Dispose a provider registration when its service edge disappears. The manager then removes that provider's observations, cancels its jobs and clears its current diagnostics. Consumers dispose their event subscriptions separately. Closing the Tasks dock tab releases the presentation while tasks and logs remain owned by the manager. Deactivating the service stops its tasks and releases all observations and retained output.

## Versioning

New optional fields and additional artifact kinds are additive within `1.x`. Changes to required fields, job identity, cancellation, event order or execution semantics require a new service contract name and coordinated consumer updates.
