# Strategos M0 spike scripts

Node 24 runs the `.ts` files directly. Install once: `npm i` in this folder (node-pty 1.1.0 ships Windows prebuilds; no build tools needed).
All output goes to `spike/out/` (git-ignored). Nothing here writes to `~/.claude`. Never use `--dangerously-skip-permissions`.

| Script | Run | Purpose |
|---|---|---|
| `s0.ts` | `node s0.ts` | S0: spawn cmd.exe through node-pty, echo, exit 0 |
| `mkrepo.ts` | `node mkrepo.ts [dir]` | Create the sandbox repo `C:\dev\strategos-sandbox` with deny rules in `.claude/settings.local.json` |
| `mksettings.ts` | `node mksettings.ts --id <id> [--port 47801] [--no-agentview]` | Write `out/run/<id>.settings.json` (plan section 5). Also `import { writeSettings }` |
| `tap.mjs` | used as the statusLine command: `node tap.mjs <id>` | Prints chained (`STRATEGOS_CHAIN_STATUSLINE`) or fallback line first, then POSTs to `/statusline/<id>` (250 ms timeout) |
| `hooklog.ts` | `node hooklog.ts` | Hook server on 127.0.0.1:47801. Stdin or `POST /ctl {"cmd":"allow"}` : `allow`, `deny <msg>` (`msg` field), `always <i>` (`arg`), `answer <json>` (`arg`), `none`, `drop`, `list`. Acts on the oldest held request. Logs to `out/hooklog.log`, bodies to `out/hooks/`, status lines to `out/statusline/` |
| `hostpty.ts` | `node hostpty.ts [--cwd D] [--prompt "text"] [--resume ID] [--conpty-dll] [--no-agentview] [--name N]` | Spawn the real claude.exe in a pty, page at http://127.0.0.1:47800/. Headless control: `POST /input {"data":"..."}`, `GET /screen`, `GET /info`. Raw output in `out/pty-<id>.log`. `--exe <path> [--exe-args "a b"]` substitutes another program (no settings injected), used for smoke tests |
| `hash-claude-dir.ts` | `node hash-claude-dir.ts before` / `after` | Read-only SHA-256 of `~/.claude/settings*.json` plus listing, to `out/claude-dir-<label>.json` |
| `agents-cost.ts` | `node agents-cost.ts` | S13 timings (runs `claude agents --json` 10x; read-only) |

Typical S1 run: terminal A `node hooklog.ts`; terminal B `node hostpty.ts`; open the page; compare `hash-claude-dir.ts` before/after.
Note: in hooklog, Node fires `req 'close'` as soon as the body is read; a client disconnect shows as `res 'close' (finished=false)`.
