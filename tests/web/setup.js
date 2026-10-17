// 前端测试公共装配：把 JJ API 挂到全局，所有用例通过 JJ.* 调用（与浏览器环境共用同一套 install 装配）。
import { install } from '../../web/src/index.js';

globalThis.JJ = install(globalThis);
