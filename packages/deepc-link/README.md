# deepc-link

> DSH 远端互联插件 —— 三模式自选 + 本地 TOTP 2FA。

deepc-link 是「深海套装」的本地执行器与互联底座。它把本地 dsh host 经
**3081 鉴权代理（TOTP 2FA）+ cloudflared Quick Tunnel** 暴露到局域网 / 公网，
并可选登录 deepc 主站纳管 URL。

## 三种互联模式（用户自选，递进）

| 模式 | 能力 | 登录 | CF |
|------|------|------|----|
| **local** 本地共享 | 仅 3081 鉴权代理，局域网访问 `http://<本机IP>:3081` | 否 | 否 |
| **tunnel** 暴露 | + cloudflared（匿名 Quick Tunnel / 自定义域） | 否 | 是 |
| **managed** 纳管 | + 登录上报 URL，断链自动重连上报 | 是 | 是 |

## 核心原则

- **本地 TOTP 2FA**：安全码（TOTP secret）由插件本地生成并持久化，用户用任意 2FA 应用
  扫码绑定，动态码 30s 轮换。**最终安全由用户本地掌控**。
- **主站只纳管 URL**：Worker 不存任何 secret，不签 ticket、不代过鉴权。
- **数据面零 Worker**：远程访问 dsh UI 走 CF Tunnel → 3081 鉴权 → 反代 3080。
- **前后端分层**：node 端承载 3081/cloudflared/TOTP/上报；browser 端（悬浮球）只做展示 + 控制。

## 目录

```
packages/deepc-link/
├── package.json        # dsh.bundle.patch → cordis.patch.yml；peerDeps @deepseek-ai/cordis
├── cordis.patch.yml    # 组合包：挂载 deepc-link node 端插件
├── tsconfig.json       # 继承根风格，strict
├── scripts/build.mjs   # esbuild 打包 node + browser 端（注入 __DEEPC_*_BASE__）
├── test/               # TOTP 2FA / 鉴权代理 / cloudflared 测试（build-tests.mjs 打包）
└── src/
    ├── index.ts        # node 端入口：注册 /deepc 路由
    ├── host.ts         # 三模式编排 + Device Grant + TOTP secret 持久化
    ├── totp.ts         # TOTP 2FA（RFC 6238：secret 生成/校验/otpauth URI）
    ├── auth-proxy.ts   # 3081 鉴权代理（反代 3080 + WS hijack + 6位2FA + 防暴力）
    ├── cloudflared.ts  # cloudflared 托管（下载 + SHA-256 + 子进程）
    ├── tunnel.ts       # 互联编排（三模式 + 上报 URL + 断链重连）
    ├── events.ts       # DO 事件订阅（node_deleted）
    ├── host-ui.ts      # browser 端悬浮球（三模式 UI + 2FA 二维码）
    └── client/index.ts # browser 端入口
```

## 设备身份模型

- **nodeId**：插件后端由主机 `hostname` SHA-256 派生的确定性 UUID v4（同主机 = 同 ID）。
- **设备名**：默认取主机 `hostname`，可改。
- **TOTP secret**：本地生成，持久化 `~/.deepc/totp-secret`（chmod 600）。
- **device_token**：Device Grant 流签发，持久化 `~/.deepc/device-token`（chmod 600）。

## 安装

```bash
dsh plugin --profile web add deepc-link
```

## 开发

```bash
pnpm --filter deepc-link typecheck   # 类型检查
pnpm --filter deepc-link build       # 构建（注入默认基址 https://deepc.cn）
node test/build-tests.mjs            # 打包测试 bundle
node test/totp.test.mjs              # TOTP 2FA 测试（RFC 6238 标准向量）
node test/auth-proxy.test.mjs        # 鉴权代理测试
```

本地联调：插件 Sheet 打开「开发模式」开关 → 基址切到 `http://127.0.0.1:5174`（vite 代理本地 worker）。

详见：`docs/deepsea-tunnel-bridge-proposal.md`。
