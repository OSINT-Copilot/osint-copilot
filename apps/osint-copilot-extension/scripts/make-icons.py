#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Probe Point Analytics LLC
"""Regenerates static/icons/icon-{16,32,48,128}.png from the desktop app's icon.

One source of truth for the artwork: the app's build/icon.png. Run it again whenever that
changes (needs Pillow): python3 scripts/make-icons.py
"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent / 'tangent-electron' / 'build' / 'icon.png'
OUT = HERE.parent / 'static' / 'icons'
SIZES = (16, 32, 48, 128)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE).convert('RGBA')
    for size in SIZES:
        # LANCZOS keeps the small sizes crisp; downsampling straight from the master avoids
        # compounding blur from a chain of resizes.
        icon = source.resize((size, size), Image.LANCZOS)
        # optimize, and no metadata, so rerunning on the same source gives the same bytes.
        icon.save(OUT / f'icon-{size}.png', optimize=True)
        print(f'wrote {OUT / f"icon-{size}.png"}')


if __name__ == '__main__':
    main()
