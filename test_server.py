#!/usr/bin/env python3
"""Local development server for the Yodeck RSS HTML app.

Run: python test_server.py
Open: http://127.0.0.1:8080/?test=1

The /proxy endpoint exists only to bypass browser CORS while developing locally.
The server binds to localhost only.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from pathlib import Path
import os

HOST = "127.0.0.1"
PORT = 8080
ROOT = Path(__file__).resolve().parent

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/proxy":
            return super().do_GET()

        target = parse_qs(parsed.query).get("url", [""])[0]
        target_parsed = urlparse(target)
        if target_parsed.scheme not in {"http", "https"} or not target_parsed.netloc:
            self.send_error(400, "Invalid proxy URL")
            return

        req = Request(
            target,
            headers={
                "User-Agent": "Mozilla/5.0 Yodeck-RSS-Local-Test/1.0",
                "Accept": "application/rss+xml, application/xml, text/xml, text/html, */*",
            },
        )
        try:
            with urlopen(req, timeout=20) as response:
                data = response.read()
                self.send_response(response.status)
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as exc:
            self.send_error(exc.code, f"Upstream HTTP error: {exc.reason}")
        except URLError as exc:
            self.send_error(502, f"Upstream connection failed: {exc.reason}")
        except Exception as exc:
            self.send_error(502, f"Proxy failed: {exc}")

if __name__ == "__main__":
    os.chdir(ROOT)
    print(f"Yodeck RSS local test server: http://{HOST}:{PORT}/?test=1")
    print("Stop with Ctrl+C")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
