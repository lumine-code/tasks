// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript", "busy-signal"],
  viewport: { width: 1100, height: 730 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("build-sample/signal.js");
    await lumine.project.setPaths([fixture("build-sample")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Track active tasks and inspect a completed build log.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, fixture, waitFor } = context;
        {
          const b = lumine.packages.getActivePackage("tasks").mainModule;
          const service = b.provideTasks();
          state.watchProvider = service.registerProvider({
            id: "demo-signal-watch",
            name: "Watch samples",
            supports: (filePath) => filePath.endsWith(".js"),
            prepare: () => ({
              name: "Watch samples",
              cmd: "node",
              args: ["--watch", "signal.js"],
              cwd: fixture("build-sample"),
            }),
          });
          state.watchJob = service.run({
            providerId: "demo-signal-watch",
            filePath: fixture("build-sample/signal.js"),
          });
          await waitFor(
            () =>
              state.watchJob.state === "running" &&
              state.watchJob.stdout.includes("Mean amplitude: 0.42"),
            "Node watch mode has processed the signal samples",
          );
          await b.refreshTargets();
          const job = await b.runTarget(b.targets.find((target) => target.configPath));
          await job.completion;
          state.completedJob = job;
          b.ensurePanel().selectJob(job);
          await b.ensurePanel().show();
          lumine.workspace.getBottomDock().setState({ size: 300 });
        }
      },
      ready({ lumine, state }) {
        const panel = document.querySelector(".tasks-panel");
        const dock = lumine.workspace.getBottomDock();
        const tasksStatus = document.querySelector("status-bar .tasks-status");
        const iconBounds = tasksStatus?.querySelector(".icon-tools")?.getBoundingClientRect();
        const history = panel?.querySelector(".tasks-run-list");
        const watchRow = history?.querySelector(`[data-job-id="${state.watchJob?.id}"]`);
        const completedRow = history?.querySelector(`[data-job-id="${state.completedJob?.id}"]`);
        const output = panel?.querySelector(".task-output");
        return Boolean(
          iconBounds?.width > 0 &&
          iconBounds?.height > 0 &&
          dock.isVisible() &&
          dock.getElement().contains(panel) &&
          tasksStatus.dataset.running === "true" &&
          panel?.dataset.mode === "details" &&
          panel?.dataset.state === "passed" &&
          watchRow?.dataset.state === "running" &&
          completedRow?.dataset.state === "passed" &&
          panel.querySelector(".tasks-panel-title")?.textContent === "Process samples" &&
          !panel.querySelector(".tasks-panel-details").hidden &&
          output &&
          !output.hidden &&
          output.textContent.includes("Mean amplitude: 0.42"),
        );
      },
    },
  ],
  async cleanup({ state }) {
    state.watchJob?.stop();
    await state.watchJob?.completion;
    state.watchProvider?.dispose();
  },
};
