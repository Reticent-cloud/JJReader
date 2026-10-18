// 原创「鲸鱼女仆娘」形象资产（界面美化波）：全部图形为本仓库自绘的内联 SVG 字符串，
// 不含任何外部 URL / <image> / <use> / <script>，也不接受外部输入拼接。
// 元素：深蓝鲸鱼身体 + 鲸尾 + 白色荷叶边女仆头饰 + 深蓝发丝/呆毛 + 腮红 + 气泡与浪花。
// 配色取自 DeepSeek 蓝系（#4D6BFE 主色、#1B2A6B 深蓝、#DCE7FF 腹部、#9BD8FF 气泡、#FF9EB5 腮红/蝴蝶结）。
// 安全：MASCOT_SVG / MASCOT_LARGE_SVG 是常量字符串；bubbleDecor 只拼接数字（夹紧后）与固定 class，
// 由 shell 通过 innerHTML 放进装饰层（装饰层 aria-hidden + pointer-events:none，非用户内容）。

/** 64×64 主形象：鲸鱼女仆娘（工具栏 / 水印 / 小尺寸装饰用）。 */
const MASCOT_ART = `
  <g transform="translate(-1.2 0)">
    <path d="M44.8 40.4 C50.6 37.1 56.3 32 60.8 24.3 C63.4 26.2 63 30.1 60.5 32.6 C57.6 35.2 54.4 36.8 51.8 38.1 C50.2 39.7 50.6 41.6 52.8 42.6 C56 43.5 59.2 46.1 60.8 49.9 C63.4 53.8 62.4 57.3 59.2 56.6 C54.4 55.7 49.3 49 44.8 41.9 Z" fill="#2A44B8"/>
    <path d="M51.2 36.8 C55.1 33 57.9 29.1 59.6 26.6" stroke="#8FB4FF" stroke-width="0.6" fill="none" opacity="0.7"/>
    <path d="M51.5 45.8 C55.4 49.6 58 52.9 59.6 54.8" stroke="#8FB4FF" stroke-width="0.6" fill="none" opacity="0.7"/>
  </g>
  <ellipse cx="32" cy="34" rx="20" ry="19.5" fill="#15255E"/>
  <ellipse cx="32" cy="34.5" rx="17" ry="16.5" fill="#4D6BFE"/>
  <ellipse cx="26" cy="27" rx="8.5" ry="5.5" fill="#7089FF" opacity="0.5"/>
  <ellipse cx="32" cy="43" rx="10.5" ry="7.5" fill="#DCE7FF"/>
  <path d="M25 41.5 Q32 44.5 39 41.5" stroke="#AFC5FF" stroke-width="1" fill="none" stroke-linecap="round"/>
  <path d="M26.5 45 Q32 47.5 37.5 45" stroke="#AFC5FF" stroke-width="1" fill="none" stroke-linecap="round"/>
  <path d="M16.5 27 C13 33 13.5 41 17 47 C18.5 49.5 21.5 49 22 46.5 C19.5 41 19 34 20.5 28.5 Z" fill="#15255E"/>
  <path d="M47.5 27 C51 33 50.5 41 47 47 C45.5 49.5 42.5 49 42 46.5 C44.5 41 45 34 43.5 28.5 Z" fill="#15255E"/>
  <path d="M18 29 C20 23 25 20 32 20 C39 20 44 23 46 29 C43.5 30 40.5 29 38.5 26.5 C36.5 29.5 33 30.5 30.5 27 C28 30.5 23.5 30.5 22 28 C21 29 19.5 29 18 29 Z" fill="#15255E"/>
  <path d="M32 12 C32 8 35 5 39 6 C36 7 34 9 33.5 12" fill="#15255E"/>
  <path d="M15 21.6 C16.3 14.4 23.4 10.1 32 10.1 C40.6 10.1 47.7 14.4 49 21.6 C46.2 19.2 43.6 18.4 41.3 20.5 C38.4 17.2 35.1 16 32 17.2 C28.9 16 25.6 17.2 22.7 20.5 C20.4 18.4 17.8 19.2 15 21.6 Z" fill="#E2ECFF" stroke="#96B0E8" stroke-width="0.6" stroke-linejoin="round"/>
  <circle cx="17.3" cy="15.2" r="1.9" fill="#E2ECFF" stroke="#96B0E8" stroke-width="0.5"/>
  <circle cx="22.4" cy="12.3" r="1.86" fill="#E2ECFF" stroke="#96B0E8" stroke-width="0.5"/>
  <circle cx="28.2" cy="10.8" r="1.79" fill="#E2ECFF" stroke="#96B0E8" stroke-width="0.5"/>
  <circle cx="35.8" cy="10.8" r="1.79" fill="#E2ECFF" stroke="#96B0E8" stroke-width="0.5"/>
  <circle cx="41.6" cy="12.3" r="1.86" fill="#E2ECFF" stroke="#96B0E8" stroke-width="0.5"/>
  <circle cx="46.7" cy="15.2" r="1.9" fill="#E2ECFF" stroke="#96B0E8" stroke-width="0.5"/>
  <path d="M46.2 15.7 L42.6 13.6 L43.3 17.7 Z" fill="#FF9EB5"/>
  <path d="M46.2 15.7 L49.9 13.6 L49.2 17.7 Z" fill="#FF9EB5"/>
  <circle cx="46.2" cy="15.7" r="1" fill="#FF7FA8"/>
  <ellipse cx="25.5" cy="33.5" rx="1.8" ry="2.6" fill="#0E1B45"/>
  <circle cx="26.2" cy="32.6" r="0.7" fill="#FFFFFF"/>
  <ellipse cx="38.5" cy="33.5" rx="1.8" ry="2.6" fill="#0E1B45"/>
  <circle cx="39.2" cy="32.6" r="0.7" fill="#FFFFFF"/>
  <ellipse cx="21.5" cy="38" rx="2.2" ry="1.2" fill="#FF9EB5" opacity="0.55"/>
  <ellipse cx="42.5" cy="38" rx="2.2" ry="1.2" fill="#FF9EB5" opacity="0.55"/>
  <path d="M30 38.5 Q32 40.5 34 38.5" stroke="#0E1B45" stroke-width="1.1" fill="none" stroke-linecap="round"/>
  <circle cx="11" cy="18" r="2.4" fill="#9BD8FF" opacity="0.75"/>
  <circle cx="8.5" cy="25" r="1.2" fill="#9BD8FF" opacity="0.6"/>
  <circle cx="55" cy="15" r="2" fill="#9BD8FF" opacity="0.7"/>
  <circle cx="57.5" cy="50" r="1.6" fill="#9BD8FF" opacity="0.6"/>
  <circle cx="10.5" cy="17.2" r="0.7" fill="#FFFFFF" opacity="0.9"/>
  <circle cx="54.4" cy="14.3" r="0.6" fill="#FFFFFF" opacity="0.9"/>
  <path d="M7 57 Q12 53.5 17 57 T27 57 T37 57 T47 57 T57 57" stroke="#8FD3FF" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.8"/>
`;

/** 64×64 内联 SVG：原创鲸鱼女仆娘（装饰性图形；aria-hidden）。 */
export const MASCOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false">${MASCOT_ART}</svg>`;

/**
 * 220×220 空状态插画：浅蓝光晕 + 鲸鱼女仆娘 + 气泡 + 浪花 + 星光。
 * 仅由本文件的常量拼成，无外部 URL。
 */
export const MASCOT_LARGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" width="220" height="220" aria-hidden="true" focusable="false">
  <circle cx="110" cy="112" r="102" fill="#EEF3FF"/>
  <circle cx="110" cy="112" r="92" fill="#F7FAFF"/>
  <circle cx="110" cy="112" r="102" fill="none" stroke="#C9D8FF" stroke-width="2" stroke-dasharray="3 8" opacity="0.9"/>
  <circle cx="36" cy="52" r="7" fill="#9BD8FF" opacity="0.55"/>
  <circle cx="24" cy="72" r="3.5" fill="#9BD8FF" opacity="0.45"/>
  <circle cx="186" cy="42" r="9" fill="#9BD8FF" opacity="0.45"/>
  <circle cx="198" cy="66" r="4" fill="#9BD8FF" opacity="0.5"/>
  <circle cx="190" cy="176" r="6" fill="#9BD8FF" opacity="0.4"/>
  <circle cx="30" cy="168" r="4.5" fill="#9BD8FF" opacity="0.45"/>
  <path d="M52 34 l2.4 6.2 6.2 2.4 -6.2 2.4 -2.4 6.2 -2.4 -6.2 -6.2 -2.4 6.2 -2.4 z" fill="#8FD3FF" opacity="0.65"/>
  <path d="M170 20 l1.8 4.6 4.6 1.8 -4.6 1.8 -1.8 4.6 -1.8 -4.6 -4.6 -1.8 4.6 -1.8 z" fill="#8FD3FF" opacity="0.55"/>
  <path d="M22 196 Q42 184 62 196 T102 196 T142 196 T182 196 T212 196" stroke="#8FD3FF" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.65"/>
  <path d="M40 206 Q62 196 84 206 T128 206 T172 206" stroke="#B9E3FF" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.7"/>
  <g transform="translate(11 8) scale(3.1)">${MASCOT_ART}</g>
</svg>`;

/**
 * 低透明度气泡装饰（固定装饰层用）：返回可直接 innerHTML 的 HTML 字符串。
 * 位置/大小/动画延迟都由下标确定性计算（无 Math.random，便于测试与稳定渲染）；
 * count 夹紧到 0–24 的整数，非数字按 0 处理；样式值只包含数字，不接受外部字符串。
 * @param {number} [count] 气泡数量（默认 12）
 * @returns {string}
 */
export function bubbleDecor(count = 12) {
  const parsed = Math.trunc(Number(count));
  const total = Number.isFinite(parsed) ? Math.max(0, Math.min(24, parsed)) : 0;
  const bubbles = [];
  for (let index = 0; index < total; index += 1) {
    const left = (index * 37 + 11) % 100;
    const top = (index * 53 + 7) % 100;
    const size = 10 + ((index * 13) % 30);
    const delay = ((index * 7) % 12) / 2;
    const duration = 12 + (index % 5) * 2;
    bubbles.push(
      `<span class="jj-bubble" style="left:${left}%;top:${top}%;width:${size}px;height:${size}px;animation-delay:${delay}s;animation-duration:${duration}s"></span>`,
    );
  }
  return `<div class="bubble-field" aria-hidden="true">${bubbles.join('')}</div>`;
}
