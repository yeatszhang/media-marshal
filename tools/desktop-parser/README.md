# 桌面离线名称解析器

这是与旧 FastAPI 服务独立的 stdio 程序，运行依赖只有 guessit 及其依赖。每条 JSON Lines 请求必须带 `protocolVersion: 1`、有界 `requestId` 和 `action`；`health` 返回版本，`parse` 额外接收单个 `filename`。stdout 只输出响应，不打开端口、不读媒体文件、不执行名称中的命令。EOF 后退出。

源码测试与构建（在本目录，Python 3.11）：

```bash
python -m pip install --require-hashes -r requirements-build.txt
python -m unittest discover -s tests
python build.py
python smoke.py
```

目录产物为 `dist/media-marshal-parser/`，其中可执行文件在 Windows 带 `.exe`。必须保留整个目录；macOS 与 Windows 分别原生构建。冻结程序可在清空 PATH/PYTHONHOME/PYTHONPATH 后运行同一套测试：将 `PARSER_EXECUTABLE` 设为生成的可执行文件绝对路径，再运行测试。冻结程序自身不需要系统 Python，测试驱动仍需开发环境 Python。

顶层依赖维护在 `requirements*.in`，带校验值的跨平台锁定清单由 `uv pip compile --universal --python-version 3.11 --generate-hashes requirements-build.in -o requirements-build.txt` 生成。发行前需要收集依赖许可并签名；目前只有本机冻结验证，三平台结果未齐，不视为正式发行完成。Core 的解析管道、超时/取消、崩溃恢复和随 Electron 包接入仍由后续任务完成。
