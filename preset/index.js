/**
 * @GJY-cmd/dsh-zh-dict-preset — 宿主侧为空。
 *
 * 本包只携带一个 Cordis patch（cordis.patch.yml），它声明 preset-zh-dict
 * 一行并依赖 @GJY-cmd/dsh-cn-dict 提供工具。宿主侧无需任何代码，
 * 故 apply 为空实现（bundle 要求包可解析一个插件入口）。
 */
export function apply() {}
