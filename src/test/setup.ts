import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// 每次测试后自动清理
afterEach(() => {
  cleanup();
});
