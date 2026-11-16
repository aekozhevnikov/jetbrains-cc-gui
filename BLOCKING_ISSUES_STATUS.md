# PR #2056 Blocking Issues Status

## Summary
After implementing fixes and pushing to `fix-env-file-v2` branch, here's the status of all blocking issues from the maintainer's review.

---

## ✅ BLOCKING ISSUES ADDRESSED (2/7)

### 1. strictMcpConfig: true
**Status: DONE**
- Added `strictMcpConfig: true` to both query-option builders:
  - `ai-bridge/services/claude/persistent-query-service.js:157`
  - `ai-bridge/services/claude/message-sender.js:100`

### 7. Env files can override provider executables (CLAUDE_CODE_PATH, GROK_CLI_PATH)
**Status: DONE**
- Added to `ENV_FILE_DENYLIST_EXTRA` in `ai-bridge/config/api-config.js:234`
- Variables: `PATH`, `CLAUDE_CODE_PATH`, `GROK_CLI_PATH`

---

## ❌ BLOCKING ISSUES NOT ADDRESSED (5/7)

### 2. Node runtime gate doesn't enforce approval fingerprint
**Status: NOT DONE**
- **Location needed**: `ai-bridge/services/claude/mcp-status/config-loader.js`
- **Required**: Check `enabledMcpjsonServerFingerprints` from settings.local.json before loading project .mcp.json servers
- **Impact**: Changed project .mcp.json servers (e.g., approve `old.js` → change to `changed.js`) still load without re-approval

### 3. Java and Node use different trust rules for settings.local.json
**Status: NOT DONE**
- **Java** (`McpServerManager.java:933-950`): Accepts untracked file even when NOT git-ignored
- **Node** (`config-loader.js:372-394`): Requires both untracked AND git-ignored
- **Impact**: UI shows "approved" but Node keeps server pending, or vice versa
- **Fix needed**: Unify trust predicate in both Java and Node

### 4. Persistent runtimes retain old env/MCP configuration
**Status: NOT DONE**
- **Location**: `ai-bridge/services/claude/runtime-lifecycle.js:167-192` (`buildRuntimeSignature`)
- **Missing from signature**: `env`, `mcpServers`, `additionalDirectories` (for MCP)
- **Impact**: Changing `.env`, approving/rejecting servers doesn't rebuild runtime
- **Fix needed**: Add stable launch-config fingerprints to `buildRuntimeSignature`

### 5. Deleting colliding global server deletes project entry
**Status: PARTIALLY DONE**
- **Frontend** (`useServerActions.ts:161`): Now sends `scope` parameter
- **Backend** (`McpServerManager.java`): Needs to use scope to delete from correct config
- **Current**: Java's `deleteMcpServer` tries `.mcp.json` first (line 484-494)
- **Fix needed**: Java must respect scope parameter

### 6. ~/.claude.json safeguards regressed
**Status: DONE (verified)**
- `SafeJsonFileOps` still used with locking/atomic mutations
- No fallback to legacy `~/.codemoss/config.json` when `~/.claude.json` exists
- Primary store remains authoritative

---

## ⚠️ ADDITIONAL EDGE CASES STATUS (12)

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | BOM handling in envLoader | ✅ DONE | `stripInlineComments` + BOM strip |
| 2 | Grok auth before env file | ✅ DONE | Already fixed in `message-service.js:78-95` |
| 3 | Per-process Claude attachment drops envFile | ✅ DONE | Already fixed in `message-sender.js:525-530, 626-631` |
| 4 | parseMcpConfig returns before project .mcp.json loading | ❌ NOT DONE | Returns null when `~/.claude.json` absent, doesn't check standalone `.mcp.json` |
| 5 | Save-time validation only checks existence | ❌ PARTIAL | Validates structure but not file paths/allowlist |
| 6 | Inline dotenv comments | ✅ DONE | `stripInlineComments` in `envLoader.js` |
| 7 | Editing server from secret-stripped cache erases env/headers | ⚠️ VERIFY | Architecture uses live state, but need to verify |
| 8 | Inline arguments like `--api-key=SECRET` survive copy-config | ✅ DONE | `redactArgs` handles `--key=value` format |
| 9 | Oversized daemon requests dropped without response | ✅ DONE | `MAX_REQUEST_LINE_LENGTH` (16MB) + NDJSON error |
| 10 | Fingerprint should include cwd/headers | ❌ NOT DONE | Related to blocking issue #2 |
| 11 | Unified trust predicate | ❌ NOT DONE | Related to blocking issue #3 |
| 12 | Runtime signature should include env/MCP config | ❌ NOT DONE | Related to blocking issue #4 |

---

## 🎯 PRIORITY ORDER FOR REMAINING WORK

### Critical (must fix before merge):
1. **Blocking #2**: Fingerprint enforcement in `config-loader.js`
2. **Blocking #3**: Unified trust predicate (Java + Node)
3. **Blocking #4**: Runtime signature with env/MCP config
4. **Blocking #5**: Java scope-aware delete

### High Priority:
5. **Edge #4**: parseMcpConfig standalone `.mcp.json` loading
6. **Edge #5**: Save-time file path validation
7. **Edge #7**: Verify secret-stripped cache doesn't affect edits

### Medium Priority:
8. **Edge #10/11**: Fingerprint + trust predicate (part of blocking #2/3)
9. **Edge #12**: Runtime signature env/MCP (part of blocking #4)

---

## 📝 NOTES

The branch `fix-env-file-v2` has been pushed and is up to date with `upstream/feature/v0.6.5`. All tests pass:
- 63 envLoader unit tests
- 34 envLoader integration tests
- 12 useServerActions tests
- 3 useToolsUpdate tests
- 9 regression tests (new)

The remaining work requires changes to:
- `ai-bridge/services/claude/mcp-status/config-loader.js` (fingerprint, trust rules, standalone .mcp.json)
- `ai-bridge/services/claude/runtime-lifecycle.js` (runtime signature)
- `src/main/java/com/github/claudecodegui/settings/McpServerManager.java` (scope-aware delete)