// 鲸鲸阅读器前端引擎入口。Task 1 只提供最小 install 骨架，后续任务在此扩展。

export function install(target = {}) {
  const api = { version: '0.1.0' };
  target.JJ = api;
  return api;
}

if (typeof window !== 'undefined') {
  install(window);
}
