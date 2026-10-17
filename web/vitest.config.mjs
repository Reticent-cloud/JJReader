// 鲸鲸阅读器前端测试配置：root 是 web/（`vitest run` 在 web/ 下执行），用例与 setup 放在仓库 tests/web/ 下。
// globals: true —— 用例里直接使用 it/expect/vi（与计划中的测试写法一致）；
// setupFiles —— 每个测试文件执行前把 JJ 装到全局，测试只通过 JJ.* 使用前端 API；
// server.fs.allow —— 用例与 setup 在 root 之外（../tests/web/），必须放行父目录，否则 Vite 拒绝加载。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    fs: {
      allow: ['..'],
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['../tests/web/**/*.test.js'],
    setupFiles: ['../tests/web/setup.js'],
  },
});
