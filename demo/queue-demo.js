// 지지 줄서기 데모: "지지 = 그 의견 뒤에 줄서기"
//  1. 줄서기 — 각자 앞사람을 서명으로 확인하며 선다 (참여가 곧 검증)
//  2. 동시 줄서기 → 갈라진 줄이 다음 사람에 의해 아문다
//  3. 분기 — 수정안 줄로 옮겨 서면 원안 줄에서 자동으로 빠진다
//  4. 떠나기 — 길이는 줄지만 역사는 남는다
//  5. 검열 공격 — 중간 사람을 지우면 뒷사람 전원이 증인이 된다
import { Wallet } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';
import { tips, joinLine, leaveLine, amendLine, lineIntegrity, queueState } from '../src/weave/queue.js';

const line = (s = '') => console.log(s);
const section = (t) => line(`\n━━ ${t} ${'━'.repeat(Math.max(2, 46 - t.length * 2))}`);

const names = ['김하늘', '이도윤', '박서연', '최지호', '정유나', '한민준', '오세아', '류지원'];
const wallets = names.map((n) => new Wallet(n));
const registry = new Map(wallets.map((w) => [w.citizenId, w.publicKey]));
const nameOf = (id) => wallets.find((w) => w.citizenId === id)?.name ?? id.slice(0, 8);
const [haneul, doyun, seoyeon, jiho, yuna, minjun, sea, jiwon] = wallets;

const T = 't_연금개혁';
const seoul = new WeaveNode({ id: '서울노드', interests: [T], registry });
const daejeon = new WeaveNode({ id: '대전노드', interests: [T], registry });

const printState = (node) => {
  for (const o of queueState(node, T).opinions) {
    const tree = o.parentId ? '  └ (수정안) ' : '';
    line(`  ${tree}${o.title} — 줄 길이 ${o.weight}명 (${(o.ratio * 100).toFixed(0)}%)`);
  }
};

section('1. 줄서기 — 참여가 곧 검증');
const p = haneul.act(T, 'PROPOSE', { title: '보험료율 단계 인상 + 자동조정장치' });
seoul.ingest(p);
daejeon.ingest(p);
line(`김하늘이 의견을 제안했다 (줄의 머리, ${p.hash.slice(0, 10)}…)`);
for (const w of [doyun, seoyeon, jiho]) {
  const j = joinLine(seoul, w, T, p.hash);
  line(`${w.name}이(가) ${j.data.behind.map((h) => nameOf(seoul.byHash.get(h).author)).join(', ')} 뒤에 서명하고 섰다`);
}
line('\n서명이 앞사람 항목의 해시를 덮으므로, 뒤에 서는 순간 앞사람들의 자리가 고정된다.');
printState(seoul);

section('2. 동시 줄서기 → 줄이 아문다');
WeaveNode.sync(seoul, daejeon);
joinLine(seoul, yuna, T, p.hash); // 서울에서
joinLine(daejeon, minjun, T, p.hash); // 같은 순간 대전에서
WeaveNode.sync(seoul, daejeon);
line(`정유나(서울)와 한민준(대전)이 동시에 줄 끝에 섰다 → 팁 ${tips(seoul, p.hash).length}개로 갈라짐`);
const healer = joinLine(seoul, sea, T, p.hash);
line(`오세아가 갈라진 끝 ${healer.data.behind.length}개를 모두 참조하며 섰다 → 팁 ${tips(seoul, p.hash).length}개, 줄이 아물었다`);
printState(seoul);

section('3. 분기 — 의견의 진화');
const am = amendLine(seoul, jiwon, T, p.hash, { title: '보험료 인상 + 소득대체율 유지 (수정안)' });
line('류지원이 원안에서 갈라져 수정안 줄을 시작했다.');
joinLine(seoul, seoyeon, T, am.hash);
joinLine(seoul, jiho, T, am.hash);
line('박서연·최지호가 수정안 줄로 옮겨 섰다 — 가족 안의 위치는 하나이므로 원안 줄에서 자동으로 빠진다:');
printState(seoul);

section('4. 떠나기 — 역사는 남고 길이만 준다');
leaveLine(seoul, doyun, T, p.hash);
line('이도윤이 줄을 떠났다. 링크(역사)는 남아 무결성은 유지된다:');
line(`  줄 무결성: ${lineIntegrity(seoul, p.hash).intact ? '정상' : '훼손'}`);
printState(seoul);

section('5. 검열 공격 — 뒷사람 전원이 증인');
WeaveNode.sync(seoul, daejeon);
const victim = [...daejeon.byHash.values()].find((e) => e.type === 'JOIN' && e.author === seoyeon.citizenId && e.data.opinionId === am.hash);
daejeon.entries.get(victim.author).delete(victim.seq);
daejeon.byHash.delete(victim.hash);
line('대전노드가 수정안 줄에서 박서연의 줄서기를 몰래 지웠다.');
const check = lineIntegrity(daejeon, am.hash);
line(`  줄 무결성: ${check.intact ? '정상(문제!)' : '훼손 감지'}`);
for (const d of check.dangling) {
  line(`  증인 ${nameOf(d.witness)}: "내가 서명한 앞사람 항목 ${d.missing.slice(0, 10)}…이 사라졌다"`);
}
line('\n줄서기 구조에서는 지지자가 늘수록 증인이 늘어난다 —');
line('긴 줄일수록 지우기 어렵다. 지지의 크기가 곧 기록의 견고함이다.');
