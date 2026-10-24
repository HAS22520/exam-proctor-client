/* eslint style/indent: ['warn', 2] -- 前端遵循两空格缩进。 */
// 与 OJ 的 hydro-ui-accent-color 预设一致；页面加载后优先继承其实际 CSS 主题色。
const accents: Record<string, [string, string]> = {
  default: ['#3f879c', '#6bb3c7'],
  blue: ['#228be6', '#74c0fc'],
  violet: ['#7950f2', '#b197fc'],
  rose: ['#e64980', '#f06595'],
};

export function panelAccent(value: string | null, dark: boolean) {
  if (value && /^#[\da-f]{6}$/i.test(value)) return value;
  return (value && Object.hasOwn(accents, value) ? accents[value] : accents.default)[dark ? 1 : 0];
}

export function panelIconColor(color: string) {
  if (!/^#[\da-f]{6}$/i.test(color)) return '#ffffff';
  const rgb = [1, 3, 5].map((start) => {
    const value = Number.parseInt(color.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? '#142b3b' : '#ffffff';
}

/** 兼容页面尚未加载主题、存储被禁用及同页/跨页切换主题。 */
export function bindPanelTheme(host: HTMLElement) {
  const root = host.ownerDocument.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    let accent: string | null = null;
    let dark = media.matches;
    try {
      accent = localStorage.getItem('hydro-ui-accent-color');
      if (localStorage.getItem('hydro-ui-auto-theme') === 'false') dark = localStorage.getItem('hydro-ui-theme') === 'dark';
    } catch { /* 页面禁用存储时仍继承 CSS 主题。 */ }
    const scheme = root.getAttribute('data-mantine-color-scheme');
    if (scheme === 'dark' || scheme === 'light') dark = scheme === 'dark';
    if (root.classList.contains('dark')) dark = true;

    const fallback = panelAccent(accent, dark);
    const primary = getComputedStyle(root).getPropertyValue('--hydro-primary').trim() || fallback;
    const failed = dark ? '#ef4444' : '#dc2626';
    const success = dark ? '#22c55e' : '#15803d';

    host.setAttribute('data-theme', dark ? 'dark' : 'light');
    host.style.setProperty('--panel-accent', fallback);
    host.style.setProperty('--panel-icon-color', panelIconColor(primary));
    host.style.setProperty('--panel-status-pending', primary);
    host.style.setProperty('--panel-status-failed', failed);
    host.style.setProperty('--panel-status-success', success);
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ['style', 'class', 'data-mantine-color-scheme'] });
  window.addEventListener('storage', sync);
  window.addEventListener('focus', sync);
  media.addEventListener('change', sync);
  return () => {
    observer.disconnect();
    window.removeEventListener('storage', sync);
    window.removeEventListener('focus', sync);
    media.removeEventListener('change', sync);
  };
}
