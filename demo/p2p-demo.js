// P2P 네트워크 데모 — 중앙 서버 없이, 실제 TCP 소켓 위에서:
//  1. 시드 하나로 시작된 그물망이 피어 발견으로 스스로 자란다
//  2. 각 시민의 행위가 자기 클라이언트에서 서명되어 전파되고 전체가 수렴한다
//  3. 피어가 죽어도 네트워크는 계속 동작한다
//  4. 늦게 합류한 피어가 과거 전체를 따라잡는다
import { Wallet } from '../src/weave/entry.js';
import { Peer } from '../src/weave/peer.js';
import { tips, queueState } from '../src/weave/queue.js';

const line = (s = '') => console.log(s);
const section = (t) => line(`\n━━ ${t} ${'━'.repeat(Math.max(2, 46 - t.length * 2))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`시간 초과: ${what}`);
}

const T = 't_연금개혁';
const digest = (p) => p.node.digestUpTo(T, p.node.headsFor(T)).slice(0, 12);

section('1. 그물망 형성 — 중앙 서버 없음');
const haneul = new Peer({ id: '김하늘', wallet: new Wallet('김하늘'), interests: [T], gossipMs: 150 });
await haneul.start();
line(`김하늘이 첫 피어를 띄웠다 (127.0.0.1:${haneul.port}) — 이것이 유일한 시드`);
const doyun = new Peer({ id: '이도윤', wallet: new Wallet('이도윤'), interests: [T], seeds: [haneul.addr], gossipMs: 150 });
const seoyeon = new Peer({ id: '박서연', wallet: new Wallet('박서연'), interests: [T], seeds: [haneul.addr], gossipMs: 150 });
await Promise.all([doyun.start(), seoyeon.start()]);
const jiho = new Peer({ id: '최지호', wallet: new Wallet('최지호'), interests: [T], seeds: [doyun.addr], gossipMs: 150 });
await jiho.start();
line('이도윤·박서연은 김하늘을, 최지호는 이도윤을 시드로 접속 —');
await waitFor(() => [haneul, doyun, seoyeon, jiho].every((p) => p.sockets.size >= 3), '피어 발견으로 완전 연결');
line(`피어 발견(PEERS 교환)으로 4명 전원이 서로 연결됐다: ${[haneul, doyun, seoyeon, jiho].map((p) => `${p.id} ${p.sockets.size}연결`).join(', ')}`);

section('2. 행위 → 서명 → 전파 → 수렴');
const p = haneul.act(T, 'PROPOSE', { title: '보험료율 단계 인상 + 자동조정장치' });
line('김하늘이 자기 클라이언트에서 서명한 제안을 냈다 (개인키는 김하늘의 기기에만).');
await waitFor(() => [doyun, seoyeon, jiho].every((x) => x.node.byHash.has(p.hash)), '제안 전파');
doyun.act(T, 'JOIN', { opinionId: p.hash, behind: tips(doyun.node, p.hash) });
await waitFor(() => seoyeon.node.entriesForTopic(T).length >= 2, '줄서기 전파');
seoyeon.act(T, 'JOIN', { opinionId: p.hash, behind: tips(seoyeon.node, p.hash) });
await waitFor(
  () => [haneul, doyun, seoyeon, jiho].every((x) => queueState(x.node, T).opinions[0]?.weight === 3),
  '전체 수렴'
);
line('이도윤(자기 피어에서), 박서연(자기 피어에서)이 줄에 섰다.');
line(`네 피어의 주제 요약이 모두 일치한다: ${[haneul, doyun, seoyeon, jiho].map(digest).join(' = ')}`);
line(`줄 길이: ${queueState(jiho.node, T).opinions[0].weight}명 (최지호 피어에서 확인)`);

section('3. 피어 사망 — 네트워크는 계속된다');
doyun.stop();
line('이도윤의 클라이언트가 꺼졌다.');
await sleep(200);
const p2 = haneul.act(T, 'PROPOSE', { title: '수급 개시 연령 조정' });
await waitFor(() => jiho.node.byHash.has(p2.hash), '남은 피어끼리 전파');
line('김하늘의 새 제안이 남은 피어들에게 정상 전파됐다 — 단일 장애점이 없다.');
line('(이도윤이 다시 켜면 반보정 가십이 빠진 기간 전체를 채워 준다)');

section('4. 늦은 합류자 — 과거 전체를 따라잡는다');
const late = new Peer({ id: '정유나', wallet: new Wallet('정유나'), interests: [T], seeds: [jiho.addr], gossipMs: 150 });
await late.start();
line('정유나가 이제서야 최지호를 시드로 합류했다.');
await waitFor(
  () => late.node.entriesForTopic(T).length === haneul.node.entriesForTopic(T).length,
  '늦은 피어 수렴'
);
line(`정유나의 요약 = 김하늘의 요약: ${digest(late)} = ${digest(haneul)}`);
line('중앙 서버 없이, 서명 로그와 가십만으로 역사가 복원된다.');

line('\n터미널에서 직접 해보기:');
line('  node bin/peer.js --name 김하늘 --port 4001 --topics t_연금개혁');
line('  node bin/peer.js --name 이도윤 --port 4002 --seeds 127.0.0.1:4001 --topics t_연금개혁');

for (const x of [haneul, seoyeon, jiho, late]) x.stop();
