# T8 / T0 Codex 历史分页执行报告

日期：2026-09-28。范围：T8，以及 T0 中 Codex 历史分页的合成基线；不代表整个 T0 或性能修复总计划已完成。

## 实现与修改文件

| 文件 | 修改内容 |
| --- | --- |
| `src/main/java/com/github/claudecodegui/handler/history/CodexHistoryPageIndex.java` | 新增有界、文件支撑的轮次索引。保存消息偏移与轮次边界；已转换消息写入临时文件，后续只反序列化所选页。支持追加更新、文件身份检查、LRU、取消与清理。 |
| `src/main/java/com/github/claudecodegui/handler/history/HistoryMessageInjector.java` | 初次加载和向上翻页复用同一个索引。复用现有转换 accumulator，保存尾部去重上下文，延迟 usage 可更新已落盘的 assistant。发布、错误与完成通知检查请求代际；切换会话和项目销毁清理索引。 |
| `src/main/java/com/github/claudecodegui/provider/codex/CodexHistorySessionService.java` | 新增按字节区间读取，8 KiB 分块，记录之间检查取消；不吞掉消费者的取消/索引失败。继续支持一行多个 JSON、UTF-8 和坏行跳过。 |
| `src/main/java/com/github/claudecodegui/provider/codex/CodexHistoryReader.java` | 暴露内部 Java 路径解析和增量区间迭代入口；原有公开桥接负载不变。 |
| `src/test/java/com/github/claudecodegui/handler/history/CodexHistoryPageIndexTest.java` | 新增 15 项真实临时 JSONL 回归，使用纯合成数据，不读取用户历史。 |
| `src/test/java/com/github/claudecodegui/handler/history/HistoryMessageInjectorTest.java` | 增加过时代际不得发布消息/完成动作的验证。 |

没有改动 `session`、Claude 实现、`StreamMessageCoalescer`、前端或其他执行者文件；没有新增依赖、提交、分支或版本记录。

现有 `CodexHistoryIndexService` 是会话列表元数据索引，不保存轮次或转换上下文，因此未把前端转换对象塞入其持久化结构。新增页索引复用现有历史查找、解析、转换与分页语义；原元数据索引测试继续运行。

## T0：前后工作量

固定夹具：1,000 个用户轮次，每轮一个用户记录和一个 assistant 记录；2,000 条原始记录、207,780 字节。依次取最新 30 轮、`beforeTurn=970`、`beforeTurn=940`。

| 工作 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 第一页解析原始记录 | 2,000 | 2,000 |
| 第二页解析原始记录 | 2,000 | 0 |
| 第三页解析原始记录 | 2,000 | 0 |
| 三页合计解析原始记录 | 6,000 | 2,000 |
| 送入原始 JSON 解析器的会话字节，三页合计 | 623,340 | 207,780 |
| 两条已有记录后追加两条，更新页解析记录 | 4 | 2 |

修改后每个早期页仍需从临时文件反序列化该页的 60 条已转换消息；不是“完全不解析 JSON”。第一遍新增了转换结果写盘成本，不能仅由记录数推导首次打开耗时改善。

字节指标来自读取区间，不是物理磁盘 I/O 测量：不计文件元数据、临时文件 I/O、文件系统缓存及保护性采样。建索引时读取最多 8 KiB 首尾采样；追加检查和更新采样分别最多 8 KiB；无变化的缓存命中不重新扫描源内容。路径解析仍使用原有会话文件查找。

## 先失败、再实现的证据

1. 实现前，新增连续翻页和追加回归均失败：后两页合计原始记录解析仍为 4,000，追加读取仍为 4。
2. 第一版实现后，新增超大 pending 消息回归失败：仅一个尾消息时能绕过落盘配额。
3. 增加尾部转换状态配额后，相关测试转绿。

红灯日志：`/tmp/codex-t8-red.log`、`/tmp/codex-t8-boundaries.log`。它们是本机执行证据，不是仓库依赖。

## 行为与缓存约束

- 保持 `totalTurns`、`fromTurn`、`toTurn`、页大小和 `cursorReset` 语义；`beforeTurn=0` 返回空页，超界游标返回最新页。
- 跨页、跨追加的工具调用与结果保留 `call_id` / `tool_use_id`；工具结果不新增用户轮次。没有替换现有工具转换规则。
- 追加保留待发消息及最新 assistant 上下文，覆盖 event/response 用户重复记录与延迟 token usage；返回消息独立于缓存，调用者修改不会污染后续页。
- 新文件身份、截断、等长修改会重建；Unix 上额外检查 ctime，测试覆盖保留 mtime 的同 inode 改写及文件替换。
- 未换行的尾记录在后续追加时保守重建，以避免半条 JSON 或完整但无换行记录产生重复/丢失。
- 索引过程中源文件变化会放弃结果并清理，提示重试，不发布混合快照；请求代际变化会中断扫描并删除部分索引。
- 每个 injector 最多保留 2 个会话，每个最多 200,000 个已落盘消息偏移、64 MiB 临时文件；保留的尾部转换状态也受配额检查。超过预算使用不缓存的流式分页，不丢历史。
- 缓存命中只还原目标页，不缓存整段 JSON 对象树。5 分钟闲置条目在下一次访问时清理；LRU 淘汰、会话切换、项目销毁及显式关闭会关闭并删除临时文件。

## 局部验证

```bash
./gradlew test \
  --tests '*CodexHistoryPageIndexTest' \
  --tests '*HistoryMessageInjectorTest' \
  --tests '*CodexHistoryIndexServiceTest' \
  --tests '*CodexHistoryReaderRefactorTest' \
  --tests '*CodexSDKBridgeHistoryTest' \
  checkstyleMain -x buildWebview --console=plain
```

已通过的局部组合：71 项测试（15 + 34 + 4 + 10 + 8），零失败；`compileJava`、`compileTestJava`、`checkstyleMain` 通过。最终复跑日志为 `/tmp/codex-t8-final.log`。`git diff --check` 用于补充补丁静态检查。

覆盖：稳定页复用、追加、截断、替换、保留 mtime 改写、半条 JSON、Unicode、单行多 JSON、坏行、空页、错误游标、跨记录工具结果、延迟 usage、尾部用户去重、页面对象隔离、扫描取消、文件修改中断、LRU/关闭清理、消息/磁盘/尾部对象预算及请求发布代际。

额外验证出现的失败，未隐藏或顺带修改：

- 初次未跳过 `buildWebview` 的命令被并行工作区前端类型错误阻断：`useTextContent.ts` 的 nullable ref、`useChatComputations.ts` 的 `string | undefined`。本执行者未修改这些文件；最终 Java 验证明确跳过 webview 构建，不宣称前端类型检查通过。
- 扩大的 `*CodexHistoryReader*Test` 组合为 69 项、1 项失败：`CodexHistoryReaderSymlinkCwdTest.matchesSessionsRecordedUnderPhysicalCwdWhenQueriedViaSymlink`，第 88 行期望 1 个会话、实际 0。此用例走未修改的会话列表筛选路径，未在本任务定位根因或修复；不能据此宣称全仓测试通过。日志：`/tmp/codex-t8-validation.log`。

## 剩余风险与交接

1. 未做真实 JetBrains/JCEF 录制、首开耗时或堆剖析，不能声称实际卡顿已完全解决。
2. 超出预算的超大历史会回退全量流式扫描；这种情况下保正确性和有界驻留，不保证翻页解析量下降。回退前可能已完成部分索引工作，存在额外初扫成本。
3. 追加判定依赖文件身份、属性及旧内容首尾采样。它不是全文件哈希：同 inode 在旧内容中段改写、保留两端并同时增长的非追加式写入，可能被视作追加。正常追加、独立文件替换、截断和等长改写已有覆盖；其他写入协议需要另行约定或更强校验。
4. 未验证 Windows 文件身份/时间戳退化情形。在缺少 Unix ctime 的文件系统，故意保留所有可见属性的原地等长改写不能保证识别。
5. 临时文件在正常生命周期内清理；进程异常终止可能留下 OS 临时目录中的文件。没有引入跨启动持久化缓存。
6. 持续写入导致读取期间属性变化时，当前策略是失败并提示重试，而不是自动无限重试。
7. Java 阶段验证通过不等于 JCEF 异步桥接的端到端会话切换验证；本次覆盖扫描取消及生产发布闸门，真实 GUI 行为仍需主执行者整体验证。

回退边界：一起回退上表六个 Java/测试文件的本任务差异即可；不涉及会话列表索引格式、公开桥接协议、依赖或用户历史源文件迁移。请不要整体还原并行工作区的其他文件。

## Review P2 修复：坏记录转换异常（2026-09-28）

复现：正常 user 与 assistant 之间插入 `payload.type=null`、`payload.type={}` 或 `function_call.name=null`，旧流式扫描保留两条正常消息，新索引却因转换阶段的 `UnsupportedOperationException` 使整页失败。

最小修复：只把 `transformFunctionCall(message)` 移入 `parseLine` 现有解析容错块；`consumer.accept(message)` 仍在 try/catch 外，避免吞掉取消、索引配额等消费者异常。没有扩大捕获到索引转换和消费者发布链，也没有修改缓存预算或回退策略。

新增四项测试：三类坏记录分别验证相邻正常消息和再次命中缓存的结果；另直接验证消费者抛出的 `CancellationException` 原对象向外传播。

- 红灯：19 项索引测试中三项新增坏记录用例失败，其余 16 项通过。日志：`/tmp/ccgui-t8-review-red.log`。
- 绿灯：五个局部测试类合计 **75 项、零失败、零跳过**（19 + 34 + 4 + 10 + 8）；取消中断、消息预算、磁盘预算及超大 pending 回退保持通过；`checkstyleMain`、Java 编译及补丁检查通过。日志：`/tmp/ccgui-t8-review-green.log`。
- 使用独立 `/tmp/ccgui-t8-review-build` 和 `/tmp/ccgui-t8-review-project-cache`，没有覆盖主工作区构建产物；Gradle 已退出。未 commit。

```bash
./gradlew -I /tmp/ccgui-t8-review.init.gradle \
  --project-cache-dir /tmp/ccgui-t8-review-project-cache \
  test --tests '*CodexHistoryPageIndexTest' \
  --tests '*HistoryMessageInjectorTest' \
  --tests '*CodexHistoryIndexServiceTest' \
  --tests '*CodexHistoryReaderRefactorTest' \
  --tests '*CodexSDKBridgeHistoryTest' \
  checkstyleMain -x buildWebview --console=plain
```

基线结论补充：先前的符号链接失败已通过任务前提交 `ed3986526c6d5c48e848ea7a5024be8032d37efe` 的相关类和原测试重新编译确认。默认 `/var/folders/...` tmpdir 时同样在第 88 行失败，仅规范化为 `/private/var/folders/...` 后通过；属于既有路径相关失败，不是 T8 新引入。复现脚本：`/tmp/ccgui-t8-baseline.Co00A3/reproduce.sh`。不在此任务修复该无关逻辑；主代理继续负责 canonical tmpdir 下的全仓构建验证。
