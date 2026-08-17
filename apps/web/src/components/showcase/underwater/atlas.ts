import * as THREE from "three"

// ---------------------------------------------------------------------------
// 代码字符图集（8×8 = 64 字符，白色字符、黑色底）
// 供海底「漂浮代码」点精灵采样（纹理 R 通道作亮度掩码）
// ---------------------------------------------------------------------------

// 64 个编程感字符（涵盖数字/运算符/括号/符号）
export const CHARS =
  "01<>/{}[]()=+*#_-.$%&|;:~^?!," +
  "abcdefABCDEFxyzXYZwWvV0123456789<>/[]{}()=+-*#"

export const ATLAS_SIZE = 8

export function createCodeAtlas(): THREE.CanvasTexture {
  const cell = 64
  const canvas = document.createElement("canvas")
  canvas.width = ATLAS_SIZE * cell
  canvas.height = ATLAS_SIZE * cell
  const ctx = canvas.getContext("2d")
  if (ctx) {
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = "#fff"
    ctx.font = `bold ${Math.floor(cell * 0.72)}px "JetBrains Mono", Consolas, monospace`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    for (let i = 0; i < CHARS.length; i++) {
      const col = i % ATLAS_SIZE
      const row = Math.floor(i / ATLAS_SIZE)
      ctx.fillText(CHARS[i], col * cell + cell / 2, row * cell + cell * 0.52)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  // 亮度掩码，不做颜色空间转换
  texture.colorSpace = THREE.NoColorSpace
  return texture
}
