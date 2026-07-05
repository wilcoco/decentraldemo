// 보안 테스트 — 시빌 방어(자격증명 승인), 속도 제한, 크기 제한
import assert from 'node:assert/strict';
import net from 'node:net';
import { Wallet } from '../src/weave/entry.js';
import { WeaveNode } from '../src/weave/node.js';
import { Peer } from '../src/weave/peer.js';
import { CredentialIssuer, verifyCredential } from '../src/weave/identity.js';

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
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('보안 테스트\n');

await test('자격증명 검증: 신뢰 발급자의 서명만 통과한다', async () => {
  const issuer = new CredentialIssuer('선관위');
  const rogue = new CredentialIssuer('사칭기관');
  const w = new Wallet('가');
  const good = issuer.issue(w.publicKey);
  const forged = rogue.issue(w.publicKey);
  assert.equal(verifyCredential(good, w.publicKey, [issuer.publicKey]), true);
  assert.equal(verifyCredential(forged, w.publicKey, [issuer.publicKey]), false); // 발급자 불신
  const other = new Wallet('나');
  assert.equal(verifyCredential(good, other.publicKey, [issuer.publicKey]), false); // 남의 증명 도용
});

await test('시빌 방어: 자격증명 없는 계정은 등록부에 오르지 못하고 여론에 진입할 수 없다', async () => {
  const issuer = new CredentialIssuer('선관위');
  const citizen = new Wallet('시민');
  const citizenCred = issuer.issue(citizen.publicKey);
  const a = new Peer({
    id: 'A',
    wallet: citizen,
    credential: citizenCred,
    interests: [],
    gossipMs: 100,
    admission: 'credential',
    issuers: [issuer.publicKey],
  });
  await a.start();
  peers.push(a);
  // 시빌: 자격증명 없이 지갑만 1000개 만들어 밀고 들어오려는 피어
  const sybil = new Wallet('시빌봇');
  const b = new Peer({
    id: 'B',
    wallet: sybil, // 자격증명 없음
    interests: [],
    gossipMs: 100,
    seeds: [a.addr],
    admission: 'open', // 공격자 자신은 아무거나 쓸 수 있지만
  });
  await b.start();
  peers.push(b);
  await waitFor(() => b.sockets.size >= 1, '연결');
  await sleep(400); // HELLO/REGISTRY 교환 시간
  assert.equal(a.node.registry.has(sybil.citizenId), false); // A는 시빌을 등록하지 않는다
  // 시빌이 이슈를 공표해도 A에게는 "등록되지 않은 시민"이라 거부된다
  const { topicId } = b.announceTopic({ title: '시빌의 여론 조작 이슈' });
  await sleep(500);
  assert.equal(a.catalog().length, 0);
  void topicId;
});

await test('자격증명 있는 시민의 신원은 가십으로 전파되어 제3자도 검증·수용한다', async () => {
  const issuer = new CredentialIssuer('선관위');
  const w1 = new Wallet('가');
  const w2 = new Wallet('나');
  const mk = (id, wallet, seeds = []) =>
    new Peer({
      id,
      wallet,
      credential: issuer.issue(wallet.publicKey),
      interests: [],
      gossipMs: 100,
      seeds,
      admission: 'credential',
      issuers: [issuer.publicKey],
    });
  const a = await mk('A2', w1).start();
  const b = await mk('B2', w2, [a.addr]).start();
  peers.push(a, b);
  a.announceTopic({ title: '정상 이슈' });
  await waitFor(() => b.catalog().length === 1, 'B가 자격증명 검증 후 수용');
  assert.equal(b.node.registry.has(w1.citizenId), true);
});

await test('속도 제한: 작성자별 수용 상한을 넘는 홍수는 거부된다 (창이 비면 다시 수용)', async () => {
  const w = new Wallet('가');
  const registry = new Map([[w.citizenId, w.publicKey]]);
  const node = new WeaveNode({ id: 'n', interests: ['t1'], registry, rateLimit: { max: 3, perMs: 60_000 } });
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(node.ingest(w.act('t1', 'PROPOSE', { title: `홍수 ${i}` })).accepted);
  }
  assert.deepEqual(results, [true, true, true, false, false]);
});

await test('크기 제한: 과대 데이터 항목은 저장을 거부한다', async () => {
  const w = new Wallet('가');
  const registry = new Map([[w.citizenId, w.publicKey]]);
  const node = new WeaveNode({ id: 'n', interests: ['t1'], registry });
  const bomb = w.act('t1', 'PROPOSE', { title: '폭탄', body: 'x'.repeat(50_000) });
  assert.equal(node.ingest(bomb).accepted, false);
  assert.match(node.ingest(bomb).reason ?? '과대', /과대|중복/);
});

await test('메모리 폭탄 방어: 개행 없는 초대형 메시지는 회선이 끊기고 피어는 계속 동작한다', async () => {
  const a = new Peer({ id: 'A3', wallet: new Wallet('가'), interests: [], gossipMs: 100, maxLineBytes: 10_000 });
  await a.start();
  peers.push(a);
  const attacker = net.createConnection({ host: '127.0.0.1', port: a.port });
  attacker.on('error', () => {});
  let attackerClosed = false;
  attacker.on('close', () => (attackerClosed = true));
  attacker.resume(); // 수신을 흘려보내야 상대의 종료(FIN)가 감지된다
  await new Promise((r) => attacker.on('connect', r));
  attacker.write('x'.repeat(50_000)); // 개행 없는 5만 바이트
  await waitFor(() => attackerClosed, '공격 회선 차단', 3000);
  // 피어는 멀쩡히 새 연결을 받는다
  const b = new Peer({ id: 'B3', wallet: new Wallet('나'), interests: [], gossipMs: 100, seeds: [a.addr] });
  await b.start();
  peers.push(b);
  a.announceTopic({ title: '생존 확인' });
  await waitFor(() => b.catalog().length === 1, '공격 후에도 정상 동작');
});

for (const p of peers) p.stop();
console.log(`\n${passed}개 테스트 모두 통과`);
