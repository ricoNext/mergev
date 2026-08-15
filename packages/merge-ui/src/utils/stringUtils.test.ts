import { describe, it, expect } from 'vitest';
import {
  fileNameOf,
  dirOf,
  hashString,
  formatDisplayPath,
  splitLines,
} from './stringUtils';

describe('stringUtils', () => {
  describe('fileNameOf', () => {
    it('应该返回路径的文件名', () => {
      expect(fileNameOf('src/utils/stringUtils.ts')).toBe('stringUtils.ts');
      expect(fileNameOf('README.md')).toBe('README.md');
    });

    it('应该处理空路径', () => {
      expect(fileNameOf('')).toBe('');
    });

    it('应该处理只有文件名的情况', () => {
      expect(fileNameOf('file.txt')).toBe('file.txt');
    });
  });

  describe('dirOf', () => {
    it('应该返回路径的目录部分', () => {
      expect(dirOf('src/utils/stringUtils.ts')).toBe('src/utils');
      expect(dirOf('src/main.tsx')).toBe('src');
    });

    it('应该处理根级文件', () => {
      expect(dirOf('README.md')).toBe('');
    });

    it('应该处理空路径', () => {
      expect(dirOf('')).toBe('');
    });
  });

  describe('hashString', () => {
    it('应该为相同字符串返回相同的哈希值', () => {
      const hash1 = hashString('test');
      const hash2 = hashString('test');
      expect(hash1).toBe(hash2);
    });

    it('应该为不同字符串返回不同的哈希值', () => {
      const hash1 = hashString('test1');
      const hash2 = hashString('test2');
      expect(hash1).not.toBe(hash2);
    });

    it('应该返回正数', () => {
      const hash = hashString('any string');
      expect(hash).toBeGreaterThanOrEqual(0);
    });

    it('应该处理空字符串', () => {
      const hash = hashString('');
      expect(hash).toBe(0);
    });
  });

  describe('formatDisplayPath', () => {
    it('应该使用提供的 homeDir 替换路径', () => {
      const result = formatDisplayPath('/Users/john/project/file.ts', '/Users/john');
      expect(result).toBe('~/project/file.ts');
    });

    it('应该自动检测 /Users/ 路径并替换', () => {
      const result = formatDisplayPath('/Users/john/Documents/file.txt');
      expect(result).toBe('~/Documents/file.txt');
    });

    it('应该自动检测 /home/ 路径并替换', () => {
      const result = formatDisplayPath('/home/john/projects/app');
      expect(result).toBe('~/projects/app');
    });

    it('应该保持不匹配的路径不变', () => {
      const result = formatDisplayPath('/var/log/app.log');
      expect(result).toBe('/var/log/app.log');
    });

    it('应该处理用户主目录本身', () => {
      const result = formatDisplayPath('/Users/john', '/Users/john');
      expect(result).toBe('~');
    });
  });

  describe('splitLines', () => {
    it('应该分割多行文本', () => {
      const result = splitLines('line1\nline2\nline3');
      expect(result).toEqual(['line1', 'line2', 'line3']);
    });

    it('应该处理以换行符结尾的文本', () => {
      const result = splitLines('line1\nline2\n');
      expect(result).toEqual(['line1', 'line2']);
    });

    it('应该处理空字符串', () => {
      const result = splitLines('');
      expect(result).toEqual([]);
    });

    it('应该处理单行文本', () => {
      const result = splitLines('single line');
      expect(result).toEqual(['single line']);
    });

    it('应该处理只有换行符的文本', () => {
      const result = splitLines('\n');
      expect(result).toEqual(['']);
    });
  });
});
