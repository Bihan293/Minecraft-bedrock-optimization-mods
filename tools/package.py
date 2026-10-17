#!/usr/bin/env python3
"""Собирает dist/BedrockBoost.mcaddon (+ отдельные .mcpack) для установки на телефон."""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS = ROOT / "packs"
DIST = ROOT / "dist"


def zip_dir(zf: zipfile.ZipFile, folder: Path, prefix: str):
    for f in sorted(folder.rglob("*")):
        if f.is_file():
            zf.write(f, f"{prefix}/{f.relative_to(folder).as_posix()}" if prefix else f.relative_to(folder).as_posix())


def validate():
    n = 0
    for f in PACKS.rglob("*.json"):
        json.loads(f.read_text(encoding="utf-8"))
        n += 1
    print(f"JSON OK: {n} файлов")


def main():
    validate()
    DIST.mkdir(exist_ok=True)
    version = ".".join(map(str, json.loads((PACKS / "BedrockBoost_BP/manifest.json").read_text())["header"]["version"]))
    addon = DIST / "BedrockBoost.mcaddon"
    with zipfile.ZipFile(addon, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in ("BedrockBoost_RP", "BedrockBoost_BP"):
            zip_dir(zf, PACKS / p, p)
    for p in ("BedrockBoost_RP", "BedrockBoost_BP"):
        with zipfile.ZipFile(DIST / f"{p}.mcpack", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            zip_dir(zf, PACKS / p, "")
    for f in sorted(DIST.iterdir()):
        print(f"{f.name}: {f.stat().st_size // 1024} КБ (v{version})")


if __name__ == "__main__":
    main()
