---
name: dsh-security-audit
description: 'deepc 插件安全管理审计。Use when: 构造 dsh 插件 deepc、安全映射方案、动态安全路径、二次验证、插件安装前审计、权限与路径校验、密钥管理、供应链安全。'
argument-hint: '要审计/加固的安全场景，例如 "插件安装路径映射" 或 "deepc 二次验证流程"'
user-invocable: true
---

# deepc 安全审计

## 目标

构造 dsh 插件 `deepc` 用于 DeepSeek Harness 的安全管理，提供：统一且安全的映射方案、动态安全路径、二次验证等能力，并对生态插件做安装前审计。

## 何时使用

- 实现 deepc 插件的核心安全逻辑
- 插件安装/更新前的安全审计
- 文件路径映射与访问控制
- 敏感操作（安装、更新、执行）的二次验证

## 安全设计

### 1. 统一且安全的映射方案

- 每个插件映射到唯一沙箱命名空间：`~/.dsh/deepc/plugins/<plugin-id>/`（`plugin-id` 由 owner+repo 哈希生成，防路径注入）
- 建立「插件 → 允许访问路径」白名单映射表，插件只能读写映射表内的路径
- **映射表存储走官方 `ctx.storage` seam**（`defineDomain` + `DomainFacility.open` → `ctx.storageDomain`，
  挂 `storage-json` 后端），**不手写 `~/.dsh/deepc/mappings.json`**（避免绕开官方持久化与热发布）。
  校验时比对规范化（canonical）路径，杜绝 `..`、符号链接逃逸：

```ts
function safeResolve(base: string, input: string): string | null {
  const resolved = path.resolve(base, input)
  return resolved.startsWith(base + path.sep) ? resolved : null
}
```

### 1a. 密钥管理（对齐官方 `ctx.credentials` seam）

- GitHub/gist token 一律经 `ctx.credentials`（`credentialRef('DEEPSEA_GITHUB_TOKEN')` →
  `ctx.credentials.resolve(ref)` → `{ value, source }`）；配置只携带引用，`describe(ref)` 永不返回值。
- **绝不把密钥写入白名单/收藏等任何明文 JSON**；密钥值只由 `credentials-local` provider 持有。

### 2. 动态安全路径

- 插件请求路径时由 deepc 返回**动态生成的临时路径**（每次会话随机化目录名），而不是固定路径，防止插件间相互探测
- 临时路径生命周期与会话绑定，会话结束自动回收

### 3. 二次验证

- 危险操作（安装新插件、更新、执行带写权限的插件、修改映射）必须二次确认：
  - 交互确认：展示操作摘要（插件名、来源、将写入的路径）后由用户确认
  - 可选的 TOTP/口令二次验证（`deepc verify` 命令或 UI 对话框）
- 操作日志写入审计存储（追加型日志；可走 `ctx.storage` domain 或独立 `audit.log` 文件，路径经
  `ctx.settings.documentPath` 解析）（时间、操作、插件、路径、结果）

### 4. 安装前审计清单

安装/更新插件前逐项检查：

- [ ] 来源仓库可信（owner 是否官方/已知组织，star 数，创建时间）
- [ ] `has_issues`/`has_discussions` 支持后续反馈
- [ ] 依赖清单无已知高危依赖（可接入 OSV/npm audit）
- [ ] 无对绝对路径、环境变量敏感读取的硬编码
- [ ] license 明确（MIT/Apache-2.0 等宽松协议优先）
- [ ] 安装后首次运行在只读沙箱中试运行（dry-run）

## 完成标准

- [ ] 路径映射白名单 + 规范化校验防逃逸
- [ ] 动态临时路径随会话生成与回收
- [ ] 危险操作二次验证 + 审计日志
- [ ] 安装前审计清单可执行并产出报告
