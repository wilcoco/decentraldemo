// 민주주의 이론 로드맵 반영 테스트 (docs/theory-review.md)
// 블라인드 구간 · 지속 다수 · 헌장 계층 · 추첨 배심 · 위임 · 상한/감쇠/다양성 · 지역
import assert from 'node:assert/strict';
import { Wallet } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';
import {
  joinLine,
  opposeLine,
  queueState,
  delegateTopic,
  selectJury,
  submitVerdict,
} from '../src/weave/queue.js';
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
const setup = (n = 6) => {
  const wallets = ['가', '나', '다', '라', '마', '바', '사', '아'].slice(0, n).map((x) => new Wallet(x));
  const registry = new Map(wallets.map((w) => [w.citizenId, w.publicKey]));
  const node = new WeaveNode({ id: 'n', interests: ['t1'], registry });
  return { wallets, node };
};

console.log('민주주의 이론 로드맵 테스트\n');

await test('블라인드 초기 구간 (콩도르세): 공표 직후에는 집계 비공개 플래그가 선다', async () => {
  const { wallets, node } = setup();
  const [w1] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  const fresh = queueState(node, 't1', { blindMs: 60_000 }).opinions[0];
  assert.equal(fresh.blind, true); // 표시 계층은 이 플래그를 보고 숫자를 숨긴다
  const later = queueState(node, 't1', { blindMs: 60_000, now: Date.now() + 120_000 }).opinions[0];
  assert.equal(later.blind, false); // 구간이 지나면 공개
  assert.equal(queueState(node, 't1').opinions[0].blind, false); // 기본값은 블라인드 없음
});

await test('지속 다수 (매디슨): 임계값 도달 즉시가 아니라 유지해야 채택된다', async () => {
  const { wallets, node } = setup(4);
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  joinLine(node, w2, 't1', p.hash);
  joinLine(node, w3, 't1', p.hash); // 3/4 = 75% ≥ 50%
  const opts = { sustainMs: 300 };
  assert.equal(queueState(node, 't1', opts).opinions[0].status, '채택 대기'); // 순간 다수
  await sleep(350);
  assert.equal(queueState(node, 't1', opts).opinions[0].status, '채택'); // 지속 다수
  // 저역 필터임을 확인: sustainMs=0이면 즉시 채택 (기존 동작 보존)
  assert.equal(queueState(node, 't1').opinions[0].status, '채택');
});

await test('지속 다수는 중간에 조건이 깨지면 시계가 리셋된다', async () => {
  const { wallets, node } = setup(4);
  const [w1, w2, w3, w4] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  joinLine(node, w2, 't1', p.hash);
  joinLine(node, w3, 't1', p.hash);
  await sleep(150);
  // 반대가 들어와 조건(지지>반대 & 50%)이 잠시 깨졌다가 회복
  opposeLine(node, w4, 't1', p.hash);
  opposeLine(node, w3, 't1', p.hash); // w3 이탈: 2 vs 2 → 조건 붕괴
  await sleep(50);
  joinLine(node, w3, 't1', p.hash); // 복귀: 3 vs 1 → 조건 재성립 (시계 리셋)
  const op = queueState(node, 't1', { sustainMs: 150 }).opinions[0];
  assert.equal(op.status, '채택 대기'); // 예전 성립 시점부터가 아니라 다시 센다
  await sleep(200);
  assert.equal(queueState(node, 't1', { sustainMs: 150 }).opinions[0].status, '채택');
});

await test('헌장 계층 (토크빌): 상위 임계값 — 과반으로는 헌장 의제를 못 바꾼다', async () => {
  const { wallets, node } = setup(6);
  const [w1, w2, w3, w4, w5] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '기본권 조항 개정' });
  node.ingest(p);
  joinLine(node, w2, 't1', p.hash);
  joinLine(node, w3, 't1', p.hash); // 3/6 = 50%
  const charter = { adopt: 2 / 3 };
  assert.equal(queueState(node, 't1', charter).opinions[0].status, '우세'); // 헌장 기준 미달
  joinLine(node, w4, 't1', p.hash);
  joinLine(node, w5, 't1', p.hash); // 5/6 ≈ 83% ≥ 2/3
  assert.equal(queueState(node, 't1', charter).opinions[0].status, '채택');
});

await test('추첨 배심 (피시킨·랑드모어): 결정론적 추첨 + 배심 다수 승인 없이 채택 불가', async () => {
  const { wallets, node } = setup(6);
  const [w1, w2, w3, w4] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  for (const w of [w2, w3, w4]) joinLine(node, w, 't1', p.hash); // 4/6 ≥ 50%
  const jury = selectJury(node, p.hash, 3);
  assert.equal(jury.length, 3);
  assert.ok(!jury.includes(w1.citizenId)); // 제안자는 배심 제외
  assert.deepEqual(selectJury(node, p.hash, 3), jury); // 누구나 같은 배심을 재계산 (검증 가능)
  const opts = { jurySize: 3 };
  assert.equal(queueState(node, 't1', opts).opinions[0].status, '배심 심사 중'); // 숙의 관문
  // 배심이 아닌 시민의 판정은 무시된다
  const nonJuror = wallets.find((w) => !jury.includes(w.citizenId) && w !== undefined);
  submitVerdict(node, nonJuror, 't1', p.hash, true);
  assert.equal(queueState(node, 't1', opts).opinions[0].jury.approve, 0);
  // 배심 2/3 승인 → 채택
  const jurors = wallets.filter((w) => jury.includes(w.citizenId));
  submitVerdict(node, jurors[0], 't1', p.hash, true, '근거 타당');
  submitVerdict(node, jurors[1], 't1', p.hash, true, '반론 응답됨');
  assert.equal(queueState(node, 't1', opts).opinions[0].status, '채택');
  // 배심 다수가 기각하면 지지가 높아도 기각
  submitVerdict(node, jurors[0], 't1', p.hash, false, '재검토');
  submitVerdict(node, jurors[2], 't1', p.hash, false, '비용 추계 오류');
  assert.equal(queueState(node, 't1', opts).opinions[0].status, '배심 기각');
});

await test('위임 (다운스): 표가 사슬로 흐르고, 직접 참여가 우선하며, 즉시 회수된다', async () => {
  const { wallets, node } = setup(5);
  const [w1, w2, w3, w4, w5] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  delegateTopic(node, w2, 't1', w1.citizenId); // 나→가
  delegateTopic(node, w3, 't1', w2.citizenId); // 다→나→가 (연쇄)
  let op = queueState(node, 't1').opinions[0];
  assert.equal(op.weight, 3); // 직접 1 + 위임 2
  assert.equal(op.delegatedSupport, 2);
  // 직접 참여가 위임을 우선한다: 다가 직접 반대하면 위임 무효
  opposeLine(node, w3, 't1', p.hash);
  op = queueState(node, 't1').opinions[0];
  assert.equal(op.weight, 2);
  assert.equal(op.against, 1);
  // 즉시 회수
  delegateTopic(node, w2, 't1', null);
  op = queueState(node, 't1').opinions[0];
  assert.equal(op.weight, 1);
  // 순환은 표를 만들지 않는다
  delegateTopic(node, w4, 't1', w5.citizenId);
  delegateTopic(node, w5, 't1', w4.citizenId);
  assert.equal(queueState(node, 't1').opinions[0].weight, 1);
});

await test('안목 가중 상한 (홍-페이지): 한 사람의 목소리는 기본표의 (1+cap)배를 넘지 못한다', async () => {
  const { wallets, node } = setup(8);
  const [w1] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '대박 의견' });
  node.ingest(p);
  for (const w of wallets.slice(1)) joinLine(node, w, 't1', p.hash); // w1 안목 7
  assert.equal(computeInsight(node).citizenHub.get(w1.citizenId), 7);
  const p2 = w1.act('t1', 'PROPOSE', { title: '새 의견' });
  node.ingest(p2);
  const op2 = authorityIndex(node, 't1', { cap: 2 }).find((o) => o.id === p2.hash);
  assert.equal(op2.authority, 3); // 1 + min(2, 3.5) — 안목 3.5라도 상한 2
});

await test('시간 감쇠 (미헬스): 오래된 안목은 반감한다', async () => {
  const { wallets, node } = setup(4);
  const [w1, w2, w3] = wallets;
  const p = w1.act('t1', 'PROPOSE', { title: '의견' });
  node.ingest(p);
  joinLine(node, w2, 't1', p.hash);
  joinLine(node, w3, 't1', p.hash);
  const fresh = computeInsight(node).citizenHub.get(w1.citizenId);
  assert.equal(fresh, 2);
  const halfLifeMs = 1000;
  const decayed = computeInsight(node, undefined, { halfLifeMs, now: Date.now() + 1000 }).citizenHub.get(
    w1.citizenId
  );
  assert.ok(Math.abs(decayed - 1) < 0.05); // 한 반감기 뒤 절반
});

await test('다양성 지표 (랑드모어): 같은 무리의 줄과 다양한 연합의 줄이 구분된다', async () => {
  const { wallets, node } = setup(6);
  const [w1, w2, w3, w4, w5, w6] = wallets;
  // 무리 A(w1,w2,w3)는 모든 의견에 항상 같이 선다
  const x = w1.act('t1', 'PROPOSE', { title: 'X' });
  const y = w1.act('t1', 'PROPOSE', { title: 'Y' });
  node.ingest(x);
  node.ingest(y);
  for (const w of [w2, w3]) joinLine(node, w, 't1', x.hash);
  for (const w of [w2, w3]) joinLine(node, w, 't1', y.hash);
  // 참고: 가족당 입장 하나이므로 서로 다른 가족(X, Y)에 각각 서는 것은 유효
  // 다양한 연합: Z에는 평소 행적이 겹치지 않는 w4, w5, w6이 선다
  const z = w4.act('t1', 'PROPOSE', { title: 'Z' });
  node.ingest(z);
  const w5Own = w5.act('t1', 'PROPOSE', { title: 'W5의 딴 의견' });
  node.ingest(w5Own); // w5의 별도 행적
  joinLine(node, w5, 't1', z.hash); // 가족이 다르므로 w5는 Z에도 선다... (W5 가족과 Z 가족은 별개)
  joinLine(node, w6, 't1', z.hash);
  const result = authorityIndex(node, 't1');
  const X = result.find((o) => o.id === x.hash);
  const Z = result.find((o) => o.id === z.hash);
  assert.ok(X.diversity != null && Z.diversity != null);
  assert.ok(Z.diversity > X.diversity); // 같은 무리(X)보다 다양한 연합(Z)이 높다
});

await test('지역·헌장 표시 (오스트롬 연방화): 카탈로그에서 지역과 헌장 의제가 구분된다', async () => {
  const a = new Peer({ id: 'A', wallet: new Wallet('가'), interests: [], gossipMs: 100, region: '부산' });
  await a.start();
  peers.push(a);
  const b = new Peer({ id: 'B', wallet: new Wallet('나'), interests: [], gossipMs: 100, seeds: [a.addr] });
  await b.start();
  peers.push(b);
  a.announceTopic({ title: '부산 시내버스 개편' }); // region 기본값 = 피어의 지역
  a.announceTopic({ title: '참여 규칙 개정', charter: true, region: '전국' });
  await waitFor(() => b.catalog().length === 2, '카탈로그 수신');
  const items = b.catalog();
  assert.equal(items.find((c) => c.title.includes('버스')).region, '부산');
  const charterItem = items.find((c) => c.charter);
  assert.ok(charterItem);
  // 헌장 의제에는 상위 임계값이 적용된다
  const opts = b.topicOpts(charterItem.topicId);
  assert.equal(opts.adopt, 2 / 3);
});

for (const p of peers) p.stop();
console.log(`\n${passed}개 테스트 모두 통과`);
