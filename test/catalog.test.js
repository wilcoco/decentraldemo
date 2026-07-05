// 카탈로그 테스트 — P2P 환경에서의 전체 이슈 조회·구독·관심 표명
import assert from 'node:assert/strict';
import { Wallet } from '../src/weave/entry.js';
import { Peer, CATALOG } from '../src/weave/peer.js';
import { queueState, tips } from '../src/weave/queue.js';

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
  const p = new Peer({ gossipMs: 100, interests: [], ...opts });
  await p.start();
  peers.push(p);
  return p;
}
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('카탈로그(전체 이슈 조회) 테스트\n');

await test('공표된 이슈가 관심 주제가 다른 피어의 카탈로그에도 나타난다', async () => {
  const a = await makePeer({ id: 'A', wallet: new Wallet('가') });
  const b = await makePeer({ id: 'B', wallet: new Wallet('나'), seeds: [a.addr] });
  const { topicId } = a.announceTopic({ title: '연금 개혁', description: '보험료·소득대체율', domain: '복지' });
  await waitFor(() => b.catalog().length === 1, 'B의 카탈로그 수신');
  const [item] = b.catalog();
  assert.equal(item.title, '연금 개혁');
  assert.equal(item.topicId, topicId);
  assert.equal(item.following, false); // 목차는 알지만 본문은 아직 복제 안 함
  assert.equal(item.localEntries, 0);
});

await test('구독(follow)하면 반보정 가십이 본문 과거 전체를 채워 준다', async () => {
  const a = await makePeer({ id: 'A2', wallet: new Wallet('가') });
  const { topicId } = a.announceTopic({ title: '에너지 전환' });
  const p = a.act(topicId, 'PROPOSE', { title: '재생 60% + 원전 보완' });
  a.act(topicId, 'JOIN', { opinionId: p.hash, behind: [p.hash] });
  const b = await makePeer({ id: 'B2', wallet: new Wallet('나'), seeds: [a.addr] });
  await waitFor(() => b.catalog().length === 1, '카탈로그 수신');
  assert.equal(b.node.entriesForTopic(topicId).length, 0); // 구독 전엔 본문 없음
  b.follow(topicId);
  await waitFor(() => b.node.entriesForTopic(topicId).length === 2, '본문 백필');
  assert.equal(queueState(b.node, topicId).opinions[0].weight, 1);
});

await test('관심 표명은 카탈로그 줄서기다 — 이슈별 관심도가 실시간 집계된다', async () => {
  const a = await makePeer({ id: 'A3', wallet: new Wallet('가') });
  const b = await makePeer({ id: 'B3', wallet: new Wallet('나'), seeds: [a.addr] });
  const { announceId } = a.announceTopic({ title: '주거 안정' });
  await waitFor(() => b.catalog().length === 1, '카탈로그 수신');
  b.expressInterest(b.catalog()[0].announceId);
  await waitFor(() => a.catalog()[0]?.interest === 2, '관심 줄 수렴');
  assert.equal(a.catalog()[0].interest, 2); // 공표자 + 나
  assert.equal(b.catalog()[0].following, true);
  assert.ok(announceId);
});

await test('여러 이슈가 관심도 순으로 정렬되어 전체 조회된다', async () => {
  const a = await makePeer({ id: 'A4', wallet: new Wallet('가') });
  const b = await makePeer({ id: 'B4', wallet: new Wallet('나'), seeds: [a.addr] });
  const c = await makePeer({ id: 'C4', wallet: new Wallet('다'), seeds: [a.addr] });
  a.announceTopic({ title: '이슈1' });
  await waitFor(() => b.catalog().length === 1, 'B 수신');
  const { announceId: hot } = b.announceTopic({ title: '이슈2-인기' });
  await waitFor(() => c.catalog().length === 2, 'C 수신');
  c.expressInterest(hot);
  await waitFor(() => a.catalog().length === 2 && a.catalog()[0].interest === 2, 'A 수렴');
  assert.equal(a.catalog()[0].title, '이슈2-인기'); // 관심 줄이 긴 이슈가 위로
  assert.equal(a.catalog()[0].interest, 2);
  assert.equal(a.catalog()[1].interest, 1);
});

await test('카탈로그 자체도 위브 주제이므로 무결성 장치가 그대로 적용된다', async () => {
  const a = await makePeer({ id: 'A5', wallet: new Wallet('가') });
  const b = await makePeer({ id: 'B5', wallet: new Wallet('나'), seeds: [a.addr] });
  const { announceId } = a.announceTopic({ title: '검증 이슈' });
  await waitFor(() => b.catalog().length === 1, '수신');
  b.expressInterest(b.catalog()[0].announceId);
  await waitFor(() => a.catalog()[0].interest === 2, '수렴');
  // 공표 줄에도 무결성: 관심 표명 항목의 behind가 공표 항목을 가리킨다
  const join = [...a.node.byHash.values()].find((e) => e.type === 'JOIN' && e.data.opinionId === announceId);
  assert.ok(join.data.behind.includes(announceId));
  assert.ok(tips(a.node, announceId).length >= 1);
});

for (const p of peers) p.stop();
console.log(`\n${passed}개 테스트 모두 통과`);
