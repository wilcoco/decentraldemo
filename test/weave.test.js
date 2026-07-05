// 위브 프로토콜 테스트: 서명·수렴·부분 복제·분기 증명·검열 탐지
import assert from 'node:assert/strict';
import { Wallet, craftEntry, verifyEntry, isFork } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const setup = (topics, nodeInterests) => {
  const wallets = ['가', '나', '다', '라'].map((n) => new Wallet(n));
  const registry = new Map(wallets.map((w) => [w.citizenId, w.publicKey]));
  const nodes = nodeInterests.map((ints, i) => new WeaveNode({ id: `n${i}`, interests: ints, registry }));
  return { wallets, registry, nodes };
};

console.log('위브 프로토콜 테스트\n');

test('항목은 서명으로 보호된다: 내용을 고치면 검증 실패', () => {
  const w = new Wallet('가');
  const e = w.act('t1', 'PROPOSE', { title: '원본' });
  assert.equal(verifyEntry(e, w.publicKey), true);
  e.data.title = '조작';
  assert.equal(verifyEntry(e, w.publicKey), false);
});

test('수렴성: 같은 항목 집합은 도착 순서와 무관하게 같은 집계를 만든다', () => {
  const { wallets, nodes } = setup(['t1'], [['t1'], ['t1']]);
  const [a, b] = nodes;
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  const s = w2.act('t1', 'SUPPORT', { opinionId: p.hash });
  const ev = w3.act('t1', 'EVIDENCE', { opinionId: p.hash, text: '근거' });
  // 노드 a: 제안 → 지지 → 근거 순서, 노드 b: 역순
  [p, s, ev].forEach((e) => a.ingest(e));
  [ev, s, p].forEach((e) => b.ingest(e));
  assert.deepEqual(a.tally('t1'), b.tally('t1'));
  assert.equal(a.digestUpTo('t1', a.headsFor('t1')), b.digestUpTo('t1', b.headsFor('t1')));
});

test('최신 우선 병합: 지지 후 철회하면 어떤 순서로 도착해도 미지지', () => {
  const { wallets, nodes } = setup(['t1'], [['t1']]);
  const [a] = nodes;
  const [w1, w2] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  const sup = w2.act('t1', 'SUPPORT', { opinionId: p.hash });
  const wd = w2.act('t1', 'WITHDRAW', { opinionId: p.hash });
  a.ingest(p);
  a.ingest(wd); // 철회가 지지보다 먼저 도착
  a.ingest(sup);
  const [op] = a.tally('t1').opinions;
  assert.equal(op.weight, 1); // 제안자 본인만
});

test('관심 기반 부분 복제: 관심 밖 주제는 저장하지 않는다', () => {
  const { wallets, nodes } = setup(['t1', 't2'], [['t1']]);
  const [a] = nodes;
  const res = a.ingest(wallets[0].act('t2', 'PROPOSE', { title: '다른 주제' }));
  assert.equal(res.accepted, false);
  assert.equal(a.storedCount(), 0);
});

test('가십 동기화로 겹치는 관심 주제가 수렴한다', () => {
  const { wallets, nodes } = setup(['t1'], [['t1'], ['t1'], ['t1']]);
  const [a, b, c] = nodes;
  const p = wallets[0].act('t1', 'PROPOSE', { title: '의견' });
  a.ingest(p);
  c.ingest(wallets[1].act('t1', 'SUPPORT', { opinionId: p.hash }));
  WeaveNode.sync(a, b);
  WeaveNode.sync(b, c);
  WeaveNode.sync(a, b); // c에서 b로 온 지지가 a까지 전파
  assert.deepEqual(a.tally('t1'), c.tally('t1'));
});

test('위임된 표가 흐르고, 분기 증명된 시민은 집계에서 제외된다', () => {
  const { wallets, nodes } = setup(['t1'], [['t1'], ['t1']]);
  const [a, b] = nodes;
  const [w1, w2, w3, w4] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  a.ingest(p);
  a.ingest(w3.act('t1', 'DELEGATE', { to: w1.citizenId })); // 다 → 가 위임
  assert.equal(a.tally('t1').opinions[0].weight, 2); // 가(1) + 다(위임)

  // 나가 이중 발언: 같은 순번으로 지지와 철회를 각각 다른 노드에
  const honest = w2.act('t1', 'SUPPORT', { opinionId: p.hash });
  const forged = craftEntry({
    author: w2.citizenId,
    privateKey: w2.privateKey,
    seq: honest.seq,
    prevHash: honest.prevHash,
    topicId: 't1',
    type: 'WITHDRAW',
    data: { opinionId: p.hash },
    ts: Date.now(),
  });
  assert.equal(isFork(honest, forged), true);
  a.ingest(honest);
  b.ingest(forged);
  WeaveNode.sync(a, b);
  const tally = a.tally('t1');
  assert.deepEqual(tally.flagged, [w2.citizenId]);
  assert.equal(tally.opinions[0].weight, 2); // 나의 지지는 무효
});

test('검열 탐지: 항목을 몰래 지우면 체크포인트 대조에서 불일치', () => {
  const { wallets, nodes } = setup(['t1'], [['t1'], ['t1']]);
  const [a, b] = nodes;
  const [w1, w2] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  const s = w2.act('t1', 'SUPPORT', { opinionId: p.hash });
  const ev = w2.act('t1', 'EVIDENCE', { opinionId: p.hash, text: '근거' });
  [p, s, ev].forEach((e) => a.ingest(e));
  a.makeCheckpoint(w1, 't1');
  WeaveNode.sync(a, b);
  assert.ok(b.auditAgainstCheckpoints('t1').every((r) => r.status === '일치'));
  // b가 중간 항목(지지)을 몰래 삭제 — 뒷 항목이 남아 있어 겉보기엔 완전한 기록
  b.entries.get(s.author).delete(s.seq);
  assert.equal(b.verifyStorage().valid, true);
  const audit = b.auditAgainstCheckpoints('t1');
  assert.ok(audit.some((r) => r.status === '불일치(누락/조작 의심)'));
});

test('체크포인트는 동기화로 전파되어 제3자도 대조할 수 있다', () => {
  const { wallets, nodes } = setup(['t1'], [['t1'], ['t1'], ['t1']]);
  const [a, b, c] = nodes;
  const p = wallets[0].act('t1', 'PROPOSE', { title: '의견' });
  a.ingest(p);
  a.makeCheckpoint(wallets[0], 't1');
  WeaveNode.sync(a, b);
  WeaveNode.sync(b, c);
  assert.ok(c.auditAgainstCheckpoints('t1').every((r) => r.status === '일치'));
});

console.log(`\n${passed}개 테스트 모두 통과`);
