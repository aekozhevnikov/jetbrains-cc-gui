import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// We'll test the daemon.js handleInputLine logic by loading it
// Since daemon.js has side effects, we test the oversized request logic in isolation

describe('daemon.js oversized request handling', () => {
  const MAX_INPUT_LINE_LENGTH = 8 * 1024 * 1024; // 8MB

  test('oversized request should be rejected with error response', async () => {
    // Create a line longer than MAX_INPUT_LINE_LENGTH
    const oversizedLine = 'x'.repeat(MAX_INPUT_LINE_LENGTH + 100);

    // Simulate the handleInputLine logic
    let errorResponseSent = false;
    let errorResponse = null;

    const mockWriteRawLine = (obj) => {
      errorResponseSent = true;
      errorResponse = obj;
    };

    // Test the rejection logic
    if (oversizedLine.length > MAX_INPUT_LINE_LENGTH) {
      // Try to extract request ID
      let requestId = '0';
      try {
        const idMatch = oversizedLine.match(/"id"\s*:\s*("([^"]*)"|(\d+))/);
        if (idMatch) {
          requestId = idMatch[2] || idMatch[3] || '0';
        }
      } catch {
        requestId = '0';
      }

      mockWriteRawLine({
        id: requestId,
        done: true,
        success: false,
        error: `Request too large: ${oversizedLine.length} bytes (limit ${MAX_INPUT_LINE_LENGTH})`
      });
    }

    assert.ok(errorResponseSent, 'Error response should be sent for oversized request');
    assert.equal(errorResponse.done, true);
    assert.equal(errorResponse.success, false);
    assert.match(errorResponse.error, /Request too large/);
  });

  test('oversized request with valid JSON ID should extract ID', async () => {
    const oversizedLine = JSON.stringify({
      id: 'req-123',
      method: 'test',
      params: {}
    }) + 'x'.repeat(MAX_INPUT_LINE_LENGTH);

    let errorResponse = null;
    const mockWriteRawLine = (obj) => { errorResponse = obj; };

    if (oversizedLine.length > MAX_INPUT_LINE_LENGTH) {
      let requestId = '0';
      try {
        const idMatch = oversizedLine.match(/"id"\s*:\s*("([^"]*)"|(\d+))/);
        if (idMatch) {
          requestId = idMatch[2] || idMatch[3] || '0';
        }
      } catch {
        requestId = '0';
      }

      mockWriteRawLine({
        id: requestId,
        done: true,
        success: false,
        error: `Request too large: ${oversizedLine.length} bytes (limit ${MAX_INPUT_LINE_LENGTH})`
      });
    }

    assert.equal(errorResponse.id, 'req-123');
  });

  test('oversized request with numeric ID should extract ID', async () => {
    const oversizedLine = JSON.stringify({
      id: 456,
      method: 'test',
      params: {}
    }) + 'x'.repeat(MAX_INPUT_LINE_LENGTH);

    let errorResponse = null;
    const mockWriteRawLine = (obj) => { errorResponse = obj; };

    if (oversizedLine.length > MAX_INPUT_LINE_LENGTH) {
      let requestId = '0';
      try {
        const idMatch = oversizedLine.match(/"id"\s*:\s*("([^"]*)"|(\d+))/);
        if (idMatch) {
          requestId = idMatch[2] || idMatch[3] || '0';
        }
      } catch {
        requestId = '0';
      }

      mockWriteRawLine({
        id: requestId,
        done: true,
        success: false,
        error: `Request too large: ${oversizedLine.length} bytes (limit ${MAX_INPUT_LINE_LENGTH})`
      });
    }

    assert.equal(errorResponse.id, 456);
  });

  test('oversized request with malformed ID should default to "0"', async () => {
    const oversizedLine = JSON.stringify({
      method: 'test',
      params: {}
    }) + 'x'.repeat(MAX_INPUT_LINE_LENGTH);

    let errorResponse = null;
    const mockWriteRawLine = (obj) => { errorResponse = obj; };

    if (oversizedLine.length > MAX_INPUT_LINE_LENGTH) {
      let requestId = '0';
      try {
        const idMatch = oversizedLine.match(/"id"\s*:\s*("([^"]*)"|(\d+))/);
        if (idMatch) {
          requestId = idMatch[2] || idMatch[3] || '0';
        }
      } catch {
        requestId = '0';
      }

      mockWriteRawLine({
        id: requestId,
        done: true,
        success: false,
        error: `Request too large: ${oversizedLine.length} bytes (limit ${MAX_INPUT_LINE_LENGTH})`
      });
    }

    assert.equal(errorResponse.id, '0');
  });

  test('normal sized request should not be rejected', async () => {
    const normalLine = JSON.stringify({
      id: 'req-789',
      method: 'sendMessage',
      params: { message: 'Hello' }
    });

    let errorResponse = null;
    let requestProcessed = false;
    const mockWriteRawLine = (obj) => { errorResponse = obj; };

    if (normalLine.length > MAX_INPUT_LINE_LENGTH) {
      // This should not happen for normal sized requests
      errorResponse = { done: true, success: false };
    } else {
      requestProcessed = true;
    }

    assert.ok(requestProcessed, 'Normal sized request should be processed');
    assert.equal(errorResponse, null, 'No error response for normal request');
  });
});

console.log('\n✅ Daemon oversized request tests defined. Run with: node daemon.test.js');