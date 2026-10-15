# Codex CLI 识别兜底

常规 GuessIt、TMDB 与父目录增强仍是主流程。仅当类型无法确定、没有 TMDB 候选或匹配分数不足时，调用宿主机桥接服务，通过 `codex exec` 返回符合 JSON Schema 的名称解析建议。

模型接收文件名、最多四层父目录名、最多 80 个同目录视频文件名及原始解析字段。它不接收媒体内容或 TMDB Key，不操作媒体文件。CLI 使用隔离工作目录、只读沙盒，关闭 shell，开启受限联网检索，并忽略用户配置以免加载无关 MCP。若使用 API 提供商，仅把所需密钥注入该 CLI 子进程。

## 本机桥接

需要 Python 3 与可用的 Codex CLI。使用官方 CLI 支持的 `exec --output-schema`、`--output-last-message` 和 `--sandbox read-only`，参考 [OpenAI Docs](https://learn.chatgpt.com/docs/developer-commands#codex-exec)。

通过 `python3 scripts/codex-bridge.py --config /path/to/bridge.json` 启动。配置文件权限应为 600，配置示例：

```json
{
  "runtime_dir": "/path/to/private/runtime",
  "codex_path": "/absolute/path/to/codex",
  "model": "gpt-5.4-mini",
  "web_search": "live",
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

桥接提供 `GET /health` 和带 `X-Media-Marshal-Token` 认证的 `POST /recognize`。成功结果按完整上下文缓存 24 小时，未知结果仅缓存 5 分钟，手动重新识别绕过未知缓存。缓存键包含提示词、Schema、模型和联网模式，升级策略后自动失效。同一具名父目录下至少两集且全部为不同纯数字视频名时，可复用置信度至少 0.9 的剧集作品身份；每个文件重新填入自身集号；已整理的集数离开目录后仍能复用身份，显式年份冲突时重新查证。季号不明时保持空值。混合片名目录、监听根目录、电影和低置信度结果不共享。CLI 调用串行执行，并设有排队和进程超时。CLI 失败时不向调用者暴露其输出。

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

模型使用 `gpt-5.4-mini`、low 推理强度，通过 CLI 原生联网检索查证错字、谐音和别名；找到可靠证据后返回正式片名及来源 URL。示例：“尼古猫猫”经作品官网查证可对应《ヤニねこ》，随后使用正式片名搜索 TMDB，不再把 `01.mkv` 作为作品名追加查询。队列卡片展示识别依据。该检索使用现有 OpenCode Responses API 额度，无需新增搜索服务密钥。

仍然无法消歧、搜索失败或完全没有作品线索时返回 `unknown`。模型不能读取视频内容；用户仍可补充正式片名或手动指定作品。

## 验证

```sh
cd backend && mvn test
python3 -m unittest discover -s scripts -p test_codex_bridge.py
cd frontend && npm run build
```

确认整理前，前后端都检查剧集季号和集号是否完整，单条及批量确认均无法绕过；缺失时引导编辑，防止目标路径残留模板占位符。外置盘监控根目录不可访问时暂停缺失检测，避免把暂时的挂载错误当作源文件删除。
