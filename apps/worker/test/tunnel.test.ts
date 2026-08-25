// ---------------------------------------------------------------------------
// /auth/tunnel/* 集成测试 —— 三模式 · 主站仅纳管 URL
//
// 覆盖：
//   · report：上报 URL → upsert（防膨胀）+ DO 广播；不存任何 secret
//   · list：归属过滤（只返回自己的节点）+ url 直接来自云端
//   · delete：纯硬删 D1（无 CF API 调用）
//   · 未登录：全部 401
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from "vitest"

import * as d1Mod from "../src/lib/d1"
import {
  handleTunnelReport,
  handleTunnelList,
  handleTunnelDelete,
} from "../src/auth/tunnel"

// 拦截 resolveActorUserId：测试中模拟登录态（默认返回 42）。
vi.mock("../src/lib/d1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/d1")>()
  return {
    ...actual,
    resolveActorUserId: vi.fn(async () => 42),
  }
})

// ── mock Env（D1 用内存 Map 模拟；KV/DO 用 no-op）────────────────────────
function createMockEnv() {
  const tunnels = new Map<string, Record<string, unknown>>()
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        async first<T>(): Promise<T | null> {
          const m = sql.match(/WHERE node_id = \? AND github_id = \?/)
          if (m) {
            const [nid, gid] = args as [string, number]
            const row = tunnels.get(nid)
            if (row && row.github_id === gid) {
              return row as T
            }
            return null
          }
          return null
        },
        async run(): Promise<unknown> {
          if (sql.includes("ON CONFLICT(node_id)")) {
            const [nodeId, githubId, nodeName, url, status] = args as [
              string, number, string, string, string | undefined,
            ]
            const nextStatus = status ?? "connected"
            const existing = tunnels.get(nodeId)
            if (existing && existing.github_id === githubId) {
              existing.node_name = nodeName
              existing.url = url
              existing.status = nextStatus
              existing.modified_at = Date.now()
            } else {
              tunnels.set(nodeId, {
                node_id: nodeId,
                github_id: githubId,
                node_name: nodeName,
                url,
                status: nextStatus,
                created_at: Date.now(),
                modified_at: Date.now(),
              })
            }
          }
          if (sql.startsWith("DELETE FROM")) {
            const [nodeId, githubId] = args as [string, number]
            const row = tunnels.get(nodeId)
            if (row && row.github_id === githubId) {
              tunnels.delete(nodeId)
            }
          }
          return {}
        },
        async all<T>(): Promise<{ results: T[] }> {
          const gid = args[0] as number
          return {
            results: [...tunnels.values()].filter((r) => r.github_id === gid) as T[],
          }
        },
      }),
    }),
  }

  return {
    env: {
      DEEPSEA_D1: d1,
      DEEPSEA_KV: {},
      TUNNEL_HUB: {
        idFromName: () => ({}),
        get: () => tunnelHubStub,
      },
      _tunnels: tunnels,
    } as never,
    tunnels,
  }
}

/** TunnelHub DO stub（单例，广播 spy 全局可见）。 */
const tunnelHubStub = {
  fetch: vi.fn(async () => new Response("ok")),
}

/** 构造带 device_token 登录态的请求。 */
function authedRequest(
  method: string,
  path: string,
  body?: unknown,
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: "Bearer dev-token-hash" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** 合法 nodeId（UUID 形态）。 */
const NODE = "11111111-2222-3333-4444-555555555555"

function seedNode(
  tunnels: Map<string, Record<string, unknown>>,
  nodeId = NODE,
  githubId = 42,
  url = "https://abc.trycloudflare.com",
): void {
  tunnels.set(nodeId, {
    node_id: nodeId,
    github_id: githubId,
    node_name: "my-node",
    url,
    status: "connected",
    created_at: 1,
    modified_at: 1,
  })
}

describe("/auth/tunnel/*", () => {
  beforeEach(() => {
    vi.mocked(d1Mod.resolveActorUserId).mockResolvedValue(42)
    tunnelHubStub.fetch.mockClear()
  })

  it("未登录访问 list → 401", async () => {
    const { env } = createMockEnv()
    vi.mocked(d1Mod.resolveActorUserId).mockResolvedValue(null)
    const res = await handleTunnelList(new Request("http://localhost/auth/tunnel/list"), env)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ ok: false, authed: false })
  })

  it("report：上报 URL → upsert 节点 + 返回 URL + DO 广播（不存 secret）", async () => {
    const { env, tunnels } = createMockEnv()
    await seedNode(tunnels, NODE, 42, "https://old.trycloudflare.com")

    const res = await handleTunnelReport(
      authedRequest("POST", "/auth/tunnel/report", {
        nodeId: NODE,
        nodeName: "test-node",
        url: "https://new.trycloudflare.com",
      }),
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.url).toBe("https://new.trycloudflare.com")
    expect(body.securityCode).toBeUndefined() // 不再下发安全码
    const row = tunnels.get(NODE)!
    expect(row.url).toBe("https://new.trycloudflare.com")
    expect(row.security_code).toBeUndefined() // 不落库任何 secret
    expect(row.status).toBe("connected")
    expect(tunnelHubStub.fetch).toHaveBeenCalled()
  })

  it("report status=offline → 节点标记离线 + 广播 node_offline", async () => {
    const { env, tunnels } = createMockEnv()
    await seedNode(tunnels, NODE, 42, "https://abc.trycloudflare.com")

    const res = await handleTunnelReport(
      authedRequest("POST", "/auth/tunnel/report", {
        nodeId: NODE,
        nodeName: "test-node",
        url: "https://abc.trycloudflare.com",
        status: "offline",
      }),
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("offline")
    expect(tunnels.get(NODE)!.status).toBe("offline")

    // 广播应为 node_offline（而非 node_online）
    const call = tunnelHubStub.fetch.mock.calls[0] as unknown as [
      string,
      { body: string },
    ]
    const broadcastBody = JSON.parse(call[1].body) as { type: string; nodeId: string }
    expect(broadcastBody.type).toBe("node_offline")
    expect(broadcastBody.nodeId).toBe(NODE)
  })

  it("report：新节点 → upsert 创建", async () => {
    const { env, tunnels } = createMockEnv()
    const res = await handleTunnelReport(
      authedRequest("POST", "/auth/tunnel/report", {
        nodeId: NODE,
        nodeName: "fresh-node",
        url: "https://fresh.trycloudflare.com",
      }),
      env,
    )
    expect((await res.json()).ok).toBe(true)
    expect(tunnels.size).toBe(1)
    expect(tunnels.get(NODE)!.node_name).toBe("fresh-node")
  })

  it("report：非法 nodeId / 非 https url → 400", async () => {
    const { env } = createMockEnv()
    const bad = [
      { nodeId: "not-a-uuid", url: "https://x.trycloudflare.com" },
      { nodeId: NODE, url: "http://x.trycloudflare.com" },
      { nodeId: NODE, url: "ftp://x" },
    ]
    for (const b of bad) {
      const res = await handleTunnelReport(
        authedRequest("POST", "/auth/tunnel/report", b),
        env,
      )
      expect(res.status).toBe(400)
    }
  })

  it("list：只返回自己的节点，url 来自云端上报", async () => {
    const { env, tunnels } = createMockEnv()
    await seedNode(tunnels, "11111111-2222-3333-4444-aaaaaaaaaaaa", 42, "https://mine.trycloudflare.com")
    await seedNode(tunnels, "11111111-2222-3333-4444-bbbbbbbbbbbb", 99, "https://other.trycloudflare.com")
    const res = await handleTunnelList(authedRequest("GET", "/auth/tunnel/list"), env)
    const body = await res.json()
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0].nodeId).toBe("11111111-2222-3333-4444-aaaaaaaaaaaa")
    expect(body.nodes[0].url).toBe("https://mine.trycloudflare.com")
  })

  it("delete：纯硬删 D1（无 CF API 调用）", async () => {
    const { env, tunnels } = createMockEnv()
    await seedNode(tunnels, NODE, 42, "https://x.trycloudflare.com")
    const origFetch = globalThis.fetch
    const fetchSpy = vi.fn(async () => new Response("unexpected"))
    globalThis.fetch = fetchSpy as never
    const res = await handleTunnelDelete(
      authedRequest("POST", "/auth/tunnel/delete", { nodeId: NODE }),
      env,
    )
    globalThis.fetch = origFetch
    expect((await res.json()).ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled() // 零 CF 依赖
    expect(tunnels.has(NODE)).toBe(false)
    const listRes = await handleTunnelList(authedRequest("GET", "/auth/tunnel/list"), env)
    expect((await listRes.json()).nodes).toHaveLength(0)
  })

  it("delete：不存在的节点 → 404", async () => {
    const { env } = createMockEnv()
    const res = await handleTunnelDelete(
      authedRequest("POST", "/auth/tunnel/delete", { nodeId: NODE }),
      env,
    )
    expect(res.status).toBe(404)
  })

  it("归属校验：他人节点 delete 404", async () => {
    const { env, tunnels } = createMockEnv()
    await seedNode(tunnels, NODE, 99, "https://other.trycloudflare.com")
    const res = await handleTunnelDelete(
      authedRequest("POST", "/auth/tunnel/delete", { nodeId: NODE }),
      env,
    )
    expect(res.status).toBe(404)
  })

  it("硬删后重新 report → 节点重建（防膨胀：始终仅 1 行）", async () => {
    const { env, tunnels } = createMockEnv()
    await seedNode(tunnels, NODE, 42, "https://x.trycloudflare.com")
    await handleTunnelDelete(authedRequest("POST", "/auth/tunnel/delete", { nodeId: NODE }), env)
    expect(tunnels.has(NODE)).toBe(false)
    const rep = await handleTunnelReport(
      authedRequest("POST", "/auth/tunnel/report", {
        nodeId: NODE,
        nodeName: "revived",
        url: "https://revived.trycloudflare.com",
      }),
      env,
    )
    expect(rep.status).toBe(200)
    const listRes = await handleTunnelList(authedRequest("GET", "/auth/tunnel/list"), env)
    const nodes = (await listRes.json()).nodes
    expect(nodes).toHaveLength(1)
    expect(nodes[0].url).toBe("https://revived.trycloudflare.com")
  })

  it("report 重复上报：原地更新不新增行 + modified_at 刷新（防膨胀）", async () => {
    const { env, tunnels } = createMockEnv()
    const t0 = Date.now()
    await seedNode(tunnels, NODE, 42, "https://v1.trycloudflare.com")
    await handleTunnelReport(
      authedRequest("POST", "/auth/tunnel/report", {
        nodeId: NODE,
        nodeName: "v2",
        url: "https://v2.trycloudflare.com",
      }),
      env,
    )
    await handleTunnelReport(
      authedRequest("POST", "/auth/tunnel/report", {
        nodeId: NODE,
        nodeName: "v3",
        url: "https://v3.trycloudflare.com",
      }),
      env,
    )
    expect(tunnels.size).toBe(1)
    const row = tunnels.get(NODE)!
    expect(row.url).toBe("https://v3.trycloudflare.com")
    expect((row.modified_at as number) >= t0).toBe(true)
  })
})
