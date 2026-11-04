package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import java.util.stream.Stream;

/**
 * Service to convert SDK-created sessions to CLI-recognizable sessions.
 * Changes entrypoint from "sdk-cli" to "cli" so sessions appear in CLI's /resume list.
 *
 * @author Gadfly
 */
public class SessionConversionService {

    private static final Logger LOG = Logger.getInstance(SessionConversionService.class);

    private final HandlerContext context;
    private final SessionConversionCore conversionCore = new SessionConversionCore();
    private final Gson gson = new GsonBuilder().disableHtmlEscaping().create();

    /**
     * Resolves the {@code ~/.claude/projects} base per call. Injected rather than hardcoded
     * so the batch converter tests can point the file rewrite at a temporary directory
     * instead of the developer's real session history.
     */
    private final Supplier<Path> projectsDirSupplier;

    private static final String ENTRYPOINT_CLI = SessionEntrypoint.CLI.getValue();

    public SessionConversionService(HandlerContext context) {
        this(context, () -> Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude", "projects"));
    }

    /**
     * @param context handler context, may be null in tests that only exercise pure logic.
     * @param projectsDirSupplier resolves the projects root per call.
     */
    public SessionConversionService(HandlerContext context, Supplier<Path> projectsDirSupplier) {
        this.context = context;
        this.projectsDirSupplier = projectsDirSupplier;
    }

    /**
     * Resolve {@code ~/.claude/projects} at call time. A static field would snapshot the
     * Windows home at class-load, but a WSL node stores sessions under the WSL filesystem;
     * {@link NodeDetector#resolveHomeForFileOps()} returns the correct home for the active
     * node. Every other history service in this package was migrated the same way.
     */
    private Path projectsDir() {
        return this.projectsDirSupplier.get();
    }

    /**
     * Convert the IDE project base path to the form Claude CLI used when it created the
     * session directory. A WSL node keys projects by their Linux path, so the host
     * {@code D:\proj} must become {@code /mnt/d/proj} before sanitizing; a native node
     * keeps the path as-is. Mirrors {@code HistoryDeleteService}.
     */
    public static String resolveProjectPathForFileOps(String rawProjectPath) {
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        return NodeDetector.isWslPath(nodePath)
                ? NodeDetector.convertToWslPath(rawProjectPath)
                : rawProjectPath;
    }

    /**
     * Convert a non-CLI session to CLI-recognizable session.
     * Changes entrypoint from "sdk-cli" or "claude-vscode" to "cli" in the session file.
     * Uses atomic write with temporary file to ensure file integrity.
     *
     * @param sessionId Session ID to convert.
     * @param projectPath Project path (optional, will scan all projects if null).
     */
    void convertSdkSession(String sessionId, String projectPath) {
        if (!HistoryDeleteService.isValidSessionId(sessionId)) {
            LOG.warn("[SessionConversionService] Conversion rejected: invalid sessionId");
            this.sendConversionResult(false, ConversionResultCode.INVALID_SESSION_ID);
            return;
        }

        // Refuse to convert the session this window is still chatting in: the SDK
        // process keeps appending to the jsonl, and replacing the file underneath
        // it would silently drop those messages onto the old inode.
        if (this.isSessionActive(sessionId)) {
            LOG.warn("[SessionConversionService] Conversion rejected: session is active");
            this.sendConversionResult(false, ConversionResultCode.SESSION_ACTIVE);
            return;
        }

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            ConversionResultCode resultCode = this.convertSession(sessionId, projectPath);
            this.sendConversionResult(resultCode == null, resultCode);
        });
    }

    /**
     * Convert one session's jsonl on the calling thread and report the outcome as a code.
     *
     * <p>This is the shared core behind both the single-session bridge command and the
     * batch command: it owns the lock/backup/atomic-move dance and returns instead of
     * pushing to the webview, so a caller can aggregate many outcomes into one reply.
     *
     * @param sessionId Session ID to convert (assumed already validated and non-active).
     * @param projectPath Project path hint, or null to scan every project directory.
     * @return null when the session was rewritten, otherwise the failure/notice code.
     */
    ConversionResultCode convertSession(String sessionId, String projectPath) {
        Path sessionFile;
        try {
            sessionFile = this.findSessionFile(sessionId, projectPath);
            if (sessionFile == null) {
                LOG.warn("[SessionConversionService] Session file not found: " + sessionId);
                return ConversionResultCode.SESSION_NOT_FOUND;
            }

            // The finder only returns existing files; this catches a narrow TOCTOU
            // window where another process deletes the file after discovery.
            if (!Files.exists(sessionFile)) {
                LOG.warn("[SessionConversionService] Session file does not exist: " + sessionFile);
                return ConversionResultCode.FILE_NOT_EXIST;
            }

            // Use shared conversion core with file lock (single-session path needs locking)
            var activeIdsSupplier = (java.util.function.Supplier<java.util.Set<String>>) this::activeSessionIds;
            var outcome = conversionCore.convertSessionFileWithLock(sessionFile, activeIdsSupplier);
            if (outcome.resultCode() != null) {
                return outcome.resultCode();
            }
            if (!outcome.converted()) {
                return ConversionResultCode.CONVERSION_FAILED;
            }
            return null;

        } catch (Exception e) {
            LOG.warn("[SessionConversionService] Failed to convert session: " + e.getMessage(), e);
            return ConversionResultCode.CONVERSION_FAILED;
        }
    }

    /**
     * Convert the top-level entrypoint field in one JSONL row.
     *
     * @param line JSONL row to parse.
     * @param hasCliEntrypoint whether any row already identified itself as CLI.
     * @param modifiedCount number of rows modified so far.
     * @return original or converted JSON row.
     */
    // Package-private so SessionConversionServiceTest can exercise the per-row rewrite directly.
    String convertEntrypointInLine(
            String line,
            AtomicBoolean hasCliEntrypoint,
            AtomicInteger modifiedCount
    ) {
        JsonObject row;
        try {
            row = conversionCore.parseRow(line);
        } catch (JsonSyntaxException e) {
            LOG.warn("[SessionConversionService] Keeping non-JSON session row unchanged");
            return line;
        }

        if (row == null || !row.has("entrypoint") || row.get("entrypoint").isJsonNull()
                || !row.get("entrypoint").isJsonPrimitive()) {
            return line;
        }

        String entrypoint = row.get("entrypoint").getAsString();
        SessionEntrypoint parsedEntrypoint = SessionEntrypoint.fromValue(entrypoint);
        if (parsedEntrypoint == SessionEntrypoint.CLI) {
            hasCliEntrypoint.set(true);
            return line;
        }

        if (!parsedEntrypoint.isConvertibleToCli()) {
            return line;
        }

        row.addProperty("entrypoint", ENTRYPOINT_CLI);
        modifiedCount.incrementAndGet();
        return conversionCore.convertLine(line);
    }

    /**
     * Check whether the given session is active in any chat window of this project.
     * Every tab and every detached window owns an independent SDK bridge that appends
     * to its own session's jsonl, so "active" is the union over all of them — checking
     * only this window's session would let a conversion replace the file another tab
     * is streaming into.
     *
     * @param sessionId Session ID to check.
     * @return true if the session is active and must not be converted.
     */
    private boolean isSessionActive(String sessionId) {
        return this.activeSessionIds().contains(sessionId);
    }

    /**
     * Ids of all sessions currently open in this project's chat windows, including this
     * window's own session. Read at call time — the set changes as the user switches
     * chats, so it must never be cached.
     *
     * @return active session ids, never null.
     */
    // VisibleForTesting
    Set<String> activeSessionIds() {
        Set<String> ids = new HashSet<>();
        String ownSessionId = this.activeSessionId();
        if (ownSessionId != null) {
            ids.add(ownSessionId);
        }
        try {
            Project project = this.context != null ? this.context.getProject() : null;
            if (project != null && !project.isDisposed()) {
                ids.addAll(ClaudeSDKToolWindow.getActiveSessionIdsForProject(project));
            }
        } catch (Exception e) {
            LOG.warn("[SessionConversionService] Failed to resolve other windows' sessions: " + e.getMessage());
        }
        return ids;
    }

    /**
     * Id of the session this window is currently chatting in, or null when there is none.
     * Read from the handler context at call time — the session changes as the user switches
     * chats, so it must never be cached.
     *
     * @return active session id, or null.
     */
    String activeSessionId() {
        try {
            var session = this.context.getSession();
            return session != null ? session.getSessionId() : null;
        } catch (Exception e) {
            LOG.warn("[SessionConversionService] Failed to resolve active session: " + e.getMessage());
            return null;
        }
    }

    /**
     * Release the file lock and close the channel, tolerating repeat calls.
     *
     * @param fileLock Lock to release, may be null or already released.
     * @param fileChannel Channel to close, may be null or already closed.
     */
    private static void releaseFileLock(FileLock fileLock, FileChannel fileChannel) {
        try {
            if (fileLock != null && fileLock.isValid()) {
                fileLock.release();
            }
            if (fileChannel != null && fileChannel.isOpen()) {
                fileChannel.close();
            }
        } catch (IOException lockError) {
            LOG.warn("[SessionConversionService] Failed to release file lock: " + lockError.getMessage());
        }
    }

    /**
     * Find session file by sessionId.
     *
     * @param sessionId Session ID.
     * @param projectPath Project path (optional).
     * @return Session file path, or null if not found.
     */
    private Path findSessionFile(String sessionId, String projectPath) {
        try {
            Path projectsDir = projectsDir();
            if (projectPath != null && !projectPath.isEmpty()) {
                Path projectDir = this.getProjectDir(projectsDir, resolveProjectPathForFileOps(projectPath));
                Path sessionFile = projectDir.resolve(sessionId + ".jsonl");
                if (Files.exists(sessionFile)) {
                    return sessionFile;
                }
            }

            // Scan all project directories
            if (!Files.exists(projectsDir)) {
                return null;
            }

            LOG.debug("[SessionConversionService] Scanning project directories for session: " + sessionId);
            try (var stream = Files.newDirectoryStream(projectsDir)) {
                for (Path projectDir : stream) {
                    if (!Files.isDirectory(projectDir)) {
                        continue;
                    }
                    Path sessionFile = projectDir.resolve(sessionId + ".jsonl");
                    if (Files.exists(sessionFile)) {
                        return sessionFile;
                    }
                }
                return null;
            }
        } catch (Exception e) {
            LOG.error("[SessionConversionService] Error finding session file: " + e.getMessage(), e);
            return null;
        }
    }

    /**
     * Get project directory path.
     *
     * @param projectsDir Resolved {@code ~/.claude/projects} base.
     * @param projectPath Project path.
     * @return Project directory path.
     */
    private Path getProjectDir(Path projectsDir, String projectPath) {
        // Resolve symlinks first: the CLI stores sessions under the physical path's key (issue #1789)
        String sanitized = PathUtils.sanitizePath(PathUtils.realPath(projectPath));
        return projectsDir.resolve(sanitized);
    }

    /**
     * Send conversion result to frontend via the safe HandlerContext helper.
     * On failure the code is sent as errorCode; on success it is sent as
     * infoCode (extra context such as ALREADY_CLI_SESSION), keeping the two
     * semantics apart for the frontend.
     *
     * @param success Whether conversion was successful.
     * @param code Result code, or null for a plain success.
     */
    private void sendConversionResult(boolean success, ConversionResultCode code) {
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        if (code != null) {
            result.addProperty(success ? "infoCode" : "errorCode", code.getCode());
        }

        Project project = this.context.getProject();
        if (project != null && !project.isDisposed()) {
            // escapeJs() runs on the serialized JSON, which is the right order here:
            // it escapes the payload for a JS string literal AFTER the JSON quotes are
            // in place. Every character it rewrites is a valid JSON escape too, so the
            // JS parser reverses it and the frontend still receives the exact JSON text.
            String escapedJson = this.context.escapeJs(this.gson.toJson(result));
            String jsCode = "if (window.onConversionResult) { window.onConversionResult('" + escapedJson + "'); }";
            this.context.executeJavaScriptQueued(jsCode);
        }
    }
}
