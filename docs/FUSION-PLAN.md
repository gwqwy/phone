# shou · 构建计划（v0.1.0）

> 状态：**已获用户批准并开始构建**。本文档保留为决策记录——每一条"为什么这么做"
> 都是当时比较过替代方案之后的结果，改动本项目的架构前请先读它。

## 一、需求

把两个手机端上游（ZCode 远控、DeepSeek Harness 手机版）融合成一个 App，
加上"远程控制电脑端 DeepSeek Harness"的能力，用 uni-app 实现、由 HBuilderX 构建，
非 root，先出 App 版，后续可出小程序版。版本 0.1.0，显示名与包名 `shou`。

补充确认：不内嵌 dsh-pocket，只作外部依赖；包名用 `com.shou`。

## 二、三个上游各自是什么（核实结论）

### zremote（pjpv/zremote，Flutter，MIT）

**它不是协议实现，是"官方远控网页的壳 + 流量嗅探器"**：加载官方页面、注入脚本包装
`fetch`/`EventSource`/`WebSocket`，把抓到的帧回传 Dart 重建状态。仓库内没有服务端。

它的价值在**产品行为与不变量**，被 21 个测试文件钉住：配对链接的解析与重铸规则、
按 sid 去重、两路索引的合并优先级、排序与日期分组、通知差分状态机（0→>0 才通知、
归零才撤回、首见终态不通知）、九条中继终态关闭原因、深色主题的精确数值。

**决定了什么**：小程序不能用 WebView 嗅探，所以 ZCode 侧必须原生实现协议——
这条路线否决了"照抄 zremote 的做法"，只移植它的行为规格。

### dsh-phone（railgun0325/dsh-phone，Java，MIT）

**也不是 dsh 的 fork**，而是上游 npm 包 `@deepseek-ai/dsh` 的安装器 + 宿主适配层 + 安卓控制插件。
三个风味：root、**shizuku（非 root）**、common。

**非 root 的答案是 Shizuku 版**：权限边界是 adb shell 级（uid 2000），
一次性无线调试配对、不需要电脑；Termux + Node 是 dsh 的硬依赖。
它记录的 g1–g12 关卡（没有 flock 原生模块、硬链接被 SELinux 拒、附件持久化不能向上遍历祖先目录、
WebView 必须宿主实现 `onShowFileChooser`、MIUI 会冻结 Termux）是**设计约束**，不是要抄的代码。

**决定了什么**：运行时装不进 uni-app（监听端口、前台服务、Shizuku provider 都在原生层），
所以 shou 复用它的 Shizuku 版 APK 作配套部署器，自己只做客户端，指向 `127.0.0.1:3080`。

### dsh-pocket（shaobeichen/dsh-pocket，Node，**GPL-2.0**）

**一个反向代理 + 信任栅栏绕过 + 认证门禁**，装在电脑的 dsh 里。它的源码注释说明了为什么不可替代：

> DSH 的 /api 浏览器信任栅栏只认 loopback（127.0.0.1）或 `--trusted-host` 白名单，
> 且官方禁了 0.0.0.0 绑定。本代理把入站请求的 Host / Origin / Referer / Sec-Fetch-Site
> 统一改写成 loopback 权威，转发给本机 dsh web——栅栏永远看到 loopback。

**决定了什么**：
1. 手机要够到电脑上的 dsh，除了这条路几乎没有正路 → 必须融合它；
2. **它是 GPL-2.0**（README 徽章写着 MIT，但 LICENSE 与 package.json 都是 GPL-2.0）→
   为了保持 shou 是 MIT，绝不复制它的代码，只当外部依赖；
3. dsh 的 `/api` 线上协议没有任何文档，且 dsh 还在 0.1.x-alpha、一个发布周期内断过两次客户端契约 →
   **dsh 侧用 WebView 渲染它自己的界面**（天数级工作量、100% 保真），而不是自己写一套原生 dsh UI。

## 三、最终架构

一个 uni-app 客户端 + 统一的"端点"抽象，三类端点共用一套页面：

```
shou（uni-app，HBuilderX）
├─ ZCode 端点（原生 UI）
│    └─ 中继客户端：HMAC 握手 → JSON 信封 → 工作区桥接 → v4 RPC
├─ dsh 端点（WebView 面板，plus.webview 多实例常驻）
│    ├─ 电脑端：经 dsh-pocket 的局域网 / 隧道地址
│    └─ 手机本机：127.0.0.1:3080（dsh-phone Shizuku 版）
└─ 统一层：端点清单 / 扫码导入 / 状态灯 / 会话总览 / 通知 / 保活 / 应用锁 / 双语 / 主题
```

**没有自建服务端。** 第一版计划里有一个电脑端 Node 服务，后来砍掉了：
dsh 的中转由 dsh-pocket 承担，ZCode 直连中继不需要中转。它只在**小程序版**里会重新出现——
小程序的请求域名必须是自己备案的，届时需要一台自己的服务器做中转。

## 四、v0.1.0 范围

**做**：端点管理与导入、ZCode 任务列表与会话时间线、dsh 面板、会话总览、通知、保活、应用锁、
中英双语、主题三档、中继协议（认证 + 信封 + 桥接 RPC 编解码）、102 项内核单测。

**不做**：小程序端（后续）、App 内一键部署 dsh 运行时（需原生插件）、原生前台服务保活、
指纹/面容识别（需原生插件，先用自绘口令锁）、dsh 侧的文件下载（dsh-pocket 只有 4MB 文本读取）。

**明确标注为未验证**：中继的写入通道（远程发送 / 审批）。协议形状按官方开源代码还原，
但没在真机上跑通，所以默认关闭，藏在一个"实验性写入"开关后面。

## 五、协议还原的依据

不靠猜，靠三份材料逐行核对：

1. **本仓库早期的逆向笔记**（`docs/relay-protocol.md`，同一作者、同一个仓库的历史）——
   认证握手、关闭码、`data.payload` 的两种形态、两段式协议；
2. **官方 OSS 仓库**（zai-org/ZCode，构建时拉取核对）——
   `RequestType`/`ResponseType` 枚举、VQL 与 DataType 序列化、13 字节帧头、
   `ChannelClient` 的 Initialize 握手、服务通道名 `zcode-agent`、
   v4 方法名（`v4/controller/subscribe`、`v4/conversation/rowsRange`、`v4/command`…）；
3. **官方前端 bundle**（早期笔记里记录的常量与参数语义）。

## 六、里程碑与落地情况

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 工程骨架、身份文件、许可与署名 | 完成 |
| M1 | 客户端内核 + 中继编解码 + 单测 | 完成（102 项全绿） |
| M2 | 端点列表与扫码/粘贴导入 | 完成 |
| M3 | ZCode 任务列表与会话时间线 | 读路径完成，写路径待真机验收 |
| M4 | dsh 面板（多实例常驻、PIN 注入、重试） | 完成 |
| M5 | 总览、通知、保活、应用锁、双语 | 完成 |
| M6 | 打包配置、文档、真机验收 | 配置与文档完成，**真机验收待用户执行** |

真机验收需要的东西（ZCode 桌面端的配对二维码、装了 dsh-pocket 的电脑、装了 dsh-phone 的手机）
在开发机上不具备，因此这一步必须由用户完成。清单见 `docs/VERIFY.md`。
