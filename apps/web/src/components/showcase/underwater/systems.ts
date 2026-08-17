import * as THREE from "three"

import {
  bubbleFragmentShader,
  bubbleVertexShader,
  causticsFragmentShader,
  causticsVertexShader,
  codeCharFragmentShader,
  codeCharVertexShader,
  godRayFragmentShader,
  godRayVertexShader,
} from "./shaders"

// ---------------------------------------------------------------------------
// 水下系统构建器：caustics（折射光影）/ godRays（丁达尔）/ bubbles（气泡）
// / codeParticles（漂浮代码）
// ---------------------------------------------------------------------------

// —— caustics：海底折射光影（参考 giser2017 领域扭曲算法）——
export function createCaustics(): {
  mesh: THREE.Mesh
  update: (dive: number, t: number) => void
  dispose: () => void
} {
  const geometry = new THREE.PlaneGeometry(60, 60, 32, 32)
  geometry.rotateX(-Math.PI * 0.5)
  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 9.0 },
    uSpeed: { value: 0.28 },
    uFlowSpeed: { value: new THREE.Vector2(0.02, 0.015) },
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
  // 铺在海底（相机水下看斜下方时作为海底本体）
  mesh.position.set(0, -6.2, -7)

  return {
    mesh,
    update: (dive: number, t: number) => {
      uniforms.uTime.value = t
      uniforms.uOpacity.value = dive
    },
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}

// —— 丁达尔光柱：7 根阳光射入海底 ——
const GOD_RAY_POSITIONS: Array<[number, number, number, number]> = [
  [-5.2, 2.4, -2.5, 0.0],
  [-2.4, 2.8, -4.2, 1.2],
  [0.2, 3.0, -1.2, 2.4],
  [2.6, 2.6, -5.4, 3.6],
  [5.0, 3.2, -2.8, 4.8],
  [-1.2, 2.2, -7.5, 5.6],
  [3.6, 2.0, -8.2, 6.4],
]

export function createGodRays(): {
  group: THREE.Group
  update: (dive: number, t: number) => void
  dispose: () => void
} {
  const group = new THREE.Group()
  const materials: THREE.ShaderMaterial[] = []
  const geometry = new THREE.PlaneGeometry(3.6, 16)

  for (const [x, y, z, phase] of GOD_RAY_POSITIONS) {
    const material = new THREE.ShaderMaterial({
      vertexShader: godRayVertexShader,
      fragmentShader: godRayFragmentShader,
      uniforms: {
        uOpacity: { value: 0 },
        uPhase: { value: phase },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    // 从水面斜射向海底
    mesh.rotation.x = 0.55
    mesh.rotation.z = (Math.random() - 0.5) * 0.3
    group.add(mesh)
    materials.push(material)
  }

  return {
    group,
    update: (dive: number, t: number) => {
      for (const material of materials) {
        const phase = material.uniforms.uPhase.value as number
        // 透明度随潜入淡入 + 缓慢呼吸
        material.uniforms.uOpacity.value =
          dive * 0.5 * (0.72 + 0.28 * Math.sin(t * 0.12 + phase))
      }
    },
    dispose: () => {
      geometry.dispose()
      for (const material of materials) {
        material.dispose()
      }
    },
  }
}

// —— 气泡系统：过场泳镜气泡 + 环境气泡（池化）——
const MAX_BUBBLES = 700

interface BubbleState {
  vel: THREE.Vector3
  ttl: number
  maxTtl: number
  baseScale: number
  alive: boolean
  seed: number
}

export function createBubbleSystem(): {
  points: THREE.Points
  /** 过场：相机周围喷一大团气泡（泳镜效果） */
  burst: (count: number, center: THREE.Vector3) => void
  /** 环境：在指定范围持续冒泡 */
  spawnAmbient: (
    count: number,
    center: THREE.Vector3,
    range: THREE.Vector3
  ) => void
  update: (delta: number, t: number) => void
  dispose: () => void
} {
  const positions = new Float32Array(MAX_BUBBLES * 3)
  const scales = new Float32Array(MAX_BUBBLES)
  const alphas = new Float32Array(MAX_BUBBLES)
  const state: BubbleState[] = []
  for (let i = 0; i < MAX_BUBBLES; i++) {
    state.push({
      vel: new THREE.Vector3(),
      ttl: 0,
      maxTtl: 1,
      baseScale: 0.2,
      alive: false,
      seed: Math.random() * 100,
    })
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute("aScale", new THREE.BufferAttribute(scales, 1))
  geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1))

  const material = new THREE.ShaderMaterial({
    vertexShader: bubbleVertexShader,
    fragmentShader: bubbleFragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color("#cdeaff") },
      uOpacity: { value: 1 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false

  const spawn = (
    center: THREE.Vector3,
    range: THREE.Vector3,
    velUp: [number, number],
    ttl: [number, number],
    scale: [number, number]
  ) => {
    const slot = state.find((s) => !s.alive)
    if (!slot) {
      return
    }
    const index = state.indexOf(slot)
    positions[index * 3] = center.x + (Math.random() - 0.5) * 2 * range.x
    positions[index * 3 + 1] = center.y + (Math.random() - 0.5) * 2 * range.y
    positions[index * 3 + 2] = center.z + (Math.random() - 0.5) * 2 * range.z
    slot.vel.set(
      (Math.random() - 0.5) * 1.2,
      velUp[0] + Math.random() * (velUp[1] - velUp[0]),
      (Math.random() - 0.5) * 1.2
    )
    slot.maxTtl = ttl[0] + Math.random() * (ttl[1] - ttl[0])
    slot.ttl = slot.maxTtl
    slot.baseScale = scale[0] + Math.random() * (scale[1] - scale[0])
    slot.alive = true
    slot.seed = Math.random() * 100
    scales[index] = slot.baseScale
    alphas[index] = 0
  }

  const burst = (count: number, center: THREE.Vector3) => {
    // 贴相机的大气泡团：范围大、上浮快、寿命短
    for (let i = 0; i < count; i++) {
      spawn(
        center,
        new THREE.Vector3(7, 4.5, 6),
        [3.2, 5.6],
        [1.6, 3.2],
        [0.25, 0.6]
      )
    }
  }

  const spawnAmbient = (
    count: number,
    center: THREE.Vector3,
    range: THREE.Vector3
  ) => {
    for (let i = 0; i < count; i++) {
      spawn(center, range, [1.6, 2.8], [3.0, 6.0], [0.1, 0.3])
    }
  }

  const update = (delta: number, t: number) => {
    let needsUpdate = false
    for (let i = 0; i < MAX_BUBBLES; i++) {
      const s = state[i]
      if (!s.alive) {
        continue
      }
      s.ttl -= delta
      if (s.ttl <= 0) {
        s.alive = false
        alphas[i] = 0
        needsUpdate = true
        continue
      }
      // 上浮 + 左右漂移
      positions[i * 3] += s.vel.x * delta
      positions[i * 3 + 1] += s.vel.y * delta
      positions[i * 3 + 2] += s.vel.z * delta
      // 寿命渐出 + 微闪烁
      const life = s.ttl / s.maxTtl
      const flicker = 0.75 + 0.25 * Math.sin(t * 6 + s.seed * 10)
      alphas[i] = Math.min(1, life * 2) * flicker
      needsUpdate = true
    }
    if (needsUpdate) {
      ;(geometry.attributes.position as THREE.BufferAttribute).needsUpdate =
        true
      ;(geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true
    }
  }

  return {
    points,
    burst,
    spawnAmbient,
    update,
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}

// —— 漂浮代码粒子 ——
const MAX_CODE = 4000
// 青绿蓝随机调色板（海底氛围）
const CODE_PALETTE = [
  new THREE.Color("#b8ecff"),
  new THREE.Color("#73d4f0"),
  new THREE.Color("#61a8f5"),
  new THREE.Color("#52c9d1"),
  new THREE.Color("#a9c8ff"),
]

export function createCodeParticles(atlas: THREE.Texture): {
  points: THREE.Points
  update: (t: number) => void
  dispose: () => void
} {
  const positions = new Float32Array(MAX_CODE * 3)
  const basePositions = new Float32Array(MAX_CODE * 3)
  const seeds = new Float32Array(MAX_CODE)
  const chars = new Float32Array(MAX_CODE)
  const alphas = new Float32Array(MAX_CODE)
  const colors = new Float32Array(MAX_CODE * 3)

  const color = new THREE.Color()
  for (let i = 0; i < MAX_CODE; i++) {
    const x = (Math.random() - 0.5) * 28
    const y = -1 - Math.random() * 7.5
    const z = -16 + Math.random() * 20
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
    basePositions[i * 3] = x
    basePositions[i * 3 + 1] = y
    basePositions[i * 3 + 2] = z
    seeds[i] = Math.random() * 100
    chars[i] = Math.floor(Math.random() * 64)
    alphas[i] = 0.35 + Math.random() * 0.6
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

  const update = (t: number) => {
    for (let i = 0; i < MAX_CODE; i++) {
      const seed = seeds[i]
      positions[i * 3] =
        basePositions[i * 3] + Math.sin(t * 0.3 + seed * 90) * 0.8
      positions[i * 3 + 1] =
        basePositions[i * 3 + 1] + Math.sin(t * 0.45 + seed * 45) * 0.5
      positions[i * 3 + 2] =
        basePositions[i * 3 + 2] + Math.cos(t * 0.35 + seed * 30) * 0.5
    }
    ;(geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
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
  caustics: ReturnType<typeof createCaustics>
  godRays: ReturnType<typeof createGodRays>
  bubbles: ReturnType<typeof createBubbleSystem>
  code: ReturnType<typeof createCodeParticles>
  update: (
    dive: number,
    t: number,
    delta: number,
    camPos: THREE.Vector3
  ) => void
  dispose: () => void
}

export function buildUnderwaterScene(atlas: THREE.Texture): UnderwaterScene {
  const group = new THREE.Group()
  const caustics = createCaustics()
  const godRays = createGodRays()
  const bubbles = createBubbleSystem()
  const code = createCodeParticles(atlas)

  group.add(caustics.mesh)
  group.add(godRays.group)
  group.add(bubbles.points)
  group.add(code.points)

  // 环境气泡：在相机前方海底区域持续冒泡
  let ambientTimer = 0
  const ambientCenter = new THREE.Vector3(0, -5.5, -6)
  const ambientRange = new THREE.Vector3(10, 2.5, 9)

  return {
    group,
    caustics,
    godRays,
    bubbles,
    code,
    update: (dive, t, delta, camPos) => {
      caustics.update(dive, t)
      godRays.update(dive, t)
      bubbles.update(delta, t)
      code.update(t)
      if (dive > 0.6) {
        ambientTimer += delta
        if (ambientTimer > 0.16) {
          ambientTimer = 0
          bubbles.spawnAmbient(1, ambientCenter, ambientRange)
        }
      }
      void camPos
    },
    dispose: () => {
      caustics.dispose()
      godRays.dispose()
      bubbles.dispose()
      code.dispose()
    },
  }
}
