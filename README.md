# Media Marshal

Media Marshal 是面向本地媒体库的桌面客户端，当前工程使用 Electron、React 和 TypeScript。产品范围、设计与实施状态以 [OpenSpec](openspec/) 和当前维护文档为准；代码、测试和正式发行验收分别记录。

## 当前工程

| 目录 | 职责 |
| --- | --- |
| `apps/desktop/` | Electron 桌面宿主、受限 IPC 和 React 界面 |
| `packages/contracts/` | 共享业务契约 |
| `packages/media-core/` | 媒体识别、来源、下载与整理核心 |
| `tools/desktop-parser/` | 桌面冻结 stdio 解析器 |
| `tools/desktop-files/`、`tools/desktop-sidecars/` | 原生文件工具与内置下载组件 |
| `docs/`、`openspec/` | 当前产品、架构、开发及验收文档 |
| `legacy/` | 旧 Java / Vue / HTTP parser 工程与历史文档，仅供参考 |

桌面运行不依赖旧 Java 服务或旧数据库。开发环境、依赖准备与原生模块说明见[桌面客户端开发](docs/architecture/desktop-development.md)。

完成依赖准备后，在仓库根目录使用：

```sh
npm run desktop:dev
npm run typecheck
npm run check:boundaries
npm test
npm run docs:build
```

## 文档入口

- [客户端下载与使用条件](docs/download.md)
- [架构总览](docs/architecture/index.md)
- [桌面迁移基线](docs/architecture/desktop-migration.md)
- [产品定位](docs/product/positioning.md)与[商业策略](docs/product/business-and-operations.md)
- [开发协作指引](AGENTS.md)

## 旧工程参考

旧代码、Docker 配置、本机部署及桥接脚本、版本标记、说明图片和历史文档已统一移入根目录 [legacy/](legacy/README.md)。旧项目介绍与操作说明保留在[归档 README](legacy/README.md)及[历史资料索引](legacy/docs/index.md)，不作为当前桌面工程的运行或交付依据。

## 许可证

[GPL-3.0](LICENSE)
