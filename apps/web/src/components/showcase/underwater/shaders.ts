import { seaFieldGLSL } from "../sea-field"

// ---------------------------------------------------------------------------
// 水下场景 shader 集合
//   caustics  —— 海底折射光斑（统一 waveField 骨架 + 正色映射）
//   lightShaft—— 海中光柱（浪谷三角向下拉伸的三棱柱侧面，位置 100% 对齐海面）
//   codeChar  —— 漂浮代码字符点精灵（atlas 采样）
// 说明：renderer.toneMapping = ACESFilmicToneMapping 时 three 会自动注入
//       tonemapping/colorspace 的 pars 函数，此处仅 include 使用点 chunk。
// ---------------------------------------------------------------------------

// —— 海底折射光斑（caustics）——
// 统一骨架：直接用共享 seaFieldGLSL 的 waveField（世界 XZ → 海面高度），
//   正色映射：浪峰（h>0）聚光 → 亮；浪谷（h<0） → 暗。
//   → 光斑结构与海面波浪完全一致（同一函数、同一参数、世界坐标），天然同向晃动。
export const causticsVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

export const causticsFragmentShader = /* glsl */ `
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
  uniform float uBrightness;
  uniform float uOpacity;
  uniform vec3 uLightColor;
  uniform vec3 uDeepColor;

  varying vec2 vUv;
  varying vec3 vWorldPos;

  ${seaFieldGLSL}

  void main() {
    // 统一骨架：世界 XZ 采样海面高度（与海面 / 海中光柱同一 waveField）
    float h = waveField(vWorldPos.xz, uTime);
    // 正色映射（不做反色）：浪峰（h>0）聚光 → 亮；浪谷（h<0） → 暗
    float light = smoothstep(0.0, 0.4, h);
    float bright = pow(light, 1.2) * uBrightness;

    // 海底深蓝渐变（远处更暗）+ 光斑
    vec3 deep = uDeepColor * (0.55 + 0.45 * vUv.y);
    vec3 color = deep + bright * uLightColor;

    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

// —— 海中光柱（light shaft）：浪谷三角向下拉伸的三棱柱侧面 ——
// 几何体（systems.ts 构造）= 海面网格每个三角形向下拉伸的三棱柱侧面 quad，
// 顶点着色器复用共享 seaFieldGLSL 的 waveField（世界 XZ → 海面高度）：
//   · 上顶点（aFlag=0）落位海面高度 elevation，下顶点（aFlag=1）落位
//     elevation - uLength（光束长度可调）
//   · 光柱沿入射角度倾斜（uAngle + uTilt 控制方向与强度）
//   · uScale 缩放光柱从海面向下的横向收束（光影缩放）
//   · → 光柱从海面波谷自然向下延伸，位置/方向与海面波浪 100% 实时对齐（同一函数）
// 片元：取反(-elevation) 决定透光强度（浪谷越深越亮），沿纵向靠近海底渐隐。
export const lightShaftVertexShader = /* glsl */ `
  attribute float aFlag;

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
  uniform float uLength;
  uniform float uScale;
  uniform float uAngle;
  uniform float uTilt;

  varying float vElevation;
  varying float vFlag;

  ${seaFieldGLSL}

  void main() {
    // position.xy 即世界 XZ（与海面 modelPosition.xz 同一坐标系 → 波谷天然对齐）
    float elevation = waveField(position.xy, uTime);
    // 光影缩放：光柱从海面（aFlag=0）向下按 uScale 横向缩放（>1 发散 / <1 收束）
    float shrink = mix(1.0, uScale, aFlag);
    // 入射角度：沿 uAngle 方向的水平倾斜（uTilt 控制强度）
    vec2 tiltDir = vec2(sin(uAngle), cos(uAngle));
    vec2 offset = tiltDir * uTilt * uLength * aFlag;
    vec3 worldPos = vec3(
      position.x * shrink + offset.x,
      mix(elevation, elevation - uLength, aFlag),
      position.y * shrink + offset.y
    );
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
    vElevation = elevation;
    vFlag = aFlag;
  }
`

export const lightShaftFragmentShader = /* glsl */ `
  uniform float uOpacity;
  uniform float uThreshold;
  uniform float uCrestLight;
  uniform vec3 uLightColor;

  varying float vElevation;
  varying float vFlag;

  void main() {
    // 映射：浪顶为光（uCrestLight=1）→ 浪顶（elevation 高）发光；
    //       默认（uCrestLight=0）→ 浪谷（elevation 低）透光
    float lo = uThreshold - 0.4;
    float hi = uThreshold;
    float light;
    if (uCrestLight > 0.5) {
      light = smoothstep(lo, hi, vElevation);
    } else {
      light = 1.0 - smoothstep(lo, hi, vElevation);
    }
    // 纵向渐隐：海面（vFlag=0）亮 → 光束底端（vFlag=1）渐隐全透明
    float fade = 1.0 - smoothstep(0.4, 1.0, vFlag);
    float a = light * fade * uOpacity;
    gl_FragColor = vec4(uLightColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

// —— 漂浮代码字符点精灵 ——
// vertex 把字符索引/颜色/透明度传给 fragment，gl_PointSize 随距离衰减
export const codeCharVertexShader = /* glsl */ `
  attribute float aChar;
  attribute float aAlpha;
  attribute vec3 aColor;

  uniform float uSize;
  uniform float uPixelRatio;

  varying float vChar;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vChar = aChar;
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * uPixelRatio * (180.0 / max(-mvPosition.z, 0.1));
    gl_Position = projectionMatrix * mvPosition;
  }
`

export const codeCharFragmentShader = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform float uAtlasSize;

  varying float vChar;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float col = mod(vChar, uAtlasSize);
    float row = floor(vChar / uAtlasSize);
    vec2 uv = (vec2(col, row) + gl_PointCoord) / uAtlasSize;
    float mask = texture2D(uAtlas, uv).r;
    if (mask < 0.5) {
      discard;
    }
    gl_FragColor = vec4(vColor, mask * vAlpha);
  }
`
