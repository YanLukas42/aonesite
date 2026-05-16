#!/usr/bin/env python3
"""
AoneSite — Servidor local de desenvolvimento
Serve os arquivos com os headers COOP/COEP necessários para o FFmpeg.wasm.

Uso:
    python3 server.py

Acesse: http://localhost:8080
"""

import http.server
import socketserver
import os

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    """Handler que injeta os headers de isolamento cross-origin."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Necessário para SharedArrayBuffer (FFmpeg multi-thread)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        # Cache amigável para development
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Formata o log de forma mais legível
        print(f"  → {self.address_string()}  {fmt % args}")


def main():
    os.chdir(DIRECTORY)
    with socketserver.TCPServer(("", PORT), CORSHandler) as httpd:
        print(f"\n  🚀  AoneSite rodando em  http://localhost:{PORT}\n")
        print("  Pressione Ctrl+C para encerrar.\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Servidor encerrado.\n")


if __name__ == "__main__":
    main()
