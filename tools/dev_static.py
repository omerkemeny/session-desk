"""Preview server: serves web/ on [::1]:8798 (--port 0 picks a free port and prints it) with the same page shell as server.py, no token, so the page runs in demo mode."""
import argparse
import os
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SHELL = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>'
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


class Handler(SimpleHTTPRequestHandler):
    """Wrapped page at /, an empty page at /__blank for test baselines, plain static files below, nothing cached."""

    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css"}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/favicon.ico":
            self.send_response(204)
            return self.end_headers()
        if path == "/__blank":
            return self.page(b"<!doctype html><title>blank</title>")
        if path == "/":
            with open(os.path.join(self.directory, "index.html"), "rb") as fh:
                return self.page(SHELL.encode() + fh.read())
        return super().do_GET()

    def page(self, data):
        """Send one HTML document."""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=ROOT, help="folder holding index.html (default: web/)")
    ap.add_argument("--port", type=int, default=8798)
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    httpd = Server(("::1", a.port), lambda *x: Handler(*x, directory=root))
    print(f"serving {root} at http://[::1]:{httpd.server_address[1]}/", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
