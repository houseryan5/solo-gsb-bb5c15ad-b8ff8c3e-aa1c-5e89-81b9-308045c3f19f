'use strict';

/**
 * 结局概率推演引擎
 *
 * 在分析器同款「场景 + 变量状态」有限具体状态图上求解吸收概率：
 *
 *   1. 从起点（起点场景进入赋值后的状态）BFS 枚举全部可达具体状态；每个状态下
 *      只考虑“条件成立 且 目标场景存在 且 进入后目标前置条件成立”的选项，
 *      这些选项的正整数权重归一化后作为出边概率（条件不成立 / 悬空 / 入口受阻
 *      的选项不参与归一化，也不占概率质量）；
 *   2. 没有可进入选项的具体状态为“终止场景”（吸收态）；
 *   3. 其余状态构成有限马尔可夫链。用 Kosaraju 求 SCC：
 *      - 无出边的单点 SCC 即终止场景；
 *      - 没有任何出边离开本 SCC 的非平凡闭 SCC 是“永久循环陷阱”——一旦进入
 *        就再也出不来，其中的概率质量永远到不了任何结局；
 *   4. 删除陷阱 SCC 内部状态后，剩余状态全部能在有限步内到达吸收态（瞬态），
 *      (I − Q) 必然可逆；逐吸收目标求解线性方程组 (I − Q)·X = B，
 *      得到每个终止场景与每个循环陷阱的最终到达概率。
 *
 * 这是方程组的精确稳态解（高斯-若尔当消元），不存在“固定走 N 步截断”；
 * 只有为了保证服务终止性的状态数上限触发时才明确标记“无法给出精确结果”
 * （solved=false），绝不以截断结果冒充精确概率。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');
const { validateStoryWeights } = require('./weights');

const SOLVER_TRANSIENT_CAP = 500; // 线性方程组规模上限（消元为 O(n³)）
const PIVOT_EPS = 1e-12;

function badRequest(message, extra) {
  return Object.assign(new Error(message), { status: 400 }, extra || {});
}

/**
 * 结局概率推演。
 * @param storyInput 剧情对象（草稿或已保存均可；权重需已通过校验）
 * @param opts { maxStates, solverCap } 测试可注入更小上限
 */
function simulate(storyInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;
  const solverCap = Number.isInteger(opts.solverCap) && opts.solverCap > 0 ? opts.solverCap : SOLVER_TRANSIENT_CAP;

  validateStoryWeights(story);

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene) throw badRequest('未指定起点场景，无法推演结局概率');
  if (!sceneMap.has(story.startScene)) {
    throw badRequest(`起点场景 "${story.startScene}" 不存在，无法推演结局概率`);
  }

  const knownVars = collectStateVars({ ...story, scenes });

  // ---- 编译全部条件：推演对语法错误零容忍（分析面板另有报告），直接 400 ----
  const conditionErrors = [];
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const optionInfo = new Map(); // `${sceneId}#${idx}` -> { option, cond, assigns, weight }
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    sceneCond.set(scene.id, compileSceneCond(scene, conditionErrors));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      if (!opt) return;
      let cond = null;
      if (opt.condition && String(opt.condition).trim()) {
        try {
          cond = compile(opt.condition);
        } catch (e) {
          conditionErrors.push({
            where: `场景 "${scene.id}" 选项 ${idx + 1} 的条件`,
            message: e.message,
            sceneId: scene.id, optionIndex: idx,
          });
        }
      }
      optionInfo.set(`${scene.id}#${idx}`, {
        option: opt,
        cond,
        assigns: (opt.assigns || []).filter((a) => a && a.variable),
        weight: opt.weight === undefined || opt.weight === null || opt.weight === ''
          ? 1 : Number(opt.weight),
      });
    });
  }
  if (conditionErrors.length) {
    throw badRequest(
      `剧情存在 ${conditionErrors.length} 处条件语法错误，请先在“一致性分析”中修复后再推演：\n- ` +
        conditionErrors.slice(0, 5).map((e) => `${e.where}：${e.message}`).join('\n- '),
      { code: 'badCondition', conditionErrors },
    );
  }

  // ---- BFS 枚举可达具体状态，并构造带概率出边 ----
  // nodes: [{ sceneId, code, outEdges:[{to, prob, edge}], key, index }]（index 后补）
  const nodes = [];
  const nodeByKey = new Map(); // `${sceneId}\x00${code}` -> node
  const warnings = [];
  const warnedOption = new Set();
  let truncated = false;

  const addWarning = (w) => { warnings.push(w); };

  /** 在具体状态 state 下计算场景 sceneId 的可进入选项与归一化出边 */
  const expand = (sceneId, state, fromNode) => {
    const scene = sceneMap.get(sceneId);
    const entries = []; // { targetId, nextCode, weight, edge }
    let totalWeight = 0;
    (scene.options || []).forEach((opt, idx) => {
      const info = optionInfo.get(`${sceneId}#${idx}`);
      const optKey = `${sceneId}#${idx}`;
      const label = (opt && opt.text) || `选项 ${idx + 1}`;

      if (info && info.cond && !info.cond.evaluate(state)) return; // 条件不成立：不可见，不参与

      const targetId = ((opt && opt.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) {
        // 悬空跳转：条件成立却没有合法目标 —— 记录一次警告，该选项不占概率质量
        if (!warnedOption.has(optKey)) {
          warnedOption.add(optKey);
          addWarning({
            type: 'orphanOption',
            sceneId, optionIndex: idx, optionUid: (opt && opt.uid) || null,
            message: targetId
              ? `场景 "${sceneId}" 选项「${label}」指向不存在的场景 "${targetId}"，推演时忽略该选项（不参与权重归一化）`
              : `场景 "${sceneId}" 选项「${label}」没有目标场景，推演时忽略`,
          });
        }
        return;
      }

      let nextState = state;
      if (info && info.assigns.length) nextState = applyAssigns(nextState, info.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const nextCode = encodeState(nextState, knownVars);

      const targetCond = sceneCond.get(targetId);
      if (targetCond && !targetCond.evaluate(nextState)) {
        if (!warnedOption.has(optKey)) {
          warnedOption.add(optKey);
          addWarning({
            type: 'blockedEntry',
            sceneId, optionIndex: idx, optionUid: (opt && opt.uid) || null,
            targetSceneId: targetId,
            message: `场景 "${sceneId}" 选项「${label}」条件成立，但进入 "${targetId}" 时其前置条件不成立，推演时忽略该选项`,
          });
        }
        return;
      }

      totalWeight += info.weight;
      entries.push({
        targetId,
        nextCode,
        weight: info.weight,
        edge: {
          sceneId, optionIndex: idx, optionUid: (opt && opt.uid) || null,
          optionText: (opt && opt.text) || '', target: targetId,
        },
      });
    });

    if (!entries.length) return [];
    return entries.map((e) => ({
      to: `${e.targetId}\x00${e.nextCode}`,
      prob: e.weight / totalWeight,
      edge: e.edge,
    }));
  };

  const offer = (sceneId, code) => {
    const key = `${sceneId}\x00${code}`;
    if (nodeByKey.has(key)) return nodeByKey.get(key);
    if (nodes.length >= maxStates) { truncated = true; return null; }
    const node = { sceneId, code, key, out: null, index: -1 };
    nodeByKey.set(key, node);
    nodes.push(node);
    return node;
  };

  // 起点：全部 false 叠加起点场景进入赋值；起点前置不成立 => 剧情无法开始
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startCode = encodeState(startState, knownVars);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));

  let startKey = null;
  if (!startBlocked) {
    const startNode = offer(story.startScene, startCode);
    startKey = startNode ? startNode.key : null;
  }

  // BFS：节点出边在出队时展开（保证目标节点已建或当场建）
  let head = 0;
  while (head < nodes.length && !truncated) {
    const cur = nodes[head++];
    const state = decodeState(cur.code, knownVars);
    cur.out = expand(cur.sceneId, state, cur);
    if (truncated) break;
    for (const e of cur.out) {
      const [tid, tcode] = splitKey(e.to);
      offer(tid, tcode);
      if (truncated) break;
    }
  }

  const result = {
    solved: false,
    reason: null,
    truncated: false,
    startBlocked,
    startScene: story.startScene,
    knownVars,
    stateCount: nodes.length,
    maxStates,
    solverCap,
    endings: [],
    loops: [],
    trappedProbability: 0,
    totalAccounted: 0,
    warnings,
    message: '',
  };

  if (startBlocked) {
    result.reason = 'startBlocked';
    result.message = '起点场景的前置条件在初始状态下不成立，剧情无法开始：没有任何结局概率';
    result.solved = true;
    return result;
  }
  if (truncated) {
    result.truncated = true;
    result.reason = 'stateLimit';
    result.message = `可达具体状态数达到上限（${nodes.length} / ${maxStates}），状态图不完整，拒绝以固定步数或部分状态冒充精确概率；请减少布尔变量数量后重试`;
    return result;
  }

  nodes.forEach((n, i) => { n.index = i; });
  const N = nodes.length;

  // ---- Kosaraju（迭代实现，避免百万节点递归爆栈）求 SCC ----
  const adj = nodes.map((n) => [...new Set(n.out.map((e) => e.to))].map((k) => nodeByKey.get(k).index));
  const radj = Array.from({ length: N }, () => []);
  adj.forEach((tos, u) => tos.forEach((v) => radj[v].push(u)));

  // 第一遍：原图 DFS 结束序
  const visited = new Uint8Array(N);
  const order = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (visited[s0]) continue;
    const stack = [s0];
    while (stack.length) {
      const u = stack[stack.length - 1];
      if (!visited[u]) {
        visited[u] = 1;
        for (const v of adj[u]) if (!visited[v]) stack.push(v);
      } else {
        stack.pop();
        if (visited[u] === 1) { visited[u] = 2; order.push(u); }
      }
    }
  }
  // 第二遍：反图按结束序逆序 DFS 染色
  const comp = new Int32Array(N).fill(-1);
  const comps = [];
  for (let i = N - 1; i >= 0; i--) {
    const s0 = order[i];
    if (comp[s0] !== -1) continue;
    const cid = comps.length;
    const members = [];
    const stack = [s0];
    comp[s0] = cid;
    while (stack.length) {
      const u = stack.pop();
      members.push(u);
      for (const v of radj[u]) {
        if (comp[v] === -1) { comp[v] = cid; stack.push(v); }
      }
    }
    comps.push(members);
  }

  // SCC 是否有出边离开本 SCC
  const compClosed = comps.map((members, cid) => {
    for (const u of members) {
      for (const v of adj[u]) if (comp[v] !== cid) return false;
    }
    return true;
  });

  // ---- 分类：终止场景（无出边单点 SCC）/ 循环陷阱（闭的非平凡 SCC）/ 瞬态 ----
  const terminalNodes = []; // node index
  const trapCompIds = [];
  comps.forEach((members, cid) => {
    if (!compClosed[cid]) return;
    if (members.length === 1 && adj[members[0]].length === 0) {
      terminalNodes.push(members[0]);
    } else {
      trapCompIds.push(cid);
    }
  });

  const terminalSet = new Set(terminalNodes);
  const trapNodeSet = new Set();
  trapCompIds.forEach((cid) => comps[cid].forEach((u) => trapNodeSet.add(u)));
  const transientIdx = [];
  for (let i = 0; i < N; i++) {
    if (!terminalSet.has(i) && !trapNodeSet.has(i)) transientIdx.push(i);
  }

  if (transientIdx.length > solverCap) {
    result.reason = 'solverLimit';
    result.solved = false;
    result.message = `需要求解的瞬态状态数为 ${transientIdx.length}，超过线性方程组求解上限 ${solverCap}，拒绝给出可能失真的概率；请减少变量数量后重试`;
    return result;
  }

  // 吸收目标列：终止场景按 sceneId 聚合 + 每个循环陷阱一列
  terminalNodes.sort((a, b) => {
    const sa = nodes[a].sceneId; const sb = nodes[b].sceneId;
    return sa < sb ? -1 : sa > sb ? 1 : a - b;
  });
  // 同一场景的多个终止具体状态合并为一个“结局”
  const endings = [];
  const endingColumnOfNode = new Map(); // terminal node index -> ending column
  for (const u of terminalNodes) {
    const sid = nodes[u].sceneId;
    let ending = endings.find((e) => e.sceneId === sid);
    if (!ending) {
      ending = {
        sceneId: sid,
        title: (sceneMap.get(sid) || {}).title || '',
        terminalStateCount: 0,
        terminalStates: [],
      };
      endings.push(ending);
    }
    endingColumnOfNode.set(u, endings.length - 1);
    ending.terminalStateCount++;
    ending.terminalStates.push(decodeState(nodes[u].code, knownVars));
  }

  const trapCompSorted = trapCompIds.map((cid) => {
    const members = comps[cid].slice().sort((a, b) => a - b);
    const sceneIds = [...new Set(members.map((u) => nodes[u].sceneId))].sort();
    return { cid, members, sceneIds };
  }).sort((a, b) => {
    const x = a.sceneIds[0]; const y = b.sceneIds[0];
    return x < y ? -1 : x > y ? 1 : a.cid - b.cid;
  });
  const trapColumnOfComp = new Map();
  trapCompSorted.forEach((t, col) => trapColumnOfComp.set(t.cid, endings.length + col));

  const K = endings.length + trapCompSorted.length;

  // ---- 组装 (I − Q) 与 B；同一目标的多条边概率相加（状态去重已保证目标节点唯一）----
  const nt = transientIdx.length;
  const posOf = new Int32Array(N).fill(-1);
  transientIdx.forEach((u, p) => { posOf[u] = p; });

  const IQ = Array.from({ length: nt }, () => new Float64Array(nt));
  const Bmat = Array.from({ length: nt }, () => new Float64Array(K));
  transientIdx.forEach((u, row) => {
    IQ[row][row] = 1;
    // 聚合：to node -> 总概率
    const probTo = new Map();
    for (const e of nodes[u].out) {
      const v = nodeByKey.get(e.to).index;
      probTo.set(v, (probTo.get(v) || 0) + e.prob);
    }
    for (const [v, p] of probTo) {
      if (terminalSet.has(v)) {
        Bmat[row][endingColumnOfNode.get(v)] += p;
      } else if (trapNodeSet.has(v)) {
        Bmat[row][trapColumnOfComp.get(comp[v])] += p;
      } else {
        IQ[row][posOf[v]] -= p;
      }
    }
  });

  // ---- 高斯-若尔当消元（部分主元）解 (I − Q) X = B，多右端同时消元 ----
  let singular = false;
  for (let col = 0; col < nt; col++) {
    let piv = col;
    let pivAbs = Math.abs(IQ[col][col]);
    for (let r = col + 1; r < nt; r++) {
      const a = Math.abs(IQ[r][col]);
      if (a > pivAbs) { pivAbs = a; piv = r; }
    }
    if (pivAbs < PIVOT_EPS) { singular = true; break; }
    if (piv !== col) {
      const tmpA = IQ[col]; IQ[col] = IQ[piv]; IQ[piv] = tmpA;
      const tmpB = Bmat[col]; Bmat[col] = Bmat[piv]; Bmat[piv] = tmpB;
    }
    const pivotVal = IQ[col][col];
    for (let j = 0; j < nt; j++) IQ[col][j] /= pivotVal;
    for (let j = 0; j < K; j++) Bmat[col][j] /= pivotVal;
    for (let r = 0; r < nt; r++) {
      if (r === col) continue;
      const factor = IQ[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < nt; j++) IQ[r][j] -= factor * IQ[col][j];
      for (let j = 0; j < K; j++) Bmat[r][j] -= factor * Bmat[col][j];
    }
  }

  if (singular) {
    // 理论上不会发生（删除闭 SCC 后剩余图全部状态可到吸收态，I−Q 可逆）；
    // 命中说明引擎有 bug，宁可报错也不输出假结果。
    result.reason = 'singular';
    result.solved = false;
    result.message = '概率方程组出现奇异矩阵，无法求解（请检查剧情结构并联系开发者）';
    return result;
  }

  const round6 = (x) => {
    const v = Math.round(x * 1e6) / 1e6;
    return Math.max(0, Math.min(1, v));
  };

  // 起点行概率
  const startNode = nodeByKey.get(startKey);
  let startRow;
  if (terminalSet.has(startNode.index)) {
    startRow = new Float64Array(K);
    startRow[endingColumnOfNode.get(startNode.index)] = 1;
  } else if (trapNodeSet.has(startNode.index)) {
    startRow = new Float64Array(K);
    startRow[trapColumnOfComp.get(comp[startNode.index])] = 1;
  } else {
    startRow = Bmat[posOf[startNode.index]];
  }

  result.solved = true;
  result.endings = endings.map((e, col) => ({
    sceneId: e.sceneId,
    title: e.title,
    probability: round6(startRow[col]),
    terminalStateCount: e.terminalStateCount,
    terminalStates: e.terminalStates,
  }));

  result.loops = trapCompSorted.map((t, i) => {
    const col = endings.length + i;
    // 陷阱内部边（用于展示涉及哪些循环跳转）：
    const edgeSet = new Map(); // key -> { edge, from, toSceneId }
    for (const u of t.members) {
      for (const e of nodes[u].out) {
        const v = nodeByKey.get(e.to).index;
        if (comp[v] !== t.cid) continue;
        const key = `${e.edge.sceneId}#${e.edge.optionIndex}->${e.edge.target}`;
        if (!edgeSet.has(key)) {
          edgeSet.set(key, { ...e.edge, fromSceneId: e.edge.sceneId });
        }
      }
    }
    return {
      id: `loop-${i + 1}`,
      probability: round6(startRow[col]),
      scenes: t.sceneIds.map((sid) => ({
        sceneId: sid,
        title: (sceneMap.get(sid) || {}).title || '',
        stateCount: t.members.filter((u) => nodes[u].sceneId === sid).length,
      })),
      stateCount: t.members.length,
      edges: [...edgeSet.values()].sort((a, b) => {
        const ka = `${a.sceneId}#${a.optionIndex}`;
        const kb = `${b.sceneId}#${b.optionIndex}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
    };
  });

  let endingsMass = 0;
  for (const e of result.endings) endingsMass += e.probability;
  let trapped = 0;
  for (const l of result.loops) trapped += l.probability;
  result.trappedProbability = round6(trapped);
  result.totalAccounted = round6(endingsMass + trapped);
  result.message = trapped > 0
    ? `推演完成：${result.endings.length} 个终止场景共承载 ${(endingsMass * 100).toFixed(2)}% 概率，${result.loops.length} 个永久循环承载 ${(trapped * 100).toFixed(2)}%`
    : `推演完成：全部概率最终都到达 ${result.endings.length} 个终止场景，不存在永久循环`;
  return result;
}

function compileSceneCond(scene, conditionErrors) {
  if (!scene.precondition || !String(scene.precondition).trim()) return null;
  try {
    return compile(scene.precondition);
  } catch (e) {
    conditionErrors.push({
      where: `场景 "${scene.id}" 的前置条件`,
      message: e.message, sceneId: scene.id,
    });
    return null;
  }
}

function splitKey(key) {
  const i = key.indexOf('\x00');
  return [key.slice(0, i), key.slice(i + 1)];
}

module.exports = { simulate, SOLVER_TRANSIENT_CAP };
