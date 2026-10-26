package com.github.claudecodegui.skill;

import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Covers the invalid-name fallback and its warn-once behaviour. Skill discovery
 * re-parses the same files on every refresh, so the warning must not repeat per
 * scan (it produced 44 idea.log lines in a single second before).
 */
public class SkillFrontmatterParserTest {

    @Test
    public void invalidNameWarnsOnlyOnTheFirstPassForEachFile() {
        Path first = Path.of("/tmp/skills/alpha/SKILL.md");
        Path second = Path.of("/tmp/skills/beta/SKILL.md");

        assertTrue("first sighting must be reported", SkillFrontmatterParser.shouldReportInvalidName(first));
        assertFalse("re-scanning the same file must stay quiet", SkillFrontmatterParser.shouldReportInvalidName(first));
        assertTrue("a different file is its own warning", SkillFrontmatterParser.shouldReportInvalidName(second));
        assertFalse(SkillFrontmatterParser.shouldReportInvalidName(second));
    }

    @Test
    public void parseFallsBackToDirectoryNameAndStaysIdempotent() throws IOException {
        Path skillDir = Files.createTempDirectory("skill-invalid-name").resolve("my-skill");
        Files.createDirectories(skillDir);
        Files.writeString(
                skillDir.resolve("SKILL.md"),
                "---\nname: Not A Valid Name\ndescription: does something\n---\n\nBody.\n",
                StandardCharsets.UTF_8
        );

        // The warn-once guard only gates the log line - the parsed metadata must be
        // identical on every pass, otherwise skill discovery would drift.
        SkillFrontmatterParser.SkillMetadata first = SkillFrontmatterParser.parse(skillDir);
        SkillFrontmatterParser.SkillMetadata second = SkillFrontmatterParser.parse(skillDir);

        assertEquals("my-skill", first.name());
        assertEquals(first.name(), second.name());
        assertEquals("does something", first.description());
    }
}
