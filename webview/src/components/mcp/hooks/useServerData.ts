/**
 * Server Data Loading and Initialization Hook
 * Manages loading of server list, status, and cache
 */

// Extend Window interface for custom properties
declare global {
  interface Window {
    updateMcpServers?: (json: string) => void;
    updateMcpServerStatus?: (json: string) => void;
    updateMcpServerStatusPartial?: (jsonStr: string, requestedNamesJson?: string) => void;
    updateMcpServerTools?: (json: string) => void;
    updateCodexMcpServers?: (json: string) => void;
    updateCodexMcpServerStatus?: (json: string) => void;
    updateCodexMcpServerTools?: (json: string) => void;
    refreshMcpServers?: () => void;
  }
}

import { useState, useEffect, useRef, useCallback } from 'react';
import type { McpServer, McpServerStatusInfo, ServerToolsState, RefreshLog, CacheKeys } from '../types';
import { sendToJava } from '../../../utils/bridge';
import { clearToolsCache, readCache, readToolsCache, writeCache } from '../utils';
import {getServerCardKey, isServerEnabled } from '../utils/serverUtils';

const TERMINAL_DISCONNECT_STATUSES = new Set<McpServerStatusInfo['status']>([
  'failed',
  'needs-auth',
  'disabled',
]);

function normalizeServerKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function getTerminalStatusNames(statusList: McpServerStatusInfo[]): Set<string> {
  return new Set(
    statusList.flatMap((status) => {
      if (!TERMINAL_DISCONNECT_STATUSES.has(status.status)) return [];
      const name = normalizeServerKey(status.name);
      return name ? [name] : [];
    }),
  );
}

function getTerminalServerIds(servers: McpServer[], terminalStatusNames: Set<string>): string[] {
  if (terminalStatusNames.size === 0) {
    return [];
  }

  return servers.flatMap((server) => {
    if (terminalStatusNames.has(normalizeServerKey(server.id))
      || terminalStatusNames.has(normalizeServerKey(server.name))) {
      return [server.id];
    }
    return [];
  });
}

/**
 * Strip secrets from global servers for caching.
 * Project servers keep their secrets since they're protected by approval gate.
 * Global servers have their secrets stripped because they're cached in localStorage.
 */
function toCacheableServers(servers: McpServer[]): McpServer[] {
  return servers.map((server) => {
    const spec = server.server;
    if (!spec || spec.env === undefined && spec.headers === undefined) {
      return server;
    }
    // Don't strip secrets from project servers - they're protected by approval gate
    const isProjectServer = server.source === 'project';
    if (isProjectServer) {
      return server;
    }
    const { env, headers, ...restSpec } = spec;
    return { ...server, server: restSpec };
  });
}

export interface UseServerDataOptions {
  isCodexMode: boolean;
  messagePrefix: string;
  cacheKeys: CacheKeys;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
}

export interface UseServerDataReturn {
  // State
  servers: McpServer[];
  serverStatus: Map<string, McpServerStatusInfo>;
  loading: boolean;
  statusLoading: boolean;
  serverTools: ServerToolsState;
  expandedServers: Set<string>;

  // State update functions
  setServers: React.Dispatch<React.SetStateAction<McpServer[]>>;
  setServerStatus: React.Dispatch<React.SetStateAction<Map<string, McpServerStatusInfo>>>;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  setExpandedServers: React.Dispatch<React.SetStateAction<Set<string>>>;

  // Data loading functions
  loadServers: (refreshExpandedTools?: boolean) => void;
  loadServerStatus: (serverNames?: string[]) => void;
  loadServerTools: (server: McpServer, forceRefresh?: boolean) => void;
  refreshMcpServers: () => void;
}

/**
 * Server Data Loading and Initialization Hook
 */
export function useServerData({
  isCodexMode,
  messagePrefix,
  cacheKeys,
  t,
  onLog
}: UseServerDataOptions): UseServerDataReturn {
  // State
  const [servers, setServersState] = useState<McpServer[]>([]);
  const [serverStatus, setServerStatus] = useState<Map<string, McpServerStatusInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [serverTools, setServerTools] = useState<ServerToolsState>({});
  const [expandedServers, setExpandedServersState] = useState<Set<string>>(new Set());

  // Refs
  const refreshTimersRef = useRef<number[]>([]);
  const serversRef = useRef<McpServer[]>([]);
  const expandedServersRef = useRef<Set<string>>(new Set());
  const refreshExpandedToolsRef = useRef(false);
  const refreshMcpServersRef = useRef<() => void>(() => {});
  const setExpandedServers = useCallback((value: React.SetStateAction<Set<string>>) => {
    const next = typeof value === 'function' ? value(expandedServersRef.current) : value;
    expandedServersRef.current = next;
    setExpandedServersState(next);
  }, []);
  const terminalStatusNamesRef = useRef<Set<string>>(new Set());

  const setServers = useCallback((value: React.SetStateAction<McpServer[]>) => {
    // serversRef always holds the latest list, so functional updates can be
    // resolved synchronously here instead of inside the state updater.
    const next = typeof value === 'function' ? value(serversRef.current) : value;
    serversRef.current = next;
    setServersState(next);
  }, []);

  const clearToolsForTerminalStatuses = useCallback((
      currentServers: McpServer[],
      terminalStatusNames: Set<string>,
  ) => {
    const terminalServerIds = getTerminalServerIds(currentServers, terminalStatusNames);
    if (terminalServerIds.length === 0) {
      return;
    }

    terminalServerIds.forEach((serverId) => clearToolsCache(serverId, cacheKeys));
    setServerTools((previous) => {
      const next = {...previous};
      terminalServerIds.forEach((serverId) => {
        delete next[serverId];
      });
      return next;
    });
  }, [cacheKeys]);

  // Load server list
  const loadServers = useCallback((refreshExpandedTools = false) => {
    // A plain reload must not cancel a refresh that is still waiting for its catalog.
    refreshExpandedToolsRef.current = refreshExpandedToolsRef.current || refreshExpandedTools;
    setLoading(true);
    onLog(
        t('mcp.logs.loadingServers'),
        'info',
        undefined,
        undefined,
        `get_${messagePrefix}mcp_servers request to backend`
    );
    sendToJava(`get_${messagePrefix}mcp_servers`, {});
  }, [messagePrefix, onLog]);

  // Load server status
  const loadServerStatus = useCallback((serverNames?: string[]) => {
    setStatusLoading(true);
    onLog(
        t('mcp.logs.refreshingStatus'),
        'info',
        undefined,
        undefined,
        `get_${messagePrefix}mcp_server_status request to backend`,
        `Querying MCP server connection status via ${isCodexMode ? 'Codex' : 'Claude'} SDK`
    );
    sendToJava(`get_${messagePrefix}mcp_server_status`, serverNames ? { serverNames } : {});
  }, [messagePrefix, isCodexMode, onLog]);

  // Refresh MCP servers (both list and status)
  const refreshMcpServers = useCallback(() => {
    loadServers(true);
    if (!isCodexMode) {
      loadServerStatus();
    }
  }, [loadServers, loadServerStatus, isCodexMode]);

  // Keep ref in sync for use in effects with stable dependencies
  useEffect(() => {
    refreshMcpServersRef.current = refreshMcpServers;
  }, [refreshMcpServers]);

  // Load server tools list
  const loadServerTools = useCallback((server: McpServer, forceRefresh = false) => {
      // Check cache (unless force refresh)
      if (!forceRefresh) {
        const cachedTools = readToolsCache(server.id, cacheKeys);
        if (cachedTools && cachedTools.length > 0) {
          setServerTools(prev => ({
            ...prev,
            [server.id]: {
              tools: cachedTools,
              loading: false,
              error: undefined
            }
          }));
          onLog(
              t('mcp.logs.loadedToolsFromCache', {name: server.name || server.id, count: cachedTools.length}),
              'info',
              undefined,
              server.name || server.id
          );
          return;
        }
      }

      // Set loading state
      setServerTools(prev => ({
        ...prev,
        [server.id]: {
          tools: [],
          loading: true,
          error: undefined
        }
      }));

      onLog(
          forceRefresh
              ? t('mcp.logs.forceRefreshingTools', {name: server.name || server.id})
              : t('mcp.logs.loadingTools', {name: server.name || server.id}),
          'info',
          undefined,
          server.name || server.id,
          `get_${messagePrefix}mcp_server_tools request to backend`
      );

      sendToJava(`get_${messagePrefix}mcp_server_tools`, {serverId: server.id, forceRefresh});
    }, [cacheKeys, messagePrefix, t, onLog]);

    // Initialization and data loading
    useEffect(() => {
      const clearRefreshTimers = () => {
        refreshTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
        refreshTimersRef.current = [];
      };

      // Load data from cache
      const loadFromCache = (): boolean => {
        terminalStatusNamesRef.current = new Set();
        const cachedServers = readCache<McpServer[]>(cacheKeys.SERVERS, cacheKeys);
        const hasValidCache = !!cachedServers && cachedServers.length > 0;

        if (hasValidCache) {
          setServers(cachedServers);
          setLoading(false);
          let cachedAt = 0;
          try {
            const parsed: unknown = JSON.parse(localStorage.getItem(cacheKeys.SERVERS) || '{}');
            if (parsed && typeof parsed === 'object' && 'timestamp' in parsed && typeof parsed.timestamp === 'number') {
              cachedAt = parsed.timestamp;
            }
          } catch {
            // Malformed cache payload — treat as cache with no timestamp.
          }
          const cacheAge = Date.now() - cachedAt;
          if (cacheAge < 60000) {
            onLog(t('mcp.logs.fastLoadCache', {
              count: cachedServers.length,
              seconds: Math.round(cacheAge / 1000)
            }), 'info');
          }
        }

        if (!isCodexMode) {
          const cachedStatus = readCache<McpServerStatusInfo[]>(cacheKeys.STATUS, cacheKeys);
          if (cachedStatus && cachedStatus.length > 0) {
            const terminalStatusNames = getTerminalStatusNames(cachedStatus);
            terminalStatusNamesRef.current = terminalStatusNames;
            clearToolsForTerminalStatuses(cachedServers || [], terminalStatusNames);
            const statusMap = new Map<string, McpServerStatusInfo>();
            cachedStatus.forEach((status) => {
              statusMap.set(status.name, status);
            });
            setServerStatus(statusMap);
            setStatusLoading(false);
          }
        }

        // Restore last expanded server
        if (hasValidCache) {
          try {
            const lastServerCardKey = localStorage.getItem(cacheKeys.LAST_SERVER_ID);
            if (lastServerCardKey) {
              // Check if the stored key is a bare ID (no ::project suffix) or a full card key
              const isBareId = !lastServerCardKey.includes('::project');

              let matchedServer: McpServer | undefined;

              if (isBareId) {
                // For bare IDs, find all servers with matching bare ID
                const matchingServers = cachedServers.filter(s => s.id === lastServerCardKey);
                // Only restore if exactly one server matches (no ambiguity)
                if (matchingServers.length === 1) {
                  matchedServer = matchingServers[0];
                }
                // If multiple match (ambiguity), don't restore anything
              } else {
                // For full card keys, match exactly
                matchedServer = cachedServers.find(s => getServerCardKey(s) === lastServerCardKey);
              }

              if (matchedServer) {
                const cardKey = getServerCardKey(matchedServer);
                setExpandedServers(new Set([cardKey]));
                const cachedTools = readToolsCache(matchedServer.id, cacheKeys);
                if (cachedTools && cachedTools.length > 0) {
                  setServerTools(prev => ({
                    ...prev,
                    [cardKey]: {
                      tools: cachedTools,
                      loading: false,
                      error: undefined
                    }
                  }));
                  onLog(t('mcp.logs.loadedToolsFromCacheSimple', {count: cachedTools.length}), 'info', undefined, matchedServer.id);
                }
              }
            }
          } catch (e) {
            console.warn('[MCP] Failed to restore last expanded server:', e);
          }
        }

        return hasValidCache;
      };

      // A refresh from a previous provider cannot request tools in this catalog.
      refreshExpandedToolsRef.current = false;
      // Try loading data from cache first
      const hasCache = loadFromCache();

      if (hasCache) {
        onLog(t('mcp.logs.usingCacheStrategy'), 'info');
        // Even with a cache hit, fire a background request to get the full
        // server data (including env/headers that are stripped from the cache).
        // This ensures the UI shows complete data without blocking on the first load.
        loadServers();
        if (!isCodexMode) {
          loadServerStatus();
        }
      } else {
        onLog(t('mcp.logs.firstLoad'), 'info');
        loadServers();
        loadServerStatus();
      }

      return () => {
        clearRefreshTimers();
      };
    }, [cacheKeys, isCodexMode, loadServers, loadServerStatus, onLog, clearToolsForTerminalStatuses, setExpandedServers]);

    // Register server list update callback
    useEffect(() => {
      const handleServerListUpdate = (jsonStr: string) => {
        try {
          const serverList: McpServer[] = JSON.parse(jsonStr);
          setServers(serverList);
          clearToolsForTerminalStatuses(serverList, terminalStatusNamesRef.current);
          setLoading(false);
          // Persist to cache so subsequent mounts can load instantly
          // Secrets from global servers are stripped; project servers keep their secrets.
          writeCache(cacheKeys.SERVERS, toCacheableServers(serverList));
          onLog(t('mcp.logs.loadedServersSuccess', {count: serverList.length}), 'success');
          if (refreshExpandedToolsRef.current) {
            refreshExpandedToolsRef.current = false;
            const expanded = serverList.find(server => expandedServersRef.current.has(server.id));
            if (expanded && isServerEnabled(expanded, isCodexMode)) loadServerTools(expanded, true);
          }
        } catch (error) {
          refreshExpandedToolsRef.current = false;
          console.error('[McpSettings] Failed to parse servers:', error);
          setLoading(false);
          onLog(t('mcp.logs.loadedServersFailed', {error: String(error)}), 'error');
        }
      };

      const handleServerStatusUpdate = (jsonStr: string) => {
        try {
          const statusList: McpServerStatusInfo[] = JSON.parse(jsonStr);
          const statusMap = new Map<string, McpServerStatusInfo>();
          statusList.forEach((status) => {
            statusMap.set(status.name, status);
          });
          setServerStatus(statusMap);
          const terminalStatusNames = getTerminalStatusNames(statusList);
          terminalStatusNamesRef.current = terminalStatusNames;
          clearToolsForTerminalStatuses(serversRef.current, terminalStatusNames);
          setStatusLoading(false);
          // Persist status to cache
          writeCache(cacheKeys.STATUS, statusList);

          const statusCount = {
            connected: statusList.filter(s => s.status === 'connected').length,
            failed: statusList.filter(s => s.status === 'failed').length,
            pending: statusList.filter(s => s.status === 'pending').length,
            needsAuth: statusList.filter(s => s.status === 'needs-auth').length
          };

          onLog(
              t('mcp.logs.statusUpdateComplete', {
                total: statusList.length,
                connected: statusCount.connected,
                failed: statusCount.failed,
                pending: statusCount.pending,
                needsAuth: statusCount.needsAuth
              }),
              statusCount.failed > 0 ? 'warning' : 'success'
          );
        } catch (error) {
          console.error('[McpSettings] Failed to parse server status:', error);
          setStatusLoading(false);
          onLog(t('mcp.logs.loadedStatusFailed', {error: String(error)}), 'error');
        }
      };

      const handleServerStatusPartialUpdate = (jsonStr: string, requestedNamesJson?: string) => {
        try {
          const statusList: McpServerStatusInfo[] = JSON.parse(jsonStr);
          let requestedNames: string[] | undefined;
          if (requestedNamesJson) {
            requestedNames = JSON.parse(requestedNamesJson);
          }

          setServerStatus(prevStatusMap => {
            const nextStatusMap = new Map(prevStatusMap);

            if (requestedNames && requestedNames.length > 0) {
              // Targeted update: only the requested names are affected
              if (statusList.length === 0) {
                // Empty response for targeted check - drop the requested names
                requestedNames.forEach(name => nextStatusMap.delete(name));
              } else {
                // Merge the partial update for requested names
                statusList.forEach((status) => {
                  if (requestedNames.includes(status.name)) {
                    nextStatusMap.set(status.name, status);
                  }
                });
              }
            } else {
              // Full update (no name filter): merge all entries
              statusList.forEach((status) => {
                nextStatusMap.set(status.name, status);
              });
            }

            // Persist the merged status to cache
            const mergedStatusList: McpServerStatusInfo[] = [];
            nextStatusMap.forEach((status) => mergedStatusList.push(status));
            writeCache(cacheKeys.STATUS, mergedStatusList);

            return nextStatusMap;
          });

          // Update terminal status names and clear tools if needed
          const terminalStatusNames = getTerminalStatusNames(statusList);
          terminalStatusNamesRef.current = terminalStatusNames;
          clearToolsForTerminalStatuses(serversRef.current, terminalStatusNames);

        } catch (error) {
          console.error('[McpSettings] Failed to parse partial server status:', error);
          onLog(t('mcp.logs.loadedStatusFailed', {error: String(error)}), 'error');
        }
      };

      // Register callbacks
      if (isCodexMode) {
        window.updateCodexMcpServers = handleServerListUpdate;
        window.updateCodexMcpServerStatus = handleServerStatusUpdate;
        window.updateCodexMcpServerStatusPartial = handleServerStatusPartialUpdate;
        window.refreshMcpServers = refreshMcpServersRef.current;
      } else {
        window.updateMcpServers = handleServerListUpdate;
        window.updateMcpServerStatus = handleServerStatusUpdate;
        window.updateMcpServerStatusPartial = handleServerStatusPartialUpdate;
        window.refreshMcpServers = refreshMcpServersRef.current;
      }

      return () => {
        if (isCodexMode) {
          window.updateCodexMcpServers = undefined;
          window.updateCodexMcpServerStatus = undefined;
          window.updateCodexMcpServerStatusPartial = undefined;
          window.refreshMcpServers = undefined;
        } else {
          window.updateMcpServers = undefined;
          window.updateMcpServerStatus = undefined;
          window.updateMcpServerStatusPartial = undefined;
          window.refreshMcpServers = undefined;
        }
      };
    }, [isCodexMode, onLog, clearToolsForTerminalStatuses, setServers, loadServerTools]);

    return {
      // State
      servers,
      serverStatus,
      loading,
      statusLoading,
      serverTools,
      expandedServers,

      // State update functions
      setServers,
      setServerStatus,
      setServerTools,
      setExpandedServers,

      // Data loading functions
      loadServers,
      loadServerStatus,
      loadServerTools,
      refreshMcpServers,
    }
  }
