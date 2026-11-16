/**
 * Tools List Update Hook
 * Listens for tools list update events and handles state updates
 */

import { useEffect } from 'react';
import type { ServerToolsState, McpTool, RefreshLog, CacheKeys, McpServer } from '../types';
import { getServerCardKey } from '../utils';

export interface UseToolsUpdateOptions {
  isCodexMode: boolean;
  cacheKeys: CacheKeys;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
  serversRef: { current: McpServer[] };
}

/**
 * Tools List Update Hook
 * Registers the provider-specific MCP tools callback.
 */
export function useToolsUpdate({
  isCodexMode,
  cacheKeys,
  setServerTools,
  onLog,
  serversRef,
}: UseToolsUpdateOptions): void {
  useEffect(() => {
    // Register tools list update callback
    const handleToolsUpdate = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        const { serverId, serverName, tools, error } = result;

        if (!serverId) {
          console.warn('[MCP] Tools update missing serverId');
          return;
        }

        // Find the server to get its source for card key
        // If source is provided in the event, use it; otherwise find the server in the list
        let source = (result as any).source;
        let server = serversRef.current.find(s => s.id === serverId);

        if (!source && server) {
          source = server.source;
        }

        const cardKey = getServerCardKey({ id: serverId, source });

        const toolList: McpTool[] = (result as any).tools || [];

        // When tools are available, treat as (partial) success even if error exists
        if (toolList.length > 0) {
          window.dispatchEvent(new CustomEvent('mcp-tools-loaded', { detail: { serverId, tools: toolList } }));

          // The setServerTools will be called by the parent component
          // We just need to ensure the cache is updated
          // The parent component handles the setServerTools call via the event listener

          return;
        }

        // No tools and has error — full failure
        if (error) {
          // Error is handled by the parent component
          return;
        }

        // No tools, no error — empty result
        // Log a warning for connected servers that return no tools
        onLog(
          `Server "${serverName || serverId}" returned no tools`,
          'warning',
          undefined,
          serverName || serverId
        );
      } catch (e) {
        console.error('[MCP] Failed to parse tools update:', e);
        window.dispatchEvent(new CustomEvent('mcp-tools-error', { detail: { error: String(e) } }));
      }
    };

    if (isCodexMode) {
      window.updateCodexMcpServerTools = handleToolsUpdate;
    } else {
      window.updateMcpServerTools = handleToolsUpdate;
    }

    return () => {
      if (isCodexMode && window.updateCodexMcpServerTools === handleToolsUpdate) {
        window.updateCodexMcpServerTools = undefined;
      } else if (!isCodexMode && window.updateMcpServerTools === handleToolsUpdate) {
        window.updateMcpServerTools = undefined;
      }
    };
  }, [isCodexMode, cacheKeys, setServerTools, onLog, serversRef]);
}
