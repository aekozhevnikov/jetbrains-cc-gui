package com.github.claudecodegui.startup;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Safety-net install of the CEF-level paste hook for the project's main window.
 *
 * Why: on macOS 27+, when the JCEF webview (OSR mode) has focus, the Cmd+V
 * KEYEVENT_RAWKEYDOWN is swallowed by the OS before reaching CEF; only an
 * orphaned KEYEVENT_KEYUP arrives. IDE-level actions and AWT listeners never
 * see the event either. CefPasteHook attaches to the CefClient keyboard
 * handler chain (the same native path the webview receives events through)
 * and detects the orphaned Cmd+V KEYUP to paste clipboard images.
 *
 * The primary install path is ClaudeChatWindow.replaceBrowser, which covers
 * every tab and browser recreation; this activity only backstops the first
 * window of a project opened before that path ran.
 */
public class PasteKeyInitializer implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(PasteKeyInitializer.class);

    @Nullable
    @Override
    public Object execute(@Nullable Project project, @NotNull Continuation<? super Unit> continuation) {
        try {
            // Delay to let toolwindow + browser initialize
            com.intellij.util.concurrency.AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> {
                try {
                    ClaudeChatWindow window = ClaudeSDKToolWindow.getChatWindow(project);
                    CefPasteHook.installForWindow(window);
                } catch (Throwable t) {
                    LOG.warn("[paste-fix] deferred CEF install failed", t);
                }
            }, 15, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Throwable t) {
            LOG.warn("[paste-fix] PasteKeyInitializer failed", t);
        }
        return Unit.INSTANCE;
    }
}
