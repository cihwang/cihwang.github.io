"""개발용 정적 서버.

- 브라우저가 예전 wheel.js·styles.css를 캐시에서 쓰지 않게 매 응답에 no-store를 붙인다.
- 글(posts/*.md)·site.json·build.js가 바뀌었으면 posts.json을 요청받을 때 `node build.js --drafts`로 다시 만든다.
  그래서 글을 저장하고 브라우저를 새로고침만 하면 반영된다(초안 포함).
  빌드가 실패하면(카테고리 오타 등) 이 창에 어느 파일이 왜 틀렸는지 나오고, 화면에는 '불러오지 못했어요'가 뜬다.

실행: python serve.py  →  http://127.0.0.1:5173/
"""
import subprocess
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 5173
ROOT = Path(__file__).parent
OUT = ROOT / "posts.json"
_build_lock = threading.Lock()


def _latest_source_mtime() -> float:
    sources = [ROOT / "site.json", ROOT / "build.js", ROOT / "markdown.js", *ROOT.joinpath("posts").rglob("*.md")]
    return max(p.stat().st_mtime for p in sources if p.exists())


def rebuild_if_stale() -> bool:
    """posts.json이 글보다 오래됐으면 다시 만든다. 성공하면(또는 이미 최신이면) True."""
    with _build_lock:
        if OUT.exists() and OUT.stat().st_mtime >= _latest_source_mtime():
            return True
        result = subprocess.run(
            ["node", "build.js", "--drafts"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8"
        )
        print((result.stdout + result.stderr).strip())
        return result.returncode == 0


class DevHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/posts.json" and not rebuild_if_stale():
            self.send_error(500, "posts.json build failed - see the serve.py window")
            return
        super().do_GET()


if __name__ == "__main__":
    # 에디터 미리보기가 쓰는 vendor/highlight.js는 git에 없으니 서버를 켜기 전에 만든다.
    vendor = subprocess.run(["node", "tools/vendor.js"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if vendor.returncode != 0:
        print("tools/vendor.js 실패:\n" + (vendor.stdout + vendor.stderr).strip())
        raise SystemExit(1)
    handler = partial(DevHandler, directory=str(ROOT))
    print(f"http://127.0.0.1:{PORT}/")
    ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
