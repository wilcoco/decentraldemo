// P2P 피어 테스트 — 실제 TCP 소켓 위에서의 전파·수렴·발견·장애 허용
import assert from 'node:assert/strict';
import { Wallet, craftEntry } from '../src/weave/entry.js';
import { Peer } from '../src/weave/peer.js';
import { queueState, tips } from '../src/weave/queue.js';

const T = 't1';
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
async function makePeer(opts) {
  const p = new Peer({ gossipMs: 100, interests: [T], ...opts });
  await p.start();
  peers.push(p);
  return p;
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('P2P 피어 테스트 (실제 TCP)\n');

await test('행위가 피어 간에 전파되고 양방향으로 수렴한다', async () => {
  const w1 = new Wallet('가');
  const w2 = new Wallet('나');
  const a = await makePeer({ id: 'A', wallet: w1 });
  const b = await makePeer({ id: 'B', wallet: w2, seeds: [a.addr] });
  const p = a.act(T, 'PROPOSE', { title: '의견' });
  await waitFor(() => b.node.byHash.has(p.hash), 'B가 제안을 수신');
  // B가 자기 노드가 아는 팁 뒤에 줄을 선다
  b.act(T, 'JOIN', { opinionId: p.hash, behind: tips(b.node, p.hash) });
  await waitFor(() => queueState(a.node, T).opinions[0]?.weight === 2, 'A가 줄서기를 수신');
  assert.equal(queueState(a.node, T).opinions[0].weight, 2);
});

await test('늦게 합류한 피어가 반보정 가십으로 과거 전체를 따라잡는다', async () => {
  const w1 = new Wallet('가');
  const w2 = new Wallet('나');
  const a = await makePeer({ id: 'A2', wallet: w1 });
  const p = a.act(T, 'PROPOSE', { title: '의견' });
  a.act(T, 'JOIN', { opinionId: p.hash, behind: [p.hash] }); // 히스토리를 쌓은 뒤
  const late = await makePeer({ id: 'L', wallet: w2, seeds: [a.addr] }); // 늦게 합류
  await waitFor(
    () => late.node.entriesForTopic(T).length === a.node.entriesForTopic(T).length,
    '늦은 피어의 수렴'
  );
  assert.equal(
    late.node.digestUpTo(T, late.node.headsFor(T)),
    a.node.digestUpTo(T, a.node.headsFor(T))
  );
});

await test('피어 발견: 시드에게만 접속해도 서로 모르던 피어끼리 연결된다', async () => {
  const seed = await makePeer({ id: 'S' }); // 지갑 없는 관찰자(시드) 피어
  const w1 = new Wallet('가');
  const w2 = new Wallet('나');
  const b = await makePeer({ id: 'B3', wallet: w1, seeds: [seed.addr] });
  const c = await makePeer({ id: 'C3', wallet: w2, seeds: [seed.addr] });
  const p = b.act(T, 'PROPOSE', { title: '의견' });
  await waitFor(() => c.node.byHash.has(p.hash), 'C가 B의 제안을 수신 (S 경유 발견)');
  assert.ok(c.node.byHash.has(p.hash));
});

await test('이중 발언이 반보정 가십으로 만나 네트워크 전체에 증명된다', async () => {
  const w1 = new Wallet('가');
  const cheater = new Wallet('나');
  const a = await makePeer({ id: 'A4', wallet: w1 });
  const b = await makePeer({ id: 'B4', seeds: [a.addr] });
  const p = a.act(T, 'PROPOSE', { title: '의견' });
  await waitFor(() => b.node.byHash.has(p.hash), 'B가 제안 수신');
  // 사기꾼이 같은 순번으로 두 항목을 서명해 A와 B에 하나씩 보낸다
  const honest = cheater.act(T, 'JOIN', { opinionId: p.hash, behind: [p.hash] });
  const forged = craftEntry({
    author: cheater.citizenId,
    privateKey: cheater.privateKey,
    seq: honest.seq,
    prevHash: honest.prevHash,
    topicId: T,
    type: 'LEAVE',
    data: { familyRoot: p.hash },
    ts: Date.now(),
  });
  a.node.registry.set(cheater.citizenId, cheater.publicKey);
  b.node.registry.set(cheater.citizenId, cheater.publicKey);
  a.node.ingest(honest);
  b.node.ingest(forged);
  await waitFor(
    () => a.node.forkProofs.has(cheater.citizenId) && b.node.forkProofs.has(cheater.citizenId),
    '양쪽 모두 분기 증명 확보'
  );
  assert.ok(a.node.forkProofs.has(cheater.citizenId));
});

await test('피어가 죽어도 남은 피어들은 계속 동작한다', async () => {
  const w1 = new Wallet('가');
  const w2 = new Wallet('나');
  const a = await makePeer({ id: 'A5', wallet: w1 });
  const b = await makePeer({ id: 'B5', seeds: [a.addr] });
  const c = await makePeer({ id: 'C5', wallet: w2, seeds: [b.addr] });
  const p = a.act(T, 'PROPOSE', { title: '의견' });
  await waitFor(() => c.node.byHash.has(p.hash), 'C가 수신 (발견 완료)');
  b.stop(); // 중간 피어 사망
  await sleep(150);
  const p2 = a.act(T, 'PROPOSE', { title: '두 번째 의견' });
  await waitFor(() => c.node.byHash.has(p2.hash), 'B 없이도 A→C 직접 전파');
  assert.ok(c.node.byHash.has(p2.hash));
});

for (const p of peers) p.stop();
console.log(`\n${passed}개 테스트 모두 통과`);
