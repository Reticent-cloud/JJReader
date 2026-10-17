// YAML front matter 扩展（Task 8）：文档开头的 ---\n…\n--- 块默认隐藏，解析成数据供 T9 的「属性」折叠块展示。
// 解析口径（只做阅读器需要的 YAML 子集，不做完整 YAML）：
//   - key: value；值 [a, b] → 字符串数组（元素去引号）；带引号的标量去引号；
//   - true/false 转布尔；数字保持字符串（避免 YAML 的数值语义扩展）；
//   - 缩进/嵌套不支持：缩进续行原样并入上一个 key 的字符串值；
//   - 重复 key 后值覆盖；以 # 开头的行按 YAML 注释跳过。
// 解析异常 / 格式不对（未闭合、块内出现无法识别的行）→ { data: {}, body: 原文 }，正文不被吞掉。

/** 匹配文档开头的 front matter 块（开/闭围栏都是独占行的 ---）。 */
const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;

/** `[a, b]` 形式的数组值（只支持单行、元素不含嵌套结构）。 */
const ARRAY_VALUE_RE = /^\[([\s\S]*)\]$/;

/** 去掉值两端成对的单/双引号（不做转义处理）。 */
function unquote(text) {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}

/** 把单行值解析成数组 / 布尔 / 字符串（数字与其它写法都保持字符串）。 */
function parseScalar(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return '';
  }
  const arrayMatch = ARRAY_VALUE_RE.exec(text);
  if (arrayMatch) {
    return arrayMatch[1]
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter((item) => item !== '');
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  return unquote(text);
}

/**
 * 解析 front matter 块内的行；出现无法识别的行时返回 null（调用方按「格式不对」处理）。
 * @param {string} block 围栏之间的原文
 * @returns {Record<string, string|string[]|boolean> | null}
 */
function parseBlock(block) {
  const data = {};
  let currentKey = '';
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    if (/^[ \t]/.test(line)) {
      // 缩进/嵌套不支持：续行原样并入上一个值；没有上一个 key 说明结构不对
      if (!currentKey) {
        return null;
      }
      data[currentKey] = data[currentKey] === '' ? trimmed : `${data[currentKey]}\n${trimmed}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      return null;
    }
    const key = line.slice(0, colon).trim();
    if (!key) {
      return null;
    }
    currentKey = key;
    data[key] = parseScalar(line.slice(colon + 1));
  }
  return data;
}

/**
 * 提取文档开头的 front matter：返回解析数据与去掉该块后的正文。
 * 无 front matter / 解析失败时返回 { data: {}, body: 原文 }（保证正文一字不丢）。
 * @param {string} markdown 原始 markdown
 * @returns {{ data: Record<string, string|string[]|boolean>, body: string }}
 */
export function extractFrontmatter(markdown) {
  const text = String(markdown ?? '');
  const withoutFrontmatter = { data: {}, body: text };
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return withoutFrontmatter;
  }
  const data = parseBlock(match[1] ?? '');
  if (!data) {
    return withoutFrontmatter;
  }
  return { data, body: text.slice(match[0].length) };
}

/**
 * 在 core 链最前端（normalize 之前）剥掉 front matter 块，并把数据写进 env.frontmatter。
 * env 已带 frontmatter（调用方显式覆盖）时不改动它，只负责正文剥离。
 */
export function install(md) {
  md.core.ruler.before('normalize', 'jj_frontmatter', (state) => {
    const { data, body } = extractFrontmatter(state.src);
    if (body !== state.src) {
      state.src = body;
    }
    if (state.env && typeof state.env === 'object' && state.env.frontmatter == null) {
      state.env.frontmatter = data;
    }
  });
}
