# 遥测（可选，默认关闭）

jshookmcp 内置可选的 OpenTelemetry 遥测：把**工具调用与搜索行为**以标准 OTLP/HTTP 协议导出到任意 collector 式端点（自建 [opentelemetry-collector](https://opentelemetry.io/docs/collector/)、SigNoz、Grafana Cloud，或项目维护者提供的接收端点）。

**默认完全关闭**（零网络、零开销）。不设置下列环境变量时，进程不发出任何遥测数据。

## 开启方式

在 `.env`（或 MCP server 进程环境）中设置：

```bash
JSHOOK_OBSERVABILITY_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=<端点地址>
# 端点要求认证时（如项目官方接收端点）：
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <token>"
```

## 采集什么（最小化原则）

| 信号 | 内容 | 不包含 |
|------|------|--------|
| `tool.execute` span | 工具名、所属域、耗时、成功/失败 | **工具参数、响应内容一律不采集** |
| `search.query` span | 查询文本（见下方策略）、top-K、结果数、延迟、BM25 置信分、向量是否参与 | 检索结果内容 |
| `search_feedback_used` 指标 | 被调用工具的排名档位（top1/3/5/10）+ 工具名 | — |
| 资源标识 | `service.name=jshookmcp`、每次进程的 `service.instance.id`、匿名随机安装 UUID `install.id` | **无主机名、无用户名、无 IP、无机器指纹**——install.id 是首次运行时本地生成的随机 UUID |

## 查询文本策略（`JSHOOK_OTLP_QUERY_TEXT`）

搜索查询可能包含你自己的敏感信息（目标站 URL、token、样本内容）。默认 `truncated` 只发送**前 64 个字符**加溢出标记：

```bash
JSHOOK_OTLP_QUERY_TEXT=off         # 完全不发送查询文本（指标仍包含数值统计）
JSHOOK_OTLP_QUERY_TEXT=truncated   # 默认：前 64 字符 + …(+N)
JSHOOK_OTLP_QUERY_TEXT=full        # 完整文本（仅在私有端点下使用）
```

## 关闭

删除上述环境变量即恢复默认（no-op，零网络活动）。已生成的匿名 install.id 存于 `~/.jshookmcp/state/install-id`，删除该文件即可重置身份。

代理网络：导出器会自动识别 `HTTPS_PROXY`/`ALL_PROXY` 环境变量（`NO_PROXY` 与 localhost 端点始终直连），无需额外配置。

## 其他后端

`JSHOOK_OBSERVABILITY_EXPORTER=memory` 将 span/指标保存在进程内存中（诊断用）；`none` 为默认 no-op。
