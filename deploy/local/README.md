# 本机开发与部署

正式 Git 项目放在 `~/workspaces/media-marshal`。本目录为 macOS + Docker Desktop 的本机部署配置；上游 `docker-compose.yml` 保持不变。

在项目根目录执行：

```sh
./scripts/local-service.sh deploy
```

该命令运行后端测试、桥接测试、前端类型检查和构建，构建本地镜像，备份数据库后重新部署并等待网页与 API 就绪。需要 Docker Desktop、Node.js/npm、Python 3；Java/Maven 在 Docker 中运行。

```sh
./scripts/local-service.sh build   # 只验证和构建
./scripts/local-service.sh start   # 使用已构建版本启动
./scripts/local-service.sh stop
./scripts/local-service.sh status
./scripts/local-service.sh logs
```

数据库、密钥、活动镜像版本、启动脚本与备份放在 `~/Library/Application Support/MediaMarshal`。源码目录只保存 Git 文件及已忽略的 `build-artifacts/` 构建缓存，运行数据不进入 Git。

后端数据挂载使用运行目录下的 `data/`，媒体卷默认 `/Volumes/Seagate`，网页和 API 只绑定本机 3000、8080 端口。监听规则、TMDB Key、Codex 开关继续从原数据库读取，不由部署脚本覆盖。Codex 私有配置及独立启动项沿用原设置，参见 [Codex 兜底](../../docs/codex-fallback.md)。

镜像标签对应构建时的 Git 短提交号；有未提交改动时追加 `-dirty`。活动标签保存在运行目录 `deployment.env` 中，构建成功后才更新。旧镜像保留，可通过 `MEDIA_MARSHAL_LOCAL_TAG=旧标签 ./scripts/local-service.sh start` 临时回退；数据库发生结构迁移时还需使用对应备份。

需要自定义运行位置时可设置 `MEDIA_MARSHAL_RUNTIME_DIR`、`MEDIA_MARSHAL_DATA_DIR`、`MEDIA_MARSHAL_MEDIA_ROOT`。当前登录启动项面向现有 Seagate 卷：登录后先确认真实挂载，再从运行目录 `project-path` 读取正式仓库位置并启动服务。
