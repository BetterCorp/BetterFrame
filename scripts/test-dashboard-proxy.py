#!/usr/bin/env python3
"""Exercise the production proxy's dashboard authentication using local fixtures."""
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]


class DashboardProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        nginx = os.environ.get("BF_TEST_NGINX") or shutil.which("nginx")
        if not nginx:
            raise RuntimeError("Install nginx or set BF_TEST_NGINX to run proxy integration tests")
        cls.temp = tempfile.TemporaryDirectory(prefix="bf-dashboard-proxy-")
        cls.servers = []

        def fixture(kind):
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_GET(self):
                    cookie = self.headers.get("Cookie", "")
                    status, headers = 200, {}
                    if kind == "admin":
                        if cookie == "admin-denied":
                            status = 403
                        elif cookie in ("admin-a", "admin-b"):
                            headers["X-BetterFrame-Tenant"] = cookie[-1]
                        else:
                            status = 401
                    elif kind == "api":
                        if cookie in ("kiosk-a", "display-a"):
                            headers = {"X-BetterFrame-Tenant": "a", "X-BetterFrame-Kiosk-Id": "kiosk-a",
                                       "Set-Cookie": "dashboard-session=test; Path=/; HttpOnly"}
                            if cookie == "display-a":
                                headers["X-BetterFrame-Display-Scope"] = "server-signed-scope"
                            original = self.headers.get("X-Original-URI", "")
                            if original.startswith("/private") or ("socket.io" in original and cookie != "display-a"):
                                status = 403
                        else:
                            status = 401
                    body = json.dumps({"path": self.path, "tenant": self.headers.get("X-BetterFrame-Tenant"),
                                       "upgrade": self.headers.get("Upgrade"),
                                       "scope": self.headers.get("X-BetterFrame-Display-Scope"),
                                       "kiosk": self.headers.get("X-BetterFrame-Kiosk-Id")}).encode()
                    self.send_response(status)
                    for key, value in headers.items():
                        self.send_header(key, value)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            cls.servers.append(server)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            return server.server_port

        admin, api, runtime = fixture("admin"), fixture("api"), fixture("runtime")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        config = (ROOT / "deploy/angie/betterframe.docker.conf").read_text()
        for old, port in [("server:18080", admin), ("server:18081", api), ("server:18082", runtime), ("nodered:1880", runtime)]:
            config = config.replace(old, f"127.0.0.1:{port}")
        config = config.replace("listen 80", f"listen 127.0.0.1:{cls.port}")
        prefix = Path(cls.temp.name)
        conf = prefix / "nginx.conf"
        conf.write_text(f"daemon off; master_process off; pid {prefix}/pid; error_log {prefix}/error.log;\n"
                        f"events {{}}\nhttp {{ access_log off; client_body_temp_path {prefix}/body; proxy_temp_path {prefix}/proxy; fastcgi_temp_path {prefix}/fastcgi; uwsgi_temp_path {prefix}/uwsgi; scgi_temp_path {prefix}/scgi;\n"
                        + config + "\n}")
        subprocess.run([nginx, "-t", "-p", str(prefix), "-c", str(conf)], check=True)
        cls.process = subprocess.Popen([nginx, "-p", str(prefix), "-c", str(conf)], stderr=subprocess.PIPE)
        for _ in range(100):
            if cls.process.poll() is not None:
                raise RuntimeError(cls.process.stderr.read().decode())
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=.1):
                    return
            except OSError:
                time.sleep(.05)
        raise RuntimeError("proxy did not start")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.process.stderr.close()
        for server in cls.servers:
            server.shutdown()
            server.server_close()
        cls.temp.cleanup()

    def request(self, path, cookie=None, extra=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": "frame-eu.betterportal.net", **(extra or {})}
        if cookie:
            headers["Cookie"] = cookie
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        body = response.read()
        result = response.status, dict(response.getheaders()), body
        connection.close()
        return result

    def test_anonymous_and_forged_tenant_cannot_read_dashboard_surfaces(self):
        for path in ["/dashboard/page1", "/custom/page1", "/dash/page-id", "/dashboard/assets/app.js", "/dashboard/_setup", "/dashboard/socket.io/?transport=polling"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 401)
                self.assertEqual(self.request(path, extra={"X-BetterFrame-Tenant": "a", "X-BetterFrame-Dashboard-Token": "forged"})[0], 401)
        self.assertEqual(self.request("/dashboard/socket.io/", extra={"Upgrade": "websocket", "Connection": "upgrade"})[0], 401)
        self.assertEqual(self.request("/nrdp/")[0], 401)

    def test_admin_context_overwrites_caller_tenant_and_supports_socket_upgrades(self):
        for tenant in ["a", "b"]:
            status, _, body = self.request("/dashboard/page1", f"admin-{tenant}", {"X-BetterFrame-Tenant": "forged"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["tenant"], tenant)
        status, _, body = self.request("/dashboard/socket.io/", "admin-a", {"Upgrade": "websocket", "Connection": "upgrade"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["upgrade"], "websocket")
        self.assertEqual(self.request("/dashboard/page1", "admin-denied")[0], 403)

    def test_kiosk_fallback_preserves_original_path_and_cookie(self):
        status, headers, body = self.request("/dashboard/page1", "kiosk-a")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["tenant"], "a")
        self.assertEqual(json.loads(body)["kiosk"], "kiosk-a")
        self.assertIn("Set-Cookie", headers)
        self.assertEqual(self.request("/private/page1", "kiosk-a")[0], 403)
        self.assertEqual(self.request("/dashboard/socket.io/", "kiosk-a")[0], 403)

    def test_display_scope_is_forwarded_only_from_auth_response(self):
        for path in ["/dashboard/_setup", "/dashboard/socket.io/?transport=polling"]:
            status, _, body = self.request(path, "display-a", {"X-BetterFrame-Display-Scope": "forged"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["scope"], "server-signed-scope")
        status, _, body = self.request("/dashboard/socket.io/", "display-a", {"Upgrade": "websocket", "Connection": "upgrade", "X-BetterFrame-Display-Scope": "forged"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["scope"], "server-signed-scope")
        self.assertEqual(json.loads(body)["upgrade"], "websocket")
        _, _, body = self.request("/dashboard/page1", "admin-a", {"X-BetterFrame-Display-Scope": "forged"})
        self.assertIsNone(json.loads(body)["scope"])

    def test_desktop_enrollment_check_remains_available_with_credentials(self):
        self.assertEqual(self.request("/api/kiosk/_check")[0], 401)
        self.assertEqual(self.request("/api/kiosk/_check", "kiosk-a")[0], 200)

    def test_public_webhooks_have_no_trusted_tenant_and_internal_checks_are_private(self):
        status, _, body = self.request("/in/public/a/webhook", extra={"X-BetterFrame-Tenant": "forged"})
        self.assertEqual(status, 200)
        self.assertIsNone(json.loads(body)["tenant"])
        for path in ["/_bf_dashboard_check", "/_bf_dashboard_kiosk_check", "/api/admin/_check"]:
            self.assertEqual(self.request(path)[0], 404)


if __name__ == "__main__":
    unittest.main()
