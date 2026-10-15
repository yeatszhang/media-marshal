# Codex CLI 识别兜底

常规 GuessIt、TMDB 与父目录增强仍是主流程。仅当类型无法确定、没有 TMDB 候选或匹配分数不足时，调用宿主机桥接服务，通过 `codex exec` 返回符合 JSON Schema 的名称解析建议。

模型接收文件名、最多四层父目录名、最多 80 个同目录视频文件名及原始解析字段。它不接收媒体内容或 TMDB Key，不操作媒体文件。CLI 使用隔离工作目录、只读沙盒，关闭 shell 和联网搜索，并忽略用户配置以免加载无关 MCP。若使用 API 提供商，仅把所需密钥注入该 CLI 子进程。

## 本机桥接

需要 Python 3 与可用的 Codex CLI。使用官方 CLI 支持的 `exec --output-schema`、`--output-last-message` 和 `--sandbox read-only`，参考 [OpenAI Docs](https://learn.chatgpt.com/docs/developer-commands#codex-exec)。

通过 `python3 scripts/codex-bridge.py --config /path/to/bridge.json` 启动。配置文件权限应为 600，配置示例：

```json
{
  "runtime_dir": "/path/to/private/runtime",
  "codex_path": "/absolute/path/to/codex",
  "model": "使用当前账户实际可用的模型",
  "host": "127.0.0.1",
  "port": 18081,
  "timeout_seconds": 150,
  "token": "替换为不少于32位的随机令牌"
}
```

默认复用 Codex 的现有登录。可选 `provider` 配置通过 Codex CLI 自定义 Responses 提供商：

```json
{
  "base_url": "https://opencode.ai/zen/v1",
  "env_file": "/path/to/private/.env",
  "env_key": "OPENCODE_ZEN_API_KEY"
}
```

把该对象放在桥接配置的 `provider` 字段。程序只读取 `.env` 中指定的一项，不执行文件；密钥不写入 Media Marshal，也不出现在命令参数中。API 调用消耗对应提供商的额度。

桥接提供 `GET /health` 和带 `X-Media-Marshal-Token` 认证的 `POST /recognize`。结果与未知结果均按完整上下文缓存 24 小时，CLI 调用串行执行，并设有排队和进程超时。CLI 失败时不向调用者暴露其输出。

## Media Marshal 配置

通过现有 `/api/settings/{key}` 配置接口保存：

| 键 | 含义 |
| --- | --- |
| `codex.enabled` | 是否启用，默认 false |
| `codex.bridge-url` | 桥接地址，Docker Desktop 默认 `http://host.docker.internal:18081` |
| `codex.bridge-token` | 与桥接相同的随机令牌，保存时设 `sensitive=true` |
| `codex.require-confirmation` | 是否强制人工确认，默认 true |

前端“系统设置 → 识别配置”提供启用和确认开关。部署前先在容器内验证桥接健康接口可达。

Codex 必须提供合法结构，结果为 `identified` 且置信度至少 0.6。明确的原季集号优先保留；规则限定电影或剧集时拒绝不相符结果。模型建议必须再次经过 TMDB 搜索，不会降低已有候选的最佳分数。缺少季集号的剧集仍需确认。

已有待确认任务可点击文件卡片顶部的“Codex 重新识别”，也可在“编辑识别信息”面板底部使用同名按钮。对应接口 `POST /api/queue/{id}/codex-rematch` 仅更新解析及 TMDB 候选；不移动文件，也不清除旧记录。无法确定作品、TMDB 无候选或源文件不存在时，返回说明并保留原信息。

完全混淆的目录和纯数字文件名可能缺少作品身份，模型应返回 `unknown`。需要补充正式片名、原文名或由用户在队列中指定作品。

## 验证

```sh
cd backend && mvn test
python3 -m unittest discover -s scripts -p test_codex_bridge.py
cd frontend && npm run build
```
