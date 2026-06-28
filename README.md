# Vox — 高质量多人语音通讯

3–5 人小队语音，低延迟、强降噪，桌面端打包成 Windows `.exe`。

> **架构简化**：Go 后端只做一件事——**签 LiveKit JWT**。
> SFU / TURN / STUN / ICE servers 全部由 **LiveKit Cloud**（或你自托管的 LiveKit server）提供。
> 没有 Docker、没有 coturn、没有 SQLite，单进程 Go 二进制 + 单文件安装包就够了。

```
┌─────────────────────┐      ws/wss       ┌──────────────────────┐
│  Tauri 桌面客户端    │  ◀──────────────▶ │  LiveKit (Cloud/自托) │
│  React/TS + Rust     │   WebRTC(Opus)    │  SFU + STUN + TURN   │
│  + AI 降噪           │                   └─────────┬────────────┘
│  - AudioWorklet      │   HTTP (token only)          │
│  - DeepFilter/DTLN   │  ◀──────────────▶ ┌──────────▼──────────┐
│    (Rust→WASM 可选)  │                   │  Go 后端（单进程）    │
└─────────────────────┘                   │  仅签 LiveKit JWT    │
                                           │  $ go run ./cmd/voiceapp│
                                           └─────────────────────┘
```

## 目录结构

```
APP/
├── README.md
├── .env.example                    # LiveKit 凭据 + 端口
├── server/                         # Go 后端（仅签 token）
│   ├── go.mod
│   ├── cmd/voiceapp/main.go        # 入口
│   └── internal/
│       ├── api/                    # HTTP: /join /leave /health + CORS
│       ├── config/                 # 环境变量
│       └── lkauth/                 # LiveKit JWT 签发
└── client/                         # Tauri v2 桌面端
    ├── src/                        # React/TS UI + 降噪管线
    │   ├── lib/denoise.ts          # MicPipeline (Web Audio → Worklet)
    │   └── lib/useVoiceRoom.ts     # LiveKit 连接 / 发布 / 静音
    ├── public/
    │   ├── worklets/denoise-processor.js  # 实时降噪 (DSP + 可选 WASM 模型)
    │   └── wasm/                   # 放入 RNNoise/DTLN/DeepFilterNet WASM 即启用 AI 模式
    └── src-tauri/                  # Rust 层：DSP 参考实现 + 模型发现
        └── src/denoise.rs
```

## 降噪模式（全部支持开关，UI 一键切换）

| 模式 | 实现 | 说明 |
| --- | --- | --- |
| **Off** | 原始麦克风 | 不做任何处理 |
| **Basic** | 浏览器 `noiseSuppression` + `echoCancellation` + `AGC` | 一行配置，零成本 |
| **Smart（推荐）** | AudioWorklet 实时处理 | 内置自适应噪声门 + 高通；可升级到 RNNoise/DTLN/DeepFilterNet（Rust 编译成 WASM） |

- Smart 模式默认**保留浏览器 AEC（去回声）**，把"去噪声"交给 Worklet。
- **Strength 滑块**实时生效（AudioParam，无需重新发布）。
- 切换模式 / 模型会自动重建管线并重新发布。

## 一、配置 LiveKit

1. 注册 **LiveKit Cloud**（免费额度够 3–5 人小队）：https://cloud.livekit.io
2. 新建 Project → 拿到：
   - `LIVEKIT_API_KEY`（如 `APIxxxxxxxxxxxxx`）
   - `LIVEKIT_API_SECRET`（生成时只显示一次，复制下来）
   - `LIVEKIT_HOST`（如 `wss://your-project.livekit.cloud`）

> 想完全自托管？装个 LiveKit Server（一条 `docker run livekit/livekit-server` 即可），把 `LIVEKIT_HOST` 换成你的 wss URL。Go 服务本身仍然**不跑** Docker。

## 二、启动 Go 后端

```bash
cp .env.example .env
# 编辑 .env 填入 LiveKit API key / secret / host
go run ./server/cmd/voiceapp
# 验证：
curl http://localhost:8080/api/health
# {"ok":true,"ts":...}
```

或 build 单文件：
```bash
go build -o voiceapp ./server/cmd/voiceapp && ./voiceapp
```

## 三、运行桌面客户端

```bash
cd client
npm install
# 开发（启动 vite + Tauri 窗口）
npm run tauri dev
```

打包 Windows 安装包（在装好 Rust + Tauri 依赖的 Windows 上）：
```bash
npm run tauri build
# 产物：client/src-tauri/target/release/bundle/{nsis,msi}/*.exe
```

桌面客户端默认连 `http://localhost:8080`；改部署地址见 `client/src/config.ts` 的 `API_URL`，或 `VITE_API_URL` 环境变量覆盖。

> 浏览器直接跑 UI：`cd client && npm run dev` → `http://localhost:1420`（允许麦克风权限）。

## 四、启用 AI 降噪（可选）

内置 DSP 已可用。要上 RNNoise / DTLN-rs / DeepFilterNet：

1. 编译好的 `.wasm` 放进 `client/public/wasm/`，文件名对应 `src/config.ts` 的 `WASM_MODELS`：
   `rnnoise.wasm` / `dtln.wasm` / `deepfilter.wasm`
2. 要求的 WASM ABI（详见 `public/wasm/README.md`）：
   `exports.denoise_frame(inPtr, outPtr)` + `exports.memory`，每帧 480×f32 @48kHz。
3. 客户端 Engine 下拉选择对应模型；worklet 会 fetch+instantiate，失败回退内置 DSP。

参考算法（与 worklet 一致）在 `client/src-tauri/src/denoise.rs`，可用于离线处理或编译 WASM 时作基准。

## 常见问题

- **Go 后端 `8080` 被占**：`.env` 改 `GO_HTTP_ADDR=:8090`，客户端 `VITE_API_URL=http://localhost:8090` 重建。
- **听不到对方**：先确认 LiveKit Cloud 项目里没禁用 audio；同局域网一般不需要 TURN。
- **回声**：开启 Smart 模式（默认 AEC on）；外放务必开 AEC。
- **键盘/风扇噪声**：切 Smart 调高 Strength；想极致再上 DeepFilterNet WASM。
