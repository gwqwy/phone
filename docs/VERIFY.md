# 验收状态

这个文件的作用是**避免把"写完了"当成"能用"**。开发机上没有 ZCode 桌面端配对二维码、
没有装了 dsh-pocket 的电脑、也没有装了 dsh-phone 的手机，所以下面标着「待真机」的部分
必须由你在手机上验收之后才算成立。

## 一、已通过单测（`npm test`，102 项）

不需要 HBuilderX，纯 Node 跑：

| 覆盖 | 关键不变量 |
|---|---|
| `tests/crypto.test.js` | SHA-256 / HMAC-SHA256 命中标准测试向量（含 RFC 4231 超长 key）；base64url 无填充 |
| `tests/url.test.js` | 链接解析保留端口与路径、没写端口时不凭空长出 `:443`；拒绝非 http(s) 与畸形输入；`+` 解成空格、编码不用 `+`；私有/保留地址识别（含 CGNAT、IPv4-mapped IPv6） |
| `tests/pairing-link.test.js` | `sid`/`hash` 必填；未知参数原样保留；重建时**只换 `t`**、`hash` 的 `=` 重新编码为 `%3D` |
| `tests/dsh-link.test.js` | 地址来源分级（本机/局域网/公网）；`?token=` 提取为密码且不残留在参数里；身份键忽略密码差异 |
| `tests/endpoint-store.test.js` | 同 sid 去重不产生第二张卡；换链接保留 id/创建时间/自定义名字；重排拒绝丢 id/重复/未知 id 且拒绝后原顺序不变；删除同时清理"上次停留" |
| `tests/session-index.test.js` | 两路索引的字段权威划分；运行中优先、无时间戳排最后；**待办计数不参与排序**；按本地日历日分组（23:50 与次日 00:10 算两天）；置顶不与日桶重复 |
| `tests/event-differ.test.js` | 0→>0 才通知、2→1 不打扰、归零才撤回；首见待办要通知、**首见终态不通知**；空帧不抹状态 |
| `tests/relay-led.test.js` | 可恢复错误码不变灯、未知错误码判终态；九条终态关闭原因；只有主文档 4xx/5xx 才算异常 |
| `tests/rpc-wire.test.js` | VQL 编码边界（0/127/128）；值往返；**13 字节帧头大端布局**；半包不消费帧头、粘包逐帧拆出；Initialize 之前请求排队 |
| `tests/topics.test.js` | 帧文本拒绝 SSE/HTML；`zcode_type` 信封与 topic 帧的深度受限查找；任务/会话 delta（含归档、移除、快照、`meta.status` 回落）；**分片重组按字节拼接**（多字节字符跨片不坏） |

## 二、已完成但**未在真机验证**

### 中继数据面（ZCode）

| 能力 | 可信度 | 说明 |
|---|---|---|
| 认证握手（auth_init → challenge → response → ack） | 高 | 依据同仓库早期逆向笔记，那条笔记记录过 `auth_ack + pair_status=matched` 的实测 |
| JSON 信封（bootstrap / workspace-list / platform / bridge-open） | 中高 | 早期笔记记录过 bootstrap-response 实测到达 |
| 桥接 RPC 编解码（VQL + DataType + 13 字节帧 + ChannelClient） | 高（编码层） | 逐行对照官方 OSS 核对，往返自测通过；但**没和真实桌面端对上过** |
| 通道名 `zcode-agent`、v4 方法名 | 中 | 取自官方 OSS 的 `ServiceChannels` 与 v4 transport 常量，但"哪个通道承载 v4"这一步是推论 |
| **远程发送 / 审批（写路径）** | **低** | 命令信封的字段名与必填项未核对过。**默认关闭**，藏在「设置 → 实验性写入」后面 |

### dsh 面板

面板本身只是把地址交给 WebView 显示，机制简单、风险低。未验证的是真机上的三件事：
首屏时长、明文 HTTP 是否被系统拦截、以及 WebView 的 cookie 能否长期维持登录态。

### 平台相关

- **通知撤回**：HTML5+ 只能整体 `clear()`，没有按 id 撤回。实现策略是"活跃槽位清空才 clear"，
  多个待办同时存在时撤回是不精确的。要精确撤回需要原生插件。
- **保活**：只用 `plus.device.setWakelock` + 电池白名单引导。没有前台服务，
  系统在内存紧张时仍可能冻结后台。
- **应用锁**：自绘口令 + 加盐摘要。它是**界面锁不是加密**——挡的是拿到你手机的人随手翻开 App。

## 三、请在手机上按这个顺序验收

1. **导入**：扫 ZCode 二维码 → 首页出现卡片，状态从「连接中」变成「已连接」。
2. **任务列表**：进入端点 → 看到任务，按今天/昨天/更早分组，运行中的在最前。
3. **会话内容**：点进一个任务 → 看到历史（正文/思考/终端/编辑）。
   **读不到时进「诊断」页（任务列表右上角）→ 点「复制全部」→ 把内容发我。**
   诊断页会显示：桥接是否就绪、用的工作区键、任务里有多少条带完整路径、
   以及完整的收发帧日志。这三项足以定位是桥接没开、还是通道名/方法名不对。
4. **实时**：在电脑上让 agent 干点活 → 手机上状态与时间跟着变。
5. **通知**：让 agent 触发一次审批 → 出现通知；在电脑上处理掉 → 通知消失
   （若同时有多个待办，见上面的限制）。
6. **dsh 面板**：添加 `http://127.0.0.1:3080`（或局域网地址）→ 面板能打开、
   显示的就是电脑上的界面、断线后能重试。
7. **后台**：切到后台 5 分钟再回来 → 连接还在，状态没有回退。
8. **锁屏**：设置口令 → 杀掉 App 重开 → 要求输入口令；输错有提示，输对能进。

### 诊断页还有一个用途

「试探桌面端方法」那几个按钮会拿阶段一的通用方法代理（`platform-request`）
去问桌面端有没有 `session/list` 这类方法。**如果桌面端答了**，读会话就能完全绕开桥接 RPC
（少一层没验证的二进制协议）；如果全都超时不答，说明必须走桥接，我们就照着日志修桥接。
两条路的结论都只需要你点一下按钮。

## 四、首次真机反馈后修掉的问题

反馈是"能连接，但看不到会话内容"。逐条查下来是三类问题，都不在连接层而在数据面：

**1. 桥接用的工作区键传错了（主因）**

传的是 basename（`demo`），而中继要的是完整键（`W:\ws\demo`）。桌面端因此不会回
`workspace-bridge-ready`，界面只能一直等。修法：任务行与会话行都保留 `workspaceKey`，
显示仍用 basename；取键按"任务行 → bootstrap 的 activeWorkspaceKey → 会话主题路径"三级兜底。
`tests/workspace-key.test.js` 把这条不变量钉住了。

**2. `rowsRange` 的参数形状根本不对**

最初写的是 `{sessionId, from, limit}`——`from` 这个字段在协议里**不存在**。
对照 OSS 的 `v4ConversationRowsRangeParamsSchema` 后改成真实形状：

```ts
{ sessionId: string, beforeRowId?: number, limit: number /* 1..200，必填 */ }
```

`beforeRowId` 是"取 rowId 小于它的行"的向上游标，省略即从当前尾部向前。
返回形状也一并核对为 `{rows, atSeq, atRevision, atLogEpoch, hasMore}`，rows 按 rowId 升序。

**3. 通道请求没有超时**

通道名或方法名猜错时桌面端可能**根本不回**，没有超时的话 promise 永不 settle，
界面就停在空白上、拿不到任何线索。现在 10 秒超时并给出"通道名或方法名可能不对"的提示。

**顺带补上的两件事**：

- 桥接就绪后主动 `controller/subscribe` 与 `conversation/subscribe`——会话索引是订阅型的，
  不订阅桌面端不会推；
- 桥接就绪后发 `clientHello`（`clientKind: 'mobileRemote'`）。OSS 注释写明 subscribe 的
  `clientMode` 由 host 从该连接的 clientHello 注入，所以这一步可能是订阅被接受的前提。

**时间线现在按真实行模型渲染。** OSS 里 `conversationRowSchema` 是按 `kind` 判别的 9 种联合
（`turnHeader` / `userInput` / `assistantText` / `reasoning` / `toolCall` / `artifact` /
`subagent` / `hookInvocation` / `timelineMarker`），字段名已逐一核对并落成
`client/core/rows.js` 与 `tests/rows.test.js`——正文、思考（含时长）、终端、编辑、
产物（含体积）、子智能体各按各的样子显示，认不出的 kind 原样展示 JSON 而不是静默吞掉。

## 五、`pair_status: waiting` 是什么意思

真机日志里出现过这个状态，它很容易被误读成"网络不通"，其实含义很具体：

```
→ auth_init … → auth_challenge … → auth_response …
← auth_ack {"terminal_sid":"t_…","pair_status":"waiting"}
```

拿到 `terminal_sid` 说明**手机 ↔ 中继这一侧完全正常**，认证已经通过。
`waiting` 是中继在说："这个 `device_sid` 我认识，但电脑端自己那条中继腿不在线。"
所以此刻不该发 bootstrap（发了也没人执行），任务数自然是 0、连接灯只能停在"连接中"。

两种成因：

1. **二维码换版了**——电脑端每次重开远控会话都会签发新的 `sid`，而我们手里存的是旧的，
   中继无法把它和电脑端那条腿对上。诊断页现在会显示完整的 `sid`，可与电脑端二维码比对。
2. **远控页面没真正持有连接**——页面看着是开着的，但那条腿已经掉了。

处理方式（v0.1.0 已实现）：`waiting` 期间每 **15 秒重新握一次手**，所以电脑端那条腿一回来，
不用碰手机，状态会在 15 秒内自己翻成"已连接"。
之所以用重新握手而不是官方的 `pair_status_query`：早期笔记记录过那条查询发得不对会被直接
`KICKED`，而重新握手是安全的（日志已证明它稳定返回 `auth_ack`）。

诊断页还有一个**交叉验证**按钮：把配对链接（带新时间戳）复制出来，粘进手机浏览器打开官方页面。
官方页面能列出任务 = 链接是好的、问题在 shou；官方页面同样停在等待 = 电脑端那一侧确实没上线。
注意两者共用同一个 `sid`，同时开会互相踢掉，测完关掉浏览器页面即可。

## 六、桥接被拒：`远程 workspace 不在当前窗口中，无法重连`

第二轮真机日志里，电脑端**明确回答了**，而我的代码把失败记成了成功：

```
← {"zcode_type":"workspace-reconnect-response","success":false,
   "error":"远程 workspace 不在当前窗口中，无法重连: E:\\文件\\编程文件\\zcode phone"}
· workspace-reconnect ok        ← 这行是错的：压根没看 success 字段
```

同一份日志还暴露了两个发包重复的问题：任务列表页与会话页各调了一次 `ensureBridge`，
于是同一毫秒发了两个 `workspace-reconnect`（requestId `-3` 与 `-4`）；两个回应又各触发一次
`bridge-open`，于是 `#1 #2` 同样在同一毫秒连发。

已修：

1. 检查 `success`，把电脑端的原话**原样**显示在会话页（`电脑端拒绝了这次请求（原话）：…`）；
2. 同工作区在途时 `openWorkspaceBridge` 直接返回既有桥接，不再重发；
3. `bridge-open` 500 毫秒防抖；被明确拒绝后只试一次就如实上报，不再空转四轮。

### 那个「当前窗口」到底是什么

目前只能确定：电脑端有一个"窗口"的概念，而它认为我们给的工作区不在其中。
注意 bootstrap 自己回的 `initialViewState.activeWorkspaceKey` 就是这个路径，
所以"电脑端当前活动的工作区"与"当前窗口里的工作区"**未必是同一件事**。

一条新线索来自日志：`workspace-list: workspaces=8 tasks=11`——回复里有一个**独立的
`workspaces` 数组（8 条）**，与 11 个任务不是一回事，而我一直只用了任务里的 `workspacePath`。
重连要的键很可能出自那个数组。因此现在优先从权威数组换键（按路径或标签匹配，
Windows 大小写与尾斜杠容错），并把它第一条的原始结构写进诊断日志——下一次真机反馈
就能确认那个字段的真名。

## 七、偶发「配对已失效」是怎么来的（已修）

真机反馈：电脑端连接一直没变，手机却有时显示「配对已失效」。这是**我们自己的 bug**：

```js
terminal: LED_ERROR === onFrameRoot({ type: 'error', code: reason })
```

把 WebSocket 的**关闭原因字符串**当成错误码丢进错误码判定函数。任何一次关闭（reason 甚至是空串）
都不在"可恢复/被接管"名单里，于是落进"未知错误码 = 终态"分支，状态被写成 `expired`，
界面就显示「配对已失效」。网络一抖就误报，就是这么来的。

现在改为 `isTerminalClose(code, reason)`：先看原因文本、再看官方关闭码
（4004/4009/4010/4011/4012/4013），两者都没有就**不算终态**——默认偏袒自动重连，
因为误判成终态会逼用户去重新扫码，而重连判错的代价只是多试几次。

## 八、`workspace-reconnect` 用错了（已移除）

第六节记过电脑端的拒绝理由：「远程 workspace 不在当前窗口中，无法重连」。
查 `packages/shared/src/remote-workspace-identity.ts` 才明白这句话的意思：

```ts
export type RemoteWorkspaceIdentityKind = "ssh" | "wsl" | "docker";
export function isRemoteWorkspaceIdentity(identity): boolean
```

**ZCode 里"远程 workspace"指的是跑在 SSH / WSL / Docker 上的工作区**，跟手机远控毫无关系。
那条请求是我上一轮的错误假设——拿一个本地路径去问它，注定被拒。

已移除该步骤。现在直接发 `workspace-bridge-open` 并有限重发（3 次），无回应则如实上报。

## 九、读取路径改为两条都试

`bridge-open` 在真机上**完全没有回应**（既不是拒绝也不是接受）。而早期协议笔记里
其实写过一条我没重视的结论：**"数据面即 bootstrap/platform-request 通道，无需 VSCode RPC 栈"**。
`platform-request {requestId, method, args}` 是一层通用方法代理，而 v4 方法名已经从 OSS 拿到。

所以 `readRows` 现在两条路都试：桥接通道优先，拿不到就改走
`platform-request` + `v4/conversation/rowsRange`（参数 `{sessionId, limit}`，`limit` 必填）。
界面会显示内容**是从哪条路读到的**（经桥接通道 / 经 platform-request），
诊断页也有一个"用 platform-request 读这条会话"的按钮专门验证这条路。

内容不再依赖桥接就绪——桥接现在只负责实时订阅。

## 十、已知的空白

- **新建任务**（在桌面端建一条全新会话）没有做进界面：它依赖同一个未验证的写入通道，
  我不想同时上两个没验证的入口。
- **dsh 侧的统一时间线与总览**：dsh 端点在 v0.1.0 里只是"把电脑界面装进口袋"，
  没有进入 shou 的原生总览面板。要做到那一步需要先摸清 dsh 的 `events.mux` 事件流。
- **小程序端**：代码按 `uni.*` 跨端写，但没有做小程序验收。小程序不能连手机本地回环地址，
  所以 dsh 本机端点在那边不可用；ZCode 侧需要一个自己的中转服务器（域名要备案）。
