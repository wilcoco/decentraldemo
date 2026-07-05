// 지지 줄서기 프로토콜 테스트
import assert from 'node:assert/strict';
import { Wallet } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';
import { tips, joinLine, leaveLine, amendLine, lineIntegrity, queueState } from '../src/weave/queue.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const setup = (n = 2) => {
  const wallets = ['가', '나', '다', '라', '마', '바'].map((x) => new Wallet(x));
  const registry = new Map(wallets.map((w) => [w.citizenId, w.publicKey]));
  const nodes = Array.from({ length: n }, (_, i) => new WeaveNode({ id: `n${i}`, interests: ['t1'], registry }));
  return { wallets, nodes };
};

console.log('지지 줄서기 프로토콜 테스트\n');

test('줄 길이 = 현재 서 있는 사람 수 (제안자 포함)', () => {
  const { wallets, nodes } = setup(1);
  const [a] = nodes;
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '원안' });
  a.ingest(p);
  joinLine(a, w2, 't1', p.hash);
  joinLine(a, w3, 't1', p.hash);
  const [op] = queueState(a, 't1').opinions;
  assert.equal(op.weight, 3);
  assert.equal(tips(a, p.hash).length, 1); // 줄은 일렬로 이어짐
});

test('뒤에 선 사람이 앞사람의 증인: 중간 항목을 지우면 참조가 허공에 뜬다', () => {
  const { wallets, nodes } = setup(1);
  const [a] = nodes;
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '원안' });
  a.ingest(p);
  const j2 = joinLine(a, w2, 't1', p.hash);
  joinLine(a, w3, 't1', p.hash); // w3은 w2 뒤에 선다
  assert.equal(lineIntegrity(a, p.hash).intact, true);
  // 노드가 w2의 줄서기를 몰래 삭제 (검열)
  a.entries.get(j2.author).delete(j2.seq);
  a.byHash.delete(j2.hash);
  const check = lineIntegrity(a, p.hash);
  assert.equal(check.intact, false);
  assert.equal(check.dangling[0].witness, w3.citizenId); // 뒷사람이 증인
  assert.equal(check.dangling[0].missing, j2.hash);
});

test('동시 줄서기로 갈라진 줄은 다음 사람이 아물게 하고, 사람 수는 중복 없이 센다', () => {
  const { wallets, nodes } = setup(2);
  const [a, b] = nodes;
  const [w1, w2, w3, w4] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '원안' });
  a.ingest(p);
  b.ingest(p);
  joinLine(a, w2, 't1', p.hash); // 서울에서 동시에
  joinLine(b, w3, 't1', p.hash); // 부산에서 동시에
  WeaveNode.sync(a, b);
  assert.equal(tips(a, p.hash).length, 2); // 줄이 두 갈래
  const j4 = joinLine(a, w4, 't1', p.hash); // 다음 사람이 두 팁을 모두 참조
  assert.equal(j4.data.behind.length, 2);
  assert.equal(tips(a, p.hash).length, 1); // 줄이 아물었다
  assert.equal(queueState(a, 't1').opinions[0].weight, 4); // 중복 계산 없음
});

test('수정안 분기: 옮겨 서면 원안 줄에서 자동으로 빠진다 (가족 내 최신 위치 하나)', () => {
  const { wallets, nodes } = setup(1);
  const [a] = nodes;
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '원안' });
  a.ingest(p);
  joinLine(a, w2, 't1', p.hash);
  joinLine(a, w3, 't1', p.hash); // 원안 줄: 3명
  const am = amendLine(a, w2, 't1', p.hash, { title: '수정안' }); // w2가 분기
  joinLine(a, w3, 't1', am.hash); // w3도 수정안으로 옮겨 섬
  const state = queueState(a, 't1');
  const orig = state.opinions.find((o) => o.id === p.hash);
  const amend = state.opinions.find((o) => o.id === am.hash);
  assert.equal(amend.parentId, p.hash);
  assert.equal(amend.familyRoot, p.hash);
  assert.equal(orig.weight, 1); // 제안자만 남음
  assert.equal(amend.weight, 2); // w2(분기 작성) + w3(이동)
});

test('줄 떠나기: 길이는 줄지만 링크(역사)는 남는다', () => {
  const { wallets, nodes } = setup(1);
  const [a] = nodes;
  const [w1, w2] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '원안' });
  a.ingest(p);
  joinLine(a, w2, 't1', p.hash);
  assert.equal(queueState(a, 't1').opinions[0].weight, 2);
  leaveLine(a, w2, 't1', p.hash);
  assert.equal(queueState(a, 't1').opinions[0].weight, 1);
  assert.equal(lineIntegrity(a, p.hash).intact, true); // 링크는 그대로
});

test('줄서기 상태는 노드 간 동기화 후 동일하게 수렴한다', () => {
  const { wallets, nodes } = setup(2);
  const [a, b] = nodes;
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '원안' });
  a.ingest(p);
  joinLine(a, w2, 't1', p.hash);
  const am = amendLine(a, w3, 't1', p.hash, { title: '수정안' });
  WeaveNode.sync(a, b);
  assert.deepEqual(queueState(a, 't1'), queueState(b, 't1'));
  assert.equal(queueState(b, 't1').opinions.find((o) => o.id === am.hash).weight, 1);
});

console.log(`\n${passed}개 테스트 모두 통과`);
