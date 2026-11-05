#!/usr/bin/env python3
"""Adds a mod to this store: zips its patch files and updates manifest.json.

Example:
  python add_mod.py "C:\\path\\to\\MyMod"  (a folder or a .zip) --name "My Mod" --creator stripesvr --version 1.0.0 --summary "What it does" --tags visuals,fun

The folder must contain a matching .utoc, .ucas and .pak. Only add mods you made or have permission to share.
"""
import argparse
import hashlib
import json
import re
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "manifest.json"
GITHUB_LIMIT = 100 * 1024 * 1024  # GitHub rejects larger single files


def main():
    ap = argparse.ArgumentParser(description="Add a mod to this store.")
    ap.add_argument("folder", type=Path, help="folder or .zip holding the .utoc, .ucas and .pak")
    ap.add_argument("--name", required=True)
    ap.add_argument("--creator", required=True)
    ap.add_argument("--version", default="1.0.0")
    ap.add_argument("--summary", default="")
    ap.add_argument("--description", default="")
    ap.add_argument("--tags", default="", help="comma separated")
    ap.add_argument("--id", help="defaults to a cleaned-up name")
    a = ap.parse_args()

    mod_id = a.id or re.sub(r"[^a-z0-9]+", "-", a.name.lower()).strip("-")
    if not re.fullmatch(r"[A-Za-z0-9][\w.\-]{0,79}", mod_id):
        sys.exit(f"'{mod_id}' is not a usable id. Pass one with --id using letters, numbers, dots or dashes.")

    if not a.folder.exists():
        sys.exit(f"{a.folder} does not exist.")
    tmp = None
    if a.folder.is_file():
        if a.folder.suffix.lower() != ".zip":
            sys.exit("Pass a folder or a .zip holding the .utoc, .ucas and .pak.")
        tmp = tempfile.TemporaryDirectory()
        with zipfile.ZipFile(a.folder) as z:
            z.extractall(tmp.name)
        files = Path(tmp.name).rglob("*")
    else:
        files = a.folder.iterdir()

    stems = {}
    for f in files:
        if f.is_file() and f.suffix.lower() in (".utoc", ".ucas", ".pak"):
            stems.setdefault(f.stem, {})[f.suffix.lower()] = f
    complete = {s: fs for s, fs in stems.items() if len(fs) == 3}
    if not complete:
        sys.exit("No complete patch found. The folder needs a .utoc, .ucas and .pak with the same name.")

    out_dir = HERE / "mods" / mod_id
    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / f"{mod_id}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for fs in complete.values():
            for f in fs.values():
                z.write(f, f.name)
    if tmp:
        tmp.cleanup()
    data = archive.read_bytes()
    if len(data) > GITHUB_LIMIT:
        archive.unlink()
        if tmp:
            tmp.cleanup()
        sys.exit("The zip is over GitHub's 100 MB file limit, so it can't be hosted here.")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {
        "id": mod_id,
        "name": a.name,
        "creator": a.creator,
        "version": a.version,
        "summary": a.summary,
        "description": a.description or a.summary,
        "tags": [t.strip() for t in a.tags.split(",") if t.strip()],
        "updated": now,
        "files": [{
            "name": archive.name,
            "url": f"mods/{mod_id}/{archive.name}",
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }],
    }
    mods = [m for m in manifest["mods"] if m.get("id") != mod_id]
    replaced = len(mods) != len(manifest["mods"])
    mods.append(entry)
    manifest["mods"] = mods
    manifest["updated"] = now
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{'Updated' if replaced else 'Added'} {a.name}: {len(data)} bytes, {len(complete)} patch(es). Commit and push to publish it.")


if __name__ == "__main__":
    main()
