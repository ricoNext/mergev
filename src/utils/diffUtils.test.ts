import { describe, it, expect } from 'vitest';
import { tokenizeWords, wordDiffTokens } from './diffUtils';

describe('diffUtils', () => {
  describe('tokenizeWords', () => {
    it('应该正确分割单词和空格', () => {
      const result = tokenizeWords('hello world');
      expect(result).toEqual(['hello', ' ', 'world']);
    });

    it('应该处理多个空格', () => {
      const result = tokenizeWords('a  b');
      expect(result).toEqual(['a', '  ', 'b']);
    });

    it('应该处理空字符串', () => {
      const result = tokenizeWords('');
      expect(result).toEqual(['']);
    });

    it('应该处理只有空格的字符串', () => {
      const result = tokenizeWords('   ');
      expect(result).toEqual(['   ']);
    });

    it('应该处理单个单词', () => {
      const result = tokenizeWords('hello');
      expect(result).toEqual(['hello']);
    });
  });

  describe('wordDiffTokens', () => {
    it('应该识别相同的文本', () => {
      const result = wordDiffTokens('hello', 'hello');
      expect(result.left).toEqual([{ kind: 'equal', text: 'hello' }]);
      expect(result.right).toEqual([{ kind: 'equal', text: 'hello' }]);
    });

    it('应该识别删除的单词', () => {
      const result = wordDiffTokens('hello world', 'hello');
      expect(result.left).toEqual([
        { kind: 'equal', text: 'hello' },
        { kind: 'delete', text: ' ' },
        { kind: 'delete', text: 'world' },
      ]);
      expect(result.right).toEqual([{ kind: 'equal', text: 'hello' }]);
    });

    it('应该识别插入的单词', () => {
      const result = wordDiffTokens('hello', 'hello world');
      expect(result.left).toEqual([{ kind: 'equal', text: 'hello' }]);
      expect(result.right).toEqual([
        { kind: 'equal', text: 'hello' },
        { kind: 'insert', text: ' ' },
        { kind: 'insert', text: 'world' },
      ]);
    });

    it('应该识别替换的单词', () => {
      const result = wordDiffTokens('hello world', 'hi there');
      expect(result.left.some(t => t.kind === 'delete')).toBe(true);
      expect(result.right.some(t => t.kind === 'insert')).toBe(true);
    });

    it('应该处理空字符串', () => {
      const result = wordDiffTokens('', '');
      expect(result.left).toEqual([{ kind: 'equal', text: '' }]);
      expect(result.right).toEqual([{ kind: 'equal', text: '' }]);
    });

    it('应该处理完全不同的文本', () => {
      const result = wordDiffTokens('abc', 'xyz');
      expect(result.left).toEqual([{ kind: 'delete', text: 'abc' }]);
      expect(result.right).toEqual([{ kind: 'insert', text: 'xyz' }]);
    });
  });
});
