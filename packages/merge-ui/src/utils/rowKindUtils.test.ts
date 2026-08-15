import { describe, it, expect } from 'vitest';
import type { ConflictRegion } from '../types';
import { sideRowKind } from './rowKindUtils';

describe('rowKindUtils', () => {
  describe('sideRowKind', () => {
    it('应该将无内容侧的 insert 转为 empty', () => {
      const conflict: Partial<ConflictRegion> = {
        ours: 'content',
        theirs: '  \n  ',
        blockKind: 'change',
      };
      const result = sideRowKind('theirs', 'insert', conflict as ConflictRegion);
      expect(result).toBe('empty');
    });

    it('应该保持有内容侧的 insert', () => {
      const conflict: Partial<ConflictRegion> = {
        ours: 'content',
        theirs: 'other content',
        blockKind: 'change',
      };
      const result = sideRowKind('theirs', 'insert', conflict as ConflictRegion);
      expect(result).toBe('insert');
    });

    it('应该将已 settled 的 conflict 转为 context', () => {
      const conflict: ConflictRegion = {
        index: 0,
        rowStart: 0,
        rowEnd: 1,
        decision: 'ours',
        ours: 'a',
        theirs: 'b',
        resolution: { ours: 'accepted', theirs: 'pending', acceptOrder: ['ours'] },
      };
      const result = sideRowKind('ours', 'conflict', conflict);
      expect(result).toBe('context');
    });

    it('应该保持未 settled 的 conflict', () => {
      const conflict: ConflictRegion = {
        index: 0,
        rowStart: 0,
        rowEnd: 1,
        decision: 'unresolved',
        ours: 'a',
        theirs: 'b',
        resolution: { ours: 'pending', theirs: 'pending', acceptOrder: [] },
      };
      const result = sideRowKind('ours', 'conflict', conflict);
      expect(result).toBe('conflict');
    });

    it('应该将已 settled 的 insert 转为 context', () => {
      const conflict: ConflictRegion = {
        index: 0,
        rowStart: 0,
        rowEnd: 1,
        decision: 'ours',
        ours: 'content',
        theirs: '',
        resolution: { ours: 'accepted', theirs: 'pending', acceptOrder: ['ours'] },
      };
      const result = sideRowKind('ours', 'insert', conflict);
      expect(result).toBe('context');
    });

    it('应该将已 settled 的 delete 转为 context', () => {
      const conflict: ConflictRegion = {
        index: 0,
        rowStart: 0,
        rowEnd: 1,
        decision: 'empty',
        ours: 'a',
        theirs: 'b',
        resolution: { ours: 'ignored', theirs: 'pending', acceptOrder: [] },
      };
      const result = sideRowKind('ours', 'delete', conflict);
      expect(result).toBe('context');
    });

    it('应该保持 context 不变', () => {
      const conflict: Partial<ConflictRegion> = {
        ours: 'a',
        theirs: 'b',
      };
      const result = sideRowKind('ours', 'context', conflict as ConflictRegion);
      expect(result).toBe('context');
    });

    it('应该保持 empty 不变', () => {
      const conflict: Partial<ConflictRegion> = {
        ours: 'a',
        theirs: 'b',
      };
      const result = sideRowKind('ours', 'empty', conflict as ConflictRegion);
      expect(result).toBe('empty');
    });

    it('应该处理 null conflict', () => {
      const result = sideRowKind('ours', 'insert', null);
      expect(result).toBe('insert');
    });

    it('应该处理 undefined conflict', () => {
      const result = sideRowKind('theirs', 'conflict', undefined);
      expect(result).toBe('conflict');
    });
  });
});
