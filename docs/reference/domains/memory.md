# 内存

域名：`memory`

面向原生内存扫描、指针链分析、结构体推断与断点观测的内存分析域。

## Profile

- full

## 典型场景

- 首扫/缩扫定位目标值
- 指针链与结构体分析
- 内存断点与扫描会话管理

## 常见组合

- memory + process
- memory + debugger
- memory + workflow

## 工具清单（59）

| 工具 | 说明 |
| --- | --- |
| `memory_first_scan` | 启动新的内存扫描会话。在目标进程的可读写内存区域中搜索指定值。支持 13 种数据类型、可选浮点容差（tolerance）和区域过滤（可读写/可执行/仅模块）。跨平台。 |
| `memory_next_scan` | 在现有扫描会话基础上缩小范围。新增 4 种比较模式：changed_by（变化量等于 delta）、increased_by（增加至少 delta）、decreased_by（减少至少 delta）、changed_by_variable（记录每地址的实际变化量）。支持浮点容差和精确值/范围过滤。跨平台。 |
| `memory_unknown_scan` | 开始未知初始值扫描。先捕获指定类型的全部可读内存地址，再结合 memory_next_scan 的 "changed"、"unchanged"、"increased"、"decreased" 模式逐步缩小范围。等同于 Cheat Engine 的“Unknown initial value”扫描。 |
| `memory_pointer_scan` | 查找指向目标地址的指针。扫描进程内存中的指针大小值，定位那些直接指向目标地址或落在目标地址附近（±4096 字节，适用于结构体成员访问）的指针。 |
| `memory_group_scan` | 同时搜索多个已知偏移上的值。适合在你已知结构体相对布局时使用，例如生命值在 +0、法力值在 +4、等级在 +8。 |
| `memory_scan_session` | 管理扫描会话。操作：list（列出全部）、delete（删除指定会话）、export（导出为 JSON）。 |
| `memory_search_string` | 待补充中文：Search process memory for strings matching a pattern. Wraps memory_first_scan with valueType=string for convenience and adds substring/regex post-filtering. Optionally also searches for UTF-16LE (wide) strings. |
| `memory_pointer_chain` | 多级指针链操作：扫描、验证、解析和导出指针链。 |
| `memory_structure_analyze` | 分析某个地址处的内存内容，以推断数据结构布局。使用启发式规则将字段识别为 vtable 指针、普通指针、字符串指针、浮点数、整数、布尔值或填充区。可选解析 RTTI，以获取类名和继承链（MSVC x64）。 |
| `memory_vtable_parse` | 解析 vtable，枚举其中的虚函数指针并解析为模块名 + 偏移。同时尝试解析 RTTI，以恢复类名和继承层级。 |
| `memory_structure_export_c` | 将推断出的结构体导出为 C 风格 struct 定义或 ReClass.NET XML 项目文件（format='reclass'），并附带偏移注释和类型标注。ReClass 格式与 ReClass.NET 兼容，可直接导入进行可视化结构分析。 |
| `memory_structure_compare` | 比较两个结构体实例，找出哪些字段会变化（如生命值、坐标等动态值），哪些字段保持不变（如 vtable、类型标志等），便于定位关键字段。 |
| `memory_breakpoint` | 使用 x64 调试寄存器（DR0-DR3）的硬件断点操作或 INT3（0xCC）软件断点。硬件断点最多 4 个并发，支持按访问类型（读/写/读写/执行）和观察大小（1/2/4/8 字节）过滤。软件断点无数量限制，在执行前自动读回原始字节检测自修改代码，线程安全。可选条件表达式（JavaScript 语法，如 'rax === 0x1234n'），条件为 false 时自动跳过命中。操作：set、remove、list、trace。 |
| `memory_patch_bytes` | 向目标进程的指定地址写入字节序列。会保存原始字节，便于后续撤销。适用于运行时代码补丁。 |
| `memory_patch_nop` | 将指定地址处的指令改写为 NOP（0x90）。常用于禁用检查逻辑或跳转指令。 |
| `memory_patch_undo` | 撤销之前的补丁，并恢复原始字节内容。 |
| `memory_code_caves` | 在已加载模块的可执行节中查找 code cave（连续的 0x00 或 0xCC 区段），并按大小优先返回。 |
| `memory_allocate` | 待补充中文：Allocate executable memory in target process (VirtualAllocEx wrapper). Win32 only. Requires JSHOOK_INJECTION_ENABLE=1. |
| `memory_free` | 待补充中文：Free remote memory in target process (VirtualFreeEx wrapper). Win32 only. Requires JSHOOK_INJECTION_ENABLE=1. |
| `memory_inject_shellcode` | 待补充中文：Inject shellcode into target process. Win32 only. Methods: createremote (CreateRemoteThread) or ntcreatethread (NtCreateThreadEx). Requires JSHOOK_INJECTION_ENABLE=1. |
| `memory_inject_dll` | 待补充中文：Inject a DLL into target process. Win32 only. Modes: loadlibrary (LoadLibraryW injection) or manualmap (manual mapping). Requires JSHOOK_INJECTION_ENABLE=1. |
| `memory_write_value` | 向指定内存地址写入一个带类型的值，并支持通过 memory_write_history 的 undo/redo 动作进行撤销与重做。 |
| `memory_batch_edit` | 待补充中文：Write a value to ALL addresses in a scan session at once. Thin wrapper that iterates through the session address list and calls writeValue for each. Capped at 1000 addresses per call with a clear error when exceeded. Destructive — an audit trail entry is recorded for each write. Equivalent to GameGuardian's gg.editAll() or Cheat Engine's "Edit All". |
| `memory_watch` | 待补充中文：Poll a memory address until its value changes (like scanmem's "watch" command). Reads the current value, then polls at a configurable interval. Returns immediately with the old value, new value, and elapsed time when a change is detected. If no change occurs within the timeout, returns the unchanged value and a hint. Useful for "tell me when this variable changes" workflows. |
| `memory_freeze` | 将某个地址冻结为固定值。工具会按设定间隔持续回写该值，防止它被其他逻辑修改。 |
| `memory_dump` | 以十六进制 + ASCII 列的形式导出一段内存区域，输出风格类似 xxd 的格式化十六进制转储。 |
| `memory_speedhack` | 通过进程内 SSE2 蹦床挂钩时间 API 来缩放进程时间。操作包括：apply（挂钩并设置速度）、set（调整速度无需重新挂钩）、restore（取消挂钩并恢复原始函数）。速度范围 0.01–100 倍。共挂钩 6 个 API：GetTickCount64、GetTickCount、QueryPerformanceCounter、QueryPerformanceFrequency（速度=0 时除零保护→1.0）、timeGetTime（winmm.dll）、GetSystemTimeAsFileTime。三区 W^X 分配架构（代码/蹦床/数据分离，从不同时可写可执行）。仅 Win32。 |
| `memory_write_history` | 撤销或重做最近一次内存写入操作。 |
| `memory_heap_enumerate` | 通过 Toolhelp32 快照枚举目标进程中的所有堆和堆块，返回堆列表、块数量、块大小以及整体统计信息。 |
| `memory_heap_stats` | 获取详细的堆统计信息，包括大小分布桶（0-64B、64B-1KB、1-64KB、64KB-1MB、&gt;1MB）、碎片率和各类汇总指标。 |
| `memory_heap_anomalies` | 检测堆异常，包括堆喷射模式（大量同尺寸块）、可能的 use-after-free（已释放块中仍存在非零数据），以及可疑块尺寸（0 或大于 100MB）。 |
| `memory_pe_headers` | 从进程内存中的模块基址解析 PE 头（DOS、NT、File、Optional），返回机器类型、入口点、镜像基址、节区数量以及数据目录信息。 |
| `memory_pe_imports_exports` | 从进程内存中的 PE 模块解析导入表和/或导出表，返回 DLL 名称、函数名、序号、hint 以及 forwarded export 等信息。 |
| `memory_inline_hook_detect` | 通过比较磁盘文件与内存中每个导出函数的前 16 个字节来检测 inline hook。可识别 JMP rel32、JMP abs64、PUSH+RET 等 hook 形式，并解析跳转目标。 |
| `memory_anticheat_detect` | 扫描进程导入项中的反调试/反作弊机制，例如 IsDebuggerPresent、NtQueryInformationProcess、计时检测（QPC、GetTickCount）、线程隐藏、堆标志检查以及 DR 寄存器检测。每项发现都会附带绕过建议。 |
| `memory_guard_pages` | 查找进程中所有带有 PAGE_GUARD 保护属性的内存区域。Guard page 常用于防篡改机制或栈溢出检测。 |
| `memory_integrity_check` | 通过比较磁盘字节与内存字节的 SHA-256 哈希，检查代码节完整性。可用于发现补丁、Hook 以及其他对可执行节的运行时修改。 |
| `memory_region_enumerate` | 枚举目标进程的内存区域。跨平台：Windows（VirtualQueryEx）、macOS（mach_vm_region）、Linux（/proc/pid/maps）。返回基址、大小、保护属性（r/w/x/rw/rx/rwx）、状态、类型（image/mapped/private）和模块名（如有模块背书）。 |
| `memory_aob_scan` | 支持通配符的字节阵列扫描（AOB scan）。在可读内存中搜索如 "48 8B ?? ?? 00 00" 的字节模式。接受十六进制字节（00-FF，可选 0x 前缀）和 "??" 通配符，大小写不敏感。可选 executableOnly=true 仅扫描可执行内存页面（CE 7.6 AOBSCANEX）。 |
| `memory_find_accesses` | 查找写入或访问某内存地址的指令（Cheat Engine MWT 工作流）。在目标地址设置硬件断点，每次命中后自动重装，捕获触发故障的指令地址、上下文和时间戳，可选择反汇编该指令。返回聚合的命中记录及每条命中的指令详情。 |
| `memory_cheat_table` | 待补充中文：Import or export a Cheat Engine .CT file. Export: converts a JSON array of {description, address, valueType, moduleName?, offset?} entries to a valid .CT XML file. Import: parses a .CT XML string and returns entries as JSON. Addresses can be hex ("0x7FF612340000") or module+offset ("game.exe"+00123456). Auto Assembler scripts are skipped with a warning. |
| `memory_generate_signature` | 待补充中文：Generate an update-resistant AOB (Array-of-Bytes) signature from bytes at a memory address. Detects relative offsets in CALL/JMP/LEA/Jcc instructions and replaces the displacement bytes with wildcards (??), making the signature survive minor code changes between updates. Uses byte-pattern heuristics — no Capstone dependency required. |
| `memory_rtti_info` | 待补充中文：Parse MSVC RTTI (Run-Time Type Information) at an object address. Reads vtable pointer, follows the Complete Object Locator chain, extracts class name, base classes, and class hierarchy descriptor. Equivalent to CE's "Find out what addresses this code accesses" for type discovery — quickly answer "what type is this object?" without a full structure analysis. Only works on MSVC x64 binaries with RTTI enabled. |
| `memory_parse_dump` | 解析 Windows Minidump（.dmp）文件并提取取证信息：已加载模块（基址/大小/名称/时间戳）、线程（ID/栈/上下文）、内存范围（64 位或 32 位）、系统信息（OS/CPU）和异常记录。可选解析地址列表对照 dump 内容。纯 TS 实现——跨平台（可在 Linux/macOS 上分析 Windows dump）。 |
| `memory_mono_detect` | 待补充中文：Detect Mono or IL2CPP runtime in a target process. Returns runtime kind (mono/il2cpp), module name, pointer size, and root domain address if resolved. Works on Unity games and other Mono/.NET applications. |
| `memory_mono_assemblies` | 待补充中文：List Mono assemblies loaded in the root domain of a Unity/Mono process. Returns assembly name, address, and image address. Optionally filter by name substring. |
| `memory_mono_classes` | 待补充中文：List Mono classes in a specific assembly from a Unity/Mono process. Reads the MonoImage type definition table (MONO_TABLE_TYPEDEF) and resolves class names from the string heap. Optionally filter by namespace. |
| `memory_mono_objects` | 待补充中文：Find live Mono objects of a specific class in the managed heap. Resolves class vtable, then scans writable heap regions for vtable pointer matches. Returns object addresses with class name and estimated size. |
| `memory_mono_fields` | 待补充中文：Read field values from a Mono object at the given address. Resolves the class via vtable pointer, walks MonoClass fields, and decodes each field value with type-aware heuristics (int, float, string pointer detection). |
| `memory_mono_methods` | 待补充中文：Inspect method count for a Mono class in a Unity/Mono process. Full method name enumeration requires walking the MonoMethod table from MonoImage (not yet implemented — returns methodCount from the type definition table). |
| `memory_handle_enum` | 待补充中文：Enumerate all open handles in a target process via NtQuerySystemInformation. Returns handle value, object type, access mask, and object name for each handle. Filterable by type: File, Key, Process, Thread, Token, Section, etc. Useful for finding handles to protected resources and analyzing process security posture. Win32-only, admin required. |
| `memory_protect` | 待补充中文：Change memory page protection for a region in the target process. Wraps VirtualProtectEx (Win32) / mprotect (Linux) / mach_vm_protect (macOS). Protection: r (read-only), rw (read-write), rx (read-execute), rwx (all), none (no-access). Returns the old protection. Destructive — audit trail recorded. |
| `memory_region_compare` | 待补充中文：Compare two memory regions byte-by-byte and return a diff summary. Equivalent to Cheat Engine's compareMemory(). Returns identical flag, diff count, and per-offset differences (byte1, byte2). Max compare size: 64KB. |
| `memory_bookmark` | 待补充中文：Manage address bookmarks for a process. Actions: add (bookmark an address with optional label and color), remove (delete a bookmark), list (show all bookmarks for the PID), clear (remove all bookmarks for the PID). Labels help categorize findings; colors use hex format (e.g. "#FF0000"). Bookmarks are scoped per PID. For long-term persistence, export via state_board_io with namespace "memory_bookmarks:&lt;pid&gt;". |
| `memory_register_type` | 待补充中文：Register a custom value type for memory scanning (Cheat Engine parity). Registered types can be used as valueType in memory_first_scan, memory_unknown_scan, etc. Types are session-scoped (live as long as the domain handler instance). |
| `memory_list_types` | 待补充中文：List all registered custom scan types. |
| `memory_unregister_type` | 待补充中文：Remove a registered custom scan type by name. |
| `memory_call_stack` | 待补充中文：Walk the call stack of a target process thread using the x64 RBP frame-pointer chain. Suspends the thread, reads the CONTEXT to get RBP/RSP/RIP, then follows the linked list of [saved_RBP][return_address] frames via ReadProcessMemory. Resolves module names using Toolhelp32 module snapshots. Returns an array of {frameIndex, returnAddress, moduleName, functionName}. Equivalent to x64dbg's "standard" call stack mode. Win32 (x64) only — requires Administrator privileges. |
| `memory_process_control` | 待补充中文：Suspend or resume a target process for consistent memory snapshots. Suspend freezes all threads (NtSuspendProcess on Win32, SIGSTOP on Linux, task_suspend on macOS) so memory reads/scans see a consistent state. Resume thaws all threads. Useful before memory_dump or memory_first_scan for processes with actively-changing memory. Cross-platform. |
