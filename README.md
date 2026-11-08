# tasks

Run project tasks and surface their output and diagnostics.

Fork of [noseglid/atom-build](https://github.com/noseglid/atom-build).

## Features

- **Project targets**: discovers JSON or YAML target definitions throughout every open project, including nested configurations.
- **Document tasks**: runs language-specific compilers through a shared service while their packages resolve documents and interpret results.
- **Execution history**: lists each run from preparation onward, with sortable status, start time, duration, target and source columns and a detail view for its output.
- **Process control**: runs independent documents concurrently, coalesces repeated saves and stops compiler process trees.
- **Diagnostics**: combines provider diagnostics and named regular-expression captures, navigates results and publishes to the linter.
- **Compile on save**: observes explicitly selected documents and their provider-supplied dependencies, including after an editor closes.
- **Workspace integration**: reports progress through busy-signal and the status bar when available.

![Track active tasks and inspect a completed build log.](.github/demo.png)

## Installation

To install `build` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/tasks`.

## Commands

Commands available in `lumine-workspace`:

- `tasks:run-task`: choose an available task and run it immediately,
- `tasks:stop`: stop the task whose log is selected,
- `tasks:stop-all`: stop all active tasks,
- `tasks:clear-logs`: remove all completed logs without opening Tasks or stopping running tasks,
- `tasks:toggle`: show or hide the Tasks view,
- `tasks:toggle-focus`: focus Tasks or return to the center pane (Alt+B),
- `tasks:observed-files`: list documents observed for compile-on-save,
- `tasks:clear-observed`: stop observing all documents,
- `tasks:next-error`: open the next matched diagnostic,
- `tasks:previous-error`: open the previous matched diagnostic.

Commands available in `.tasks-panel`:

- `tasks:open-details`: open the exact execution associated with a history row,
- `tasks:rerun-task`: rerun the clicked or displayed execution's target when it is available,
- `tasks:back-to-history`: return from run details to execution history,
- `tasks:stop-task`: stop the clicked or displayed execution,
- `tasks:toggle-log`: hide or show the displayed execution's output, in the detail view only,
- `tasks:copy-log`: copy that execution's log,
- `tasks:remove-log`: remove that completed execution's log,
- `tasks:clear-list`: remove all completed execution logs from history, in the history view only.

Commands available in `.tasks-observed-files`:

- `tasks:open-observed-file`: open the selected observed source,
- `tasks:unobserve-selected-file`: stop compiling the selected document when its files change.

Commands available in `.tasks-targets`:

- `tasks:choose-task`: run the selected task,
- `tasks:refresh-tasks`: reload available tasks while keeping the picker open.

## Usage

The Tasks icon is visible in the status bar by default. Click it to toggle the bottom panel; Alt+B toggles focus between Tasks and the center editor. Its context menu offers task execution, stopping runs and managing observed documents. Compiler packages share this control instead of adding their own status or observation indicators.

The tools icon stays neutral and pulses while any execution is preparing, running or collecting results, including while Tasks is visible. The upper count shows unread completed logs in the color of the worst unread result, with failures taking priority over cancelled results, then successful results. The tooltip includes counts and outcomes. Revealing Tasks in any visible dock pane acknowledges these results and clears the upper count; keyboard focus is not required. Results completed while Tasks is visible are already seen and add no upper count. The lower count shows distinct canonical documents observed for compile-on-save across providers, excluding dependency-watch paths.

Run Task from the Tasks menu, its status control or the command palette opens a picker of available project and document tasks. Choosing an entry starts that task immediately. Opening or dismissing the picker leaves the execution history unchanged. Document tool packages can also start compiler tasks directly through the shared service.

Running or rerunning a task, using a compiler package command or compiling an observed document never opens Tasks or moves focus to it. The shared status control signals progress and results, and logs remain available in execution history. Use `tasks:toggle` to show or hide Tasks, or `tasks:toggle-focus` to focus it or return to the center editor.

The task picker reloads its choices every time it opens. While it is open, press F5 or use its Refresh Tasks action to reload without closing the picker, changing the search query or modifying execution history. Refresh Tasks is also available under Packages > Tasks while the picker has focus.

Execution history has one row per retained run, appearing as soon as preparation starts and updating through running, result collection and completion. Its columns are Status, Started, Duration, Target and Source. Click a column header to sort. Open a row to inspect that exact execution's output, stop it, copy its log, or remove a completed log. Back returns to the history, keeping its sort order and scroll position and clearing row focus. Rerun in the detail view starts another execution of the same task using its current definition when that task is still available.

Hide log and Show log toggle output visibility for the displayed execution without removing its content. Incoming output stays hidden until Show log is used, and Copy Log remains available for the retained text. Each execution keeps its own visibility setting while navigating between history and details.

Status filters and the Run task, Clear List and Observed Documents icon buttons sit at the right of the Source column header. Running, Passed, Failed and Cancelled are all shown by default; Running includes preparation and result collection. Filters hide rows without deleting their logs and remain set while viewing details and after Back. The Run task icon opens the task picker and waits for a choice. The eye icon opens Observed Documents. Clear List removes every completed execution log, including filtered-out rows, while retaining running executions.

Middle-click a completed row to remove its log. Running executions cannot be removed. Click a path in the Source column to open its file; hover over it to see the full path.

Right-click a history row for Open Details, Run Again, Stop, Copy Log and Remove Log. These actions use the clicked execution, including when another row has focus. Actions that do not apply to its current state are disabled.

Removing a completed log removes its history row and releases its output; the latest result remains available to status and diagnostic queries. Executions whose targets have left the current context remain inspectable while their logs are retained. Closing the Tasks tab keeps tasks running and preserves their logs for reopening.

The task picker combines configured tasks from every open project with compiler actions for the current document. The Tasks panel keeps the center document's context, so focusing run details preserves those document choices. Viewing an earlier execution does not change the available tasks or start another run.

Different documents can compile concurrently. Repeated save requests for one busy document schedule one subsequent compilation. Artifact viewers can pause reloads until the associated task has collected its results. Provider packages retain their language-specific commands, settings and document navigation.

Observed Documents lists compile-on-save sources from all compiler providers. Search by provider or source path, open a selected source, stop observing one document or clear the whole list. Removing an entry keeps the list open and preserves the remaining selection.

Compiler integrations enable observation through the shared service with `setObserved({ providerId, filePath }, true)` and disable it with `false`. `getObserved({ providerId })` lists that provider's observed sources; `getObserved()` includes all providers. Each observation remains a provider/source pair in the shared list, while the lower status count deduplicates their canonical document paths across providers.

Create `.lumine/tasks.json` in a project root or any nested project directory. Every open root is searched recursively and all matching files contribute tasks. Discovery respects workspace file exclusions, skips dependency and version-control directories such as `node_modules` and `.git`, and does not follow symlinks. A document may describe one task or contain a `tasks` array:

```json
{
  "tasks": [
    {
      "name": "Tests",
      "cmd": "node",
      "args": ["--test"],
      "cwd": ".",
      "env": { "NODE_ENV": "test" },
      "errorMatch": "(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<message>.+)"
    }
  ]
}
```

Add relative file names or paths, such as `tasks.json` or `.config/tasks.yaml`, to `tasks.additionalConfigFiles` to discover more files alongside the default. Entries match complete path suffixes recursively within the open roots; globs, absolute paths and parent traversal are not accepted. Explicit YAML and YML files accept the same shape. All matching files are merged; no format overrides another. Tasks support `name`, `cmd`, string `args`, relative `cwd`, string `env` values, `shell`, `commandName`, and `errorMatch`. A `commandName` must be a unique, unreserved name in the `tasks:` namespace.

For `.lumine/tasks.json`, the default working directory is the directory containing `.lumine`; relative `cwd` values resolve from that directory too. For example, `packages/compiler/.lumine/tasks.json` runs from `packages/compiler`. Additional configuration files use their containing directory as the working-directory base. `{PROJECT_PATH}` names the owning workspace root; `{CONFIG_PATH}` is the full configuration path and `{CONFIG_DIRECTORY}` remains its physical containing directory, including `.lumine` for the default file.

The placeholders `{PROJECT_PATH}`, `{CONFIG_PATH}`, `{CONFIG_DIRECTORY}`, `{FILE_ACTIVE}`, `{FILE_ACTIVE_PATH}`, `{FILE_ACTIVE_NAME}`, `{SELECTION}`, `{ROW}`, and `{COLUMN}` are expanded immediately before a run. Selection text is read only when a target uses `{SELECTION}`; a selection exceeding the runtime string limit rejects that expansion instead of truncating it.

Tasks with the same name in different configuration files remain distinct. Editing command arguments or reordering differently named tasks preserves their identity and association with earlier executions. Removing a task prevents new runs without interrupting a process already using its captured configuration; retained output remains available in execution history.

## Customization

Adjust the output surface in your `styles.css`:

```css
.tasks-panel {
  background: var(--tool-panel-background-color);
  --task-output-line-height: 1.6;
}
```

## Services

- [`build`](docs/tasks.md): provided to register document compilers, run and observe tasks, and inspect their diagnostics, logs and artifacts.
- `status-bar`: consumed to show progress, unread results and the observed-document count.
- `busy-signal`: consumed to report a target while its process is running.
- `linter.registry`: consumed to publish diagnostics parsed from output.
- `background-tips.provider`: provided to describe task execution in the empty workspace.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
