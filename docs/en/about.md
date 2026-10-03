# About JSHookMCP

JSHookMCP is an open-source TypeScript project that lets AI agents operate on the real, running JavaScript ecosystem. It packages browser automation, CDP debugging, network capture, JS hooking and deobfuscation, plus cross-platform native FFI, into a standard MCP server that any MCP client can run with a single npx command. The project is initiated and maintained by vmoranv and is released under AGPL-3.0.

## Positioning

JSHookMCP follows a "tools first, minimal privilege" philosophy. It ships no built-in signature library or known-bad samples; it provides matching engines and informational output so users supply the targets they want to analyze. That design serves legitimate research, auditing of assets you own, and authorized security testing. The project is also auditable: every capability domain declares its prerequisites and activation conditions in a manifest, and the runtime loads them by profile so the whole tool catalog is never dumped into context at once.

## Maintenance & Community

vmoranv maintains the source and tracks issues on GitHub (github.com/vmoranv/jshookmcp). Contributions follow conventional commits and a pre-commit quality gate (drift guards, lint, type checks, tests). The docs site itself is a project artifact, built with VitePress and published through GitHub Pages.

## Usage Boundaries

JSHookMCP is for authorized contexts: reverse engineering your own applications, open-source research, CTFs, and compliant penetration testing. It does not provide tooling for attacking third-party online services; users are responsible for abiding by target systems' terms of service and applicable law.
