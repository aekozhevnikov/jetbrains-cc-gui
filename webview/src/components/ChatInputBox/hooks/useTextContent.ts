import { useCallback, useEffect, useRef } from 'react';
import { perfTimer } from '../../../utils/debug.js';
import { makeQuoteToken } from '../utils/quoteRegistry.js';

interface TextContentCache {
  content: string;
  version: number;
}

interface UseTextContentOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
}

interface UseTextContentReturn {
  /** Get text content from editable element (with cache optimization) */
  getTextContent: () => string;
  /** Invalidate cache to force fresh content read */
  invalidateCache: () => void;
}

/**
 * useTextContent - Extract plain text from contenteditable element
 *
 * Performance optimization:
 * - Uses cache to avoid repeated DOM traversal
 * - Uses explicit invalidation and DOM mutation versions without HTML snapshots
 * - Properly handles file tags by reading data-file-path attribute
 */
export function useTextContent({
  editableRef,
}: UseTextContentOptions): UseTextContentReturn {
  const textCacheRef = useRef<TextContentCache>({
    content: '',
    version: -1,
  });
  const contentVersionRef = useRef(0);
  const observedElementRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedElementRef.current = null;
      textCacheRef.current = { content: '', version: -1 };
    };
  }, []);

  /**
   * Invalidate cache to force fresh content read
   */
  const invalidateCache = useCallback(() => {
    observerRef.current?.takeRecords();
    contentVersionRef.current += 1;
  }, []);

  /**
   * Get plain text content from editable element
   * Extracts text including file tag references in @path format
   *
   * Performance optimization:
   * - Uses array + join instead of string concatenation (O(n) vs O(n²))
   * - Tracks last character type to avoid repeated string operations
   */
  const getTextContent = useCallback((): string => {
    const timer = perfTimer('getTextContent');
    const editable = editableRef.current;
    if (observedElementRef.current !== editable) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedElementRef.current = isMountedRef.current ? editable : null;
      invalidateCache();
      if (editable && isMountedRef.current) {
        observerRef.current = new MutationObserver((records) => {
          if (records.length > 0) contentVersionRef.current += 1;
        });
        observerRef.current.observe(editable, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'data-file-path', 'data-quote-id'],
        });
      }
    }
    if (!editable) {
      textCacheRef.current = { content: '', version: -1 };
      timer.end();
      return '';
    }
    if (observerRef.current?.takeRecords().length) {
      contentVersionRef.current += 1;
    }
    const cache = textCacheRef.current;

    if (cache.version === contentVersionRef.current) {
      timer.mark('cache-hit');
      timer.end();
      return cache.content;
    }
    timer.mark('cache-miss');

    // Extract plain text from DOM, including file tag references
    // Use array + join for O(n) complexity instead of string concatenation O(n²)
    const textParts: string[] = [];
    let endsWithNewline = false;

    // Recursive traversal, but for file-tag only read data-file-path without descending
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const content = node.textContent || '';
        if (content) {
          textParts.push(content);
          endsWithNewline = content.endsWith('\n');
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        const tagName = element.tagName.toLowerCase();

        // Handle line break elements
        if (tagName === 'br') {
          textParts.push('\n');
          endsWithNewline = true;
        } else if (tagName === 'div' || tagName === 'p') {
          // Add newline before div/p (if not first element and doesn't already end with newline)
          if (textParts.length > 0 && !endsWithNewline) {
            textParts.push('\n');
            endsWithNewline = true;
          }
          node.childNodes.forEach(walk);
        } else if (element.classList.contains('file-tag')) {
          const filePath = element.getAttribute('data-file-path') || '';
          textParts.push(`@${filePath}`);
          endsWithNewline = false;
          // Don't traverse file-tag children to avoid duplicate filename and close button text
        } else if (element.classList.contains('quote-tag')) {
          const quoteId = element.getAttribute('data-quote-id') || '';
          textParts.push(makeQuoteToken(quoteId));
          endsWithNewline = false;
          // Don't traverse quote-tag children (preview + close button are decorative)
        } else {
          // Continue traversing child nodes
          node.childNodes.forEach(walk);
        }
      }
    };

    editable.childNodes.forEach(walk);
    timer.mark('dom-walk');

    // Join all parts into final text
    let text = textParts.join('');
    timer.mark('join');

    // Only remove trailing newline that JCEF might add (not user-entered newlines)
    // If there are multiple trailing newlines, only remove the last one (JCEF added)
    if (text.endsWith('\n') && editable.childNodes.length > 0) {
      const lastChild = editable.lastChild;
      // Only remove if last node is not a br tag (meaning it's JCEF added)
      if (
        lastChild?.nodeType !== Node.ELEMENT_NODE ||
        (lastChild as HTMLElement).tagName?.toLowerCase() !== 'br'
      ) {
        text = text.slice(0, -1);
      }
    }

    // Update cache
    textCacheRef.current = {
      content: text,
      version: contentVersionRef.current,
    };

    timer.end();
    return text;
  }, [editableRef, invalidateCache]);

  return {
    getTextContent,
    invalidateCache,
  };
}
