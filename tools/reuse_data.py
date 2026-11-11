#!/usr/bin/env python3
"""
Copy the data files currently on the live site into the new build.

Used when only the app's code changed (no need to rebuild the timetables and
walking network, which takes minutes), and as a fallback when the nightly
build fails, so the site never loses its data.

Usage: python3 tools/reuse_data.py OUT_DIR
Exits with 1 if there's no data on the live site yet.
"""

import json
import os
import sys
import urllib.request

BASE = "https://musa800.github.io/AcrossTransit/data/"


def get(name):
    req = urllib.request.Request(BASE + name, headers={"User-Agent": "AcrossTransit-build/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    try:
        report = json.loads(get("report.json"))
    except Exception as e:  # noqa: BLE001
        print(f"no data on the live site yet ({e})")
        sys.exit(1)
    names = list(report.get("files", {}).keys()) + [d["file"] for d in report.get("days", [])]
    for name in names:
        try:
            data = get(name)
        except Exception as e:  # noqa: BLE001
            print(f"could not copy {name}: {e}")
            sys.exit(1)
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        print(f"kept {name} ({len(data) // 1024} KB)")
    with open(os.path.join(out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
