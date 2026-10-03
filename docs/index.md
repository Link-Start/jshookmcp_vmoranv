---
layout: home

hero:
  name: JSHookMCP
  text: JavaScript 逆向与自动化文档站
  tagline: 面向浏览器自动化、网络采集、运行时 Hook、扩展开发与工作流编排的 MCP 文档。
  image:
    src: /favicon.png
    alt: JSHookMCP
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 扩展开发
      link: /extensions/

features:
  - title: 快速进入状态
    icon: 🚀
    details: 从安装、启动、抓第一批请求，到选择 built-in tools、workflow、plugin 的最短路径。
  - title: 扩展优先文档
    icon: 🧩
    details: 覆盖插件模板仓、工作流模板仓、并行调用与 subagent 侧车分析实践。
  - title: 运维与生产说明
    icon: 🛡️
    details: 集中说明 doctor、产物 retention、安全默认值与跨平台限制。
---

## ⚡ 极速接入

只需将以下配置添加到你的 MCP 客户端（如 Claude Desktop 或 Cursor）即可完成接入：

```json
{
  "mcpServers": {
    "jshook": {
      "command": "npx",
      "args": ["-y", "@jshookmcp/jshook"]
    }
  }
}
```

## 这是什么

这是一个 TypeScript 实现的 MCP（Model Context Protocol）server，npm 包名 `@jshookmcp/jshook`，AGPL-3.0 许可，一行 `npx` 即可运行，无需本地安装。它为 AI agent 提供 600+ 工具，覆盖 36 个能力域，横跨浏览器自动化、CDP 协议调试、网络抓包与协议分析、JavaScript hook 与反混淆、跨平台 native FFI，以及声明式工作流编排。

## 能力域速览

| 域 | 典型用途 |
| --- | --- |
| browser | 页面导航、点击、表单、截图、localStorage/cookie 管理、CDP 目标连接 |
| network | 请求/响应捕获、协议分析（HTTP/2、gRPC、protobuf、msgpack）、重放 |
| debugger / v8-inspector | 断点、单步、堆栈、V8 引擎级 inspector 协议直连 |
| native-emulator | ARM64/AArch64 指令仿真，Flutter 与 Android native 逆向 |
| workflow | 声明式多工具编排：parallel、branch、retry、fallback |
| extension-sdk | 以插件形式扩展工具与工作流，最小权限模型 |

完整目录见 [工具参考](/reference/)，按域分章、中英双语。

### 按任务快速定位

- 抓包与协议分析 → [network](/reference/#network)
- 页面操作与截图 → [browser](/reference/#browser)
- 断点单步 → [debugger / v8-inspector](/reference/#debugger)
- 插件与工作流扩展 → [extension-sdk](/reference/#extension-sdk)

## 运行平台

基于 koffi 的跨平台 FFI 层支持三个操作系统：

- **Windows**：Win32 API（进程、模块、调试器 API）
- **macOS**：Mach trap（任务/端口/反汇编）
- **Linux**：POSIX syscall 直读

环境变量 `MCP_TOOL_PROFILE` 控制加载层级：`search`（检索）⊂ `workflow`（编排）⊂ `full`（全量 36 域）。

## 文档导航

- [快速开始](/guide/getting-started) — 安装、启动、抓第一批请求
- [最佳实践](/guide/best-practices) — 工具选择与调用策略
- [配置](/guide/configuration) — `.env` 与 profile 分层
- [扩展开发](/extensions/) — 插件模板仓与工作流模板仓
- [运维与诊断](/operations/doctor-and-artifacts) — `doctor`、产物保留、安全默认值
- [贡献指南](/contributing) — 构建、测试、提交流程
