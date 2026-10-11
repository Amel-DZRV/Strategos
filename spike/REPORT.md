# Strategos M0 spike report

| Order | Check | Result | Notes |
|---|---|---|---|
| 0 | S0 node-pty installs and spawns a shell | PASS (Windows) | `node-pty@1.1.0` installed with no build tools (npm skipped install scripts; the package's bundled `prebuilds/win32-x64` loaded). `spike/s0.ts` spawned cmd.exe, echoed, exit code 0. Mac not yet run. `@lydell/node-pty` not needed |
| 1 | S1 --settings injects http hooks | pending | |
| 2 | S2 Hold a PermissionRequest | pending | |
| 3 | S3 ConPTY renders the TUI | pending | |
| 4 | S9 Answer AskUserQuestion | pending | |
| 5 | S11 Identity churn | pending | |
| 6 | S12 Interrupts | pending | |
| 7 | S18 Agent View escape | pending | |
| 8 | S5 Status line through --settings | pending | tap alone measured ~90 ms above bare node start (bare node ~165-240 ms on this machine): check the 300 ms budget for real |
| 9 | S4 Reply through the pty | pending | |
| 10 | S10 Trust in new worktrees | pending | |
| 11 | S16 Cache TTL | pending | |
| 12 | S17 Added context after a tool | pending | |
| 13 | S14 Resume identity | pending | |
| 14 | S13 Reconciler and sampler cost | pending | |
| 15 | S6 Chat from the transcript tail | pending | |
| 16 | S15 Toast actions | pending | |
| 17 | S8 Option E | pending | |
| 18 | S7 Cross-mode resume | pending | |
