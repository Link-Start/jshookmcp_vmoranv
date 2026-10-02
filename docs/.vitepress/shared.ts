import { defineConfig } from 'vitepress';

export const base = process.env.VITEPRESS_BASE || '/';

export const shared = defineConfig({
  title: 'JSHookMCP',
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}favicon.png` }],
    ['meta', { name: 'theme-color', content: '#0b0f19' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
    ['meta', { property: 'og:title', content: 'JSHookMCP | JavaScript 逆向与自动化' }],
    ['meta', { property: 'og:site_name', content: 'JSHookMCP' }],
    ['meta', { property: 'og:image', content: 'https://vmoranv.github.io/jshookmcp/favicon.png' }],
    ['meta', { property: 'og:url', content: 'https://vmoranv.github.io/jshookmcp/' }],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'WebSite',
            '@id': 'https://vmoranv.github.io/jshookmcp/#website',
            url: 'https://vmoranv.github.io/jshookmcp/',
            name: 'JSHookMCP',
            description: '面向 JavaScript 逆向、浏览器自动化、网络采集与扩展开发的 MCP 文档站。',
            inLanguage: ['zh-CN', 'en'],
            publisher: { '@id': 'https://vmoranv.github.io/jshookmcp/#org' },
            potentialAction: {
              '@type': 'SearchAction',
              target: 'https://vmoranv.github.io/jshookmcp/?q={search_term_string}',
              'query-input': 'required name=search_term_string',
            },
          },
          {
            '@type': 'Organization',
            '@id': 'https://vmoranv.github.io/jshookmcp/#org',
            name: 'vmoranv',
            url: 'https://vmoranv.github.io/jshookmcp/',
            logo: 'https://vmoranv.github.io/jshookmcp/logo.svg',
            sameAs: ['https://github.com/vmoranv/jshookmcp', 'https://github.com/vmoranv'],
            contactPoint: {
              '@type': 'ContactPoint',
              contactType: 'technical support',
              url: 'https://github.com/vmoranv/jshookmcp/issues',
            },
          },
          {
            '@type': 'FAQPage',
            '@id': 'https://vmoranv.github.io/jshookmcp/#faq',
            mainEntity: [
              {
                '@type': 'Question',
                name: '支持哪些 MCP 客户端？',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: '任何标准 MCP 客户端（Claude Desktop、Cursor、Claude Code 等），通过 stdio 或 Streamable HTTP 接入。',
                },
              },
              {
                '@type': 'Question',
                name: '36 个能力域是什么？',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: '按职责划分的工具集合（如 browser、network、debugger、v8-inspector、native-ffi 等），运行时按 profile 分层加载，其余域懒激活。',
                },
              },
              {
                '@type': 'Question',
                name: '平台支持？',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'Windows（Win32 API）、macOS（Mach trap）、Linux（POSIX syscall），基于 koffi 的跨平台 FFI。',
                },
              },
            ],
          },
        ],
      }),
    ],
    [
      'link',
      {
        rel: 'alternate',
        type: 'application/rss+xml',
        title: 'JSHookMCP Feed',
        href: `${base}feed.rss`,
      },
    ],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Outfit:wght@400;500;600;700&display=swap',
      },
    ],
  ],
  themeConfig: {
    logo: `${base}logo.svg`,
    search: {
      provider: 'local',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/vmoranv/jshookmcp' }],
    footer: {
      message: 'Released under AGPL-3.0-only',
      copyright: 'Copyright © vmoranv and contributors',
    },
  },
});
