# VoiceApp — 高质量多人语音通讯

3–5 人小队语音，目标：低延迟、强降噪、可一键部署、桌面端打包成 Windows `.exe`。

```
┌─────────────────────┐      ws/wss       ┌──────────────────────┐
│  Tauri 桌面客户端    │  ◀──────────────▶ │  LiveKit Server (SFU) │
│  React/TS + Rust     │   WebRTC(Opus)    │  Go 编写，Docker       │
│  + AI 降噪           │                   └─────────┬────────────┘
│  - AudioWorklet 降噪 │                             │ token / 信令
│  - DeepFilter/DTLN   │   HTTP (token+TURN)          ▼
│    (Rust→WASM 可选)  │  ◀──────────────▶ ┌──────────────────────┐
└─────────────────────┘                   │  Go 后端              │
        ▲                                 │  Auth/Token/房间/SQLite │
        │ TURN (对称 NAT 穿透)            └─────────┬────────────┘
        └────────────── coturn (STUN/TURN) ◀────────┘
```

## 目录结构

```
APP/
├── docker-compose.yml          # LiveKit + coturn + Go 一键启动
├── config/
│   ├── livekit.yaml            # LiveKit 配置 (key/secret 必须与 .env 一致)
│   └── turnserver.conf         # coturn 配置
├── server/                     # Go 后端
│   ├── cmd/voiceapp/main.go    # 入口
│   └── internal/
│       ├── api/                # HTTP: /join /leave /rooms /health + CORS
│       ├── config/             # 环境变量
│       ├── db/                 # SQLite (房间/参与者历史)
│       ├── lkauth/             # LiveKit JWT 签发
│       └── turn/               # coturn 短时凭证 (REST shared-secret)
└── client/                     # Tauri v2 桌面端
    ├── src/                    # React/TS UI + 降噪管线
    │   ├── lib/denoise.ts      # MicPipeline (Web Audio → Worklet)
    │   └── lib/useVoiceRoom.ts # LiveKit 连接 / 发布 / 静音
    ├── public/
    │   ├── worklets/denoise-processor.js  # 实时降噪 (DSP + 可选 WASM 模型)
    │   └── wasm/               # 放入 RNNoise/DTLN/DeepFilterNet WASM 即启用 AI 模式
    └── src-tauri/              # Rust 层：降噪设置 / DSP 参考 / 模型发现
        └── src/denoise.rs
```

## 降噪模式（全部支持开关，UI 一键切换）

| 模式 | 实现 | 说明 |
| --- | --- | --- |
| **Off** | 原始麦克风 | 不做任何处理 |
| **Basic** | 浏览器 `noiseSuppression` + `echoCancellation` + `AGC` | 一行配置，零成本 |
| **Smart（推荐）** | AudioWorklet 实时处理 | 内置自适应噪声门 + 高通；可升级到 RNNoise/DTLN/DeepFilterNet（Rust 编译成 WASM） |

- Smart 模式默认**保留浏览器 AEC（去回声）**，把“去噪声”交给 Worklet，鱼和熊掌兼得。
- **Strength 滑块**实时生效（AudioParam，无需重新发布）。
- 切换模式 / 模型会自动重建管线并重新发布（无需离开通话）。

为什么实时降噪在 Worklet 而不在 Rust 主进程：音频每帧（128/480 样本）若跨 IPC 进 Rust 处理会引入不可接受延迟。因此**实时路径在 Web Audio 音频线程**；Rust 层作为：① DSP 算法单一事实来源（`denoise.rs`，与 worklet 数学一致）② 离线/批量处理 ③ 编译出 WASM 模型供 worklet 调用。

## 一、启动后端（Docker Compose）

```bash
cp .env.example .env          # 务必改掉其中的 secret
# 把 .env 里的 localhost 换成你的服务器公网域名/IP，并配置 TLS（见下）
docker compose up -d --build
```

启动后：

- LiveKit 信令：`ws://<host>:7880`（生产建议套 TLS → `wss://`）
- coturn STUN/TURN：`3478/udp`、`3478/tcp`、`5349/tcp(TLS)`、`49152-49200/udp`
- Go API：`http://<host>:8080`
- 验证：`curl http://localhost:8080/api/health` → `{"ok":true,...}`

> **关于 TLS / 公网**：浏览器/Tauri 的 WebRTC 与 getUserMedia 需要“安全上下文”。
> 本地 `ws://localhost` 可用；公网请在 LiveKit 与 Go 前面加一层 Nginx/Caddy 做 HTTPS/WSS，
> 并把 `LIVEKIT_HOST` 设为 `wss://your.domain`，`TURN_DOMAIN` 设为你的域名。
> coturn 的 5349 端口若要 TURN/TLS，需挂载证书（见 coturn 文档）。

## 二、运行桌面客户端

```bash
cd client
npm install
# 开发（会自动启动 vite:1420 并打开 Tauri 窗口）
npm run tauri dev
```

打包成 Windows 安装包（在你装好 Rust + Tauri 前置依赖的 Windows 上）：

```bash
npm run tauri build        # 产物：client/src-tauri/target/release/bundle/{nsis,msi}/*.exe
```

客户端默认连 `http://localhost:8080`；改部署地址见 `client/src/config.ts` 的 `API_URL`，
或用 Vite 环境变量 `VITE_API_URL` 覆盖。

> 本地开发时浏览器直接跑 UI：`npm run dev` 然后开 `http://localhost:1420`
> （需要允许麦克风权限；Tauri 打包版无此限制）。

## 三、启用 AI 降噪（可选）

内置 DSP 已可用。要上 RNNoise / DTLN-rs / DeepFilterNet：

1. 把编译好的 `.wasm` 放进 `client/public/wasm/`，文件名对应 `src/config.ts` 的 `WASM_MODELS`：
   `rnnoise.wasm` / `dtln.wasm` / `deepfilter.wasm`
2. 要求的 WASM ABI（详见 `public/wasm/README.md`）：
   `exports.denoise_frame(inPtr, outPtr)` + `exports.memory`，每帧 480×f32 @48kHz。
3. 客户端 Engine 下拉选择对应模型；worklet 会自动 fetch+instantiate，失败回退内置 DSP。

参考算法（与 worklet 一致）在 `client/src-tauri/src/denoise.rs`，可用于离线处理或作为编译 WASM 时的基准。

## 降噪可落地性小结

- **基础模式**：`getUserMedia` 的 `audio: { noiseSuppression: true, echoCancellation: true }` —— 已实现（`client/src/lib/denoise.ts`）。
- **智能模式**：AudioWorklet 实时 AI 降噪（RNNoise 轻量 → DeepFilterNet3/DTLN-rs 高质量）—— 内置 DSP 已实时工作，WASM 模型按上面三步接入。
- **Tauri/Rust 层**：拥有降噪配置与 DSP 参考实现，并通过 WASM 间接参与实时链路（Rust 编译的模型在 Worklet 里跑）—— 已实现。

## 技术栈

- **SFU**：LiveKit Server (Go)
- **桌面**：Tauri v2 (Rust) + React/TS + `livekit-client`
- **TURN/STUN**：coturn（REST shared-secret，Go 签发短时凭证）
- **数据库**：SQLite（纯 Go 驱动 `modernc.org/sqlite`，无 CGO）
- **部署**：Docker Compose
- **协议**：WebRTC (Opus 音频)

## 常见问题

- **听不到对方**：检查 coturn 端口是否放行；同局域网通常用不到 TURN。Tauri 打包版需在 `capabilities/default.json` 允许的网络内。
- **回声**：开启 Smart 模式（默认 AEC on）；外放场景务必开 AEC。
- **键盘/风扇噪声**：切到 Smart 并调高 Strength；想极致再上 DeepFilterNet WASM。
