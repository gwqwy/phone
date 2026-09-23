# ZCode 官方中继协议逆向笔记（实测验证）

> 目标：让自建客户端凭配对链接直连官方中继，获得与官方 remote/v4 页面等价的能力
> （工作区/任务/会话流/发送/审批——执行方是桌面端自身，不受本地 headless 的账号限制）。
> 状态：**认证已打通（auth_ack + pair_status=matched）**；数据面（VSCode RPC 栈 + v4 方言）为下一里程碑。

## 1. 端点与配对

- 中继：`wss://zcode.z.ai/ws`（备用源 `wss://zcode.chatglm.site/ws`）
  来源：remote/v4 前端 bundle（`/remote/v4/3.14.3/assets/src-dNkcRypW.js`）常量。
- 配对链接参数 → 语义（前端解析函数）：
  `sid→deviceSid`、`hash→passHash`、`t→timestamp`、`mid→deviceMid`、`name→deviceName`、`app_version→appVersion`
- 关闭码：`SessionNotFound=4004`、`SessionConflict=4009`、`DesktopDisconnected=4010`、
  `SessionExpired=4011`、`WorkspaceClosed=4012`、`InvalidMobileConnection=4013`；文本 error 帧 `KICKED`。

## 2. 认证握手（已实测通过 ✅）

1. `→ {type:"auth_init", role:"terminal", device_sid, meta:{platform:"web", version:appVersion, name:"mobile-browser"}, client_ts}`
2. `← {type:"auth_challenge", nonce}`
3. `→ {type:"auth_response", device_sid, proof, client_ts}`
   **proof = base64url(HMAC-SHA256(key=passHash, msg=`${nonce}|terminal|${deviceSid}`))**
   （官方实现：`sVn`，crypto.subtle HMAC，`|` 分隔；`terminal` 为角色字面量）
4. `← {type:"auth_ack", pair_status:"waiting"|"matched"}`（后续 `pair_status_ack` 同结构）
   - `waiting`：桌面端中继腿不在线（配对链接过期/远控未激活）
   - `matched`：桌面在线，通道可用 ✅（2026-09-23 实测）
5. 心跳/查询：`{type:"pair_status_query", device_sid, client_ts}`（注意：单独发即被 `KICKED`，
   疑似须与官方客户端的状态机时序配合——实现时按官方前端时序或完全模拟）
6. 数据帧：`{type:"data", payload:…}`（见下）；错误 `{type:"error", code, message}`。
7. **data.payload 的两种形态**（实测确认）：
   - `rpc-frame`：`{zcode_type:'rpc-frame', bridgeSessionId, bridgeGeneration, recoveryId, seq, dataBase64}`
   - 内层 JSON 信封：`{zcode_type:'bootstrap-request'|'bootstrap-response'|'platform-request'|…, requestId, …}`
     —— **bootstrap 必须走此形态**；裸发顶层帧（无 type/data 包裹）会被中继拒绝 `WRONG_PARAM` 并断链（实测）。
   - 配对后应答第一个动作：`{type:'data', payload:{zcode_type:'bootstrap-request', requestId}}` →
     桌面端回 `{type:'data', payload:{zcode_type:'bootstrap-response', requestId, result}}`。

## 3. 数据面信封（data 帧，外层已确认）

```jsonc
{ "type": "data", "client_ts": 0,
  "payload": { "zcode_type": "rpc-frame",
               "bridgeSessionId": "<uuid>", "bridgeGeneration": 0,
               "recoveryId": "<uuid>", "seq": 0,
               "dataBase64": "<base64>" },
  "server_ts": 0 }
```

- 入站须回 `{zcode_type:"rpc-frame-ack", ackMessageSeq, ...identity}`
- 大消息分片重组（frameAssembly，按 bridgeSessionId/generation/recoveryId 校验，
  无效即进入 degraded 终态）
- `dataBase64` 内层 = VSCode 风格二进制 RPC（`packages/rpc/src/protocol.ts`）：
  **13 字节帧头** `{type:u8(Regular=1), id:u32BE, ack:u32BE, length:u32BE}` + payload；
  ChunkStream 处理粘包；PersistentProtocol 增补 ACK/重连/KeepAlive(type=9)/ReplayRequest(6)。

## 4. 内层 RPC（待实现）

- Channel 层（`packages/rpc/src/channelClient.ts`）：`serialize([type, id, channelName, name])` +
  `serialize(arg)` 的 JSON 字符串序列化（BufferWriter，u32 长度前缀），响应 `{[ResponseType, id], data}`，
  首帧 `Initialize` 握手。
- v4 方言（`packages/shared/src/zcode-protocol-v4/`，OSS 内完整可用）：
  - `clientHello {kind, protocolVersion:3, clientId, clientKind:"mobileRemote", appVersion, capabilities?}`
  - 订阅：`v4/controller/subscribe`（sessions-index）、`v4/conversation/subscribe|rowsRange`
  - 实时：通知 `v4/conversation/frame`（TopicWireFrame，kind:complete/fragment，需重组）
  - 写路径：`v4command` 信封（sendText/stop/resolveInteraction/createSession…，
    15 个 CAS 命令需带 baseRevision）
  - 任务实时镜像：`packages/shared/src/task-realtime.ts`
- 规模估计：忠实复刻 = RPC 栈 ~500 行 + v4 客户端 ~800 行 + 分片/ACK 状态机；OSS 有全部类型定义。

## 5. 实测记录

| 时间 | 结果 |
|---|---|
| 2026-09-23 | auth_ack + `waiting`（桌面腿离线，链接为旧配对） |
| 2026-09-23 | 发 `pair_status_query` 后被 `KICKED`（时序/占用，待实现时按官方状态机处理） |
| 2026-09-23 | 复连后 `auth_ack + pair_status="matched"`（桌面腿在线）✅ |
| 2026-09-23 | matched 后裸发顶层 `bootstrap-request` → `WRONG_PARAM` + 断链；已修正为 data.payload 内层 JSON 形态 |
| 2026-09-23 | 桌面腿随「远程控制」页面开关浮动（matched↔waiting）；官方页面在线会挤占同一 sid（KICKED 根因） |

## 6. 落地形态（建议）

`adapters/zcode-relay/`：把配对链接存入 `.data/config.json`（`relayPairingUrl`），
适配器完成 auth → channel → v4 客户端，向手机端提供**全能力**（含远程发送与审批，
执行方为桌面端自身）。链接过期（SessionExpired/4011）时提示用户在桌面端重新生成配对码。

## 7. 参考

- 官方前端 bundle：`https://zcode.z.ai/remote/v4/3.14.3/assets/*`（入口 `index-NjWRUABD.js`，连接模块 `src-dNkcRypW.js`）
- OSS：`packages/shared/src/zcode-protocol-v4/{transport,core,command}.ts`、`task-realtime.ts`、
  `packages/rpc/src/{protocol,channelClient,persistent-protocol}.ts`
- 本仓库探针：`server/scripts/probe-relay.ts`（host 白名单：仅官方中继域名）
