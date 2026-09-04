#!/usr/bin/env python3
"""Sync the latest local commit snapshot to GitHub via Git Data API.

Creates one commit on the remote whose tree matches the full local working
snapshot and whose message matches the latest local commit message.
Usage: python3 sync_commit_tmp.py <repo> <local-dir>
"""
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "out", ".vscode", "__pycache__"}


def gh(method: str, path: str, data=None):
    cmd = ["gh", "api", "--method", method, path]
    if data is not None:
        cmd += ["--input", "-"]
    p = subprocess.run(cmd, input=json.dumps(data) if data is not None else None,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"gh api {method} {path} failed: {p.stderr.strip()}")
    return json.loads(p.stdout)


def list_files(local_dir: Path):
    files = []
    for p in sorted(local_dir.rglob("*")):
        if p.is_dir():
            continue
        rel = p.relative_to(local_dir)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if p.name in (".DS_Store", "Thumbs.db") or p.suffix == ".vsix":
            continue
        files.append(rel.as_posix())
    return files


def main():
    repo = sys.argv[1]
    root = Path(sys.argv[2]).resolve()

    files = list_files(root)
    print(f"Creating snapshot commit of {len(files)} file(s) for {repo} ...")

    # 1. Blobs
    blobs = {}
    for rel in files:
        p = root / rel
        data = {"content": base64.b64encode(p.read_bytes()).decode(), "encoding": "base64"}
        blobs[rel] = gh("POST", f"repos/{repo}/git/blobs", data)["sha"]

    # 2. Tree (nested paths are expanded into subtrees automatically)
    entries = []
    for rel, sha in blobs.items():
        mode = "100755" if os.access(root / rel, os.X_OK) else "100644"
        entries.append({"path": rel, "mode": mode, "type": "blob", "sha": sha})
    tree = gh("POST", f"repos/{repo}/git/trees", {"tree": entries})

    # 3. Commit (parent = current remote main, message = latest local commit)
    head = gh("GET", f"repos/{repo}/git/refs/heads/main")["object"]["sha"]
    msg = subprocess.run(["git", "-C", str(root), "log", "-1", "--format=%B"],
                         capture_output=True, text=True).stdout.strip()
    commit = gh("POST", f"repos/{repo}/git/commits", {
        "message": msg,
        "tree": tree["sha"],
        "parents": [head],
    })

    # 4. Fast-forward the main ref
    gh("PATCH", f"repos/{repo}/git/refs/heads/main", {"sha": commit["sha"]})
    print(f"Done. Remote HEAD now: {commit['sha'][:8]} ({msg.splitlines()[0]})")


if __name__ == "__main__":
    main()
