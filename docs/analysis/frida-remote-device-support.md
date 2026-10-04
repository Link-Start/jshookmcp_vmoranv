# Frida 远程设备支持改造方案

> 状态:待实现(设计提案)
> 背景:在 Android 模拟器(MuMu 12 / HyperOS-15,桥接网络)上对 `HyperCeiler` 做动态分析时,发现 `binary-instrument` 域的 Frida 工具链完全绑定本地设备,无法 attach 到模拟器进程。
> 本文档精确列出需要修改的文件、函数、调用链,并给出已实测验证的关键事实。

---

## 1. 问题根因

所有 Frida 工具最终都调用 `FridaSession.runFridaCommandWithArgs()`,其命令拼装只有目标参数,没有设备参数:

```ts
// src/modules/binary-instrument/FridaSession.ts
const args = [...targetArgs, '--runtime=v8', '-q', '-e', script];   // ~L506
```

目标参数生成 (`buildTargetArgs`, ~L527-537):

```ts
if (/^\d+$/.test(target)) return ['-p', target];                    // PID
if (target.includes('/') || target.includes('\\')) return ['-f', target]; // 二进制路径
return ['-n', target];                                              // 进程名(本地设备)
```

四个独立缺陷:

1. **无设备选择** —— 从工具层到 `FridaSession` 都没有 `-U/-H/-D` 概念,默认始终是 frida CLI 的 `local` 设备。
2. **Android 进程名不匹配** —— frida-server 在 Android 上对应用进程显示的是 **App Label** 而非包名(实测 `com.sevtinge.hyperceiler` 进程在 frida 里叫 `HyperCeiler`),`-n <包名>` 必然失败;且没有进程枚举工具可查。
3. **`frida_dex_dump` 只有 USB 模式** —— `frida.ts` 里只拼 `-U`(默认 true),桥接网络的模拟器走不了 USB 通道。
4. **CLI 生命周期与挂起风险** —— 每次工具调用都是「起一个 `frida` CLI → attach → 跑脚本 → 退出」的一次性过程(见 §5 架构约束,不要求本次改掉,但要写进行为文档)。

---

## 2. 目标设计与工具面变化

### 2.1 设备模型(核心)

新增类型,绑定在会话上,下游工具从会话继承设备,无需重复传参:

```ts
// src/modules/binary-instrument/FridaSession.ts
export type FridaDevice =
  | { type: 'local' }                          // 默认:不加任何参数
  | { type: 'usb' }                            // -> ['-U']
  | { type: 'remote'; host: string }           // -> ['-H', host]
  | { type: 'id'; id: string };                // -> ['-D', id]

export interface FridaDeviceArgsOptions {
  device?: FridaDevice;
  host?: string;                               // type=remote 时使用的地址:port
}
```

命令行映射,新增私有方法:

```ts
private buildDeviceArgs(device: FridaDevice): string[] {
  switch (device.type) {
    case 'local':  return [];
    case 'usb':    return ['-U'];
    case 'remote': return ['-H', device.host];
    case 'id':     return ['-D', device.id];
  }
}
```

`runFridaCommandWithArgs` 改为把设备参数放在**最前**(frida CLI 的 `-U/-H/-D` 必须出现在 `-n/-p/-f` 之前):

```ts
const args = [
  ...this.buildDeviceArgs(device),
  ...targetArgs,
  '--runtime=v8', '-q', '-e', script,
];
```

### 2.2 会话记录携带设备

```ts
// ~L80 FridaSessionRecord / ~L71 FridaSessionInfo
interface FridaSessionRecord extends FridaSessionInfo {
  device: FridaDevice;          // 新增
  ...
}
```

- `attach(target, device?)`、`spawn(target, device?)` 签名扩展,未传时默认 `{ type: 'local' }`(保持向后兼容,本地行为不变)。
- `attach` 的空探脚本 `console.log("__frida_attach_ok__")` 走 `runFridaCommand`,会自动带上设备参数,失败信息里能区分 `local` 与 `remote` 的报错。
- `runFridaCommandForSession(session, ...)` 用 `session.device` 拼参数 —— 所有下游(executeScript / resume / enumerateModules / enumerateFunctions / findSymbols / memoryScan / memoryRead / attach_interceptor)自动继承,无需改签名。

### 2.3 目标解析与进程发现(解决 App Label 问题)

- `frida_attach` 增加可选 `pid` 参数(已有 legacy `pid` 通道,但走的是旧插件;建议统一为本实现),远程场景直接 `-p <pid>` 绕过名称匹配。
- **新增工具 `frida_list_devices`**:调 `frida-ls-devices`(本地、USB、远程按 `-H`),返回 `{ id, type, name }[]`,方便先发现设备再 attach。设备参数复用 `device` 模型。
- **新增工具 `frida_list_processes`**:调 `frida-ps`(按设备参数加 `-U/-H/-D`,本地不加参数),返回 `{ pid, name }[]`。Android 上展示的 name 即 App Label,配合 `-p` 使用即可彻底绕开「包名 vs Label」的坑。

> 实现位置建议:这两个工具放 `FridaSession` 同级(或 `FridaSession` 内新增 `listDevices() / listProcesses(device)`),由 `frida-handlers.ts` 暴露;`frida-ps/frida-ls-devices` 通过现有 `probeCommand` 探活。

---

## 3. 逐文件修改清单

### 3.1 `src/modules/binary-instrument/FridaSession.ts`(核心)

| 位置 | 改动 |
|---|---|
| ~L69 附近 | 新增 `FridaDevice` / `FridaDeviceArgsOptions` 类型(见 §2.1) |
| `FridaSessionInfo`/`FridaSessionRecord` | 加 `device: FridaDevice` 字段 |
| `attach()` / `spawn()` | 签名加 `device?: FridaDevice`,记录到 session;`runFridaCommand*` 调用处传入 |
| `runFridaCommandWithArgs()` ~L506 | 参数拼装前插入 `buildDeviceArgs(device)` |
| `runFridaCommandForSession()` ~L477 | 从 `session.device` 取设备 |
| 新增 `buildDeviceArgs()` | 见 §2.1 代码 |
| 新增 `listDevices()` / `listProcesses(device?)` | 见 §2.3 |

注意:`spawn` 模式下 `runFridaCommandForSession` 在 `resumed !== true` 时会**重新用 `-f` spawn 一次新进程**(~L484-486)——远程 Android 上这会反复重启应用。保持该语义,但在文档/返回里注明「spawn 会话在 resume 前每次工具调用都会重新 spawn」。

### 3.2 `src/server/domains/binary-instrument/definitions.ts`(工具 schema)

DSL 支持 `.enum()`(已确认,见 `registry` 里 ToolSpec 的 enum 实现)。改动:

- `frida_attach`(~L20):加
  ```ts
  .enum('device', ['local', 'usb', 'remote', 'id'], 'Frida 设备: local(默认)/usb/remote(-H host)/id(-D id)')
  .string('host', 'device=remote 时的 host:port,例如 192.168.1.11:27042')
  .number('pid', '远程场景直接用 PID attach,避免 App Label 名称不匹配')
  ```
- `frida_spawn`(~L26):同样加 `device`/`host`。
- `frida_dex_dump`(~L106):把现有 `usb` 布尔升级为 `device` 枚举 + `host`,保留 `usb` 布尔做向后兼容(映射到 `{ type:'usb' }`)。
- 新增 `frida_list_devices` / `frida_list_processes` 两个 `tool()` 定义。
- 其余 session 工具(`frida_run_script`/`frida_memory_scan` 等)**不需要**加 device 参数 —— 从 `sessionId` 关联的会话记录继承。

### 3.3 `src/server/domains/binary-instrument/handlers/frida-handlers.ts`

- `handleFridaAttach`(~L55):读 `device`/`host`/`pid`,构造 `FridaDevice`,调 `frida.attach(target, device)`;返回体带 `device`。
- `handleFridaSpawn`(~L106):同上。
- 新增 `handleFridaListDevices` / `handleFridaListProcesses`。
- 其余 handler 只读 `sessionId`,逻辑不变(设备自动继承)。

### 3.4 `src/server/domains/binary-instrument/handlers/frida.ts`(dex_dump)

- `handleFridaDexDump`(~L19):`dexArgs` 拼装改为设备感知:
  ```ts
  // local: 无参数;usb: ['-U'];remote: ['-H', host];id: ['-D', id]
  dexArgs.push(...deviceArgs, ...);
  ```
  当前写死的 `if (usb) dexArgs.push('-U')`(~L40)替换为设备分支;`-p`/`-n` 逻辑保留(同样注意 App Label 问题,建议优先 `-p`)。

### 3.5 `src/server/domains/binary-instrument/manifest.ts`

- ~L20-58 工具注册表:加 `frida_list_devices`、`frida_list_processes` 两行 `{ tool, method }`。
- 改完 definitions/manifest 后运行 `pnpm scripts/generate-domains-index.mjs`(或项目约定的 build)重新生成 `src/server/registry/generated-tool-catalog.ts` 与 `generated-tool-domains.ts` —— **不要手改 generated 文件**(scripts/CLAUDE.md 有明确约束)。

### 3.6 配置(`src/types/config.ts`)

- `FridaAnalysisConfig`(~L352):新增 `remoteTimeoutMs`、`deviceProbeTimeoutMs` 等可调项(远程 attach 首包握手比本地慢,默认值建议 > FRIDA_TIMEOUT_MS)。
- 对应实现取值处:在 handler 层把 `timeoutMs` 传进 `attach/spawn` 的空探调用。

### 3.7 测试

- `tests/modules/binary-instrument/FridaSession.test.ts`(现有用例都断言 `execFile.mock.calls` 的 args 数组):
  - 新增用例:`attach(..., {type:'usb'})` 断言 args 含 `-U`;`{type:'remote',host}` 断言 `['-H', host, '-n', target, ...]` 顺序;`spawn` 同理。
  - 断言 device 字段写进 session record,`listSessions()` 返回 device。
- `tests/modules/binary-instrument/FridaSession.memory.test.ts`:补一条远程设备下 `memoryScan` 的 args 前缀断言。
- `tests/server/domains/binary-instrument/frida-task.test.ts`:确认 async 任务路径透传 device。

---

## 4. 已实测验证的关键事实(可直接复现)

以下是在本机/模拟器上跑通的环境事实,用于实现后自测:

1. **宿主机 frida**:`C:\Python313\Scripts\frida.exe`,版本 **17.12.0**(python `frida 17.12.0`)。
2. **模拟器侧 frida-server**:`frida-server-17.12.0-android-x86_64`,root 运行 `nohup /data/local/tmp/frida-server -l 0.0.0.0:27042 &`(MuMu 桥接网卡 IP `192.168.1.11`,Android 15,x86_64)。
3. **通道验证(等价于改造后的 `-H` 路径)**:
   ```bash
   FRIDA_HOST=192.168.1.11:27042 "C:/Python313/Scripts/frida.exe" \
     -n HyperCeiler --runtime=v8 -q -e 'console.log(Process.id)'
   # 输出: ATTACH_OK pid=2695 arch=x64; Java.available=true
   ```
   证明 `-H host:port + -n <App Label>` 是可行调用形态。
4. **进程名**:frida 枚举该模拟器进程显示 **`HyperCeiler`**(App Label),不是 `com.sevtinge.hyperceiler` —— `-n` 必须用 Label 或直接 `-p <pid>`。
5. **frida-tools 的环境变量 fallback**(临时方案,不推荐长期依赖):`frida_tools/application.py` 在未显式给 `-D/-U/-H` 时读取 `FRIDA_DEVICE`/`FRIDA_HOST`(实现见 ~L199-209)。`FRIDA_HOST` 可与 `-n` 组合直接工作。
6. **Windows 非 TTY 退出行为**:`frida -q -e` 在非交互 stdin 下依赖 prompt_toolkit 的报错退出才能结束进程(实测 `frida-ls-devices` 在该环境直接抛 `NoConsoleScreenBufferError`)。建议顺手把 `execFileUtf8` 的 stdio 显式设为 `stdio: ['ignore','pipe','pipe']`(stdin EOF → REPL 立即退出),让一次性脚本执行可确定性地结束,而不是靠超时/异常。

---

## 5. 架构约束与行为文档(本次不实现,但建议写进工具描述)

- **Hook 不跨调用持久**:每次 `frida_run_script` 都是「新起 CLI → 重新 attach → 跑完即退出」,上一个脚本装的 hook 在该 CLI 退出后失效。若工作流需要「hook 住 → 操作应用 UI → 观察 hook 触发」,请用现有 `async:true` 后台任务模式:脚本常驻一个 frida CLI 进程(默认 5 分钟 TTL,可调至 10 分钟),hook 存活期间用 MCP 的 adb/browser 工具操作目标,任务结束/取消后 `tasks_result` 取到完整 console 输出。这个语义需要写进 `frida_run_script` 的 desc。
- **spawn 语义**:spawn 会话在 `resumed` 之前,每次工具调用都会 `-f` 重新 spawn(现有行为),远程 Android 会反复重启应用 —— 文档注明。
- **版本匹配**:客户端 frida 与远端 frida-server 必须大版本一致(本项目客户端固定 17.12.0,server 也须 17.12.0),x86_64 模拟器用 `android-x86_64` 构建。

---

## 6. 实现验收清单

- [ ] `frida_attach(device='remote', host='192.168.1.11:27042', target='HyperCeiler')` 返回 sessionId
- [ ] `frida_list_processes(device='remote', host=...)` 能列出 `2695 HyperCeiler`
- [ ] 同一 sessionId 下 `frida_run_script` 输出带 `-H` 前缀参数
- [ ] `frida_memory_scan` / `frida_enumerate_modules` 在远程会话可用
- [ ] `frida_dex_dump(device='remote', host=..., pid=2695)` 产出 dex
- [ ] `frida_spawn(device='remote', host=..., target='com.sevtinge.hyperceiler')` + `frida_resume` 在模拟器可用
- [ ] local 设备行为完全不变(全部现有测试通过)
- [ ] generated catalog 已重新生成,无手改
