// 지지/반대 입장 테스트 — 반대 줄, 의견 첨부, 입장 전환, 헛발질 감점, 검색 조회
import assert from 'node:assert/strict';
import { Wallet } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';
import { joinLine, opposeLine, leaveLine, queueState, tips, lineIntegrity } from '../src/weave/queue.js';
import { computeInsight, authorityIndex } from '../src/weave/insight.js';
import { Peer } from '../src/weave/peer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`시간 초과: ${what}`);
}

let passed = 0;
const peers = [];
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const setup = () => {
  const wallets = ['가', '나', '다', '라', '마', '바'].map((x) => new Wallet(x));
  const registry = new Map(wallets.map((w) => [w.citizenId, w.publicKey]));
  const node = new WeaveNode({ id: 'n', interests: ['t1'], registry });
  return { wallets, node };
};

console.log('지지/반대 입장 테스트\n');

await test('지지 줄과 반대 줄이 따로 서고 함께 조회된다', async () => {
  const { wallets, node } = setup();
  const [w1, w2, w3, w4] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  joinLine(node, w2, 't1', p.hash);
  opposeLine(node, w3, 't1', p.hash);
  opposeLine(node, w4, 't1', p.hash);
  const [op] = queueState(node, 't1').opinions;
  assert.equal(op.weight, 2); // 제안자 + w2
  assert.equal(op.against, 2); // w3, w4
  assert.equal(op.status, '경합');
  assert.equal(lineIntegrity(node, p.hash).intact, true); // 반대 줄도 무결성 점검 대상
});

await test('의견을 첨부해 지지/반대할 수 있고, 지지의견·반대의견 목록으로 축적된다', async () => {
  const { wallets, node } = setup();
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  joinLine(node, w2, 't1', p.hash, '재정 추계를 보면 이 안이 유일하게 지속 가능하다');
  opposeLine(node, w3, 't1', p.hash, '세대 간 형평 문제를 간과했다');
  const [op] = queueState(node, 't1').opinions;
  assert.equal(op.supportComments.length, 1);
  assert.equal(op.supportComments[0].authorId, w2.citizenId);
  assert.match(op.supportComments[0].text, /지속 가능/);
  assert.equal(op.opposeComments.length, 1);
  assert.match(op.opposeComments[0].text, /형평/);
});

await test('입장 전환: 지지 → 반대로 옮기면 지지 줄에서 자동으로 빠진다 (첨부 의견은 역사로 남음)', async () => {
  const { wallets, node } = setup();
  const [w1, w2] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  joinLine(node, w2, 't1', p.hash, '처음엔 좋아 보였다');
  let [op] = queueState(node, 't1').opinions;
  assert.equal(op.weight, 2);
  opposeLine(node, w2, 't1', p.hash, '자료를 보니 비용 추계가 틀렸다');
  [op] = queueState(node, 't1').opinions;
  assert.equal(op.weight, 1); // 지지 줄에서 빠짐
  assert.equal(op.against, 1); // 반대 줄에 섬
  assert.equal(op.supportComments.length, 1); // 과거 지지의견은 기록으로 남는다
  assert.equal(op.opposeComments.length, 1);
});

await test('반대가 우세해지면 상태가 "반대 우세"로 바뀌고, 떠나면 다시 회복된다 (레그 없음)', async () => {
  const { wallets, node } = setup();
  const [w1, w2, w3, w4] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  opposeLine(node, w2, 't1', p.hash);
  opposeLine(node, w3, 't1', p.hash);
  assert.equal(queueState(node, 't1').opinions[0].status, '반대 우세');
  leaveLine(node, w2, 't1', p.hash);
  leaveLine(node, w3, 't1', p.hash);
  const [op] = queueState(node, 't1').opinions;
  assert.equal(op.against, 0);
  assert.notEqual(op.status, '반대 우세');
  void w4;
});

await test('헛발질 감점: 진 쪽에 서 있으면 격차만큼 안목이 깎이고, 떠나면 감점이 사라진다', async () => {
  const { wallets, node } = setup();
  const [w1, w2, w3, w4, w5, w6] = wallets;
  // w1이 좋은 줄에서 안목을 쌓는다 (뒤에 2명)
  const good = w1.act('t1', 'PROPOSE', { title: '좋은 의견' });
  node.ingest(good);
  joinLine(node, w2, 't1', good.hash);
  joinLine(node, w3, 't1', good.hash);
  assert.equal(computeInsight(node).citizenHub.get(w1.citizenId), 2);
  // w1이 나쁜 의견을 제안했는데 반대가 3명 몰린다 (지지 1 vs 반대 3 → 격차 2)
  const bad = w1.act('t1', 'PROPOSE', { title: '나쁜 의견' });
  node.ingest(bad);
  opposeLine(node, w4, 't1', bad.hash);
  opposeLine(node, w5, 't1', bad.hash);
  opposeLine(node, w6, 't1', bad.hash);
  const hubWhileLosing = computeInsight(node).citizenHub.get(w1.citizenId);
  assert.equal(hubWhileLosing, 0); // (2 + (0-2)) / 2 = 0 — 높던 안목이 깎였다
  // 판단을 철회하면(줄에서 떠나면) 감점은 사라지고 평균 희석만 남는다
  leaveLine(node, w1, 't1', bad.hash);
  const hubAfterLeave = computeInsight(node).citizenHub.get(w1.citizenId);
  assert.equal(hubAfterLeave, 1); // (2 + 0) / 2
});

await test('안목이 음수여도 기본 1표는 불가침 — 권위 기여는 1 밑으로 내려가지 않는다', async () => {
  const { wallets, node } = setup();
  const [w1, w2, w3, w4] = wallets;
  const bad = w1.act('t1', 'PROPOSE', { title: '외로운 의견' });
  node.ingest(bad);
  opposeLine(node, w2, 't1', bad.hash);
  opposeLine(node, w3, 't1', bad.hash);
  opposeLine(node, w4, 't1', bad.hash);
  const hub = computeInsight(node).citizenHub.get(w1.citizenId);
  assert.ok(hub < 0); // 감점으로 음수
  const [op] = authorityIndex(node, 't1');
  assert.equal(op.authority, 1); // 그래도 w1의 목소리는 1
  // 반대 줄에도 안목이 쌓인다: 일찍 반대한 w2(뒤에 2명)=+2, w3=+1, w4=0
  assert.equal(op.authorityAgainst, (1 + 2) + (1 + 1) + (1 + 0));
});

await test('P2P 검색 결과에 지지/반대/의견 수/상태가 담겨 온다', async () => {
  const a = new Peer({ id: 'A', wallet: new Wallet('가'), interests: [], gossipMs: 100 });
  await a.start();
  peers.push(a);
  const b = new Peer({ id: 'B', wallet: new Wallet('나'), interests: [], gossipMs: 100, seeds: [a.addr] });
  await b.start();
  peers.push(b);
  const { topicId } = a.announceTopic({ title: '연금 이슈' });
  const p = a.act(topicId, 'PROPOSE', { title: '검색가능한특별의견', body: '' });
  a.supportOpinion(topicId, p.hash, '근거 자료 첨부'); // 제안자가 의견 첨부 지지 (이미 지지 중이므로 코멘트 추가)
  const c = new Wallet('다');
  a.node.registry.set(c.citizenId, c.publicKey);
  opposeLine(a.node, c, topicId, p.hash, '반대 근거');
  await waitFor(() => b.catalog().length === 1, '카탈로그');
  const hits = await b.search('검색가능한특별의견', { timeoutMs: 800 });
  const hit = hits.find((h) => h.kind === '의견');
  assert.ok(hit);
  assert.equal(hit.weight, 1);
  assert.equal(hit.against, 1);
  assert.equal(hit.supportOpinions, 1);
  assert.equal(hit.opposeOpinions, 1);
  assert.equal(hit.status, '경합');
  assert.ok(hit.authority >= 1);
});

for (const p of peers) p.stop();
console.log(`\n${passed}개 테스트 모두 통과`);
