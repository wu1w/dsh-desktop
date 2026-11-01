// 平台相关的显示差异。
// 逻辑层一直同时接受 Ctrl 与 ⌘（event.metaKey || event.ctrlKey），
// 但界面上写死的 ⌘ 在 Windows 上会误导用户，这里统一转换。
export const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/** macOS 风格标签 -> 当前平台可读的标签 */
export const fmtKeys = (label) =>
  isWindows ? String(label).replaceAll('⌘', 'Ctrl').replaceAll('⇧', 'Shift') : String(label);

/** 修饰键的显示名 */
export const modKey = isWindows ? 'Ctrl' : '⌘';

/** 组合键显示名，例如 hotkey('N') -> 'Ctrl N' / '⌘ N' */
export const hotkey = (...keys) => [modKey, ...keys].join(' ');
