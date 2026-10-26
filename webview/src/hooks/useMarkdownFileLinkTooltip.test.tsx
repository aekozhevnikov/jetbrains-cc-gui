import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMarkdownFileLinkTooltip } from './useMarkdownFileLinkTooltip';

const resolveFilePathWithCallback = vi.fn();
vi.mock('../utils/bridge', () => ({
  resolveFilePathWithCallback: (...args: unknown[]) => resolveFilePathWithCallback(...args),
}));

function LinkSurface({ linkify, href, label }: { linkify: string; href: string; label: string }) {
  const tooltip = useMarkdownFileLinkTooltip();
  return (
    <div
      onMouseOver={tooltip.handleMouseOver}
      onMouseMove={tooltip.handleMouseMove}
      onMouseOut={tooltip.handleMouseOut}
    >
      <a data-linkify={linkify} href={href}>{label}</a>
    </div>
  );
}

const queryTooltip = () => document.body.querySelector('.file-link-tooltip');

describe('useMarkdownFileLinkTooltip', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the raw href for URL links on hover', () => {
    render(<LinkSurface linkify="url" href="https://git.homolo.org/pr/56" label="#56" />);
    fireEvent.mouseOver(screen.getByText('#56'));
    const tooltip = queryTooltip();
    expect(tooltip).toBeTruthy();
    expect(tooltip!.textContent).toBe('https://git.homolo.org/pr/56');
  });

  it('keeps the URL tooltip alive while the mouse moves within the link', () => {
    render(<LinkSurface linkify="url" href="https://example.com/a" label="link" />);
    const anchor = screen.getByText('link');
    fireEvent.mouseOver(anchor);
    fireEvent.mouseMove(anchor);
    expect(queryTooltip()).toBeTruthy();
  });

  it('hides the URL tooltip on mouseout', () => {
    render(<LinkSurface linkify="url" href="https://example.com/a" label="link" />);
    const anchor = screen.getByText('link');
    fireEvent.mouseOver(anchor);
    expect(queryTooltip()).toBeTruthy();
    fireEvent.mouseOut(anchor);
    expect(queryTooltip()).toBeNull();
  });

  it('still resolves file links through the backend and shows the resolved path', () => {
    render(<LinkSurface linkify="file" href="webview/src/App.tsx" label="App.tsx" />);
    fireEvent.mouseOver(screen.getByText('App.tsx'));
    expect(resolveFilePathWithCallback).toHaveBeenCalledWith('webview/src/App.tsx', expect.any(Function));
    const callback = resolveFilePathWithCallback.mock.calls[0][1] as (path: string) => void;
    act(() => callback('src/App.tsx'));
    expect(queryTooltip()!.textContent).toBe('src/App.tsx');
  });

  it('ignores anchors without a linkify tag', () => {
    render(<LinkSurface linkify="" href="#section" label="anchor" />);
    fireEvent.mouseOver(screen.getByText('anchor'));
    expect(queryTooltip()).toBeNull();
    expect(resolveFilePathWithCallback).not.toHaveBeenCalled();
  });
});
