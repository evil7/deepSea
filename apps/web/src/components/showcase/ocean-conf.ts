// ---------------------------------------------------------------------------
// Ocean 配置（OceanConf）—— 全部可调参数单一真源
//  - Ocean 组件通过 props.conf 接收 Partial<OceanConf>，与 DEFAULT_CONF 合并
//  - 调试面板（#sea-debug）据此生成滑块/取色器，并可导出 JSON
//  - 颜色一律 hex 字符串，向量拆成分量（x/y/z），便于 JSON 序列化
// ---------------------------------------------------------------------------

export interface OceanConf {
  // 【海浪】关键调控（圆形沙盘：浪高/密度/移速）
  waveHeight: number
  waveDensity: number
  waveSpeed: number
  // 【海面流动】流向角度（度，替代旧 flowDirX/Y）+ 海面移速
  flowAngle: number
  flowSpeed: number
  // 内部波浪细节（shader 需要，面板隐藏）
  waveIterations: number
  waveDrag: number
  swellStrength: number
  swellScale: number
  swellSpeed: number
  smallElevation: number
  smallFrequency: number
  smallSpeed: number
  smallIterations: number
  midElevation: number
  midScale: number
  midSpeed: number
  foamCurvMax: number
  foamStrength: number
  foamHeightStart: number
  foamSlopeGate: number
  foamNoiseScale: number
  foamNoiseSpeed: number
  // 【海面配色】
  depthColor: string
  surfaceColor: string
  foamColor: string
  colorOffset: number
  colorMultiplier: number
  fresnelStrength: number
  specularStrength: number
  specularPower: number
  // 【天空（海天一色）】
  skyHorizon: string
  skyZenith: string
  sunDirectionX: number
  sunDirectionY: number
  sunDirectionZ: number
  // 【雾与地平线】
  fogColor: string
  /** 圆形雾起始半径（距沙盘中心） */
  fogRadius: number
  /** 圆形雾过渡带宽度 */
  fogSpread: number
  /** 圆形雾强度 */
  fogStrength: number
  // 【视角】圆形沙盘轨道相机：高低 / 方向角 / 俯仰角 / 距离
  cameraHeight: number
  cameraAngle: number
  cameraPitch: number
  cameraDistance: number
  // 【鼠标】跟随摇移开关 / 反向跟随开关 / 视差强度
  mouseFollow: boolean
  mouseInvert: boolean
  parallaxStrength: number
  // 【潜水】
  diveThreshold: number
  diveDuration: number
  /** 下潜俯冲强度（相机扎入水面时视角向下压的程度） */
  diveDip: number
  /** 上浮抬视角强度（浮出水面时先抬起视角看上方） */
  riseLift: number
  fogUnder: string
  fogUnderNear: number
  fogUnderFar: number
  skyUnderTop: string
  skyUnderBottom: string
  // 【海中光柱】阳光投射参数化
  /** 浪顶为光：true=浪顶发光（正映射），false=浪谷透光（取反映射） */
  shaftCrestLight: boolean
  /** 生成阈值：海面高度映射门槛 */
  shaftThreshold: number
  /** 光影缩放：光柱从海面向下收窄/发散的程度 */
  shaftScale: number
  /** 入射角度（度）：光柱倾斜方向 */
  shaftAngle: number
  /** 光束长度（从海面向下延伸的世界单位） */
  shaftLength: number
  /** 光束透明度（潜入后的最大 alpha） */
  shaftOpacity: number
  /** 光影颜色 */
  shaftColor: string
  // 【海水与海底】
  /** 海水颜色（海中环境色/海面背面） */
  waterColor: string
  /** 海底深度（海面与海底之间的距离，正值） */
  bottomDepth: number
  /** 海底颜色 */
  bottomColor: string
  /** 海底光斑亮度 */
  causticBrightness: number
}

export const DEFAULT_CONF: OceanConf = {
  "waveHeight": 0.5,
  "waveDensity": 1,
  "waveSpeed": 1,
  "flowAngle": 195,
  "flowSpeed": 0.18,
  "waveIterations": 8,
  "waveDrag": 0.115,
  "swellStrength": 0.45,
  "swellScale": 1.65,
  "swellSpeed": 0.7,
  "smallElevation": 0.08,
  "smallFrequency": 1,
  "smallSpeed": 0.2,
  "smallIterations": 2,
  "midElevation": 0.07,
  "midScale": 4.6,
  "midSpeed": 0.64,
  "foamCurvMax": 0.003,
  "foamStrength": 0.8,
  "foamHeightStart": 0.45,
  "foamSlopeGate": 0.24,
  "foamNoiseScale": 4.5,
  "foamNoiseSpeed": 0.28,
  "depthColor": "#142743",
  "surfaceColor": "#1236c4",
  "foamColor": "#6c9fc1",
  "colorOffset": 0.4,
  "colorMultiplier": 2,
  "fresnelStrength": 0.37,
  "specularStrength": 0.55,
  "specularPower": 128,
  "skyHorizon": "#b4ac8d",
  "skyZenith": "#6294ea",
  "sunDirectionX": 0.09,
  "sunDirectionY": 0.43,
  "sunDirectionZ": 0.53,
  "fogColor": "#b2c5dc",
  "fogRadius": 16.5,
  "fogSpread": 5,
  "fogStrength": 0.08,
  "cameraHeight": 1.2,
  "cameraAngle": 0,
  "cameraPitch": -8,
  "cameraDistance": 20,
  "mouseFollow": true,
  "mouseInvert": false,
  "parallaxStrength": 1.45,
  "diveThreshold": 0.12,
  "diveDuration": 1.5,
  "diveDip": 2.5,
  "riseLift": 7,
  "fogUnder": "#000000",
  "fogUnderNear": 3,
  "fogUnderFar": 30.5,
  "skyUnderTop": "#024a74",
  "skyUnderBottom": "#0d1763",
  "shaftCrestLight": false,
  "shaftThreshold": -0.4,
  "shaftScale": 1.08,
  "shaftAngle": 168,
  "shaftLength": 10,
  "shaftOpacity": 0.1,
  "shaftColor": "#bfe6ff",
  "waterColor": "#0a2038",
  "bottomDepth": 60,
  "bottomColor": "#213e59",
  "causticBrightness": 2.85
}

export interface OceanParamMeta {
  key: keyof OceanConf
  label: string
  type?: "number" | "color" | "boolean" | "input"
  min?: number
  max?: number
  step?: number
}

export interface OceanParamGroup {
  name: string
  params: OceanParamMeta[]
}

// —— 调试面板参数元数据（精简：只留关键参数）——
export const OCEAN_PARAM_GROUPS: OceanParamGroup[] = [
  {
    name: "海浪",
    params: [
      { key: "waveHeight", label: "浪高", min: 0, max: 1, step: 0.01 },
      { key: "waveDensity", label: "海浪密度", min: 0.2, max: 3, step: 0.05 },
      { key: "waveSpeed", label: "海浪移速", min: 0, max: 3, step: 0.05 },
      {
        key: "flowAngle",
        label: "流向角度",
        min: 0,
        max: 360,
        step: 1,
      },
      { key: "flowSpeed", label: "海面移速", min: 0, max: 0.4, step: 0.005 },
    ],
  },
  {
    name: "视角",
    params: [
      {
        key: "cameraHeight",
        label: "视角高低",
        min: -6,
        max: 20,
        step: 0.1,
      },
      { key: "cameraAngle", label: "视角方向", min: 0, max: 360, step: 1 },
      {
        key: "cameraPitch",
        label: "俯仰角度",
        min: -60,
        max: 30,
        step: 0.5,
      },
      {
        key: "cameraDistance",
        label: "视角距离",
        min: 4,
        max: 40,
        step: 0.5,
      },
    ],
  },
  {
    name: "鼠标",
    params: [
      { key: "mouseFollow", label: "跟随摇移", type: "boolean" },
      { key: "mouseInvert", label: "反向跟随", type: "boolean" },
      {
        key: "parallaxStrength",
        label: "视差强度",
        min: 0,
        max: 3,
        step: 0.05,
      },
    ],
  },
  {
    name: "海面配色",
    params: [
      { key: "depthColor", label: "浪谷色", type: "color" },
      { key: "surfaceColor", label: "浪峰色", type: "color" },
      { key: "foamColor", label: "白沫色", type: "color" },
      {
        key: "colorOffset",
        label: "明暗偏移",
        min: -0.5,
        max: 0.5,
        step: 0.01,
      },
      {
        key: "colorMultiplier",
        label: "明暗强度",
        min: 0.5,
        max: 15,
        step: 0.1,
      },
      {
        key: "fresnelStrength",
        label: "天空反射",
        min: 0,
        max: 1.5,
        step: 0.01,
      },
      {
        key: "specularStrength",
        label: "高光强度",
        min: 0,
        max: 3,
        step: 0.05,
      },
      { key: "specularPower", label: "高光锐度", min: 8, max: 512, step: 8 },
    ],
  },
  {
    name: "天空",
    params: [
      { key: "skyHorizon", label: "地平线色", type: "color" },
      { key: "skyZenith", label: "天顶色", type: "color" },
      {
        key: "sunDirectionX",
        label: "太阳方向 X",
        min: -1,
        max: 1,
        step: 0.01,
      },
      {
        key: "sunDirectionY",
        label: "太阳方向 Y",
        min: -1,
        max: 1,
        step: 0.01,
      },
      {
        key: "sunDirectionZ",
        label: "太阳方向 Z",
        min: -1,
        max: 1,
        step: 0.01,
      },
    ],
  },
  {
    name: "雾",
    params: [
      { key: "fogColor", label: "雾色", type: "color" },
      {
        key: "fogRadius",
        label: "圆形雾半径",
        min: 4,
        max: 40,
        step: 0.5,
      },
      {
        key: "fogSpread",
        label: "雾带宽度",
        min: 1,
        max: 20,
        step: 0.5,
      },
      {
        key: "fogStrength",
        label: "雾强度",
        min: 0,
        max: 1,
        step: 0.01,
      },
      { key: "fogUnder", label: "水下雾色", type: "color" },
      { key: "fogUnderNear", label: "水下雾近", min: 0.5, max: 20, step: 0.5 },
      { key: "fogUnderFar", label: "水下雾远", min: 5, max: 60, step: 0.5 },
      { key: "skyUnderTop", label: "深海顶色", type: "color" },
      { key: "skyUnderBottom", label: "深海底色", type: "color" },
    ],
  },
  {
    name: "入水动画",
    params: [
      { key: "diveThreshold", label: "触发阈值", min: 0, max: 1, step: 0.01 },
      { key: "diveDuration", label: "动画时长", min: 0.5, max: 5, step: 0.1 },
      { key: "diveDip", label: "下潜俯冲", min: 0, max: 10, step: 0.1 },
      { key: "riseLift", label: "上浮抬视角", min: 0, max: 10, step: 0.1 },
    ],
  },
  {
    name: "海中光柱",
    params: [
      { key: "shaftCrestLight", label: "浪顶为光", type: "boolean" },
      {
        key: "shaftThreshold",
        label: "生成阈值",
        min: -0.4,
        max: 0.4,
        step: 0.01,
      },
      {
        key: "shaftScale",
        label: "光影缩放",
        min: 0.2,
        max: 2,
        step: 0.02,
      },
      {
        key: "shaftAngle",
        label: "入射角度",
        min: 0,
        max: 360,
        step: 1,
      },
      {
        key: "shaftLength",
        label: "光束长度",
        type: "input",
        min: 0,
        step: 0.1,
      },
      {
        key: "shaftOpacity",
        label: "光束透明度",
        min: 0,
        max: 1,
        step: 0.01,
      },
      { key: "shaftColor", label: "光影颜色", type: "color" },
    ],
  },
  {
    name: "海水与海底",
    params: [
      { key: "waterColor", label: "海水颜色", type: "color" },
      {
        key: "bottomDepth",
        label: "海底深度",
        type: "input",
        min: 10,
        step: 0.1,
      },
      { key: "bottomColor", label: "海底颜色", type: "color" },
      {
        key: "causticBrightness",
        label: "海底光斑亮度",
        min: 0,
        max: 4,
        step: 0.05,
      },
    ],
  },
]
