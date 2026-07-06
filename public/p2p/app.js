// 아고라 라이브 — 브라우저 P2P 시민 클라이언트 UI
//
// 핵심: 집계 코드는 서버 피어와 동일한 모듈을 그대로 import 한다.
// 브라우저는 화면이 아니라 완전한 피어다 — 서명·저장·가십·집계 전부 로컬.
import { sha256 } from '/src/weave/hash.js';
import { queueState, tips, selectJury } from '/src/weave/queue.js';
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

let wallet = null;
let node = null;
let mesh = null;
let currentTopic = null;
const setCurrentTopic = (t) => {
  currentTopic = t;
  if (t) localStorage.setItem('agora-current-topic', t);
};

// ── 참여 (이름 → 지갑 생성/복원 → 메시 접속) ─────────────────
async function boot(name) {
  wallet = await BrowserWallet.create(name);
  node = new BrowserNode({ id: wallet.name, interests: [CATALOG] });
  node.restore(); // 이 기기에 저장된 역사·등록부·관심사 복원
  node.registry.set(wallet.citizenId, wallet.publicKey);
  mesh = new BrowserMesh({ node, wallet, onChange: render });
  mesh.connect(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`);
  const savedTopic = localStorage.getItem('agora-current-topic');
  if (savedTopic && node.interests.has(savedTopic)) currentTopic = savedTopic;
  $('#join-overlay').classList.add('hidden');
  $('#my-info').textContent = `${wallet.name} · ${wallet.citizenId} (개인키는 이 브라우저에만 존재)`;
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

// ── 행위 ─────────────────────────────────────────────────────
async function announce(title, description, charter) {
  const topicId = 't_' + sha256(`${title}|${wallet.citizenId}|${wallet.seq}`).slice(0, 12);
  mesh.follow(topicId);
  await mesh.act(CATALOG, 'PROPOSE', { title, body: description, topicId, charter });
  setCurrentTopic(topicId);
}

async function expressInterest(announceId) {
  const announce = node.byHash.get(announceId);
  mesh.follow(announce.data.topicId);
  setCurrentTopic(announce.data.topicId);
  await mesh.act(CATALOG, 'JOIN', { opinionId: announceId, behind: tips(node, announceId) });
}

async function support(opinionId, comment) {
  // 교차 노출 (선스타인): 지지 직전 최신 반대의견을 먼저 보여준다
  const op = queueState(node, currentTopic).opinions.find((x) => x.id === opinionId);
  if (op?.opposeComments.length) {
    const top = op.opposeComments[op.opposeComments.length - 1];
    if (!confirm(`이 의견에 대한 반대의견을 먼저 확인하세요:\n\n"${top.text}" — ${nameOf(top.authorId)}\n\n그래도 지지 줄에 서시겠습니까?`)) return;
  }
  const data = { opinionId, behind: tips(node, opinionId, 'support') };
  if (comment) data.comment = comment;
  await mesh.act(currentTopic, 'JOIN', data);
}

async function oppose(opinionId, comment) {
  const data = { opinionId, behind: tips(node, opinionId, 'oppose') };
  if (comment) data.comment = comment;
  await mesh.act(currentTopic, 'OPPOSE', data);
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
  pill.textContent = n > 0 ? `피어 ${n}명과 직접 연결됨 · 시민 ${node.registry.size}명` : '피어 대기 중 (다른 브라우저에서 접속하면 연결됩니다)';
  pill.className = `pill ${n > 0 ? 'ok' : ''}`;
  $('#peers-list').innerHTML =
    [...mesh.channels.entries()]
      .map(([, ch]) => `<div class="peer-row"><b>${esc(ch.hello?.id ?? '협상 중…')}</b> — WebRTC 직접 연결</div>`)
      .join('') || '<div class="peer-row">아직 연결된 피어가 없습니다</div>';
}

function renderCatalog() {
  const filter = ($('#catalog-filter').value ?? '').toLowerCase();
  const items = catalogItems().filter(
    (c) => !filter || `${c.title} ${c.description}`.toLowerCase().includes(filter)
  );
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
      <div class="catalog-meta">관심 ${c.interest}명${c.following ? ` · 보유 ${c.entries}항목 · 구독중` : ''}</div>
      ${c.following ? '' : `<button class="btn small" data-follow="${c.announceId}">관심 + 구독</button>`}
    </div>`
      )
      .join('') || '<p class="hint">아직 공표된 이슈가 없습니다.</p>';

  document.querySelectorAll('[data-follow]').forEach((el) =>
    el.addEventListener('click', () => expressInterest(el.dataset.follow).then(render))
  );
  document.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', () => {
      const t = el.dataset.open;
      if (node.interests.has(t)) {
        setCurrentTopic(t);
        render();
      }
    })
  );
}

function renderTopic() {
  const header = $('#topic-header');
  if (!currentTopic || !node.interests.has(currentTopic)) {
    header.innerHTML = '<p class="hint">왼쪽에서 이슈를 구독하거나 새로 공표하세요.</p>';
    $('#opinions').innerHTML = '';
    $('#propose-form').classList.add('hidden');
    $('#delegation-box').classList.add('hidden');
    return;
  }
  const item = catalogItems().find((c) => c.topicId === currentTopic);
  const opts = topicOpts(currentTopic);
  header.innerHTML = `<h2>${esc(item?.title ?? currentTopic)}
    ${item?.charter ? '<span class="badge charter">헌장 의제 — 채택 2/3 + 3배 유지</span>' : ''}</h2>
    ${item?.description ? `<p class="hint">${esc(item.description)}</p>` : ''}`;
  $('#propose-form').classList.remove('hidden');
  $('#delegation-box').classList.remove('hidden');

  // 위임 선택지 (다운스): 등록된 다른 시민들
  const sel = $('#delegate-select');
  const others = [...node.registry.keys()].filter((c) => c !== wallet.citizenId);
  const currentDelegation = node
    .entriesForTopic(currentTopic)
    .filter((e) => e.type === 'DELEGATE' && e.author === wallet.citizenId)
    .sort((a, b) => b.seq - a.seq)[0]?.data.to;
  sel.innerHTML =
    '<option value="">직접 참여</option>' +
    others.map((c) => `<option value="${c}" ${c === currentDelegation ? 'selected' : ''}>${esc(nameOf(c))}에게 위임</option>`).join('');
  sel.onchange = () => mesh.act(currentTopic, 'DELEGATE', { to: sel.value || null });

  const opinions = authorityIndex(node, currentTopic, { queueOpts: opts });
  $('#opinions').innerHTML =
    opinions
      .map((o) => {
        const statusClass = o.status.replace(/\s/g, '');
        const mine = o.standers.includes(wallet.citizenId)
          ? '지지 중'
          : o.opposers.includes(wallet.citizenId)
            ? '반대 중'
            : null;
        const jury = o.jury
          ? `<div class="jury-note">추첨 배심 ${o.jury.members.length}인: 승인 ${o.jury.approve} · 기각 ${o.jury.reject}${
              o.jury.members.includes(wallet.citizenId)
                ? ` — <b>나는 배심원입니다</b> <button class="btn small" data-verdict-ok="${o.id}">승인</button> <button class="btn small danger" data-verdict-no="${o.id}">기각</button>`
                : ''
            }</div>`
          : '';
        if (o.blind) {
          return `
        <article class="card opinion ${o.parentId ? 'amend' : ''}">
          <div class="op-head"><span class="status 블라인드">블라인드</span><h3>${esc(o.title)}</h3></div>
          ${o.body ? `<p class="op-body">${esc(o.body)}</p>` : ''}
          <p class="blind-note">집계 비공개 구간입니다 — 숫자가 아니라 논증을 읽고 독립적으로 판단하세요 (콩도르세).</p>
          ${renderComments(o)}
          ${renderActions(o, mine)}
        </article>`;
        }
        const total = Math.max(o.weight + o.against, 1);
        return `
      <article class="card opinion ${o.parentId ? 'amend' : ''}">
        <div class="op-head"><span class="status ${statusClass}">${o.status}</span><h3>${esc(o.title)}</h3>
          ${mine ? `<span class="badge ${mine === '지지 중' ? '' : 'charter'}">${mine}</span>` : ''}</div>
        <p class="op-meta">제안: ${esc(nameOf(o.authorId))}</p>
        ${o.body ? `<p class="op-body">${esc(o.body)}</p>` : ''}
        <div class="bar"><div class="sup" style="width:${(o.weight / total) * 100}%"></div><div class="opp" style="width:${(o.against / total) * 100}%"></div></div>
        <p class="op-meta">지지 ${o.weight}명 (권위 ${o.authority.toFixed(1)}) vs 반대 ${o.against}명 (권위 ${o.authorityAgainst.toFixed(1)})
          ${o.diversity != null ? ` · 다양성 ${(o.diversity * 100).toFixed(0)}%` : ''}
          ${o.delegatedSupport + o.delegatedOppose > 0 ? ` · 위임 +${o.delegatedSupport}/−${o.delegatedOppose}` : ''}
          ${o.metSince && o.status === '채택 대기' ? ` · 지속 확인 중` : ''}</p>
        ${jury}
        ${renderComments(o)}
        ${renderActions(o, mine)}
      </article>`;
      })
      .join('') || '<p class="hint">아직 의견이 없습니다. 첫 의견을 제안해 보세요.</p>';

  bindOpinionActions();
}

function renderComments(o) {
  if (!o.supportComments.length && !o.opposeComments.length) return '';
  return `<div class="comments">
    ${o.supportComments.length ? `<h4>지지의견 ${o.supportComments.length}</h4><ul>${o.supportComments.map((c) => `<li><span class="sup-c">+</span> <b>${esc(nameOf(c.authorId))}</b>: ${esc(c.text)}</li>`).join('')}</ul>` : ''}
    ${o.opposeComments.length ? `<h4>반대의견 ${o.opposeComments.length}</h4><ul>${o.opposeComments.map((c) => `<li><span class="opp-c">−</span> <b>${esc(nameOf(c.authorId))}</b>: ${esc(c.text)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function renderActions(o, mine) {
  return `<div class="actions">
    <button class="btn primary" data-sup="${o.id}">지지 (+의견)</button>
    <button class="btn danger" data-opp="${o.id}">반대 (+의견)</button>
    <button class="btn" data-amend="${o.id}">수정안 분기</button>
    ${mine ? `<button class="btn ghost" data-leave="${o.familyRoot}">줄 떠나기</button>` : ''}
  </div>`;
}

function bindOpinionActions() {
  document.querySelectorAll('[data-sup]').forEach((el) =>
    el.addEventListener('click', () => {
      const comment = prompt('첨부할 지지의견 (비워도 됩니다):') ?? undefined;
      if (comment === undefined) return;
      support(el.dataset.sup, comment.trim() || null).then(render);
    })
  );
  document.querySelectorAll('[data-opp]').forEach((el) =>
    el.addEventListener('click', () => {
      const comment = prompt('첨부할 반대의견 (비워도 됩니다):') ?? undefined;
      if (comment === undefined) return;
      oppose(el.dataset.opp, comment.trim() || null).then(render);
    })
  );
  document.querySelectorAll('[data-amend]').forEach((el) =>
    el.addEventListener('click', () => {
      const title = prompt('수정안 제목:');
      if (!title) return;
      mesh
        .act(currentTopic, 'AMEND', { parentId: el.dataset.amend, behind: el.dataset.amend, title, body: '' })
        .then(render);
    })
  );
  document.querySelectorAll('[data-leave]').forEach((el) =>
    el.addEventListener('click', () => mesh.act(currentTopic, 'LEAVE', { familyRoot: el.dataset.leave }).then(render))
  );
  document.querySelectorAll('[data-verdict-ok]').forEach((el) =>
    el.addEventListener('click', () => {
      const reason = prompt('승인 사유:') ?? '';
      mesh.act(currentTopic, 'VERDICT', { opinionId: el.dataset.verdictOk, approve: true, reason }).then(render);
    })
  );
  document.querySelectorAll('[data-verdict-no]').forEach((el) =>
    el.addEventListener('click', () => {
      const reason = prompt('기각 사유:') ?? '';
      mesh.act(currentTopic, 'VERDICT', { opinionId: el.dataset.verdictNo, approve: false, reason }).then(render);
    })
  );
  void selectJury; // (배심 명단은 queueState가 내부적으로 동일 추첨을 수행)
}

function renderInsight() {
  const { citizenHub } = computeInsight(node);
  const sorted = [...citizenHub.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  $('#insight-list').innerHTML =
    sorted
      .map(
        ([id, hub]) =>
          `<div class="insight-row"><span>${esc(nameOf(id))}${id === wallet.citizenId ? ' (나)' : ''}</span><b>${hub.toFixed(2)}</b></div>`
      )
      .join('') || '<p class="hint">아직 안목 기록이 없습니다.</p>';
}

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
