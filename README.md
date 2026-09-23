# ZCode Phone — 手机远控编码智能体

在手机浏览器里查看/操控电脑上的编码智能体（ZCode、DeepSeek Harness 等）。
深色为默认主题，支持 **系统默认 / 深色 / 浅色** 三档切换；界面与交互对齐 ZCode 官方远程控制。

![架构](docs/architecture.txt)

```
手机 uni-app H5 ── HTTP + WebSocket（JSON 帧，PIN 认证）──▶ 电脑端 Node 服务
                                                              │ HarnessAdapter（预留扩展接口）
                                                              ├─ adapters/zcode    ← v1 已实现
                                                              └─ adapters/template ← DeepSeek Harness 要点
```

## 功能

- **工作区/任务列表**：按工作区分组的任务卡，实时状态徽标（进行中/已完成/待确认/出错）、相对时间、置顶排序、下拉刷新
- **任务会话时间线**：用户消息、AI 正文、🧠 思考（含时长）、✏️ 文件编辑（+增 -删）、🖥 终端命令、📦 变更集、审批卡片；桌面端正在跑的任务也能实时看到推进（2s 轮询 + 订阅双通道）
- **新建任务**：选工作区（按最近使用排序）+ 任务描述 → 远程下发
- **长按任务菜单**：置顶 / 重命名 / 归档 / 标记未读 / 复制路径 / 复制会话 ID（存本地元数据层，与 harness 无关）
- **侧面板**：审查（会话增删统计 + 涉及文件清单）；终端 tab 预留
- **安全**：PIN 配对（首启 CSPRNG 生成，控制台+二维码可见）、常量时间比较、登录限速、Host 分级 fail-closed（本机回环免密 / 局域网 PIN / 公网域名按最强策略）、服务端重启自动全体重新登录
- **PWA**：手机浏览器「添加到主屏幕」即可当 App 用

## 快速开始

要求：电脑端 Node.js ≥ 23.6（建议 24+）。

```bash
# 1. 安装依赖
npm run setup

# 2. 构建手机端（首次）
npm run build:web

# 3. 启动
npm start
```

启动后控制台会打印：

```
本机:   http://127.0.0.1:3930
局域网: http://192.168.x.x:3930
PIN: 12345678
```

手机连同一 Wi-Fi，浏览器打开局域网地址 → 输入 PIN → 完成。
（也可用终端二维码/带 `?pin=` 的地址扫码直登。）

开发模式：

```bash
npm run dev:server   # 服务端 watch 重启
npm run dev:web      # 手机端 vite dev（API/WS 已代理到 3930）
npm test             # 服务端单测
```

## 配置（.data/config.json）

```jsonc
{
  "port": 3930,              // 占用自动 +1 顺延
  "host": "0.0.0.0",
  "clientDist": "…",         // H5 构建产物目录
  "zcodeCommand": "",        // zcode CLI 路径；留空自动探测桌面端内置 CLI
  "zcodeCwd": ""             // app-server 工作目录，默认用户主目录
}
```

`.data/` 其他文件：`pin`（访问口令）、`meta.json`（置顶/归档/别名等手机端元数据）、`server.log`。
公网访问可自行套 Cloudflare Tunnel/frp 等指向本服务端口（接口已预留，见路线图）。

## 接入新的 harness

见 [server/src/adapters/README.md](server/src/adapters/README.md)——实现 `HarnessAdapter`
接口（列表/历史/订阅/发送/审批等，按能力声明）并在 `server/src/index.ts` 注册即可，
手机端零改动。`adapters/template/` 内含 DeepSeek Harness（dsh web）的接入要点注释稿。

## 已知限制（当前版本）

1. **远程发送/新建任务受桌面版限制**：桌面端把模型账号"注入"它自己的进程，独立进程
   （含官方 headless 模式）拿不到模型，因此远程下发会得到明确提示。解锁路径（任一即可，
   代码已全部接线、无需再改）：
   - 在 `~/.zcode` 下配置**个人 API Key 提供方**（如 open.bigmodel.cn 的 key），适配器即可用该模型执行远程任务；
   - 等待 ZCode 开放本地服务/SDK 的账号通道（OSS 仓库 `zcode --web` / app-server 已具备全部会话接口）；
   - 公网隧道模式（路线图）。
2. **桌面端正在运行的会话**：可看列表与历史、可实时看到推进，但因运行时在桌面进程内，
   远程发送会提示先在桌面端处理。
3. **微信小程序**：代码已按 `uni.*` 跨端书写，未做小程序端验收。
4. 时间线中桌面端创建、从未在本服务进程激活过的会话，历史读取走只读 SQLite 快照。

## 路线图

- [ ] Cloudflare Tunnel 公网访问（移植 dsh-pocket 的 cloudflared 方案）
- [ ] 交互式终端 tab（复用 ZCode terminal-client 通道）
- [ ] DeepSeek Harness 适配器（按 template/ 注释稿）
- [ ] 桌面端通知（任务完成/等待审批推送到手机）

## 目录结构

```
server/            Node.js ≥ 23.6 · TypeScript（原生直跑，无需编译）
  src/core/        统一协议 + HarnessAdapter 接口 + 元数据覆盖层
  src/adapters/    zcode（v1）/ template（下一个接入的骨架）+ 开发指南
  scripts/         协议探测与 E2E 脚本（开发用）
  test/            单元测试（node --test）
client/            uni-app Vue3 + Vite（H5 优先，保持小程序兼容）
  src/pages/       登录 / 工作区列表 / 任务会话
  src/components/  时间线行、侧面板、长按菜单、新建任务、主题切换
.reference/        参考仓库克隆（gitignore：dsh-pocket、zcode OSS）
.data/             运行时数据（gitignore）
```
