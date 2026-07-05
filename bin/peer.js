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
//   k <키워드>      네트워크 키워드 검색 (이슈는 즉시, 본문은 이웃 피어가 찾아 줌)
//   t               전체 이슈 조회 (카탈로그 — 관심도 순)
//   c <제목>        새 이슈 생성 + 네트워크에 공표
//   f <번호>        이슈에 관심 표명(줄서기) + 구독 + 현재 이슈로 전환
//   p <제목>        현재 이슈에 새 의견 제안 (줄의 머리)
//   j <번호> [의견] 지지 줄에 서기 (자기 의견 첨부 가능)
//   o <번호> [의견] 반대 줄에 서기 (자기 의견 첨부 가능)
//   d <번호>        의견 상세: 지지의견/반대의견 목록
//   l <번호>        그 의견 가족의 줄에서 떠나기
//   a <번호> <제목> 해당 의견에서 분기한 수정안 제안
//   s               현재 상태 (의견 줄·길이·권위)
//   h               시민 안목 지수 순위
//   n               연결된 피어 목록
//   q               종료
import readline from 'node:readline';
import { Wallet } from '../src/weave/entry.js';
import { Peer, CATALOG } from '../src/weave/peer.js';
import { tips, queueState } from '../src/weave/queue.js';
import { computeInsight, authorityIndex } from '../src/weave/insight.js';

// ── 인자 파싱 ────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const name = args.name ?? `시민${Math.floor(Math.random() * 1000)}`;
const topics = (args.topics ?? '').split(',').filter(Boolean);
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
console.log(`  구독 주제: ${topics.length ? topics.join(', ') : '(카탈로그만 — t로 전체 이슈를 조회하세요)'}`);
console.log(`  명령: k 검색 / t 전체이슈 / c 이슈생성 / f 관심+구독 / p 제안 / j 지지[+의견] / o 반대[+의견] / d 상세 / l 떠나기 / a 수정안 / s 상태 / h 안목 / n 피어 / q 종료\n`);

let currentTopic = topics[0] ?? null;
let lastList = []; // s 출력의 번호 → 의견 id
let lastCatalog = []; // t 출력의 번호 → 공표 id

const followedTopics = () => [...peer.node.interests].filter((t) => t !== CATALOG);

function printCatalog() {
  const items = peer.catalog();
  lastCatalog = items.map((i) => i.announceId);
  console.log(`\n네트워크 전체 이슈 ${items.length}개 (관심도 순):`);
  items.forEach((i, idx) => {
    const marks = [
      i.following ? '구독중' : null,
      i.topicId === currentTopic ? '현재' : null,
    ].filter(Boolean);
    console.log(
      `  ${idx}. ${i.title}${i.domain ? ` [${i.domain}]` : ''} — 관심 ${i.interest}명` +
        (i.following ? `, 보유 항목 ${i.localEntries}개` : '') +
        (marks.length ? ` (${marks.join('·')})` : '')
    );
  });
  if (!items.length) console.log('  (아직 공표된 이슈가 없습니다 — c <제목>으로 만들어 보세요)');
}

const nameOf = (id) => {
  // 등록부의 공개키로는 이름을 알 수 없으므로, HELLO로 알게 된 이름 캐시가 없으면 ID 축약
  return id === wallet.citizenId ? name : id.slice(0, 10);
};

function printState() {
  if (!followedTopics().length) {
    console.log('구독 중인 이슈가 없습니다. t로 조회하고 f <번호>로 구독하세요.');
    return;
  }
  for (const t of followedTopics()) {
    const withAuthority = authorityIndex(peer.node, t);
    const label = peer.catalog().find((c) => c.topicId === t)?.title ?? t;
    console.log(`\n[${label}] 의견 줄 (${withAuthority.length}개)${t === currentTopic ? ' ← 현재 이슈' : ''}`);
    if (t === currentTopic) lastList = withAuthority.map((o) => o.id);
    withAuthority.forEach((o, i) => {
      const idx = t === currentTopic ? `${i}` : '-';
      const fork = o.parentId ? ' └(수정안)' : '';
      const my = o.standers.includes(wallet.citizenId)
        ? ' [지지 중]'
        : o.opposers.includes(wallet.citizenId)
          ? ' [반대 중]'
          : '';
      console.log(
        `  ${idx}.${fork} [${o.status}] ${o.title} — 지지 ${o.weight}명(권위 ${o.authority.toFixed(1)}) vs 반대 ${o.against}명(권위 ${o.authorityAgainst.toFixed(1)})` +
          `, 지지의견 ${o.supportComments.length}·반대의견 ${o.opposeComments.length}${my}`
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
    if (cmd === 'k' && argText) {
      peer.search(argText).then((hits) => {
        console.log(`\n"${argText}" 검색 결과 ${hits.length}건:`);
        lastCatalog = [];
        hits.forEach((h, i) => {
          if (h.kind === '이슈') {
            lastCatalog.push(h.announceId);
            console.log(`  ${lastCatalog.length - 1}. [이슈] ${h.title} — 관심 ${h.interest}명 (f ${lastCatalog.length - 1} 로 구독)`);
          } else {
            if (h.announceId) lastCatalog.push(h.announceId);
            const fRef = h.announceId ? ` (f ${lastCatalog.length - 1} 로 이슈 구독)` : '';
            console.log(
              `  - [의견][${h.status}] ${h.title} — 이슈 "${h.topicTitle}", 지지 ${h.weight}(권위 ${h.authority?.toFixed(1)}) vs 반대 ${h.against}(권위 ${h.authorityAgainst?.toFixed(1)}), 지지의견 ${h.supportOpinions}·반대의견 ${h.opposeOpinions}, 찾은 피어: ${h.foundBy}${fRef}`
            );
          }
        });
        if (!hits.length) console.log('  (없음 — TTL 밖이거나 존재하지 않는 키워드)');
        rl.prompt();
      });
    } else if (cmd === 't') {
      printCatalog();
    } else if (cmd === 'c' && argText) {
      const { topicId } = peer.announceTopic({ title: argText });
      currentTopic = topicId;
      console.log(`이슈를 생성해 네트워크에 공표했습니다: ${argText} (${topicId})`);
    } else if (cmd === 'f' && rest[0] != null) {
      const announceId = lastCatalog[Number(rest[0])];
      if (!announceId) throw new Error('먼저 t로 카탈로그를 확인하세요');
      const entry = peer.expressInterest(announceId);
      currentTopic = peer.node.byHash.get(announceId).data.topicId;
      console.log('관심 줄에 서고 구독을 시작했습니다 — 과거 항목이 곧 채워집니다.');
      void entry;
    } else if (cmd === 'p' && argText) {
      if (!currentTopic) throw new Error('현재 이슈가 없습니다. c로 만들거나 f로 구독하세요');
      const e = peer.act(currentTopic, 'PROPOSE', { title: argText });
      console.log(`제안했습니다: ${argText} (${e.hash.slice(0, 10)}…)`);
    } else if (cmd === 'j' && rest[0] != null) {
      const opinionId = lastList[Number(rest[0])];
      if (!opinionId) throw new Error('먼저 s로 목록을 확인하세요');
      const comment = rest.slice(1).join(' ') || null;
      peer.supportOpinion(currentTopic, opinionId, comment);
      console.log(comment ? '의견을 첨부해 지지 줄에 섰습니다.' : '지지 줄에 섰습니다. 내 서명이 앞사람들의 자리를 고정합니다.');
    } else if (cmd === 'o' && rest[0] != null) {
      const opinionId = lastList[Number(rest[0])];
      if (!opinionId) throw new Error('먼저 s로 목록을 확인하세요');
      const comment = rest.slice(1).join(' ') || null;
      peer.opposeOpinion(currentTopic, opinionId, comment);
      console.log(comment ? '의견을 첨부해 반대 줄에 섰습니다.' : '반대 줄에 섰습니다. (지지 중이었다면 지지 줄에서 자동으로 빠집니다)');
    } else if (cmd === 'd' && rest[0] != null) {
      const opinionId = lastList[Number(rest[0])];
      if (!opinionId) throw new Error('먼저 s로 목록을 확인하세요');
      const op = authorityIndex(peer.node, currentTopic).find((x) => x.id === opinionId);
      console.log(`\n${op.title} [${op.status}]`);
      if (op.body) console.log(`  ${op.body}`);
      console.log(`  지지 ${op.weight}명 (권위 ${op.authority.toFixed(1)}) / 반대 ${op.against}명 (권위 ${op.authorityAgainst.toFixed(1)})`);
      console.log(`  지지의견 ${op.supportComments.length}건:`);
      for (const cmt of op.supportComments) console.log(`    + ${nameOf(cmt.authorId)}: ${cmt.text}`);
      console.log(`  반대의견 ${op.opposeComments.length}건:`);
      for (const cmt of op.opposeComments) console.log(`    - ${nameOf(cmt.authorId)}: ${cmt.text}`);
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
      console.log('명령: k 검색 / t 전체이슈 / c 이슈생성 / f 관심+구독 / p 제안 / j 지지[+의견] / o 반대[+의견] / d 상세 / l 떠나기 / a 수정안 / s 상태 / h 안목 / n 피어 / q 종료');
    }
  } catch (err) {
    console.log(`오류: ${err.message}`);
  }
  rl.prompt();
});
