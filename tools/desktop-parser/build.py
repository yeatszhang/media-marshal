"""在当前平台冻结目录产物；发行环境不需要系统 Python。"""

from pathlib import Path

import PyInstaller.__main__

root = Path(__file__).resolve().parent
PyInstaller.__main__.run([
    "--noconfirm", "--clean", "--onedir", "--console",
    "--name", "media-marshal-parser",
    "--distpath", str(root / "dist"),
    "--workpath", str(root / "build"),
    "--specpath", str(root),
    "--collect-all", "guessit",
    "--collect-all", "rebulk",
    "--collect-all", "babelfish",
    "--copy-metadata", "guessit",
    "--copy-metadata", "rebulk",
    "--copy-metadata", "babelfish",
    str(root / "main.py"),
])
