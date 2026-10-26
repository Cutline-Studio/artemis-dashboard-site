"""Artemis Ops Terminal client: call the sandboxed shell as an agent tool.

Standard library only. The dashboard password is read from the environment
(ARTEMIS_DASHBOARD_PASSWORD) and never printed or logged.

    from artemis_ops import OpsTerminal
    term = OpsTerminal("https://admin.artemisstatistics.artemisai-bycutlineindustries.studio")
    r = term.run("uname -a", timeout_ms=5000)
    print(r.exit_code, r.stdout)

    # As an LLM tool / function call:
    spec = OpsTerminal.tool_spec()                  # JSON-schema tool definition
    result_json = term.handle_tool_call({"command": "ls -la", "timeout": 5000})
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any, Optional

__all__ = ["OpsTerminal", "OpsResult", "OpsError"]


class OpsError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


@dataclass
class OpsResult:
    stdout: str
    stderr: str
    exit_code: Optional[int]
    duration_ms: int
    timed_out: bool
    truncated: bool
    blocked: Optional[str] = None
    http_status: int = 200
    stdout_bytes: int = 0             # raw bytes produced (before the output cap)
    stderr_bytes: int = 0
    cpu_user_ms: Optional[int] = None  # CPU time of the command's processes (sandbox shell `times`)
    cpu_sys_ms: Optional[int] = None
    run_id: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.blocked is None and not self.timed_out and self.exit_code == 0

    def to_dict(self) -> dict:
        return asdict(self)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # keep 303 from /login so we can read Set-Cookie
        return None


class OpsTerminal:
    TOOL_NAME = "artemis_shell"

    def __init__(self, base_url: str, password: Optional[str] = None, http_timeout: float = 60.0):
        self.base = base_url.rstrip("/")
        self._password = password if password is not None else os.environ.get("ARTEMIS_DASHBOARD_PASSWORD", "")
        self._timeout = http_timeout
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self._jar), _NoRedirect)
        self._logged_in = False

    # -- auth -----------------------------------------------------------------
    def login(self) -> None:
        if not self._password:
            raise OpsError(0, "no password: set ARTEMIS_DASHBOARD_PASSWORD")
        data = urllib.parse.urlencode({"password": self._password}).encode()
        req = urllib.request.Request(self.base + "/login", data=data, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            resp = self._opener.open(req, timeout=self._timeout)
            status = resp.status
        except urllib.error.HTTPError as e:
            status = e.code
            # 303 arrives as HTTPError because redirects are disabled; cookies were still captured.
            self._jar.extract_cookies(e, req)
        if status not in (302, 303) or not any(c.name == "artemis_sess" for c in self._jar):
            raise OpsError(status, "login failed (wrong password or rate limited)")
        self._logged_in = True

    # -- calls ----------------------------------------------------------------
    def _request(self, method: str, path: str, body: Optional[dict] = None) -> tuple[int, Any]:
        if not self._logged_in:
            self.login()
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json", "X-Artemis-Ops": "1"} if body is not None else {}
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            resp = self._opener.open(req, timeout=self._timeout)
            return resp.status, json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read() or b"null")
            except ValueError:
                payload = {"error": e.reason}
            if e.code == 401 and self._logged_in:  # session expired: log in once more
                self._logged_in = False
                return self._request(method, path, body)
            return e.code, payload

    def run(self, command: str, timeout_ms: int = 5000, run_id: Optional[str] = None,
            tokens_in: Optional[int] = None, tokens_out: Optional[int] = None) -> OpsResult:
        """Run one command in a fresh sandbox. Blocked/rate-limited commands return a result
        with `blocked` set (HTTP 403/429); other HTTP errors raise OpsError.
        run_id groups an agent's commands in the audit log; tokens_in/out are optional,
        caller-reported LLM token counts (only send real numbers)."""
        body: dict = {"command": command, "timeout": int(timeout_ms)}
        if run_id:
            body["run_id"] = run_id
        if tokens_in is not None:
            body["tokens_in"] = int(tokens_in)
        if tokens_out is not None:
            body["tokens_out"] = int(tokens_out)
        status, p = self._request("POST", "/api/ops/exec", body)
        if status in (200, 403, 429) and isinstance(p, dict) and "stdout" in p:
            return OpsResult(p.get("stdout", ""), p.get("stderr", ""), p.get("exit_code"), int(p.get("duration_ms") or 0),
                             bool(p.get("timed_out")), bool(p.get("truncated")), p.get("blocked"), status,
                             int(p.get("stdout_bytes") or 0), int(p.get("stderr_bytes") or 0),
                             p.get("cpu_user_ms"), p.get("cpu_sys_ms"), p.get("run_id"))
        raise OpsError(status, (p or {}).get("error", "unexpected response") if isinstance(p, dict) else "unexpected response")

    def usage(self, days: int = 14) -> dict:
        status, p = self._request("GET", f"/api/ops/usage?days={int(days)}")
        if status != 200:
            raise OpsError(status, "usage failed")
        return p

    # -- LLM tool glue ----------------------------------------------------------
    @classmethod
    def tool_spec(cls) -> dict:
        """Tool definition in the common JSON-schema function format (OpenAI / Anthropic style)."""
        return {
            "name": cls.TOOL_NAME,
            "description": ("Run ONE shell command in a fresh, isolated, throwaway Linux sandbox (no network, "
                            "empty temp dir, unprivileged user, allow-listed coreutils only). Files do not persist "
                            "between calls. Returns stdout, stderr, exit_code, duration_ms, timed_out, truncated, blocked."),
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command, max 2000 chars"},
                    "timeout": {"type": "integer", "description": "Timeout in ms (100-30000, default 5000)"},
                },
                "required": ["command"],
            },
        }

    def handle_tool_call(self, args: dict, run_id: Optional[str] = None) -> str:
        """Execute a tool call and return a JSON string for the model."""
        try:
            r = self.run(str(args.get("command", "")), int(args.get("timeout", 5000)), run_id=run_id)
            return json.dumps(r.to_dict())
        except OpsError as e:
            return json.dumps({"error": str(e)})


if __name__ == "__main__":  # tiny CLI: python artemis_ops.py URL "command"
    import sys
    if len(sys.argv) < 3:
        sys.exit("usage: ARTEMIS_DASHBOARD_PASSWORD=... python artemis_ops.py BASE_URL 'command' [timeout_ms]")
    t = OpsTerminal(sys.argv[1])
    res = t.run(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 5000)
    print(json.dumps(res.to_dict(), indent=2))
