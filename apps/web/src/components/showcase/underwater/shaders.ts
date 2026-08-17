// ---------------------------------------------------------------------------
// 水下场景 shader 集合
//   caustics —— 水波折射光影（参考 giser2017「波浪效果」的领域扭曲算法）
//   godRay   —— 丁达尔光柱（阳光射入海底）
//   bubble   —— 气泡点精灵（过场泳镜气泡 + 环境气泡）
//   codeChar —— 漂浮代码字符点精灵（atlas 采样）
// 说明：renderer.toneMapping = ACESFilmicToneMapping 时 three 会自动注入
//       tonemapping/colorspace 的 pars 函数，此处仅 include 使用点 chunk。
// ---------------------------------------------------------------------------

// —— 水波折射光影（caustics）——
// 移植自参考 shader 的核心：迭代域扭曲（i = p + cos/sin 扰动）产生流动光斑，
// 叠加在深蓝海底渐变之上，模拟水面折射光投在海底的焦散光影。
export const causticsVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const causticsFragmentShader = /* glsl */ `
  #define TAU 6.28318530718
  #define MAX_ITER 5

  uniform float uTime;
  uniform float uScale;
  uniform float uSpeed;
  uniform vec2 uFlowSpeed;
  uniform float uBrightness;
  uniform float uOpacity;
  uniform vec3 uLightColor;
  uniform vec3 uDeepColor;

  varying vec2 vUv;

  void main() {
    // 流动采样：uv 随时间漂移（参考 flowSpeed）
    vec2 uv = (vUv + uTime * uFlowSpeed) * uScale;

    // —— 领域扭曲焦散（参考 giser2017「波浪效果」）——
    vec2 p = mod(uv * TAU, TAU) - 250.0;
    vec2 i = vec2(p);
    float c = 1.0;
    float inten = 0.005;
    for (int n = 0; n < MAX_ITER; n++) {
      float t = uTime * uSpeed * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
    }
    c /= float(MAX_ITER);
    c = 1.17 - pow(c, uBrightness);
    vec3 rgb = vec3(pow(abs(c), 8.0));

    // 海底深蓝渐变（远处更暗）+ 焦散光斑
    vec3 deep = uDeepColor * (0.55 + 0.45 * vUv.y);
    vec3 color = deep + rgb * uLightColor;

    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

// —— 丁达尔光柱（god ray）——
// 顶部（水面方向）亮、向下渐隐，水平软边；透明度随潜入淡入
export const godRayVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const godRayFragmentShader = /* glsl */ `
  uniform float uOpacity;

  varying vec2 vUv;

  void main() {
    float edge = smoothstep(0.0, 0.3, vUv.x) * (1.0 - smoothstep(0.7, 1.0, vUv.x));
    float fade = smoothstep(1.0, 0.12, vUv.y);
    float a = edge * fade * uOpacity;
    gl_FragColor = vec4(vec3(0.72, 0.87, 1.0), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

// —— 气泡点精灵 ——
// 外圈亮环 + 中心微透 + 左上高光点，模拟水泡反光
export const bubbleVertexShader = /* glsl */ `
  attribute float aScale;
  attribute float aAlpha;

  uniform float uPixelRatio;

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aScale * uPixelRatio * (220.0 / max(-mvPosition.z, 0.1));
    gl_Position = projectionMatrix * mvPosition;
  }
`

export const bubbleFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    // 外圈亮环
    float ring = smoothstep(0.5, 0.42, d) - smoothstep(0.4, 0.36, d);
    // 中心微亮（水膜感）
    float core = smoothstep(0.18, 0.0, d) * 0.22;
    // 左上高光点
    vec2 hp = vec2(-0.14, 0.12);
    float highlight = smoothstep(0.26, 0.12, length(c - hp));
    float a = (ring * 0.85 + core + highlight * 0.9) * vAlpha * uOpacity;
    gl_FragColor = vec4(uColor, a);
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
