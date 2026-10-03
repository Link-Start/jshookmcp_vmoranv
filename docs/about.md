# 关于 JSHookMCP

JSHookMCP 是一个开源 TypeScript 项目，目标是让 AI agent 能够直接操作真实运行中的 JavaScript 生态。它把浏览器自动化、CDP 调试、网络抓包、JS hook 与反混淆，以及跨平台 native FFI 打包成一个标准 MCP server，用一行 npx 即可接入任意 MCP 客户端。项目由 vmoranv 发起并维护，以 AGPL-3.0 许可发布。

## 项目定位

JSHookMCP 的核心理念是「工具优先、最小权限」。它不预置任何特征库或已知恶意样本，而是提供匹配引擎与信息性输出，让使用者按需传入要分析的对象。这种设计使它同时服务于合法研究、自有资产审计，以及授权范围内的安全测试。项目强调可审计：每个能力域都有 manifest 声明其前置依赖与激活条件，运行时按 profile 分层加载，避免一次性把所有工具塞进上下文。

## 维护与社区

维护者为 vmoranv，源码与 issue 追踪均托管在 GitHub（github.com/vmoranv/jshookmcp）。贡献遵循 conventional commits 与提交前质量门禁（漂移守卫、lint、类型检查、测试）。文档站本身也是项目产物的一部分，由 VitePress 生成并通过 GitHub Pages 发布。如果你发现工具在某类目标上表现不佳，欢迎提 issue 附上最小复现；已修复的问题会在文档的运维与诊断章节记录边界。

## 使用边界

JSHookMCP 面向授权场景：自有应用的逆向、开源项目研究、CTF 与合规渗透测试。它不提供针对第三方在线服务的自动化攻击能力，使用者需自行遵守目标系统的服务条款与适用法律。
