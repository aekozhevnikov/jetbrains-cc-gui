import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import { MessageList } from './MessageList';
import { reconcileMessageKeys } from '../utils/messageUtils';

// Real ContextMenu + useContextMenu on purpose: this suite covers the full
// right-click-a-link → "copy link address" → write_clipboard pipeline.
vi.mock('./MessageItem', () => ({
  MessageItem: ({ message }: { message: ClaudeMessage }) => (
    <div data-testid="message-item">
      <a data-linkify="url" href="https://git.homolo.org/pr/56">{message.content}</a>
    </div>
  ),
}));
vi.mock('./WaitingIndicator', () => ({
  default: () => null,
}));
vi.mock('../utils/quoteUtils', () => ({
  quoteToChatInput: vi.fn(),
}));

const noopGetText = (m: ClaudeMessage) => m.content ?? '';
const noopGetBlocks = (_m: ClaudeMessage): ClaudeContentBlock[] => [];
const noopFindToolResult = (_id: string | undefined): ToolResultBlock | null => null;
const noopExtractMd = (_m: ClaudeMessage) => '';
const t = ((key: string, defaultValue?: string) => defaultValue ?? key) as never;

function renderList() {
  const messages = [{ type: 'assistant', content: 'MR #56', id: 'm-0' }] as unknown as ClaudeMessage[];
  return render(
    <MessageList
      messages={messages}
      messageKeys={reconcileMessageKeys(messages, undefined, 'test-session').keys}
      streamingActive={false}
      isThinking={false}
      loading={false}
      loadingStartTime={null}
      t={t}
      getMessageText={noopGetText}
      getContentBlocks={noopGetBlocks}
      findToolResult={noopFindToolResult}
      extractMarkdownContent={noopExtractMd}
      messagesEndRef={createRef<HTMLDivElement>()}
    />
  );
}

describe('MessageList link context menu', () => {
  afterEach(() => {
    cleanup();
    delete window.sendToJava;
  });

  it('opens the menu on a right-clicked link and copies its href via the bridge', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    renderList();

    fireEvent.contextMenu(screen.getByText('MR #56'));
    const item = screen.getByText('Copy Link Address');
    expect(item).toBeTruthy();
    // Right-clicking a link without any text selection must not offer
    // selection actions — there is nothing to quote or copy.
    expect(screen.queryByText('Quote')).toBeNull();
    expect(screen.queryByText('Copy')).toBeNull();
    // ContextMenu renders through a portal into document.body
    expect(document.body.querySelector('.context-menu')).toBeTruthy();

    fireEvent.click(item);
    // Bridge protocol: one "method:payload" string per call.
    expect(sendToJava).toHaveBeenCalledTimes(1);
    const bridgePayload = sendToJava.mock.calls[0][0] as string;
    expect(bridgePayload.startsWith('write_clipboard:')).toBe(true);
    expect(bridgePayload).toContain('https://git.homolo.org/pr/56');
    expect(document.body.querySelector('.context-menu')).toBeNull();
  });

  it('does not open the menu when right-clicking plain content with no selection', () => {
    renderList();
    fireEvent.contextMenu(screen.getByTestId('message-item'));
    expect(screen.queryByText('Copy Link Address')).toBeNull();
  });
});
