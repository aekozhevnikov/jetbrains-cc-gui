package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * Supply-chain gate tests for {@link McpServerManager}: git-trust of the project
 * settings file, symlink-safe writing, non-destructive parsing, fingerprint-bound
 * approvals, and id-collision handling.
 */
public class McpServerManagerApprovalTest {

    private static final String MCP_JSON = "{\n"
            + "  \"mcpServers\": {\n"
            + "    \"evil\": {\"command\": \"node\", \"args\": [\"payload.js\"]},\n"
            + "    \"dup\": {\"command\": \"/usr/bin/true\"}\n"
            + "  }\n"
            + "}\n";

    private String originalHomeDir;
    private Path home;
    private Path project;
    private McpServerManager manager;

    @Before
    public void setUp() throws Exception {
        home = Files.createTempDirectory("mcp-approval-home");
        project = Files.createTempDirectory("mcp-approval-project");
        useTemporaryHomeDirectory(home);

        manager = new McpServerManager(new Gson(), v -> new JsonObject(), c -> { }, null);
        Files.writeString(project.resolve(".mcp.json"), MCP_JSON, StandardCharsets.UTF_8);
    }

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    // ------------------------------------------------------------------
    // 1. A committed settings.local.json must not be able to open the gate
    // ------------------------------------------------------------------

    @Test
    public void shouldReportTrackedFileAsTracked() throws Exception {
        assumeGitAvailable();
        initRepo();
        Path settings = writeProjectLocalSettings("{\"enableAllProjectMcpServers\": true}");
        git("add", "-f", settings.toString());

        assertEquals(McpServerManager.GitTrackingState.TRACKED,
                McpServerManager.detectGitTrackingState(project, settings));
    }

    @Test
    public void shouldReportUntrackedFileAsUntracked() throws Exception {
        assumeGitAvailable();
        initRepo();
        Path settings = writeProjectLocalSettings("{\"enableAllProjectMcpServers\": true}");

        assertEquals(McpServerManager.GitTrackingState.UNTRACKED,
                McpServerManager.detectGitTrackingState(project, settings));
    }

    @Test
    public void shouldReportGitignoredFileAsUntracked() throws Exception {
        assumeGitAvailable();
        initRepo();
        Files.writeString(project.resolve(".gitignore"), ".claude/\n", StandardCharsets.UTF_8);
        Path settings = writeProjectLocalSettings("{\"enableAllProjectMcpServers\": true}");

        assertEquals(McpServerManager.GitTrackingState.UNTRACKED,
                McpServerManager.detectGitTrackingState(project, settings));
    }

    @Test
    public void shouldTreatFilesOutsideAnyRepositoryAsUntracked() throws Exception {
        // No `git init` here: git gives a definitive "not a git repository" answer, so
        // nothing in this directory can ever be committed by a repository.
        Path settings = writeProjectLocalSettings("{\"enableAllProjectMcpServers\": true}");

        assertEquals(McpServerManager.GitTrackingState.UNTRACKED,
                McpServerManager.detectGitTrackingState(project, settings));
    }

    @Test
    public void shouldFailClosedOnAnUnreadableRepository() throws Exception {
        // A `.git` file that git cannot parse: the answer is neither "tracked" nor a
        // clean "not a repository", so the trust decision must be indeterminate.
        Files.writeString(project.resolve(".git"), "not a real gitfile", StandardCharsets.UTF_8);
        Path settings = writeProjectLocalSettings("{\"enableAllProjectMcpServers\": true}");

        assertEquals(McpServerManager.GitTrackingState.INDETERMINATE,
                McpServerManager.detectGitTrackingState(project, settings));
    }

    @Test
    public void shouldNotApproveWhenGitStateIsIndeterminate() throws Exception {
        Files.writeString(project.resolve(".git"), "not a real gitfile", StandardCharsets.UTF_8);
        writeProjectLocalSettings("{\"enabledMcpjsonServers\": [\"evil\"]}");

        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void shouldNotApproveFromTrackedProjectSettings() throws Exception {
        assumeGitAvailable();
        initRepo();
        Path settings = writeProjectLocalSettings(
                "{\"enableAllProjectMcpServers\": true,"
                        + " \"enabledMcpjsonServers\": [\"evil\"]}");
        git("add", "-f", settings.toString());

        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void shouldNotHonourEnableAllFromProjectSettings() throws Exception {
        // Untracked (and therefore user-owned), but enableAllProjectMcpServers is a
        // user/managed-scope-only switch — a project-local copy must be ignored.
        writeProjectLocalSettings("{\"enableAllProjectMcpServers\": true}");

        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void shouldStillHonourEnableAllFromUserSettings() throws Exception {
        writeProjectLocalSettings("{}");
        Path userSettings = Files.createDirectories(home.resolve(".claude"))
                .resolve("settings.json");
        Files.writeString(userSettings, "{\"enableAllProjectMcpServers\": true}", StandardCharsets.UTF_8);

        assertEquals("approved", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void shouldHonourExplicitListFromUntrackedProjectSettings() throws Exception {
        assumeGitAvailable();
        initRepo();
        writeProjectLocalSettings("{\"enabledMcpjsonServers\": [\"evil\"]}");

        // The id is listed, but there is no stored fingerprint yet, so the approval
        // is not trusted until it is granted through approveProjectMcpJsonServer.
        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    // ------------------------------------------------------------------
    // 2/3. Symlink-safe, non-destructive writes
    // ------------------------------------------------------------------

    @Test
    public void shouldPreserveUnrelatedKeysAndRecordFingerprint() throws Exception {
        Files.createDirectories(project.resolve(".claude"));
        Path settings = project.resolve(".claude").resolve("settings.local.json");
        Files.writeString(settings,
                "{\"permissions\": {\"allow\": [\"Bash\"]}, \"env\": {\"A\": \"1\"}}",
                StandardCharsets.UTF_8);

        manager.approveProjectMcpJsonServer("evil", project.toString());

        JsonObject written = parse(settings);
        assertNotNull(written.getAsJsonObject("permissions"));
        assertEquals("1", written.getAsJsonObject("env").get("A").getAsString());
        assertEquals("evil", written.getAsJsonArray("enabledMcpjsonServers").get(0).getAsString());
        assertEquals(McpServerManager.fingerprintOfProjectServer(project.toString(), "evil"),
                written.getAsJsonObject(McpServerManager.KEY_MCPJSON_SERVER_FINGERPRINTS)
                        .get("evil").getAsString());
        assertEquals("approved", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void shouldRequireReconfirmationWhenTheSpecChanges() throws Exception {
        manager.approveProjectMcpJsonServer("evil", project.toString());
        assertEquals("approved", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));

        // The repository repoints the same id at a different binary.
        Files.writeString(project.resolve(".mcp.json"),
                MCP_JSON.replace("payload.js", "payload2.js"), StandardCharsets.UTF_8);

        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void shouldTreatLegacyApprovalWithoutFingerprintAsPending() throws Exception {
        Files.createDirectories(project.resolve(".claude"));
        Files.writeString(project.resolve(".claude").resolve("settings.local.json"),
                "{\"enabledMcpjsonServers\": [\"evil\"]}", StandardCharsets.UTF_8);

        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void shouldClearFingerprintOnReject() throws Exception {
        manager.approveProjectMcpJsonServer("evil", project.toString());
        manager.rejectProjectMcpJsonServer("evil", project.toString());

        Path settings = project.resolve(".claude").resolve("settings.local.json");
        JsonObject written = parse(settings);
        assertEquals("evil", written.getAsJsonArray("disabledMcpjsonServers").get(0).getAsString());
        assertFalse(written.getAsJsonObject(McpServerManager.KEY_MCPJSON_SERVER_FINGERPRINTS).has("evil"));
        assertEquals("rejected", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void shouldNotOverwriteUnparseableSettingsLocalJson() throws Exception {
        Files.createDirectories(project.resolve(".claude"));
        Path settings = project.resolve(".claude").resolve("settings.local.json");
        String broken = "{ this is not json";
        Files.writeString(settings, broken, StandardCharsets.UTF_8);

        assertThrows(IOException.class,
                () -> manager.approveProjectMcpJsonServer("evil", project.toString()));

        assertEquals(broken, Files.readString(settings, StandardCharsets.UTF_8));
    }

    @Test
    public void shouldRefuseToWriteThroughSymlinkedSettingsLocalJson() throws Exception {
        Path outside = Files.createTempDirectory("mcp-approval-outside").resolve("settings.json");
        Files.writeString(outside, "{\"permissions\": {\"allow\": []}}", StandardCharsets.UTF_8);

        Files.createDirectories(project.resolve(".claude"));
        Files.createSymbolicLink(project.resolve(".claude").resolve("settings.local.json"), outside);

        assertThrows(IOException.class,
                () -> manager.approveProjectMcpJsonServer("evil", project.toString()));

        assertEquals("{\"permissions\": {\"allow\": []}}",
                Files.readString(outside, StandardCharsets.UTF_8));
    }

    @Test
    public void shouldRefuseToWriteThroughSymlinkedClaudeDirectory() throws Exception {
        Path outsideDir = Files.createTempDirectory("mcp-approval-outside-dir");
        Path victim = outsideDir.resolve("settings.local.json");
        Files.writeString(victim, "{\"permissions\": {}}", StandardCharsets.UTF_8);

        Files.createSymbolicLink(project.resolve(".claude"), outsideDir);

        assertThrows(IOException.class,
                () -> manager.approveProjectMcpJsonServer("evil", project.toString()));

        assertEquals("{\"permissions\": {}}", Files.readString(victim, StandardCharsets.UTF_8));
    }

    @Test
    public void shouldRejectUnknownServerId() throws Exception {
        assertNotNull(McpServerManager.validateProjectMcpServerId("not-in-mcp-json", project.toString()));
        assertThrows(IOException.class,
                () -> manager.approveProjectMcpJsonServer("not-in-mcp-json", project.toString()));
    }

    @Test
    public void shouldRejectMalformedServerIds() throws Exception {
        assertNotNull(McpServerManager.validateProjectMcpServerId(null, project.toString()));
        assertNotNull(McpServerManager.validateProjectMcpServerId("", project.toString()));
        assertNotNull(McpServerManager.validateProjectMcpServerId("evil\nrm -rf /", project.toString()));
        assertNotNull(McpServerManager.validateProjectMcpServerId(
                "x".repeat(McpServerManager.MAX_SERVER_ID_LENGTH + 1), project.toString()));
        assertNull(McpServerManager.validateProjectMcpServerId("evil", project.toString()));
    }

    // ------------------------------------------------------------------
    // 5. Fingerprint includes cwd and headers (REGRESSION: PR #2056)
    // ------------------------------------------------------------------

    @Test
    public void fingerprintShouldIncludeCwd() throws Exception {
        String mcpJson1 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"args\": [\"a.js\"]}}}";
        String mcpJson2 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"args\": [\"a.js\"], \"cwd\": \"/custom\"}}}";

        Files.writeString(project.resolve(".mcp.json"), mcpJson1, StandardCharsets.UTF_8);
        String fp1 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        Files.writeString(project.resolve(".mcp.json"), mcpJson2, StandardCharsets.UTF_8);
        String fp2 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        assertNotEquals(fp1, fp2, "cwd change should change fingerprint");
    }

    @Test
    public void fingerprintShouldIncludeHeaders() throws Exception {
        String mcpJson1 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"args\": [\"a.js\"]}}}";
        String mcpJson2 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"args\": [\"a.js\"], \"headers\": {\"X-Custom\": \"value\"}}}}";

        Files.writeString(project.resolve(".mcp.json"), mcpJson1, StandardCharsets.UTF_8);
        String fp1 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        Files.writeString(project.resolve(".mcp.json"), mcpJson2, StandardCharsets.UTF_8);
        String fp2 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        assertNotEquals(fp1, fp2, "headers change should change fingerprint");
    }

    @Test
    public void fingerprintShouldUseCanonicalJsonSerialization() throws Exception {
        // Order of env keys should not affect fingerprint
        String mcpJson1 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"env\": {\"B\": \"2\", \"A\": \"1\"}}}}";
        String mcpJson2 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"env\": {\"A\": \"1\", \"B\": \"2\"}}}}";

        Files.writeString(project.resolve(".mcp.json"), mcpJson1, StandardCharsets.UTF_8);
        String fp1 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        Files.writeString(project.resolve(".mcp.json"), mcpJson2, StandardCharsets.UTF_8);
        String fp2 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        assertEquals(fp1, fp2, "env key order should not affect fingerprint");
    }

    @Test
    public void fingerprintShouldUseCanonicalJsonSerializationForHeaders() throws Exception {
        // Order of header keys should not affect fingerprint
        String mcpJson1 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"headers\": {\"X-B\": \"2\", \"X-A\": \"1\"}}}}";
        String mcpJson2 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"headers\": {\"X-A\": \"1\", \"X-B\": \"2\"}}}}";

        Files.writeString(project.resolve(".mcp.json"), mcpJson1, StandardCharsets.UTF_8);
        String fp1 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        Files.writeString(project.resolve(".mcp.json"), mcpJson2, StandardCharsets.UTF_8);
        String fp2 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        assertEquals(fp1, fp2, "headers key order should not affect fingerprint");
    }

    @Test
    public void fingerprintShouldIncludeArgsOrder() throws Exception {
        // Args order should matter
        String mcpJson1 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"args\": [\"a\", \"b\"]}}}";
        String mcpJson2 = "{\"mcpServers\": {\"srv\": {\"command\": \"node\", \"args\": [\"b\", \"a\"]}}}";

        Files.writeString(project.resolve(".mcp.json"), mcpJson1, StandardCharsets.UTF_8);
        String fp1 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        Files.writeString(project.resolve(".mcp.json"), mcpJson2, StandardCharsets.UTF_8);
        String fp2 = McpServerManager.fingerprintOfProjectServer(project.toString(), "srv");

        assertNotEquals(fp1, fp2, "args order should affect fingerprint");
    }

    // ------------------------------------------------------------------
    // 6. Unified trust predicate (REGRESSION: PR #2056)
    // ------------------------------------------------------------------

    @Test
    public void unifiedTrustPredicateShouldRequireBothUntrackedAndGitignored() throws Exception {
        assumeGitAvailable();
        initRepo();
        // Case 1: tracked (not ignored) - should NOT be trusted
        Files.createDirectories(project.resolve(".claude"));
        Path settings = project.resolve(".claude").resolve("settings.local.json");
        Files.writeString(settings, "{\"enabledMcpjsonServers\": [\"evil\"]}", StandardCharsets.UTF_8);
        git("add", "-f", settings.toString());

        assertEquals(McpServerManager.GitTrackingState.TRACKED,
                McpServerManager.detectGitTrackingState(project, settings));
        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));

        // Case 2: untracked but NOT ignored - should NOT be trusted
        git("reset", "-q", "HEAD", "--", settings.toString());
        Files.writeString(project.resolve(".gitignore"), "# nothing ignored\n", StandardCharsets.UTF_8);

        assertEquals(McpServerManager.GitTrackingState.UNTRACKED,
                McpServerManager.detectGitTrackingState(project, settings));
        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));

        // Case 3: untracked AND ignored - should be trusted
        Files.writeString(project.resolve(".gitignore"), ".claude/settings.local.json\n", StandardCharsets.UTF_8);

        assertEquals(McpServerManager.GitTrackingState.UNTRACKED,
                McpServerManager.detectGitTrackingState(project, settings));
        writeProjectLocalSettings("{\"enabledMcpjsonServers\": [\"evil\"]}");
        assertEquals("approved", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    @Test
    public void trustPredicateShouldFailClosedOnGitErrors() throws Exception {
        // Create unreadable .git
        Files.writeString(project.resolve(".git"), "not a real gitfile", StandardCharsets.UTF_8);
        Files.createDirectories(project.resolve(".claude"));
        Path settings = project.resolve(".claude").resolve("settings.local.json");
        Files.writeString(settings, "{\"enabledMcpjsonServers\": [\"evil\"]}", StandardCharsets.UTF_8);

        assertEquals(McpServerManager.GitTrackingState.INDETERMINATE,
                McpServerManager.detectGitTrackingState(project, settings));
        assertEquals("pending", manager.resolveProjectMcpApprovalStatus("evil", project.toString()));
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private Path writeProjectLocalSettings(String content) throws IOException {
        Path dir = Files.createDirectories(project.resolve(".claude"));
        Path settings = dir.resolve("settings.local.json");
        Files.writeString(settings, content, StandardCharsets.UTF_8);
        return settings;
    }

    private JsonObject parse(Path file) throws IOException {
        try {
            return JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (Exception e) {
            throw new IOException(e);
        }
    }

    private void assumeGitAvailable() {
        Assume.assumeTrue("git is not available", gitAvailable());
    }

    private static boolean gitAvailable() {
        try {
            ProcessBuilder builder = new ProcessBuilder("git", "--version");
            builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            builder.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process process = builder.start();
            return process.waitFor(10, TimeUnit.SECONDS) && process.exitValue() == 0;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private void initRepo() throws Exception {
        git("init");
    }

    private void git(String... args) throws Exception {
        List<String> command = new java.util.ArrayList<>();
        command.add("git");
        command.addAll(java.util.Arrays.asList(args));
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(project.toFile());
        builder.redirectErrorStream(true);
        Process process = builder.start();
        assertTrue("git " + String.join(" ", args) + " failed",
                process.waitFor(30, TimeUnit.SECONDS) && process.exitValue() == 0);
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
