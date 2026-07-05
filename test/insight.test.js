// 안목 지수 테스트 (등록특허 10-0913256 / 10-0952391 의 줄서기 구현)
import assert from 'node:assert/strict';
import { Wallet, craftEntry } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';
import { joinLine } from '../src/weave/queue.js';
import { computeInsight, authorityIndex } from '../src/weave/insight.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const setup = (n = 1) => {
  const wallets = ['가', '나', '다', '라', '마', '바'].map((x) => new Wallet(x));
  const registry = new Map(wallets.map((w) => [w.citizenId, w.publicKey]));
  const nodes = Array.from({ length: n }, (_, i) => new WeaveNode({ id: `n${i}`, interests: ['t1'], registry }));
  return { wallets, nodes };
};

console.log('안목 지수 테스트\n');

test('먼저 선 사람일수록 안목 지수가 높다 (뒤에 선 사람 수)', () => {
  const { wallets, nodes } = setup();
  const [a] = nodes;
  const [w1, w2, w3, w4] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  a.ingest(p);
  joinLine(a, w2, 't1', p.hash);
  joinLine(a, w3, 't1', p.hash);
  joinLine(a, w4, 't1', p.hash);
  const { perLine } = computeInsight(a);
  assert.equal(perLine.get(w1.citizenId).get(p.hash), 3); // 제안자 뒤에 3명
  assert.equal(perLine.get(w2.citizenId).get(p.hash), 2);
  assert.equal(perLine.get(w3.citizenId).get(p.hash), 1);
  assert.equal(perLine.get(w4.citizenId).get(p.hash), 0);
});

test('아무도 따라 서지 않는 줄에 서면 평균 안목이 깎인다 (특허 청구항 8: 평균, 자기 조절)', () => {
  const { wallets, nodes } = setup();
  const [a] = nodes;
  const [w1, w2, w3, w4, w5] = wallets;
  const good = w1.act('t1', 'PROPOSE', { title: '좋은 의견' });
  const bad = w5.act('t1', 'PROPOSE', { title: '부실 의견' });
  a.ingest(good);
  a.ingest(bad);
  joinLine(a, w2, 't1', good.hash); // w2가 좋은 의견에 일찍 섬 → 뒤에 2명
  joinLine(a, w3, 't1', good.hash);
  joinLine(a, w4, 't1', good.hash);
  joinLine(a, w2, 't1', bad.hash); // w2가 부실 의견에도 섰지만 아무도 안 따라옴
  const { citizenHub } = computeInsight(a);
  assert.equal(citizenHub.get(w2.citizenId), 1); // (2 + 0) / 2
  assert.equal(citizenHub.get(w3.citizenId), 1); // (1) / 1
});

test('갈라졌다 아문 줄에서도 조상-후손 관계로 순서가 정확히 계산된다', () => {
  const { wallets, nodes } = setup(2);
  const [a, b] = nodes;
  const [w1, w2, w3, w4] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  a.ingest(p);
  b.ingest(p);
  joinLine(a, w2, 't1', p.hash); // 동시에 두 노드에서
  joinLine(b, w3, 't1', p.hash);
  WeaveNode.sync(a, b);
  joinLine(a, w4, 't1', p.hash); // 두 갈래를 모두 참조하며 섬
  const { perLine } = computeInsight(a);
  assert.equal(perLine.get(w2.citizenId).get(p.hash), 1); // 후손은 w4뿐 (w3은 병렬)
  assert.equal(perLine.get(w3.citizenId).get(p.hash), 1);
  assert.equal(perLine.get(w1.citizenId).get(p.hash), 3);
  assert.equal(perLine.get(w4.citizenId).get(p.hash), 0);
});

test('권위 지수 = 서 있는 시민들의 (1+안목) 합 — 같은 길이라도 안목 있는 줄이 무겁다', () => {
  const { wallets, nodes } = setup();
  const [a] = nodes;
  const [w1, w2, w3, w4, w5, w6] = wallets;
  // w1·w2가 좋은 의견의 앞줄에 서서 안목을 쌓는다 (뒤에 2명씩)
  const good = w1.act('t1', 'PROPOSE', { title: '검증된 의견' });
  a.ingest(good);
  joinLine(a, w2, 't1', good.hash);
  joinLine(a, w3, 't1', good.hash);
  joinLine(a, w4, 't1', good.hash);
  // 새 의견 두 개: 하나는 안목 높은 w1이, 하나는 신규 w5가 제안하고 각각 1명씩 선다
  const x = w1.act('t1', 'PROPOSE', { title: 'X안' });
  const y = w5.act('t1', 'PROPOSE', { title: 'Y안' });
  a.ingest(x);
  a.ingest(y);
  joinLine(a, w2, 't1', x.hash);
  joinLine(a, w6, 't1', y.hash);
  const result = authorityIndex(a, 't1');
  const X = result.find((o) => o.id === x.hash);
  const Y = result.find((o) => o.id === y.hash);
  assert.equal(X.weight, Y.weight); // 줄 길이는 2로 동일
  assert.ok(X.authority > Y.authority); // 안목 지수 차이로 권위가 다르다
});

test('안목 지수는 노드 간 동일하게 수렴한다', () => {
  const { wallets, nodes } = setup(2);
  const [a, b] = nodes;
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  a.ingest(p);
  joinLine(a, w2, 't1', p.hash);
  joinLine(a, w3, 't1', p.hash);
  WeaveNode.sync(a, b);
  assert.deepEqual(
    Object.fromEntries(computeInsight(a).citizenHub),
    Object.fromEntries(computeInsight(b).citizenHub)
  );
});

test('분기 증명된 시민은 안목 집계에서 제외되지만 줄의 연결은 끊기지 않는다', () => {
  const { wallets, nodes } = setup(2);
  const [a, b] = nodes;
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  a.ingest(p);
  const j2 = joinLine(a, w2, 't1', p.hash);
  joinLine(a, w3, 't1', p.hash); // w3은 w2 뒤에 선다
  // w2가 이중 발언 (같은 순번으로 다른 항목 서명)
  const forged = craftEntry({
    author: w2.citizenId,
    privateKey: w2.privateKey,
    seq: j2.seq,
    prevHash: j2.prevHash,
    topicId: 't1',
    type: 'LEAVE',
    data: { familyRoot: p.hash },
    ts: Date.now(),
  });
  b.ingest(p);
  b.ingest(forged);
  WeaveNode.sync(a, b);
  const { perLine, citizenHub } = computeInsight(a);
  assert.equal(citizenHub.has(w2.citizenId), false); // 집계 제외
  assert.equal(perLine.get(w1.citizenId).get(p.hash), 1); // w3만 계산 (w2 제외)
  assert.equal(perLine.get(w3.citizenId).get(p.hash), 0); // 그러나 w2를 거친 연결은 유지
});

console.log(`\n${passed}개 테스트 모두 통과`);
