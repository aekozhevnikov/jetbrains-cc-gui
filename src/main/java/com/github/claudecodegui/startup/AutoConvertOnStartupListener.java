package com.github.claudecodegui.startup;

import com.github.claudecodegui.handler.history.HistoryAutoConvertService;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.StartupActivity;
import com.intellij.openapi.startup.StartupManager;
import com.intellij.openapi.diagnostic.Logger;

import org.jetbrains.annotations.NotNull;

import java.nio.file.Paths;
import java.util.Set;

/**
 * Converts SDK-created Claude sessions to CLI-recognizable ones when a project opens,
 * BEFORE any chat tabs are restored and their SDK daemons start appending to the files.
 *
 * <p>This runs as a {@link StartupActivity} so it executes during project startup,
 * before tool windows (and their tab restoration) are created. This ensures the
 * session the user was working in when they quit gets converted — the exit hook
 * skipped it because the daemon was still running, but on startup the daemon
 * hasn't started yet.
 */
public class AutoConvertOnStartupListener implements StartupActivity {

    private static final Logger LOG = Logger.getInstance(AutoConvertOnStartupListener.class);

    @Override
    public void runActivity(@NotNull Project project) {
        if (!isAutoConvertEnabled()) {
            return;
        }

        // Run on a background thread so we don't block project startup UI
        // runWhenProjectIsInitialized is deprecated but remains the standard API for this use case
        Runnable runner = () -> runConversion(project);
        StartupManager.getInstance(project).runWhenProjectIsInitialized(runner);
    }

    /**
     * Read the opt-in flag defensively: a broken config must not break startup.
     */
    private boolean isAutoConvertEnabled() {
        try {
            return new CodemossSettingsService().getAutoConvertSessionsOnExit();
        } catch (Exception e) {
            LOG.warn("[AutoConvertOnStartup] Cannot read the auto-convert setting: " + e.getMessage());
            return false;
        }
    }

    private void runConversion(Project project) {
        try {
            new HistoryAutoConvertService(
                    () -> Paths.get(com.github.claudecodegui.bridge.NodeDetector.resolveHomeForFileOps(), ".claude", "projects"),
                    () -> resolveProjectDirForConversion(project),
                    Set::of // No active sessions yet — tabs not restored
            ).convertAllProjects();
        } catch (Exception e) {
            LOG.warn("[AutoConvertOnStartup] Auto conversion failed: " + e.getMessage());
        }
    }

    /**
     * Resolves the project directory for conversion.
     * Mirrors the WSL path resolution logic used by the batch converter.
     */
    private Set<String> resolveProjectDirForConversion(Project project) {
        String basePath = project.getBasePath();
        if (basePath == null) {
            return Set.of();
        }
        // Use effective working directory like the batch converter does
        String effectivePath = new CodemossSettingsService()
                .getEffectiveWorkingDirectory(basePath);
        // Resolve WSL path if needed
        String nodePath = com.github.claudecodegui.bridge.NodeDetector.getInstance().getCachedNodePath();
        String resolved = com.github.claudecodegui.bridge.NodeDetector.isWslPath(nodePath)
                ? com.github.claudecodegui.bridge.NodeDetector.convertToWslPath(effectivePath)
                : effectivePath;
        return Set.of(com.github.claudecodegui.util.PathUtils.sanitizePath(
                com.github.claudecodegui.util.PathUtils.realPath(resolved)));
    }
}
