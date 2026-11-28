---
name: preview-browser
description: Run and compare authenticated WebUI previews in headless Chromium with isolated per-variant headers. Use for agent-driven UI checks, on-request live tab sharing, and cleanup on projects with a preview-browser configuration.
---

Run from the trusted project checkout containing `preview-browser.config.json` and the installed Playwright package. Invoke this skill’s `scripts/cli.mjs` from that checkout. The example uses the repository-installed skill path. Use a deployment summary for each selector and expected revision. Pick the same path for both sides.

```sh
node .agents/skills/preview-browser/scripts/cli.mjs compare "$FLAG_A" "$SHA_A" "$FLAG_B" "$SHA_B" --path /
```

The process owns the browser. Leave it running in a tool session while issuing commands from another shell. Its output contains the run ID and sides. `open SELECTOR REVISION` starts one side. Read each side with `inspect RUN a` or `inspect RUN b`. Use `screenshot RUN SIDE FILE` to compare layout. `goto RUN SIDE /path`, `click RUN SIDE ROLE NAME`, and `fill RUN SIDE LABEL VALUE` act on that side. Two agents can use the same project identity with their own run IDs. Agree on fixtures before comparing mutable backend data.

Authenticate the owner process using the project's credential injection setup. If the sandbox blocks the provisioned credential helper, Browser Run connection, or session socket, request scoped access for the same launcher command and retry. The controller checks the app's response for the expected principal and release before reporting readiness. If it receives an Access login redirect, a denied role, or the wrong revision, report the failed check and correct the project configuration. Keep the agent's mailbox and personal browser outside this workflow.

Generate `show RUN SIDE` only when the user requests a live tab. The returned capability URL is private; give it directly to the requester. Cloudflare produces a read-only hosted view. Local Chromium streams a read-only view on loopback for a human on the same computer. An explicitly requested interactive Cloudflare handoff uses `show RUN SIDE --control`; agent interactions pause until `resume RUN`. Close the run to end existing hosted grants.

Use `close RUN` when done, including failed tests, and wait for the owner to exit. The launcher also cleans up on termination and after two minutes without a control command. A local check requires no desktop browser window.

For another project, see [project configuration](references/project.md).
