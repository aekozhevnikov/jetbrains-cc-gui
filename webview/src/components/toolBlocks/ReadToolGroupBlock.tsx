import { useState, useMemo, useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { openFile } from '../../utils/bridge';
import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';
import { getToolLineInfo, resolveToolTarget } from '../../utils/toolPresentation';

interface FileItem {
  key: string;
  filePath: string;
  displayPath: string;
  cleanFileName: string;
  openPath: string;
  isDirectory: boolean;
  lineInfo?: string;
  lineStart?: number;
  lineEnd?: number;
  isCompleted: boolean;
  isError: boolean;
}

interface ReadToolGroupBlockProps {
  items: Array<{
    id?: string;
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
  }>;
}

/** Max visible items before scroll */
const MAX_VISIBLE_ITEMS = 3;
/** Height per item in pixels */
const ITEM_HEIGHT = 28;
const OVERSCAN = 3;

const TITLE_SECTION_STYLE: React.CSSProperties = { overflow: 'hidden' };

const TITLE_TEXT_STYLE: React.CSSProperties = { flexShrink: 0 };

const TITLE_SUMMARY_STYLE: React.CSSProperties = {
  color: 'var(--text-secondary)',
  marginLeft: '4px',
  flexShrink: 0,
};

const FILE_ICON_STYLE: React.CSSProperties = {
  marginRight: '8px',
  display: 'flex',
  alignItems: 'center',
  width: '16px',
  height: '16px',
  flexShrink: 0,
};

const FILE_NAME_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  minWidth: 0,
};

const LINE_INFO_STYLE: React.CSSProperties = {
  marginLeft: '8px',
  fontSize: '11px',
  color: 'var(--text-tertiary, var(--text-secondary))',
  flexShrink: 0,
  opacity: 0.8,
};

const STATUS_INDICATOR_STYLE: React.CSSProperties = { marginLeft: '8px' };

function getFileListItemStyle(isDirectory: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 8px',
    borderRadius: '4px',
    cursor: isDirectory ? 'default' : 'pointer',
    transition: 'background-color 0.15s ease',
    minHeight: `${ITEM_HEIGHT}px`,
    height: `${ITEM_HEIGHT}px`,
    boxSizing: 'border-box',
    flexShrink: 0,
  };
}

/**
 * Parse item to FileItem
 */
const parseFileItem = (item: { input?: ToolInput; result?: ToolResultBlock | null }): Omit<FileItem, 'key'> | null => {
  const input = item.input;
  if (!input) return null;

  const target = resolveToolTarget(input, 'read');
  if (!target) return null;

  const lineInfoValue = getToolLineInfo(input, target);
  const lineInfo = lineInfoValue.start
    ? (lineInfoValue.end && lineInfoValue.end !== lineInfoValue.start
      ? `L${lineInfoValue.start}-${lineInfoValue.end}`
      : `L${lineInfoValue.start}`)
    : '';

  // Determine completion status
  const isCompleted = item.result !== undefined && item.result !== null;
  const isError = isCompleted && item.result?.is_error === true;

  return {
    filePath: target.rawPath,
    displayPath: target.displayPath,
    cleanFileName: target.cleanFileName,
    openPath: target.openPath,
    isDirectory: target.isDirectory,
    lineInfo,
    lineStart: lineInfoValue.start,
    lineEnd: lineInfoValue.end,
    isCompleted,
    isError,
  };
};

/**
 * Get file icon SVG by file name (with extension).
 */
const getFileIconSvg = (fileName: string, isDirectory: boolean) => {
  if (isDirectory) {
    return getFolderIcon(fileName.replace(/\/$/, ''));
  }
  const cleanName = fileName.replace(/:\d+(-\d+)?$/, '');
  const extension = cleanName.includes('.') ? cleanName.split('.').pop() : '';
  return getFileIcon(extension ?? '', cleanName);
};

interface FileListItemProps {
  item: FileItem;
  index: number;
  onFileClick: (openPath: string, isDirectory: boolean, e: React.MouseEvent, lineStart?: number, lineEnd?: number) => void;
}

const FileListItem = ({ item, index, onFileClick }: FileListItemProps) => {
  const fileLinkTooltip = useResolvedFileLinkTooltip(
    !item.isDirectory ? item.filePath : undefined,
    item.displayPath,
  );

  return (
    <div
      className={`file-list-item ${!item.isDirectory ? 'clickable-file' : ''}`}
      data-index={index}
      role={item.isDirectory ? undefined : 'button'}
      tabIndex={0}
      onClick={(e) => onFileClick(item.openPath, item.isDirectory, e, item.lineStart, item.lineEnd)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.click();
        }
      }}
      style={getFileListItemStyle(item.isDirectory)}
      {...fileLinkTooltip}
    >
      <span
        style={FILE_ICON_STYLE}
        dangerouslySetInnerHTML={{ __html: getFileIconSvg(item.cleanFileName, item.isDirectory) }}
      />
      <span style={FILE_NAME_STYLE}>
        {item.displayPath}
      </span>
      {item.lineInfo && (
        <span style={LINE_INFO_STYLE}>
          {item.lineInfo}
        </span>
      )}
      <div
        className={`tool-status-indicator ${item.isError ? 'error' : item.isCompleted ? 'completed' : 'pending'}`}
        style={STATUS_INDICATOR_STYLE}
      />
    </div>
  );
};

const ReadToolGroupBlock = ({ items }: ReadToolGroupBlockProps) => {
  // Default to expanded
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollPosition = useRef(0);
  const focusIndex = useRef<number | null>(null);

  // Parse all items to file items
  const fileItems = useMemo(() => {
    const occurrences = new Map<string, number>();
    return items.flatMap(item => {
      const file = parseFileItem(item);
      if (!file) return [];
      const identity = item.id ?? `${file.filePath}:${file.lineStart ?? ''}:${file.lineEnd ?? ''}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return [{ ...file, key: `${identity}:${occurrence}` }];
    });
  }, [items]);

  const listHeight = Math.min(MAX_VISIBLE_ITEMS, fileItems.length) * ITEM_HEIGHT;
  const maxScrollTop = Math.max(0, fileItems.length * ITEM_HEIGHT - listHeight);

  useLayoutEffect(() => {
    const previousMax = Math.max(0, (prevItemCountRef.current - MAX_VISIBLE_ITEMS) * ITEM_HEIGHT);
    const wasAtBottom = scrollPosition.current >= previousMax - 1;
    const nextScrollTop = fileItems.length > prevItemCountRef.current && wasAtBottom
      ? maxScrollTop : Math.min(scrollPosition.current, maxScrollTop);
    scrollPosition.current = nextScrollTop;
    setScrollTop(nextScrollTop);
    if (listRef.current) listRef.current.scrollTop = nextScrollTop;
    prevItemCountRef.current = fileItems.length;
  }, [fileItems.length, maxScrollTop, expanded]);

  useLayoutEffect(() => {
    if (focusIndex.current === null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${focusIndex.current}"]`)?.focus({ preventScroll: true });
    focusIndex.current = null;
  }, [scrollTop]);

  if (fileItems.length === 0) {
    return null;
  }

  // Calculate list height: show up to MAX_VISIBLE_ITEMS, scroll for more
  const needsScroll = fileItems.length > MAX_VISIBLE_ITEMS;
  const visibleStart = Math.floor(Math.min(scrollTop, maxScrollTop) / ITEM_HEIGHT);
  const startIndex = Math.max(0, visibleStart - OVERSCAN);
  const endIndex = Math.min(fileItems.length, Math.ceil((Math.min(scrollTop, maxScrollTop) + listHeight) / ITEM_HEIGHT) + OVERSCAN);

  const headerStyle: React.CSSProperties = {
    borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
  };

  const detailsStyle: React.CSSProperties = {
    padding: '6px 8px',
    border: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    maxHeight: `${listHeight + 12}px`, // +12 for padding
    height: `${listHeight + 12}px`,
    boxSizing: 'border-box',
    overflowY: needsScroll ? 'auto' : 'hidden',
    overflowX: 'hidden',
  };

  const handleFileClick = (openPath: string, isDirectory: boolean, e: React.MouseEvent, lineStart?: number, lineEnd?: number) => {
    e.stopPropagation();
    if (!isDirectory) {
      openFile(openPath, lineStart, lineEnd);
    }
  };

  return (
    <div className="task-container">
      <div
        className="task-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'Tab' && !event.shiftKey && expanded) {
            event.preventDefault();
            const firstRow = listRef.current?.querySelector<HTMLElement>('[data-index="0"]');
            focusIndex.current = firstRow ? null : 0;
            scrollPosition.current = 0;
            if (listRef.current) listRef.current.scrollTop = 0;
            setScrollTop(0);
            firstRow?.focus({ preventScroll: true });
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded(previous => !previous);
          }
        }}
        style={headerStyle}
      >
        <div className="task-title-section" style={TITLE_SECTION_STYLE}>
          <span className="codicon codicon-file-code tool-title-icon" />
          <span className="tool-title-text" style={TITLE_TEXT_STYLE}>
            {t('permission.tools.ReadBatch')}
          </span>
          <span className="tool-title-summary" style={TITLE_SUMMARY_STYLE}>
            ({fileItems.length})
          </span>
        </div>
      </div>

      {expanded && (
        <div
          ref={listRef}
          className="task-details file-list-container"
          style={detailsStyle}
          onScroll={(event) => {
            scrollPosition.current = event.currentTarget.scrollTop;
            setScrollTop(event.currentTarget.scrollTop);
          }}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return;
            const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
            if (!row) return;
            const currentIndex = Number(row.dataset.index);
            const direction = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
            if (event.key === 'Tab' && (currentIndex + direction < 0 || currentIndex + direction >= fileItems.length)) return;
            event.preventDefault();
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? fileItems.length - 1
              : Math.max(0, Math.min(fileItems.length - 1, currentIndex + direction));
            const rowTop = nextIndex * ITEM_HEIGHT;
            const nextScroll = Math.max(0, Math.min(maxScrollTop,
              rowTop < scrollPosition.current ? rowTop
                : Math.max(scrollPosition.current, rowTop + ITEM_HEIGHT - listHeight)));
            const mountedRow = listRef.current?.querySelector<HTMLElement>(`[data-index="${nextIndex}"]`);
            focusIndex.current = mountedRow ? null : nextIndex;
            scrollPosition.current = nextScroll;
            if (listRef.current) listRef.current.scrollTop = nextScroll;
            setScrollTop(nextScroll);
            mountedRow?.focus({ preventScroll: true });
          }}
        >
          <div style={{ height: fileItems.length * ITEM_HEIGHT, position: 'relative', flexShrink: 0 }}>
            <div style={{ position: 'absolute', top: startIndex * ITEM_HEIGHT, left: 0, right: 0 }}>
              {fileItems.slice(startIndex, endIndex).map((item, index) => (
                <FileListItem
                  key={item.key}
                  item={item}
                  index={startIndex + index}
                  onFileClick={handleFileClick}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReadToolGroupBlock;
