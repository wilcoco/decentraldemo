// 핵심 로직 테스트: 블록체인 무결성, 위임 가중치, 실시간 지위 변동
import assert from 'node:assert/strict';
import { Democracy, THRESHOLDS } from '../src/democracy.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('아고라 라이브 핵심 로직 테스트\n');

test('시민 등록이 서명되어 체인에 기록된다', () => {
  const d = new Democracy();
  d.registerCitizen('테스트');
  assert.equal(d.chain.blocks.length, 2); // 제네시스 + 등록
  assert.equal(d.chain.verify().valid, true);
});

test('체인 변조가 감지된다', () => {
  const d = new Democracy();
  const c = d.registerCitizen('가');
  const issue = d.createIssue({ title: '의제', domain: '분야' });
  d.propose(c.id, issue.id, '의견');
  assert.equal(d.chain.verify().valid, true);
  // 기록된 트랜잭션 내용을 몰래 수정
  d.chain.blocks[1].transactions[0].data.name = '변조된 이름';
  const check = d.chain.verify();
  assert.equal(check.valid, false);
});

test('위임된 표가 직접 지지자에게 흘러간다 (연쇄 위임 포함)', () => {
  const d = new Democracy();
  const a = d.registerCitizen('가');
  const b = d.registerCitizen('나');
  const c = d.registerCitizen('다');
  const issue = d.createIssue({ title: '의제', domain: '경제' });
  const o = d.propose(a.id, issue.id, '의견'); // 가가 직접 지지 (제안자)
  d.delegate(c.id, '경제', b.id); // 다 → 나
  d.delegate(b.id, '경제', a.id); // 나 → 가
  const weights = d.effectiveWeights(issue.id);
  assert.equal(weights.get(a.id), 3); // 본인 1 + 나 + 다
  const status = d.opinionStatus(d.opinions.get(o.id), weights);
  assert.equal(status.weight, 3);
});

test('직접 지지가 위임보다 우선한다', () => {
  const d = new Democracy();
  const a = d.registerCitizen('가');
  const b = d.registerCitizen('나');
  const issue = d.createIssue({ title: '의제', domain: '경제' });
  const o1 = d.propose(a.id, issue.id, '의견1');
  const o2 = d.propose(b.id, issue.id, '의견2');
  d.delegate(b.id, '경제', a.id); // 나가 가에게 위임했지만
  // 나는 의견2를 직접 지지 중이므로 위임은 무효
  const weights = d.effectiveWeights(issue.id);
  assert.equal(weights.get(a.id), 1);
  assert.equal(weights.get(b.id), 1);
});

test('위임 순환은 표를 소멸시키지 않고 안전하게 무시된다', () => {
  const d = new Democracy();
  const a = d.registerCitizen('가');
  const b = d.registerCitizen('나');
  const c = d.registerCitizen('다');
  const issue = d.createIssue({ title: '의제', domain: '경제' });
  d.propose(a.id, issue.id, '의견');
  d.delegate(b.id, '경제', c.id);
  d.delegate(c.id, '경제', b.id); // 나 ↔ 다 순환
  const weights = d.effectiveWeights(issue.id);
  assert.equal(weights.get(a.id), 1); // 순환된 표는 어디에도 더해지지 않음
});

test('지지 철회 즉시 지위가 강등된다 (레그 없음)', () => {
  const d = new Democracy();
  const citizens = Array.from({ length: 4 }, (_, i) => d.registerCitizen(`시민${i}`));
  const issue = d.createIssue({ title: '의제', domain: '경제' });
  const o = d.propose(citizens[0].id, issue.id, '의견');
  d.addEvidence(citizens[1].id, o.id, '근거 자료');
  for (const c of citizens.slice(1)) d.setSupport(c.id, o.id, true);
  let status = d.opinionStatus(o, d.effectiveWeights(issue.id));
  assert.equal(status.status, '채택'); // 4/4 지지 + 검증됨
  // 두 명이 즉시 지지 철회 → 2/4 = 50%, 여전히 채택 경계
  d.setSupport(citizens[2].id, o.id, false);
  d.setSupport(citizens[3].id, o.id, false);
  status = d.opinionStatus(o, d.effectiveWeights(issue.id));
  assert.equal(status.ratio, 0.5);
  // 한 명 더 철회 → 채택 지위 상실
  d.setSupport(citizens[1].id, o.id, false);
  status = d.opinionStatus(o, d.effectiveWeights(issue.id));
  assert.ok(status.ratio < THRESHOLDS.adopt);
  assert.notEqual(status.status, '채택');
});

test('반론이 근거보다 많으면 지지가 높아도 채택되지 않는다', () => {
  const d = new Democracy();
  const a = d.registerCitizen('가');
  const b = d.registerCitizen('나');
  const issue = d.createIssue({ title: '의제', domain: '경제' });
  const o = d.propose(a.id, issue.id, '의견');
  d.setSupport(b.id, o.id, true); // 100% 지지
  d.addEvidence(a.id, o.id, '근거');
  d.addChallenge(b.id, o.id, '반론1');
  d.addChallenge(b.id, o.id, '반론2');
  const status = d.opinionStatus(o, d.effectiveWeights(issue.id));
  assert.equal(status.status, '반박됨');
});

test('전체 상태 스냅숏이 계산 필드를 포함한다', () => {
  const d = new Democracy();
  const a = d.registerCitizen('가');
  const issue = d.createIssue({ title: '의제', domain: '경제' });
  d.propose(a.id, issue.id, '의견');
  const state = d.getState();
  assert.equal(state.chain.valid, true);
  assert.equal(state.issues.length, 1);
  const op = state.issues[0].opinions[0];
  assert.ok(typeof op.weight === 'number');
  assert.ok(typeof op.status === 'string');
});

console.log(`\n${passed}개 테스트 모두 통과`);
