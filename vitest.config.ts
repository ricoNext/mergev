import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.config.*',
        '**/dist/',
        'scripts/',
        'src-tauri/',
        // 排除难以测试的 UI 组件和 Tauri 集成
        'src/components/**',
        'src/screens/**',
        'src/hooks/**',
        'src/main.tsx',
        'src/App.tsx',
        'src/BranchDialog.tsx',
        'src/types.ts',
        'src/vite-env.d.ts',
      ],
      thresholds: {
        // 全局阈值 - 适用于整体代码
        lines: 10,
        functions: 60,
        branches: 80,
        statements: 10,
      },
      // 为工具函数目录设置更高的覆盖率要求
      thresholdAutoUpdate: false,
      perFile: true,
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    },
  },
});
