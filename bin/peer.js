#!/usr/bin/env node
// 독립 실행형 P2P 시민 클라이언트
//
// 사용법:
//   node bin/peer.js --name 김하늘 --port 4001 --topics t_연금개혁,t_에너지전환
//   node bin/peer.js --name 이도윤 --port 4002 --seeds 127.0.0.1:4001 --topics t_연금개혁
//
// 터미널 여러 개에서 각각 띄우면 진짜 P2P 네트워크가 된다. 중앙 서버가 없다 —
// 첫 피어는 시드 없이 시작하고, 나머지는 아무 피어나 시드로 잡으면
// 피어 발견으로 그물망이 형성된다.
//
// 명령:
//   p <제목>        새 의견 제안 (줄의 머리)
//   j <번호>        해당 의견 줄에 서기 (지지)
//   l <번호>        그 의견 가족의 줄에서 떠나기
//   a <번호> <제목> 해당 의견에서 분기한 수정안 제안
//   s               현재 상태 (의견 줄·길이·권위)
//   h               시민 안목 지수 순위
//   n               연결된 피어 목록
//   q               종료
import readline from 'node:readline';
import { Wallet } from '../src/weave/entry.js';
import { Peer } from '../src/weave/peer.js';
import { tips, queueState } from '../src/weave/queue.js';
import { computeInsight, authorityIndex } from '../src/weave/insight.js';

// ── 인자 파싱 ────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const name = args.name ?? `시민${Math.floor(Math.random() * 1000)}`;
const topics = (args.topics ?? 't_광장').split(',');
const seeds = (args.seeds ?? '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [host, port] = s.split(':');
    return { host, port: Number(port) };
  });

const wallet = new Wallet(name);
const peer = new Peer({ id: name, wallet, interests: topics, port: Number(args.port ?? 0), seeds });
await peer.start();

console.log(`─ ${name} 의 P2P 시민 클라이언트`);
console.log(`  주소: 127.0.0.1:${peer.port} (다른 피어의 --seeds 값으로 쓰세요)`);
console.log(`  시민 ID: ${wallet.citizenId} (공개키에서 유도, 개인키는 이 프로세스에만 존재)`);
console.log(`  관심 주제: ${topics.join(', ')}`);
console.log(`  명령: p 제안 / j 줄서기 / l 떠나기 / a 수정안 / s 상태 / h 안목 / n 피어 / q 종료\n`);

let currentTopic = topics[0];
let lastList = []; // s 출력의 번호 → 의견 id

const nameOf = (id) => {
  // 등록부의 공개키로는 이름을 알 수 없으므로, HELLO로 알게 된 이름 캐시가 없으면 ID 축약
  return id === wallet.citizenId ? name : id.slice(0, 10);
};

function printState() {
  for (const t of topics) {
    const withAuthority = authorityIndex(peer.node, t);
    console.log(`\n[${t}] 의견 줄 (${withAuthority.length}개)`);
    if (t === currentTopic) lastList = withAuthority.map((o) => o.id);
    withAuthority.forEach((o, i) => {
      const idx = t === currentTopic ? `${i}` : '-';
      const fork = o.parentId ? ' └(수정안)' : '';
      console.log(
        `  ${idx}.${fork} ${o.title} — 길이 ${o.weight}명, 권위 ${o.authority.toFixed(1)}` +
          (o.standers.includes(wallet.citizenId) ? ' [서 있음]' : '')
      );
    });
  }
  console.log(`  (연결 피어 ${peer.sockets.size}개, 등록 시민 ${peer.node.registry.size}명)`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${name}> ` });
rl.prompt();
rl.on('line', (line) => {
  try {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const argText = rest.join(' ');
    if (cmd === 'p' && argText) {
      const e = peer.act(currentTopic, 'PROPOSE', { title: argText });
      console.log(`제안했습니다: ${argText} (${e.hash.slice(0, 10)}…)`);
    } else if (cmd === 'j' && rest[0] != null) {
      const opinionId = lastList[Number(rest[0])];
      if (!opinionId) throw new Error('먼저 s로 목록을 확인하세요');
      peer.act(currentTopic, 'JOIN', { opinionId, behind: tips(peer.node, opinionId) });
      console.log('줄에 섰습니다. 내 서명이 앞사람들의 자리를 고정합니다.');
    } else if (cmd === 'l' && rest[0] != null) {
      const opinionId = lastList[Number(rest[0])];
      if (!opinionId) throw new Error('먼저 s로 목록을 확인하세요');
      const state = queueState(peer.node, currentTopic);
      const op = state.opinions.find((o) => o.id === opinionId);
      peer.act(currentTopic, 'LEAVE', { familyRoot: op.familyRoot });
      console.log('줄에서 떠났습니다 (기록은 남고 길이만 줄어듭니다).');
    } else if (cmd === 'a' && rest.length >= 2) {
      const parentId = lastList[Number(rest[0])];
      if (!parentId) throw new Error('먼저 s로 목록을 확인하세요');
      const title = rest.slice(1).join(' ');
      peer.act(currentTopic, 'AMEND', { parentId, behind: parentId, title, body: '' });
      console.log(`수정안 줄을 시작했습니다: ${title}`);
    } else if (cmd === 's') {
      printState();
    } else if (cmd === 'h') {
      const { citizenHub } = computeInsight(peer.node);
      const sorted = [...citizenHub.entries()].sort((a, b) => b[1] - a[1]);
      console.log('\n안목 지수 (좋은 의견을 일찍 알아본 정도):');
      for (const [id, hub] of sorted.slice(0, 10)) console.log(`  ${nameOf(id)}: ${hub.toFixed(2)}`);
    } else if (cmd === 'n') {
      console.log(`연결 피어 ${peer.sockets.size}개:`);
      for (const { hello } of peer.sockets.values()) {
        if (hello) console.log(`  ${hello.id} @127.0.0.1:${hello.listenPort} [${hello.interests.join(',')}]`);
      }
    } else if (cmd === 'q') {
      peer.stop();
      process.exit(0);
    } else if (cmd) {
      console.log('명령: p 제안 / j 줄서기 / l 떠나기 / a 수정안 / s 상태 / h 안목 / n 피어 / q 종료');
    }
  } catch (err) {
    console.log(`오류: ${err.message}`);
  }
  rl.prompt();
});
