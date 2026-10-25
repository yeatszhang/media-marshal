# 修正文件操作的 macOS 原语

本目录提供 `renameatx_np(..., RENAME_EXCL)` 的 Node-API 8 绑定，作为后续单条／批量修正的底层能力。Apple 将独占改名定义为文件系统能力，不能从普通 `rename` 或词法预检推断支持：[Apple 文档](https://developer.apple.com/documentation/foundation/urlresourcevalues/volumesupportsexclusiverenaming)。Node-API 的接口版本与 Electron 的普通 C++ 模块 ABI 分开，实际可加载性仍须按目标运行验证：[Node-API 文档](https://nodejs.org/api/n-api.html)。

当前只在隔离测试中使用，**尚未由 Core 修正服务调用，也没有进入安装包**。不改变当前 COPY、来源授权或已有媒体文件。任务 5.6／5.7 保持未完成；修正预览、持久日志、历史链、跨卷 COPY、旧目标回收、安装态和签名仍须接入及验收。

## 构建与验证

Mac 需安装 Xcode Command Line Tools。准备命令使用根锁文件已有的 node-gyp，通过 Electron 官方地址校验并缓存固定版本头文件；运行中的客户端不下载头文件或调用编译器。

```sh
npm run desktop:prepare-native-files
npm run desktop:prepare-native-files -- x64
npm test -- packages/media-core/src/files/rename-exclusive.test.ts
node tools/desktop-files/check-filesystems.mjs
```

输出位于忽略的 `build-artifacts/desktop-files/darwin-{arm64,x64}`。构建记录源码和四份 Node-API 头文件的 SHA-256、Electron 头文件版本、SDK、编译器、架构及二进制摘要；构建期间输入变化则失败。每次临时编译后核对 Mach-O CPU，再发布到开发输出目录。未承诺跨机器或临时链接标识的逐字节可复现构建。

`build.mjs --headers <目录> --out <隔离输出> --arch <架构>` 可用于已准备 SDK 的离线编译。开发输出标记 `unintegrated-development`；目前不修改 Electron builder 的原生模块白名单或资源装载路径。将来接入必须补齐 Main／Core 的可信资源定位、摘要验证、ASAR 解包、架构白名单、Developer ID 签名与安装态验证。

## 内部契约与恢复边界

`renameExclusive(fromParentFd, fromName, toParentFd, toName, expected)` 只接受两个目录 FD、两个单层名称和原文件 BigInt 快照 `{dev, ino, size, birthtimeNs, mtimeNs, ctimeNs}`。拒绝穿越、绝对路径、NUL、超长名称、孤立代理项、非整数 FD、伪造快照及非普通来源；不接收任意命令或 SQL。**目录 FD 是否来自已授权媒体根仍由 Core 保证**，本原语不能替代原卷、父目录或路径边界核验。

排队前以 `F_DUPFD_CLOEXEC` 复制并独占持有目录 FD，避免调用者关闭／复用句柄后改名到另一目录。每个原生函数实例最多 64 项等待；在 libuv 工作线程执行，完成或排队失败释放 FD、工作对象和名额。函数对象释放后在途工作仍保留实例状态，不借全局实例数据与其他原生模块共享所有者。

返回固定结果，不包含路径或原始系统消息：

| 状态 | 语义 | 后续 Core 必须采取的动作 |
| --- | --- | --- |
| `NOT_RENAMED` | 系统调用没有成功改名；包括目标占用、来源变化、跨卷、不支持和不可用 | 保留原目标；按原因等待、重新预览或进入跨卷计划 |
| `RENAMED` | 独占改名成功，改名后身份与大小／修改时间相符，目录同步成功 | 仍须核对内容证据并补记持久日志，不能仅凭返回值完成历史 |
| `UNCERTAIN` | 改名成功后身份核对或目录同步失败 | 原位置可能已变化；按持久日志定位现存文件，不自动删除或逆向改名 |

原文件的 ctime 用于改名前核对，改名后允许内核更新 ctime；摘要和文件的业务归属由上层另行证明。原语不提供“取消后必未执行”的承诺。调用前必须先持久化完整计划，调用后等待确定结果；Core 被强杀时应从日志核对旧／新位置，不重放普通覆盖式改名。返回 `CROSS_VOLUME` 或 `UNSUPPORTED` 不执行 COPY、硬链接降级或旧目标删除。同路径或仅大小写改名的计划应由上层明确判定，必要时使用可恢复中间计划。

## 已有证据与缺口

`fixtures/mac-rename-exclusive-2026-10-25.json` 保存本机 arm64 的自有 256 MiB 稀疏映像结果和构建摘要：APFS、HFS+ 改名及不覆盖通过；exFAT 实际改名返回 `UNSUPPORTED`；三种目标的跨卷调用均返回 `CROSS_VOLUME`。工具以 `hdiutil info` 核对映像与设备归属后卸载，不按设备名猜测；残留挂载未确认时不递归删除测试目录。

8 项 Electron Node 原生测试覆盖同卷 inode／内容保持、外部进程抢占、并发目标领取、来源变化、符号链接、目录、非法输入、权限撤销、异步 FD 复用以及 64 项上限和完成后名额释放。同一模块还由本机 Node 22.23.1 加载完成文件系统矩阵；Electron 44.9.0 内置 Node 24.22.0 实测加载。x64 仅交叉编译与 Mach-O 核对，不能视作 Intel Mac 运行或安装验收。

尚未覆盖“改名后来源被并发替换”的 `UNCERTAIN` 实际竞争窗口及同步故障注入；该返回分支只是必要契约，不能据此宣称修正恢复已验证。后续仍须完成旧目标隔离与确切归属回收、主视频／附属文件逐项日志、目标提交后记账前 SIGKILL、部分失败和历史恢复，不沿用旧 Java 的内存回滚方式。
