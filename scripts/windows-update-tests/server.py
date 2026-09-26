"""Disposable BF origin for native updater tests. No GitHub or external fetches."""
import hashlib
import http.server
import json
import pathlib
import sys
import urllib.parse

root = pathlib.Path(sys.argv[1])
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        config = json.loads((root / "control.json").read_text(encoding="utf-8-sig"))
        with (root / "requests.log").open("a") as f:
            f.write(url.path + "\n")
        if url.path.startswith("/api/kiosk/") and config["reject_auth"]:
            self.send_response(401); self.end_headers(); return
        if "/download/" in url.path:
            name = url.path.rsplit("/", 1)[-1]
            artifact = root / (name + ".msi")
            if not artifact.is_file():
                self.send_response(404); self.end_headers(); return
            data = artifact.read_bytes()
        else:
            version = query.get("version", [config["version"]])[0]
            current = query.get("current", [""])[0]
            artifact = root / (version + ".msi")
            metadata = json.loads((root / (version + ".json")).read_text(encoding="utf-8-sig"))
            up_to_date = bool(current) and tuple(map(int, version.split("."))) <= tuple(map(int, current.split(".")))
            body = {"up_to_date": up_to_date}
            if not up_to_date:
                body["update"] = metadata
            if url.path.startswith("/api/kiosk/"):
                body["update_policy"] = {"server":"", "schedule":{"mode":"always", "windows":[], "timezone":"UTC"},
                    "firmware_channel":"stable", "firmware_target_version":None, "os_update_channel":"stable", "os_update_target_version":None}
            data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
(root / "port").write_text(str(server.server_port))
server.serve_forever()
