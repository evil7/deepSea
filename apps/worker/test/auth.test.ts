import { describe, expect, it } from "vitest"

import { parseCookies, serializeCookie } from "../src/lib/cookies"
import { decryptToken, encryptToken } from "../src/lib/crypto"

describe("cookies", () => {
  it("解析 cookie 请求头", () => {
    const cookies = parseCookies("a=1; b=%E6%B5%B7; c=hello")
    expect(cookies).toEqual({ a: "1", b: "海", c: "hello" })
  })

  it("空头返回空对象", () => {
    expect(parseCookies(null)).toEqual({})
    expect(parseCookies("")).toEqual({})
  })

  it("序列化带安全属性的 cookie", () => {
    const cookie = serializeCookie("ds_session", "abc123", {
      maxAge: 3600,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })
    expect(cookie).toContain("ds_session=abc123")
    expect(cookie).toContain("Max-Age=3600")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Lax")
  })
})

describe("token 加密缓存", () => {
  it("加密后可解密还原", async () => {
    const secret = "test-secret-key-1234567890"
    const token = "gho_xxx_token_value"
    const enc = await encryptToken(secret, token)
    expect(enc).not.toContain(token)
    const dec = await decryptToken(secret, enc)
    expect(dec).toBe(token)
  })

  it("错误密钥解密失败返回 null", async () => {
    const enc = await encryptToken("secret-a", "gho_token")
    const dec = await decryptToken("secret-b", enc)
    expect(dec).toBeNull()
  })
})
