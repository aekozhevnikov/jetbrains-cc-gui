import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReadToolGroupBlock from './ReadToolGroupBlock';

const bridgeMocks = vi.hoisted(() => ({
  openFile: vi.fn(),
  resolveFilePathWithCallback: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/bridge', () => ({
  openFile: bridgeMocks.openFile,
  resolveFilePathWithCallback: bridgeMocks.resolveFilePathWithCallback,
}));

describe('ReadToolGroupBlock', () => {
  it('mounts only viewport rows and overscan for a thousand reads', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      input: { file_path: `/repo/file-${index}.ts` },
    }));
    const view = render(<ReadToolGroupBlock items={items} />);
    expect(view.container.querySelectorAll('.file-list-item').length).toBeLessThanOrEqual(10);
    const list = view.container.querySelector('.file-list-container') as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 500 * 28 } });
    expect(screen.getByText('file-500.ts')).toBeTruthy();
    fireEvent.scroll(list, { target: { scrollTop: 997 * 28 } });
    expect(screen.getByText('file-999.ts')).toBeTruthy();
    expect(view.container.querySelectorAll('.file-list-item').length).toBeLessThanOrEqual(10);
  });

  it('preserves an inspected position and row identity on append, result updates and re-expansion', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      input: { file_path: `/repo/file-${index}.ts` },
    }));
    const view = render(<ReadToolGroupBlock items={items} />);
    let list = view.container.querySelector('.file-list-container') as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 500 * 28 } });
    const row = screen.getByText('file-500.ts').closest('.file-list-item');
    const appended = [...items, { input: { file_path: '/repo/file-1000.ts' } }];
    view.rerender(<ReadToolGroupBlock items={appended} />);
    expect(list.scrollTop).toBe(500 * 28);
    expect(screen.getByText('file-500.ts').closest('.file-list-item')).toBe(row);
    view.rerender(<ReadToolGroupBlock items={appended.map((item, index) => index === 500
      ? { ...item, result: { type: 'tool_result', is_error: true, content: 'failed' } } : item)} />);
    expect(row?.querySelector('.tool-status-indicator.error')).toBeTruthy();
    expect(list.scrollTop).toBe(500 * 28);
    const header = view.container.querySelector('.task-header') as HTMLElement;
    fireEvent.click(header);
    expect(view.container.querySelectorAll('.file-list-item')).toHaveLength(0);
    fireEvent.keyDown(header, { key: 'Enter' });
    list = view.container.querySelector('.file-list-container') as HTMLElement;
    expect(list.scrollTop).toBe(500 * 28);
    expect(screen.getByText('file-500.ts')).toBeTruthy();
    view.rerender(<ReadToolGroupBlock items={items.slice(0, 2)} />);
    expect(list.scrollTop).toBe(0);
    expect(screen.getByText('file-0.ts')).toBeTruthy();
  });

  it('follows appends only at the bottom and opens the correct virtual row by mouse and keyboard', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      input: { file_path: `/repo/file-${index}.ts`, offset: 10, limit: 5 },
    }));
    const view = render(<ReadToolGroupBlock items={items} />);
    const list = view.container.querySelector('.file-list-container') as HTMLElement;
    expect(list.scrollTop).toBe(997 * 28);
    view.rerender(<ReadToolGroupBlock items={[...items, { input: { file_path: '/repo/last.ts' } }]} />);
    expect(list.scrollTop).toBe(998 * 28);
    fireEvent.scroll(list, { target: { scrollTop: 500 * 28 } });
    const row = screen.getByText('file-500.ts').closest('.file-list-item') as HTMLElement;
    fireEvent.click(row);
    expect(bridgeMocks.openFile).toHaveBeenLastCalledWith('/repo/file-500.ts', 10, 14);
    fireEvent.keyDown(row, { key: ' ' });
    expect(bridgeMocks.openFile).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(row, { key: 'End' });
    expect(document.activeElement?.textContent).toContain('last.ts');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement?.textContent).toContain('file-0.ts');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('file-1.ts');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(bridgeMocks.openFile).toHaveBeenLastCalledWith('/repo/file-1.ts', 10, 14);
  });

  it('tabs through rows outside the mounted window and lets focus leave at either boundary', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      input: { file_path: `/repo/file-${index}.ts` },
    }));
    const view = render(<ReadToolGroupBlock items={items} />);
    const list = view.container.querySelector('.file-list-container') as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 500 * 28 } });
    const row = screen.getByText('file-505.ts').closest('.file-list-item') as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: 'Tab' });
    expect(document.activeElement?.textContent).toContain('file-506.ts');
    expect(list.scrollTop).toBe(504 * 28);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.textContent).toContain('file-505.ts');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true })).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })).toBe(true);
    expect(view.container.querySelectorAll('.file-list-item').length).toBeLessThanOrEqual(10);
  });

  it('starts keyboard traversal at the first record even when initially scrolled to the bottom', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      input: { file_path: `/repo/file-${index}.ts` },
    }));
    const view = render(<ReadToolGroupBlock items={items} />);
    const header = view.container.querySelector('.task-header') as HTMLElement;
    header.focus();
    fireEvent.keyDown(header, { key: 'Tab' });
    expect(document.activeElement?.textContent).toContain('file-0.ts');
    expect((view.container.querySelector('.file-list-container') as HTMLElement).scrollTop).toBe(0);
  });

  beforeEach(() => {
    bridgeMocks.openFile.mockReset();
    bridgeMocks.resolveFilePathWithCallback.mockReset();
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callback('src/App.tsx');
    });
    document.querySelectorAll('.file-link-tooltip').forEach((element) => element.remove());
  });

  it('uses custom lazy tooltip instead of native title for file rows', () => {
    render(
      <ReadToolGroupBlock
        items={[
          {
            input: { file_path: '/repo/src/App.tsx' },
            result: { type: 'tool_result', content: 'content' },
          },
        ]}
      />,
    );

    const fileRow = screen.getByText('App.tsx').closest('.file-list-item') as HTMLElement;

    expect(fileRow.getAttribute('title')).toBeNull();
    expect(bridgeMocks.resolveFilePathWithCallback).not.toHaveBeenCalled();

    fireEvent.mouseEnter(fileRow, { clientX: 10, clientY: 20 });

    expect(bridgeMocks.resolveFilePathWithCallback).toHaveBeenCalledWith('/repo/src/App.tsx', expect.any(Function));
    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe('src/App.tsx');
  });

  it('keeps a full-path tooltip for directory rows without resolving through backend', () => {
    render(
      <ReadToolGroupBlock
        items={[
          {
            input: { path: 'src/components/' },
            result: { type: 'tool_result', content: 'content' },
          },
        ]}
      />,
    );

    const directoryRow = screen.getByText('src/components/').closest('.file-list-item') as HTMLElement;

    expect(directoryRow.getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(directoryRow, { clientX: 10, clientY: 20 });

    expect(bridgeMocks.resolveFilePathWithCallback).not.toHaveBeenCalled();
    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe('src/components/');
  });
});
