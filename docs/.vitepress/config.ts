import { defineConfig } from 'vitepress';
import { shared } from './shared';
import { zh } from './zh';
import { en } from './en';

const SITE_ORIGIN = 'https://vmoranv.github.io/jshookmcp';

// 为每页注入 <link rel="canonical">。
// transformHtml 在每页渲染完成后、写盘前执行；htmlFileName 是【绝对路径】（…/dist/<locale>/<page>.html，Windows 下反斜杠）。
// 以产物目录 `dist/` 为锚点取站点相对路径（归一化反斜杠后按 `/dist/` 切分），得到与 cleanUrls 一致的真实 URL：
//   dist/index.html            → https://vmoranv.github.io/jshookmcp/
//   dist/en/index.html         → https://vmoranv.github.io/jshookmcp/en/
//   dist/guide/getting-started.html → https://vmoranv.github.io/jshookmcp/guide/getting-started
// index.html 归一到其所在目录（保留尾斜杠语义），普通页去掉 .html；404.html 跳过。
function injectCanonical(code: string, htmlFileName: string): string {
  if (code.includes('rel="canonical"')) return code;
  const sitePath = htmlFileName.replace(/\\/g, '/').split('/dist/').pop();
  if (!sitePath || sitePath === '404.html') return code;
  // index.html → 所在目录（带尾斜杠，与 cleanUrls 的 /en/、/ 一致）；普通页去 .html
  const url = sitePath.endsWith('index.html')
    ? `${SITE_ORIGIN}/${sitePath.replace(/index\.html$/, '')}`
    : `${SITE_ORIGIN}/${sitePath.replace(/\.html$/, '')}`;
  return code.replace(/<head>/, `<head>\n  <link rel="canonical" href="${url}">`);
}

export default defineConfig({
  ...shared,
  transformHtml(code, htmlFileName) {
    return injectCanonical(code, htmlFileName);
  },
  locales: {
    root: {
      label: '简体中文',
      ...zh,
    },
    en: {
      label: 'English',
      link: '/en/',
      ...en,
    },
  },
});
