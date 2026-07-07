// 아고라 라이브 — 브라우저 P2P 시민 클라이언트 UI
//
// 핵심: 집계 코드는 서버 피어와 동일한 모듈을 그대로 import 한다.
// 브라우저는 화면이 아니라 완전한 피어다 — 서명·저장·가십·집계 전부 로컬.
import { sha256 } from '/src/weave/hash.js';
import { queueState, tips } from '/src/weave/queue.js';
import { computeInsight, authorityIndex } from '/src/weave/insight.js';
import { BrowserWallet, BrowserNode, BrowserMesh } from '/p2p/weave-web.js';

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
};

let wallet = null;
let node = null;
let mesh = null;
let dupTab = false;
let currentTopic = null;
let openForm = null; // { opinionId, side: 'support'|'oppose'|'amend' } — 열려 있는 동안 갱신 일시정지
let openHelp = null; // 현재 펼쳐진 도움말 키

const setCurrentTopic = (t) => {
  currentTopic = t;
  if (t) localStorage.setItem('agora-current-topic', t);
};

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
  const savedTopic = localStorage.getItem('agora-current-topic');
  if (savedTopic && node.interests.has(savedTopic)) currentTopic = savedTopic;
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

// ── 행위 ─────────────────────────────────────────────────────
async function announce(title, description, charter) {
  const topicId = 't_' + sha256(`${title}|${wallet.citizenId}|${wallet.seq}`).slice(0, 12);
  mesh.follow(topicId);
  await mesh.act(CATALOG, 'PROPOSE', { title, body: description, topicId, charter });
  setCurrentTopic(topicId);
}

async function expressInterest(announceId) {
  const a = node.byHash.get(announceId);
  mesh.follow(a.data.topicId);
  setCurrentTopic(a.data.topicId);
  await mesh.act(CATALOG, 'JOIN', { opinionId: announceId, behind: tips(node, announceId) });
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

// ── 렌더링 ───────────────────────────────────────────────────
function render() {
  if (!node) return;
  renderNet();
  renderCatalog();
  renderTopic();
  renderInsight();
}

function renderNet() {
  const pill = $('#net-status');
  const n = mesh.channels.size;
  if (mesh.wsState !== '연결됨') {
    pill.textContent = `신호 서버 ${mesh.wsState ?? '연결 중'}…`;
    pill.className = 'pill';
  } else if (n > 0) {
    pill.textContent = `피어 ${n}명과 직접 연결됨 · 시민 ${node.registry.size}명`;
    pill.className = 'pill ok';
  } else {
    pill.textContent = '신호 연결됨 · 다른 참여자 대기 중';
    pill.className = 'pill';
  }
  const ICE_LABEL = { new: '협상 준비', connecting: 'ICE 협상 중', connected: '직접 연결됨', failed: '연결 실패(NAT — 중계 필요)', disconnected: '끊김', closed: '종료' };
  const rows = [];
  for (const [peerId, pc] of mesh.pcs) {
    const ch = mesh.channels.get(peerId);
    const name = ch?.hello?.id ?? peerId;
    const state = ch ? '직접 연결됨 (데이터 P2P)' : (ICE_LABEL[pc.connectionState] ?? pc.connectionState);
    rows.push(`<div class="peer-row"><b>${esc(name)}</b> — ${state}</div>`);
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
  const resetBtn = document.getElementById('reset-wallet');
  if (resetBtn) {
    resetBtn.onclick = () => {
      if (confirm('이 브라우저의 지갑과 저장 데이터를 지우고 새 시민으로 다시 참여합니다. 계속할까요?')) {
        localStorage.clear();
        location.reload();
      }
    };
  }
}

function renderCatalog() {
  const filter = ($('#catalog-filter').value ?? '').toLowerCase();
  const items = catalogItems().filter((c) => !filter || `${c.title} ${c.description}`.toLowerCase().includes(filter));
  $('#catalog-list').innerHTML =
    items
      .map(
        (c) => `
    <div class="catalog-item">
      <div class="catalog-title ${c.topicId === currentTopic ? 'current' : ''}" data-open="${c.topicId}">
        ${esc(c.title)}
        ${c.charter ? '<span class="badge charter">헌장</span>' : ''}
        ${c.region ? `<span class="badge region">${esc(c.region)}</span>` : ''}
      </div>
      <div class="catalog-meta">🔥 관심 ${c.interest}명${c.following ? ` · 구독중 (${c.entries}건 보관)` : ''}</div>
      ${c.following
        ? `<button class="btn small ghost" data-open2="${c.topicId}">열기 →</button>`
        : `<button class="btn small primary" data-follow="${c.announceId}">구독하고 참여</button>`}
    </div>`
      )
      .join('') ||
    '<p class="hint">아직 공표된 이슈가 없습니다.<br/>아래에서 <b>첫 이슈를 만들어</b> 네트워크에 알려보세요 ↓<br/>(다른 참여자가 만든 이슈는 여기 자동으로 나타납니다)</p>';

  document.querySelectorAll('[data-follow]').forEach((el) =>
    el.addEventListener('click', () => expressInterest(el.dataset.follow).then(render))
  );
  document.querySelectorAll('[data-open],[data-open2]').forEach((el) =>
    el.addEventListener('click', () => {
      const t = el.dataset.open ?? el.dataset.open2;
      if (node.interests.has(t)) {
        setCurrentTopic(t);
        openForm = null;
        render();
      }
    })
  );
}

function renderTopic() {
  // 작성 중에는 화면 갱신을 멈춰 입력을 보호한다 (폼이 닫히면 재개)
  if (openForm && document.getElementById('stance-form-active')) return;

  const header = $('#topic-header');
  if (!currentTopic || !node.interests.has(currentTopic)) {
    header.innerHTML =
      '<div class="card empty-guide"><h3>👈 왼쪽에서 시작하세요</h3><p class="hint">관심 있는 이슈의 <b>[구독하고 참여]</b>를 누르면 그 이슈의 모든 의견과 논쟁이 이 자리에 나타납니다.<br/>원하는 이슈가 없다면 <b>새 이슈 만들기</b>로 직접 공표할 수 있습니다.</p></div>';
    $('#opinions').innerHTML = '';
    $('#propose-form').classList.add('hidden');
    $('#delegation-box').classList.add('hidden');
    return;
  }
  const item = catalogItems().find((c) => c.topicId === currentTopic);
  const opts = topicOpts(currentTopic);
  header.innerHTML = `<h2>${esc(item?.title ?? currentTopic)}
    ${item?.charter ? `<span class="badge charter">헌장 의제</span>${info('헌장')}` : ''}</h2>
    ${item?.description ? `<p class="hint">${esc(item.description)}</p>` : ''}
    ${helpBox(['헌장'])}`;
  $('#propose-form').classList.remove('hidden');
  $('#delegation-box').classList.remove('hidden');

  // 위임 (다운스): 등록된 다른 시민들
  const sel = $('#delegate-select');
  const others = [...node.registry.keys()].filter((c) => c !== wallet.citizenId);
  const currentDelegation = node
    .entriesForTopic(currentTopic)
    .filter((e) => e.type === 'DELEGATE' && e.author === wallet.citizenId)
    .sort((a, b) => b.seq - a.seq)[0]?.data.to;
  sel.innerHTML =
    '<option value="">직접 참여 (기본)</option>' +
    others.map((c) => `<option value="${c}" ${c === currentDelegation ? 'selected' : ''}>${esc(nameOf(c))}에게 맡기기</option>`).join('');
  sel.onchange = () => mesh.act(currentTopic, 'DELEGATE', { to: sel.value || null });
  $('#delegation-help').innerHTML = info('위임') + helpBox(['위임']);

  const opinions = authorityIndex(node, currentTopic, { queueOpts: opts });
  $('#opinions').innerHTML =
    opinions.map((o) => opinionCard(o)).join('') ||
    '<div class="card empty-guide"><h3>아직 의견이 없습니다</h3><p class="hint">이 이슈에 대한 <b>첫 의견(해결책·주장)</b>을 아래에서 제안해 보세요.<br/>제안한 의견에는 다른 시민들이 논거를 붙여 지지하거나 반대하게 됩니다.</p></div>';

  bindOpinionActions();
}

function opinionCard(o) {
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

  // 인라인 입장 폼 (교차 노출: 지지하려는 순간 최신 반대 논거를 먼저 보여준다)
  let form = '';
  if (isForm) {
    const side = openForm.side;
    const cross =
      side === 'support' && o.opposeComments.length
        ? `<div class="cross-note">잠깐 — 반대하는 시민의 논거를 먼저 읽어보세요:<br/>“${esc(o.opposeComments[o.opposeComments.length - 1].text)}” — ${esc(nameOf(o.opposeComments[o.opposeComments.length - 1].authorId))}</div>`
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
    ${o.parentId ? '<div class="amend-tag">↳ 수정안</div>' : ''}
    <div class="op-head">
      <span class="status ${statusClass}" data-help="상태" title="눌러서 설명 보기">${o.status}</span>
      <h3>${esc(o.title)}</h3>
      ${mine ? `<span class="badge ${mine === 'support' ? 'mine-sup' : 'mine-opp'}">${mine === 'support' ? '✓ 지지 중' : '✕ 반대 중'}</span>` : ''}
    </div>
    <p class="op-meta">제안: ${esc(nameOf(o.authorId))}</p>
    ${o.body ? `<p class="op-body">${esc(o.body)}</p>` : ''}
    ${numbers}
    ${jury}
    ${helpBox(['상태', '권위', '다양성', '블라인드', '배심'])}
    <div class="stance-row">
      <button class="btn stance sup ${mine === 'support' ? 'active' : ''}" data-sup="${o.id}">
        👍 지지${o.blind ? '' : ` <b>${o.weight}</b>`}</button>
      <button class="btn stance opp ${mine === 'oppose' ? 'active' : ''}" data-opp="${o.id}">
        👎 반대${o.blind ? '' : ` <b>${o.against}</b>`}</button>
      <button class="btn" data-amend="${o.id}" title="이 의견에 동의하지만 고치고 싶을 때 — 수정안의 새 줄을 시작합니다">✏️ 고쳐서 제안</button>
      ${mine ? `<button class="btn ghost" data-leave="${o.familyRoot}" title="집계에서 빠집니다. 남긴 논거는 기록으로 남습니다.">입장 철회</button>` : ''}
      <button class="info" data-help="줄서기" title="지지/반대의 원리">ⓘ</button>
    </div>
    ${helpBox(['줄서기'])}
    ${form}
    ${comments}
  </article>`;
}

function bindOpinionActions() {
  const openStance = (opinionId, side) => {
    openForm = { opinionId, side };
    render();
    document.getElementById('stance-text')?.focus();
  };
  document.querySelectorAll('[data-sup]').forEach((el) => el.addEventListener('click', () => openStance(el.dataset.sup, 'support')));
  document.querySelectorAll('[data-opp]').forEach((el) => el.addEventListener('click', () => openStance(el.dataset.opp, 'oppose')));
  document.querySelectorAll('[data-amend]').forEach((el) => el.addEventListener('click', () => openStance(el.dataset.amend, 'amend')));
  document.querySelectorAll('[data-leave]').forEach((el) =>
    el.addEventListener('click', () => mesh.act(currentTopic, 'LEAVE', { familyRoot: el.dataset.leave }).then(render))
  );
  document.querySelectorAll('[data-verdict-ok],[data-verdict-no]').forEach((el) =>
    el.addEventListener('click', () => {
      const approve = 'verdictOk' in el.dataset;
      const opinionId = el.dataset.verdictOk ?? el.dataset.verdictNo;
      const reason = prompt(approve ? '승인 사유 (근거가 타당한가요?):' : '기각 사유:') ?? '';
      mesh.act(currentTopic, 'VERDICT', { opinionId, approve, reason }).then(render);
    })
  );
  const confirmBtn = document.querySelector('[data-stance-confirm]');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const text = document.getElementById('stance-text')?.value.trim() || null;
      const { opinionId, side } = openForm;
      openForm = null;
      await submitStance(opinionId, side, text);
      render();
    });
  }
  document.querySelector('[data-stance-cancel]')?.addEventListener('click', () => {
    openForm = null;
    render();
  });
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

// ── 도움말 ⓘ (이벤트 위임 — 재렌더에도 살아남는다) ──────────
document.addEventListener('click', (e) => {
  const helpBtn = e.target.closest('[data-help]');
  if (helpBtn) {
    openHelp = openHelp === helpBtn.dataset.help ? null : helpBtn.dataset.help;
    render();
    return;
  }
  if (e.target.closest('[data-help-close]')) {
    openHelp = null;
    render();
  }
});

// ── 폼 바인딩 ────────────────────────────────────────────────
$('#announce-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#announce-title').value.trim();
  if (!title) return;
  announce(title, $('#announce-desc').value.trim(), $('#announce-charter').checked).then(() => {
    $('#announce-title').value = '';
    $('#announce-desc').value = '';
    $('#announce-charter').checked = false;
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

$('#catalog-filter').addEventListener('input', renderCatalog);
$('#guide-close').addEventListener('click', () => {
  localStorage.setItem('agora-guide-done', '1');
  $('#guide').classList.add('hidden');
});
$('#help-btn').addEventListener('click', () => $('#guide').classList.toggle('hidden'));
