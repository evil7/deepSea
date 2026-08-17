import { useEffect, useRef } from "react"
import * as THREE from "three"

import { createCodeAtlas } from "@/components/showcase/underwater/atlas"
import { buildUnderwaterScene } from "@/components/showcase/underwater/systems"

// ---------------------------------------------------------------------------
// Ocean —— 3D 物理海浪背景 + 滚动潜入海底（工程化版）
// 效果源自 Open Three「波涛海浪」「水天一色」与 giser2017「波浪效果」：
//   · 海面：wavedx 指数波（exp(sin-1)，波峰尖）× 多方向迭代 + Gerstner 拖拽
//           + Perlin 涌浪/碎浪 → 天然随机，浪高差异明显
//   · 着色：fresnel 天空反射 + 太阳高光 + ACES filmic tonemap
//   · 背景：程序化渐变天空（海天一色）
//   · 滚动潜入：下滑越过视口 40% → 泳镜气泡过场 → 沉入海底
//       - 丁达尔光柱（阳光射入海底）
//       - 水波折射光影 caustics（参考 giser2017 领域扭曲算法）
//       - 漂浮代码字符 + 环境气泡 + 水膜遮罩
//
// ── 调参速查（改 WAVE 对象即可，保存即热更新）────────────────────────
// 【主浪】wavedx 多方向指数波，浪形随机性的核心
//   waveElevation      整体浪高（0 ~ 0.6，越大浪越高）
//   waveIterations     波方向迭代次数（3 ~ 8，越多越随机也越吃性能）
//   waveDrag           拖拽系数（0 ~ 0.12，波间拉扯感，越大越"活"）
// 【涌浪分组】低频噪声调制主浪 —— 浪高差异明显的关键
//   swellStrength      调制强度（0 = 无分组；0.5+ = 明显涌浪）
//   swellScale         涌浪空间尺度（越小分组越大）
//   swellSpeed         涌浪变化速度
// 【小波】Perlin 碎浪（abs 下凹，浪花碎痕）
//   smallElevation     碎浪深度（0 ~ 0.3）
//   smallFrequency     碎浪基础频率
//   smallSpeed         碎浪刷新速度
//   smallIterations    碎浪迭代次数（1 ~ 10）
// 【中频起伏】正负双向随机浪涌
//   midElevation       中频起伏幅度
//   midScale / midSpeed
// 【海面配色】
//   depthColor         深水色（浪谷）
//   surfaceColor       波峰亮蓝（兼作太阳高光色）
//   colorOffset / colorMultiplier  明暗过渡
//   fresnelStrength    天空反射强度（0 ~ 1，越大海天越浑然一体）
//   specularStrength / specularPower  太阳镜面高光强度/锐度
// 【天空（海天一色）】
//   skyHorizon         地平线亮蓝（海天交接处）
//   skyZenith          天顶深蓝
//   sunDirection       太阳方向（决定高光与光晕位置）
// 【雾】fogColor 应与地平线同色系，远处海面才能融入天际线
//   fogColor / fogNear / fogFar
// 【相机】camera —— 海面俯瞰机位 + 鼠标视差；cameraUnder —— 水下机位
// 【潜水】滚动越过阈值触发潜入，气泡过场后进入水下场景
//   diveThreshold      滚动触发阈值（视口高度比例，0 ~ 1）
//   diveDuration       潜入/浮出动画时长（秒）
//   fogUnder           水下雾色（与深海背景同色系）
//   skyUnderTop/skyUnderBottom  水下深海渐变背景（上亮下暗）
// ---------------------------------------------------------------------------

const WAVE = {
  // 主浪（wavedx 多方向指数波）
  waveElevation: 0.3,
  waveIterations: 6,
  waveDrag: 0.06,
  // 涌浪分组（噪声调制主浪，制造明显的高度差异）
  swellStrength: 0.55,
  swellScale: 0.9,
  swellSpeed: 0.22,
  // 小波（Perlin 噪声，迭代减幅成碎浪）
  smallElevation: 0.12,
  smallFrequency: 3,
  smallSpeed: 0.2,
  smallIterations: 4,
  // 中频随机起伏（正负双向，进一步打破重复）
  midElevation: 0.08,
  midScale: 2.4,
  midSpeed: 0.4,
  // 海面配色（浪峰=主色亮蓝，浪底=深水色）
  depthColor: new THREE.Color("#0d1f3d"),
  surfaceColor: new THREE.Color("#5b7cff"),
  colorOffset: 0.08,
  colorMultiplier: 6,
  fresnelStrength: 0.9,
  specularStrength: 1.1,
  specularPower: 128,
  // 天空（海天一色：地平线亮蓝 → 天顶深蓝 + 太阳方向）
  skyHorizon: new THREE.Color("#3d6ea8"),
  skyZenith: new THREE.Color("#040b18"),
  sunDirection: new THREE.Vector3(0.5, 0.32, 0.8).normalize(),
  // 距离雾（与地平线同色系，远海融入天际线）
  fogColor: new THREE.Color("#1a3350"),
  fogNear: 2,
  fogFar: 10,
  // 相机（海面俯瞰机位 + 鼠标视差）
  camera: new THREE.Vector3(1, 1, 1),
  // 潜水：滚动触发潜入 + 水下机位 + 水下配色
  diveThreshold: 0.4,
  diveDuration: 2.0,
  cameraUnder: new THREE.Vector3(0, -3.6, 5.5),
  fogUnder: new THREE.Color("#04131f"),
  fogUnderNear: 3,
  fogUnderFar: 22,
  skyUnderTop: new THREE.Color("#0d4a6e"),
  skyUnderBottom: new THREE.Color("#020d18"),
} as const

// 水面细分（512 足够呈现碎浪细节，又不至于压垮移动端）
const GEOMETRY_SIZE = 12
const GEOMETRY_SEGMENTS = 512

// ---------------------------------------------------------------------------
// 顶点着色器
// 波浪三层结构，全部在 GPU 完成：
//   ① 主浪：wavedx 指数波（exp(sin-1)，波峰尖、波谷平）× 多方向迭代叠加
//           + 拖拽累积（Gerstner 式水平位移，波间互相拉扯）→ 天然随机
//   ② 小波：Perlin cnoise 多迭代，abs 下凹碎浪，采样带动态偏移
//   ③ 中频随机起伏（正负双向）
//   并输出 vWorldPosition 供片元做 fresnel 天空反射（海天一色）
// ---------------------------------------------------------------------------
const vertexShader = /* glsl */ `
  #include <fog_pars_vertex>

  uniform float uTime;
  uniform float uWaveElevation;
  uniform float uWaveIterations;
  uniform float uWaveDrag;
  uniform float uSwellStrength;
  uniform float uSwellScale;
  uniform float uSwellSpeed;
  uniform float uSmallWavesElevation;
  uniform float uSmallWavesFrequency;
  uniform float uSmallWavesSpeed;
  uniform float uSmallWavesIterations;
  uniform float uMidElevation;
  uniform float uMidScale;
  uniform float uMidSpeed;

  varying float vElevation;
  varying vec3 vWorldPosition;

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

  void main() {
    #include <begin_vertex>
    #include <project_vertex>
    #include <fog_vertex>

    vec4 modelPosition = modelMatrix * vec4(position, 1.0);

    // ① 涌浪分组：低频噪声调制主浪振幅（浪高差异明显的核心）
    float swell = cnoise(vec3(
      modelPosition.xz * uSwellScale,
      uTime * uSwellSpeed
    ));
    float amp = uWaveElevation * (1.0 + swell * uSwellStrength);

    // ② 主浪：wavedx 多方向指数波叠加 + 拖拽累积
    //    方向每轮旋转（iter += 12°），频率/速度倍增、权重衰减 → 天然随机不重复
    vec2 wavePos = modelPosition.xz * 0.35;
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
      float res = wavedx(wavePos, dir, speed, phase, uTime);
      // 拖拽：波的能量沿传播方向拉扯采样坐标，波与波互相挤压 → 高差更明显
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

    // ③ 小波碎浪：Perlin 多迭代 abs 下凹，采样带动态偏移（随机感刷新）
    for (float i = 1.0; i <= 10.0; i++) {
      if (i > uSmallWavesIterations) {
        break;
      }
      // 每迭代独立的采样偏移 + 时间相位，避免碎浪纹样重复
      vec2 off = vec2(hash11(i * 3.7) * 120.0, hash11(i * 9.1) * 120.0);
      float tShift = hash11(i * 5.3) * 20.0;
      float n = cnoise(vec3(
        modelPosition.xz * uSmallWavesFrequency * i * 1.35 + off,
        uTime * uSmallWavesSpeed * (1.0 + 0.15 * i) + tShift
      ));
      elevation -= abs(n) * uSmallWavesElevation / i;
    }

    // ④ 中频随机起伏（正负双向），进一步打破重复
    float mid = cnoise(vec3(
      modelPosition.xz * uMidScale,
      uTime * uMidSpeed
    ));
    elevation += mid * uMidElevation;

    modelPosition.y += elevation;
    vElevation = elevation;
    vWorldPosition = modelPosition.xyz;

    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;
    gl_Position = projectedPosition;
  }
`

// ---------------------------------------------------------------------------
// 片元着色器
// 海面 = 深水色（浪谷）↔ 波峰亮蓝（浪峰）渐变
//      + fresnel 天空反射（近掠角反射天空色 → 海天一色）
//      + 太阳镜面高光（波峰闪光）
// 颜色在 linear 空间计算，末尾交给 three 内置
//   tonemapping_fragment（ACESFilmicToneMapping）+ colorspace_fragment（sRGB）
// 与场景背景（天空纹理）走同一输出管线，保证海天颜色一致
// 注意：tonemapping/colorspace 的 pars 函数由 three 自动注入，此处只 include
//       使用点 chunk，否则会重复定义导致编译失败
// 法线用屏幕空间导数重建（dFdx/dFdy），无需额外顶点法线数据
// ---------------------------------------------------------------------------
const fragmentShader = /* glsl */ `
  #include <fog_pars_fragment>

  precision highp float;

  uniform vec3 uDepthColor;
  uniform vec3 uSurfaceColor;
  uniform float uColorOffset;
  uniform float uColorMultiplier;
  uniform float uFresnelStrength;
  uniform float uSpecularStrength;
  uniform float uSpecularPower;
  uniform vec3 uSkyHorizon;
  uniform vec3 uSkyZenith;
  uniform vec3 uSunDirection;

  varying float vElevation;
  varying vec3 vWorldPosition;

  // 海天一色的天空：地平线亮蓝 → 天顶深蓝（近似大气散射）
  vec3 getSky(vec3 dir) {
    float t = pow(max(dir.y, 0.0), 0.6);
    vec3 sky = mix(uSkyHorizon, uSkyZenith, t);
    // 太阳光晕（柔和暖白）
    float sun = pow(max(dot(dir, uSunDirection), 0.0), 32.0);
    sky += vec3(1.0, 0.95, 0.85) * sun * 0.35;
    return sky;
  }

  void main() {
    // 屏幕空间导数重建世界法线（浪面真实朝向 → fresnel 正确）
    vec3 worldPos = vWorldPosition;
    vec3 dx = dFdx(worldPos);
    vec3 dy = dFdy(worldPos);
    vec3 N = normalize(cross(dx, dy));

    vec3 viewDir = normalize(cameraPosition - worldPos);
    vec3 R = reflect(-viewDir, N);

    // fresnel：近掠角（看浪脊线）反射天空 → 海天浑然一体
    // 必须 clamp，否则波谷背面（dot 为负）会使 mix 溢出成过饱和色
    float fresnel = clamp(0.04 + 0.96 * pow(1.0 - max(dot(N, viewDir), 0.0), 5.0), 0.0, 1.0);

    // 基础水色：浪谷深水色 ↔ 波峰亮蓝（按浪高渐变）
    float mixStrength = (vElevation + uColorOffset) * uColorMultiplier;
    vec3 water = mix(uDepthColor, uSurfaceColor, clamp(mixStrength, 0.0, 1.0));

    // 天空反射 + fresnel 混合
    vec3 color = mix(water, getSky(R), fresnel * uFresnelStrength);

    // 太阳镜面高光（波峰闪光）
    float spec = pow(max(dot(R, uSunDirection), 0.0), uSpecularPower);
    color += uSurfaceColor * spec * uSpecularStrength;

    gl_FragColor = vec4(color, 1.0);
    // three 输出管线：ACES tone mapping → sRGB（与天空背景一致 → 海天一色）
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`

// 程序化天空渐变（地平线亮蓝 → 天顶深蓝，作为场景背景 → 海天一色）
function createSkyTexture(): THREE.CanvasTexture {
  return createVerticalGradientTexture(WAVE.skyZenith, WAVE.skyHorizon)
}

// 深海渐变背景（上方有光、越深越暗）
function createDeepTexture(): THREE.CanvasTexture {
  return createVerticalGradientTexture(WAVE.skyUnderTop, WAVE.skyUnderBottom)
}

function createVerticalGradientTexture(
  top: THREE.Color,
  bottom: THREE.Color
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas")
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext("2d")
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
    gradient.addColorStop(0, `#${top.getHexString()}`)
    gradient.addColorStop(1, `#${bottom.getHexString()}`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function Ocean() {
  const containerRef = useRef<HTMLDivElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    // —— 场景 / 相机 / 渲染器 ——
    const scene = new THREE.Scene()
    const skyTexture = createSkyTexture()
    const deepTexture = createDeepTexture()
    scene.background = skyTexture
    const fog = new THREE.Fog(WAVE.fogColor.clone(), WAVE.fogNear, WAVE.fogFar)
    scene.fog = fog

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    )
    camera.position.copy(WAVE.camera)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // ACES filmic tone mapping（与 fragment shader 的 tonemapping_fragment 配合）
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    container.appendChild(renderer.domElement)

    // —— 水面（位移全在 vertex shader，CPU 零开销）——
    const geometry = new THREE.PlaneGeometry(
      GEOMETRY_SIZE,
      GEOMETRY_SIZE,
      GEOMETRY_SEGMENTS,
      GEOMETRY_SEGMENTS
    )
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      fog: true,
      uniforms: {
        uTime: { value: 0 },
        uWaveElevation: { value: WAVE.waveElevation },
        uWaveIterations: { value: WAVE.waveIterations },
        uWaveDrag: { value: WAVE.waveDrag },
        uSwellStrength: { value: WAVE.swellStrength },
        uSwellScale: { value: WAVE.swellScale },
        uSwellSpeed: { value: WAVE.swellSpeed },
        uSmallWavesElevation: { value: WAVE.smallElevation },
        uSmallWavesFrequency: { value: WAVE.smallFrequency },
        uSmallWavesSpeed: { value: WAVE.smallSpeed },
        uSmallWavesIterations: { value: WAVE.smallIterations },
        uMidElevation: { value: WAVE.midElevation },
        uMidScale: { value: WAVE.midScale },
        uMidSpeed: { value: WAVE.midSpeed },
        uDepthColor: { value: WAVE.depthColor.clone() },
        uSurfaceColor: { value: WAVE.surfaceColor.clone() },
        uColorOffset: { value: WAVE.colorOffset },
        uColorMultiplier: { value: WAVE.colorMultiplier },
        uFresnelStrength: { value: WAVE.fresnelStrength },
        uSpecularStrength: { value: WAVE.specularStrength },
        uSpecularPower: { value: WAVE.specularPower },
        uSkyHorizon: { value: WAVE.skyHorizon.clone() },
        uSkyZenith: { value: WAVE.skyZenith.clone() },
        uSunDirection: { value: WAVE.sunDirection.clone() },
        ...THREE.UniformsLib.fog,
      },
    })

    const water = new THREE.Mesh(geometry, material)
    water.rotation.x = -Math.PI * 0.5
    scene.add(water)

    // —— 水下场景（滚动潜入后可见：caustics 折射光影 + 丁达尔光柱 + 代码 + 气泡）——
    const atlas = createCodeAtlas()
    const underwater = buildUnderwaterScene(atlas)
    underwater.group.visible = false
    scene.add(underwater.group)

    // —— 潜水状态机：surface → diving → underwater → surfacing ——
    const surfaceCam = WAVE.camera.clone()
    const underCam = WAVE.cameraUnder.clone()
    type Phase = "surface" | "diving" | "underwater" | "surfacing"
    let phase: Phase = "surface"
    let prevPhase: Phase = "surface"
    let dive = 0 // 0 = 海面，1 = 完全潜入
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

    // 滚动越过阈值触发潜入 / 回滚浮出
    const onScroll = () => {
      const shouldDive =
        window.scrollY > window.innerHeight * WAVE.diveThreshold
      if (shouldDive && (phase === "surface" || phase === "surfacing")) {
        phase = "diving"
      } else if (
        !shouldDive &&
        (phase === "underwater" || phase === "diving")
      ) {
        phase = "surfacing"
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true })

    // —— 鼠标视差（轻微移动相机，增强沉浸感）——
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 }
    const onMouseMove = (e: MouseEvent) => {
      mouse.tx = (e.clientX / window.innerWidth) * 2 - 1
      mouse.ty = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener("mousemove", onMouseMove, { passive: true })

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    }
    window.addEventListener("resize", onResize)

    // —— 动画循环 ——
    let raf = 0
    const startTime = performance.now()
    const camPos = new THREE.Vector3()
    const lookPos = new THREE.Vector3()
    const fogSurface = new THREE.Color(WAVE.fogColor)
    const fogUnder = new THREE.Color(WAVE.fogUnder)
    let lastFrame = performance.now()

    const tick = () => {
      const now = performance.now()
      const delta = Math.min((now - lastFrame) / 1000, 0.05)
      lastFrame = now
      const elapsed = (now - startTime) / 1000
      material.uniforms.uTime.value = elapsed

      // —— 潜水状态推进 ——
      if (phase === "diving") {
        dive = Math.min(1, dive + delta / WAVE.diveDuration)
      } else if (phase === "surfacing") {
        dive = Math.max(0, dive - delta / WAVE.diveDuration)
      }
      if (dive <= 0) {
        phase = "surface"
      } else if (dive >= 1) {
        phase = "underwater"
      }
      const eased = easeInOutCubic(dive)

      // 过场气泡：刚进入 diving 时相机周围爆发一大团（泳镜感）
      if (phase === "diving" && prevPhase !== "diving") {
        underwater.bubbles.burst(260, camPos)
      }
      prevPhase = phase

      // —— 相机：海面俯瞰 ↔ 水下 插值（鼠标视差只作用于海面）——
      mouse.x += (mouse.tx - mouse.x) * 0.04
      mouse.y += (mouse.ty - mouse.y) * 0.04
      const parallax = 1 - eased
      camPos.lerpVectors(surfaceCam, underCam, eased)
      camPos.x += mouse.x * 0.35 * parallax
      camPos.y += mouse.y * 0.2 * parallax
      camera.position.copy(camPos)
      lookPos.lerpVectors(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, -2.5, -8),
        eased
      )
      camera.lookAt(lookPos)

      // —— 海面 / 背景 / 雾过渡（潜入过半切换）——
      water.visible = dive < 0.5
      underwater.group.visible = dive > 0.05
      if (dive >= 0.5 && scene.background !== deepTexture) {
        scene.background = deepTexture
      } else if (dive < 0.5 && scene.background !== skyTexture) {
        scene.background = skyTexture
      }
      fog.color.copy(fogSurface).lerp(fogUnder, eased)
      fog.near = THREE.MathUtils.lerp(WAVE.fogNear, WAVE.fogUnderNear, eased)
      fog.far = THREE.MathUtils.lerp(WAVE.fogFar, WAVE.fogUnderFar, eased)

      // 水下系统（caustics / 光柱 / 气泡 / 代码粒子）
      underwater.update(eased, elapsed, delta, camPos)

      // 泳镜水膜遮罩
      if (veilRef.current) {
        veilRef.current.style.opacity = String(eased * 0.85)
      }

      renderer.render(scene, camera)
      raf = window.requestAnimationFrame(tick)
    }
    tick()

    // —— cleanup ——
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("resize", onResize)
      window.removeEventListener("scroll", onScroll)
      geometry.dispose()
      material.dispose()
      atlas.dispose()
      underwater.dispose()
      skyTexture.dispose()
      deepTexture.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [])

  return (
    <>
      <div
        ref={containerRef}
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        aria-hidden="true"
      />
      {/* 泳镜水膜遮罩：潜入海底时的暗角蓝膜 */}
      <div
        ref={veilRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-0"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(3,16,30,0.28) 0%, rgba(3,16,30,0.88) 100%)",
        }}
      />
    </>
  )
}
