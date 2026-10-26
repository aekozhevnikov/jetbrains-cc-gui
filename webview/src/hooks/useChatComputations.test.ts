import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ClaudeMessage } from '../types';
import { sliceLatestConversationTurn } from '../utils/turnScope';
import { deriveSessionTitle, deriveTodosForTurn, useChatComputations } from './useChatComputations';

interface TestMessage extends ClaudeMessage {
  __blocks?: ClaudeContentBlock[];
}

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] =>
  (message as TestMessage).__blocks ?? [];

const user = (content: string): ClaudeMessage => ({ type: 'user', content });

const assistant = (blocks: ClaudeContentBlock[]): ClaudeMessage =>
  ({ type: 'assistant', __blocks: blocks }) as TestMessage;

const toolUse = (id: string, name: string, input: Record<string, unknown>): ClaudeContentBlock =>
  ({ type: 'tool_use', id, name, input });

describe('session tool result snapshots', () => {
  afterEach(cleanup);
  const resultMessage = (id: string, content: string, isError = false): ClaudeMessage => ({
    type: 'user',
    raw: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  });
  const translate = ((key: string) => key) as TFunction;
  const text = (message: ClaudeMessage) => message.content ?? '';
  const blocks = (message: ClaudeMessage): ClaudeContentBlock[] => {
    const raw = message.raw;
    const content = raw && typeof raw === 'object' ? raw.content ?? raw.message?.content : null;
    return Array.isArray(content)
      ? content.filter((block): block is ClaudeContentBlock => block.type !== 'tool_result')
      : [];
  };
  const histories = {};
  const sessionRef = { current: 'session-a' };
  const mount = (messages: ClaudeMessage[]) => renderHook(
    ({ messages: current, sessionId }) => useChatComputations({
      t: translate, messages: current, mergedMessages: current,
      subagentHistories: histories, customSessionTitle: null, restoredSessionTitle: null,
      streamingActive: true, currentProvider: 'claude', currentSessionId: sessionId,
      currentSessionIdRef: sessionRef, getMessageText: text, getContentBlocks: blocks,
    }),
    { initialProps: { messages, sessionId: 'session-a' } },
  );

  it('keeps lookups stable across 30 text deltas while pending lookups stay empty', () => {
    const completed = resultMessage('done', 'ok');
    const { result, rerender } = mount([completed]);
    const lookup = result.current.findToolResult;
    const rawLookup = result.current.getToolResultRaw;
    for (let index = 0; index < 30; index += 1) {
      rerender({ messages: [completed, { type: 'assistant', content: 'x'.repeat(index + 1) }], sessionId: 'session-a' });
      expect(result.current.findToolResult).toBe(lookup);
      expect(result.current.getToolResultRaw).toBe(rawLookup);
      expect(lookup('pending', 0)).toBeNull();
    }
  });

  it('replaces revised results without mutating previously captured snapshots', () => {
    const initial = resultMessage('tool', 'initial');
    const { result, rerender } = mount([initial]);
    const oldLookup = result.current.findToolResult;
    expect(oldLookup('tool', 0)?.content).toBe('initial');
    const revised = resultMessage('tool', 'denied', true);
    rerender({ messages: [revised], sessionId: 'session-a' });
    expect(result.current.findToolResult('tool', 0)).toMatchObject({ content: 'denied', is_error: true });
    expect(result.current.getToolResultRaw('tool')).toBe(revised.raw);
    expect(oldLookup('tool', 0)?.content).toBe('initial');
  });

  it('releases old results on reset and does not reuse IDs across sessions', () => {
    const { result, rerender } = mount([resultMessage('tool', 'session A')]);
    result.current.findToolResult('tool', 0);
    rerender({ messages: [], sessionId: 'session-a' });
    expect(result.current.getToolResultRaw('tool')).toBeNull();
    rerender({ messages: [resultMessage('tool', 'session B')], sessionId: 'session-b' });
    expect(result.current.findToolResult('tool', 0)?.content).toBe('session B');
  });

  it('retains loaded results when older history is prepended', () => {
    const recent = resultMessage('recent', 'new');
    const { result, rerender } = mount([recent]);
    rerender({ messages: [resultMessage('older', 'old'), recent], sessionId: 'session-a' });
    expect(result.current.findToolResult('older', 0)?.content).toBe('old');
    expect(result.current.findToolResult('recent', 1)?.content).toBe('new');
    expect(result.current.findToolResult(undefined, 0)).toBeNull();
    expect(result.current.findToolResult('recent')).toBeNull();
  });

  it('uses a later result revision without confusing identical content from another tool', () => {
    const original = resultMessage('tool', 'pending output');
    const unrelated = resultMessage('other', 'pending output');
    const { result, rerender } = mount([original, unrelated]);
    const revised = resultMessage('tool', 'denied', true);
    rerender({ messages: [original, unrelated, revised], sessionId: 'session-a' });
    expect(result.current.findToolResult('tool', 0)).toMatchObject({ content: 'denied', is_error: true });
    expect(result.current.getToolResultRaw('tool')).toBe(revised.raw);
    expect(result.current.getToolResultRaw('other')).toBe(unrelated.raw);
    rerender({ messages: [resultMessage('tool', 'older history'), original, unrelated, revised], sessionId: 'session-a' });
    expect(result.current.findToolResult('tool', 0)?.content).toBe('denied');
  });
});

describe('deriveTodosForTurn', () => {
  it('does not carry a completed plan into a new user turn', () => {
    const messages = [
      user('previous request'),
      assistant([
        toolUse('plan-1', 'update_plan', {
          plan: Array.from({ length: 5 }, (_, index) => ({
            step: `Previous step ${index + 1}`,
            status: 'completed',
          })),
        }),
      ]),
      user('Only answer OK'),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true, 'codex')).toEqual([]);
  });

  it('does not revive an earlier Codex plan after a later turn settles', () => {
    const messages = [
      user('previous request'),
      assistant([
        toolUse('plan-1', 'update_plan', {
          plan: [
            { step: 'Inspect existing UI', status: 'in_progress' },
            { step: 'Implement page', status: 'pending' },
            { step: 'Verify integration', status: 'pending' },
          ],
        }),
      ]),
      user('follow-up request without a plan'),
      assistant([]),
    ];

    expect(deriveTodosForTurn(messages, getContentBlocks, false, 'codex')).toEqual([]);
  });

  it('shows the latest plan created in the current turn', () => {
    const messages = [
      user('previous request'),
      assistant([toolUse('old-plan', 'update_plan', {
        plan: [{ step: 'Old step', status: 'completed' }],
      })]),
      user('new request'),
      assistant([toolUse('new-plan', 'update_plan', {
        plan: [
          { step: 'First', status: 'in_progress' },
          { step: 'Second', status: 'pending' },
          { step: 'Third', status: 'pending' },
        ],
      })]),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true, 'codex')).toEqual([
      { content: 'First', status: 'in_progress' },
      { content: 'Second', status: 'pending' },
      { content: 'Third', status: 'pending' },
    ]);
  });

  it('does not carry completed structured tasks into a new user turn', () => {
    const messages = [
      user('previous request'),
      assistant([toolUse('task-create-1', 'TaskCreate', { subject: 'Previous task' })]),
      {
        type: 'user',
        raw: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-create-1',
            content: 'Task #1 created successfully',
          }],
        },
      } as ClaudeMessage,
      assistant([toolUse('task-update-1', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
      user('Only answer OK'),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true, 'claude')).toEqual([]);
  });

  it('keeps earlier todos when the full transcript is scoped (settled history replay)', () => {
    // Non-streaming scope feeds the WHOLE transcript to deriveTodosForTurn, so an
    // earlier turn's plan survives even when the last turn has no task tool —
    // exactly what a resumed history session needs to render its task list.
    const messages = [
      user('previous request'),
      assistant([toolUse('old-plan', 'update_plan', {
        plan: [
          { step: 'Kept step', status: 'completed' },
          { step: 'In-flight step', status: 'in_progress' },
        ],
      })]),
      user('Only answer OK'),
    ];

    expect(deriveTodosForTurn(messages, getContentBlocks, false, 'claude')).toEqual([
      { content: 'Kept step', status: 'completed' },
      { content: 'In-flight step', status: 'completed' },
    ]);
  });

  it('preserves Codex in-progress plan state after streaming settles', () => {
    const messages = [
      user('implement the fix'),
      assistant([toolUse('plan-1', 'update_plan', {
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Implement', status: 'in_progress' },
        ],
      })]),
    ];

    expect(deriveTodosForTurn(messages, getContentBlocks, false, 'codex')).toEqual([
      { content: 'Inspect', status: 'completed' },
      { content: 'Implement', status: 'in_progress' },
    ]);
  });

  it.each([
    ['update_plan', { plan: [] }],
    ['TodoWrite', { todos: [] }],
  ])('treats a Codex empty %s snapshot as clearing the previous plan', (name, input) => {
    const messages = [
      user('implement the fix'),
      assistant([toolUse('plan-1', 'update_plan', {
        plan: [{ step: 'Old step', status: 'in_progress' }],
      })]),
      assistant([toolUse('plan-2', name, input)]),
    ];

    expect(deriveTodosForTurn(messages, getContentBlocks, false, 'codex')).toEqual([]);
  });

  it('lets Claude structured tasks survive an empty TodoWrite snapshot', () => {
    const messages = [
      user('implement the fix'),
      assistant([toolUse('legacy-todos', 'TodoWrite', {
        todos: [{ content: 'Legacy task', status: 'in_progress' }],
      })]),
      assistant([toolUse('task-create-1', 'TaskCreate', { subject: 'Review implementation' })]),
      {
        type: 'user',
        raw: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-create-1',
            content: 'Task #1 created successfully',
          }],
        },
      } as ClaudeMessage,
      assistant([toolUse('empty-todos', 'TodoWrite', { todos: [] })]),
    ];

    expect(deriveTodosForTurn(messages, getContentBlocks, false, 'claude')).toEqual([
      { id: '1', content: 'Review implementation', status: 'pending' },
    ]);
  });
});

describe('deriveSessionTitle', () => {
  const messageText = (message: ClaudeMessage) => message.content ?? '';
  const derive = (overrides: Partial<Parameters<typeof deriveSessionTitle>[0]> = {}) => deriveSessionTitle({
    customSessionTitle: null,
    restoredSessionTitle: null,
    currentSessionId: null,
    messages: [],
    fallbackTitle: 'New Session',
    getMessageText: messageText,
    ...overrides,
  });

  it('prefers a user-set custom title over every other source', () => {
    expect(derive({
      customSessionTitle: 'Renamed by hand',
      restoredSessionTitle: { sessionId: 's1', title: 'CLI title' },
      currentSessionId: 's1',
      messages: [user('first prompt')],
    })).toBe('Renamed by hand');
  });

  it('prefers the CLI title of the session on screen over prompt derivation', () => {
    expect(derive({
      restoredSessionTitle: { sessionId: 's1', title: 'CLI title' },
      currentSessionId: 's1',
      messages: [user('mid-conversation prompt')],
    })).toBe('CLI title');
  });

  it('ignores a CLI title belonging to another session', () => {
    expect(derive({
      restoredSessionTitle: { sessionId: 'other', title: 'CLI title' },
      currentSessionId: 's1',
      messages: [user('first prompt')],
    })).toBe('first prompt');
  });

  it('falls back to the new-session label when nothing can title the session', () => {
    expect(derive({ messages: [{ type: 'assistant', content: 'hi' }] })).toBe('New Session');
  });

  it('skips tool-result carriers so a paginated page never titles from a tool row', () => {
    // The carrier's rendered text is not the "[tool_result]" marker, so only the
    // raw block type identifies it.
    const carrier: ClaudeMessage = {
      type: 'user',
      content: 'Bash tool output preview',
      raw: { message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    };
    expect(derive({ messages: [carrier, user('real prompt')] })).toBe('real prompt');
  });

  it('skips meta rows and internal XML wrappers', () => {
    expect(derive({
      messages: [
        { type: 'user', content: 'caveat', raw: { isMeta: true } } as ClaudeMessage,
        user('<local-command-caveat>noise</local-command-caveat>'),
        user('real prompt'),
      ],
    })).toBe('real prompt');
  });

  it('truncates a long prompt to the header budget', () => {
    expect(derive({ messages: [user('abcdefghijklmnopqrstuvwxyz')] })).toBe('abcdefghijklmno...');
  });
});
