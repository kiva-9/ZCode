# Computer Use

Computer Use lets ZCode operate native desktop applications the way a person
would: observe an app's interface, click its controls, type into its fields and
press keys. It ships as the `computer-use` plugin (manifest v0.6.1, author Z.ai)
on top of the `@zcode/zcode-cua` runtime (v0.6.3), which drives the desktop via
`@trycua/cua-driver` 0.28.2.

This page is for the person operating ZCode, not for the model. It explains what
the feature needs from the machine, what it will and will not do on its own, and
how to stop it.

## 1. What Computer Use does — and where the runtime comes from

Computer Use reads the accessibility (AX) tree of a running application, finds
the control you or the model named, and acts on it — clicks, drags, typing, key
chords, scrolling, setting values — while the target app stays in the background.

**Hard rule: the host provides the runtime.** There is nothing to install and no
package name to guess. Never run `npm install`, `pnpm add` or `pip install` to
"fix" a missing Computer Use runtime, and never look for an alternative driver
or a way to make one appear. If Computer Use is unavailable, that means the
plugin is not enabled for this client — not that a dependency is missing. The
only supported fix is enabling the plugin (section 2) and granting the system
permissions (section 3).

## 2. Enabling it

| Fact                   | Value                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| Default state          | Off — the plugin ships disabled                                  |
| Where to enable        | Settings → Computer Use                                          |
| Existing conversations | Need a restart; the setting is picked up when the session starts |

Enabling it turns on the runtime bridge for new sessions. A conversation started
before the change reports Computer Use as unavailable — restart it; do not reinstall.

## 3. Required system permissions

| Platform       | Required grants                                          |
| -------------- | -------------------------------------------------------- |
| macOS          | Accessibility and Screen Recording                       |
| Windows, Linux | Code path exists but is **not verified** (see section 9) |

On macOS both grants must belong to **the process that runs Computer Use**, and
that process is the one you must find in System Settings:

1. In System Settings → Privacy & Security, confirm the process that runs
   Computer Use is present and switched on under Accessibility, and again under
   Screen Recording (Screen & System Audio where System Settings groups them).
2. Re-check by calling `agent.computerUse.capabilities()` — it reports
   `accessibility` and `screenRecording` from the driver's `check_permissions`,
   together with the permission subject: `source.executable` and
   `host_bundle_id`, plus the driver's own note that in embedded mode the
   booleans reflect **the HOST app's TCC grant**, not a helper's.
3. Re-detect after changing a permission by calling `capabilities()` or
   `diagnostics()` again — the report is read live from the driver each call.

Honest note about the permission subject: in this build the driver runs **in the
node_repl host process** — there is no separate Helper app. In development the
subject is the host process you launched (the terminal running the CLI, or the
desktop app), and the `health_report` `bundle_identity` check is expected to fail
for a plain node process with no `CFBundleIdentifier`.

## 4. Supported platforms and models

| Platform           | Status                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| macOS arm64        | Primary accepted platform, and the only one verified on a real machine |
| Windows, Linux     | Code path kept; **not verified**                                       |
| Packaged installer | **Not verified**                                                       |

| Model capability | Path                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| Text-only model  | Accessibility (AX) path — the supported way to work without images              |
| Screenshots      | Need a model that can read images **and** a provider that can carry tool images |

The runtime does not guess about image transport: `screenshotProducible`,
`modelCanReadImages` and `providerCanCarryToolImages` all report `unknown`,
because that decision belongs to the host's provider layer. Do not promise a
screenshot step to a model with no image path; fall back to the AX path.

## 5. Safety model

| Rule                   | Behavior                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background first       | Delivery is background by default; nothing steals the user's focus                                                                                                                                                          |
| Foreground             | `background_unavailable` maps to `FOREGROUND_REQUIRED`; the runtime **never** auto-upgrades to foreground — the user must bring the app forward                                                                             |
| One active session     | One active desktop control lease per desktop. A second live session is refused (`CONTROLLER_BUSY`) and never retried automatically; report the owner and stop                                                               |
| Subagents              | Refused. Computer Use is main-agent only and is never delegated to a subagent                                                                                                                                               |
| Blocked inputs         | Danger chords (`cmd+shift+backspace`, `cmd+ctrl+q`, `ctrl+alt+delete`, `option+f4`, `win+l`, …) and pipe-to-shell or recursive-delete inputs are refused **before any approval** — no approval prompt can wave them through |
| Snapshot-bound targets | Element targets are tokens bound to the observation they came from; a vanished element fails closed rather than acting on a stale index                                                                                     |
| Coordinates            | Coordinates belong to one raster; a coordinate from an earlier frame is refused, not reinterpreted                                                                                                                          |

What the plugin may never do: install, upgrade or substitute the driver; promote
itself to the foreground; act after a stop until you explicitly re-authorize; or
run inside a subagent. Approval boundaries are otherwise unchanged from the rest
of ZCode — consent is still asked for, blocked classes never reach that prompt,
and a stop is honored immediately.

## 6. Stopping

Use the **stop computer control** button in the chat. It is a per-session stop.

What it does: control for that session ends immediately; further actions are refused for it.

What it does not do:

- It does not roll back delivered input. Text already typed and clicks already
  sent have already happened.
- It does not auto-reconnect. The session stays stopped; there is no background
  retry that resumes control.
- It does not survive recovery by reset. The stop survives a REPL reset, a
  reconnect and a retry, and stays in force **until the user explicitly
  re-authorizes** Computer Use.

## 7. Diagnostics

Two helpers are read-only and report facts instead of guessing:

| Call                               | What it reports                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.computerUse.capabilities()` | Platform, driver package and version, native platform-package resolution, system permissions (accessibility, screen recording, whether screen recording can capture, and the permission subject), observation capability, image transport as `unknown`, and session facts (lease held / holder, stopped, observation count) |
| `agent.computerUse.diagnostics()`  | Runtime facts (pid, Node version, driver load source and version, whether the driver resolves), lease state, observation summaries, and the driver's `health_report` checks — 8 checks in the verified run, including a `bundle_identity` check that fails when the host process has no `CFBundleIdentifier`                |

Neither helper ever clicks or types, so they are safe to call when something
fails. Read the concrete failing field and quote it — "Screen Recording is not
granted to the process that runs Computer Use" is actionable, "something is
wrong" is not. A passing capability report is not approval to start typing.

When you export a diagnostic bundle, preview it before it leaves the machine:
screenshots and AX content can be privacy sensitive.

## 8. Upgrade and cleanup

Upgrade: the runtime ships with ZCode and is enabled through Settings → Computer
Use. There is nothing for you to upgrade by hand, and no driver installation step
should ever be attempted to "upgrade" it.

Cleanup — three separable things, owned by different places:

| What                      | Where it lives                                                               | How to remove                                                               |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Plugin state / app data   | ZCode app data and settings                                                  | Turn the plugin off in Settings → Computer Use                              |
| Optional driver resources | Native driver packages pulled in with the runtime                            | Leave them; they are shared and removed by the package manager, not by hand |
| System permission entries | macOS System Settings → Privacy & Security (Accessibility, Screen Recording) | Remove the entry for the host process if you no longer want it              |

Closing the plugin disables assembly and restores the previous behavior without
uninstalling ZCode.

**Never delete a Cua installation that other programs share.** The Cua driver on
this machine may be used by other software besides ZCode; removing its files or
its permission entries to "clean up" can break those programs.

## 9. Known limitations

Verified on macOS 27.0.1 arm64 with Node 24.18 and driver 0.28.2: in-process
driver load, `list_apps`, `list_windows`, `get_capabilities`,
`get_diagnostics`, `request_access`, a live AX observation with 71 elements and
`state_id` / `element_index` tokens, an AX click receipt, a stale-token refusal,
and the background-refusal path.

Not verified — treat each as unproven rather than working:

- Screenshot delivery through the model message in the session it was tested in
  (that session later stopped exposing any AXWindow elements — `ax_window_unresolved`
  for every window).
- Windows and Linux.
- The packaged installer.
- The desktop task set (an end-to-end task suite over the desktop).

Known behavioral edges:

- A window on another Space can fail to resolve (`ax_window_unresolved`).
- Hidden and minimized windows return an empty tree by design; observe a
  visible window instead of reading emptiness as an error.
- `select_text`, `perform_action` and `paste` are accepted by name but return
  `ACTION_UNAVAILABLE` by design in this runtime.
- In dev the permission subject is the host process, not a Helper app, and the
  `bundle_identity` health check is expected to fail for plain node.
