import { useCallback, useEffect, useRef } from "react"
import * as THREE from "three"

import { createCircularGeometry } from "@/components/showcase/circular-geometry"
import { DEFAULT_CONF, type OceanConf } from "@/components/showcase/ocean-conf"
import type { SeaState } from "@/components/showcase/sea-state"
import { seaFieldGLSL } from "@/components/showcase/sea-field"
import { createCodeAtlas } from "@/components/showcase/underwater/atlas"
import { buildUnderwaterScene } from "@/components/showcase/underwater/systems"

// ---------------------------------------------------------------------------
// Ocean —— 3D 物理海浪背景 + 滚动潜入海底（工程化版）
// 效果源自 Open Three「波涛海浪」「水天一色」与 giser2017「波浪效果」：
//   · 海面：wavedx 指数波（exp(sin-1)，波峰尖）× 多方向迭代 + Gerstner 拖拽
//           + Perlin 涌浪/碎浪 → 天然随机，浪高差异明显
//   · 整体流动：所有噪声采样带统一流向偏移 → 整个海面纹样向同一方向无限推移
//   · 浪头白沫：直接由 vElevation 波峰曲率驱动（屏幕空间拉普拉斯）
//           → 脊线方向与海浪完全统一，顶峰连接成细长白沫带
//   · 着色：fresnel 天空反射 + 太阳高光 + ACES filmic tonemap
//   · 背景：程序化渐变天空（海天一色）
//   · 视角：相机放平（地平线在屏幕上方 1/3 处），120×40 宽幅海面远端汇成消失线
//           （横向远超视锥，消除矩形畸变导致的左右远角缺失）
//   · 滚动潜入：下滑越过视口 15% → 贴海面气泡爆发（摄像机掉入水中）→ 沉入海底
//       - 丁达尔光柱（阳光射入海底）
//       - 水波折射光影 caustics（参考 giser2017 领域扭曲算法）
//       - 漂浮代码字符 + 环境气泡 + 水膜遮罩
//
// ── 参数传入 ──────────────────────────────────────────────────────
//   组件通过 props.conf 接收 Partial<OceanConf>（见 ocean-conf.ts），
//   与 DEFAULT_CONF 深合并；tick 每帧同步到 uniforms/相机/雾，实时生效。
//   调参见 ocean-conf.ts 的 DEFAULT_CONF（需修改配置时直接编辑）。
// ── 调参速查（ocean-conf.ts 的 DEFAULT_CONF）────────────────────────
// 【海浪】waveHeight（浪高）/ waveDensity（密度）/ waveSpeed（海浪移速）
//        flowAngle（流向角）/ flowSpeed（海面移速）
// 【视角】cameraHeight（高低）/ cameraAngle（方向）/ cameraPitch（俯仰）
//        cameraDistance（距离）
// 【鼠标】mouseFollow（跟随摇移开关）/ mouseInvert（反向跟随开关）
//        parallaxStrength（视差强度）
// 【海面配色】depthColor / surfaceColor / foamColor / colorOffset
//            / colorMultiplier / fresnelStrength / specularStrength / specularPower
// 【天空】skyHorizon / skyZenith / sunDirectionX/Y/Z
// 【雾与潜水】fogColor / fogRadius（圆形雾半径）/ fogSpread（雾带宽度）
//            / fogStrength（雾强度）/ diveThreshold / diveDuration
//            / diveDip / riseLift / fogUnder / fogUnderNear / fogUnderFar
//            / skyUnderTop / skyUnderBottom
// 【海中光柱】shaftCrestLight（浪顶为光）/ shaftThreshold（生成阈值）
//            / shaftScale（光影缩放）/ shaftAngle（入射角度）
//            / shaftLength / shaftOpacity / shaftColor
// 【海水与海底】waterColor / bottomDepth（海底深度）/ bottomColor / causticBrightness
// ---------------------------------------------------------------------------

// 圆形海面沙盘：矩形规则网格切分（波浪三角面为横竖网格，无放射状），
// 生成后投影回圆形边界（外框为圆，无矩形尖角）
// 半径 42 覆盖视锥（相机轨道距离 ~11，75° 视锥远端需覆盖 ±20+）
// 细分度由 conf.geometrySubdivision 控制（默认 1280，保证波浪细节），
// 调整后重建几何体（结构参数，无法 uniform 同步）
const GEOMETRY_RADIUS = 42

// ---------------------------------------------------------------------------
// 设备能力检测：海面细分度自动档位
//   默认目标 1280；低端设备自动降档，运行时再按 FPS 动态校正：
//     · 设备类型  → UA 判断移动端
//     · CPU 核数  → navigator.hardwareConcurrency
//     · GPU 状态  → WEBGL_debug_renderer_info 取渲染器型号，
//                   识别软件渲染 / 低端核显（SwiftShader、LLVMpipe、Intel HD…）
//   档位：high=1280（默认）/ mid=640 / low=320（移动/低端）
//   说明：FPS 本身即是 GPU 运行时状态的直接反馈——静态检测定起点，
//         FPS 监测持续校正（掉帧降档、流畅回升），见 tick 内自适应逻辑。
// ---------------------------------------------------------------------------
function detectDeviceTier(): "high" | "mid" | "low" {
  const ua = navigator.userAgent
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
  if (mobile) {
    return "low"
  }
  const cores = navigator.hardwareConcurrency ?? 4
  let gpu = ""
  try {
    const canvas = document.createElement("canvas")
    const gl = canvas.getContext("webgl") as WebGLRenderingContext | null
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info")
      if (ext) {
        gpu = String(
          gl.getParameter(
            ext.UNMASKED_RENDERER_WEBGL ?? ext.UNMASKED_VENDOR_WEBGL
          ) ?? ""
        ).toLowerCase()
      }
    }
  } catch {
    // 拿不到 GPU 信息时按 CPU 核数兜底
  }
  const lowGpu =
    /swiftshader|llvmpipe|software|microsoft basic|intel hd|hd graphics|mali-[0-4]|adreno 3|powervr|mesa/i.test(
      gpu
    )
  if (lowGpu || cores <= 4) {
    return "low"
  }
  if (cores >= 12 && gpu && !lowGpu) {
    return "high"
  }
  return "mid"
}

/** 自动细分度初始档位（默认目标 1280，低端设备自动降档） */
function initialSubdivision(): number {
  return detectDeviceTier() === "high"
    ? 1280
    : detectDeviceTier() === "mid"
      ? 640
      : 320
}

// ---------------------------------------------------------------------------
// 顶点着色器
// 波浪三层结构，全部在 GPU 完成：
//   ① 主浪：wavedx 指数波（exp(sin-1)，波峰尖、波谷平）× 多方向迭代叠加
//           + 拖拽累积（Gerstner 式水平位移，波间互相拉扯）→ 天然随机
//   ② 小波：Perlin cnoise 多迭代，abs 下凹碎浪，采样带动态偏移
//   ③ 中频随机起伏（正负双向）
// 整体流动：所有噪声采样统一减去 flowDir×uTime×uFlowSpeed →
//   整个海面纹样（噪声图案 + 波）向同一方向无限推移（Perlin 连续场无边界）
// 圆形外框：片元按距中心距离做边缘渐隐（vRadius → alpha 淡出成圆形沙盘）
// 并输出：
//   · vWorldPosition  供片元做 fresnel 天空反射（海天一色）
//   · vFoamNoise      白沫边缘 Perlin 破碎微扰（方向无关，仅撕边）
// 注意：白沫的脊线位置由片元对 vElevation 的曲率检测得出，天然与波浪方向统一
// ---------------------------------------------------------------------------
const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec2 uFlowDir;
  uniform float uFlowSpeed;
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
  uniform float uWaveDensity;
  uniform float uWaveSpeed;
  uniform float uFoamNoiseScale;
  uniform float uFoamNoiseSpeed;
  uniform float uRadius;

  varying float vElevation;
  varying vec3 vWorldPosition;
  varying float vFoamNoise;
  varying float vRadius;

  ${seaFieldGLSL}

  void main() {
    vec4 modelPosition = modelMatrix * vec4(position, 1.0);

    // —— 统一骨架：海面波浪高度（与海底光斑 / 海中光柱共享同一 waveField）——
    vec2 samplePos = modelPosition.xz - uFlowDir * uTime * uFlowSpeed;
    float elevation = waveField(modelPosition.xz, uTime);

    modelPosition.y += elevation;
    vElevation = elevation;
    vWorldPosition = modelPosition.xyz;

    // 距中心距离 → 圆形边缘渐隐
    vRadius = length(modelPosition.xz);

    // 白沫边缘 Perlin 破碎微扰（碎浪尺度，随整体流动，仅撕边不破坏连接）
    vFoamNoise = cnoise(vec3(
      samplePos * uFoamNoiseScale,
      uTime * uFoamNoiseSpeed
    ));

    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;
    gl_Position = projectedPosition;
  }
`

// ---------------------------------------------------------------------------
// 片元着色器
// 海面 = 深水色（浪谷）↔ 波峰亮蓝（浪峰）渐变
//      + 顶峰白沫（屏幕空间曲率检测波峰脊线 → 方向与海浪统一）
//      + fresnel 天空反射（近掠角反射天空色 → 海天一色）
//      + 太阳镜面高光（波峰闪光，白沫处微暗让泡沫更清晰）
// 颜色在 linear 空间计算，末尾交给 three 内置
//   tonemapping_fragment（ACESFilmicToneMapping）+ colorspace_fragment（sRGB）
// 与场景背景（天空纹理）走同一输出管线，保证海天颜色一致
// 注意：tonemapping/colorspace 的 pars 函数由 three 自动注入，此处只 include
//       使用点 chunk，否则会重复定义导致编译失败
// 法线用屏幕空间导数重建（dFdx/dFdy），无需额外顶点法线数据
// ---------------------------------------------------------------------------
const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3 uDepthColor;
  uniform vec3 uSurfaceColor;
  uniform vec3 uFoamColor;
  uniform vec3 uWaterColor;
  uniform float uColorOffset;
  uniform float uColorMultiplier;
  uniform float uFresnelStrength;
  uniform float uSpecularStrength;
  uniform float uSpecularPower;
  uniform float uFoamStrength;
  uniform float uFoamCurvMax;
  uniform float uFoamHeightStart;
  uniform float uFoamSlopeGate;
  uniform vec3 uSkyHorizon;
  uniform vec3 uSkyZenith;
  uniform vec3 uSunDirection;
  uniform float uRadius;
  uniform vec3 uFogColor;
  uniform float uFogRadius;
  uniform float uFogSpread;
  uniform float uFogStrength;

  varying float vElevation;
  varying vec3 vWorldPosition;
  varying float vFoamNoise;
  varying float vRadius;

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
    // —— 圆形外框：距中心越远 alpha 越淡（沙盘边缘渐隐成圆）——
    float edge = 1.0 - smoothstep(uRadius * 0.82, uRadius, vRadius);
    // —— 圆形外围雾：距中心超过 fogRadius 逐渐融入雾色（替代全局距离雾）——
    float fogFade = smoothstep(uFogRadius, uFogRadius + uFogSpread, vRadius);

    // —— 背面（从海中仰视海面）：海面 DoubleSide 双面渲染 ——
    // 正面 = 海面（顶部看）；背面 = 海中（下方看）。从海中看：浪谷透光、
    // 浪峰挡光 → 海中丁达尔底色（与光柱取反逻辑一致，同一 vElevation）。
    if (!gl_FrontFacing) {
      float light = smoothstep(0.05, -0.4, vElevation);
      vec3 deep = mix(uWaterColor, vec3(0.02, 0.08, 0.14), 0.45);
      vec3 color = deep + light * vec3(0.38, 0.66, 0.9);
      gl_FragColor = vec4(color, edge);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

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

    // —— 顶峰白沫（方向与海浪完全统一）——
    // 主门控 = 现有高亮 mixStrength（波峰亮蓝的顶部饱和区）：
    //   白沫即高亮波峰顶的白色覆盖 → 方向、位置天然与海浪一致
    // 曲率（屏幕空间拉普拉斯，凸起为负）仅作脊线锐化增益，不承担主定位
    vec2 sl = vec2(dFdx(vElevation), dFdy(vElevation));
    float lap = dFdx(sl.x) + dFdy(sl.y);
    float peak = max(-lap, 0.0);
    float peakNorm = clamp(peak / uFoamCurvMax, 0.0, 1.0);
    float crestBoost = 0.4 + 0.6 * peakNorm * peakNorm;
    // 高亮顶部：mixStrength 接近饱和处才覆盖白沫（细长连续带）
    float foam = smoothstep(uFoamHeightStart, 1.0, mixStrength) * crestBoost;
    // 坡度抑制：碎浪陡坡（非波峰顶部）不误报
    float slopeLen = length(sl);
    float slopeGate = 1.0 - smoothstep(uFoamSlopeGate, uFoamSlopeGate * 2.0, slopeLen);
    foam *= clamp(0.5 + 0.5 * slopeGate, 0.0, 1.0);
    // Perlin 微扰：撕边缘但不破坏连接
    foam *= 0.85 + 0.3 * vFoamNoise;
    // 高亮微调：白沫处轻微压暗太阳镜面高光，让泡沫带更清晰
    color += uSurfaceColor * spec * uSpecularStrength * (1.0 - foam * 0.55);
    color = mix(color, uFoamColor, foam * uFoamStrength);

    // 圆形外围雾：距沙盘中心越远越融入雾色（海面外围雾化，不再全局距离雾）
    color = mix(color, uFogColor, fogFade * uFogStrength);

    gl_FragColor = vec4(color, edge);
    // three 输出管线：ACES tone mapping → sRGB（与天空背景一致 → 海天一色）
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

// 程序化天空渐变（地平线亮蓝 → 天顶深蓝，作为场景背景 → 海天一色）
function createSkyTexture(
  horizon: string,
  zenith: string
): THREE.CanvasTexture {
  return createVerticalGradientTexture(zenith, horizon)
}

// 深海渐变背景（上方有光、越深越暗）
function createDeepTexture(top: string, bottom: string): THREE.CanvasTexture {
  return createVerticalGradientTexture(top, bottom)
}

function createVerticalGradientTexture(
  top: string,
  bottom: string
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas")
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext("2d")
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
    gradient.addColorStop(0, top)
    gradient.addColorStop(1, bottom)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export interface OceanProps {
  /** 覆盖默认参数的配置（Partial 合并，热更新实时生效） */
  conf?: Partial<OceanConf>
  /** 海洋状态：surface=海面（首页），deep=深海（核心能力屏/二级功能页）
   *  状态变化时自动平滑下潜/上浮动画；点击、滚动、路由统一走此状态 */
  state?: SeaState
  /** 背景虚化（二级页叠加轻微 blur，突出前景内容） */
  blur?: boolean
}

const DEG2RAD = Math.PI / 180

// 轨道相机：相机绕中心旋转（angle），高度 height，距离 distance，
// 俯仰 pitch（度，负=向下看）作用于注视点高度 → 圆形沙盘始终居中
function applyOrbitCamera(
  camPos: THREE.Vector3,
  lookPos: THREE.Vector3,
  c: OceanConf
) {
  const a = c.cameraAngle * DEG2RAD
  camPos.set(
    Math.sin(a) * c.cameraDistance,
    c.cameraHeight,
    Math.cos(a) * c.cameraDistance
  )
  // 注视点：中心下方（pitch 负 → 向下俯视沙盘中心）
  const lookY = Math.tan(c.cameraPitch * DEG2RAD) * c.cameraDistance * 0.9
  lookPos.set(0, lookY, 0)
}

export function Ocean({ conf, state = "surface", blur = false }: OceanProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)
  // 自动细分模式：外部未显式传 geometrySubdivision 时，由设备能力+FPS 自动调控；
  // 显式传入（含调试面板拖动）则尊重用户值，不再自动干预
  const autoSubMode = conf?.geometrySubdivision === undefined
  // ref 形态：tick 闭包（[] effect）读取，conf 变化时同步
  const autoSubRef = useRef(autoSubMode)
  // 初始档位：自动模式=设备检测值；显式=用户值。
  // 用普通变量承载（而非 useRef initializer 里读 ref.current），
  // 避免渲染期访问 ref（React Compiler react(refs) lint）；initSubRef
  // 供 tick 闭包读取，confRef 首次初始化直接用 initSub 值。
  const initSub = autoSubMode
    ? initialSubdivision()
    : (conf?.geometrySubdivision ?? DEFAULT_CONF.geometrySubdivision)
  const initSubRef = useRef(initSub)
  // 当前生效配置（props 变化时同步，tick 每帧读取）
  const confRef = useRef<OceanConf>({
    ...DEFAULT_CONF,
    ...conf,
    geometrySubdivision: initSub,
  })
  // 海洋状态（路由/滚动/点击切换时同步；状态机 tick 内读取，动画平滑过渡）
  const stateRef = useRef<SeaState>(state)
  // 水面 mesh 引用：细分度变化需重建几何体（结构参数无法 uniform 同步）
  const waterRef = useRef<THREE.Mesh | null>(null)

  // 重建水面几何体（细分度变化时调用；替换并释放旧几何体）。
  // useCallback 稳定化：ref-sync effect 依赖它不会因每次渲染新引用而重跑。
  const rebuildGeometry = useCallback((nextSub: number) => {
    if (!waterRef.current) {
      return
    }
    const old = waterRef.current.geometry
    waterRef.current.geometry = createCircularGeometry(
      GEOMETRY_RADIUS,
      nextSub,
      nextSub
    )
    old.dispose()
  }, [])

  // props.conf 变化 → 更新 ref（不重建场景，tick 里实时同步）；
  // 例外：geometrySubdivision（三角面细分度）是几何结构参数，无法 uniform
  // 同步，检测到变化时重建水面几何体并替换。
  // props.conf 变化 → 更新 ref（不重建场景，tick 里实时同步）；
  // 例外：geometrySubdivision（三角面细分度）是几何结构参数，无法 uniform
  // 同步，检测到变化时重建水面几何体并替换。rebuildGeometry 已 useCallback
  // 稳定化 → 加入依赖不会导致重跑（仍只在 conf 变化时执行）。
  useEffect(() => {
    const prevSub = confRef.current.geometrySubdivision
    const next = { ...DEFAULT_CONF, ...conf }
    // 自动模式下 conf 未显式指定细分度 → 保留当前自适应值（不被 DEFAULT 重置）
    autoSubRef.current = conf?.geometrySubdivision === undefined
    if (autoSubRef.current) {
      next.geometrySubdivision = prevSub
    }
    confRef.current = next
    const nextSub = next.geometrySubdivision
    if (prevSub !== nextSub) {
      rebuildGeometry(nextSub)
    }
  }, [conf, rebuildGeometry])

  // 海洋状态变化 → 同步 ref（不重建场景；tick 内驱动下潜/上浮动画）
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // —— 场景初始化（挂载一次）：构建场景/相机/渲染器 + rAF tick 循环。
  // 函数体引用的组件内函数与变量全部只读 ref/常量，场景结构参数无需响应式；
  // 依赖数组 [] 是刻意设计（重建场景开销大），豁免 exhaustive-deps 误报。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const C = confRef.current

    // —— 场景 / 相机 / 渲染器 ——
    const scene = new THREE.Scene()
    const skyTexture = createSkyTexture(C.skyHorizon, C.skyZenith)
    const deepTexture = createDeepTexture(C.skyUnderTop, C.skyUnderBottom)
    scene.background = skyTexture
    // 全局距离雾（仅水下兜底：海底/代码粒子；海面改用圆形雾，见 fragment shader）
    const fog = new THREE.Fog(C.fogUnder, 0, 100)
    scene.fog = fog

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      200
    )
    // 轨道相机（圆形沙盘）：围绕中心旋转，高低/方向/俯仰/距离由 conf 控制
    const surfaceCam = new THREE.Vector3()
    const surfaceLook = new THREE.Vector3()
    applyOrbitCamera(surfaceCam, surfaceLook, C)
    camera.position.copy(surfaceCam)
    camera.lookAt(surfaceLook)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // ACES filmic tone mapping（与 fragment shader 的 tonemapping_fragment 配合）
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    container.appendChild(renderer.domElement)

    // —— 水面（圆形沙盘，位移全在 vertex shader，CPU 零开销）——
    // 细分度取自 conf（默认 128），调整后由 conf effect 重建几何体
    const sub = confRef.current.geometrySubdivision
    const geometry = createCircularGeometry(GEOMETRY_RADIUS, sub, sub)
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uFlowDir: {
          value: new THREE.Vector2(
            Math.sin(C.flowAngle * DEG2RAD),
            Math.cos(C.flowAngle * DEG2RAD)
          ).normalize(),
        },
        uFlowSpeed: { value: C.flowSpeed },
        uWaveElevation: { value: C.waveHeight },
        uWaveIterations: { value: C.waveIterations },
        uWaveDrag: { value: C.waveDrag },
        uSwellStrength: { value: C.swellStrength },
        uSwellScale: { value: C.swellScale },
        uSwellSpeed: { value: C.swellSpeed },
        uSmallWavesElevation: { value: C.smallElevation },
        uSmallWavesFrequency: { value: C.smallFrequency },
        uSmallWavesSpeed: { value: C.smallSpeed },
        uSmallWavesIterations: { value: C.smallIterations },
        uMidElevation: { value: C.midElevation },
        uMidScale: { value: C.midScale },
        uMidSpeed: { value: C.midSpeed },
        uWaveDensity: { value: C.waveDensity },
        uWaveSpeed: { value: C.waveSpeed },
        uFoamNoiseScale: { value: C.foamNoiseScale },
        uFoamNoiseSpeed: { value: C.foamNoiseSpeed },
        uRadius: { value: GEOMETRY_RADIUS },
        uDepthColor: { value: new THREE.Color(C.depthColor) },
        uSurfaceColor: { value: new THREE.Color(C.surfaceColor) },
        uFoamColor: { value: new THREE.Color(C.foamColor) },
        uWaterColor: { value: new THREE.Color(C.waterColor) },
        uColorOffset: { value: C.colorOffset },
        uColorMultiplier: { value: C.colorMultiplier },
        uFoamStrength: { value: C.foamStrength },
        uFoamCurvMax: { value: C.foamCurvMax },
        uFoamHeightStart: { value: C.foamHeightStart },
        uFoamSlopeGate: { value: C.foamSlopeGate },
        uFresnelStrength: { value: C.fresnelStrength },
        uSpecularStrength: { value: C.specularStrength },
        uSpecularPower: { value: C.specularPower },
        uSkyHorizon: { value: new THREE.Color(C.skyHorizon) },
        uSkyZenith: { value: new THREE.Color(C.skyZenith) },
        uSunDirection: {
          value: new THREE.Vector3(
            C.sunDirectionX,
            C.sunDirectionY,
            C.sunDirectionZ
          ).normalize(),
        },
        uFogColor: { value: new THREE.Color(C.fogColor) },
        uFogRadius: { value: C.fogRadius },
        uFogSpread: { value: C.fogSpread },
        uFogStrength: { value: C.fogStrength },
      },
    })

    const water = new THREE.Mesh(geometry, material)
    waterRef.current = water
    scene.add(water)

    // —— 水下场景（滚动潜入后可见：海底地面 + 光斑 + 海中光柱 + 代码粒子）——
    const atlas = createCodeAtlas()
    const underwater = buildUnderwaterScene(atlas, {
      surfaceY: 0,
      bottomY: -C.bottomDepth,
    })
    underwater.group.visible = false
    scene.add(underwater.group)

    // —— 潜水状态机：surface → diving → underwater → surfacing ——
    // 由 seaState 驱动：deep → 下潜（二级页/核心能力屏），surface → 上浮（首页）
    const underCam = new THREE.Vector3()
    const underLook = new THREE.Vector3()
    const applyUnderCam = () => {
      // 水下机位：固定位置（不随海底深度变化；潜水后镜头只由滚动翻页状态决定）
      underCam.set(0, -3, 5.6)
      underLook.set(0, -1.5, -8)
    }
    applyUnderCam()
    type Phase = "surface" | "diving" | "underwater" | "surfacing"
    let phase: Phase = stateRef.current === "deep" ? "underwater" : "surface"
    let dive = stateRef.current === "deep" ? 1 : 0 // 0 = 海面，1 = 完全潜入
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

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

    // 初始背景：deep 状态直接使用深海纹理（避免首帧闪现天空）
    if (stateRef.current === "deep") {
      scene.background = deepTexture
    }

    // —— 动画循环 ——
    let raf = 0
    const startTime = performance.now()
    const camPos = new THREE.Vector3()
    const lookPos = new THREE.Vector3()
    const fogSurface = new THREE.Color(C.fogColor)
    const fogUnder = new THREE.Color(C.fogUnder)
    const flowVec = new THREE.Vector2()
    const sunVec = new THREE.Vector3()
    let lastFrame = performance.now()
    let prevSkyH = C.skyHorizon
    let prevSkyZ = C.skyZenith
    let prevUnderT = C.skyUnderTop
    let prevUnderB = C.skyUnderBottom
    let skyTextureAlive = skyTexture
    let deepTextureAlive = deepTexture

    // —— FPS 自适应状态（仅自动细分模式；掉帧降档、流畅回升至初始档位）——
    let fpsAccum = 0
    let fpsFrames = 0
    let lastAdapt = 0
    let cooldownUntil = 0 // 降档冷却：期间不升档（防振荡）

    // 从 confRef 同步当前生效值（每帧调用，数值复制开销极低）
    const syncConf = (u: Record<string, { value: unknown }>) => {
      const c = confRef.current
      // 流向角度 → 方向向量（normalize 保持方向语义）
      const a = c.flowAngle * DEG2RAD
      flowVec.set(Math.sin(a), Math.cos(a)).normalize()
      ;(u.uFlowDir.value as THREE.Vector2).copy(flowVec)
      sunVec.set(c.sunDirectionX, c.sunDirectionY, c.sunDirectionZ).normalize()
      ;(u.uSunDirection.value as THREE.Vector3).copy(sunVec)
      // 数值
      ;(u.uFlowSpeed.value as number) = c.flowSpeed
      ;(u.uWaveElevation.value as number) = c.waveHeight
      ;(u.uWaveIterations.value as number) = c.waveIterations
      ;(u.uWaveDrag.value as number) = c.waveDrag
      ;(u.uSwellStrength.value as number) = c.swellStrength
      ;(u.uSwellScale.value as number) = c.swellScale
      ;(u.uSwellSpeed.value as number) = c.swellSpeed
      ;(u.uSmallWavesElevation.value as number) = c.smallElevation
      ;(u.uSmallWavesFrequency.value as number) = c.smallFrequency
      ;(u.uSmallWavesSpeed.value as number) = c.smallSpeed
      ;(u.uSmallWavesIterations.value as number) = c.smallIterations
      ;(u.uMidElevation.value as number) = c.midElevation
      ;(u.uMidScale.value as number) = c.midScale
      ;(u.uMidSpeed.value as number) = c.midSpeed
      ;(u.uWaveDensity.value as number) = c.waveDensity
      ;(u.uWaveSpeed.value as number) = c.waveSpeed
      ;(u.uFoamNoiseScale.value as number) = c.foamNoiseScale
      ;(u.uFoamNoiseSpeed.value as number) = c.foamNoiseSpeed
      ;(u.uColorOffset.value as number) = c.colorOffset
      ;(u.uColorMultiplier.value as number) = c.colorMultiplier
      ;(u.uFoamStrength.value as number) = c.foamStrength
      ;(u.uFoamCurvMax.value as number) = c.foamCurvMax
      ;(u.uFoamHeightStart.value as number) = c.foamHeightStart
      ;(u.uFoamSlopeGate.value as number) = c.foamSlopeGate
      ;(u.uFresnelStrength.value as number) = c.fresnelStrength
      ;(u.uSpecularStrength.value as number) = c.specularStrength
      ;(u.uSpecularPower.value as number) = c.specularPower
      // 颜色
      ;(u.uDepthColor.value as THREE.Color).set(c.depthColor)
      ;(u.uSurfaceColor.value as THREE.Color).set(c.surfaceColor)
      ;(u.uFoamColor.value as THREE.Color).set(c.foamColor)
      ;(u.uWaterColor.value as THREE.Color).set(c.waterColor)
      ;(u.uSkyHorizon.value as THREE.Color).set(c.skyHorizon)
      ;(u.uSkyZenith.value as THREE.Color).set(c.skyZenith)
      // 圆形雾
      ;(u.uFogColor.value as THREE.Color).set(c.fogColor)
      ;(u.uFogRadius.value as number) = c.fogRadius
      ;(u.uFogSpread.value as number) = c.fogSpread
      ;(u.uFogStrength.value as number) = c.fogStrength
      // 相机 / 雾 / 潜水
      applyOrbitCamera(surfaceCam, surfaceLook, c)
      applyUnderCam()
      fogSurface.set(c.fogColor)
      fogUnder.set(c.fogUnder)
      // 背景渐变纹理：颜色变化时重建（廉价 canvas）
      if (c.skyHorizon !== prevSkyH || c.skyZenith !== prevSkyZ) {
        prevSkyH = c.skyHorizon
        prevSkyZ = c.skyZenith
        skyTextureAlive.dispose()
        skyTextureAlive = createSkyTexture(c.skyHorizon, c.skyZenith)
        if (dive < 0.5) {
          scene.background = skyTextureAlive
        }
      }
      if (c.skyUnderTop !== prevUnderT || c.skyUnderBottom !== prevUnderB) {
        prevUnderT = c.skyUnderTop
        prevUnderB = c.skyUnderBottom
        deepTextureAlive.dispose()
        deepTextureAlive = createDeepTexture(c.skyUnderTop, c.skyUnderBottom)
        if (dive >= 0.5) {
          scene.background = deepTextureAlive
        }
      }
    }

    const tick = () => {
      const now = performance.now()
      // rawDelta 供 FPS 统计（不 clamp，真实反映掉帧；delta 用于动画稳定性）
      const rawDelta = (now - lastFrame) / 1000
      const delta = Math.min(rawDelta, 0.05)
      lastFrame = now
      const elapsed = (now - startTime) / 1000
      const cur = confRef.current
      material.uniforms.uTime.value = elapsed
      syncConf(material.uniforms)

      // —— FPS 自适应：每秒评估一次；掉帧降档（立即），流畅回升（冷却后）——
      // 仅自动细分模式生效；用户显式指定细分度后不再干预（autoSubRef 同步）
      if (autoSubRef.current) {
        fpsAccum += rawDelta
        fpsFrames += 1
        if (fpsAccum >= 1) {
          const fps = fpsFrames / fpsAccum
          fpsFrames = 0
          fpsAccum = 0
          const nowMs = performance.now()
          const curSub = confRef.current.geometrySubdivision
          if (nowMs - lastAdapt >= 5000) {
            if (fps < 24 && curSub > 16) {
              // 掉帧 → 降一档（减半取 8 倍数，下限 16）
              const next = Math.max(16, Math.round(curSub / 2 / 8) * 8)
              if (next !== curSub) {
                confRef.current.geometrySubdivision = next
                rebuildGeometry(next)
                lastAdapt = nowMs
                cooldownUntil = nowMs + 8000 // 降档后 8 秒内只降不升
              }
            } else if (
              fps > 56 &&
              curSub < initSubRef.current &&
              nowMs >= cooldownUntil
            ) {
              // 流畅 → 升一档（×1.5 取 8 倍数，上限初始档位）
              const next = Math.min(
                initSubRef.current,
                Math.round((curSub * 1.5) / 8) * 8
              )
              if (next !== curSub) {
                confRef.current.geometrySubdivision = next
                rebuildGeometry(next)
                lastAdapt = nowMs
              }
            }
          }
        }
      }

      // —— 潜水状态推进（由统一 seaState 驱动，替代原滚动判断）——
      // 点击（探索更多/进度点）、滚动（首页翻屏）、路由（功能页/回首页）
      // 都会更新 stateRef；此处只响应状态做平滑下潜/上浮，动画路径统一
      if (stateRef.current === "deep") {
        if (phase === "surface" || phase === "surfacing") {
          phase = "diving"
        }
      } else if (phase === "underwater" || phase === "diving") {
        phase = "surfacing"
      }
      if (phase === "diving") {
        dive = Math.min(1, dive + delta / cur.diveDuration)
      } else if (phase === "surfacing") {
        dive = Math.max(0, dive - delta / cur.diveDuration)
      }
      if (dive <= 0) {
        phase = "surface"
      } else if (dive >= 1) {
        phase = "underwater"
      }
      const eased = easeInOutCubic(dive)

      // —— 相机视差（摇杆语义，作用于画面内容）——
      mouse.x += (mouse.tx - mouse.x) * 0.04
      mouse.y += (mouse.ty - mouse.y) * 0.04
      const parallax = 1 - eased
      const follow = cur.mouseFollow ? 1 : 0
      // 顺向（不勾选反向）：鼠标右 → 画面右摇；鼠标上 → 画面上摇
      // 反向（勾选，摇杆对调）：鼠标左 → 画面右摇；鼠标上 → 画面下摇（x/y 各轴取反）
      // 注意：相机与注视点同向平移（纯 pan），画面内容移动方向与相机相反，
      //       故 pan 取 -mouse.x / +mouse.y（mouse.y 屏幕坐标上负下正）
      const dir = cur.mouseInvert ? -1 : 1
      const panX = -mouse.x * 0.9 * follow * dir
      const panY = mouse.y * 0.3 * follow * dir
      camPos.lerpVectors(surfaceCam, underCam, eased)
      camPos.x += panX * parallax * cur.parallaxStrength
      camPos.y += panY * parallax * cur.parallaxStrength
      camera.position.copy(camPos)

      // 视角路径：
      //   下潜 diving —— 中段向下压（扎入水中感）
      //   上浮 surfacing —— 中段抬起（游出水面感），末尾回平视
      lookPos.lerpVectors(surfaceLook, underLook, eased)
      const midBias = Math.sin(eased * Math.PI) // 0→1→0 峰值在中段
      if (phase === "diving") {
        lookPos.y -= midBias * cur.diveDip
        lookPos.z -= midBias * cur.diveDip * 0.4
      } else if (phase === "surfacing") {
        lookPos.y += midBias * cur.riseLift
        lookPos.z += midBias * cur.riseLift * 0.4
      }
      // 视差同时作用于注视点 → 纯摇移（pan）：鼠标与视角同向移动
      lookPos.x += panX * parallax * cur.parallaxStrength
      lookPos.y += panY * parallax * cur.parallaxStrength
      camera.lookAt(lookPos)

      // —— 海面 / 背景 / 雾过渡（潜入过半切换）——
      // 海面双面渲染：顶部看=海面，下方看=海中（始终可见，无需隐藏）
      water.visible = true
      underwater.group.visible = dive > 0.05
      if (dive >= 0.5 && scene.background !== deepTextureAlive) {
        scene.background = deepTextureAlive
      } else if (dive < 0.5 && scene.background !== skyTextureAlive) {
        scene.background = skyTextureAlive
      }
      fog.color.copy(fogSurface).lerp(fogUnder, eased)
      fog.near = THREE.MathUtils.lerp(0, cur.fogUnderNear, eased)
      fog.far = THREE.MathUtils.lerp(100, cur.fogUnderFar, eased)

      // 水下系统（caustics / 光柱 / 代码粒子）：光斑=海面高度→亮度，光柱=波峰定位，
      // 三者同源并随海面洋流同速漂移；代码粒子随鼠标视差同向缓慢跟随
      underwater.update(
        eased,
        elapsed,
        delta,
        camPos,
        confRef.current,
        mouse.x,
        mouse.y
      )

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
      // dispose 当前生效的几何体（细分度可能已被重建替换过）
      if (waterRef.current) {
        waterRef.current.geometry.dispose()
        waterRef.current = null
      }
      material.dispose()
      atlas.dispose()
      underwater.dispose()
      skyTextureAlive.dispose()
      deepTextureAlive.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    }
    // rebuildGeometry 已 useCallback 稳定化 → 加入依赖不改变 mount-once 语义
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 场景只初始化一次，其余引用均为稳定 ref/模块函数
  }, [rebuildGeometry])

  return (
    <>
      <div
        ref={containerRef}
        className={`pointer-events-none fixed inset-0 z-0 overflow-hidden ${
          blur ? "blur-[5px]" : ""
        }`}
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
