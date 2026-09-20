'use strict';

// 结局概率推演自检（node test/probability.js）
// 覆盖：权重归一化、条件成立才参与、终止场景概率聚合、含环图精确稳态解、
//       永久循环概率质量（含部分质量被困）、循环涉及场景、无固定步数截断、
//       权重校验、权重随存储规整保留 / 拒绝、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { simulate, SOLVER_TRANSIENT_CAP } = require('../src/probability');
const storage = require('../src/storage');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ============================================================
 * 核心算法
 * ============================================================ */
console.log('权重归一化：');
// a -> good(w=3) / bad(w=1)，两条路均终止
const storySplit = {
  startScene: 'a',
  variables: [],
  scenes: [
    {
      id: 'a', options: [
        { uid: 'o1', text: '大概率', weight: 3, target: 'good' },
        { uid: 'o2', text: '小概率', weight: 1, target: 'bad' },
      ],
    },
    { id: 'good', options: [] },
    { id: 'bad', options: [] },
  ],
};
const r1 = simulate(storySplit);
ok('推演成功（精确解）', r1.solved === true && r1.truncated === false);
const pg = r1.endings.find((e) => e.sceneId === 'good').probability;
const pb = r1.endings.find((e) => e.sceneId === 'bad').probability;
ok('权重 3:1 归一化为 0.75 / 0.25', close(pg, 0.75) && close(pb, 0.25));
ok('无循环质量', r1.trappedProbability === 0 && r1.loops.length === 0);
ok('概率合计 = 1', close(r1.totalAccounted, 1, 1e-6));

// 缺省权重 = 1：两级加权 1/2 * 1/2
const storyDefault = {
  startScene: 'a', variables: [],
  scenes: [
    { id: 'a', options: [{ text: '', target: 'b' }, { text: '', weight: 1, target: 'c' }] },
    { id: 'b', options: [{ text: '', target: 'end' }, { text: '', target: 'end2' }] },
    { id: 'c', options: [] },
    { id: 'end', options: [] },
    { id: 'end2', options: [] },
  ],
};
const rd = simulate(storyDefault);
ok('缺省权重按 1 处理（各结局 0.25 / 0.25 / 0.5）',
  close(rd.endings.find((e) => e.sceneId === 'end').probability, 0.25) &&
  close(rd.endings.find((e) => e.sceneId === 'end2').probability, 0.25) &&
  close(rd.endings.find((e) => e.sceneId === 'c').probability, 0.5));

console.log('仅条件成立的选项参与归一化：');
// a,!k 时“离开”条件不成立，只能拿钥匙；a,k 时“拿钥匙”条件不成立，只能离开
// 权重比永远不被使用（每个状态只有一个选项成立）=> end 概率 1
const storyCond = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [
      { text: '拿钥匙', condition: '!k', weight: 99, target: 'a', assigns: [{ variable: 'k', value: true }] },
      { text: '离开', condition: 'k', weight: 1, target: 'end' },
    ] },
    { id: 'end', options: [] },
  ],
};
const r2 = simulate(storyCond);
ok('状态依赖的可选选项不参与该状态的归一化',
  r2.solved && close(r2.endings[0].probability, 1) && r2.trappedProbability === 0);
ok('枚举出 a 的两个具体状态', r2.stateCount === 3);

// 悬空 / 入口受阻选项不占概率质量：a 有一个悬空选项(w=3) 和一个合法选项(w=1) => end = 1
const storyIgnore = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [
      { text: '悬空', weight: 3, target: 'ghost' },
      { text: '入口冲突', weight: 5, target: 't', assigns: [{ variable: 'k', value: false }] },
      { text: '正路', weight: 1, target: 'end' },
    ] },
    { id: 't', precondition: 'k', options: [] },
    { id: 'end', options: [] },
  ],
};
const r3 = simulate(storyIgnore);
ok('悬空 / 入口受阻选项不占概率质量', close(r3.endings[0].probability, 1));
ok('被忽略选项以警告列出（orphan + blockedEntry）',
  r3.warnings.some((w) => w.type === 'orphanOption') &&
  r3.warnings.some((w) => w.type === 'blockedEntry'));
// 全部选项都不可进入 => 当前具体状态本身成为终止场景
const r3b = simulate({
  startScene: 'a', variables: [],
  scenes: [{ id: 'a', options: [{ text: '', target: 'ghost' }] }],
});
ok('无可进入选项的状态本身成为终止场景', r3b.endings.some((e) => e.sceneId === 'a'));

console.log('终止场景概率聚合（同一终局的多个具体状态）：');
const storyAgg = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [
      { text: '带钥匙', weight: 1, target: 'end', assigns: [{ variable: 'k', value: true }] },
      { text: '不带', weight: 3, target: 'end' },
    ] },
    { id: 'end', options: [] },
  ],
};
const r4 = simulate(storyAgg);
ok('end 总概率 1（0.25+0.75 聚合）', close(r4.endings[0].probability, 1));
ok('记录 2 种终止具体状态', r4.endings[0].terminalStateCount === 2);

console.log('含环图：精确稳态解（非固定步数截断）：');
// 几何分布：wheel 每轮 1/2 赢、1/2 再来；赢的概率极限 = 1
const storyGeom = {
  startScene: 'a', variables: [],
  scenes: [
    { id: 'a', options: [{ text: '', target: 'wheel' }] },
    { id: 'wheel', options: [
      { text: '赢', weight: 1, target: 'win' },
      { text: '再来', weight: 1, target: 'wheel' },
    ] },
    { id: 'win', options: [] },
  ],
};
const r5 = simulate(storyGeom);
ok('可逃逸循环：结局概率恰为 1，循环质量为 0',
  close(r5.endings[0].probability, 1) && r5.trappedProbability === 0);

// 两层环：s<->a 反复，最终从 a 以 1/2 进 end
// p_s = p_a; p_a = 1/2 + 1/2 p_s => p = 1
const storyLoop2 = {
  startScene: 's', variables: [],
  scenes: [
    { id: 's', options: [{ text: '', target: 'a' }] },
    { id: 'a', options: [
      { text: '回 s', weight: 1, target: 's' },
      { text: '结局', weight: 1, target: 'end' },
    ] },
    { id: 'end', options: [] },
  ],
};
const r6 = simulate(storyLoop2);
ok('多场景可逃逸环：结局概率 = 1', close(r6.endings[0].probability, 1) && r6.loops.length === 0);

// 注意：单节点自循环只要存在正概率出口，几何级数极限出口概率恒为 1（与权重无关，
// 权重只改变期望停留时长）。非平凡的概率分割必然来自“进入某个闭 SCC”——
// wheel 赢(w=1) / 进入永久循环(w=3) => 赢概率 = 1/4，被困 = 3/4
const storyGeomW = {
  startScene: 'wheel', variables: [],
  scenes: [
    { id: 'wheel', options: [
      { text: '赢', weight: 1, target: 'win' },
      { text: '进入永动机', weight: 3, target: 'forever' },
    ] },
    { id: 'win', options: [] },
    { id: 'forever', options: [{ text: '', target: 'forever' }] },
  ],
};
const r7 = simulate(storyGeomW);
ok('以 1:3 分流到结局 / 闭陷阱：结局 = 1/4，被困 = 3/4',
  close(r7.endings[0].probability, 0.25) && close(r7.trappedProbability, 0.75));

// 与方程组的代数答案核对：
// s -> a(2) / b(1)；a -> end(1) / s(1)；b -> end(3) / s(1)，解 p_s = 1
const storyMarkov = {
  startScene: 's', variables: [],
  scenes: [
    { id: 's', options: [{ text: '', weight: 2, target: 'a' }, { text: '', weight: 1, target: 'b' }] },
    { id: 'a', options: [{ text: '', weight: 1, target: 'end' }, { text: '', weight: 1, target: 's' }] },
    { id: 'b', options: [{ text: '', weight: 3, target: 'end' }, { text: '', weight: 1, target: 's' }] },
    { id: 'end', options: [] },
  ],
};
const r8 = simulate(storyMarkov);
ok('多节点线性方程组解正确（end=1，无被困质量）',
  close(r8.endings[0].probability, 1) && close(r8.totalAccounted, 1, 1e-6));

console.log('永久循环概率质量：');
// a -> loop(w=1) / end(w=1)；loop 中先 !k 置 k 再 k 永远自循环
// 进入 loop 的 0.5 全部被困
const storyTrap = {
  startScene: 'a', variables: ['k'],
  scenes: [
    { id: 'a', options: [
      { text: '进循环', weight: 1, target: 'loop' },
      { text: '结局', weight: 1, target: 'end' },
    ] },
    { id: 'loop', options: [
      { text: '打转并置 k', condition: '!k', target: 'loop', assigns: [{ variable: 'k', value: true }] },
      { text: '永远打转', condition: 'k', target: 'loop' },
    ] },
    { id: 'end', options: [] },
  ],
};
const r9 = simulate(storyTrap);
ok('结局 0.5 / 被困 0.5',
  close(r9.endings[0].probability, 0.5) && close(r9.trappedProbability, 0.5));
ok('单列 1 个循环且其概率 0.5', r9.loops.length === 1 && close(r9.loops[0].probability, 0.5));
ok('循环涉及场景为 loop 且列出循环边',
  r9.loops[0].scenes.map((s) => s.sceneId).join() === 'loop' &&
  r9.loops[0].edges.some((e) => e.target === 'loop'));
ok('结局 + 循环合计 1', close(r9.totalAccounted, 1, 1e-6));

// 两个陷阱 + 一个结局：1/4 end，1/4 t1，1/2 t2
const storyTwoTraps = {
  startScene: 's', variables: [],
  scenes: [
    { id: 's', options: [
      { text: '', weight: 1, target: 't1' },
      { text: '', weight: 2, target: 't2' },
      { text: '', weight: 1, target: 'e' },
    ] },
    { id: 't1', options: [{ text: '', target: 't1' }] },
    { id: 't2', options: [{ text: '', target: 't2' }] },
    { id: 'e', options: [] },
  ],
};
const r10 = simulate(storyTwoTraps);
ok('多个循环陷阱分别给出概率',
  close(r10.loops.find((l) => l.scenes.some((s) => s.sceneId === 't1')).probability, 0.25) &&
  close(r10.loops.find((l) => l.scenes.some((s) => s.sceneId === 't2')).probability, 0.5) &&
  close(r10.endings[0].probability, 0.25));
ok('被困概率为两陷阱之和 0.75', close(r10.trappedProbability, 0.75));

// 纯陷阱：起点必进死循环，结局列表为空
const storyPureTrap = {
  startScene: 'a', variables: [],
  scenes: [{ id: 'a', options: [{ text: '', target: 'a' }] }],
};
const r11 = simulate(storyPureTrap);
ok('纯陷阱：无结局且被困概率 1',
  r11.endings.length === 0 && close(r11.trappedProbability, 1) && close(r11.totalAccounted, 1, 1e-6));

// 经一段可逃逸路径后必入陷阱
const storyFarTrap = {
  startScene: 's', variables: [],
  scenes: [
    { id: 's', options: [{ text: '', target: 'a' }] },
    { id: 'a', options: [{ text: '', weight: 1, target: 's' }, { text: '', weight: 1, target: 'trap' }] },
    { id: 'trap', options: [{ text: '', target: 'trap' }] },
  ],
};
const r12 = simulate(storyFarTrap);
ok('非平凡环最终全部进入陷阱（陷阱概率 1，s/a 不算循环 SCC）',
  close(r12.loops[0].probability, 1) && r12.loops[0].scenes.map((x) => x.sceneId).join() === 'trap');

console.log('拒绝以截断冒充结果：');
// 瞬态状态超过求解上限 => solved=false，且不返回伪造概率
const r13 = simulate(storyMarkov, { solverCap: 2 });
ok('超过求解规模上限时 solved=false 且原因明确',
  r13.solved === false && r13.reason === 'solverLimit' && r13.endings.length === 0);
ok('上限提示明确说明拒绝失真', /拒绝/.test(r13.message));
// BFS 状态上限
const r13b = simulate(storySplit, { maxStates: 2 });
ok('超过枚举状态上限时 solved=false（truncated）',
  r13b.solved === false && r13b.reason === 'stateLimit' && r13b.truncated === true);
ok('默认求解上限是合理的有限值', SOLVER_TRANSIENT_CAP >= 100);

// 起点前置不成立：无法开始
const r14 = simulate({
  startScene: 'a', variables: ['k'],
  scenes: [{ id: 'a', precondition: 'k', options: [] }],
});
ok('起点被挡：solved=true 但 startBlocked、无结局无循环',
  r14.solved === true && r14.startBlocked === true && r14.endings.length === 0);

console.log('权重校验：');
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && (!re || re.test(e.message)); }
  return false;
};
const baseStory = (weight) => ({
  startScene: 'a',
  scenes: [{ id: 'a', options: [{ text: '', weight, target: 'b' }] }, { id: 'b', options: [] }],
});
ok('权重 0 => 400', throws400(() => simulate(baseStory(0)), /正整数/));
ok('负权重 => 400', throws400(() => simulate(baseStory(-3)), /正整数/));
ok('小数权重 => 400', throws400(() => simulate(baseStory(1.5)), /小数/));
ok('布尔权重 => 400', throws400(() => simulate(baseStory(true)), /布尔/));
ok('非数字字符串 => 400', throws400(() => simulate(baseStory('abc')), /不是合法整数/));
ok('超大权重 => 400', throws400(() => simulate(baseStory(1e12)), /过大|范围/));
ok('错误信息带场景 ID 与选项序号',
  throws400(() => simulate(baseStory('xx')), /场景 "a" 选项 1/));
ok('字符串数字 "4" 合法', simulate(baseStory('4')).solved === true);
ok('缺省 / null / 空串权重合法',
  simulate(baseStory(undefined)).solved &&
  simulate(baseStory(null)).solved &&
  simulate(baseStory('')).solved);
ok('缺少起点 => 400', throws400(() => simulate({ scenes: [] }), /起点/));
ok('条件语法错误 => 400',
  throws400(() => simulate({
    startScene: 'a',
    scenes: [{ id: 'a', options: [{ text: '', condition: 'k &&', target: 'b' }] }, { id: 'b' }],
  }), /语法错误/));

console.log('示例剧情：');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rdemo = simulate(demo);
ok('示例剧情推演成功', rdemo.solved === true && rdemo.endings.length > 0);
ok('示例结局概率合计 + 循环 = 1', close(rdemo.totalAccounted, 1, 1e-6));
ok('示例含终章 ending 的到达概率', rdemo.endings.some((e) => e.sceneId === 'ending' && e.probability > 0));
// 示例含刻意缺陷：警告中应出现悬空跳转与入口受阻
ok('示例的悬空 / 入口受阻选项被警告',
  rdemo.warnings.some((w) => w.type === 'orphanOption') &&
  rdemo.warnings.some((w) => w.type === 'blockedEntry'));

/* ============================================================
 * 持久化：权重随剧情 JSON 保存 / 导入导出
 * ============================================================ */
console.log('权重持久化：');
const norm = storage.normalize({
  title: 't', startScene: 'a',
  scenes: [{
    id: 'a', options: [
      { uid: 'u1', text: '默认', target: 'b' },
      { uid: 'u2', text: '加权', weight: '7', target: 'b' },
    ],
  }, { id: 'b', options: [] }],
});
ok('规整后权重保留（默认 1 / 数字字符串 7）',
  norm.scenes[0].options[0].weight === 1 && norm.scenes[0].options[1].weight === 7);
let persistRejected = false;
try {
  storage.normalize({ startScene: 'a', scenes: [{ id: 'a', options: [{ weight: 0, target: 'b' }] }] });
} catch (e) { persistRejected = e.status === 400 && e.code === 'badWeight'; }
ok('规整化拒绝非法权重（400 badWeight）', persistRejected);

/* ============================================================
 * HTTP API
 * ============================================================ */
(async () => {
  console.log('HTTP API：');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probability-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SEED_ON_START = 'false';
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const req = (method, url, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: payload ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (payload) r.end(payload); else r.end();
  });
  const post = (url, body) => req('POST', url, body);

  try {
    // 草稿推演
    const q1 = await post('/api/simulate', { story: storySplit });
    ok('POST /api/simulate 对草稿推演成功',
      q1.status === 200 && q1.body.solved === true &&
      close(q1.body.endings.find((e) => e.sceneId === 'good').probability, 0.75));

    // 请求体直接是剧情也可以
    const q1b = await post('/api/simulate', storySplit);
    ok('POST /api/simulate 接受裸剧情体', q1b.status === 200 && q1b.body.solved === true);

    // 非法权重 400
    const q2 = await post('/api/simulate', { story: baseStory(0) });
    ok('非法权重返回 400 与明确信息', q2.status === 400 && /权重/.test(q2.body.error || ''));

    // 条件语法错误 400
    const q2b = await post('/api/simulate', {
      story: { startScene: 'a', scenes: [{ id: 'a', options: [{ condition: '!!', target: 'a' }] }] },
    });
    ok('条件语法错误返回 400', q2b.status === 400 && /语法错误/.test(q2b.body.error || ''));

    // 已保存剧情：保存 -> 推演；权重随保存保留；非法权重保存即 400
    const created = await post('/api/stories', storyTrap);
    ok('带权重剧情保存成功', created.status === 201);
    const savedBad = await post('/api/stories', baseStory(-1));
    ok('保存含非法权重的剧情返回 400', savedBad.status === 400 && /权重/.test(savedBad.body.error || ''));

    const q3 = await post(`/api/stories/${created.body.id}/simulate`, {});
    ok('POST /api/stories/:id/simulate 对已保存剧情推演',
      q3.status === 200 && q3.body.solved === true &&
      close(q3.body.trappedProbability, 0.5) && q3.body.loops.length === 1);
    const q4 = await post('/api/stories/no-such-id/simulate', {});
    ok('剧情不存在返回 404', q4.status === 404);

    // 导出的 JSON 含权重，再导入仍在
    const exportRes = await req('GET', `/api/stories/${created.body.id}/export`);
    ok('导出接口返回 JSON', exportRes.status === 200);
    const exported = exportRes.body;
    const allOptions = exported.scenes.flatMap((s) => s.options);
    ok('导出的选项带 weight 字段', allOptions.every((o) => Number.isInteger(o.weight) && o.weight >= 1));
    delete exported.id;
    const reimported = await post('/api/stories', exported);
    ok('导入后权重保留',
      reimported.status === 201 &&
      JSON.stringify(reimported.body.scenes.flatMap((s) => s.options).map((o) => o.weight)) ===
      JSON.stringify(allOptions.map((o) => o.weight)));

    // 超规模时 200 + solved=false（而不是伪造概率或 500）
    const q5 = await post('/api/simulate', { story: storyMarkov });
    ok('正常规模剧情给出精确解', q5.status === 200 && q5.body.solved === true);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项结局概率推演断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
