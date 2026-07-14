import { describe, it, expect } from 'vitest';
import type { ConflictRegion, ConflictResolution } from '../types';
import {
  sideHasSubstantive,
  isChangeBlock,
  sideIsSettled,
  sideNeedsAction,
  sideHasConflictActions,
  sideDecisionMerged,
  emptyResolution,
  applyAccept,
  applyIgnore,
  decisionFromResolution,
  isResolutionComplete,
  resolutionsEqual,
  decisionIncludesOurs,
  decisionIncludesTheirs,
  decisionResultLines,
  nextUnresolvedIndex,
} from './conflictUtils';

describe('conflictUtils', () => {
  describe('sideHasSubstantive', () => {
    it('应该识别有实质内容的文本', () => {
      expect(sideHasSubstantive('hello')).toBe(true);
      expect(sideHasSubstantive('  content  ')).toBe(true);
    });

    it('应该识别空白文本', () => {
      expect(sideHasSubstantive('')).toBe(false);
      expect(sideHasSubstantive('   ')).toBe(false);
      expect(sideHasSubstantive('\n\n')).toBe(false);
    });

    it('应该处理多行文本', () => {
      expect(sideHasSubstantive('\n\nhello\n\n')).toBe(true);
      expect(sideHasSubstantive('\n  \n  \n')).toBe(false);
    });
  });

  describe('isChangeBlock', () => {
    it('应该识别 change 块', () => {
      const conflict: Pick<ConflictRegion, 'ours' | 'theirs' | 'blockKind'> = {
        ours: 'a',
        theirs: 'b',
        blockKind: 'change',
      };
      expect(isChangeBlock(conflict)).toBe(true);
    });

    it('应该识别单方为空的块', () => {
      const conflict: Pick<ConflictRegion, 'ours' | 'theirs' | 'blockKind'> = {
        ours: 'content',
        theirs: '',
        blockKind: undefined,
      };
      expect(isChangeBlock(conflict)).toBe(true);
    });

    it('应该识别双方都有内容的非 change 块', () => {
      const conflict: Pick<ConflictRegion, 'ours' | 'theirs' | 'blockKind'> = {
        ours: 'content1',
        theirs: 'content2',
        blockKind: undefined,
      };
      expect(isChangeBlock(conflict)).toBe(false);
    });

    it('应该处理 null 和 undefined', () => {
      expect(isChangeBlock(null)).toBe(false);
      expect(isChangeBlock(undefined)).toBe(false);
    });
  });

  describe('sideIsSettled', () => {
    it('应该识别已决定的一侧', () => {
      const conflict: ConflictRegion = {
        ours: 'a',
        theirs: 'b',
        resolution: { ours: 'accepted', theirs: 'pending', acceptOrder: ['ours'] },
      };
      expect(sideIsSettled('ours', conflict)).toBe(true);
      expect(sideIsSettled('theirs', conflict)).toBe(false);
    });

    it('应该处理没有 resolution 的情况', () => {
      const conflict: ConflictRegion = {
        ours: 'a',
        theirs: 'b',
      };
      expect(sideIsSettled('ours', conflict)).toBe(false);
      expect(sideIsSettled('theirs', conflict)).toBe(false);
    });

    it('应该处理 null 和 undefined', () => {
      expect(sideIsSettled('ours', null)).toBe(false);
      expect(sideIsSettled('theirs', undefined)).toBe(false);
    });
  });

  describe('emptyResolution', () => {
    it('应该创建空的 resolution', () => {
      const result = emptyResolution();
      expect(result).toEqual({
        ours: 'pending',
        theirs: 'pending',
        acceptOrder: [],
      });
    });
  });

  describe('applyAccept', () => {
    it('应该接受 ours', () => {
      const current = emptyResolution();
      const result = applyAccept(current, 'ours');
      expect(result).toEqual({
        ours: 'accepted',
        theirs: 'pending',
        acceptOrder: ['ours'],
      });
    });

    it('应该接受 theirs', () => {
      const current = emptyResolution();
      const result = applyAccept(current, 'theirs');
      expect(result).toEqual({
        ours: 'pending',
        theirs: 'accepted',
        acceptOrder: ['theirs'],
      });
    });

    it('应该处理重复接受', () => {
      const current: ConflictResolution = {
        ours: 'accepted',
        theirs: 'pending',
        acceptOrder: ['ours'],
      };
      const result = applyAccept(current, 'ours');
      expect(result).toBe(current);
    });

    it('应该正确处理接受顺序', () => {
      const current = emptyResolution();
      const step1 = applyAccept(current, 'ours');
      const step2 = applyAccept(step1, 'theirs');
      expect(step2.acceptOrder).toEqual(['ours', 'theirs']);
    });
  });

  describe('applyIgnore', () => {
    it('应该忽略 ours', () => {
      const current = emptyResolution();
      const result = applyIgnore(current, 'ours');
      expect(result).toEqual({
        ours: 'ignored',
        theirs: 'pending',
        acceptOrder: [],
      });
    });

    it('应该忽略 theirs', () => {
      const current = emptyResolution();
      const result = applyIgnore(current, 'theirs');
      expect(result).toEqual({
        ours: 'pending',
        theirs: 'ignored',
        acceptOrder: [],
      });
    });

    it('应该处理重复忽略', () => {
      const current: ConflictResolution = {
        ours: 'ignored',
        theirs: 'pending',
        acceptOrder: [],
      };
      const result = applyIgnore(current, 'ours');
      expect(result).toBe(current);
    });

    it('应该从 acceptOrder 中移除', () => {
      const current: ConflictResolution = {
        ours: 'accepted',
        theirs: 'pending',
        acceptOrder: ['ours'],
      };
      const result = applyIgnore(current, 'ours');
      expect(result.acceptOrder).toEqual([]);
    });
  });

  describe('decisionFromResolution', () => {
    it('应该返回 ours', () => {
      const resolution: ConflictResolution = {
        ours: 'accepted',
        theirs: 'pending',
        acceptOrder: ['ours'],
      };
      expect(decisionFromResolution(resolution)).toBe('ours');
    });

    it('应该返回 theirs', () => {
      const resolution: ConflictResolution = {
        ours: 'pending',
        theirs: 'accepted',
        acceptOrder: ['theirs'],
      };
      expect(decisionFromResolution(resolution)).toBe('theirs');
    });

    it('应该返回 oursThenTheirs', () => {
      const resolution: ConflictResolution = {
        ours: 'accepted',
        theirs: 'accepted',
        acceptOrder: ['ours', 'theirs'],
      };
      expect(decisionFromResolution(resolution)).toBe('oursThenTheirs');
    });

    it('应该返回 theirsThenOurs', () => {
      const resolution: ConflictResolution = {
        ours: 'accepted',
        theirs: 'accepted',
        acceptOrder: ['theirs', 'ours'],
      };
      expect(decisionFromResolution(resolution)).toBe('theirsThenOurs');
    });

    it('应该返回 empty', () => {
      const resolution: ConflictResolution = {
        ours: 'ignored',
        theirs: 'ignored',
        acceptOrder: [],
      };
      expect(decisionFromResolution(resolution)).toBe('empty');
    });

    it('应该返回 unresolved', () => {
      const resolution = emptyResolution();
      expect(decisionFromResolution(resolution)).toBe('unresolved');
    });
  });

  describe('resolutionsEqual', () => {
    it('应该识别相同的 resolutions', () => {
      const a: ConflictResolution = {
        ours: 'accepted',
        theirs: 'pending',
        acceptOrder: ['ours'],
      };
      const b: ConflictResolution = {
        ours: 'accepted',
        theirs: 'pending',
        acceptOrder: ['ours'],
      };
      expect(resolutionsEqual(a, b)).toBe(true);
    });

    it('应该识别不同的 resolutions', () => {
      const a: ConflictResolution = {
        ours: 'accepted',
        theirs: 'pending',
        acceptOrder: ['ours'],
      };
      const b: ConflictResolution = {
        ours: 'pending',
        theirs: 'accepted',
        acceptOrder: ['theirs'],
      };
      expect(resolutionsEqual(a, b)).toBe(false);
    });

    it('应该检查 acceptOrder 的顺序', () => {
      const a: ConflictResolution = {
        ours: 'accepted',
        theirs: 'accepted',
        acceptOrder: ['ours', 'theirs'],
      };
      const b: ConflictResolution = {
        ours: 'accepted',
        theirs: 'accepted',
        acceptOrder: ['theirs', 'ours'],
      };
      expect(resolutionsEqual(a, b)).toBe(false);
    });
  });

  describe('decisionIncludesOurs', () => {
    it('应该正确识别包含 ours 的决定', () => {
      expect(decisionIncludesOurs('ours')).toBe(true);
      expect(decisionIncludesOurs('oursThenTheirs')).toBe(true);
      expect(decisionIncludesOurs('theirsThenOurs')).toBe(true);
      expect(decisionIncludesOurs('theirs')).toBe(false);
      expect(decisionIncludesOurs('empty')).toBe(false);
    });
  });

  describe('decisionIncludesTheirs', () => {
    it('应该正确识别包含 theirs 的决定', () => {
      expect(decisionIncludesTheirs('theirs')).toBe(true);
      expect(decisionIncludesTheirs('oursThenTheirs')).toBe(true);
      expect(decisionIncludesTheirs('theirsThenOurs')).toBe(true);
      expect(decisionIncludesTheirs('ours')).toBe(false);
      expect(decisionIncludesTheirs('empty')).toBe(false);
    });
  });

  describe('decisionResultLines', () => {
    it('应该返回 ours 的行', () => {
      const result = decisionResultLines('ours', 'line1\nline2', 'other');
      expect(result).toEqual({
        source: 'ours',
        lines: ['line1', 'line2'],
      });
    });

    it('应该返回 theirs 的行', () => {
      const result = decisionResultLines('theirs', 'other', 'line1\nline2');
      expect(result).toEqual({
        source: 'theirs',
        lines: ['line1', 'line2'],
      });
    });

    it('应该合并 oursThenTheirs', () => {
      const result = decisionResultLines('oursThenTheirs', 'a\nb', 'c\nd');
      expect(result).toEqual({
        source: 'manual',
        lines: ['a', 'b', 'c', 'd'],
      });
    });

    it('应该合并 theirsThenOurs', () => {
      const result = decisionResultLines('theirsThenOurs', 'a\nb', 'c\nd');
      expect(result).toEqual({
        source: 'manual',
        lines: ['c', 'd', 'a', 'b'],
      });
    });

    it('应该返回 empty', () => {
      const result = decisionResultLines('empty', 'a', 'b');
      expect(result).toEqual({
        source: 'manual',
        lines: [],
      });
    });

    it('应该处理 unresolved', () => {
      const result = decisionResultLines('unresolved', 'a', 'b');
      expect(result).toEqual({
        source: 'unresolved',
        lines: [''],
      });
    });
  });
});
