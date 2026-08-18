import type { OceanConf } from "./ocean-conf"

// ---------------------------------------------------------------------------
// 统一波浪骨架（sea-field）
//   · 单一权威实现：海面高度 = waveField(世界 XZ, 时间)
//   · GLSL 版（seaFieldGLSL）供海面 / 海底光斑 shader 共用
//   · JS  版（seaFieldCPU）供海中光柱在 CPU 取波谷定位，逐位一致
//   三者全部用「世界坐标 XZ」采样同一个函数 → 参数、方向、位置天然一致。
//
// 映射规则（对同一个 waveField 结果做不同映射）：
//   ① 海面     ：height → 波浪位移 + 浪花颜色
//   ② 海中光柱 ：取反(-height) → 光照强度（浪峰高 → 无光；浪谷低 → 透光）
//                位置 = 波谷（透光点）
//   ③ 海底光斑 ：取反(-height) → 底面亮度
// ---------------------------------------------------------------------------

// —— GLSL 版：只含函数（uniform 由使用方 shader 声明）——
export const seaFieldGLSL = /* glsl */ `
  //  Classic Perlin 3D Noise
  //  by Stefan Gustavson
  //
  vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
  vec3 fade(vec3 t) {return t*t*t*(t*(t*6.0-15.0)+10.0);}

  float cnoise(vec3 P){
    vec3 Pi0 = floor(P);
    vec3 Pi1 = Pi0 + vec3(1.0);
    Pi0 = mod(Pi0, 289.0);
    Pi1 = mod(Pi1, 289.0);
    vec3 Pf0 = fract(P);
    vec3 Pf1 = Pf0 - vec3(1.0);
    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    vec4 iy = vec4(Pi0.yy, Pi1.yy);
    vec4 iz0 = Pi0.zzzz;
    vec4 iz1 = Pi1.zzzz;
    vec4 ixy = permute(permute(ix) + iy);
    vec4 ixy0 = permute(ixy + iz0);
    vec4 ixy1 = permute(ixy + iz1);
    vec4 gx0 = ixy0 / 7.0;
    vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
    gx0 = fract(gx0);
    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
    vec4 sz0 = step(gz0, vec4(0.0));
    gx0 -= sz0 * (step(0.0, gx0) - 0.5);
    gy0 -= sz0 * (step(0.0, gy0) - 0.5);
    vec4 gx1 = ixy1 / 7.0;
    vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
    gx1 = fract(gx1);
    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
    vec4 sz1 = step(gz1, vec4(0.0));
    gx1 -= sz1 * (step(0.0, gx1) - 0.5);
    gy1 -= sz1 * (step(0.0, gy1) - 0.5);
    vec3 g000 = vec3(gx0.x,gy0.x,gz0.x);
    vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
    vec3 g010 = vec3(gx0.z,gy0.z,gz0.z);
    vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
    vec3 g001 = vec3(gx1.x,gy1.x,gz1.x);
    vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
    vec3 g011 = vec3(gx1.z,gy1.z,gz1.z);
    vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);
    vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
    g000 *= norm0.x;
    g010 *= norm0.y;
    g100 *= norm0.z;
    g110 *= norm0.w;
    vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
    g001 *= norm1.x;
    g011 *= norm1.y;
    g101 *= norm1.z;
    g111 *= norm1.w;
    float n000 = dot(g000, Pf0);
    float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
    float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
    float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
    float n111 = dot(g111, Pf1);
    vec3 fade_xyz = fade(Pf0);
    vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
    float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
  }

  // 简单确定性哈希（用于碎浪采样偏移，制造不重复的随机感）
  float hash11(float p) {
    return fract(sin(p * 127.1) * 43758.5453);
  }

  // 参考「水天一色」的指数波：波峰尖锐、波谷平缓，比纯 sin 更真实
  float wavedx(vec2 position, vec2 direction, float speed, float frequency, float timeshift) {
    float x = dot(direction, position) * frequency + timeshift * speed;
    return exp(sin(x) - 1.0);
  }

  // 统一波浪高度骨架：世界 XZ + 时间 → 海面位移高度
  // 依赖 uniforms（使用方声明）：uFlowDir(uFlowSpeed) uWaveElevation uWaveIterations
  //   uWaveDrag uSwellStrength uSwellScale uSwellSpeed uSmallWavesElevation
  //   uSmallWavesFrequency uSmallWavesSpeed uSmallWavesIterations
  //   uMidElevation uMidScale uMidSpeed
  //   uWaveDensity（海浪密度：缩放空间频率）uWaveSpeed（海浪移速：缩放波传播时间）
  float waveField(vec2 worldXZ, float time) {
    vec2 samplePos = worldXZ - uFlowDir * time * uFlowSpeed;
    // 波传播时间（海浪移速）：仅影响波浪自身的传播，不影响海面纹样漂移（flowSpeed）
    float wt = time * uWaveSpeed;

    // ① 涌浪分组：低频噪声调制主浪振幅（浪高差异明显的核心）
    float swell = cnoise(vec3(samplePos * uSwellScale * uWaveDensity, wt * uSwellSpeed));
    float amp = uWaveElevation * (1.0 + swell * uSwellStrength);

    // ② 主浪：wavedx 多方向指数波叠加 + 拖拽累积
    vec2 wavePos = samplePos * 0.35 * uWaveDensity;
    float iter = 0.0;
    float phase = 5.0;
    float speed = 1.6;
    float weight = 1.0;
    float w = 0.0;
    float ws = 0.0;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uWaveIterations) {
        break;
      }
      vec2 dir = vec2(sin(iter), cos(iter));
      float res = wavedx(wavePos, dir, speed, phase, wt);
      wavePos += dir * res * weight * uWaveDrag;
      w += res * weight;
      iter += 12.0;
      ws += weight;
      weight = mix(weight, 0.0, 0.2);
      phase *= 1.18;
      speed *= 1.07;
    }
    // wavedx 输出 ∈ [0.37, 1]，归一到 [-1, 1] 再乘振幅
    float normalized = clamp((w / ws - 0.368) / 0.632, 0.0, 1.0);
    float elevation = (normalized - 0.5) * 2.0 * amp;

    // ③ 小波碎浪：Perlin 多迭代 abs 下凹，采样带动态偏移
    for (float i = 1.0; i <= 10.0; i++) {
      if (i > uSmallWavesIterations) {
        break;
      }
      vec2 off = vec2(hash11(i * 3.7) * 120.0, hash11(i * 9.1) * 120.0);
      float tShift = hash11(i * 5.3) * 20.0;
      float n = cnoise(vec3(
        samplePos * uSmallWavesFrequency * i * 1.35 * uWaveDensity + off,
        wt * uSmallWavesSpeed * (1.0 + 0.15 * i) + tShift
      ));
      elevation -= abs(n) * uSmallWavesElevation / i;
    }

    // ④ 中频随机起伏（正负双向），进一步打破重复
    float mid = cnoise(vec3(samplePos * uMidScale * uWaveDensity, wt * uMidSpeed));
    elevation += mid * uMidElevation;

    return elevation;
  }
`

// ---------------------------------------------------------------------------
// —— JS 版（与 GLSL waveField 逐位一致，用于 CPU 取波谷定位光柱）——
// ---------------------------------------------------------------------------
const mod289 = (x: number) => x - Math.floor(x / 289) * 289
const permute = (x: number) => mod289((x * 34 + 1) * x)
const taylorInvSqrt = (r: number) => 1.79284291400159 - 0.85373472095314 * r
const fadeT = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const mixN = (a: number, b: number, t: number) => a + (b - a) * t
const stepF = (edge: number, x: number) => (x >= edge ? 1 : 0)
const fractV = (v: number) => v - Math.floor(v)
const dot3 = (g: number[], p: number[]) =>
  g[0] * p[0] + g[1] * p[1] + g[2] * p[2]
const scaleGrad = (g: number[], n: number): [number, number, number] => [
  g[0] * n,
  g[1] * n,
  g[2] * n,
]
const clampN = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v))
const hash11 = (p: number) => {
  const s = Math.sin(p * 127.1) * 43758.5453
  return s - Math.floor(s)
}

function cnoise3(x: number, y: number, z: number): number {
  const Pi0x = Math.floor(x)
  const Pi0y = Math.floor(y)
  const Pi0z = Math.floor(z)
  const Pi1x = Pi0x + 1
  const Pi1y = Pi0y + 1
  const Pi1z = Pi0z + 1
  const mPi0x = mod289(Pi0x)
  const mPi1x = mod289(Pi1x)
  const mPi0y = mod289(Pi0y)
  const mPi1y = mod289(Pi1y)
  const mPi0z = mod289(Pi0z)
  const mPi1z = mod289(Pi1z)
  const Pf0x = x - Pi0x
  const Pf0y = y - Pi0y
  const Pf0z = z - Pi0z
  const Pf1x = Pf0x - 1
  const Pf1y = Pf0y - 1
  const Pf1z = Pf0z - 1

  const ix = [mPi0x, mPi1x, mPi0x, mPi1x]
  const iy = [mPi0y, mPi0y, mPi1y, mPi1y]
  const iz0 = mPi0z
  const iz1 = mPi1z

  const ixy = ix.map((v, i) => permute(permute(v) + iy[i]))
  const ixy0 = ixy.map((v) => permute(v + iz0))
  const ixy1 = ixy.map((v) => permute(v + iz1))

  const gx0 = ixy0.map((v) => fractV(v / 7))
  const gy0 = ixy0.map((v) => {
    const floorG = Math.floor(v / 7)
    return floorG / 7 - Math.floor(floorG / 7) - 0.5
  })
  const gz0 = gx0.map((gx, i) => 0.5 - Math.abs(gx) - Math.abs(gy0[i]))
  const sz0 = gz0.map((gz) => stepF(0, gz))
  const gx0c = gx0.map((gx, i) => gx - sz0[i] * (stepF(0, gx) - 0.5))
  const gy0c = gy0.map((gy, i) => gy - sz0[i] * (stepF(0, gy) - 0.5))

  const gx1 = ixy1.map((v) => fractV(v / 7))
  const gy1 = ixy1.map((v) => {
    const floorG = Math.floor(v / 7)
    return floorG / 7 - Math.floor(floorG / 7) - 0.5
  })
  const gz1 = gx1.map((gx, i) => 0.5 - Math.abs(gx) - Math.abs(gy1[i]))
  const sz1 = gz1.map((gz) => stepF(0, gz))
  const gx1c = gx1.map((gx, i) => gx - sz1[i] * (stepF(0, gx) - 0.5))
  const gy1c = gy1.map((gy, i) => gy - sz1[i] * (stepF(0, gy) - 0.5))

  const g000 = [gx0c[0], gy0c[0], gz0[0]]
  const g100 = [gx0c[1], gy0c[1], gz0[1]]
  const g010 = [gx0c[2], gy0c[2], gz0[2]]
  const g110 = [gx0c[3], gy0c[3], gz0[3]]
  const g001 = [gx1c[0], gy1c[0], gz1[0]]
  const g101 = [gx1c[1], gy1c[1], gz1[1]]
  const g011 = [gx1c[2], gy1c[2], gz1[2]]
  const g111 = [gx1c[3], gy1c[3], gz1[3]]

  const norm0 = [g000, g010, g100, g110].map((g) =>
    taylorInvSqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2])
  )
  const norm1 = [g001, g011, g101, g111].map((g) =>
    taylorInvSqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2])
  )
  const g000n = scaleGrad(g000, norm0[0])
  const g010n = scaleGrad(g010, norm0[1])
  const g100n = scaleGrad(g100, norm0[2])
  const g110n = scaleGrad(g110, norm0[3])
  const g001n = scaleGrad(g001, norm1[0])
  const g011n = scaleGrad(g011, norm1[1])
  const g101n = scaleGrad(g101, norm1[2])
  const g111n = scaleGrad(g111, norm1[3])

  const n000 = dot3(g000n, [Pf0x, Pf0y, Pf0z])
  const n100 = dot3(g100n, [Pf1x, Pf0y, Pf0z])
  const n010 = dot3(g010n, [Pf0x, Pf1y, Pf0z])
  const n110 = dot3(g110n, [Pf1x, Pf1y, Pf0z])
  const n001 = dot3(g001n, [Pf0x, Pf0y, Pf1z])
  const n101 = dot3(g101n, [Pf1x, Pf0y, Pf1z])
  const n011 = dot3(g011n, [Pf0x, Pf1y, Pf1z])
  const n111 = dot3(g111n, [Pf1x, Pf1y, Pf1z])

  const fz = fadeT(Pf0z)
  const fy = fadeT(Pf0y)
  const fx = fadeT(Pf0x)
  const n_z0 = mixN(n000, n001, fz)
  const n_z1 = mixN(n100, n101, fz)
  const n_z2 = mixN(n010, n011, fz)
  const n_z3 = mixN(n110, n111, fz)
  const n_y0 = mixN(n_z0, n_z2, fy)
  const n_y1 = mixN(n_z1, n_z3, fy)
  return 2.2 * mixN(n_y0, n_y1, fx)
}

// 统一波浪高度（世界 XZ + 时间 → 高度，与 GLSL waveField 逐位一致）
export function seaFieldCPU(
  x: number,
  z: number,
  t: number,
  c: OceanConf
): number {
  // 流向角度 → 方向向量（与海面 flowAngle 一致）
  const a = c.flowAngle * (Math.PI / 180)
  const nx = Math.sin(a)
  const nz = Math.cos(a)
  const sx = x - nx * t * c.flowSpeed
  const sz = z - nz * t * c.flowSpeed
  // 波传播时间（海浪移速）
  const wt = t * c.waveSpeed

  const swell = cnoise3(
    sx * c.swellScale * c.waveDensity,
    sz * c.swellScale * c.waveDensity,
    wt * c.swellSpeed
  )
  const amp = c.waveHeight * (1 + swell * c.swellStrength)

  let wavePosX = sx * 0.35 * c.waveDensity
  let wavePosZ = sz * 0.35 * c.waveDensity
  let iter = 0
  let phase = 5.0
  let speed = 1.6
  let weight = 1.0
  let w = 0
  let ws = 0
  const iters = Math.ceil(c.waveIterations)
  for (let i = 0; i < iters; i++) {
    const dirX = Math.sin(iter)
    const dirZ = Math.cos(iter)
    const xv = (dirX * wavePosX + dirZ * wavePosZ) * phase + wt * speed
    const res = Math.exp(Math.sin(xv) - 1)
    wavePosX += dirX * res * weight * c.waveDrag
    wavePosZ += dirZ * res * weight * c.waveDrag
    w += res * weight
    iter += 12
    ws += weight
    weight = weight + (0 - weight) * 0.2
    phase *= 1.18
    speed *= 1.07
  }
  const normalized = clampN((w / ws - 0.368) / 0.632, 0, 1)
  let elevation = (normalized - 0.5) * 2 * amp

  const smallIters = Math.ceil(c.smallIterations)
  for (let i = 1; i <= smallIters; i++) {
    const offX = hash11(i * 3.7) * 120
    const offZ = hash11(i * 9.1) * 120
    const tShift = hash11(i * 5.3) * 20
    const n = cnoise3(
      sx * c.smallFrequency * i * 1.35 * c.waveDensity + offX,
      sz * c.smallFrequency * i * 1.35 * c.waveDensity + offZ,
      wt * c.smallSpeed * (1 + 0.15 * i) + tShift
    )
    elevation -= (Math.abs(n) * c.smallElevation) / i
  }

  const mid = cnoise3(
    sx * c.midScale * c.waveDensity,
    sz * c.midScale * c.waveDensity,
    wt * c.midSpeed
  )
  elevation += mid * c.midElevation

  return elevation
}
