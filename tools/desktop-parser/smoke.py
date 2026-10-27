"""以同一套协议测试验证当前平台冻结产物。"""

import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
executable = root / "dist" / "media-marshal-parser" / ("media-marshal-parser.exe" if sys.platform == "win32" else "media-marshal-parser")
if not executable.is_file():
    raise SystemExit("尚未生成当前平台的冻结解析器，请先运行 build.py")
environment = dict(os.environ, PARSER_EXECUTABLE=str(executable))
result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(root / "tests")], env=environment)
raise SystemExit(result.returncode)
