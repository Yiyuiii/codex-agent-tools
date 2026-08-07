# Windows fd3 write-half-close preflight

Date: 2026-08-01

Status: hard gate failed; implementation stopped before Task 3

Current interpretation (2026-08-01): the negative result remains immutable evidence that Node must not use write-half-close as the normal terminal handshake. The maintainer later removed the three-Node release-proof requirement and asked to eliminate other redundancies. The active design therefore keeps one full-duplex fd3, sends explicit terminate frames, and requires a live Node to keep fd3 open until terminal/helper close. Helper-observed Node-to-helper EOF is a parent-loss/control-failure cleanup signal; Node-observed helper-to-Node EOF before terminal is a permanent failure; clean EOF after a verified terminal and helper-initiated close is normal success evidence. This does not reinterpret the failed probe as PASS and does not implement the previously proposed fd4 channel. See [the current-host minimal design](../superpowers/specs/2026-08-01-windows-current-host-minimal-design.md).

Baseline: Task 1 commits `88cf22b` and `b575dd9`, with Task 2 plan correction `46ce2d2`

## Scope

This note records the negative result required by Task 2 of the approved Windows Job-owned process plan. The run used a real C# .NET Framework 4.8 probe, Node child `stdio[3]`, and C runtime `_get_osfhandle(3)`. It did not create a Job, launch a target CLI, call a model, read active Codex configuration, modify plugins, publish, or add a fallback.

The diagnostic implementation was deliberately not committed as a successful Task 2 implementation. After preserving this result, the code worktree was restored to the clean Task 1 baseline.

## TDD and matrix result

The initial focused RED test failed in both intended places:

- the real `Fd3Probe.cs` source did not exist;
- the Task 1 build entry rejected the not-yet-implemented preflight action.

The minimal probe then established this real sequence on the same fd3 OS handle:

1. Node sent `CONFIG`; C# returned `ACK/READY`.
2. Node sent `PING`; C# returned `PONG`.
3. Node called `.end("FINISH")` on `child.stdio[3]`.
4. C# read `FINISH`, then EOF, and exited with code 0. In the diagnostic probe, code 0 was reachable only after `TERMINAL` write and flush returned without throwing and `_close(3)` returned 0; the successful write/flush is therefore inferred from that unique control path rather than from a separate C# log.
5. Node observed control `end`, control `close`, and process close, but never received `TERMINAL`.

The locked public matrix command was run without retry:

```text
npm run native:preflight
exit 1
windows-native-helper: fd3 preflight failed: windows-native-helper: normal terminal ended with 0
```

The first locked entry, Node `v20.20.2`, failed, so the plan's first-error rule stopped the matrix before Node 22.23.2 and 24.18.1. The verified executable reported libuv `1.46.0`. A second parent-thread run independently reproduced the same terminal failure. The first parent-thread run also exposed a separate transient cleanup defect described below.

## Root cause

Ordinary duplex communication is valid, but Windows libuv does not preserve the readable side of this extra stdio pipe after Node shuts down its writable side.

Node v20.20.2's bundled libuv defines a [50 ms EOF timeout](https://github.com/nodejs/node/blob/v20.20.2/deps/uv/src/win/pipe.c#L41-L43) and starts that timer when a readable pipe is shut down. If the peer has not already produced EOF, the [timer path](https://github.com/nodejs/node/blob/v20.20.2/deps/uv/src/win/pipe.c#L2061-L2161) calls `close_pipe()` with the source comment `Force both ends off the pipe`, stops reading, and reports EOF.

This creates an incompatible ordering for the approved single-handle contract: the helper waits for Node's write EOF before emitting terminal, while Node/libuv closes both directions before that terminal can return. The result is not attributable to the line parser: earlier replies traversed the same reader successfully. It is also inconsistent with an exception in C# write/flush, because the temporary probe's unique code-0 control path required those operations and `_close(3)` to succeed; this remains a control-flow inference, not a separately persisted C# log.

## Independent review

A fresh read-only specification review returned `PASS` for the conclusion that the hard gate is triggered, while explicitly classifying Task 2 itself as not passed. The approved specification says that failure of any locked Node version requires returning to the written specification, without starting Task 3 or automatically selecting a named pipe, PID lookup, `taskkill`, direct spawn, or another helper technology.

The review also found diagnostic-quality issues that do not change the gate result:

- the first failed matrix run's original error was masked by a cleanup failure and left one GUID build root containing the downloaded Node executable, despite no process using that executable;
- the temporary harness did not independently prove helper-side write-half-close while keeping its read direction alive;
- the focused test called the PowerShell current action directly and therefore bypassed the public runner's exact current-version check;
- the no-Job/no-target/no-environment assertions combined source scanning with fixed report fields rather than full runtime instrumentation.

These are reasons not to commit the failed probe as product code. They are not reasons to reinterpret the Node 20 half-close failure as success.

After preserving the evidence, the parent thread verified the exact residual path, its fixed content allowlist, and absence of reparse points, removed that diagnostic GUID root, and confirmed that the build-root count returned to 0.

## Historical replacement carrier options (superseded)

At the time of the failure, no replacement had been implemented and a read-only follow-up compared three written alternatives. The labels and three-version preflight below record that historical judgment only. They are superseded by the current-host design, must not drive implementation, and do not create a pending fd4 approval gate:

1. **Then-recommended, now superseded: split inherited extra stdio channels.** Use fd 3 only for Node-to-helper commands and fd 4 only for helper-to-Node events and terminal. Closing fd 3 cannot make libuv close fd 4. This would preserve the single managed helper, anonymous inherited handles, parent-loss cleanup, Job ownership, and absence of PID or named-object fallback, but it was not approved and is not the active topology.
2. **Keep one fd but prohibit write-half-close.** Normal termination sends an explicit frame and keeps the pipe open until terminal. This is smaller, but it weakens the approved terminal-verification guarantee whenever the channel reaches EOF and therefore is not recommended.
3. **Explicit named pipe or another Win32 carrier.** This introduces naming, DACL, connection authentication, race, packaging, and possibly ABI concerns. A single duplex named pipe also does not inherently solve half-close. This is the largest boundary change and is not recommended.

The then-proposed option 1 would have required an exact three-version fd3/fd4 preflight. That requirement was never approved and has been deleted. The active replacement preflight uses the current `process.execPath`, keeps one full-duplex fd3 open until terminal/helper close, and treats terminal-before-close ordering—not half-close survival—as the gate.

## Invariants retained for any redesign

- The Job is assigned before the target's first user instruction through the approved atomic process-creation design.
- Only the helper owns the non-inheritable Job handle; target inheritance remains exactly standard streams.
- No PID reopen, WMI, `taskkill`, process scan, direct-spawn, named-pipe, or other automatic fallback.
- Missing, duplicate, malformed, or out-of-order terminal evidence permanently fails the invocation; successful cleanup cannot turn failure into success.
- No global/default step, turn, tool, context, token, duration, CPU, memory, or process limit is imposed on Kimi, Pi, or any external CLI.
