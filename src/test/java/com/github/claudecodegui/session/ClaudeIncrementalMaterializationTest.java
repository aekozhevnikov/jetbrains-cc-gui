package com.github.claudecodegui.session;

import com.google.gson.Gson;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;

import static org.junit.Assert.assertTrue;

import static org.junit.Assert.assertEquals;

public class ClaudeIncrementalMaterializationTest {
    private Application previousApplication;

    @Before
    public void stubNotificationDispatch() {
        previousApplication = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, arguments) -> {
                    if (method.getReturnType() == boolean.class) {
                        return false;
                    }
                    return null;
                });
        ApplicationManager.setApplication(application);
    }

    @After
    public void restoreApplication() {
        ApplicationManager.setApplication(previousApplication);
    }

    @Test
    public void thirtyDeltasMaterializeOnlyAtCaptureBoundary() {
        SessionState state = new SessionState();
        ClaudeMessageHandler handler = new ClaudeMessageHandler(null, state, new CallbackHandler(),
                new MessageParser(), new MessageMerger(), new Gson());
        handler.onMessage("stream_start", "");
        synchronized (state.getMessageStateLock()) {
            handler.onMessage("content_delta", "a");
            ClaudeSession.Message live = state.getMessagesReference().get(0);
            int materializations = 1;
            String previousContent = live.content;
            for (int index = 1; index < 30; index++) {
                handler.onMessage("content_delta", "a");
                if (previousContent != live.content) {
                    materializations++;
                    previousContent = live.content;
                }
            }
            assertEquals(1, materializations);
            assertEquals("Only the first delta should materialize before the batch flush", "a", live.content);
            ClaudeSession.Message snapshot = state.getMessagesSnapshot().get(0);
            assertEquals("a".repeat(30), snapshot.content);
            assertEquals(snapshot.content, snapshot.raw.getAsJsonObject("message")
                    .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
        }
        handler.onMessage("stream_end", "");
    }

    @Test
    public void thinkingBatchesPreserveTransitionsToolBoundariesAndLateDeltas() {
        SessionState state = new SessionState();
        ClaudeMessageHandler handler = handler(state, new CallbackHandler());
        synchronized (state.getMessageStateLock()) {
            handler.onMessage("stream_start", "");
            for (int index = 0; index < 30; index++) {
                handler.onMessage("thinking_delta", "t");
            }
            ClaudeSession.Message live = state.getMessagesReference().get(0);
            assertEquals("t", block(live, 0, "thinking"));
            handler.onMessage("content_delta", "A");
            handler.onMessage("content_delta", "B");
            handler.onMessage("tool_result", "{\"type\":\"tool_result\",\"tool_use_id\":\"tool\",\"content\":\"ok\"}");
            assertEquals("t".repeat(30), block(live, 0, "thinking"));
            assertEquals("AB", live.content);
            handler.onMessage("block_reset", "");
            handler.onMessage("thinking_delta", "next");
            handler.onMessage("thinking_delta", " thought");
            handler.onMessage("stream_end", "");
            assertEquals("next thought", block(live, 2, "thinking"));
            handler.onMessage("content_delta", "C");
            assertEquals("ABC", state.getMessagesSnapshot().get(0).content);
            assertEquals(2, state.getMessages().size());
        }
    }

    @Test
    public void historyReplacementDrainsPendingMaterialization() {
        SessionState state = new SessionState();
        ClaudeMessageHandler handler = handler(state, new CallbackHandler());
        synchronized (state.getMessageStateLock()) {
            handler.onMessage("stream_start", "");
            handler.onMessage("content_delta", "A");
            handler.onMessage("content_delta", "B");
            ClaudeSession.Message previous = state.getMessagesReference().get(0);
            state.replaceMessages(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "new session")));
            assertEquals("AB", previous.content);
            assertEquals("new session", state.getMessagesSnapshot().get(0).content);
        }
    }

    @Test
    public void alternatingTextAndThinkingKeepRawBlockOrder() {
        SessionState state = new SessionState();
        ClaudeMessageHandler handler = handler(state, new CallbackHandler());
        synchronized (state.getMessageStateLock()) {
            handler.onMessage("stream_start", "");
            handler.onMessage("content_delta", "A");
            handler.onMessage("content_delta", "B");
            handler.onMessage("thinking_delta", "thought");
            handler.onMessage("thinking_delta", " tail");
            handler.onMessage("content_delta", "C");
            handler.onMessage("content_delta", "D");
            handler.onMessage("stream_end", "");
            ClaudeSession.Message snapshot = state.getMessagesSnapshot().get(0);
            assertEquals("ABCD", snapshot.content);
            assertEquals("AB", block(snapshot, 0, "text"));
            assertEquals("thought tail", block(snapshot, 1, "thinking"));
            assertEquals("CD", block(snapshot, 2, "text"));
        }
    }

    @Test
    public void errorCompletionAndClearDrainPendingContent() {
        for (String boundary : List.of("error", "complete", "clear")) {
            SessionState state = new SessionState();
            ClaudeMessageHandler handler = handler(state, new CallbackHandler());
            synchronized (state.getMessageStateLock()) {
                handler.onMessage("stream_start", "");
                handler.onMessage("content_delta", "A");
                handler.onMessage("content_delta", "B");
                ClaudeSession.Message previous = state.getMessagesReference().get(0);
                switch (boundary) {
                    case "error" -> handler.onError("synthetic error");
                    case "complete" -> handler.onComplete(null);
                    case "clear" -> state.clearMessages();
                    default -> throw new AssertionError(boundary);
                }
                assertEquals(boundary, "AB", previous.content);
                assertEquals("AB", block(previous, 0, "text"));
            }
        }
    }

    @Test
    public void timerPublishesPendingThinkingWithoutAnotherInput() throws Exception {
        SessionState state = new SessionState();
        CountDownLatch flushed = new CountDownLatch(1);
        CallbackHandler callbacks = new CallbackHandler() {
            @Override
            public void notifyMessageUpdate(List<ClaudeSession.Message> messages) {
                if (!messages.isEmpty() && "AB".equals(block(messages.get(0), 0, "thinking"))) {
                    flushed.countDown();
                }
            }
        };
        ClaudeMessageHandler handler = handler(state, callbacks);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking_delta", "A");
        handler.onMessage("thinking_delta", "B");
        assertTrue(flushed.await(5, TimeUnit.SECONDS));
        handler.onMessage("stream_end", "");
        assertEquals("AB", block(state.getMessagesSnapshot().get(0), 0, "thinking"));
    }

    @Test
    public void expiredTimerAndStreamEndContendWithoutDuplicatingOrDroppingText() throws Exception {
        SessionState state = new SessionState();
        ClaudeMessageHandler handler = handler(state, new CallbackHandler());
        CompletableFuture<Void> ending;
        ClaudeSession.Message captured;
        synchronized (state.getMessageStateLock()) {
            handler.onMessage("stream_start", "");
            handler.onMessage("content_delta", "a");
            captured = state.getMessagesSnapshot().get(0);
            for (int index = 1; index < 30; index++) {
                handler.onMessage("content_delta", "a");
            }
            java.lang.reflect.Field field = ClaudeMessageHandler.class.getDeclaredField("materializationTask");
            field.setAccessible(true);
            ScheduledFuture<?> timer = (ScheduledFuture<?>) field.get(handler);
            CountDownLatch endingStarted = new CountDownLatch(1);
            ending = CompletableFuture.runAsync(() -> {
                endingStarted.countDown();
                handler.onMessage("stream_end", "");
            });
            assertTrue(endingStarted.await(5, TimeUnit.SECONDS));
            while (timer.getDelay(TimeUnit.NANOSECONDS) > 0) {
                LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
            }
        }
        ending.get(5, TimeUnit.SECONDS);
        ClaudeSession.Message completed = state.getMessagesSnapshot().get(0);
        assertEquals("a".repeat(30), completed.content);
        assertEquals(completed.content, block(completed, 0, "text"));
        assertEquals("a", captured.content);
        assertEquals("a", block(captured, 0, "text"));
    }

    @Test
    public void clearingPendingThinkingDoesNotRepublishTheClearedTranscript() {
        SessionState state = new SessionState();
        java.util.concurrent.atomic.AtomicInteger nonemptyUpdates = new java.util.concurrent.atomic.AtomicInteger();
        ClaudeMessageHandler handler = handler(state, new CallbackHandler() {
            @Override
            public void notifyMessageUpdate(List<ClaudeSession.Message> messages) {
                if (!messages.isEmpty()) {
                    nonemptyUpdates.incrementAndGet();
                }
            }
        });
        synchronized (state.getMessageStateLock()) {
            handler.onMessage("stream_start", "");
            handler.onMessage("thinking_delta", "A");
            handler.onMessage("thinking_delta", "B");
            int beforeClear = nonemptyUpdates.get();
            ClaudeSession.Message previous = state.getMessagesReference().get(0);
            state.clearMessages();
            assertEquals(beforeClear, nonemptyUpdates.get());
            assertTrue(state.getMessages().isEmpty());
            assertEquals("AB", block(previous, 0, "thinking"));
        }
    }

    private static ClaudeMessageHandler handler(SessionState state, CallbackHandler callbacks) {
        return new ClaudeMessageHandler(null, state, callbacks, new MessageParser(), new MessageMerger(), new Gson());
    }

    private static String block(ClaudeSession.Message message, int index, String field) {
        return message.raw.getAsJsonObject("message").getAsJsonArray("content")
                .get(index).getAsJsonObject().get(field).getAsString();
    }
}
