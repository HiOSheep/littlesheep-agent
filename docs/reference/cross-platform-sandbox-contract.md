# Cross-platform Sandbox Runtime — P3-0 contract

This is the **capability contract only**. It adds no OS sandbox, tool auto-approval, permissions, persistence, runner coordinator, or fallback executor.

## Boundary ownership

- **Main / trusted host** owns the active run identity, canonical workspace path, permission snapshot, and backend capability probe. Renderer, model, tool input, and plugins cannot attest capabilities or substitute the scoped snapshot.
- **Permission V2** alone resolves `allow / approval / deny / unavailable` and explicit user escalation. `assessSandboxReadiness` is not an authorization decision.
- **ToolExecutionService** remains the single agent tool lifecycle. Native `read/write/edit` guards enforce file operations at their actual file boundary. `exec` will use a future platform backend that enforces restrictions on the child process and descendants.
- **Backend** owns OS-specific isolation, process lifetime, workspace mount/access, and network egress. No backend may claim `verified` from static platform detection alone.

## Capability matrix

| Operation | Verified guarantees required for eligible auto-execution |
| --- | --- |
| Native file read | `native-file-read-confinement` |
| Native file write/edit | `native-file-write-confinement` |
| Shell (`exec`) | `process-filesystem-confinement`, `process-network-confinement`, `child-process-containment`, `process-tree-termination` |

`verified` means the actual trusted backend has demonstrated *all* guarantees required for this operation, on the current platform, workspace, run, and runtime configuration. `partial` or `unavailable` is **not** sufficient. Unknown evidence is unavailable. A data object with `status: 'verified'` is not a security token or proof on its own.

`SandboxCapabilitySnapshot.scope` is tied to a Main-canonicalized workspace root and one run. Changing the workspace, restarting without re-probing, or resuming with different authority requires fresh trusted assessment. The equality check is deliberately string-exact: canonicalization and real filesystem enforcement belong at the host boundary, not this shared type package.

## Platform backends (future)

- **Windows**: experimentally assess restricted identities/AppContainer, explicit ACL grants, process-tree management via Job Objects, PowerShell/Node/Git compatibility, network confinement, and junction/reparse-point handling. Job Objects alone are not a filesystem sandbox.
- **Linux**: experimentally assess namespace sandboxing (e.g. Bubblewrap), filesystem restrictions (possibly Landlock), seccomp and network namespaces on the deployed kernel. Detect missing unprivileged namespace support and refuse automatic execution where guarantees are incomplete.
- **macOS**: experimentally assess supported App Sandbox and signed helper approaches, user-granted directory access and child-process behavior. Do not rely on undocumented sandbox profiles as a production guarantee.

A platform may have partial support; do not present identical guarantees where the underlying protection differs. The backend must prove its claimed enforcement in negative tests, not only that ordinary commands can execute.

## Non-negotiable failure behavior

1. Missing or stale capability evidence, backend startup failure, path or run mismatch, network isolation failure, escaped child, or incomplete process cleanup => **no sandboxed auto-execution**.
2. Never silently fall back to unsandboxed host shell. If policy permits, a separate explicit approval path may request an elevated/unsandboxed execution, with its actual risk described accurately. Approval never silently upgrades the original sandbox guarantee.
3. Immutable run authority and checkpoint recovery rules remain separate; recheck the current session authority before any resumed effect. No replay of effects with unknown settlement.
4. Only Main/host-owned enforcement may generate positive capability evidence. TypeScript `readonly` and this pure evaluator are not OS security primitives.

## P3-A acceptance gates

- A demonstrably restricted shell and descendant process cannot read/write outside allowed roots or make unauthorized network connections, including via subprocesses.
- Timeout, abort, crash, and failed sandbox initialization do not leave a child running outside isolation or trigger an unsandboxed retry.
- Process launches and tool results continue through existing run, approval, audit and durable-effect paths.
- Real per-platform negative tests are required before wiring any capability as `verified`.
