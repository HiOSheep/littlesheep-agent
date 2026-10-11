# Windows Shell Sandbox PoC

This directory contains a test-only launcher for Microsoft's experimental `Experimental_CreateProcessInSandbox` API. It is not wired into `exec`, `ToolExecutionService`, Main policy, or any production automatic-approval path.

## Run on Windows

From the repository root, run:

```powershell
pnpm run poc:windows-sandbox
```

The runner creates a disposable fixture under the current user's `%TEMP%`, starts payloads only through `processmodel.dll`, records the probe report there, and removes test AppContainer profiles. If the API, schema, workspace pin, Job Object assignment, or sandbox launch fails, the runner exits with an error. It does not invoke a host-shell fallback.

The test host needs Windows PowerShell 5.1, Node.js, Git, and the repository's installed Node dependencies. The sandbox's read-only roots are the discovered PowerShell, Node, Git, Windows runtime, and optional shared PowerShell module directories; the launcher rejects volume-root read grants. Only the generated workspace root is configured read/write. The network probe uses a local listening socket and a TCP connect to `1.1.1.1:443`; the host-side connection must succeed before network confinement can be marked verified.

## What it proves

The runner probes workspace reads/writes, host fixture reads/writes, path traversal, a directory junction, a file symbolic link when the host permits creating one, a write handle to protected LS source, PowerShell-to-Node inheritance, Git basics, network attempts from PowerShell and Node, Job Object timeout cleanup, forced launcher termination, and a directory rename while the workspace handle is pinned. The `SandboxCapabilitySnapshot` and `assessSandboxReadiness` output are experimental evidence only. They are never consumed by the application.

See [the result and limitations](../../docs/reference/windows-shell-sandbox-poc.md) for the current host's evidence, compatibility notes, and P3-B prerequisites.

## Implementation notes

- `SandboxProcessApi.cs` dynamically resolves the OS export from System32, builds a sanitized child environment, pins the workspace directory without delete sharing, creates the process suspended, assigns a kill-on-close Job Object, then resumes it.
- `BaseContainerSpecification.fbs` documents the field-order subset used by the FlatBuffers builder. It is tied to the published experimental schema version `0.1.0`, not a stable Windows SDK header.
- `flatbuffers` is a development dependency used only to encode the documented `SBOX` buffer.
- This launch path is experimental and host-build-dependent. A present DLL export is not sufficient; only the executed positive and negative probes contribute evidence.
