// 안목 지수 데모 — 등록특허 10-0913256 / 10-0952391 (발명자 홍정수)의
// "링크 순서 기반 실시간 평가"를 줄서기 구조 위에 구현한 것.
//
//  1. 좋은 의견에 일찍 선 사람일수록 안목 지수가 올라간다 (실시간, 반복 연산 없음)
//  2. 아무도 따라 서지 않는 줄에 서면 평균 안목이 깎인다 (자기 조절)
//  3. 권위 지수: 같은 길이의 줄이라도 안목이 검증된 시민들이 선 줄이 무겁다
//  4. 특허의 "링크 순서"가 서명 사슬로 암호학적으로 증명된다
import { Wallet } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';
import { joinLine } from '../src/weave/queue.js';
import { computeInsight, authorityIndex } from '../src/weave/insight.js';

const line = (s = '') => console.log(s);
const section = (t) => line(`\n━━ ${t} ${'━'.repeat(Math.max(2, 46 - t.length * 2))}`);

const names = ['김하늘', '이도윤', '박서연', '최지호', '정유나', '한민준', '오세아', '류지원'];
const wallets = names.map((n) => new Wallet(n));
const registry = new Map(wallets.map((w) => [w.citizenId, w.publicKey]));
const nameOf = (id) => wallets.find((w) => w.citizenId === id)?.name ?? id.slice(0, 8);
const [haneul, doyun, seoyeon, jiho, yuna, minjun, sea, jiwon] = wallets;

const T = 't_연금개혁';
const node = new WeaveNode({ id: '노드', interests: [T], registry });

const printHubs = () => {
  const { citizenHub } = computeInsight(node);
  const sorted = [...citizenHub.entries()].sort((a, b) => b[1] - a[1]);
  for (const [id, hub] of sorted) line(`  ${nameOf(id)}: 안목 지수 ${hub.toFixed(2)}`);
};

section('1. 일찍 알아본 사람이 안목을 얻는다');
const good = haneul.act(T, 'PROPOSE', { title: '보험료율 단계 인상 + 자동조정장치' });
node.ingest(good);
line('김하늘이 의견을 제안하고, 이도윤 → 박서연 → 최지호 → 정유나 순으로 줄에 선다.');
for (const w of [doyun, seoyeon, jiho, yuna]) joinLine(node, w, T, good.hash);
line('내 뒤에 선 사람 수가 곧 그 줄에서의 내 안목 지수다 (특허 청구항 2):');
printHubs();
line('\n※ 매 줄서기마다 즉시 재산출된다 — 반복 수렴 연산이 없다 (특허의 핵심 효과).');

section('2. 무분별한 지지는 평균 안목을 깎는다');
const bad = sea.act(T, 'PROPOSE', { title: '연금 전면 폐지 후 재설계' });
node.ingest(bad);
joinLine(node, doyun, T, bad.hash);
line('이도윤이 아무도 따라오지 않는 의견에도 섰다 → 참여한 줄들의 평균이 내려간다 (특허 청구항 8):');
printHubs();

section('3. 권위 지수 — 줄 길이가 같아도 무게가 다르다');
const x = haneul.act(T, 'PROPOSE', { title: 'X안: 수급 개시 연령 조정' });
const y = jiwon.act(T, 'PROPOSE', { title: 'Y안: 기금 운용 개편' });
node.ingest(x);
node.ingest(y);
joinLine(node, seoyeon, T, x.hash); // 안목 검증된 박서연이 X안에
joinLine(node, minjun, T, y.hash); // 신규 참여자 한민준이 Y안에
line('X안(김하늘 제안 + 박서연 지지)과 Y안(류지원 제안 + 한민준 지지), 둘 다 줄 길이 2:');
for (const o of authorityIndex(node, T).filter((o) => [x.hash, y.hash].includes(o.id))) {
  line(`  ${o.title} — 길이 ${o.weight}명, 권위 지수 ${o.authority.toFixed(2)}`);
}
line('권위 지수 = 서 있는 시민들의 (1 + 안목 지수) 합 (특허 수학식 10의 민주주의 적용).');
line('좋은 의견을 일찍 알아봐 온 시민들의 지지가 실려 있는 줄이 더 무겁다.');

section('4. 특허와 줄서기의 결합이 주는 것');
line('특허(2005)의 링크 순서는 서버 타임스탬프에 의존했다.');
line('줄서기 DAG에서는 순서가 서명 사슬 자체로 증명된다 —');
line('"내가 먼저 알아봤다"는 주장이 위조 불가능한 사실이 되고,');
line('안목 지수는 조작할 수 없는 평판이 된다.');
line('\n근거: 등록특허 10-0913256(평가 방법), 10-0952391(가치 분석 시스템)');
