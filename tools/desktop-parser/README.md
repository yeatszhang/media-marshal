# 桌面离线名称解析器

这是与旧 FastAPI 服务独立的 stdio 程序，运行依赖只有 guessit 及其依赖。每条 JSON Lines 请求必须带 `protocolVersion: 1`、有界 `requestId` 和 `action`；`health` 返回版本，`parse` 额外接收单个 `filename`。stdout 只输出响应，不打开端口、不读媒体文件、不执行名称中的命令。EOF 后退出。

源码测试与构建（在本目录，固定 Python 3.11.14）：

```bash
python -m pip install --require-hashes -r requirements-build.txt
python -m unittest discover -s tests
python build.py
python smoke.py
```

目录产物为 `dist/media-marshal-parser/`，其中可执行文件在 Windows 带 `.exe`。必须保留整个目录；macOS 与 Windows 分别原生构建。冻结程序可在清空 PATH/PYTHONHOME/PYTHONPATH 后运行同一套测试：将 `PARSER_EXECUTABLE` 设为生成的可执行文件绝对路径，再运行测试。冻结程序自身不需要系统 Python，测试驱动仍需开发环境 Python。

从仓库根运行 `npm run desktop:prepare-parser`，准备器选择构建用 `.venv`（或 `MARSHAL_PARSER_PYTHON`），原生冻结当前架构并收集依赖许可、固定 Python 许可和 191 个运行文件的摘要。资源位于 `apps/desktop/resources/parser/<target>/`；清单进入 ASAR，完整 runtime 在 ASAR 外。禁止跨平台或错误架构构建，不从运行时系统 PATH 查找 Python。`desktop:build` 和打包 hook 均会准备并复核资源。

Core 已通过有界、串行、带 requestId 的管道接入；超时、输出过长、错误关联及非法结构会停止旧解析器，最多自动恢复三次。实际冻结文件逐个核验，额外代码、越界链接和错误架构均拒绝。Core 失效时由 stdin EOF 和 POSIX 父进程监测收敛生命周期，Main 强杀的真实窗口测试验证 Core 与解析器都退出。当前新接线仅完成 Mac arm64 开发态验证，其他架构和包含解析器的新安装包需要分别验收；0.2.1 下载补丁包不包含本节后续新增能力。

顶层依赖维护在 `requirements*.in`，带校验值的跨平台锁定清单由 `uv pip compile --universal --python-version 3.11 --generate-hashes requirements-build.in -o requirements-build.txt` 生成。当前没有 Developer ID/公证，仍不是正式发行。
