/**
 * 静态资源导入声明（esbuild `--loader:.svg=text` 产物，浏览器端以字符串内联）。
 */
declare module '*.svg' {
  const content: string
  export default content
}
