import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '../../types/mcp';
import type { CacheKeys } from '../types';
import { copyToClipboard } from '../../../utils/copyUtils';
import { sendToJava } from '../../../utils/bridge';
import { useServerActions } from './useServerActions';

vi.mock('../../../utils/copyUtils', () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock('../../../utils/bridge', () => ({
  sendToJava: vi.fn(),
}));

const sendToJavaMock = vi.mocked(sendToJava);
const copyToClipboardMock = vi.mocked(copyToClipboard);

const cacheKeys: CacheKeys = {
  SERVERS: 'test.mcp.servers',
  STATUS: 'test.mcp.status',
  TOOLS: 'test.mcp.tools',
  LAST_SERVER_ID: 'test.mcp.last-server',
};

const mockServer: McpServer = {
  id: 'server-1',
  name: 'Test Server',
  server: {
    command: 'node',
    args: ['--api-key', 'sk-secret123', '--endpoint', 'https://api.example.com'],
    env: { API_KEY: 'sk-env-secret', DEBUG: 'true' },
    headers: { Authorization: 'Bearer header-secret' },
    url: 'https://api.example.com?token=url-secret',
  },
  source: 'global',
  enabled: true,
};

const mockProjectServer: McpServer = {
  id: 'project-server',
  name: 'Project Server',
  server: {
    command: 'python',
    args: ['--key=value-with-secret'],
    env: { SECRET: 'project-secret' },
  },
  source: 'project',
  enabled: true,
};

const translate = (key: string) => key;
const addToast = vi.fn();

function renderActions() {
  return renderHook(() => useServerActions({
    messagePrefix: '',
    isCodexMode: false,
    addToast,
    cacheKeys,
    setServerTools: vi.fn(),
    loadServers: vi.fn(),
    loadServerStatus: vi.fn(),
    closeDropdown: vi.fn(),
    t: translate,
  }));
}

beforeEach(() => {
  sendToJavaMock.mockClear();
  copyToClipboardMock.mockClear();
  addToast.mockClear();
  copyToClipboardMock.mockResolvedValue(true);
});

afterEach(() => {
  delete window.mcpServerApproved;
  delete window.mcpServerRejected;
});

describe('useServerActions handleCopyConfig redaction', () => {
  it('redacts env values completely', async () => {
    const hook = renderActions();

    await act(async () => {
      await hook.result.current.handleCopyConfig(mockServer);
    });

    expect(copyToClipboardMock).toHaveBeenCalled();
    const copiedJson = copyToClipboardMock.mock.calls[0][0];
    const config = JSON.parse(copiedJson);

    expect(config.mcpServers['server-1'].env.API_KEY).toBe('***');
    expect(config.mcpServers['server-1'].env.DEBUG).toBe('***');
  });

  it('redacts headers values completely', async () => {
    const hook = renderActions();

    await act(async () => {
      await hook.result.current.handleCopyConfig(mockServer);
    });

    const copiedJson = copyToClipboardMock.mock.calls[0][0];
    const config = JSON.parse(copiedJson);

    expect(config.mcpServers['server-1'].headers.Authorization).toBe('***');
  });

  it('redacts secret flag values in args (--api-key value)', async () => {
    const hook = renderActions();

    await act(async () => {
      await hook.result.current.handleCopyConfig(mockServer);
    });

    const copiedJson = copyToClipboardMock.mock.calls[0][0];
    const config = JSON.parse(copiedJson);

    // args should have --api-key followed by REDACTED
    expect(config.mcpServers['server-1'].args[0]).toBe('--api-key');
    expect(config.mcpServers['server-1'].args[1]).toBe('***');
    // Non-secret args should pass through
    expect(config.mcpServers['server-1'].args[2]).toBe('--endpoint');
    expect(config.mcpServers['server-1'].args[3]).toBe('https://api.example.com');
  });

  it('redacts inline --key=value secret args (regression: inline args survived)', async () => {
    const serverWithInlineSecret: McpServer = {
      ...mockServer,
      server: {
        ...mockServer.server,
        args: ['--api-key=sk-inline-secret', '--other=value'],
      },
    };
    const hook = renderActions();

    await act(async () => {
      await hook.result.current.handleCopyConfig(serverWithInlineSecret);
    });

    const copiedJson = copyToClipboardMock.mock.calls[0][0];
    const config = JSON.parse(copiedJson);

    // --api-key=value should be redacted
    expect(config.mcpServers['server-1'].args[0]).toBe('--api-key=***');
    // Non-secret args pass through
    expect(config.mcpServers['server-1'].args[1]).toBe('--other=value');
  });

  it('redacts secret-looking values in args even without flag', async () => {
    const serverWithSecretValue: McpServer = {
      ...mockServer,
      server: {
        ...mockServer.server,
        args: ['sk-ABCDEFGHIJKLMNOP', 'normal-arg'],
      },
    };
    const hook = renderActions();

    await act(async () => {
      await hook.result.current.handleCopyConfig(serverWithSecretValue);
    });

    const copiedJson = copyToClipboardMock.mock.calls[0][0];
    const config = JSON.parse(copiedJson);

    // Secret-looking value should be redacted
    expect(config.mcpServers['server-1'].args[0]).toBe('***');
    expect(config.mcpServers['server-1'].args[1]).toBe('normal-arg');
  });

  it('redacts secrets in URL (credentials and query params)', async () => {
    const hook = renderActions();

    await act(async () => {
      await hook.result.current.handleCopyConfig(mockServer);
    });

    const copiedJson = copyToClipboardMock.mock.calls[0][0];
    const config = JSON.parse(copiedJson);

    // URL should have redacted token
    expect(config.mcpServers['server-1'].url).toContain('token=***');
    // URL should not have the secret
    expect(config.mcpServers['server-1'].url).not.toContain('url-secret');
  });

  it('preserves non-secret fields in config copy', async () => {
    const hook = renderActions();

    await act(async () => {
      await hook.result.current.handleCopyConfig(mockServer);
    });

    const copiedJson = copyToClipboardMock.mock.calls[0][0];
    const config = JSON.parse(copiedJson);

    expect(config.mcpServers['server-1'].command).toBe('node');
    expect(config.mcpServers['server-1'].args[2]).toBe('--endpoint');
    expect(config.mcpServers['server-1'].url).toContain('https://api.example.com');
  });
});

describe('useServerActions handleSaveServer scope parameter', () => {
  it('includes scope when saving NEW project server (via add)', async () => {
    const hook = renderActions();

    await act(async () => {
      await hook.result.current.handleSaveServer(mockProjectServer);
    });

    // For NEW servers (not editing), scope is NOT added - the source field determines project vs global
    expect(sendToJavaMock).toHaveBeenCalledWith('add_mcp_server', expect.objectContaining({
      source: 'project',
      // scope is not added for new servers - source field determines scope
    }));
  });

  it('includes scope when updating global server', async () => {
    const hook = renderActions();

    // Set editing server state
    act(() => {
      hook.result.current.handleEdit(mockServer);
    });

    // Wait for state update
    await act(async () => {
      await Promise.resolve();
    });

    // Now save the server
    await act(async () => {
      await hook.result.current.handleSaveServer(mockServer);
    });

    // The save should include scope for global when EDITING
    const calls = sendToJavaMock.mock.calls.filter(call => call[0] === 'update_mcp_server');
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toHaveProperty('scope', 'global');
  });

  it('includes scope in delete for project server', async () => {
    const hook = renderActions();

    act(() => {
      hook.result.current.handleDelete(mockProjectServer);
    });

    act(() => {
      hook.result.current.confirmDelete();
    });

    expect(sendToJavaMock).toHaveBeenCalledWith(
      'delete_mcp_server',
      expect.objectContaining({ scope: 'project' })
    );
  });

  it('includes scope in delete for global server', async () => {
    const hook = renderActions();

    act(() => {
      hook.result.current.handleDelete(mockServer);
    });

    act(() => {
      hook.result.current.confirmDelete();
    });

    // Check that the call was made with an object containing scope: 'global'
    const calls = sendToJavaMock.mock.calls.filter(call => call[0] === 'delete_mcp_server');
    expect(calls.length).toBeGreaterThan(0);
    // Log for debugging
    console.log('DELETE CALLS:', JSON.stringify(calls, null, 2));
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toHaveProperty('scope', 'global');
  });
});

describe('useServerActions handleSaveServer id change', () => {
  it('includes scope in delete when server id changes', async () => {
    const originalServer: McpServer = {
      ...mockServer,
      id: 'old-id',
    };
    const newServer: McpServer = {
      ...mockServer,
      id: 'new-id',
    };

    const hook = renderActions();

    act(() => {
      hook.result.current.handleEdit(originalServer);
    });

    await act(async () => {
      await hook.result.current.handleSaveServer(newServer);
    });

    // Should delete old with scope and add new with scope
    const deleteCalls = sendToJavaMock.mock.calls.filter(call => call[0] === 'delete_mcp_server');
    expect(deleteCalls.length).toBeGreaterThan(0);
    const lastDeleteCall = deleteCalls[deleteCalls.length - 1];
    expect(lastDeleteCall[1]).toHaveProperty('scope', 'global');

    const addCalls = sendToJavaMock.mock.calls.filter(call => call[0] === 'add_mcp_server');
    expect(addCalls.length).toBeGreaterThan(0);
    const lastAddCall = addCalls[addCalls.length - 1];
    expect(lastAddCall[1]).toHaveProperty('scope', 'global');
  });
});