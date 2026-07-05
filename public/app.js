// 아고라 라이브 프런트엔드
// /api/state 를 SSE 이벤트마다 다시 그려 "매 순간의 여론"을 그대로 보여준다.
let state = null;
let me = localStorage.getItem('agora-citizen') || null;
let selectedIssueId = null;
let simRunning = false;

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error ?? '요청 실패');
    throw new Error(data.error);
  }
  return data;
}

async function refresh() {
  state = await api('/api/state');
  if (!selectedIssueId && state.issues.length) selectedIssueId = state.issues[0].id;
  if (me && !state.citizens.some((c) => c.id === me)) me = null;
  render();
}

const STATUS_CLASS = { 채택: 'adopted', 우세: 'leading', 검증중: 'reviewing', 반박됨: 'contested', 제안됨: 'proposed' };

function render() {
  renderHeader();
  renderIssues();
  renderOpinions();
  renderDelegations();
  renderChain();
}

function renderHeader() {
  const pill = $('#chain-status');
  pill.textContent = state.chain.valid
    ? `체인 정상 · 블록 ${state.chain.length}개`
    : `체인 오염: ${state.chain.reason}`;
  pill.className = `pill ${state.chain.valid ? 'ok' : 'bad'}`;

  $('#sim-toggle').textContent = simRunning ? '시뮬레이션 정지' : '시뮬레이션 시작';

  const select = $('#citizen-select');
  select.innerHTML =
    '<option value="">— 시민 선택 —</option>' +
    state.citizens.map((c) => `<option value="${c.id}" ${c.id === me ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function renderIssues() {
  const byDomain = new Map();
  for (const issue of state.issues) {
    if (!byDomain.has(issue.domain)) byDomain.set(issue.domain, []);
    byDomain.get(issue.domain).push(issue);
  }
  $('#issues-list').innerHTML = [...byDomain.entries()]
    .map(
      ([domain, issues]) => `
      <div class="domain-group">
        <h3>${esc(domain)}</h3>
        ${issues
          .map((i) => {
            const top = i.opinions[0];
            return `
            <button class="issue-item ${i.id === selectedIssueId ? 'selected' : ''}" data-issue="${i.id}">
              <span class="issue-title">${esc(i.title)}</span>
              <span class="issue-meta">의견 ${i.opinions.length}개${top ? ` · 최다 지지 ${(top.ratio * 100).toFixed(0)}%` : ''}</span>
            </button>`;
          })
          .join('')}
      </div>`
    )
    .join('');
  document.querySelectorAll('.issue-item').forEach((el) =>
    el.addEventListener('click', () => {
      selectedIssueId = el.dataset.issue;
      render();
    })
  );
}

function renderOpinions() {
  const issue = state.issues.find((i) => i.id === selectedIssueId);
  if (!issue) {
    $('#issue-header').innerHTML = '';
    $('#opinions-list').innerHTML = '<p class="hint">의제를 선택하세요.</p>';
    return;
  }
  $('#issue-header').innerHTML = `
    <h2>${esc(issue.title)} <span class="domain-tag">${esc(issue.domain)}</span></h2>
    <p class="hint">${esc(issue.description)}</p>`;

  $('#opinions-list').innerHTML = issue.opinions
    .map((o) => {
      const supporting = me && o.supporters.includes(me);
      const pct = Math.min(o.ratio * 100, 100);
      return `
      <article class="card opinion">
        <div class="opinion-head">
          <span class="status ${STATUS_CLASS[o.status] ?? ''}">${o.status}</span>
          <h3>${esc(o.title)}</h3>
        </div>
        <p class="author">제안: ${esc(o.authorName)}</p>
        ${o.body ? `<p class="body">${esc(o.body)}</p>` : ''}
        <div class="support-bar"><div class="support-fill ${STATUS_CLASS[o.status] ?? ''}" style="width:${pct}%"></div></div>
        <p class="support-meta">유효 지지 가중치 ${o.weight} (전체 시민의 ${(o.ratio * 100).toFixed(1)}%) · 근거 ${o.evidences.length} · 반론 ${o.challenges.length}</p>
        <div class="actions">
          <button class="btn ${supporting ? 'danger' : 'primary'}" data-act="support" data-id="${o.id}" data-on="${!supporting}">
            ${supporting ? '지지 철회' : '지지'}
          </button>
          <button class="btn" data-act="evidence" data-id="${o.id}">근거 추가</button>
          <button class="btn" data-act="challenge" data-id="${o.id}">반론 제기</button>
          <button class="btn ghost" data-act="detail" data-id="${o.id}">검증 내역</button>
        </div>
        <div class="detail hidden" id="detail-${o.id}">
          ${
            o.evidences.length
              ? `<h4>근거</h4><ul>${o.evidences.map((e) => `<li><b>${esc(e.authorName)}</b>: ${esc(e.text)}${e.url ? ` <a href="${esc(e.url)}" target="_blank">[출처]</a>` : ''}</li>`).join('')}</ul>`
              : ''
          }
          ${
            o.challenges.length
              ? `<h4>반론</h4><ul>${o.challenges.map((c) => `<li><b>${esc(c.authorName)}</b>: ${esc(c.text)}</li>`).join('')}</ul>`
              : ''
          }
          ${!o.evidences.length && !o.challenges.length ? '<p class="hint">아직 검증 활동이 없습니다.</p>' : ''}
        </div>
      </article>`;
    })
    .join('') || '<p class="hint">아직 의견이 없습니다. 첫 의견을 제안해 보세요.</p>';

  document.querySelectorAll('#opinions-list [data-act]').forEach((el) =>
    el.addEventListener('click', async () => {
      const { act, id, on } = el.dataset;
      if (act === 'detail') {
        $(`#detail-${id}`).classList.toggle('hidden');
        return;
      }
      if (!me) return alert('먼저 시민을 선택하거나 등록하세요.');
      if (act === 'support') await api('/api/support', 'POST', { citizenId: me, opinionId: id, on: on === 'true' });
      if (act === 'evidence') {
        const text = prompt('근거 내용을 입력하세요:');
        if (text) await api('/api/evidence', 'POST', { citizenId: me, opinionId: id, text });
      }
      if (act === 'challenge') {
        const text = prompt('반론 내용을 입력하세요:');
        if (text) await api('/api/challenge', 'POST', { citizenId: me, opinionId: id, text });
      }
    })
  );
}

function renderDelegations() {
  const container = $('#delegation-list');
  if (!me) {
    container.innerHTML = '<p class="hint">시민을 선택하면 분야별 위임을 관리할 수 있습니다.</p>';
    return;
  }
  const myDelegations = state.delegations[me] ?? {};
  container.innerHTML = state.domains
    .map((domain) => {
      const options = state.citizens
        .filter((c) => c.id !== me)
        .map((c) => `<option value="${c.id}" ${myDelegations[domain] === c.id ? 'selected' : ''}>${esc(c.name)}</option>`)
        .join('');
      return `
      <div class="delegation-row">
        <label>${esc(domain)}</label>
        <select data-domain="${esc(domain)}">
          <option value="">직접 참여</option>
          ${options}
        </select>
      </div>`;
    })
    .join('');
  container.querySelectorAll('select').forEach((el) =>
    el.addEventListener('change', () =>
      api('/api/delegate', 'POST', { citizenId: me, domain: el.dataset.domain, delegateId: el.value || null })
    )
  );
}

async function renderChain() {
  const { blocks } = await api('/api/chain');
  const nameOf = (id) => state.citizens.find((c) => c.id === id)?.name ?? id;
  const LABEL = {
    GENESIS: '제네시스',
    REGISTER: '시민 등록',
    PROPOSE: '의견 제안',
    SUPPORT: '지지',
    WITHDRAW_SUPPORT: '지지 철회',
    DELEGATE: '위임',
    REVOKE_DELEGATION: '위임 회수',
    EVIDENCE: '근거 제출',
    CHALLENGE: '반론 제기',
  };
  $('#chain-list').innerHTML = blocks
    .slice(-8)
    .reverse()
    .map((b) => {
      const tx = b.transactions[0];
      return `
      <div class="block">
        <div class="block-head">#${b.index} <code>${b.hash.slice(0, 12)}…</code></div>
        <div class="block-body">${LABEL[tx.type] ?? tx.type} — ${esc(nameOf(tx.actor))}
          <span class="time">${new Date(tx.timestamp).toLocaleTimeString('ko-KR')}</span>
        </div>
      </div>`;
    })
    .join('');
}

// ── 이벤트 바인딩 ────────────────────────────────────────────
$('#citizen-select').addEventListener('change', (e) => {
  me = e.target.value || null;
  if (me) localStorage.setItem('agora-citizen', me);
  else localStorage.removeItem('agora-citizen');
  render();
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#register-name').value.trim();
  if (!name) return;
  const c = await api('/api/citizens', 'POST', { name });
  me = c.id;
  localStorage.setItem('agora-citizen', me);
  $('#register-name').value = '';
  await refresh();
});

$('#propose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!me) return alert('먼저 시민을 선택하거나 등록하세요.');
  if (!selectedIssueId) return alert('의제를 선택하세요.');
  const title = $('#propose-title').value.trim();
  if (!title) return;
  await api('/api/opinions', 'POST', {
    citizenId: me,
    issueId: selectedIssueId,
    title,
    body: $('#propose-body').value.trim(),
  });
  $('#propose-title').value = '';
  $('#propose-body').value = '';
});

$('#sim-toggle').addEventListener('click', async () => {
  const { running } = await api('/api/simulation', 'POST', { on: !simRunning });
  simRunning = running;
  renderHeader();
});

// ── 실시간 스트림 ────────────────────────────────────────────
const events = new EventSource('/api/events');
events.addEventListener('update', refresh);

(async () => {
  simRunning = (await api('/api/simulation')).running;
  await refresh();
})();
