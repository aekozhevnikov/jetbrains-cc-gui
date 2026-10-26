# 性能修复执行与验证报告

日期：2026-09-28。原计划：`2026-09-28-performance-remediation.md`。

## 交付边界

**结论：T0—T10 代码修复和 T11 自动化/普通浏览器验证已完成，真实 JetBrains/JCEF 实测未完成。**

本次保持桥接协议和依赖不变，不修改版本号或版本记录。用户授权本地提交，所有提交使用英文 Lore 格式；不推送远程。开始时仅原计划未跟踪，没有其他待保留的代码差异。独立模块通过原生子代理实现，主执行者集成、复审并运行整体验证。

以下指标是可重复的合成工作量断言，不是用户真实历史，不是磁盘物理 I/O，也不是 JCEF 帧率、输入延迟或堆剖析结果。**代码与自动化结果不能证明实际卡顿已经完全消失。**

## T0—T10 实现与工作量

| 任务 | 主要文件 | 修复及证据 |
| --- | --- | --- |
| T0 | 各模块现有测试目录及三个新增专属测试文件 | 先运行失败回归，再实现。夹具覆盖 30 次文字增量、200 条稳定消息、1,000 轮历史、1,000 个 Read 条目、长代码和大草稿，不读取用户真实会话。 |
| T1/T2 | `webview/src/hooks/useChatComputations.ts`、`webview/src/components/MessageList.tsx` 及三个测试文件 | 会话限定、不可变结果快照；纯文本保留查询引用，raw 提取用弱引用缓存，旧结果不跨会话保留。修订结果正确更新，分页不丢已加载结果。30 次尾部文字变化不再执行历史 MessageItem 渲染；历史工具签名提取由 31 次降为 1 次。 |
| T3 | `webview/src/hooks/useFileChanges.ts`、`webview/src/utils/sessionFileLedger.ts`、`webview/src/utils/fileTouchRegistry.ts` 及测试 | 分离文件操作语义与文字更新，复用账本与存储结果；30 次文字变化的账本重建 30→0、存储读 90→0、写 30→0。新操作存储读取 3→1；稳定来源去重、注册表变更通知及内存 TTL 维护跨会话语义。 |
| T4 | `ai-bridge/services/codex/codex-event-handler.js`、`codex-session-reader.js` 及测试 | 字节偏移、UTF-8 解码残留、半行、扫描合并和最终补读。30 次未增长更新的正文读取 2,107,650→0 字节。70,046 字节基线加两次共 323 字节追加，总读 70,497 字节，其中 128 字节是两次有界增长校验。 |
| T5 | `webview/src/components/MarkdownBlock.tsx` 及测试 | 未闭合流式代码按 150ms 合并高亮，围栏闭合和结束立即刷新；待高亮时复制仍取最新代码。300 行初始代码加 30 次每隔 5ms 的增量，高亮调用 31→2；最终结束再刷新一次。 |
| T6 | `session/ClaudeMessageHandler.java`、`SessionState.java`、`ClaudeIncrementalMaterializationTest.java` | 约 33ms 合并全文物化，不推迟 delta 通知；结构边界、异常、结束、读快照和会话重置先 flush。30 次同批文字增量的全文物化 30→2。 |
| T7 | `session/StreamMessageCoalescer.java`、`StreamMessageCoalescerStreamEndHookTest.java` | 锁内复用独立传输快照，仅对变化消息复制 raw；缓存随重载、会话重置和销毁清理。200 条历史加 30 个结果，复制消息/raw 捕获次数 6,665→230。 |
| T8 | `handler/history/CodexHistoryPageIndex.java`、`HistoryMessageInjector.java`、`provider/codex/CodexHistoryReader.java`、`CodexHistorySessionService.java` 及测试 | 有界、临时文件支撑的轮次索引，复用转换状态和工具关联；追加增量更新，过时代际不发布。1,000 轮取三页，源记录解析 6,000→2,000；送入源记录解析的字节 623,340→207,780。后两页仍从缓存反序列化目标页，不是完全不解析 JSON。详见 T8 专项报告。 |
| T9 | `webview/src/components/ChatInputBox/hooks/useTextContent.ts` 及测试 | 显式/DOM 版本替代 innerHTML 快照；同步处理尚未投递的 mutation，保留等长替换、标签、换行及选区。约 10 万字符、30 次修改、每次读 4 次，HTML 序列化 120→0；每个内容版本仅提取一次。 |
| T10 | `webview/src/components/toolBlocks/ReadToolGroupBlock.tsx` 及测试 | 固定 28px 行、三行视口及 overscan；1,000 条由全部挂载变为末尾 6 条、中部 9 条，非整行位置最多 10 条。保留底部跟随，中部追加不跳，折叠卸载并恢复位置，键盘可跨虚拟窗口。 |

表内 Java 路径均相对 `src/main/java/com/github/claudecodegui/`，测试位于对应 `src/test/java/` 目录。完整路径可用 `git show --stat` 查看各本地提交。

## 实现取舍

- T7 没有给所有公开可变消息字段引入版本协议，而是锁内比较现有值与独立快照，捕捉嵌套 raw 修改。这避免漏标脏导致错误复用，但仍有 raw 容器比较成本；减少的是复制与分配，不宣称所有遍历归零。
- T8 原有索引管理会话列表元数据，不保存轮次及转换上下文。新增的页索引复用原查找、转换和分页规则，不把前端转换对象写入原有持久化索引。
- T8 每个 injector 最多两个会话，每个最多 200,000 个消息偏移、64 MiB 临时文件；尾部转换状态另有预算检查。这不是 JVM 堆硬上限。超预算删除索引，回退正确的流式全扫描，性能收益不保证。
- T4 增长时比较旧 EOF 前最多 64 字节；T8 使用文件属性及首尾采样。这些不是全文件完整性校验，无法保证识别所有保持采样区域不变的中段改写。
- T1/T3 仍需迭代消息或相关工具输入，Read 条目变化仍需解析输入数组；没有把这些路径包装成 O(1)。

## T11 自动化验证

| 命令 | 最终结果 |
| --- | --- |
| `cd webview && npm test` | 194 个测试文件、1,857 项通过，并通过测试 TypeScript 检查。 |
| `cd webview && ./node_modules/.bin/tsc --noEmit` | 生产 TypeScript 检查通过。 |
| `cd webview && npm run test:e2e -- e2e/chat-input.spec.ts --project=chromium-desktop` | 5 项 Chromium 输入交互测试通过。 |
| `node --test ai-bridge/services/codex/*.test.js` | 59 项通过；包含要求的 event-handler 与新增 session-reader 测试。 |
| `node --check ai-bridge/services/codex/codex-session-reader.js` 和 `node --check ai-bridge/services/codex/codex-event-handler.js` | 语法检查通过。 |
| `./gradlew -I /tmp/ccgui-performance-canonical.init.gradle test checkstyleMain` | 完整生产构建、Checkstyle 通过；1,438 项 Java 测试中 1,424 通过、14 跳过、0 失败。环境说明见下。 |
| `git diff --check` | 通过。 |

仓库没有独立前端/桥接 lint 命令，没有新增 lint 工具或依赖。既有 KaTeX 测试 quirks-mode、构建体积及 Java 弃用提示不是零警告构建，不影响上述成功状态。最终本机日志分别为 `/tmp/perf-webview-final.log`、`/tmp/perf-production-tsc-final.log`、`/tmp/perf-input-e2e.log`、`/tmp/perf-codex-final.log`、`/tmp/perf-gradle-final.log`。

### 已确认的环境限制

原样运行 `./gradlew test checkstyleMain` 时，1,434 项 Java 测试中有 2 项失败、14 项跳过：

- `CodexHistoryReaderSymlinkCwdTest.matchesSessionsRecordedUnderPhysicalCwdWhenQueriedViaSymlink`
- `PathUtilsRealPathTest.resolvesSymlinkedProjectPathToPhysicalPath`

根因是本机 macOS 的 `/var` 与 `/private/var` 临时路径别名参与字符串比较。没有改动或跳过这两个测试。临时 Gradle init 脚本仅将测试 JVM 的 `java.io.tmpdir` 设为相同目录的 canonical path：

```groovy
allprojects {
    tasks.withType(Test).configureEach {
        systemProperty 'java.io.tmpdir', new File(System.getProperty('java.io.tmpdir')).canonicalPath
    }
}
```

使用该脚本第一次重跑完整构建、测试和 Checkstyle，不跳过 webview 构建或桥接打包，1,434 项中 **1,420 通过、14 按原配置跳过、0 失败**。最终坏记录修复又增加四项测试，最后一轮为 **1,438 项、1,424 通过、14 跳过、0 失败**。T8 代理还在任务前提交的源码上确认相同路径失败，仅规范化目录即可通过，未借性能任务修复无关逻辑。构建产生的版本文件、dist、资源副本与打包产物均未纳入提交。

### 独立审查补充修复

- Node 同 inode 重写增长的边界校验，以及首次建立当前轮上下文前原子替换的历史锚点恢复。
- 文件工具归属变化造成的重复计账、双挂载会话/TTL 的标记失效、容量淘汰后被无关文件覆盖的外部触碰标记。
- Java 索引读取中结构异常记录使整页失败：记录转换纳入坏行容错，但取消与索引预算异常仍从消费者向外传播。
- 主执行者补充后到结果修订用例，保证旧结果仍留在历史数组时也以最新结果为准，不混淆其他工具 ID。

以上均先用回归复现，再修复与复审，而不是仅依赖原测试全部通过。

## 普通浏览器验证

使用 Codex 内置浏览器与本地 Vite 服务，临时夹具挂载真实组件。验证结束已删除夹具及原实现对照副本。

- 原始 HEAD 与虚拟化 Read 组在同一视口下对比：容器、三行高度、图标、状态点及相邻代码块位置一致；视觉评价 98/100。证据在本机 `/tmp/ccgui-performance-evidence/`，结构化评价位于被忽略的 `.omx/state/performance-remediation/ralph-progress.json`。
- 1,000 条列表滚动至中部/末尾、追加、折叠恢复、Home 与 Enter 打开目标文件均验证；文件路径为合成 `/synthetic/` 路径，桥接动作由夹具捕获，没有打开或修改用户文件。
- 200 行代码追加后终止流，高亮和中文特殊字符保留；复制 5,823 字符，含最终行。
- 主界面输入长中文多行草稿；自动 E2E 进一步覆盖发送快捷键、多行、组合输入确认及视图切换草稿保留。

```text
改前：三行视口 [997][998][999]，DOM 实际保留全部 1,000 行
改后：三行视口 [997][998][999]，DOM 只保留当前窗口及 overscan
                 外观不变；键盘能跨窗口继续定位
```

## 未验证场景与剩余风险

1. **没有真实 JetBrains/JCEF 性能录制**：React 提交耗时、长任务、冷/热启动、持续运行堆保留、真实滚动/选择、原生中文输入法、权限等待/恢复等端到端性能仍需实测。
2. 首次建立 Codex 页索引增加临时写盘；这里的记录数下降不能证明首次打开更快。超预算历史会退回原流式扫描。
3. 临时文件在正常淘汰、会话切换及项目销毁时删除；进程异常退出可能留下 OS 临时文件。未验证 Windows 文件标识/时间戳退化情形。
4. 代码围栏内显示最多合并约 150ms；最终内容和复制不等待这个窗口。普通文本沿用现有节奏。
5. 仅自动化测试不能证明所有并发调度安全，尤其是实际 IDE 的会话切换、权限交互与后台页生命周期；测试覆盖的边界以提交内用例为准。

## 回退边界

工具索引、输入缓存、代码高亮、Read 虚拟列表、Node 增量回放、文件账本、Java 物化/快照与 Codex 分页分别形成独立提交。可针对对应提交回退；T1/T2 合并为一个实现单元，T6/T7 共享状态与锁，需要作为一组看待。不要整体恢复工作区来回退一个模块。

| 提交 | 范围 |
| --- | --- |
| `1f039e2f` | T1/T2 稳定查询、会话生命周期及 MessageList 签名复用 |
| `7ef2a680` | T9 输入文本版本缓存 |
| `2173b34b` | T5 流式代码高亮合并 |
| `5b0075b5` | T10 Read 工具组虚拟化 |
| `9db2dc1b` | T4 Codex 增量回放及替换边界 |
| `ec4db1a8` | T6/T7 Java 物化和快照复用 |
| `d6bf6039` | T3 文件账本与事件/TTL 驱动的存储标记 |
| `f8d25959` | T1 后到工具结果修订，和 T1/T2 主提交共同回退 |
| `dc61a387` | T8 Codex 有界分页索引及坏记录容错 |

另有文档收尾提交。所有提交保留在原 `feature/v0.5.8` 分支，没有推送、合并或发布。
