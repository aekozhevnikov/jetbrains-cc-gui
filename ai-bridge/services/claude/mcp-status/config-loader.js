/**
 * MCP configuration loader module
 * Provides functionality to read MCP server configuration from ~/.claude.json
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getRealHomeDir } from '../../../utils/path-utils.js';
import { createHash } from 'node:crypto';
import { log } from './logger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git tracking state of a settings file.
 * Matches the Java GitTrackingState enum.
 */
const GitTrackingState = {
  TRACKED: 'TRACKED',
  UNTRACKED: 'UNTRACKED',
  INDETERMINATE: 'INDETERMINATE'
};

/**
 * Detect the git tracking state of a settings file.
 * Matches the Java detectGitTrackingState implementation.
 *
 * @param {string} projectPath - Project directory path
 * @param {string} settingsFile - Settings file path to check
 * @returns {Promise<string>} 'TRACKED' | 'UNTRACKED' | 'INDETERMINATE'
 */
async function detectGitTrackingState(projectPath, settingsFile) {
  // Check if we're in a git repository
  const gitDir = join(projectPath, '.git');
  if (!existsSync(gitDir)) {
    return GitTrackingState.INDETERMINATE;
  }

  try {
    // Check if the file is tracked by git
    try {
      await execFileAsync('git', ['ls-files', '--error-unmatch', settingsFile], {
        cwd: projectPath,
        timeout: 5000
      });
      return GitTrackingState.TRACKED;
    } catch (e) {
      // Not tracked, check if ignored
    }

    // Check if the file is ignored by .gitignore
    try {
      await execFileAsync('git', ['check-ignore', settingsFile], {
        cwd: projectPath,
        timeout: 5000
      });
      return GitTrackingState.UNTRACKED;
    } catch (e) {
      // Not ignored
      return GitTrackingState.UNTRACKED;
    }
  } catch (e) {
    log('warn', `[MCP Config] Failed to detect git tracking state: ${e.message}`);
    return GitTrackingState.INDETERMINATE;
  }
}

/**
 * Expand ${VAR} placeholders in an MCP server env value
 *
 * Claude Code resolves these from the `env` section of
 * `.claude/settings.local.json` (project) and `.claude/settings.json`
 * (user), falling back to the process environment. The plugin passed the
 * literal placeholder through to the spawned MCP server, so containers
 * received e.g. DATABASE_URI=${NEXUS_MCP_DB_URI} verbatim (#1722).
 *
 * Lookup order (first hit wins): project settings.local env -> user
 * settings env -> process.env. Unresolvable placeholders are left as-is so
 * misconfiguration stays visible in logs instead of becoming empty strings.
 *
 * @param {string} value - Raw env value that may contain ${VAR} placeholders
 * @param {Object} projectEnv - env map from .claude/settings.local.json
 * @param {Object} userEnv - env map from .claude/settings.json
 * @returns {string} Value with all resolvable ${VAR} placeholders expanded
 */
function expandEnvPlaceholders(value, projectEnv, userEnv) {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  // ${VAR} only - no command substitution, nesting, or defaults syntax
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(projectEnv, name)) {
      return String(projectEnv[name]);
    }
    if (Object.prototype.hasOwnProperty.call(userEnv, name)) {
      return String(userEnv[name]);
    }
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      return process.env[name];
    }
    log('warn', `[MCP Config] Unresolved \${${name}} placeholder left as-is in MCP env`);
    return match;
  });
}

/**
 * Load the env override maps used for ${VAR} expansion
 *
 * Reads the `env` section of .claude/settings.local.json (project-local,
 * git-ignored, where secrets live) and .claude/settings.json (user-level),
 * matching the resolution order Claude Code uses for .mcp.json placeholders.
 * Files that are missing, unparseable, or have no env section produce {}.
 *
 * @param {string} cwd - Current working directory (project root)
 * @returns {Promise<{projectEnv: Object, userEnv: Object}>} env maps
 */
async function loadEnvExpansionSources(cwd) {
  const projectEnv = {};
  const userEnv = {};

  const sources = [
    { label: 'project settings.local.json', file: cwd ? join(cwd, '.claude', 'settings.local.json') : null, into: projectEnv },
    { label: 'user settings.json', file: join(getRealHomeDir(), '.claude', 'settings.json'), into: userEnv }
  ];

  for (const source of sources) {
    if (!source.file || !existsSync(source.file)) continue;
    try {
      const parsed = JSON.parse(await readFile(source.file, 'utf8'));
      if (parsed && typeof parsed.env === 'object' && parsed.env !== null) {
        Object.assign(source.into, parsed.env);
      }
    } catch (e) {
      log('warn', `[MCP Config] Failed to read ${source.label} for env expansion:`, e.message);
    }
  }

  return { projectEnv, userEnv };
}

/**
 * Apply ${VAR} expansion to every env value of every server config
 * @param {Object} mcpServers - Server name -> config map
 * @param {Object} projectEnv - env map from .claude/settings.local.json
 * @param {Object} userEnv - env map from .claude/settings.json
 * @returns {Object} New map with expanded env values (input is not mutated)
 */
function expandMcpServersEnv(mcpServers, projectEnv, userEnv) {
  const expanded = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (config && typeof config === 'object' && config.env && typeof config.env === 'object') {
      const env = {};
      for (const [key, value] of Object.entries(config.env)) {
        env[key] = expandEnvPlaceholders(value, projectEnv, userEnv);
      }
      expanded[name] = { ...config, env };
    } else {
      expanded[name] = config;
    }
  }
  return expanded;
}

/**
 * Validate the basic structure of an MCP server configuration
 * @param {Object} serverConfig - Server configuration object
 * @returns {boolean} Whether the configuration is valid
 */
function isValidServerConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== 'object') {
    return false;
  }
  // Must have command (stdio) or url (http)
  const hasCommand = typeof serverConfig.command === 'string' && serverConfig.command.length > 0;
  const hasUrl = typeof serverConfig.url === 'string' && serverConfig.url.length > 0;
  if (!hasCommand && !hasUrl) {
    return false;
  }
  // args must be an array if present
  if (serverConfig.args !== undefined && !Array.isArray(serverConfig.args)) {
    return false;
  }
  // env must be an object if present
  if (serverConfig.env !== undefined && (typeof serverConfig.env !== 'object' || serverConfig.env === null)) {
    return false;
  }
  return true;
}

/**
 * Validate the basic structure of a configuration file
 * @param {Object} config - Configuration object
 * @returns {{valid: boolean, reason?: string}} Validation result
 */
function validateConfigStructure(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, reason: 'Config must be an object' };
  }
  // mcpServers must be an object if present
  if (config.mcpServers !== undefined) {
    if (typeof config.mcpServers !== 'object' || config.mcpServers === null) {
      return { valid: false, reason: 'mcpServers must be an object' };
    }
    // Validate each server configuration
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (!isValidServerConfig(serverConfig)) {
        log('warn', `Invalid server config for "${name}", skipping`);
      }
    }
  }
  // disabledMcpServers must be an array if present
  if (config.disabledMcpServers !== undefined && !Array.isArray(config.disabledMcpServers)) {
    return { valid: false, reason: 'disabledMcpServers must be an array' };
  }
  // projects must be an object if present
  if (config.projects !== undefined && (typeof config.projects !== 'object' || config.projects === null)) {
    return { valid: false, reason: 'projects must be an object' };
  }
  return { valid: true };
}

/**
 * Parse the server list and disabled list from the MCP configuration file
 * Extracts shared logic used by both loadMcpServersConfig and loadAllMcpServersInfo
 * @param {string} cwd - Current working directory (used for project detection)
 * @returns {Promise<{mcpServers: Object, disabledServers: Set<string>} | null>} Parse result, or null on failure
 */
async function parseMcpConfig(cwd = null) {
  const claudeJsonPath = join(getRealHomeDir(), '.claude.json');

  let config = null;
  let hasClaudeJson = false;

  if (existsSync(claudeJsonPath)) {
    hasClaudeJson = true;
    const content = await readFile(claudeJsonPath, 'utf8');
    config = JSON.parse(content);

    // Validate configuration structure
    const validation = validateConfigStructure(config);
    if (!validation.valid) {
      log('error', 'Invalid config structure:', validation.reason);
      return null;
    }
  } else if (cwd) {
    // No ~/.claude.json, but we have a project directory - check for standalone .mcp.json
    const projectMcpJson = await loadProjectMcpJson(cwd);
    if (projectMcpJson && projectMcpJson.mcpServers) {
      log('info', '[MCP Config] Using standalone project .mcp.json configuration');
      // Create a minimal config object with project servers
      config = {
        mcpServers: projectMcpJson.mcpServers || {},
        disabledMcpServers: projectMcpJson.disabledMcpServers || [],
        projects: {}
      };
    } else {
      log('info', '~/.claude.json not found and no project .mcp.json');
      return null;
    }
  } else {
    log('info', '~/.claude.json not found');
    return null;
  }

  // Normalize the path to match the path format used in config
  let normalizedCwd = cwd;
  if (cwd) {
    normalizedCwd = cwd.replace(/\\/g, '/');
    normalizedCwd = normalizedCwd.replace(/\/$/, '');
  }

  // Find a matching project configuration
  let projectConfig = null;
  if (normalizedCwd && config.projects) {
    if (config.projects[normalizedCwd]) {
      projectConfig = config.projects[normalizedCwd];
    } else {
      const cwdVariants = [
        normalizedCwd,
        normalizedCwd.replace(/\//g, '\\'),
        '/' + normalizedCwd,
      ];

      for (const projectPath of Object.keys(config.projects)) {
        const normalizedProjectPath = projectPath.replace(/\\/g, '/');
        if (cwdVariants.includes(normalizedProjectPath)) {
          projectConfig = config.projects[projectPath];
          log('info', 'Found project config for:', projectPath);
          break;
        }
      }
    }
  }

  let mcpServers = {};
  let disabledServers = new Set();

  if (projectConfig) {
    log('info', '[MCP Config] Using project-specific MCP configuration');

    if (Object.keys(projectConfig.mcpServers || {}).length > 0) {
      mcpServers = JSON.parse(JSON.stringify(projectConfig.mcpServers));
      disabledServers = new Set(projectConfig.disabledMcpServers || []);
    } else {
      log('info', '[MCP Config] Project has no MCP servers, using global config');
      mcpServers = JSON.parse(JSON.stringify(config.mcpServers || {}));

      const globalDisabled = config.disabledMcpServers || [];
      const projectDisabled = projectConfig.disabledMcpServers || [];
      disabledServers = new Set([...globalDisabled, ...projectDisabled]);
    }
  } else {
    log('info', '[MCP Config] Using global MCP configuration');
    mcpServers = JSON.parse(JSON.stringify(config.mcpServers || {}));
    disabledServers = new Set(config.disabledMcpServers || []);
  }

  let projectServers = {};
  let projectDisabled = new Set();

  // If no project config found in ~/.claude.json but cwd is provided,
  // check for standalone .mcp.json in the project directory
  if (!projectConfig && cwd) {
    const projectMcpJson = await loadProjectMcpJson(cwd);
    if (projectMcpJson && projectMcpJson.mcpServers) {
      log('info', '[MCP Config] Using project .mcp.json configuration');
      projectServers = projectMcpJson.mcpServers || {};
      projectDisabled = new Set(projectMcpJson.disabledMcpServers || []);
      // Merge project servers with global servers (project ONLY adds new, doesn't override global)
      for (const [name, config] of Object.entries(projectServers)) {
        if (!mcpServers[name]) {
          mcpServers[name] = config;
        }
      }
      // Also merge disabled servers
      for (const name of projectDisabled) {
        disabledServers.add(name);
      }
    }
  }

  // Add source property to server configs
  // Global servers get source: 'global', project servers get source: 'project'
  const globalServerNames = new Set(Object.keys(config.mcpServers || {}));
  if (projectConfig) {
    // Project config from ~/.claude.json
    for (const name of Object.keys(projectConfig.mcpServers || {})) {
      if (mcpServers[name]) {
        mcpServers[name].source = 'project';
      }
    }
    // Global servers that are not overridden by project
    for (const name of Object.keys(config.mcpServers || {})) {
      if (!projectConfig.mcpServers || !projectConfig.mcpServers[name]) {
        if (mcpServers[name]) {
          mcpServers[name].source = 'global';
        }
      }
    }
  } else if (Object.keys(projectServers).length > 0) {
    // Standalone .mcp.json file
    // In case of collision, global servers win (user-scope config wins)
    // So we don't override global servers with project servers
    // First, identify which project servers have global counterparts
    const globalServerNames = new Set(Object.keys(config.mcpServers || {}));

    for (const name of Object.keys(projectServers)) {
      if (!globalServerNames.has(name)) {
        // Project-only server (no collision) - mark as 'project'
        if (!mcpServers[name]) {
          mcpServers[name] = { ...projectServers[name], source: 'project' };
        } else if (!mcpServers[name].source) {
          mcpServers[name].source = 'project';
        }
      } else {
        // Collision - global wins, source is 'global'
        if (!mcpServers[name].source) {
          mcpServers[name].source = 'global';
        }
      }
    }
    // Global servers keep source 'global'
    for (const name of Object.keys(config.mcpServers || {})) {
      if (mcpServers[name]) {
        mcpServers[name].source = 'global';
      }
    }
  } else {
    // Only global config
    for (const name of Object.keys(mcpServers)) {
      mcpServers[name].source = 'global';
    }
  }

  // Expand ${VAR} placeholders in server env values (e.g. from
  // .claude/settings.local.json) so spawned servers receive real values,
  // matching Claude Code's behaviour for the same config (#1722).
  const { projectEnv, userEnv } = await loadEnvExpansionSources(cwd);
  mcpServers = expandMcpServersEnv(mcpServers, projectEnv, userEnv);

  // Enforce approval fingerprint for project-level servers
  if (cwd) {
    mcpServers = await enforceApprovalFingerprint(mcpServers, cwd);
  }

  return { mcpServers, disabledServers };
}

/**
 * Read MCP server configuration from ~/.claude.json
 * Supports two modes:
 * 1. Global config - uses the global mcpServers
 * 2. Project config - uses project-specific mcpServers
 * @param {string} cwd - Current working directory (used for project detection)
 * @returns {Promise<Array<{name: string, config: Object}>>} List of enabled MCP servers
 */
export async function loadMcpServersConfig(cwd = null) {
  try {
    const parsed = await parseMcpConfig(cwd);
    if (!parsed) return [];

    const { mcpServers, disabledServers } = parsed;

    const enabledServers = [];
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      if (!disabledServers.has(serverName)) {
        // Skip invalid server configurations
        if (!isValidServerConfig(serverConfig)) {
          log('warn', `Skipping invalid server config: ${serverName}`);
          continue;
        }
        enabledServers.push({ name: serverName, config: serverConfig });
      }
    }

    log('info', '[MCP Config] Loaded', enabledServers.length, 'enabled MCP servers');
    return enabledServers;
  } catch (error) {
    log('error', 'Failed to load MCP servers config:', error.message);
    return [];
  }
}

/**
 * Load enabled MCP server config and return as a Record<name, config> for the
 * Claude Agent SDK's `mcpServers` option.
 *
 * Returns null (rather than an empty object) when no servers are enabled, so
 * callers can naturally write `...(mcpServers && { mcpServers })` to omit the
 * field from SDK options entirely.
 *
 * @param {string} cwd - Current working directory (used for project detection)
 * @returns {Promise<Record<string, Object> | null>}
 */
export async function loadMcpServersConfigAsRecord(cwd = null) {
  const list = await loadMcpServersConfig(cwd);
  if (list.length === 0) return null;
  return Object.fromEntries(list.map(({ name, config }) => [name, config]));
}

/**
 * Load all MCP server info (including disabled and invalid ones)
 * Merges global and project-level mcpServers to stay consistent with the server list seen by the Java side
 * @param {string} cwd - Current working directory
 * @returns {Promise<{enabled: Array, disabled: Array<string>, invalid: Array<{name: string, reason: string}>}>}
 */
export async function loadAllMcpServersInfo(cwd = null) {
  const result = { enabled: [], disabled: [], invalid: [] };

  try {
    const parsed = await parseMcpConfig(cwd);
    if (!parsed) return result;

    const { mcpServers, disabledServers } = parsed;

    // Collect server names within the project scope
    const processedNames = new Set();

    // Process servers resolved from project/global config (the parseMcpConfig result) first
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      processedNames.add(serverName);
      classifyServer(serverName, serverConfig, disabledServers, result);
    }

    // If cwd is specified, global servers may have been overridden by project config.
    // Read the global config separately to pick up servers that only exist globally.
    if (cwd) {
      const globalParsed = await parseMcpConfig(null);
      if (globalParsed) {
        for (const [serverName, serverConfig] of Object.entries(globalParsed.mcpServers)) {
          if (processedNames.has(serverName)) continue; // Already covered by project config, skip
          processedNames.add(serverName);
          classifyServer(serverName, serverConfig, globalParsed.disabledServers, result);
        }
      }
    }

    log('info', '[MCP Config] All servers:', result.enabled.length, 'enabled,', result.disabled.length, 'disabled,', result.invalid.length, 'invalid');
    return result;
  } catch (error) {
    log('error', 'Failed to load all MCP servers info:', error.message);
    return result;
  }
}

/**
 * Classify a server into the enabled/disabled/invalid buckets
 */
function classifyServer(serverName, serverConfig, disabledServers, result) {
  if (disabledServers.has(serverName)) {
    result.disabled.push(serverName);
  } else if (!isValidServerConfig(serverConfig)) {
    const hasCommand = typeof serverConfig?.command === 'string' && serverConfig.command.length > 0;
    const hasUrl = typeof serverConfig?.url === 'string' && serverConfig.url.length > 0;
    const reason = !hasCommand && !hasUrl
      ? 'Missing command or url'
      : 'Invalid config structure';
    result.invalid.push({ name: serverName, reason });
  } else {
    result.enabled.push({ name: serverName, config: serverConfig });
  }
}

/**
 * Classify a project MCP server's approval status.
 * Used by tests and UI to determine approval state.
 *
 * Supports both legacy format (enabledMcpjsonServers array) and
 * new fingerprint format (enabledMcpjsonServerFingerprints object).
 *
 * @param {string} serverName - Server name to check
 * @param {string} cwd - Project directory
 * @returns {Promise<string>} 'approved' | 'rejected' | 'pending'
 */
export async function classifyProjectServerApproval(serverName, cwd) {
  // Check if it's a project server
  const mcpJsonPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    return 'pending';
  }

  try {
    const mcpJsonContent = await readFile(mcpJsonPath, 'utf8');
    const mcpJson = JSON.parse(mcpJsonContent);
    if (!mcpJson.mcpServers || !mcpJson.mcpServers[serverName]) {
      return 'pending';
    }
  } catch (e) {
    return 'pending';
  }

  // Load fingerprints from settings
  const settingsLocalPath = join(cwd, '.claude', 'settings.local.json');
  let enabledFingerprints = {};
  // Track which source each legacy approved server came from
  const enabledServersFromProject = new Set(); // Legacy format from project settings.local.json
  const enabledServersFromUser = new Set();    // Legacy format from user settings.json
  const disabledServers = []; // Legacy format
  let enableAllProjectMcpServers = false;

  if (existsSync(settingsLocalPath)) {
    try {
      const content = await readFile(settingsLocalPath, 'utf8');
      const settings = JSON.parse(content);
      // New fingerprint format
      if (settings.enabledMcpjsonServerFingerprints &&
          typeof settings.enabledMcpjsonServerFingerprints === 'object') {
        enabledFingerprints = settings.enabledMcpjsonServerFingerprints;
      }
      // Legacy format: arrays of server names
      if (Array.isArray(settings.enabledMcpjsonServers)) {
        for (const server of settings.enabledMcpjsonServers) {
          enabledServersFromProject.add(server);
        }
      }
      if (Array.isArray(settings.disabledMcpjsonServers)) {
        for (const server of settings.disabledMcpjsonServers) {
          disabledServers.push(server);
        }
      }
      // Check for enableAllProjectMcpServers flag
      if (settings.enableAllProjectMcpServers === true) {
        enableAllProjectMcpServers = true;
      }
    } catch (e) {
      // Ignore
    }
  }

  // Also check user settings.json
  const userSettingsPath = join(getRealHomeDir(), '.claude', 'settings.json');
  if (existsSync(userSettingsPath)) {
    try {
      const content = await readFile(userSettingsPath, 'utf8');
      const settings = JSON.parse(content);
      if (settings.enabledMcpjsonServerFingerprints &&
          typeof settings.enabledMcpjsonServerFingerprints === 'object') {
        enabledFingerprints = { ...enabledFingerprints, ...settings.enabledMcpjsonServerFingerprints };
      }
      if (Array.isArray(settings.enabledMcpjsonServers)) {
        for (const server of settings.enabledMcpjsonServers) {
          enabledServersFromUser.add(server);
        }
      }
      if (Array.isArray(settings.disabledMcpjsonServers)) {
        for (const server of settings.disabledMcpjsonServers) {
          disabledServers.push(server);
        }
      }
      if (settings.enableAllProjectMcpServers === true) {
        enableAllProjectMcpServers = true;
      }
    } catch (e) {
      // Ignore
    }
  }

  // Check disabled servers first (rejected)
  if (disabledServers.includes(serverName)) {
    return 'rejected';
  }

  // Check if enableAllProjectMcpServers is enabled (approves all project servers)
  if (enableAllProjectMcpServers) {
    return 'approved';
  }

  // Check legacy approved servers from PROJECT settings (with trust predicate)
  if (enabledServersFromProject.has(serverName)) {
    const settingsLocalPath = join(cwd, '.claude', 'settings.local.json');
    const trackingState = await detectGitTrackingState(cwd, settingsLocalPath);

    // Trust predicate: file must be both untracked AND gitignored
    if (trackingState === GitTrackingState.UNTRACKED) {
      // Check if file is gitignored
      try {
        await execFileAsync('git', ['check-ignore', settingsLocalPath], {
          cwd: cwd,
          timeout: 5000
        });
        return 'approved';
      } catch (e) {
        // Not ignored or error
        log('warn', `[MCP Config] Failed to check git ignore for ${settingsLocalPath}: ${e.message}`);
      }
    }
    return 'pending';
  }

  // Check legacy approved servers from USER settings (always trusted)
  if (enabledServersFromUser.has(serverName)) {
    return 'approved';
  }

  // Check fingerprint format
  const storedFingerprint = enabledFingerprints[serverName];
  if (!storedFingerprint) {
    return 'pending';
  }

  const computedFingerprint = await computeProjectServerFingerprint(cwd, serverName);
  if (!computedFingerprint) {
    return 'pending';
  }

  if (computedFingerprint !== storedFingerprint) {
    return 'rejected'; // Fingerprint mismatch = rejected/needs re-approval
  }

  return 'approved';
}

/**
 * Check if a project MCP server is approved (boolean wrapper).
 *
 * @param {string} serverName - Server name to check
 * @param {string} cwd - Project directory
 * @returns {Promise<boolean>} true if approved, false otherwise
 */
export async function isProjectServerApproved(serverName, cwd) {
  const status = await classifyProjectServerApproval(serverName, cwd);
  return status === 'approved';
}

/**
 * Get the set of approved project MCP servers.
 * Returns null if no approval recorded, empty Set if none approved, or Set of server names.
 *
 * @param {string} cwd - Project directory
 * @returns {Promise<Set<string> | null>}
 */
export function getApprovedProjectServers(cwd) {
  if (!cwd) return null;

  const mcpJsonPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    return null;
  }

  return (async () => {
    try {
      const content = await readFile(mcpJsonPath, 'utf8');
      const mcpJson = JSON.parse(content);
      if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
        return null;
      }

      const serverNames = Object.keys(mcpJson.mcpServers);
      const approved = new Set();

      for (const serverName of serverNames) {
        const status = await classifyProjectServerApproval(serverName, cwd);
        if (status === 'approved') {
          approved.add(serverName);
        }
      }

      return approved.size > 0 ? approved : new Set();
    } catch (e) {
      return null;
    }
  })();
}

/**
 * Get the set of denied project MCP servers.
 * Returns null if no denial recorded, empty Set if none denied, or Set of server names.
 *
 * @param {string} cwd - Project directory
 * @returns {Promise<Set<string> | null>}
 */
export function getDeniedProjectServers(cwd) {
  if (!cwd) return null;

  const mcpJsonPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    return null;
  }

  return (async () => {
    try {
      const content = await readFile(mcpJsonPath, 'utf8');
      const mcpJson = JSON.parse(content);
      if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
        return null;
      }

      const serverNames = Object.keys(mcpJson.mcpServers);
      const denied = new Set();

      for (const serverName of serverNames) {
        const status = await classifyProjectServerApproval(serverName, cwd);
        if (status === 'rejected') {
          denied.add(serverName);
        }
      }

      return denied.size > 0 ? denied : new Set();
    } catch (e) {
      return null;
    }
  })();
}

/**
 * Get project MCP approval info for a project.
 * Returns an object with approved, denied, and pending server sets.
 *
 * @param {string} cwd - Project directory
 * @returns {Promise<Object | null>} { approved: Set, denied: Set, pending: Set } or null
 */
export function getProjectMcpApproval(cwd) {
  if (!cwd) return null;

  const mcpJsonPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    return null;
  }

  return (async () => {
    try {
      const content = await readFile(mcpJsonPath, 'utf8');
      const mcpJson = JSON.parse(content);
      if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
        return null;
      }

      const serverNames = Object.keys(mcpJson.mcpServers);
      const approved = new Set();
      const denied = new Set();
      const pending = new Set();

      for (const serverName of serverNames) {
        const status = await classifyProjectServerApproval(serverName, cwd);
        if (status === 'approved') {
          approved.add(serverName);
        } else if (status === 'rejected') {
          denied.add(serverName);
        } else {
          pending.add(serverName);
        }
      }

      return { approved, denied, pending };
    } catch (e) {
      return null;
    }
  })();
}

/**
 * Check if a project MCP server is trust verified (has matching fingerprint).
 *
 * @param {string} serverName - Server name to check
 * @param {string} cwd - Project directory
 * @returns {Promise<boolean>} true if trust verified, false otherwise
 */
export function isProjectServerTrustVerified(serverName, cwd) {
  if (!cwd) return Promise.resolve(false);
  return classifyProjectServerApproval(serverName, cwd).then(status => status === 'approved');
}

/**
 * Load project .mcp.json file.
 *
 * @param {string} cwd - Project directory
 * @returns {Promise<Object | null>} Parsed .mcp.json or null if not found/invalid
 */
export function loadProjectMcpJson(cwd) {
  if (!cwd) return Promise.resolve(null);

  const mcpJsonPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    return Promise.resolve(null);
  }

  return (async () => {
    try {
      const content = await readFile(mcpJsonPath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      return null;
    }
  })();
}

/**
 * Compute a fingerprint of a project-level MCP server configuration.
 * Matches the Java implementation in McpServerManager.fingerprintOfProjectServer.
 * Uses canonical JSON serialization (sorted keys) for deterministic output.
 *
 * @param {string} projectPath - Project directory path
 * @param {string} serverId - Server ID to fingerprint
 * @returns {Promise<string>} SHA-256 hex fingerprint, or empty string if not found
 */
async function computeProjectServerFingerprint(projectPath, serverId) {
  const mcpJsonPath = join(projectPath, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    return '';
  }

  try {
    const content = await readFile(mcpJsonPath, 'utf8');
    const mcpJson = JSON.parse(content);

    if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
      return '';
    }

    const serverConfig = mcpJson.mcpServers[serverId];
    if (!serverConfig || typeof serverConfig !== 'object') {
      return '';
    }

    // Extract execution-affecting fields (matching Java implementation)
    const fingerprintData = {};

    // command
    if (typeof serverConfig.command === 'string') {
      fingerprintData.command = serverConfig.command;
    }

    // url
    if (typeof serverConfig.url === 'string') {
      fingerprintData.url = serverConfig.url;
    }

    // args (order matters)
    if (Array.isArray(serverConfig.args)) {
      fingerprintData.args = serverConfig.args.filter(arg => typeof arg === 'string');
    }

    // cwd
    if (typeof serverConfig.cwd === 'string') {
      fingerprintData.cwd = serverConfig.cwd;
    }

    // env (canonical: sorted keys)
    if (serverConfig.env && typeof serverConfig.env === 'object') {
      fingerprintData.env = {};
      Object.keys(serverConfig.env).sort().forEach(key => {
        fingerprintData.env[key] = serverConfig.env[key];
      });
    }

    // headers (canonical: sorted keys)
    if (serverConfig.headers && typeof serverConfig.headers === 'object') {
      fingerprintData.headers = {};
      Object.keys(serverConfig.headers).sort().forEach(key => {
        fingerprintData.headers[key] = serverConfig.headers[key];
      });
    }

    // type
    if (typeof serverConfig.type === 'string') {
      fingerprintData.type = serverConfig.type;
    }

    // Compute SHA-256 hash of canonical JSON
    const canonicalJson = JSON.stringify(fingerprintData, Object.keys(fingerprintData).sort());
    const hash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
    return hash;
  } catch (e) {
    log('warn', `[MCP Config] Failed to compute fingerprint for ${serverId}: ${e.message}`);
    return '';
  }
}

/**
 * Enforce approval for project-level MCP servers.
 * Uses classifyProjectServerApproval to check if a server is approved, rejected, or pending.
 * Supports both legacy format (enabledMcpjsonServers array) and new fingerprint format.
 *
 * @param {Object} mcpServers - Map of server name -> config
 * @param {string} cwd - Current working directory (project root)
 * @returns {Promise<Object>} Filtered mcpServers with only approved servers
 */
async function enforceApprovalFingerprint(mcpServers, cwd) {
  const filteredServers = {};

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    // Check if this is a project-level server (exists in .mcp.json)
    const mcpJsonPath = join(cwd, '.mcp.json');
    let isProjectServer = false;

    if (existsSync(mcpJsonPath)) {
      try {
        const mcpJsonContent = await readFile(mcpJsonPath, 'utf8');
        const mcpJson = JSON.parse(mcpJsonContent);
        if (mcpJson.mcpServers && mcpJson.mcpServers[serverName]) {
          isProjectServer = true;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    if (isProjectServer) {
      // Use classifyProjectServerApproval which handles both legacy and fingerprint formats
      const status = await classifyProjectServerApproval(serverName, cwd);

      if (status !== 'approved') {
        // Server is pending or rejected - skip it
        log('info', `[MCP Config] Server ${serverName} status: ${status}, treating as disabled`);
        continue; // Skip this server (treat as disabled)
      }

      // Server is approved
      log('info', `[MCP Config] Server ${serverName} approved`);
    }

    filteredServers[serverName] = serverConfig;
  }

  return filteredServers;
}
