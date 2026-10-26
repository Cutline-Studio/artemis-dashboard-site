# Artemis Ops Terminal

A sandboxed shell inside the password-protected Artemis Dashboard, for agents and for
Latoya. It has two parts: (1) a command API and (2) usage measurement plus an audit log.
It sits behind the same login and session cookie as the rest of the dashboard.

## API
`POST /api/ops/exec`: session cookie required. Send `Content-Type: application/json`
and the header `X-Artemis-Ops: 1`. The header plus the SameSite=Strict cookie is the CSRF guard.

```json
{"command": "ls -la", "timeout": 5000, "run_id": "agent-run-42", "tokens_in": 812, "tokens_out": 64}
```
- Only `command` is required.
- `timeout` is in ms, from 100 to 30000 (default 5000).
- `run_id` (optional) groups an agent's commands in the audit log.
- `tokens_in` and `tokens_out` (optional) are LLM token counts reported by the caller. They are logged only when sent. The server never makes them up.

Response: HTTP 200 if the command ran (any exit code), 403 if blocked, 429 if rate-limited, 503 if the sandbox is unavailable.
```json
{"stdout":"…","stderr":"","exit_code":0,"duration_ms":11,"timed_out":false,"truncated":false,
 "blocked":null,"run_id":null,"stdout_bytes":114,"stderr_bytes":0,"cpu_user_ms":0,"cpu_sys_ms":0}
```

`GET /api/ops/usage?days=14` returns:
- per-day totals: commands, ran, failures, timeouts, blocked, avg_duration_ms, bytes_out, cpu_ms, runs, tokens;
- the 50 most recent audit entries;
- the live sandbox isolation status and limits.

Python client: `sdk/artemis_ops.py`. It uses only the standard library and reads the password from `ARTEMIS_DASHBOARD_PASSWORD`.
```python
from artemis_ops import OpsTerminal
t = OpsTerminal("https://admin.artemisstatistics.artemisai-bycutlineindustries.studio")
r = t.run("uname -a", timeout_ms=5000, run_id="my-agent-1")
tool = OpsTerminal.tool_spec()                       # JSON-schema tool definition
out = t.handle_tool_call({"command": "ls"}, run_id="my-agent-1")   # JSON string for the model
```

## How a command runs
1. `launch.js` starts as root, only so it can switch uids.
   - It spawns `server.js` as uid 1000 (`node`). The web server never runs as root.
   - It keeps one job: running the commands that the server sends over the IPC channel.
2. Policy check. The check runs on the server and again in the runner, in `ops/policy.js`.
   - **Deny-list, always on:**
     - metadata and wireserver IPs (169.254.x.x, 168.63.129.16);
     - managed-identity endpoints and variables;
     - `/proc/<pid>/environ|mem|…`, `/proc/1`, `/sys/kernel`;
     - fork bombs, `rm -rf /`, and `/dev/tcp` and raw devices;
     - network tools, interpreters, shells, package managers, privileged and system commands;
     - `find -exec`, tar command hooks, and PATH/LD_PRELOAD overrides.
   - **Allow-list, the default `OPS_POLICY`:**
     - each pipeline segment must start with a listed coreutils-style tool or a harmless shell keyword or builtin;
     - no `$(…)`, backticks, process substitution, path-qualified commands, or variables as commands;
     - `$((arithmetic))` is allowed.
3. Sandbox (`ops/sandbox.js`). Each run gets:
   - **A fresh temp dir.** It is created with mode 0700, owned by the sandbox uid, set as cwd and HOME, and deleted afterwards. Nothing persists between commands.
   - **A dedicated uid.** In the container this is `sandbox` (10001). It is not the uid of the server or the root launcher, so it can't read their `/proc/*/environ`, which holds the secrets.
   - **A scrubbed env.** Only PATH, HOME, TMPDIR, LANG, TERM and USER are set. PATH points to a private dir of symlinks to the allow-listed tools. `node` is not executable by the sandbox uid (it is mode 0750, owned root:node).
   - **rlimits through `prlimit`:**
     - 10 s CPU;
     - 256 MB address space;
     - 16 MB max file size;
     - 32 processes for the uid;
     - 64 file descriptors;
     - no core dumps.
   - **Namespaces, when the host allows unprivileged user namespaces.** The process gets `unshare --user --net --pid --mount --mount-proc --kill-child`:
     - no network at all (an empty net namespace with only `lo`);
     - its own PID 1, so the server's processes can't be seen;
     - everything is killed when the wrapper dies.

     The runner probes for this at startup. The UI and `/api/ops/usage` report what was actually achieved (`namespaces: net+pid+mount` or `none`).
   - **A hard timeout.** It sends SIGKILL to the whole process group. After every run, `kill -9 -1` runs as the sandbox uid to sweep up background jobs.
   - **Output caps:**
     - 64 KB each for stdout and stderr, then `truncated: true`;
     - if raw output passes 8 MB, the process group is killed.
   - **One command at a time** (a serial queue), with at most 4 queued requests.
   - **CPU time measured per command.** This comes from the sandbox shell's POSIX `times`, which the command itself could spoof in theory. `duration_ms` is wall-clock time measured by the server.
4. **Rate limits per session (in memory):** 20 per minute and 400 per day.

## Audit log and usage
- **What gets logged.** Every request is logged as one JSON object, including blocked, rate-limited and unavailable ones. The fields are:
  - `ts`, `ts_et` (America/New_York), `sid`, `run_id`;
  - `command` (credential-looking strings are redacted, max 500 chars), `timeout_ms`;
  - `status` (ok, failed, timeout, blocked, rate_limited or unavailable);
  - `exit_code`, `duration_ms`, `bytes_out`, `stdout_bytes`, `stderr_bytes`;
  - `cpu_user_ms`, `cpu_sys_ms`, `timed_out`, `truncated`;
  - `blocked` (the reason), `tokens_in`, `tokens_out`.

  `sid` is a SHA-256 hash of the session nonce, never the cookie.
- **Where it's stored.** It goes through the app's existing store: `ops-audit-YYYY-MM-DD.jsonl` in the same private blob container (via `BLOB_SAS_URL`), or in `data/` locally. It is kept for 30 days, with up to 5000 entries per day. Writes are debounced by 1.5 s and flushed on SIGTERM.
- **Stdout copy.** Each entry is also printed to stdout as `{"type":"ops_audit",…}`, so Container Apps console logs and Log Analytics keep a second copy.
- **UI.**
  - `/terminal` has the terminal, the live limits panel, KPIs (commands, failures, blocked and avg duration today), a per-day stacked bar chart, and the recent-commands audit table.
  - The main dashboard gets a compact copy of the usage panel.

## Known gaps (read before exposing this to anything but Latoya's own agents)
- **This is not a hard security boundary.** It is a uid sandbox plus rlimits, with namespaces only if the host allows them.
  - The commands share the container's kernel.
  - A kernel exploit or a sandbox-uid privilege escalation would reach the root launcher.
- **Azure Container Apps (Consumption) probably blocks unprivileged user namespaces.** If it does, the runner reports `namespaces: none`.
  - In that case there is **no kernel-level network block**. Only the policy stops network use: no network tools are in PATH, and interpreters and shells are denied.
  - A determined user could in theory find an allowed tool that opens a socket. The busybox applets on the allow-list don't, but this is not proven.
  - Managed identity: the app has a user-assigned identity. Its `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` are scrubbed from the sandbox env and can't be read from `/proc` by the sandbox uid, so tokens can't be minted without the header.
- **The deny-list is a guard rail, not the boundary.** `OPS_POLICY=denylist` mode is much weaker: any command not on the deny-list runs.
- **The CPU and memory limits are rlimits, not cgroup limits.** Address space is not the same as RSS. The container's own 0.25 vCPU / 0.5 GiB still caps the total.
- **Rate limits and the revoked-session list are in memory.** They reset when the replica restarts. Max replicas is 1, so this is consistent.
- **Each audit day is rewritten in full.** It is a block blob, so every flush rewrites the day's file (max about 2–3 MB at the 5000-entry cap). An Append Blob would be cheaper, but it needs the SAS to have `a` (add) permission, which hasn't been checked.
- **Local testing used util-linux 2.41 on Debian.** The Alpine image (busybox tools, util-linux-misc) is **not built or tested yet**.

## What real isolation would need later
- **Azure Container Apps dynamic sessions (best fit on Azure):**
  - Hyper-V isolated sandboxes, with network egress control available.
  - The dashboard would call the session pool management endpoint instead of running commands itself, so `server.js` would keep the same API and logging.
  - A *Shell/Python code-interpreter* pool is billed per allocated session-hour. A third-party source quotes about $0.03 per session-hour (**estimate**; Microsoft's page currently shows no price).
  - A *custom-container* pool runs on Dedicated E16 instances and costs far more (**estimate**: on the order of dollars per hour while a node is allocated).
- **A separate ACA Job per command.** This gives strong isolation, but each run takes seconds of cold start and is billed per vCPU-second.
- **gVisor (`runsc`) or Firecracker or Kata microVMs** on a VM or AKS node pool you control. These need nested virtualization or a custom runtime, which ACA Consumption doesn't offer.
- **A network policy** (an NSG or egress firewall on a dedicated subnet) as a second layer.

## Possible next steps (out of scope for now)
These come from the reference notes Latoya sent:
- Docker-in-container per-command sandboxes;
- Kubernetes;
- Prometheus and Grafana for real-time telemetry;
- LiteStream/SQLite for persistence;
- a LangChain tool wrapper (the SDK's `tool_spec()` and `handle_tool_call()` already cover the function-calling glue);
- load and stress tests.
