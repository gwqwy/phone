# shou

**把编码智能体装进手机。** 一个 uni-app 客户端，同时接管三件事：

| 端点类型 | 智能体在哪 | shou 怎么接 |
|---|---|---|
| **ZCode 桌面端** | 你电脑上的 ZCode | 原生界面，凭桌面端出示的配对链接直连官方中继 |
| **dsh 电脑端** | 你电脑上的 DeepSeek Harness | 面板里直接显示 dsh 的界面（经 dsh-pocket 暴露） |
| **dsh 手机本机** | 手机自己的 Termux + Node | 面板指向 `127.0.0.1:3080`，配合 dsh-phone（非 root）使用 |

深色为默认主题，支持 **深色 / 浅色 / 跟随系统**；中英双语。

---

## 快速开始

### 1. 手机端

用 **HBuilderX** 打开 `client/` 目录（标准 uni-app 布局），然后：

- 调试：「运行 → 运行到手机或模拟器」
- 发行：「发行 → 原生 App-云打包」

> 云打包前需要在 HBuilderX 里登录并点一下 `manifest.json` 的「重新获取 appid」（`appid` 目前是空的，
> 它由 DCloud 分配，无法由代码预填）。包名已设为 `com.shou`。

### 2. 电脑端（想要哪个就配哪个）

**要远控 ZCode**：在电脑端 ZCode 打开「移动端远程控制」，出示二维码 → 在 shou 里扫码导入。
链接只在桌面端那个页面开着的时候有效，关掉页面中继腿就离线了（shou 会显示「等待桌面端」）。

**要远控 DeepSeek Harness**：

```sh
npm install -g @deepseek-ai/dsh          # 若尚未安装
dsh plugin --profile web add dsh-pocket -w
npx @deepseek-ai/dsh web
```

然后按 dsh-pocket 的说明开启局域网或隧道访问，把地址或带 `?token=` 的链接粘进 shou。
详细步骤见 [docs/SETUP.md](docs/SETUP.md)。

### 3. 手机本机跑 dsh（非 root）

安装 [dsh-phone](https://github.com/railgun0325/dsh-phone) 的 **Shizuku 版**并完成一键部署，
然后在 shou 里添加 `http://127.0.0.1:3080`。这一步不需要 root，但需要一次性的无线调试配对。
细节与平台约束见 [docs/SETUP.md](docs/SETUP.md)。

---

## 现在能做什么、还不能做什么

**已实现并通过单测**：端点导入与去重、扫码/粘贴、重命名/换链接/删除/排序、连接状态灯、
会话索引（两路数据合并、排序、日期分组、相对时间）、通知差分（审批 0→>0 才通知、归零才撤回、
首见终态不通知）、应用锁、主题与双语、dsh 面板多实例常驻、中继认证握手与桥接 RPC 编解码。

**还需要在真机上验收**：中继的数据面（任务列表 / 会话历史 / 远程发送与审批）。
发送与审批默认**关闭**，在「设置 → 实验性写入」里打开——协议按官方开源代码还原，
但没在真机上跑通过，我不想把点了没反应的按钮摆到你面前。当前状态见 [docs/VERIFY.md](docs/VERIFY.md)。

---

## 开发

```sh
npm test          # 内核单测（102 项，纯 Node，不需要 HBuilderX）
```

`tests/` 覆盖的是**行为不变量**：配对链接的解析与重建、端点去重与保序、会话索引的合并优先级、
排序与分组边界、通知差分状态机、VQL 与 13 字节帧的往返、粘包/半包拆帧、分片重组（含多字节字符跨片）。

```
client/                HBuilderX 项目（用 HBuilderX 打开这个目录）
  core/                纯逻辑：链接解析、端点仓库、会话索引、通知差分、协议编解码、HTTP 工具
  api/                 中继客户端、会话管理、dsh 面板、通知、保活
  store/               全局状态与持久化
  pages/               端点列表 / 导入 / 任务 / 会话 / 面板 / 总览 / 设置 / 锁屏
  theme/               主题令牌
tests/                 单测（node --test）
tools/                 探针与诊断脚本
docs/                  计划、上游笔记、配置指引、验收状态
```

---

## 许可与署名

shou 以 **MIT** 发布。它汇集三个上游项目，其中两个 MIT、一个 GPL：

- [pjpv/zremote](https://github.com/pjpv/zremote)（MIT）—— ZCode 远控的产品行为与不变量
- [railgun0325/dsh-phone](https://github.com/railgun0325/dsh-phone)（MIT）—— 手机本机跑 dsh 的非 root 路线
- [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（**GPL-2.0**）—— 电脑端 dsh 的远程访问

**dsh-pocket 是外部依赖，不是本项目的组成部分**：shou 不包含也不修改它的任何代码，
只把它当作运行在你电脑上的独立程序来访问。这正是 shou 能以 MIT 发布的原因。
详见 [NOTICE](NOTICE)。
