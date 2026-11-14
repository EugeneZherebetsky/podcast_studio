"""Offline D2 verification. Run from the repository root after building the bundle."""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from typing import Any

root = Path(__file__).resolve().parent.parent
bundle = root / "dist-desktop"
base = Path(tempfile.mkdtemp(prefix="podcast-d2-"))
resources = base / "resources"
shutil.copytree(bundle, resources)
offline = base / "offline.mjs"
shutil.copyfile(root / "apps/server/test/desktop-offline.mjs", offline)
node = resources / "node" / ("node.exe" if os.name == "nt" else "node")
ffmpeg = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
ffprobe = os.environ.get("FFPROBE_PATH") or shutil.which("ffprobe")
if not ffmpeg or not ffprobe:
    raise RuntimeError("Set FFMPEG_PATH and FFPROBE_PATH to executable files")
subprocess.run([str(node), str(root / "scripts/build-desktop.mjs"), "--test-output", str(resources / "server/fake-test.mjs")], cwd=root, check=True)

def run_server(fake):
    label = "fake" if fake else "production"
    home, cwd, data = (base / (label + suffix) for suffix in ("-home", "-cwd", "-data"))
    home.mkdir()
    cwd.mkdir()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {"PATH": os.defpath, "HOST": "127.0.0.1", "PORT": str(port),
           "PODCAST_STUDIO_HOME": str(home), "PODCAST_STUDIO_RESOURCES": str(resources),
           "DATA_DIR": str(data), "PROFILE": "local", "TTS_VOICE_NATIVE_HOST": "fake",
           "FFMPEG_PATH": str(Path(str(ffmpeg)).resolve()), "FFPROBE_PATH": str(Path(str(ffprobe)).resolve())}
    if os.name == "nt":
        env["SystemRoot"] = os.environ["SystemRoot"]
    command = [str(node), "--import", offline.as_uri(),
               str(resources / "server" / ("fake-test.mjs" if fake else "server.mjs"))]
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    origin = f"http://127.0.0.1:{port}"
    def request(route, payload=None):
        req = urllib.request.Request(origin + route, data=json.dumps(payload).encode() if payload is not None else None,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read()
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError("server exited before listening")
            try:
                status, html = request("/")
                break
            except urllib.error.URLError:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not listen")
        assert status == 200 and b"Podcast Studio" in html
        match = re.search(rb'src="([^"]+\.js)"', html)
        assert match is not None
        asset = match.group(1).decode()
        assert request(asset)[0] == 200
        with sqlite3.connect(data / "app.db") as db:
            migrations = db.execute("SELECT COUNT(*) FROM __drizzle_migrations").fetchone()[0]
            assert migrations > 0
        try:
            request("/api/health")
            raise AssertionError("Unexpected health semantics")
        except urllib.error.HTTPError as error:
            assert error.code == 503
        print(f"{label}: UI and JS 200, migrations {migrations}, health 503")
        if fake:
            status, raw = request("/api/jobs", {"title": "Bees", "brief": "", "mode": "standard", "lang": "en", "minutes": 1, "review": False})
            assert status == 201
            job_id = json.loads(raw)["id"]
            job: dict[str, Any] = {"status": "pending"}
            for _ in range(600):
                job = json.loads(request("/api/jobs/" + job_id)[1])
                if job["status"] in ("succeeded", "failed", "cancelled"):
                    break
                time.sleep(0.2)
            assert job["status"] == "succeeded", job
            assert {stage["stage"] for stage in job["stages"]} == {"plan", "search", "extract", "notes", "script", "review", "tts", "assemble", "publish"}
            assert all(stage["status"] == "done" for stage in job["stages"])
            assert list((data / "episodes").glob("*/episode.json"))
            assert list((data / "episodes").glob("*/audio.m4a"))
            print(f"fake: job {job_id} succeeded, {len(job['stages'])} stages done, episode and audio published")
    finally:
        if process.poll() is None:
            process.terminate()
        output, _ = process.communicate(timeout=10)
        print(f"{label} server output:\n{output}")

run_server(False)
run_server(True)
print(f"Node: {node}\nFixtures retained at: {base}")
