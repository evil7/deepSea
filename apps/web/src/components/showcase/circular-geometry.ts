import * as THREE from "three"

// ---------------------------------------------------------------------------
// 圆形沙盘网格（XZ 平面，y=0）
//   以矩形规则网格（widthSegs × depthSegs）为切分骨架 —— 波浪三角面是横竖
//   规则网格，不会出现"同心圆环 + 中心放射状"的放射切分感；
//   生成后把超出圆形半径的顶点投影回圆边界 → 沙盘外框是圆形，无矩形尖角。
//   供海面位移 / 光柱侧棱 / 海底光斑共用（同一拓扑 → 位置天然对齐）。
// ---------------------------------------------------------------------------
export function createCircularGeometry(
  radius: number,
  widthSegs: number,
  depthSegs: number
): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  const half = radius

  // 矩形规则网格顶点（超出圆半径的投影回圆边界 → 圆形外框）
  for (let j = 0; j <= depthSegs; j++) {
    const z = -half + (radius * 2 * j) / depthSegs
    for (let i = 0; i <= widthSegs; i++) {
      const x = -half + (radius * 2 * i) / widthSegs
      const len = Math.hypot(x, z)
      let px = x
      let pz = z
      if (len > radius) {
        const s = radius / len
        px = x * s
        pz = z * s
      }
      positions.push(px, 0, pz)
      // uv：归一化到 [0,1]（线性映射，供渐变使用）
      uvs.push(i / widthSegs, j / depthSegs)
    }
  }

  // 三角形绕序（逆时针朝 +Y）：四角 a 左上、b 右上、c 左下、d 右下
  //   a--b
  //   | /|
  //   c--d
  // 三角 (a, c, b) 与 (b, c, d) 叉积均为 +Y → 正面朝上
  const cols = widthSegs + 1
  for (let j = 0; j < depthSegs; j++) {
    for (let i = 0; i < widthSegs; i++) {
      const a = j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  )
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}
