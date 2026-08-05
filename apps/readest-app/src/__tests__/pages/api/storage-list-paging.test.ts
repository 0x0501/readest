import { describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE, resolvePageSize } from '@/pages/api/storage/list';

// The listing costs roughly a second per request almost regardless of how many
// rows come back, so a client walking the whole account (the calibre plugin)
// pays per page. Raising the cap collapses ~16 requests into 2.
describe('resolvePageSize', () => {
  it('defaults to 50 when absent or unparseable', () => {
    expect(resolvePageSize(undefined)).toBe(50);
    expect(resolvePageSize('')).toBe(50);
    expect(resolvePageSize('abc')).toBe(50);
  });

  it('honours a requested size up to the cap', () => {
    expect(resolvePageSize('20')).toBe(20);
    expect(resolvePageSize(String(MAX_PAGE_SIZE))).toBe(MAX_PAGE_SIZE);
  });

  it('clamps anything above the cap', () => {
    expect(resolvePageSize('5000')).toBe(MAX_PAGE_SIZE);
  });

  it('never returns a range-breaking size', () => {
    expect(resolvePageSize('0')).toBe(50); // 0 is falsy, so it falls back
    expect(resolvePageSize('-5')).toBe(1);
  });
});
