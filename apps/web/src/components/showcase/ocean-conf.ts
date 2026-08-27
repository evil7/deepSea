// ---------------------------------------------------------------------------
// Ocean 配置（OceanConf）—— 全部可调参数单一真源
//  - Ocean 组件通过 props.conf 接收 Partial<OceanConf>，与 DEFAULT_CONF 合并
//  - 颜色一律 hex 字符串，向量拆成分量（x/y/z），便于 JSON 序列化
// ---------------------------------------------------------------------------

export interface OceanConf {
  // 【网格】海面三角面细分度（几何结构参数，非 uniform——调整后需重建几何体）
  /** 海面网格细分度（圆形沙盘 width/depth segments，越高三角面越细） */
  geometrySubdivision: number
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
  "geometrySubdivision": 1280,
  "waveHeight": 0.35,
  "waveDensity": 0.75,
  "waveSpeed": 0.8,
  "flowAngle": 0,
  "flowSpeed": 0.12,
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
  "surfaceColor": "#3d4b7f",
  "foamColor": "#ababab",
  "colorOffset": 0.2,
  "colorMultiplier": 2.5,
  "fresnelStrength": 0.11,
  "specularStrength": 0.6,
  "specularPower": 256,
  "skyHorizon": "#fff6d1",
  "skyZenith": "#0049c7",
  "sunDirectionX": 0,
  "sunDirectionY": 0,
  "sunDirectionZ": 0,
  "fogColor": "#b2c5dc",
  "fogRadius": 16.5,
  "fogSpread": 6.5,
  "fogStrength": 0.08,
  "cameraHeight": 1.8,
  "cameraAngle": 0,
  "cameraPitch": 4.5,
  "cameraDistance": 15,
  "mouseFollow": true,
  "mouseInvert": false,
  "parallaxStrength": 2.25,
  "diveThreshold": 0.2,
  "diveDuration": 1,
  "diveDip": 4,
  "riseLift": 6.5,
  "fogUnder": "#000000",
  "fogUnderNear": 3,
  "fogUnderFar": 30.5,
  "skyUnderTop": "#2f546a",
  "skyUnderBottom": "#0d1763",
  "shaftCrestLight": false,
  "shaftThreshold": -0.33,
  "shaftScale": 1.5,
  "shaftAngle": 88,
  "shaftLength": 30,
  "shaftOpacity": 0.1,
  "shaftColor": "#289a87",
  "waterColor": "#20558d",
  "bottomDepth": 100,
  "bottomColor": "#213e59",
  "causticBrightness": 2.85
}

