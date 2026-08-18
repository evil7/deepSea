import { describe, expect, it, vi } from "vitest"

import { handleLogin } from "../src/auth/login"
import type { Env } from "../src/index"

/** 内存 KV mock */
function createKvMock(initial: Map<string, string> = new Map()) {
  const store = initial
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v)
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k)
    }),
  } as unknown as KVNamespace
}

function makeEnv(kv: KVNamespace, base = "http://127.0.0.1:5174"): Env {
  return {
    DEEPSEA_KV: kv,
    ASSETS: {} as Fetcher,
    DEEPSEA_BASE: base,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
  }
}

describe("/auth/login", () => {
  it("未登录：302 到 GitHub authorize，state 写入 KV", async () => {
    const kv = createKvMock()
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login"),
      makeEnv(kv)
    )

    expect(res.status).toBe(302)
    const loc = res.headers.get("Location") ?? ""
    expect(loc).toContain("https://github.com/login/oauth/authorize")
    expect(loc).toContain("client_id=test-client")
    expect(loc).toContain("state=")
    const state = new URL(loc).searchParams.get("state")
    // state 已写入 KV
    expect(await kv.get(`state:${state}`)).not.toBeNull()
  })

  it("已登录（有效 session cookie）：直接 302 回站内，不再跳 GitHub", async () => {
    const kv = createKvMock(
      new Map([["session:abc", JSON.stringify({ userId: "1", createdAt: 1 })]])
    )
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login", {
        headers: { Cookie: "ds_session=abc" },
      }),
      makeEnv(kv)
    )

    expect(res.status).toBe(302)
    const loc = res.headers.get("Location") ?? ""
    expect(loc).toBe("http://127.0.0.1:5174/")
    expect(loc).not.toContain("github.com")
  })

  it("已登录 + redirect 参数：回跳指定路径", async () => {
    const kv = createKvMock(
      new Map([["session:xyz", JSON.stringify({ userId: "2", createdAt: 1 })]])
    )
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login?redirect=/plugins", {
        headers: { Cookie: "ds_session=xyz" },
      }),
      makeEnv(kv)
    )
    expect(res.headers.get("Location")).toBe("http://127.0.0.1:5174/plugins")
  })

  it("无效 session cookie：仍走 GitHub 授权", async () => {
    const kv = createKvMock() // 空 KV
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login", {
        headers: { Cookie: "ds_session=not-exist" },
      }),
      makeEnv(kv)
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toContain(
      "github.com/login/oauth/authorize"
    )
  })

  it("外部 redirect 被拒绝（防开放重定向）", async () => {
    const kv = createKvMock()
    const res = await handleLogin(
      new Request("http://127.0.0.1:5174/auth/login?redirect=https://evil.com"),
      makeEnv(kv)
    )
    expect(res.status).toBe(400)
  })
})
