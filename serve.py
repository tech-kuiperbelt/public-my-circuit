#!/usr/bin/env python3
"""开发用静态服务器：禁用浏览器缓存，避免 ES modules 新旧版本混用。

用法：python3 serve.py [端口]   默认 8000，只绑定 127.0.0.1。
"""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler)
    except OSError as err:
        print(f"serve.py: 端口 {port} 不可用（可能已有服务在运行）：{err}", file=sys.stderr)
        return 1
    print(f"serving {root} at http://127.0.0.1:{port}/ (no-store)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
