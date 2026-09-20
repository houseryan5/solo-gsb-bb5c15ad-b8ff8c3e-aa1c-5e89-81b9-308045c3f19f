'use strict';

/**
 * 选项权重（结局概率推演用）
 *
 * 每个选项可带一个正整数 weight：在某个具体状态下，所有“条件成立且目标可进入”的
 * 选项按权重归一化得到选择概率；缺省（未填 / null / 空串）视为 1。
 *
 * 非法权重（0、负数、小数、布尔值、非数字字符串、超过上限等）由
 * validateStoryWeights 统一收集，调用方应转成 400 响应，错误信息需带场景 ID 与
 * 选项序号，方便作者定位。
 */

const MAX_WEIGHT = 1e9;

/**
 * 解析单个权重值。
 * @returns {number} 1..MAX_WEIGHT 的整数
 * @throws  {{status:400}} 权重非法时
 */
function parseOptionWeight(raw) {
  if (raw === undefined || raw === null) return 1;
  if (typeof raw === 'boolean') {
    throw Object.assign(new Error(`权重必须是正整数，不能是布尔值 ${raw}`), { status: 400 });
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw Object.assign(new Error('权重必须是有限的正整数'), { status: 400 });
    }
    if (!Number.isInteger(raw)) {
      throw Object.assign(new Error(`权重必须是正整数，不能是小数 ${raw}`), { status: 400 });
    }
    return rangeCheck(raw);
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '') return 1; // 表单留空 = 默认权重 1
    if (!/^[+-]?\d+$/.test(s)) {
      throw Object.assign(new Error(`权重必须是正整数，"${s}" 不是合法整数`), { status: 400 });
    }
    const n = Number(s);
    if (!Number.isSafeInteger(n)) {
      throw Object.assign(new Error(`权重超出可精确表示的整数范围（最大 ${MAX_WEIGHT}）`), { status: 400 });
    }
    return rangeCheck(n);
  }
  throw Object.assign(new Error('权重必须是正整数'), { status: 400 });
}

function rangeCheck(n) {
  if (n < 1) {
    throw Object.assign(new Error(`权重必须是正整数（≥1），收到 ${n}`), { status: 400 });
  }
  if (n > MAX_WEIGHT) {
    throw Object.assign(new Error(`权重过大：${n}（最大允许 ${MAX_WEIGHT}）`), { status: 400 });
  }
  return n;
}

/**
 * 校验整部剧情的全部选项权重；收集错误后一次性抛出（带场景 ID 与选项序号）。
 * 草稿推演 API 与存储规整层共用，保证“非法权重返回明确校验错误”。
 */
function validateStoryWeights(storyInput) {
  const story = storyInput || {};
  const problems = [];
  for (const scene of Array.isArray(story.scenes) ? story.scenes : []) {
    if (!scene || !Array.isArray(scene.options)) continue;
    scene.options.forEach((opt, idx) => {
      if (!opt || opt.weight === undefined || opt.weight === null) return;
      try {
        parseOptionWeight(opt.weight);
      } catch (e) {
        problems.push(`场景 "${scene.id || '?'}" 选项 ${idx + 1}（${(opt.text || '无文案').slice(0, 20)}）：${e.message}`);
      }
    });
  }
  if (problems.length) {
    throw Object.assign(new Error(`存在 ${problems.length} 处非法选项权重：\n- ${problems.join('\n- ')}`), {
      status: 400,
      code: 'badWeight',
      problems,
    });
  }
}

module.exports = { parseOptionWeight, validateStoryWeights, MAX_WEIGHT };
