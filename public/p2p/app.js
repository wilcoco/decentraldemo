// 아고라 라이브 — 브라우저 P2P 시민 클라이언트 UI
//
// 핵심: 집계 코드는 서버 피어와 동일한 모듈을 그대로 import 한다.
// 브라우저는 화면이 아니라 완전한 피어다 — 서명·저장·가십·집계 전부 로컬.
//
// 화면 구조는 시민의 동선을 따른다 (발견 → 참여 → 검증):
//   광장 뷰(#plaza-view)  : 이슈 피드 — 무엇이 논의되고 있나
//   상세 뷰(#topic-view)  : 의견들이 나란히 경쟁하고, 그 뒤로 줄을 선다
//   장부 패널(#ledger)    : 이 이슈의 서명된 행위 전부 — 원하는 사람만 연다
// 라우팅은 해시(#/t/<topicId>) 하나가 진실이다 — 뒤로가기는 브라우저가 처리.
import { sha256 } from '/src/weave/hash.js';
import { queueState, tips } from '/src/weave/queue.js';
import { computeInsight, authorityIndex } from '/src/weave/insight.js';
import { BrowserWallet, BrowserNode, BrowserMesh, verifyEntry } from '/p2p/weave-web.js';

const CATALOG = 't_@catalog';
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 거버넌스 파라미터 (URL: ?blind=초&sustain=초&jury=명 — 데모 기본값 0)
const params = new URLSearchParams(location.search);
const GOV = {
  blindMs: Number(params.get('blind') ?? 0) * 1000,
  sustainMs: Number(params.get('sustain') ?? 0) * 1000,
  jurySize: Number(params.get('jury') ?? 0),
  charter: { adopt: 2 / 3, sustainFactor: 3 },
};

// 용어 도움말 — ⓘ 클릭으로 어디서든 펼쳐진다
const HELP = {
  상태: '의견의 현재 지위입니다. 저장되지 않고 매 순간 다시 계산됩니다 — 지지가 빠지면 그 순간 바뀝니다. 제안됨 → 경합(반대 존재) → 우세(시민 25%+) → 채택(50%+ 그리고 지지>반대). 반대가 더 많으면 "반대 우세".',
  권위: '지지자 수에 안목을 가중한 무게입니다. 같은 인원이라도 "좋은 의견을 일찍 알아봐 온" 시민들이 선 줄이 더 무겁습니다. 기본 1표는 누구에게나 보장되고, 안목 보너스에는 상한이 있습니다.',
  다양성: '이 줄에 선 사람들이 평소 얼마나 서로 다른 행보를 보였는지입니다. 높을수록 다양한 사람들의 연합, 낮을수록 늘 같이 움직이는 무리라는 뜻입니다.',
  안목: '좋은 의견을 남보다 일찍 알아본 기록입니다. 내가 선 뒤에 따라 선 사람 수만큼 쌓이고, 아무도 안 따라오는 곳에 서면 평균이 내려가며, 명백히 진 편을 고집하는 동안은 깎입니다(떠나면 회복).',
  위임: '이 이슈에 대한 내 목소리를 신뢰하는 시민에게 맡깁니다. 그 사람이 서는 곳에 내 표가 함께 실립니다. 내가 직접 참여하는 순간 위임보다 우선하고, 언제든 "직접 참여"로 되돌릴 수 있습니다.',
  헌장: '기본권이나 규칙을 다루는 상위 의제입니다. 과반이 아니라 3분의 2 지지와 3배의 유지 기간이 있어야 채택됩니다 — 다수의 폭정을 막는 장치입니다.',
  블라인드: '공표 직후에는 집계 숫자를 숨깁니다. 남들이 몇 명인지 보고 따라가는 쏠림을 막고, 논거를 읽고 스스로 판단하게 하기 위한 장치입니다.',
  배심: '이 의견의 심사를 위해 무작위로 추첨된 시민들입니다. 의견의 지문(해시)으로 뽑혀서 누구도 배심을 조작할 수 없습니다. 배심 다수의 승인 없이는 채택되지 않습니다.',
  줄서기: '지지와 반대는 "줄서기"입니다. 줄에 서는 순간 내 서명이 앞사람들의 기록을 고정하는 증인이 됩니다. 언제든 떠날 수 있고, 떠나면 그 순간 집계에서 빠집니다(기록은 역사로 남음).',
  전파: '이 이슈가 링크를 타고 사람에서 사람으로 옮겨진 기록입니다. 링크를 만들 때마다 공유자의 서명(SHARE)이 남고, 그 서명은 자기가 받은 링크의 서명을 가리킵니다 — 참여의 줄서기처럼 전파에도 증인의 체인이 쌓입니다. 집계에는 영향을 주지 않습니다.',
  장부: '이 이슈에서 일어난 모든 서명된 행위의 목록입니다. 서명이 깨진 항목은 애초에 저장되지 않으며, [지금 다시 검증]을 누르면 이 기기가 전체 서명을 그 자리에서 재검증합니다 — 믿으라는 말 대신 직접 확인하는 화면입니다.',
};

let wallet = null;
let node = null;
let mesh = null;
let dupTab = false;
let view = 'plaza'; // 'plaza' | 'topic'
let currentTopic = null;
let openForm = null; // { opinionId, side } — 열려 있는 동안 의견 칸반 갱신 일시정지
let openHelp = null; // 현재 펼쳐진 도움말 키
let announceOpen = false; // 공표 폼 (피드가 비면 자동 표시)
let ledgerOpen = false;
const expandedLines = new Set(); // "외 N명" 펼친 줄
const colOrders = new Map(); // topicId -> [opinionId] — 읽는 중 열이 튀지 않게 순서를 고정

const setCurrentTopic = (t) => {
  currentTopic = t;
  if (t) localStorage.setItem('agora-current-topic', t);
};

// ── 라우팅: 해시가 단일 진실 (#/t/<topicId>) ────────────────
function applyRoute() {
  const m = location.hash.match(/^#\/t\/(.+)$/);
  if (m && node.interests.has(m[1])) {
    view = 'topic';
    setCurrentTopic(m[1]);
  } else {
    view = 'plaza';
  }
}
function navTopic(topicId) {
  const target = `#/t/${topicId}`;
  if (location.hash === target) {
    applyRoute();
    render();
  } else location.hash = target; // hashchange가 applyRoute + render
}

// 같은 브라우저(같은 localStorage)의 다른 탭 감지 — 잠금 미지원 브라우저용 보조 경고
try {
  const bc = new BroadcastChannel('agora-tab');
  bc.onmessage = (e) => {
    if (e.data === 'hello?') bc.postMessage('here');
    if (e.data === 'here') {
      dupTab = true;
      if (node) render();
    }
  };
  bc.postMessage('hello?');
} catch { /* BroadcastChannel 미지원 */ }

// 같은 브라우저 프로필에서의 동시 실행 원천 차단 — 두 실행이 같은 지갑을
// 공유하면 같은 순번에 다른 서명이 만들어져 스스로 이중 발언자가 된다.
async function acquireSingleInstanceLock() {
  if (!navigator.locks) return true;
  return await new Promise((resolve) => {
    navigator.locks.request('agora-app', { ifAvailable: true }, (lock) => {
      resolve(Boolean(lock));
      if (lock) return new Promise(() => {}); // 페이지가 살아 있는 동안 잠금 유지
    });
  });
}

// ── 참여 (이름 → 지갑 생성/복원 → 메시 접속) ─────────────────
async function boot(name) {
  if (!(await acquireSingleInstanceLock())) {
    $('#join-overlay').classList.remove('hidden');
    $('#join-overlay .join-card').innerHTML =
      '<h1>이미 실행 중</h1><p>이 브라우저의 다른 탭/창에서 아고라 라이브가 이미 열려 있습니다.<br/>' +
      '두 개를 동시에 쓰면 같은 지갑이 충돌해 이중 서명이 됩니다.<br/>기존 탭을 쓰시거나, 다른 기기·시크릿 창을 이용하세요.</p>';
    return;
  }
  wallet = await BrowserWallet.create(name);
  node = new BrowserNode({ id: wallet.name, interests: [CATALOG] });
  node.restore(); // 이 기기에 저장된 역사·등록부·관심사 복원
  node.registry.set(wallet.citizenId, wallet.publicKey);
  mesh = new BrowserMesh({ node, wallet, onChange: render });
  mesh.connect(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`);
  await importFromHash(); // 링크에 실려 온 이슈 수용 (네트워크 없이도 동작) — 성공 시 #/t/ 라우트를 심는다
  window.addEventListener('hashchange', () => {
    if (!node) return;
    openForm = null;
    openHelp = null;
    ledgerOpen = false;
    applyRoute();
    render();
  });
  applyRoute();
  $('#join-overlay').classList.add('hidden');
  if (!localStorage.getItem('agora-guide-done')) $('#guide').classList.remove('hidden');
  render();
  setInterval(render, 1000); // 블라인드/지속 타이머의 실시간 반영
}

const savedWallet = localStorage.getItem('agora-wallet');
const urlName = params.get('name');
if (savedWallet || urlName) {
  boot(urlName ?? JSON.parse(savedWallet).savedName);
} else {
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#join-name').value.trim();
    if (name) boot(name);
  });
}

// ── 헬퍼 ─────────────────────────────────────────────────────
function catalogItems() {
  return queueState(node, CATALOG)
    .opinions.map((o) => {
      const announce = node.byHash.get(o.id);
      const topicId = announce?.data.topicId;
      return {
        topicId,
        title: o.title,
        description: o.body,
        charter: Boolean(announce?.data.charter),
        region: announce?.data.region ?? null,
        announceId: o.id,
        interest: o.weight,
        following: topicId ? node.interests.has(topicId) : false,
        entries: topicId ? node.entriesForTopic(topicId).length : 0,
      };
    })
    .filter((c) => c.topicId);
}

function topicOpts(topicId) {
  const item = catalogItems().find((c) => c.topicId === topicId);
  const base = { blindMs: GOV.blindMs, sustainMs: GOV.sustainMs, jurySize: GOV.jurySize };
  if (item?.charter) return { ...base, adopt: GOV.charter.adopt, sustainMs: GOV.sustainMs * GOV.charter.sustainFactor };
  return base;
}

const nameOf = (id) => mesh.names.get(id) ?? id.slice(0, 10);
const info = (key) => `<button class="info" data-help="${key}" title="눌러서 설명 보기">ⓘ</button>`;
const helpBox = (keys) =>
  openHelp && keys.includes(openHelp)
    ? `<div class="help-pop"><b>${openHelp}</b> — ${esc(HELP[openHelp])} <button class="btn small ghost" data-help-close>닫기</button></div>`
    : '';

// 표시용 줄 순번 — 결정적 계산 (서명된 ts, 동률이면 author·seq).
// queueState의 standers는 사전순이라 "몇 번째"의 근거가 될 수 없다:
// 실제 줄 순서는 각 시민이 그 의견에 마지막으로 선 항목의 시각으로 정한다.
function computeStanding(topicId) {
  const flagged = new Set(node.forkProofs.keys());
  const entries = node
    .entriesForTopic(topicId)
    .filter((e) => ['PROPOSE', 'AMEND', 'JOIN', 'OPPOSE', 'LEAVE'].includes(e.type) && !flagged.has(e.author))
    .sort((x, y) => x.ts - y.ts || (x.author < y.author ? -1 : 1) || x.seq - y.seq);
  const opinionsById = new Map();
  for (const e of entries) if (e.type === 'PROPOSE') opinionsById.set(e.hash, e.hash);
  let added = true;
  while (added) {
    added = false;
    for (const e of entries) {
      if (e.type !== 'AMEND' || opinionsById.has(e.hash)) continue;
      const root = opinionsById.get(e.data.parentId);
      if (!root) continue;
      opinionsById.set(e.hash, root);
      added = true;
    }
  }
  const perFamily = new Map(); // family -> Map(author -> {opinionId, side, seq, ts})
  for (const e of entries) {
    let family = null;
    let pos = null;
    if (e.type === 'PROPOSE') {
      family = opinionsById.get(e.hash);
      pos = { opinionId: e.hash, side: 'support', seq: e.seq, ts: e.ts };
    } else if (e.type === 'AMEND' && opinionsById.has(e.hash)) {
      family = opinionsById.get(e.hash);
      pos = { opinionId: e.hash, side: 'support', seq: e.seq, ts: e.ts };
    } else if ((e.type === 'JOIN' || e.type === 'OPPOSE') && opinionsById.has(e.data.opinionId)) {
      family = opinionsById.get(e.data.opinionId);
      pos = { opinionId: e.data.opinionId, side: e.type === 'OPPOSE' ? 'oppose' : 'support', seq: e.seq, ts: e.ts };
    } else if (e.type === 'LEAVE') {
      family = e.data.familyRoot;
      pos = { opinionId: null, side: null, seq: e.seq, ts: e.ts };
    }
    if (!family) continue;
    let m = perFamily.get(family);
    if (!m) perFamily.set(family, (m = new Map()));
    const cur = m.get(e.author);
    if (!cur || pos.seq > cur.seq) m.set(e.author, pos);
  }
  return {
    line(opinionId, side) {
      const family = opinionsById.get(opinionId) ?? opinionId;
      const m = perFamily.get(family);
      if (!m) return [];
      return [...m.entries()]
        .filter(([, p]) => p.opinionId === opinionId && p.side === side)
        .map(([cid, p]) => ({ cid, ts: p.ts }))
        .sort((a, b) => a.ts - b.ts || (a.cid < b.cid ? -1 : 1));
    },
  };
}

// ── URL 공유: 데이터를 실은 링크 (제3의 전송로) ──────────────
// 모든 항목이 서명된 자기검증 데이터이므로 URL에 실어도 위조가 불가능하고
// (수신 측 ingest가 서명을 검증), 해시(#) 부분은 서버로 전송되지 않으므로
// 신호 서버조차 내용을 보지 못한다. 카톡·문자·QR가 곧 전송로가 된다 —
// 네트워크 연결이 전혀 없어도 이슈가 사람에서 사람으로 옮겨진다.
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function packShare(str) {
  const bytes = new TextEncoder().encode(str);
  if (typeof CompressionStream === 'undefined') return 'p' + b64url(bytes);
  const cs = new CompressionStream('deflate-raw');
  const out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
  return 'z' + b64url(out);
}

async function unpackShare(s) {
  const bytes = unb64url(s.slice(1));
  if (s[0] === 'p') return new TextDecoder().decode(bytes);
  const ds = new DecompressionStream('deflate-raw');
  const out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
  return new TextDecoder().decode(out);
}

// 전파의 증인 체인: 내가 이 이슈를 "어느 링크(SHARE 항목)로 받았는가"를 기억한다.
// 재공유할 때 내 SHARE가 그 항목을 가리키므로(via), 전파 경로가 서명 체인이 된다.
const shareViaMap = () => {
  try { return JSON.parse(localStorage.getItem('agora-share-via') ?? '{}'); } catch { return {}; }
};
const setShareVia = (topicId, hash) => {
  const m = shareViaMap();
  m[topicId] = hash;
  localStorage.setItem('agora-share-via', JSON.stringify(m));
};
// 나에게 도달한 전파 계보 (기원 → … → 나에게 준 사람)
function shareLineage(topicId) {
  const chain = [];
  const guard = new Set();
  for (let h = shareViaMap()[topicId] ?? null; h && !guard.has(h); ) {
    guard.add(h);
    const e = node.byHash.get(h);
    if (!e) break;
    chain.push(e.author);
    h = e.data?.via ?? null;
  }
  return chain.reverse();
}

// 현재 이슈를 링크로 포장: 공표 + 전파 계보 + 본문 항목(시간순, 크기 한도 내) + 작성자 공개키.
// 공유하는 행위 자체가 서명된 SHARE 항목으로 남는다 — 참여(줄서기)의 증인처럼
// 전파에도 증인이 생기고, 이 기록은 가십으로도 퍼진다 (집계에는 불포함).
async function makeShareLink() {
  const item = catalogItems().find((c) => c.topicId === currentTopic);
  if (!item) return null;
  const share = await mesh.act(currentTopic, 'SHARE', { via: shareViaMap()[currentTopic] ?? null });
  const seen = new Set();
  const entries = [];
  const authorIds = new Set();
  let size = 600;
  const push = (e) => {
    if (!e || seen.has(e.hash)) return false;
    seen.add(e.hash);
    entries.push(e);
    authorIds.add(e.author);
    size += JSON.stringify(e).length;
    return true;
  };
  push(node.byHash.get(item.announceId));
  // 전파 계보(SHARE 체인)는 잘리지 않도록 먼저 담는다 — 받는 사람이 경로를 검증할 수 있게
  for (let h = share.hash; h; h = node.byHash.get(h)?.data?.via ?? null) {
    if (!push(node.byHash.get(h))) break;
  }
  const all = node.entriesForTopic(currentTopic).sort((a, b) => a.ts - b.ts);
  for (const e of all) {
    if (seen.has(e.hash)) continue;
    if (size + JSON.stringify(e).length > 8000) break; // 메신저·QR에서 다루기 좋은 크기로 제한 — 나머지는 접속 시 가십이 채운다
    push(e);
  }
  const identities = [...authorIds]
    .map((cid) => ({ citizenId: cid, publicKey: node.registry.get(cid), name: mesh.names.get(cid) ?? null }))
    .filter((i) => i.publicKey);
  const payload = JSON.stringify({ v: 1, topicId: currentTopic, shareHash: share.hash, identities, entries });
  const url = `${location.origin}/app#share=${await packShare(payload)}`;
  return { url, included: entries.length, total: all.length + 1 };
}

// 공유 링크 수신: 신원 등록 → 구독 → 항목 검증·수용 (서명이 깨진 항목은 자동 거부)
let shareNotice = null;
async function importFromHash() {
  const m = location.hash.match(/#share=(.+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search); // 해시는 흔적 없이 제거
  try {
    const payload = JSON.parse(await unpackShare(m[1]));
    for (const identity of payload.identities ?? []) mesh._register(identity);
    mesh.follow(payload.topicId); // 항목 수용 전에 관심사에 넣어야 ingest가 받는다
    let accepted = 0;
    for (const e of payload.entries ?? []) {
      const r = await node.ingest(e);
      if (r.accepted) accepted += 1;
    }
    setCurrentTopic(payload.topicId);
    // 전파의 증인: 보낸 사람의 SHARE 항목이 서명 검증을 통과했을 때만 계보에 잇는다
    const sender = payload.shareHash ? node.byHash.get(payload.shareHash) : null;
    if (sender?.type === 'SHARE') setShareVia(payload.topicId, sender.hash);
    shareNotice = `🔗 ${sender ? nameOf(sender.author) + '님이 보낸 ' : ''}링크로 이슈를 받았습니다 — 항목 ${accepted}건 서명 검증 후 수용. 네트워크에 연결되면 나머지도 자동 동기화됩니다.`;
    // 받은 이슈로 바로 입장하도록 라우트를 심는다 (replaceState라 hashchange는 안 튄다)
    history.replaceState(null, '', location.pathname + location.search + `#/t/${payload.topicId}`);
  } catch {
    shareNotice = '공유 링크를 해석할 수 없습니다 (손상되었거나 너무 오래된 형식).';
  }
}
window.__makeShareLink = () => makeShareLink(); // E2E 검증용 훅

// ── 행위 ─────────────────────────────────────────────────────
async function announce(title, description, charter) {
  const topicId = 't_' + sha256(`${title}|${wallet.citizenId}|${wallet.seq}`).slice(0, 12);
  mesh.follow(topicId);
  await mesh.act(CATALOG, 'PROPOSE', { title, body: description, topicId, charter });
  navTopic(topicId);
}

async function expressInterest(announceId) {
  const a = node.byHash.get(announceId);
  mesh.follow(a.data.topicId);
  await mesh.act(CATALOG, 'JOIN', { opinionId: announceId, behind: tips(node, announceId) });
  navTopic(a.data.topicId);
}

async function submitStance(opinionId, side, text) {
  if (side === 'support') {
    const data = { opinionId, behind: tips(node, opinionId, 'support') };
    if (text) data.comment = text;
    await mesh.act(currentTopic, 'JOIN', data);
  } else if (side === 'oppose') {
    const data = { opinionId, behind: tips(node, opinionId, 'oppose') };
    if (text) data.comment = text;
    await mesh.act(currentTopic, 'OPPOSE', data);
  } else if (side === 'amend') {
    if (!text) return;
    await mesh.act(currentTopic, 'AMEND', { parentId: opinionId, behind: opinionId, title: text, body: '' });
  }
}

// ── 렌더링 파이프라인 ────────────────────────────────────────
// 영역 렌더러로 분해: 정적 폼(#announce-form, #propose-form)은 절대 다시
// 만들지 않는다 — 목록 컨테이너만 innerHTML 교체 (제출 핸들러 보존).
function render() {
  if (!node) return;
  renderStrip();
  renderInsight();
  renderPlaza();
  renderNet();
  $('#plaza-view').classList.toggle('hidden', view !== 'plaza');
  $('#topic-view').classList.toggle('hidden', view !== 'topic');
  if (view === 'topic') {
    renderTopicHeader();
    renderOpinions(); // openForm 동안은 내부에서 정지 (입력 보호)
    renderMyBar();
    renderLedger();
  }
}

// ── 신뢰 스트립: 지금 변하는 사실만, 근거 있게 ───────────────
function renderStrip() {
  const pill = $('#net-status');
  const directCount = [...mesh.channels.values()].filter((c) => c.dc.readyState === 'open').length;
  const relayOnly = [...mesh.roomPeers].filter((pid) => !mesh.channels.get(pid) || mesh.channels.get(pid).dc.readyState !== 'open');
  const total = directCount + relayOnly.length;
  if (mesh.wsState !== '연결됨') {
    pill.textContent = `신호 서버 ${mesh.wsState ?? '연결 중'}…`;
    pill.className = 'pill';
  } else if (total > 0) {
    pill.textContent = `피어 ${total}명 연결됨 · 시민 ${node.registry.size}명`;
    pill.className = 'pill ok';
  } else {
    pill.textContent = '신호 연결됨 · 다른 참여자 대기 중';
    pill.className = 'pill';
  }
  // 정직한 3단계: 서버가 실제로 보는 것만 말한다 (과장은 신뢰를 깎는다)
  let sees;
  if (mesh.wsState !== '연결됨') sees = '서버 연결 없음';
  else if (relayOnly.length > 0) sees = `서버가 보는 것: <b>중계 ${relayOnly.length}경로의 내용</b> (위조는 불가)`;
  else sees = '서버가 보는 것: <b>접속 사실만</b>';
  const flags =
    (node.forkProofs.has(wallet.citizenId) || dupTab) ? ' · <span class="warn-flag">⚠ 광장의 네트워크 카드 확인</span>' : '';
  $('#trust-extra').innerHTML = `${sees} · 내 기록: <b>이 기기에 ${node.byHash.size}건</b>${flags}`;
}

// ── 광장 뷰: 이슈 피드 ───────────────────────────────────────
// 이론 장치 보호: 피드는 승자를 예고하지 않는다 — 순위·1위 의견·수치 대신
// 논거 한 쌍을 보여준다 (읽고 들어가게). 블라인드 구간 이슈는 참여 규모도 숨긴다.
function feedCard(c) {
  let badges = '';
  let metaExtra = '';
  let argPair = '';
  if (c.following) {
    const qs = queueState(node, c.topicId, topicOpts(c.topicId));
    const ops = qs.opinions;
    const blindActive = ops.some((o) => o.blind);
    const adopted = ops.filter((o) => o.status === '채택').length;
    const mine = ops.some((o) => o.standers.includes(wallet.citizenId))
      ? '지지'
      : ops.some((o) => o.opposers.includes(wallet.citizenId))
        ? '반대'
        : null;
    if (blindActive) badges += '<span class="badge blind-b">🕶 스스로 판단할 시간</span>';
    else if (adopted) badges += `<span class="badge adopted">채택 ${adopted}</span>`;
    if (mine) badges += `<span class="badge mine-b">✓ 내가 선 줄 있음</span>`;
    metaExtra = blindActive ? ` · 논거 ${ops.reduce((n, o) => n + o.supportComments.length + o.opposeComments.length, 0)}개` : ` · 의견 ${ops.length}개`;
    if (!blindActive) {
      const supC = ops.flatMap((o) => o.supportComments).sort((a, b) => b.ts - a.ts)[0];
      const oppC = ops.flatMap((o) => o.opposeComments).sort((a, b) => b.ts - a.ts)[0];
      if (supC || oppC) {
        argPair = `<div class="arg-pair">
          ${supC ? `<div><span class="sup-c">＋</span> "${esc(supC.text)}" — ${esc(nameOf(supC.authorId))}</div>` : ''}
          ${oppC ? `<div><span class="opp-c">－</span> "${esc(oppC.text)}" — ${esc(nameOf(oppC.authorId))}</div>` : ''}
        </div>`;
      }
    }
  }
  return `
  <div class="card feed-card">
    <h3 data-open="${c.topicId}">${esc(c.title)}
      ${c.charter ? '<span class="badge charter">헌장</span>' : ''}
      ${c.region ? `<span class="badge region">${esc(c.region)}</span>` : ''}
      ${badges}
    </h3>
    ${c.description ? `<p class="hint">${esc(c.description)}</p>` : ''}
    <div class="feed-meta">🔥 관심 ${c.interest}명${metaExtra}${c.following ? ` · 구독중 (${c.entries}건 보관)` : ''}</div>
    ${argPair}
    ${c.following
      ? `<button class="btn small ghost" data-open2="${c.topicId}">이어서 참여 →</button>`
      : `<button class="btn small primary" data-follow="${c.announceId}">줄 서러 가기 →</button>`}
  </div>`;
}

function renderPlaza() {
  const filter = ($('#catalog-filter').value ?? '').toLowerCase();
  const all = catalogItems();
  const items = all.filter((c) => !filter || `${c.title} ${c.description}`.toLowerCase().includes(filter));
  const empty = all.length === 0;
  // 빈 광장 콜드스타트: 빈 피드는 "고장"으로 읽힌다 — 첫 행동을 크게 안내
  $('#catalog-list').innerHTML = empty
    ? `<div class="card empty-plaza"><h3>아직 광장에 이슈가 없습니다</h3>
        <p class="hint">P2P 광장은 참여자가 만드는 공간입니다.<br/>
        아래에서 <b>첫 이슈를 공표</b>하거나, 받은 <b>공유 링크</b>를 열면 이슈가 이 기기로 들어옵니다.<br/>
        ${mesh.wsState === '연결됨' ? '연결은 정상 — 다른 참여자를 기다리는 중입니다. 친구에게 이 주소를 보내보세요.' : '신호 서버에 연결하는 중입니다…'}</p></div>`
    : items.map(feedCard).join('') || '<p class="hint">검색어에 맞는 이슈가 없습니다.</p>';
  // 공표 폼: 피드가 비면 자동 표시, 아니면 FAB 뒤로
  $('#announce-card').classList.toggle('hidden', !(empty || announceOpen));
  $('#fab-announce').classList.toggle('hidden', empty);
}

// ── 이슈 상세: 헤더 ──────────────────────────────────────────
function renderTopicHeader() {
  const header = $('#topic-header');
  if (!currentTopic || !node.interests.has(currentTopic)) {
    header.innerHTML = '<p class="hint">이슈를 찾을 수 없습니다 — 광장으로 돌아가세요.</p>';
    $('#opinions').innerHTML = '';
    return;
  }
  const item = catalogItems().find((c) => c.topicId === currentTopic);
  const shareCount = node
    .entriesForTopic(currentTopic)
    .filter((e) => e.type === 'SHARE' && !node.forkProofs.has(e.author)).length;
  const lineage = shareLineage(currentTopic);
  const spreadLine =
    shareCount || lineage.length
      ? `<p class="hint">📣 링크 전파 ${shareCount}회 ${info('전파')}${
          lineage.length ? ` · 나에게 온 경로: ${lineage.map((c) => esc(nameOf(c))).join(' → ')} → 나` : ''
        }</p>`
      : '';
  header.innerHTML = `<h2>${esc(item?.title ?? currentTopic)}
    ${item?.charter ? `<span class="badge charter">헌장 의제</span>${info('헌장')}` : ''}
    <button class="btn small" id="share-topic" title="이 이슈 전체(공표+의견+서명)를 링크 하나에 담아 공유합니다. 받는 사람은 접속만 해도 이슈가 자기 기기에 들어옵니다.">🔗 링크로 공유</button>
    <span id="share-msg" class="hint"></span></h2>
    ${shareNotice ? `<p class="hint" style="color:var(--ok)">${esc(shareNotice)}</p>` : ''}
    ${item?.description ? `<p class="hint">${esc(item.description)}</p>` : ''}
    ${spreadLine}
    <p class="hint live"><span class="dot"></span>임기도 마감도 없습니다 — 아래 모든 상태는 저장된 결과가 아니라 지금 이 순간 다시 계산된 것이며, 누군가 입장을 옮기면 그 즉시 바뀝니다.</p>
    ${helpBox(['헌장', '전파'])}`;
}

// ── 이슈 상세: 의견 칸반 ─────────────────────────────────────
// 정렬 원칙 (밴드왜건 억제): 무게순이 아니라 "경합이 살아있는 순".
// 블라인드 의견은 공표순으로 끝에. 열 순서는 읽는 동안 고정 —
// 순위가 바뀌면 배너로 알리고, 누를 때만 재배열한다.
function desiredOrder(opinions) {
  const families = new Map();
  for (const o of opinions) {
    if (!families.has(o.familyRoot)) families.set(o.familyRoot, []);
    families.get(o.familyRoot).push(o);
  }
  const famList = [...families.values()].map((members) => {
    members.sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || a.createdAt - b.createdAt);
    const blind = members.every((m) => m.blind);
    const contest = Math.max(...members.map((m) => Math.min(m.weight, m.against)));
    const heat = Math.max(...members.map((m) => m.weight + m.against));
    return { members, blind, contest, heat, created: Math.min(...members.map((m) => m.createdAt)) };
  });
  famList.sort((a, b) => {
    if (a.blind !== b.blind) return a.blind ? 1 : -1; // 블라인드 가족은 끝으로
    if (a.blind) return a.created - b.created; // 블라인드끼리는 공표순 (집계 누설 금지)
    return b.contest - a.contest || b.heat - a.heat || (a.members[0].id < b.members[0].id ? -1 : 1);
  });
  return famList.flatMap((f) => f.members.map((m) => m.id));
}

let lastQs = null; // renderMyBar와 공유 (한 렌더 사이클 내 재계산 방지)
function renderOpinions() {
  if (!currentTopic || !node.interests.has(currentTopic)) return;
  if (openForm) return; // 입력 보호: 폼이 열려 있는 동안 칸반은 정지 (장부·스트립은 계속 흐른다)
  const opts = topicOpts(currentTopic);
  const opinions = authorityIndex(node, currentTopic, { queueOpts: opts });
  lastQs = opinions;
  const standing = computeStanding(currentTopic);

  // 열 순서 고정 + 변동 배너
  const desired = desiredOrder(opinions);
  let order = colOrders.get(currentTopic);
  if (!order) {
    order = desired;
    colOrders.set(currentTopic, order);
  } else {
    const known = new Set(order);
    order = order.filter((id) => desired.includes(id)).concat(desired.filter((id) => !known.has(id)));
    colOrders.set(currentTopic, order);
  }
  $('#reorder-banner').classList.toggle('hidden', JSON.stringify(order) === JSON.stringify(desired));

  const byId = new Map(opinions.map((o) => [o.id, o]));
  const cols = order
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((o) => `<div class="kanban-col st-${o.status.replace(/\s/g, '')}">${opinionCard(o, standing)}</div>`);
  // 유령 열: 경쟁이 있어야 검증된다 — 의견이 하나뿐이어도 "다른 해법"의 자리를 상설로 보여준다
  cols.push(
    `<div class="kanban-col ghost-col"><div>💡 다른 해법이 있나요?<br/>경쟁이 있어야 검증됩니다.</div><button class="btn primary small" data-ghost-propose>＋ 새 의견 제안</button></div>`
  );
  $('#opinions').innerHTML = opinions.length
    ? cols.join('')
    : `<div class="card empty-guide" style="flex:1"><h3>아직 의견이 없습니다</h3><p class="hint">이 이슈에 대한 <b>첫 의견(해결책·주장)</b>을 아래에서 제안해 보세요.<br/>제안한 의견에는 다른 시민들이 논거를 붙여 지지하거나 반대하게 됩니다.</p></div>` +
      cols[cols.length - 1];
}

// 줄서기 시각화 — 의견 뒤에 실제로 선 사람들의 줄을 그린다.
// ← 는 증인의 방향: 뒤에 선 사람의 서명이 앞사람의 기록을 가리켜 고정한다.
// 긴 줄 접기: 머리·초입·나와 내 앞뒤·꼬리는 항상 보인다 (증인 관계 유지).
function collapseChips(list, myIdx, renderChip, key) {
  if (list.length <= 7 || expandedLines.has(key)) return list.map(renderChip);
  const show = new Set([0, 1, list.length - 2, list.length - 1]);
  if (myIdx >= 0) [myIdx - 1, myIdx, myIdx + 1].forEach((i) => i >= 0 && i < list.length && show.add(i));
  const out = [];
  let gap = 0;
  for (let i = 0; i < list.length; i++) {
    if (show.has(i)) {
      if (gap > 0) out.push(`<button class="chip ghost" data-line-expand="${esc(key)}">… 외 ${gap}명 …</button>`);
      gap = 0;
      out.push(renderChip(list[i], i));
    } else gap++;
  }
  if (gap > 0) out.push(`<button class="chip ghost" data-line-expand="${esc(key)}">… 외 ${gap}명 …</button>`);
  return out;
}

function lineViz(o, mine, standing) {
  if (o.blind) return ''; // 블라인드 구간엔 줄도 숨긴다 (쏠림 방지 — 콩도르세)
  const wit = '<span class="wit">←</span>';
  const chip = ({ cid }, i) =>
    (i ? wit : '') +
    `<span class="chip ${cid === wallet.citizenId ? 'me' : ''}">${esc(nameOf(cid))}${cid === wallet.citizenId ? ' (나)' : ''}</span>`;
  const oppChip = ({ cid }, i) =>
    (i ? wit : '') +
    `<span class="chip opp-side ${cid === wallet.citizenId ? 'me' : ''}">${esc(nameOf(cid))}${cid === wallet.citizenId ? ' (나)' : ''}</span>`;

  const supLine = standing.line(o.id, 'support').filter((x) => x.cid !== o.authorId);
  const myIdxS = supLine.findIndex((x) => x.cid === wallet.citizenId);
  const supChips = [`<span class="chip head">💡 제안 ${esc(nameOf(o.authorId))}</span>`].concat(
    collapseChips(supLine, myIdxS, (x, i) => wit + `<span class="chip ${x.cid === wallet.citizenId ? 'me' : ''}">${esc(nameOf(x.cid))}${x.cid === wallet.citizenId ? ' (나)' : ''}</span>`, o.id + ':s')
  );
  if (o.delegatedSupport > 0) supChips.push(wit + `<span class="chip dele">🗳 위임된 표 ×${o.delegatedSupport}</span>`);
  if (mine !== 'support') supChips.push(wit + `<button class="chip ghost" data-sup="${o.id}">＋ 나도 여기 서기</button>`);

  const oppLine = standing.line(o.id, 'oppose');
  const myIdxO = oppLine.findIndex((x) => x.cid === wallet.citizenId);
  const oppChips = collapseChips(oppLine, myIdxO, oppChip, o.id + ':o');
  if (o.delegatedOppose > 0) oppChips.push((oppChips.length ? wit : '') + `<span class="chip dele">🗳 위임된 표 ×${o.delegatedOppose}</span>`);
  if (mine !== 'oppose') oppChips.push((oppChips.length ? wit : '') + `<button class="chip ghost opp-side" data-opp="${o.id}">＋ 반대편에 서기</button>`);
  void chip;

  return `
  <div class="line-block">
    <div class="line-label">👍 지지의 줄 — 뒤에 서는 사람이 앞사람의 증인이 됩니다</div>
    <div class="line-row">${supChips.join('')}</div>
  </div>
  <div class="line-block">
    <div class="line-label">👎 반대의 줄 — 반대도 같은 방식의 줄입니다</div>
    <div class="line-row">${oppChips.join('')}</div>
  </div>`;
}

function opinionCard(o, standing) {
  const mine = o.standers.includes(wallet.citizenId) ? 'support' : o.opposers.includes(wallet.citizenId) ? 'oppose' : null;
  const statusClass = o.status.replace(/\s/g, '');
  const isForm = openForm?.opinionId === o.id;
  const total = Math.max(o.weight + o.against, 1);

  // 블라인드 카드: 숫자 대신 논거만
  const numbers = o.blind
    ? `<p class="blind-note">🕶 블라인드 구간 ${info('블라인드')} — 집계는 잠시 비공개입니다. 아래 논거를 읽고 스스로 판단해 보세요.</p>`
    : `<div class="bar"><div class="sup" style="width:${(o.weight / total) * 100}%"></div><div class="opp" style="width:${(o.against / total) * 100}%"></div></div>
       <div class="metrics">
         무게 ${info('권위')}: 지지 ${o.authority.toFixed(1)} vs 반대 ${o.authorityAgainst.toFixed(1)}
         ${o.diversity != null ? ` · 다양성 ${(o.diversity * 100).toFixed(0)}% ${info('다양성')}` : ''}
         ${o.delegatedSupport + o.delegatedOppose > 0 ? ` · 위임된 표 +${o.delegatedSupport}/−${o.delegatedOppose}` : ''}
         ${o.status === '채택 대기' ? ' · ⏳ 지속 확인 중' : ''}
       </div>`;

  const jury = o.jury
    ? `<div class="jury-note">⚖ 추첨 배심 ${o.jury.members.length}인 ${info('배심')}: 승인 ${o.jury.approve} · 기각 ${o.jury.reject}${
        o.jury.members.includes(wallet.citizenId)
          ? ` — <b>내가 배심원입니다</b> <button class="btn small" data-verdict-ok="${o.id}">승인</button> <button class="btn small danger" data-verdict-no="${o.id}">기각</button>`
          : ''
      }</div>`
    : '';

  // 인라인 입장 폼 (교차 노출: 지지하려는 순간 최신 반대 논거를, 반대하려는 순간 최신 지지 논거를 먼저 보여준다)
  let form = '';
  if (isForm) {
    const side = openForm.side;
    const crossSrc = side === 'support' ? o.opposeComments : side === 'oppose' ? o.supportComments : [];
    const crossLabel = side === 'support' ? '반대하는' : '지지하는';
    const cross =
      crossSrc.length
        ? `<div class="cross-note">잠깐 — ${crossLabel} 시민의 논거를 먼저 읽어보세요:<br/>“${esc(crossSrc[crossSrc.length - 1].text)}” — ${esc(nameOf(crossSrc[crossSrc.length - 1].authorId))}</div>`
        : '';
    const label = side === 'support' ? '지지' : side === 'oppose' ? '반대' : '수정안';
    form = `
    <div class="stance-form" id="stance-form-active">
      ${cross}
      ${side === 'amend'
        ? `<input id="stance-text" placeholder="원안을 어떻게 고칠지 — 수정안 제목" />`
        : `<textarea id="stance-text" placeholder="논거를 함께 남겨주세요 (선택) — 왜 ${label}하시나요?"></textarea>`}
      <div class="actions">
        <button class="btn primary" data-stance-confirm>${side === 'amend' ? '수정안 제안하기' : label + '하기'}</button>
        <button class="btn ghost" data-stance-cancel>취소</button>
      </div>
    </div>`;
  }

  // 논거 목록: "왜 지지하나 / 왜 반대하나"
  const comments =
    o.supportComments.length || o.opposeComments.length
      ? `<div class="comments">
        ${o.supportComments.length ? `<h4>왜 지지하나 (${o.supportComments.length})</h4><ul>${o.supportComments.map((c) => `<li><span class="sup-c">＋</span> <b>${esc(nameOf(c.authorId))}</b> ${esc(c.text)}</li>`).join('')}</ul>` : ''}
        ${o.opposeComments.length ? `<h4>왜 반대하나 (${o.opposeComments.length})</h4><ul>${o.opposeComments.map((c) => `<li><span class="opp-c">－</span> <b>${esc(nameOf(c.authorId))}</b> ${esc(c.text)}</li>`).join('')}</ul>` : ''}
      </div>`
      : '';

  return `
  <article class="card opinion ${o.parentId ? 'amend' : ''}">
    ${o.parentId ? `<div class="amend-tag">↳ ${esc(nameOf(o.authorId))}의 수정안 — 이 묶음 안에서는 한 줄에만 설 수 있습니다</div>` : ''}
    <div class="op-head">
      <span class="status ${statusClass}" data-help="상태" title="눌러서 설명 보기">${o.status}</span>
      <h3>${esc(o.title)}</h3>
    </div>
    <p class="op-meta">제안: ${esc(nameOf(o.authorId))}</p>
    ${o.body ? `<p class="op-body">${esc(o.body)}</p>` : ''}
    ${lineViz(o, mine, standing)}
    ${numbers}
    ${jury}
    ${helpBox(['상태', '권위', '다양성', '블라인드', '배심'])}
    <div class="stance-row">
      <button class="btn stance sup ${mine === 'support' ? 'active' : ''}" data-sup="${o.id}">
        👍 지지${o.blind ? '' : ` <b>${o.weight}</b>`}</button>
      <button class="btn stance opp ${mine === 'oppose' ? 'active' : ''}" data-opp="${o.id}">
        👎 반대${o.blind ? '' : ` <b>${o.against}</b>`}</button>
      <button class="btn" data-amend="${o.id}" title="이 의견에 동의하지만 고치고 싶을 때 — 수정안의 새 줄을 시작합니다">✏️ 고쳐서 제안</button>
      <button class="info" data-help="줄서기" title="지지/반대의 원리">ⓘ</button>
    </div>
    ${helpBox(['줄서기'])}
    ${form}
    ${comments}
  </article>`;
}

// ── 하단 "내 위치" 바 — 잠정성의 상설 표시 ───────────────────
// "지금은 여기 서 있음"이지 소속이 아니다. 무입장·위임도 하나의 상태로 상시 표기.
function renderMyBar() {
  if (!currentTopic || !node.interests.has(currentTopic)) return;
  const opinions = lastQs ?? authorityIndex(node, currentTopic, { queueOpts: topicOpts(currentTopic) });
  const standing = computeStanding(currentTopic);
  const mineOp = opinions.find((o) => o.standers.includes(wallet.citizenId) || o.opposers.includes(wallet.citizenId));
  const posEl = $('#my-bar-pos');

  const currentDelegation = node
    .entriesForTopic(currentTopic)
    .filter((e) => e.type === 'DELEGATE' && e.author === wallet.citizenId)
    .sort((a, b) => b.seq - a.seq)[0]?.data.to;

  if (mineOp) {
    const side = mineOp.standers.includes(wallet.citizenId) ? 'support' : 'oppose';
    const line = standing.line(mineOp.id, side); // 제안자(PROPOSE)도 줄에 포함 — 줄의 머리
    const idx = line.findIndex((x) => x.cid === wallet.citizenId);
    const myTs = idx >= 0 ? line[idx].ts : 0;
    const pos = idx + 1;
    const ahead = idx > 0 ? nameOf(line[idx - 1].cid) : null;
    // 교차 노출 상주: 내가 선 뒤 새로 올라온 반대편 논거
    const counterComments = side === 'support' ? mineOp.opposeComments : mineOp.supportComments;
    const newCounter = counterComments.filter((c) => c.ts > myTs).length;
    posEl.innerHTML = `🙋 지금은 <b>“${esc(mineOp.title)}”</b> ${side === 'support' ? '지지' : '반대'} 줄 ${pos}번째${
      ahead ? ` (${esc(ahead)} 뒤)` : ''
    } — 언제든 옮기거나 떠날 수 있습니다
      <button class="btn small ghost" data-leave="${mineOp.familyRoot}">입장 철회</button>
      ${newCounter > 0 ? `<span class="new-opp">· 내가 선 뒤 ${side === 'support' ? '반대' : '지지'} 논거 ${newCounter}개가 새로 올라왔습니다 — 읽어보세요</span>` : ''}`;
  } else if (currentDelegation) {
    posEl.innerHTML = `🗳 이 이슈의 내 목소리는 <b>${esc(nameOf(currentDelegation))}</b>에게 맡겨져 있습니다 — 내가 직접 서는 순간 위임은 물러납니다`;
  } else {
    posEl.innerHTML = `🙋 아직 어느 줄에도 서지 않았습니다 — 무입장도 하나의 입장입니다 ${info('줄서기')}`;
  }

  // 위임 선택 (다운스) — 회수는 언제든
  const sel = $('#delegate-select');
  const others = [...node.registry.keys()].filter((c) => c !== wallet.citizenId);
  sel.innerHTML =
    '<option value="">직접 참여 (기본)</option>' +
    others.map((c) => `<option value="${c}" ${c === currentDelegation ? 'selected' : ''}>${esc(nameOf(c))}에게 맡기기</option>`).join('');
  sel.onchange = () => mesh.act(currentTopic, 'DELEGATE', { to: sel.value || null });
  $('#delegation-help').innerHTML = info('위임') + helpBox(['위임']);
}

// ── 장부 패널: 검증은 pull형 — 원하는 사람만 연다 ────────────
// 원칙: 항목별 ✓ 반복은 배지 인플레이션 (미검증 항목은 애초에 저장 안 됨).
// 총괄 한 줄 + [지금 다시 검증]으로 주장을 행동으로 입증한다.
const LEDGER_VERB = {
  PROPOSE: (e) => `💡 <b>${esc(nameOf(e.author))}</b>이(가) 의견을 올렸습니다: “${esc(e.data.title ?? '')}”`,
  AMEND: (e) => `✏️ <b>${esc(nameOf(e.author))}</b>이(가) 수정안을 제안했습니다: “${esc(e.data.title ?? '')}” <span class="sub">원안을 가리킴</span>`,
  JOIN: (e) => `🙋 <b>${esc(nameOf(e.author))}</b>이(가) 지지 줄에 섰습니다`,
  OPPOSE: (e) => `👎 <b>${esc(nameOf(e.author))}</b>이(가) 반대 줄에 섰습니다`,
  LEAVE: (e) => `🚶 <b>${esc(nameOf(e.author))}</b>이(가) 줄에서 나왔습니다 <span class="sub">나온 기록도 지워지지 않고 남습니다</span>`,
  DELEGATE: (e) =>
    e.data.to
      ? `🗳 <b>${esc(nameOf(e.author))}</b>이(가) 이 이슈의 목소리를 <b>${esc(nameOf(e.data.to))}</b>에게 맡겼습니다`
      : `🗳 <b>${esc(nameOf(e.author))}</b>이(가) 목소리를 직접 내기로 했습니다 (위임 회수)`,
  VERDICT: (e) => `⚖ 배심원 <b>${esc(nameOf(e.author))}</b>이(가) ${e.data.approve ? '승인' : '기각'}했습니다${e.data.reason ? ` — “${esc(e.data.reason)}”` : ''}`,
  SHARE: (e) => `📣 <b>${esc(nameOf(e.author))}</b>이(가) 링크로 전파했습니다`,
};

function ledgerLine(e) {
  const base = LEDGER_VERB[e.type]?.(e) ?? `📄 <b>${esc(nameOf(e.author))}</b>: ${esc(e.type)}`;
  let witness = '';
  if ((e.type === 'JOIN' || e.type === 'OPPOSE') && e.data.behind?.length) {
    const front = node.byHash.get(e.data.behind[0]);
    if (front && (front.type === 'JOIN' || front.type === 'OPPOSE'))
      witness = `<span class="sub">앞선 ${esc(nameOf(front.author))}의 기록을 증인 삼음</span>`;
    else if (front) witness = '<span class="sub">줄의 머리(의견)를 증인 삼음</span>';
  }
  const cls = e.type === 'OPPOSE' ? ' opp' : e.type === 'SHARE' ? ' share' : '';
  const fork = node.forkProofs.has(e.author)
    ? `<span class="sub">⚖ 이 시민의 기록이 서로 어긋나(같은 순번에 두 서명) 수학적으로 확인되어, 집계에서 자동 제외 중입니다</span>`
    : '';
  return `<div class="ledger-ev${node.forkProofs.has(e.author) ? ' fork' : cls}">${base}${witness}${fork}
    <span class="sub">${new Date(e.ts).toLocaleTimeString('ko-KR')}</span></div>`;
}

function renderLedger() {
  const el = $('#ledger');
  el.classList.toggle('hidden', !ledgerOpen);
  if (!ledgerOpen || !currentTopic) return;
  const entries = node
    .entriesForTopic(currentTopic)
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 60);
  el.innerHTML = `<h3>📜 위브 장부 ${info('장부')}</h3>
    <div class="ledger-head">참여 내역은 공개 장부입니다 — 누구나 같은 기록을 갖고 서로 검증합니다.<br/>
    이 장부 <b>${entries.length}건</b>은 저장 시점에 전부 서명 검증되었습니다.
    <button class="btn small" data-ledger-verify>지금 다시 검증</button> <span id="ledger-verify-msg"></span></div>
    ${helpBox(['장부'])}
    ${entries.map(ledgerLine).join('') || '<p class="hint">아직 기록이 없습니다.</p>'}`;
}

async function runLedgerVerify() {
  const msg = $('#ledger-verify-msg');
  if (!msg) return;
  msg.textContent = '검증 중…';
  const entries = node.entriesForTopic(currentTopic);
  const t0 = performance.now();
  let ok = 0;
  let bad = 0;
  for (const e of entries) {
    const pem = node.registry.get(e.author);
    if (pem && (await verifyEntry(e, pem))) ok += 1;
    else bad += 1;
  }
  const ms = Math.round(performance.now() - t0);
  msg.textContent = bad === 0 ? `✓ 방금 이 기기에서 ${ok}건 재검증 완료 (${ms}ms)` : `⚠ ${bad}건 검증 실패 — 네트워크에 알려집니다`;
}

// ── 네트워크 카드 (광장 보조 열) ─────────────────────────────
function renderNet() {
  const rows = [];
  for (const [peerId, ch] of mesh.channels) {
    if (ch.dc.readyState !== 'open') continue;
    rows.push(`<div class="peer-row"><b>${esc(ch.hello?.id ?? peerId)}</b> — 🔒 직접 연결 (서버가 못 봄)</div>`);
  }
  const relayOnly = [...mesh.roomPeers].filter((pid) => !mesh.channels.get(pid) || mesh.channels.get(pid).dc.readyState !== 'open');
  let relayShown = 0;
  for (const peerId of relayOnly) {
    const hello = mesh.relayPeers.get(peerId)?.hello;
    const pc = mesh.pcs.get(peerId);
    const negotiating = pc && !['failed', 'closed'].includes(pc.connectionState);
    const label = negotiating ? '중계 연결 (직접 연결 시도 중…)' : '중계 연결 (서버 경유)';
    rows.push(`<div class="peer-row"><b>${esc(hello?.id ?? peerId)}</b> — 🔁 ${label}</div>`);
    relayShown++;
  }
  if (relayShown > 0) {
    rows.push('<div class="peer-row" style="color:var(--warn);font-size:0.72rem">🔁 중계 연결은 서버를 거칩니다(같은 와이파이가 아니면 흔함). 항목은 여전히 서명되어 위조는 불가하지만, 직접 연결과 달리 서버가 내용을 볼 수 있습니다.</div>');
  }
  if (dupTab) {
    rows.unshift('<div class="peer-row" style="color:var(--warn)">⚠ 같은 브라우저의 다른 탭에서 이미 참여 중 — 같은 지갑이 충돌합니다. 시크릿 창이나 다른 기기를 쓰세요.</div>');
  }
  if (node.forkProofs.has(wallet.citizenId)) {
    rows.unshift(
      '<div class="peer-row" style="color:var(--bad)">⚠ 이 지갑에 이중 서명 기록이 있어(과거 다중 실행 등) 네트워크가 이 시민의 모든 항목을 집계에서 제외 중입니다 — 내가 만든 이슈가 남에게 보이지 않는 원인입니다. ' +
        '<button class="btn small danger" id="reset-wallet">새 시민으로 다시 시작</button></div>'
    );
  }
  $('#peers-list').innerHTML = rows.join('') || '<div class="peer-row">아직 연결된 피어가 없습니다 — 다른 기기·시크릿 창에서 같은 주소를 열어보세요.</div>';
}

function renderInsight() {
  const { citizenHub } = computeInsight(node);
  const sorted = [...citizenHub.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const myHub = citizenHub.get(wallet.citizenId);
  $('#my-info').innerHTML = `${esc(wallet.name)} · <code>${wallet.citizenId.slice(0, 10)}</code> · 내 안목 ${myHub != null ? myHub.toFixed(2) : '—'} ${info('안목')} <span class="hint">(개인키는 이 브라우저에만)</span>`;
  $('#insight-list').innerHTML =
    helpBox(['안목']) +
    (sorted
      .map(
        ([id, hub]) =>
          `<div class="insight-row"><span>${esc(nameOf(id))}${id === wallet.citizenId ? ' <b>(나)</b>' : ''}</span><b>${hub.toFixed(2)}</b></div>`
      )
      .join('') || '<p class="hint">아직 기록이 없습니다. 의견을 제안하거나 좋은 의견에 일찍 지지하면 쌓입니다.</p>');
}

// ── 이벤트: 전면 위임 — 재렌더·뷰 전환에 면역 ────────────────
function openStance(opinionId, side) {
  openForm = { opinionId, side };
  // 폼을 그리기 위해 1회 강제 렌더 (openForm 가드는 "이미 그려진 뒤"부터 정지)
  const saved = openForm;
  openForm = null;
  render();
  openForm = saved;
  render0penForm();
  document.getElementById('stance-text')?.focus();
}
// openForm이 설정된 상태로 칸반을 딱 한 번 그린다
function render0penForm() {
  const opts = topicOpts(currentTopic);
  const opinions = authorityIndex(node, currentTopic, { queueOpts: opts });
  lastQs = opinions;
  const standing = computeStanding(currentTopic);
  const order = colOrders.get(currentTopic) ?? desiredOrder(opinions);
  const byId = new Map(opinions.map((o) => [o.id, o]));
  const cols = order
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((o) => `<div class="kanban-col st-${o.status.replace(/\s/g, '')}">${opinionCard(o, standing)}</div>`);
  cols.push(
    `<div class="kanban-col ghost-col"><div>💡 다른 해법이 있나요?<br/>경쟁이 있어야 검증됩니다.</div><button class="btn primary small" data-ghost-propose>＋ 새 의견 제안</button></div>`
  );
  $('#opinions').innerHTML = cols.join('');
}

document.addEventListener('click', (e) => {
  const hit = (sel) => e.target.closest(sel);

  const help = hit('[data-help]');
  if (help) {
    openHelp = openHelp === help.dataset.help ? null : help.dataset.help;
    render();
    return;
  }
  if (hit('[data-help-close]')) {
    openHelp = null;
    render();
    return;
  }
  const open = hit('[data-open]') ?? hit('[data-open2]');
  if (open) {
    const t = open.dataset.open ?? open.dataset.open2;
    if (node.interests.has(t)) navTopic(t);
    return;
  }
  const follow = hit('[data-follow]');
  if (follow) {
    expressInterest(follow.dataset.follow).then(render);
    return;
  }
  const sup = hit('[data-sup]');
  if (sup) {
    openStance(sup.dataset.sup, 'support');
    return;
  }
  const opp = hit('[data-opp]');
  if (opp) {
    openStance(opp.dataset.opp, 'oppose');
    return;
  }
  const amend = hit('[data-amend]');
  if (amend) {
    openStance(amend.dataset.amend, 'amend');
    return;
  }
  const leave = hit('[data-leave]');
  if (leave) {
    mesh.act(currentTopic, 'LEAVE', { familyRoot: leave.dataset.leave }).then(render);
    return;
  }
  const verdict = hit('[data-verdict-ok]') ?? hit('[data-verdict-no]');
  if (verdict) {
    const approve = 'verdictOk' in verdict.dataset;
    const opinionId = verdict.dataset.verdictOk ?? verdict.dataset.verdictNo;
    const reason = prompt(approve ? '승인 사유 (근거가 타당한가요?):' : '기각 사유:') ?? '';
    mesh.act(currentTopic, 'VERDICT', { opinionId, approve, reason }).then(render);
    return;
  }
  if (hit('[data-stance-confirm]')) {
    const text = document.getElementById('stance-text')?.value.trim() || null;
    const { opinionId, side } = openForm ?? {};
    openForm = null;
    if (opinionId) submitStance(opinionId, side, text).then(render);
    return;
  }
  if (hit('[data-stance-cancel]')) {
    openForm = null;
    render();
    return;
  }
  const expand = hit('[data-line-expand]');
  if (expand) {
    expandedLines.add(expand.dataset.lineExpand);
    render();
    return;
  }
  if (hit('[data-ghost-propose]')) {
    document.getElementById('propose-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('propose-title')?.focus();
    return;
  }
  if (hit('#back-plaza')) {
    location.hash = '';
    return;
  }
  if (hit('#ledger-btn')) {
    ledgerOpen = !ledgerOpen;
    render();
    return;
  }
  if (hit('#fab-announce')) {
    announceOpen = !announceOpen;
    render();
    if (announceOpen) document.getElementById('announce-title')?.focus();
    return;
  }
  if (hit('#reorder-banner')) {
    colOrders.delete(currentTopic);
    render();
    return;
  }
  if (hit('[data-ledger-verify]')) {
    runLedgerVerify();
    return;
  }
  if (hit('#guide-banner-btn')) {
    $('#guide').classList.toggle('hidden');
    return;
  }
  if (hit('#share-topic')) {
    (async () => {
      const made = await makeShareLink();
      if (!made) return;
      const { url, included, total } = made;
      const msg = document.getElementById('share-msg');
      const cut = included < total ? ` · ${total}건 중 ${included}건 담김, 나머지는 접속 시 동기화` : '';
      try {
        await navigator.clipboard.writeText(url);
        if (msg) msg.textContent = `복사됨! 카톡·문자 어디로든 보내세요 (${url.length}자${cut})`;
      } catch {
        prompt('이 링크를 복사해 공유하세요:', url);
      }
    })();
    return;
  }
  if (hit('#reset-wallet')) {
    if (confirm('이 브라우저의 지갑과 저장 데이터를 지우고 새 시민으로 다시 참여합니다. 계속할까요?')) {
      localStorage.clear();
      location.reload();
    }
  }
});

// ── 정적 폼 바인딩 (모듈 로드 시 1회 — 절대 innerHTML로 재생성하지 않음) ──
$('#announce-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#announce-title').value.trim();
  if (!title) return;
  announce(title, $('#announce-desc').value.trim(), $('#announce-charter').checked).then(() => {
    $('#announce-title').value = '';
    $('#announce-desc').value = '';
    $('#announce-charter').checked = false;
    announceOpen = false;
    render();
  });
});

$('#propose-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#propose-title').value.trim();
  if (!title || !currentTopic) return;
  mesh.act(currentTopic, 'PROPOSE', { title, body: $('#propose-body').value.trim() }).then(() => {
    $('#propose-title').value = '';
    $('#propose-body').value = '';
    render();
  });
});

$('#catalog-filter').addEventListener('input', () => {
  if (node && view === 'plaza') renderPlaza();
});
$('#guide-close').addEventListener('click', () => {
  localStorage.setItem('agora-guide-done', '1');
  $('#guide').classList.add('hidden');
});
$('#help-btn').addEventListener('click', () => {
  if (view !== 'plaza') location.hash = '';
  $('#guide').classList.remove('hidden');
  $('#guide').scrollIntoView({ behavior: 'smooth' });
});
