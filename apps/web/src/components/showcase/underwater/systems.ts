import * as THREE from "three"

import { createCircularGeometry } from "@/components/showcase/circular-geometry"
import type { OceanConf } from "@/components/showcase/ocean-conf"

import {
  causticsFragmentShader,
  causticsVertexShader,
  codeCharFragmentShader,
  codeCharVertexShader,
  lightShaftFragmentShader,
  lightShaftVertexShader,
} from "./shaders"

// ---------------------------------------------------------------------------
// 水下系统构建器：seabed（海底实体地面）/ caustics（海底光斑）/
// lightShafts（海中光柱）/ codeParticles（漂浮代码）
// 统一骨架：全部采样共享 sea-field 的 waveField（世界 XZ → 海面高度）——
//   · 海底光斑（GPU）：正色映射 height → 亮度（浪峰聚光亮、浪谷暗）
//   · 海中光柱（GPU）：取反/取正(-height) → 强度，位置 = 海面网格三角形对齐
//   · 海面（ocean.tsx）：height → 位移 + 浪花
// 海中/海底支持动态高度（surfaceY↔bottomY）。
// ---------------------------------------------------------------------------

// 海底 / 光柱的垂直范围（可动态调整：surfaceY=海面、bottomY=海底）
interface UnderwaterExtent {
  surfaceY: number
  bottomY: number
}

// —— 海底实体地面 ——
// 之前"海底看不见"：只有半透明光斑平面、且颜色极暗 → 被深海背景吞没。
// 修复：新增不透明圆形海底地面（bottomColor），光斑叠加其上。
export function createSeabed(bottomY: number): {
  mesh: THREE.Mesh
  update: (dive: number, conf: OceanConf) => void
  dispose: () => void
} {
  const geometry = createCircularGeometry(60, 48, 48)
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color("#04182b"),
    transparent: true,
    opacity: 0,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = bottomY
  mesh.renderOrder = 0

  return {
    mesh,
    update: (dive, conf) => {
      // 海底深度（正值 → 海面下方距离）：海底地面跟随下沉/上浮
      mesh.position.y = -conf.bottomDepth
      material.opacity = dive * 0.92
      material.color.set(conf.bottomColor)
    },
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}

// —— caustics：海底折射光斑 ——
// 统一骨架：直接用共享 waveField（世界 XZ → 海面高度），正色映射：
//   浪峰（h>0）聚光 → 亮斑；浪谷（h<0） → 暗。与海面同一函数/参数/坐标。
export function createCaustics(bottomY: number): {
  mesh: THREE.Mesh
  update: (dive: number, t: number, conf: OceanConf) => void
  dispose: () => void
} {
  const geometry = createCircularGeometry(60, 32, 32)
  const uniforms = {
    uTime: { value: 0 },
    uFlowDir: { value: new THREE.Vector2(0.2, -0.98).normalize() },
    uFlowSpeed: { value: 0.15 },
    uWaveElevation: { value: 0.35 },
    uWaveIterations: { value: 8 },
    uWaveDrag: { value: 0.115 },
    uSwellStrength: { value: 0.45 },
    uSwellScale: { value: 1.65 },
    uSwellSpeed: { value: 0.7 },
    uSmallWavesElevation: { value: 0.08 },
    uSmallWavesFrequency: { value: 1 },
    uSmallWavesSpeed: { value: 0.2 },
    uSmallWavesIterations: { value: 2 },
    uMidElevation: { value: 0.07 },
    uMidScale: { value: 4.6 },
    uMidSpeed: { value: 0.64 },
    uWaveDensity: { value: 1 },
    uWaveSpeed: { value: 1 },
    uBrightness: { value: 1.35 },
    uOpacity: { value: 0 },
    uLightColor: { value: new THREE.Color("#9fd8ff") },
    uDeepColor: { value: new THREE.Color("#04182b") },
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: causticsVertexShader,
    fragmentShader: causticsFragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  // 铺在海底（圆形 60 半径，与海面沙盘同心）
  mesh.position.y = bottomY
  mesh.renderOrder = 1

  return {
    mesh,
    update: (dive, t, conf) => {
      uniforms.uTime.value = t
      // 海底深度（正值 → 海面下方距离）：光斑平面跟随下沉/上浮
      mesh.position.y = -conf.bottomDepth
      uniforms.uOpacity.value = dive * 0.9
      uniforms.uBrightness.value = conf.causticBrightness
      ;(uniforms.uDeepColor.value as THREE.Color).set(conf.bottomColor)
      // 归一化流向（与海面一致，同一 waveField → 同向同速）
      const a = conf.flowAngle * (Math.PI / 180)
      ;(uniforms.uFlowDir.value as THREE.Vector2)
        .set(Math.sin(a), Math.cos(a))
        .normalize()
      uniforms.uFlowSpeed.value = conf.flowSpeed
      uniforms.uWaveElevation.value = conf.waveHeight
      uniforms.uWaveIterations.value = conf.waveIterations
      uniforms.uWaveDrag.value = conf.waveDrag
      uniforms.uSwellStrength.value = conf.swellStrength
      uniforms.uSwellScale.value = conf.swellScale
      uniforms.uSwellSpeed.value = conf.swellSpeed
      uniforms.uSmallWavesElevation.value = conf.smallElevation
      uniforms.uSmallWavesFrequency.value = conf.smallFrequency
      uniforms.uSmallWavesSpeed.value = conf.smallSpeed
      uniforms.uSmallWavesIterations.value = conf.smallIterations
      uniforms.uMidElevation.value = conf.midElevation
      uniforms.uMidScale.value = conf.midScale
      uniforms.uMidSpeed.value = conf.midSpeed
      uniforms.uWaveDensity.value = conf.waveDensity
      uniforms.uWaveSpeed.value = conf.waveSpeed
    },
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}

// —— 海中光柱（light shafts）：浪谷三角向下拉伸的三棱柱 ——
// 统一骨架：几何体复用海面圆形沙盘网格（矩形切分 + 圆形裁切，世界 XZ 同坐标系），
//   顶点着色器用共享 waveField 计算海面高度，波谷处三棱柱侧面自然向下延伸 →
//   位置/方向与海面波浪 100% 实时对齐（同一函数、同一参数、世界坐标）。
//   片元取反(-elevation) 决定透明度（浪谷越深越透光），靠近海底渐隐。
const SHAFT_RADIUS = 42
const SHAFT_SEGMENTS = 36

export function createLightShafts(): {
  mesh: THREE.Mesh
  update: (dive: number, t: number, conf: OceanConf) => void
  dispose: () => void
} {
  // 构造三棱柱侧面：圆形沙盘网格每个三角形 → 3 条侧棱（quad），上下顶点由 shader 落位
  const positions: number[] = []
  const flags: number[] = []
  const circular = createCircularGeometry(
    SHAFT_RADIUS,
    SHAFT_SEGMENTS,
    SHAFT_SEGMENTS
  )
  const posAttr = circular.attributes.position as THREE.BufferAttribute
  const index = circular.index as THREE.BufferAttribute
  const verts: Array<[number, number]> = []
  for (let i = 0; i < posAttr.count; i++) {
    verts.push([posAttr.getX(i), posAttr.getZ(i)])
  }

  const pushVert = (x: number, z: number, flag: number) => {
    positions.push(x, z, 0)
    flags.push(flag)
  }

  // 一条侧棱的 quad：a_top, b_top, b_bot, a_bot → 两个三角形
  const addQuad = (a: [number, number], b: [number, number]) => {
    pushVert(a[0], a[1], 0)
    pushVert(b[0], b[1], 0)
    pushVert(b[0], b[1], 1)
    pushVert(a[0], a[1], 0)
    pushVert(b[0], b[1], 1)
    pushVert(a[0], a[1], 1)
  }

  // 遍历每个三角形：三条边各生成一个侧面 quad
  // （矩形网格 + 圆形裁切：无中心顶点，不会在圆心汇聚；全量遍历）
  for (let i = 0; i < index.count; i += 3) {
    const a = verts[index.getX(i)]
    const b = verts[index.getX(i + 1)]
    const c = verts[index.getX(i + 2)]
    addQuad(a, b)
    addQuad(b, c)
    addQuad(c, a)
  }
  circular.dispose()

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3)
  )
  geometry.setAttribute(
    "aFlag",
    new THREE.BufferAttribute(new Float32Array(flags), 1)
  )

  const uniforms = {
    uTime: { value: 0 },
    uFlowDir: { value: new THREE.Vector2(0.2, -0.98).normalize() },
    uFlowSpeed: { value: 0.15 },
    uWaveElevation: { value: 0.35 },
    uWaveIterations: { value: 8 },
    uWaveDrag: { value: 0.115 },
    uSwellStrength: { value: 0.45 },
    uSwellScale: { value: 1.65 },
    uSwellSpeed: { value: 0.7 },
    uSmallWavesElevation: { value: 0.08 },
    uSmallWavesFrequency: { value: 1 },
    uSmallWavesSpeed: { value: 0.2 },
    uSmallWavesIterations: { value: 2 },
    uMidElevation: { value: 0.07 },
    uMidScale: { value: 4.6 },
    uMidSpeed: { value: 0.64 },
    uWaveDensity: { value: 1 },
    uWaveSpeed: { value: 1 },
    uLength: { value: 6.2 },
    uScale: { value: 0.8 },
    uAngle: { value: 0.35 },
    uTilt: { value: 0.15 },
    uOpacity: { value: 0 },
    uThreshold: { value: 0.0 },
    uCrestLight: { value: 0 },
    uLightColor: { value: new THREE.Color("#bfe6ff") },
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: lightShaftVertexShader,
    fragmentShader: lightShaftFragmentShader,
    uniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 2

  return {
    mesh,
    update: (dive, t, conf) => {
      uniforms.uTime.value = t
      uniforms.uOpacity.value = dive * conf.shaftOpacity
      uniforms.uLength.value = conf.shaftLength
      uniforms.uScale.value = conf.shaftScale
      uniforms.uAngle.value = conf.shaftAngle * (Math.PI / 180)
      uniforms.uThreshold.value = conf.shaftThreshold
      uniforms.uCrestLight.value = conf.shaftCrestLight ? 1 : 0
      ;(uniforms.uLightColor.value as THREE.Color).set(conf.shaftColor)
      // 归一化流向（与海面一致）
      const a = conf.flowAngle * (Math.PI / 180)
      ;(uniforms.uFlowDir.value as THREE.Vector2)
        .set(Math.sin(a), Math.cos(a))
        .normalize()
      uniforms.uFlowSpeed.value = conf.flowSpeed
      uniforms.uWaveElevation.value = conf.waveHeight
      uniforms.uWaveIterations.value = conf.waveIterations
      uniforms.uWaveDrag.value = conf.waveDrag
      uniforms.uSwellStrength.value = conf.swellStrength
      uniforms.uSwellScale.value = conf.swellScale
      uniforms.uSwellSpeed.value = conf.swellSpeed
      uniforms.uSmallWavesElevation.value = conf.smallElevation
      uniforms.uSmallWavesFrequency.value = conf.smallFrequency
      uniforms.uSmallWavesSpeed.value = conf.smallSpeed
      uniforms.uSmallWavesIterations.value = conf.smallIterations
      uniforms.uMidElevation.value = conf.midElevation
      uniforms.uMidScale.value = conf.midScale
      uniforms.uMidSpeed.value = conf.midSpeed
      uniforms.uWaveDensity.value = conf.waveDensity
      uniforms.uWaveSpeed.value = conf.waveSpeed
    },
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}

// —— 漂浮代码粒子 ——
// 运动：跟随海面洋流方向（flowDir 映射到 XZ 平面）统一漂移，超界 wrap 循环；
//       再叠加小幅正弦摆动保留随机感；同时跟随鼠标视差同向缓慢平移。
// 淡入淡出：每个粒子独立周期/相位，alpha 按 sin 脉冲循环 0→1→0，随机消失再现。
// 字符：每秒随机更换一部分粒子的字符（图集索引），内容持续变动。
const MAX_CODE = 4000
// 青绿蓝随机调色板（海底氛围）
const CODE_PALETTE = [
  new THREE.Color("#b8ecff"),
  new THREE.Color("#73d4f0"),
  new THREE.Color("#61a8f5"),
  new THREE.Color("#52c9d1"),
  new THREE.Color("#a9c8ff"),
]
// 代码粒子漂移范围（与初始分布一致）：x ∈ [-14,14]、z ∈ [-16,4]
const CODE_X_MIN = -14
const CODE_X_MAX = 14
const CODE_Z_MIN = -16
const CODE_Z_MAX = 4
// 洋流速度换算系数：海面 UV 速度 → 世界单位/秒（放慢避免眼花）
const FLOW_SCALE = 2.5
// 鼠标视差跟随系数（同向、慢速）
const MOUSE_X_SCALE = 0.8
const MOUSE_Y_SCALE = 0.45

// 数值范围 wrap（粒子漂出范围后从另一侧循环出现）
const wrap = (v: number, min: number, max: number) => {
  const span = max - min
  return min + ((((v - min) % span) + span) % span)
}

export function createCodeParticles(atlas: THREE.Texture): {
  points: THREE.Points
  update: (t: number, conf: OceanConf, mouseX: number, mouseY: number) => void
  dispose: () => void
} {
  const positions = new Float32Array(MAX_CODE * 3)
  const basePositions = new Float32Array(MAX_CODE * 3)
  const seeds = new Float32Array(MAX_CODE)
  const chars = new Float32Array(MAX_CODE)
  const alphas = new Float32Array(MAX_CODE)
  // 淡入淡出周期/相位（秒）
  const fadePeriods = new Float32Array(MAX_CODE)
  const fadePhases = new Float32Array(MAX_CODE)
  const colors = new Float32Array(MAX_CODE * 3)

  const color = new THREE.Color()
  for (let i = 0; i < MAX_CODE; i++) {
    const x = (Math.random() - 0.5) * (CODE_X_MAX - CODE_X_MIN)
    const y = -1 - Math.random() * 7.5
    const z = CODE_Z_MIN + Math.random() * (CODE_Z_MAX - CODE_Z_MIN)
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
    basePositions[i * 3] = x
    basePositions[i * 3 + 1] = y
    basePositions[i * 3 + 2] = z
    seeds[i] = Math.random() * 100
    chars[i] = Math.floor(Math.random() * 64)
    alphas[i] = 0
    fadePeriods[i] = 4 + Math.random() * 5 // 4~9 秒一个淡入淡出周期
    fadePhases[i] = Math.random() * 100 // 随机相位 → 随机消失时刻
    color.copy(CODE_PALETTE[Math.floor(Math.random() * CODE_PALETTE.length)])
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute("aChar", new THREE.BufferAttribute(chars, 1))
  geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1))
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3))

  const material = new THREE.ShaderMaterial({
    vertexShader: codeCharVertexShader,
    fragmentShader: codeCharFragmentShader,
    uniforms: {
      uAtlas: { value: atlas },
      uAtlasSize: { value: 8 },
      uSize: { value: 0.9 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    transparent: true,
    depthWrite: false,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false

  const positionAttr = geometry.attributes.position as THREE.BufferAttribute
  const charAttr = geometry.attributes.aChar as THREE.BufferAttribute
  const alphaAttr = geometry.attributes.aAlpha as THREE.BufferAttribute

  // 字符快速变换步进（0.35 秒一批）
  let lastCharSwap = -1

  const update = (
    t: number,
    conf: OceanConf,
    mouseX: number,
    mouseY: number
  ) => {
    // 洋流方向映射到 XZ 平面（海面 flowAngle → 世界 x/z）
    const a = conf.flowAngle * (Math.PI / 180)
    const dx = Math.sin(a)
    const dz = Math.cos(a)
    const drift = t * conf.flowSpeed * FLOW_SCALE
    // 鼠标视差：与海面同向（pan）但更慢
    const mx = mouseX * MOUSE_X_SCALE
    const my = mouseY * MOUSE_Y_SCALE

    for (let i = 0; i < MAX_CODE; i++) {
      const seed = seeds[i]
      // 自主摇曳：每个粒子独立频率/相位，X 轴左右摆动明显（模拟海水晃动）
      const swayFreq = 0.5 + (seed % 0.7) // 0.5~1.2 Hz 独立频率
      const swayPhase = seed * 37 // 独立相位
      // 主运动：跟随洋流统一漂移（wrap 循环）+ 左右摇曳 + 鼠标视差
      positions[i * 3] =
        wrap(basePositions[i * 3] + dx * drift, CODE_X_MIN, CODE_X_MAX) +
        Math.sin(t * swayFreq + swayPhase) * 0.55 +
        Math.sin(t * swayFreq * 2.3 + swayPhase * 1.7) * 0.18 +
        mx
      positions[i * 3 + 1] =
        basePositions[i * 3 + 1] + Math.sin(t * 0.45 + seed * 45) * 0.2 + my
      positions[i * 3 + 2] =
        wrap(basePositions[i * 3 + 2] + dz * drift, CODE_Z_MIN, CODE_Z_MAX) +
        Math.cos(t * swayFreq * 0.8 + swayPhase) * 0.15

      // 淡入淡出：sin 脉冲（半周期可见、半周期消失），pow 使中间更亮、两端快速归零
      const f = Math.sin(Math.PI * (t / fadePeriods[i] + fadePhases[i]))
      const fade = Math.pow(Math.max(0, f), 3)
      alphas[i] = (0.45 + (seed % 0.45)) * fade
    }
    positionAttr.needsUpdate = true
    alphaAttr.needsUpdate = true

    // 字符快速随机变换：每 0.35 秒更换 ~35% 粒子的字符（更频繁的滚动代码感）
    const charSwapStep = Math.floor(t / 0.35)
    if (charSwapStep !== lastCharSwap) {
      lastCharSwap = charSwapStep
      for (let i = 0; i < MAX_CODE; i++) {
        if (Math.random() < 0.35) {
          chars[i] = Math.floor(Math.random() * 64)
        }
      }
      charAttr.needsUpdate = true
    }
  }

  return {
    points,
    update,
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}

// —— 水下场景全景（组装）——
export interface UnderwaterScene {
  group: THREE.Group
  seabed: ReturnType<typeof createSeabed>
  caustics: ReturnType<typeof createCaustics>
  lightShafts: ReturnType<typeof createLightShafts>
  code: ReturnType<typeof createCodeParticles>
  update: (
    dive: number,
    t: number,
    delta: number,
    camPos: THREE.Vector3,
    conf: OceanConf,
    mouseX: number,
    mouseY: number
  ) => void
  dispose: () => void
}

export function buildUnderwaterScene(
  atlas: THREE.Texture,
  extent: UnderwaterExtent
): UnderwaterScene {
  const group = new THREE.Group()
  const seabed = createSeabed(extent.bottomY)
  const caustics = createCaustics(extent.bottomY)
  const lightShafts = createLightShafts()
  const code = createCodeParticles(atlas)

  group.add(seabed.mesh)
  group.add(caustics.mesh)
  group.add(lightShafts.mesh)
  group.add(code.points)

  return {
    group,
    seabed,
    caustics,
    lightShafts,
    code,
    update: (dive, t, delta, camPos, c, mouseX, mouseY) => {
      // 海底实体地面：随潜入淡入（修复"海底看不见"）
      seabed.update(dive, c)
      // 海底光斑：统一 waveField 正色映射（浪峰聚光亮），随海面洋流同向晃动
      caustics.update(dive, t, c)
      // 海中光柱：浪谷三角向下拉伸，位置/方向与海面波浪实时对齐
      lightShafts.update(dive, t, c)
      // 代码粒子：洋流漂移 + 鼠标视差同向缓慢跟随
      code.update(t, c, mouseX, mouseY)
      void delta
      void camPos
    },
    dispose: () => {
      seabed.dispose()
      caustics.dispose()
      lightShafts.dispose()
      code.dispose()
    },
  }
}
