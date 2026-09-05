# Media Marshal 部署指南

> 按 2026-09-05 的 v0.2.13.1 工作区配置整理。本文说明当前仓库的部署方式；远端镜像 tag、生产升级与备份恢复仍需按实际发行版本验证。使用说明见[用户手册](./user-guide.md)，排障见[FAQ](./faq.md)。

## 1. 选择部署方式

| 文件 | 镜像来源 | 未设置 tag 时的默认值 | 应用数据 |
|---|---|---|---|
| `docker-compose.yml` | 三个 GHCR 镜像 | `latest` | 命名卷 `mm_data` 挂载到 `/data` |
| `docker-compose.beta.yml` | 从本仓库构建三个镜像，`pull_policy: build` | `beta` | 命名卷 `mm_data` 挂载到 `/data` |
| `docker-compose.alpha.yml` | 三个 GHCR 镜像 | `alpha` | 宿主机 `/opt/media-marshal/data` 挂载到 `/data` |

三个服务名为 `media-marshal`（Java 后端）、`portal`（Nginx 前端）、`parser`（Python）。三个文件都将 `MEDIA_DIRS` 指定的宿主机目录挂载到后端 `/media`。

**选择一份 Compose 使用，不要叠加启动。** 当前容器名称相同；同机多套环境需先调整容器名、端口、数据卷和媒体样本路径。alpha 与其他两份文件的 `/data` 来源不同，切换文件不会自动迁移数据库。

`.env.example` 显式写有 `MEDIA_MARSHAL_IMAGE_TAG=latest`，复制后会覆盖表中的默认值。使用 alpha 时改为 `alpha` 或已确认存在的版本 tag；beta 可改为 `beta`。源码版本号不证明 GHCR 上已有同名镜像，固定版本须先核对三个镜像均已发布。

## 2. 首次启动

以下命令在仓库根目录执行，示例采用 Linux / NAS shell。

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
MEDIA_DIRS=/srv/media
MEDIA_MARSHAL_PORTAL_PORT=3000
MEDIA_MARSHAL_HTTP_PORT=8080
MEDIA_MARSHAL_IMAGE_TAG=beta
```

示例中的 `/srv/media` 应换为实际宿主机目录。目录不存在时先在宿主机创建，并确保容器进程有对应读写权限。

从当前源码构建并启动：

```bash
docker compose --env-file .env -f docker-compose.beta.yml config --quiet
docker compose --env-file .env -f docker-compose.beta.yml up -d --build
docker compose --env-file .env -f docker-compose.beta.yml ps
```

如果选择预构建镜像，将 `.env` 中 tag 改为已确认发布的标签，改用：

```bash
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d
docker compose --env-file .env -f docker-compose.yml ps
```

打开 `http://localhost:3000`；远程部署用服务器地址和所配端口。初始化页填写 TMDB API Key，然后添加路径规则。先使用少量可替换样本验证预览和文件操作，再启用实际目录。

## 3. 挂载与权限

例如宿主机目录为：

```text
/srv/media/Downloads
/srv/media/Movies
/srv/media/TV
```

设置 `MEDIA_DIRS=/srv/media` 后，路径规则应填写：

```text
/media/Downloads
/media/Movies
/media/TV
```

页面中的目录来自后端所见文件系统，不是浏览器所在电脑。数据库位于 `/data/media-marshal.db`，与媒体挂载 `/media` 分开。

- MOVE 需要读取源、删除源目录项和写入目标；COPY 需要源可读、目标可写。
- HARD_LINK 需要源 / 目标位于支持硬链接的同一文件系统。优先挂载共同父目录；不同挂载点或文件系统可能失败。
- SYMBOLIC_LINK 需要相应权限；媒体服务器也必须能解析链接指向的路径。MM 容器能访问不代表 Emby 等容器能访问。
- 保存前能力校验和实际操作都会受容器用户、NAS ACL、SMB / NFS 与挂载选项影响。不要把宿主机管理员可写当成容器也可写。
- 四种操作不会在失败时自动换成另一种方式。

## 4. 环境变量与生效来源

| 变量 / 配置 | 用途 |
|---|---|
| `MEDIA_DIRS` | 后端 `/media` 对应的宿主机目录 |
| `MEDIA_MARSHAL_PORTAL_PORT` / `MEDIA_MARSHAL_HTTP_PORT` | Web UI / 后端宿主机端口，默认 3000 / 8080 |
| `MEDIA_MARSHAL_IMAGE_TAG` | 三个镜像共用 tag；显式设置覆盖 Compose 默认值 |
| `MAVEN_MIRROR_URL` / `NPM_REGISTRY` | beta 构建使用的可选镜像源 |
| `MEDIA_MARSHAL_CONFIDENCE_THRESHOLD` | 自动确认阈值，默认 0.8 |
| `MEDIA_MARSHAL_DEBUG` | 详细日志，通常保持 false |
| `MEDIA_MARSHAL_TMDB_PROXY_ENABLED` / `MEDIA_MARSHAL_TMDB_PROXY_HTTP_URL` | TMDB API 代理回退配置 |
| 邮件相关变量 | 后端保留配置，当前页面未开放，完整投递待验收 |

`.env` 主要用于 Compose 变量替换；新增变量只有被 Compose 的 `environment` 引用或另行显式传入后端容器，后端才能读取。运行中的容器不会因编辑 `.env` 自动更新环境。

运行时来源有三种规则：

1. **TMDB API Key**：仅通过 Web UI 保存到数据库，不从环境变量读取。
2. **普通系统项**：环境变量 > `application.yml` > 数据库 > 默认值。页面保存不一定覆盖已有高优先级配置。
3. **TMDB 代理**：Web UI 显式保存优先，关闭后保存会强制直连；未保存时回退环境变量 / application 配置。

## 5. TMDB 与代理

API Key 在初始化页填写，之后在“设置 → 系统设置”修改。代理示例：

```dotenv
MEDIA_MARSHAL_TMDB_PROXY_ENABLED=true
MEDIA_MARSHAL_TMDB_PROXY_HTTP_URL=http://192.168.1.10:7890
```

将示例地址换成**后端容器实际可达**的代理。容器里的 `127.0.0.1` 指向容器本身；宿主机代理只监听宿主机回环地址时，容器未必能访问。

- 当前只支持不带认证信息的 HTTP 代理，不支持 SOCKS、HTTPS 类型代理或用户名密码。
- 只代理 TMDB API，不代理海报图片、Parser 或邮件。能搜索但海报不显示时，还需检查浏览器到图片地址的访问。
- 在 Web UI 保存代理后无需重启，新 TMDB 请求使用新配置；已有缓存可能使请求不立即访问外网。
- 当前还没有一键 TMDB / Parser 连通性检测页面。可通过实际搜索、样本整理与日志判断。

## 6. 端口与访问边界

当前 Compose 默认发布 Web UI 3000 和后端 8080；Parser 无宿主机端口，仅在 Compose 网络中访问。Nginx 转发前端 API / WebSocket 请求。

应用尚无内置认证，部署在本机、可信内网或 VPN。配置反向代理认证时也要限制直连后端端口，避免仅保护页面入口。本文不将当前无认证部署视为公网服务方案。

## 7. 升级、备份与恢复

### 升级前

1. 记录当前代码 / 镜像版本、Compose 文件、项目名、数据挂载及路径规则；保存 Compose 与 `.env`，备份中可能有敏感配置。
2. 等待普通整理与批量修正结束，停止服务后再复制数据。当前没有覆盖所有后台作业的维护模式。
3. 备份完整 `/data`，不要只在运行中复制主 `.db` 文件；SQLite 使用 WAL，完整一致性需在停写条件下保证。
4. 在隔离环境验证恢复，确认规则、任务、候选、修正历史及批次均可读取，再执行实际升级。

下面仅演示预构建镜像方式的停机备份；使用 beta / alpha 时换成实际 Compose 文件。备份目录每次使用新的名称，避免混入旧副本：

```bash
mkdir -p ./backups/pre-upgrade-20260905/data
docker compose --env-file .env -f docker-compose.yml stop
docker cp media-marshal:/data/. ./backups/pre-upgrade-20260905/data/
cp .env ./backups/pre-upgrade-20260905/env.backup
cp docker-compose.yml ./backups/pre-upgrade-20260905/compose.backup.yml
```

复制完成后检查文件和复制命令结果。备份可包含任务路径与 API Key，保存在受控位置，不上传公开仓库。命名卷实际名称受 Compose 项目名影响，不要把 `mm_data` 当成所有主机上固定的卷名。

### 升级与回滚边界

- 改为已确认存在的新 tag 后执行 `pull` 与 `up -d`；beta 重新构建。核对应用版本、启动日志与少量样本。
- 当前采用 Hibernate 自动更新及部分显式 SQLite 迁移，不能保证任意旧版本直接降级兼容。
- 回滚应恢复升级前数据库并使用匹配旧版本；保留失败升级后的数据副本供排障，不直接覆盖唯一备份。
- **恢复数据库不会撤销已经完成的媒体移动。** 如升级后已执行任务，应先核对实际文件与数据库差异。
- 恢复演练使用独立数据目录与媒体副本，不能让第二个实例连接生产数据库或自动处理真实媒体。
- 规则导入导出只迁移规则，不包含任务、候选、设置或修正批次，不替代备份。
- 卸载 / 重建容器时保留数据卷；不要用删除卷的操作代替升级或排障。

本文提供操作步骤，尚不代表最近公开版本到当前工作区的升级与恢复已完成实测。

## 8. NAS 与故障排查

NAS、网络盘和 Docker 挂载可能漏发文件事件，建议采用混合模式，并使用手动扫描区分“事件未触发”和“文件本身不可见”。周期扫描最短 5 分钟，默认 10 分钟；扫描提示成功仅表示请求已接受。

只读排查示例（换成实际 Compose 文件）：

```bash
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --tail=100 media-marshal portal parser
docker inspect media-marshal --format '{{json .Mounts}}'
docker compose --env-file .env -f docker-compose.yml exec parser python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health', timeout=3).read().decode())"
```

| 现象 | 优先检查 |
|---|---|
| 镜像拉取失败 | 三个镜像所选 tag 是否存在、仓库访问与网络；必要时使用本地 beta 构建 |
| 页面无法访问 | portal 状态、端口冲突、地址及防火墙 |
| 页面有但 API 失败 | media-marshal 启动日志、Nginx 代理和容器网络 |
| Parser 不可用 | 健康检查、后端到 `parser:8000`、解析请求异常；健康成功不等于所有文件名可解析 |
| TMDB 失败 | Web UI Key、代理生效来源、容器到代理 / TMDB 的网络 |
| 目录不出现 / 不可写 | `/media` 映射、容器身份、NAS ACL 与挂载能力 |
| 文件没自动处理 | 规则启用、忽略、Sample、去重、文件稳定性、发现模式 |

分享日志前去除密钥和个人路径；更多行为说明见[FAQ](./faq.md)。
