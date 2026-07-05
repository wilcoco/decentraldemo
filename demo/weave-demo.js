// 위브 네트워크 데모: 전역 블록체인 없이 분권형 신뢰가 성립하는 과정을 보여준다.
//
// 시나리오
//  1. 노드 4개가 각자 관심 있는 주제만 복제한다 (전체 복제 강제 없음)
//  2. 시민들의 행위가 서로 다른 노드에서 발생하고, 가십으로 수렴한다
//  3. 관심이 겹치는 노드들끼리 체크포인트로 서로의 기록을 엮는다
//  4. 공격 시연: (a) 이중 발언(로그 분기) → 증명·제외
//               (b) 저장 항목 조작 → 서명 검증에 적발
//               (c) 불리한 항목 몰래 삭제(검열) → 체크포인트 대조에 적발
import { Wallet, craftEntry } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';

const line = (s = '') => console.log(s);
const section = (t) => line(`\n━━ ${t} ${'━'.repeat(Math.max(2, 46 - t.length * 2))}`);

// ── 신원 계층: 시민 지갑 (개인키는 각자의 단말에만 존재) ──────
const names = ['김하늘', '이도윤', '박서연', '최지호', '정유나', '한민준', '오세아', '류지원'];
const wallets = names.map((n) => new Wallet(n));
const registry = new Map(wallets.map((w) => [w.citizenId, w.publicKey]));
const nameOf = (id) => wallets.find((w) => w.citizenId === id)?.name ?? id.slice(0, 8);
const [haneul, doyun, seoyeon, jiho, yuna, minjun, sea, jiwon] = wallets;

// ── 주제(의제)와 노드: 각 노드는 관심 주제만 복제한다 ─────────
const PENSION = 't_연금개혁';
const ENERGY = 't_에너지전환';
const HOUSING = 't_주거안정';

const seoul = new WeaveNode({ id: '서울노드', interests: [PENSION, ENERGY], registry });
const busan = new WeaveNode({ id: '부산노드', interests: [ENERGY, HOUSING], registry });
const daejeon = new WeaveNode({ id: '대전노드', interests: [PENSION, HOUSING], registry });
const jeju = new WeaveNode({ id: '제주노드', interests: [ENERGY], registry });
const nodes = [seoul, busan, daejeon, jeju];

section('1. 관심 기반 부분 복제');
line('노드마다 복제하는 주제가 다르다 — 모두가 모든 것을 저장할 필요가 없다:');
for (const n of nodes) line(`  ${n.id}: [${[...n.interests].map((t) => t.slice(2)).join(', ')}]`);

// ── 시민 행위: 각자 가까운 노드에 제출된다 ────────────────────
const p1 = haneul.act(PENSION, 'PROPOSE', { title: '보험료율 단계 인상 + 자동조정장치' });
const p2 = doyun.act(PENSION, 'PROPOSE', { title: '기초연금 강화 중심 개편' });
const e1 = sea.act(ENERGY, 'PROPOSE', { title: '재생에너지 60% + 원전 계속운전' });
const h1 = jiwon.act(HOUSING, 'PROPOSE', { title: '역세권 고밀 개발과 공공기여' });
seoul.ingest(p1);
seoul.ingest(p2);
seoul.ingest(seoyeon.act(PENSION, 'SUPPORT', { opinionId: p1.hash }));
seoul.ingest(jiho.act(PENSION, 'EVIDENCE', { opinionId: p1.hash, text: '자동조정장치 도입국의 재정 안정 사례' }));
seoul.ingest(jiho.act(PENSION, 'SUPPORT', { opinionId: p1.hash }));
jeju.ingest(e1);
jeju.ingest(yuna.act(ENERGY, 'SUPPORT', { opinionId: e1.hash }));
busan.ingest(h1);
busan.ingest(minjun.act(HOUSING, 'SUPPORT', { opinionId: h1.hash }));
// 위임: 한민준은 연금 주제를 박서연에게 맡긴다 (언제든 회수 가능)
seoul.ingest(minjun.act(PENSION, 'DELEGATE', { to: seoyeon.citizenId }));

section('2. 가십 동기화 → 수렴');
line('동기화 전, 같은 주제라도 노드마다 아는 것이 다르다:');
line(`  연금 요약  서울:${seoul.digestUpTo(PENSION, seoul.headsFor(PENSION)).slice(0, 12)}…  대전:${daejeon.digestUpTo(PENSION, daejeon.headsFor(PENSION)).slice(0, 12)}…`);
// 이웃끼리 몇 라운드 교환하면 관심이 겹치는 주제는 같은 상태에 도달한다
for (let round = 0; round < 2; round++) {
  WeaveNode.sync(seoul, busan);
  WeaveNode.sync(busan, daejeon);
  WeaveNode.sync(daejeon, seoul);
  WeaveNode.sync(busan, jeju);
}
line('동기화 후:');
line(`  연금 요약  서울:${seoul.digestUpTo(PENSION, seoul.headsFor(PENSION)).slice(0, 12)}…  대전:${daejeon.digestUpTo(PENSION, daejeon.headsFor(PENSION)).slice(0, 12)}…`);
line(`  에너지 요약  서울:${seoul.digestUpTo(ENERGY, seoul.headsFor(ENERGY)).slice(0, 12)}…  부산:${busan.digestUpTo(ENERGY, busan.headsFor(ENERGY)).slice(0, 12)}…  제주:${jeju.digestUpTo(ENERGY, jeju.headsFor(ENERGY)).slice(0, 12)}…`);
line('저장량 (관심 주제만 저장하므로 노드마다 다르다):');
for (const n of nodes) line(`  ${n.id}: ${n.storedCount()}개 항목`);

const t = seoul.tally(PENSION);
line('\n서울노드가 접은 연금 주제 집계 (어느 노드가 계산해도 동일):');
for (const o of t.opinions) line(`  [${o.status}] ${o.title} — 유효 지지 ${o.weight} (${(o.ratio * 100).toFixed(0)}%)`);

section('3. 상호참조 체크포인트 — 기록 엮기');
line('관심이 겹치는 노드 운영자들이 주제 상태 요약을 자기 로그에 서명해 박는다.');
const cp = seoul.makeCheckpoint(haneul, PENSION);
WeaveNode.sync(seoul, daejeon); // 체크포인트가 대전으로 전파된다
line(`  서울(김하늘)의 연금 체크포인트: digest ${cp.data.digest.slice(0, 12)}…`);
line(`  대전노드의 대조 결과: ${JSON.stringify(daejeon.auditAgainstCheckpoints(PENSION).map((r) => r.status))}`);

section('4-a. 공격: 이중 발언 (로그 분기)');
line('정유나가 서울에는 "1안 지지", 제주에는 같은 순번으로 "철회"를 서명해 보낸다.');
const honest = yuna.act(ENERGY, 'SUPPORT', { opinionId: e1.hash });
const forged = craftEntry({
  author: yuna.citizenId,
  privateKey: yuna.privateKey,
  seq: honest.seq, // 같은 순번, 다른 내용 = 로그 분기
  prevHash: honest.prevHash,
  topicId: ENERGY,
  type: 'WITHDRAW',
  data: { opinionId: e1.hash },
  ts: Date.now(),
});
seoul.ingest(honest);
jeju.ingest(forged);
line('두 진영이 만나기 전에는 각자 모른다. 동기화 순간 —');
WeaveNode.sync(seoul, jeju);
const proof = [...seoul.forkProofs.keys(), ...jeju.forkProofs.keys()];
line(`  분기 증명 확보: ${proof.map(nameOf).join(', ')} (두 서명 자체가 증거, 전파 가능)`);
line(`  집계 제외 명단: ${seoul.tally(ENERGY).flagged.map(nameOf).join(', ')}`);

section('4-b. 공격: 저장 항목 조작');
const victim = busan.entriesForTopic(HOUSING).find((e) => e.type === 'PROPOSE');
victim.data.title = '조작된 제목';
const check = busan.verifyStorage();
line(`부산노드가 저장된 제안의 제목을 몰래 고쳤다 → 자체 서명 점검: ${check.valid ? '통과(문제)' : `적발 (${check.bad.length}건 서명 불일치)`}`);
victim.data.title = '역세권 고밀 개발과 공공기여'; // 원상 복구

section('4-c. 공격: 불리한 항목 몰래 삭제 (검열)');
line('대전노드가 연금 주제에서 근거 항목 하나를 몰래 지운다 (최지호의 뒷 항목은 남겨 티가 안 나게).');
const target = daejeon.entriesForTopic(PENSION).find((e) => e.type === 'EVIDENCE');
daejeon.entries.get(target.author).delete(target.seq);
line('서명 점검은 통과한다 (남은 항목들은 멀쩡하므로):');
line(`  대전 자체 점검: ${daejeon.verifyStorage().valid ? '통과' : '적발'}`);
line('그러나 서울이 서명해 둔 체크포인트와 대조하면 —');
for (const r of daejeon.auditAgainstCheckpoints(PENSION)) {
  line(`  ${nameOf(r.operator)}의 체크포인트 대조: ${r.status}`);
}
line('\n서명은 "고쳐 쓰기"를 막고, 상호참조는 "몰래 빼기"를 막는다.');
line('관심 있는 사람이 많을수록 복제본과 상호참조가 늘어난다 — 관심이 곧 보안이다.');
