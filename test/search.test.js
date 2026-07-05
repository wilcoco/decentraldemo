// 키워드 검색 테스트 — 로컬 카탈로그 검색 + 질의 전파(query flooding)
import assert from 'node:assert/strict';
import { Wallet } from '../src/weave/entry.js';
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

console.log('키워드 검색 테스트\n');

await test('이슈(목차) 검색은 로컬에서 즉시 완결된다 — 카탈로그는 전원 복제', async () => {
  const a = await makePeer({ id: 'A', wallet: new Wallet('가') });
  const b = await makePeer({ id: 'B', wallet: new Wallet('나'), seeds: [a.addr] });
  a.announceTopic({ title: '연금 개혁', description: '보험료율과 소득대체율', domain: '복지' });
  a.announceTopic({ title: '에너지 전환', domain: '환경' });
  await waitFor(() => b.catalog().length === 2, '카탈로그 수신');
  const hits = b.searchLocal('연금');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, '이슈');
  assert.equal(hits[0].title, '연금 개혁');
  const byDesc = b.searchLocal('소득대체율'); // 설명으로도 검색
  assert.equal(byDesc.length, 1);
});

await test('본문(의견) 검색: 내가 복제하지 않는 주제 속 의견을 이웃이 찾아 준다', async () => {
  const a = await makePeer({ id: 'A2', wallet: new Wallet('가') });
  const { topicId } = a.announceTopic({ title: '에너지 정책' });
  a.act(topicId, 'PROPOSE', { title: '재생에너지 60% 확대', body: '계통 안정성을 위한 원전 계속운전 포함' });
  const b = await makePeer({ id: 'B2', wallet: new Wallet('나'), seeds: [a.addr] });
  await waitFor(() => b.catalog().length === 1, '카탈로그 수신');
  assert.equal(b.node.entriesForTopic(topicId).length, 0); // B는 본문 미복제
  const hits = await b.search('원전', { timeoutMs: 800 });
  const opinionHit = hits.find((h) => h.kind === '의견');
  assert.ok(opinionHit, '의견 결과가 있어야 함');
  assert.equal(opinionHit.title, '재생에너지 60% 확대');
  assert.equal(opinionHit.topicTitle, '에너지 정책');
  assert.equal(opinionHit.foundBy, 'A2'); // 본문을 가진 피어가 찾아 줌
});

await test('여러 홉 전파: 직접 연결되지 않은 피어의 내용도 역경로로 돌아온다', async () => {
  // 자동 발견을 꺼서 A—B—C 사슬 위상을 유지한다
  const a = await makePeer({ id: 'A3', wallet: new Wallet('가'), discovery: false });
  const b = await makePeer({ id: 'B3', wallet: new Wallet('나'), seeds: [a.addr], discovery: false });
  const c = await makePeer({ id: 'C3', wallet: new Wallet('다'), seeds: [b.addr], discovery: false });
  const { topicId } = a.announceTopic({ title: '조용한 이슈' });
  a.act(topicId, 'PROPOSE', { title: '특수식별자패턴 의견', body: '' });
  await waitFor(() => c.sockets.size >= 1 && b.sockets.size >= 2, '사슬 연결');
  assert.ok(![...c.sockets.values()].some((m) => m.hello?.id === 'A3')); // C는 A와 직접 연결 없음
  const hits = await c.search('특수식별자패턴', { ttl: 3, timeoutMs: 1000 });
  const hit = hits.find((h) => h.kind === '의견');
  assert.ok(hit, '2홉 밖의 의견이 검색되어야 함');
  assert.equal(hit.foundBy, 'A3');
});

await test('TTL이 모자라면 닿지 않는다 — 전파 범위가 제어된다', async () => {
  const a = await makePeer({ id: 'A4', wallet: new Wallet('가'), discovery: false });
  const b = await makePeer({ id: 'B4', wallet: new Wallet('나'), seeds: [a.addr], discovery: false });
  const c = await makePeer({ id: 'C4', wallet: new Wallet('다'), seeds: [b.addr], discovery: false });
  const { topicId } = a.announceTopic({ title: '먼 이슈' });
  a.act(topicId, 'PROPOSE', { title: '아주먼곳의의견', body: '' });
  await waitFor(() => c.sockets.size >= 1 && b.sockets.size >= 2, '사슬 연결');
  const hits = await c.search('아주먼곳의의견', { ttl: 1, timeoutMs: 800 }); // B까지만 도달
  assert.equal(hits.filter((h) => h.kind === '의견').length, 0);
});

await test('같은 결과가 여러 경로로 와도 한 번만 집계된다', async () => {
  const a = await makePeer({ id: 'A5', wallet: new Wallet('가') });
  const b = await makePeer({ id: 'B5', wallet: new Wallet('나'), seeds: [a.addr] });
  const c = await makePeer({ id: 'C5', wallet: new Wallet('다'), seeds: [a.addr] });
  const { topicId } = a.announceTopic({ title: '중복 테스트' });
  a.act(topicId, 'PROPOSE', { title: '유일무이한의견', body: '' });
  b.follow(topicId);
  await waitFor(() => b.node.entriesForTopic(topicId).length === 1, 'B 백필');
  await waitFor(() => [a, b, c].every((p) => p.sockets.size >= 2), '완전 연결');
  // 이제 A와 B 둘 다 본문을 갖고 있고, C는 둘 모두에 연결되어 있다
  const hits = await c.search('유일무이한의견', { timeoutMs: 800 });
  assert.equal(hits.filter((h) => h.kind === '의견').length, 1); // 중복 없이 1건
});

for (const p of peers) p.stop();
console.log(`\n${passed}개 테스트 모두 통과`);
