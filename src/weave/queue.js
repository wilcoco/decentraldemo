// 지지 줄서기(Support Queue) — "지지는 그 의견 뒤에 줄을 서는 것이다"
//
// 구조
//  - 의견(PROPOSE)이 줄의 머리가 된다. 의견마다 두 개의 줄이 선다:
//    지지 줄(JOIN)과 반대 줄(OPPOSE). 두 줄 모두 같은 머리(의견 항목)에서
//    출발하는 별도의 DAG다.
//  - 줄에 서기 = "나는 이 항목(들) 뒤에 선다"를 서명하는 것. 서명이 앞사람
//    항목의 해시를 덮으므로, 줄에 서는 행위 자체가 앞사람들의 증인이 되는
//    행위다. 참여가 곧 검증이다. (지지·반대 모두 동일)
//  - 줄에 설 때 자기 의견(comment)을 첨부할 수 있다 → 지지의견/반대의견 목록.
//  - 줄의 길이 = 현재 서 있는 사람 수. 링크는 지울 수 없는 역사로 남고,
//    떠나기(LEAVE)는 길이만 줄인다. 입장은 가족당 하나(LWW).
//
// 민주주의 이론 반영 (docs/theory-review.md 의 처방들):
//  - 블라인드 초기 구간 (콩도르세: 판단의 독립성) — 공표 직후 일정 시간
//    집계를 비공개 플래그로 표시해 정보 폭포를 차단한다. 기록은 그대로
//    쌓이므로 안목 계산은 온전하다.
//  - 지속 다수 (매디슨: 순간적 격정의 여과) — '채택'은 임계값 도달이 아니라
//    "임계값을 sustainMs 동안 유지"로 정의한다. 임기제 레그와 달리 여론이
//    진짜 바뀌면 N일 뒤 반드시 반영되는 저역 필터다.
//  - 헌장 계층 (토크빌: 다수의 폭정 방어) — 상위 임계값(adopt)과 더 긴
//    유지 기간을 opts로 주입해 기본권·규칙 의제를 보호한다.
//  - 무작위 검증 배심 (피시킨·랑드모어: 동원 불가능성) — 의견 해시로
//    결정론적으로 추첨된 배심만 판정(VERDICT)할 수 있고, 배심 다수의
//    승인 없이는 채택되지 않는다 (하버마스의 숙의 관문 겸용).
//  - 위임 (다운스: 합리적 무지의 해법) — 주제 단위로 신뢰하는 시민에게
//    목소리를 위임한다. 직접 참여가 위임을 항상 우선하고, 순환은 차단되며,
//    즉시 회수된다.
import { THRESHOLDS } from '../democracy.js';
import { sha256 } from '../blockchain.js';

const QUEUE_TYPES = new Set(['PROPOSE', 'AMEND', 'JOIN', 'OPPOSE', 'LEAVE', 'DELEGATE']);
const SIDE_TYPE = { support: 'JOIN', oppose: 'OPPOSE' };

// 어떤 의견 줄(지지 또는 반대)의 현재 팁(아무도 뒤에 서지 않은 항목들)
export function tips(node, opinionId, side = 'support') {
  const opinionEntry = node.byHash.get(opinionId);
  if (!opinionEntry) return [];
  const type = SIDE_TYPE[side];
  const joins = [...node.byHash.values()].filter((e) => e.type === type && e.data.opinionId === opinionId);
  const referenced = new Set(joins.flatMap((j) => j.data.behind));
  return [opinionEntry, ...joins].filter((e) => !referenced.has(e.hash)).map((e) => e.hash);
}

// 지지 줄에 서기 (의견 첨부 가능)
export function joinLine(node, wallet, topicId, opinionId, comment = null) {
  const behind = tips(node, opinionId, 'support');
  if (!behind.length) throw new Error('알 수 없는 의견 줄입니다');
  const data = { opinionId, behind };
  if (comment) data.comment = String(comment);
  const entry = wallet.act(topicId, 'JOIN', data);
  node.ingest(entry);
  return entry;
}

// 반대 줄에 서기 (의견 첨부 가능) — 반대도 줄이다, 같은 증인 구조가 적용된다
export function opposeLine(node, wallet, topicId, opinionId, comment = null) {
  const behind = tips(node, opinionId, 'oppose');
  if (!behind.length) throw new Error('알 수 없는 의견 줄입니다');
  const data = { opinionId, behind };
  if (comment) data.comment = String(comment);
  const entry = wallet.act(topicId, 'OPPOSE', data);
  node.ingest(entry);
  return entry;
}

// 줄 떠나기: 가족(원안+수정안 전체) 어디에도 서지 않은 상태가 된다
export function leaveLine(node, wallet, topicId, familyRoot) {
  const entry = wallet.act(topicId, 'LEAVE', { familyRoot });
  node.ingest(entry);
  return entry;
}

// 분기: 부모 의견의 한 지점에서 갈라져 수정안의 새 줄을 시작한다
export function amendLine(node, wallet, topicId, parentId, { title, body = '', behind = null }) {
  const entry = wallet.act(topicId, 'AMEND', { parentId, behind: behind ?? parentId, title, body });
  node.ingest(entry);
  return entry;
}

// 주제 위임: 이 주제에서 내가 직접 서지 않은 가족의 목소리를 to에게 흘린다.
// to=null 이면 즉시 회수. 직접 참여가 항상 위임을 우선한다.
export function delegateTopic(node, wallet, topicId, to = null) {
  const entry = wallet.act(topicId, 'DELEGATE', { to });
  node.ingest(entry);
  return entry;
}

// 무작위 검증 배심: 의견 해시로 결정론적으로 추첨한다 — 누구나 같은 배심을
// 재계산해 검증할 수 있고(검증 가능한 무작위성), 어떤 조직도 자기 사람을
// 배심에 심을 수 없다 (의견이 생기기 전에는 배심을 알 수 없으므로).
export function selectJury(node, opinionId, jurySize) {
  const flagged = new Set(node.forkProofs.keys());
  const opinion = node.byHash.get(opinionId);
  const candidates = [...node.registry.keys()].filter(
    (cid) => !flagged.has(cid) && cid !== opinion?.author // 제안자는 자기 배심이 될 수 없다
  );
  candidates.sort((a, b) => {
    const ha = sha256(`${a}|${opinionId}`);
    const hb = sha256(`${b}|${opinionId}`);
    return ha < hb ? -1 : 1;
  });
  return candidates.slice(0, jurySize);
}

// 배심 판정 제출: 근거·반론을 심사한 배심원의 승인/기각 (배심원이 아니면 무시된다)
export function submitVerdict(node, wallet, topicId, opinionId, approve, reason = '') {
  const entry = wallet.act(topicId, 'VERDICT', { opinionId, approve: Boolean(approve), reason });
  node.ingest(entry);
  return entry;
}

// 줄 무결성 점검: 지지·반대 줄의 behind 참조가 실제 항목으로 해석되어야 한다.
export function lineIntegrity(node, opinionId) {
  const links = [...node.byHash.values()].filter(
    (e) => (e.type === 'JOIN' || e.type === 'OPPOSE') && e.data.opinionId === opinionId
  );
  const dangling = [];
  for (const j of links) {
    for (const h of j.data.behind) {
      if (!node.byHash.has(h)) dangling.push({ witness: j.author, missing: h });
    }
  }
  return { intact: dangling.length === 0, dangling };
}

// 주제의 줄서기 상태 — 결정적 계산 (같은 항목 집합 + 같은 opts → 같은 결과)
//
// opts (거버넌스 파라미터 — 헌장 의제는 상위 값을 주입):
//   adopt/leading  임계값 (기본: THRESHOLDS)
//   sustainMs      지속 다수 조건 — 채택 조건을 이 시간 동안 유지해야 확정
//   jurySize       0이면 배심 없음, >0이면 배심 다수 승인 없이 채택 불가
//   blindMs        블라인드 초기 구간 — 이 시간 동안 op.blind=true (표시 계층이 집계를 숨김)
//   now            현재 시각 (테스트 주입용)
export function queueState(node, topicId, opts = {}) {
  const {
    adopt = THRESHOLDS.adopt,
    leading = THRESHOLDS.leading,
    sustainMs = 0,
    jurySize = 0,
    blindMs = 0,
    now = Date.now(),
  } = opts;
  const flagged = new Set(node.forkProofs.keys());
  const entries = node
    .entriesForTopic(topicId)
    .filter((e) => QUEUE_TYPES.has(e.type) && !flagged.has(e.author))
    .sort((x, y) => (x.author < y.author ? -1 : x.author > y.author ? 1 : x.seq - y.seq));

  // ── 의견 등록: 원안(PROPOSE), 수정안(AMEND) ────────────────
  const opinions = new Map();
  for (const e of entries) {
    if (e.type === 'PROPOSE') {
      opinions.set(e.hash, {
        id: e.hash,
        parentId: null,
        familyRoot: e.hash,
        title: e.data.title,
        body: e.data.body ?? '',
        authorId: e.author,
        createdAt: e.ts,
      });
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const e of entries) {
      if (e.type !== 'AMEND' || opinions.has(e.hash)) continue;
      const parent = opinions.get(e.data.parentId);
      if (!parent) continue; // 부모 미도착 — 동기화되면 해석된다
      opinions.set(e.hash, {
        id: e.hash,
        parentId: parent.id,
        familyRoot: parent.familyRoot,
        title: e.data.title,
        body: e.data.body ?? '',
        authorId: e.author,
        createdAt: e.ts,
      });
      added = true;
    }
  }

  // ── 현재 입장 (가족당 하나, LWW) + 첨부 의견 + 주제 위임 ──
  const standing = new Map(); // familyRoot -> Map(author -> { opinionId, side, seq })
  const stand = (family, author, opinionId, side, seq) => {
    let m = standing.get(family);
    if (!m) standing.set(family, (m = new Map()));
    const cur = m.get(author);
    if (!cur || seq > cur.seq) m.set(author, { opinionId, side, seq });
  };
  const supportComments = new Map();
  const opposeComments = new Map();
  const pushComment = (map, opinionId, e) => {
    if (!e.data.comment) return;
    if (!map.has(opinionId)) map.set(opinionId, []);
    map.get(opinionId).push({ authorId: e.author, text: e.data.comment, ts: e.ts });
  };
  const delegationState = new Map(); // author -> { to, seq } (주제 단위, LWW)
  for (const e of entries) {
    if (e.type === 'PROPOSE') stand(e.hash, e.author, e.hash, 'support', e.seq);
    else if (e.type === 'AMEND' && opinions.has(e.hash)) {
      stand(opinions.get(e.hash).familyRoot, e.author, e.hash, 'support', e.seq);
    } else if (e.type === 'JOIN' && opinions.has(e.data.opinionId)) {
      stand(opinions.get(e.data.opinionId).familyRoot, e.author, e.data.opinionId, 'support', e.seq);
      pushComment(supportComments, e.data.opinionId, e);
    } else if (e.type === 'OPPOSE' && opinions.has(e.data.opinionId)) {
      stand(opinions.get(e.data.opinionId).familyRoot, e.author, e.data.opinionId, 'oppose', e.seq);
      pushComment(opposeComments, e.data.opinionId, e);
    } else if (e.type === 'LEAVE') {
      stand(e.data.familyRoot, e.author, null, null, e.seq);
    } else if (e.type === 'DELEGATE') {
      const cur = delegationState.get(e.author);
      if (!cur || e.seq > cur.seq) delegationState.set(e.author, { to: e.data.to ?? null, seq: e.seq });
    }
  }

  const standersByOpinion = new Map();
  const opposersByOpinion = new Map();
  for (const m of standing.values()) {
    for (const [author, { opinionId, side }] of m.entries()) {
      if (!opinionId) continue;
      const bucket = side === 'oppose' ? opposersByOpinion : standersByOpinion;
      if (!bucket.has(opinionId)) bucket.set(opinionId, []);
      bucket.get(opinionId).push(author);
    }
  }
  for (const list of standersByOpinion.values()) list.sort();
  for (const list of opposersByOpinion.values()) list.sort();

  // ── 위임 해석 (다운스): 가족에 직접 서지 않은 시민의 표는 위임 사슬을
  // 따라 흐르고, 사슬 끝이 그 가족에 서 있는 시민이면 그의 입장에 +1 ──
  const delegated = new Map(); // opinionId -> { support, oppose }
  for (const [family, m] of standing) {
    for (const citizenId of node.registry.keys()) {
      if (flagged.has(citizenId)) continue;
      const own = m.get(citizenId);
      if (own && own.opinionId) continue; // 직접 참여가 위임을 우선한다
      let current = citizenId;
      const visited = new Set([current]);
      let terminal = null;
      while (true) {
        const next = delegationState.get(current)?.to;
        if (!next || visited.has(next)) break; // 회수됨 또는 순환 — 표는 흐르지 않는다
        visited.add(next);
        current = next;
        const pos = m.get(current);
        if (pos && pos.opinionId) {
          terminal = pos;
          break;
        }
      }
      if (terminal) {
        if (!delegated.has(terminal.opinionId)) delegated.set(terminal.opinionId, { support: 0, oppose: 0 });
        delegated.get(terminal.opinionId)[terminal.side === 'oppose' ? 'oppose' : 'support'] += 1;
      }
    }
    void family;
  }

  // ── 배심 (검증 가능한 추첨) + 판정 집계 ────────────────────
  const juryByOpinion = new Map(); // opinionId -> { members, approve, reject, verdicts }
  if (jurySize > 0) {
    const verdictEntries = node
      .entriesForTopic(topicId)
      .filter((e) => e.type === 'VERDICT' && !flagged.has(e.author) && opinions.has(e.data.opinionId));
    for (const opinionId of opinions.keys()) {
      const members = selectJury(node, opinionId, jurySize);
      const memberSet = new Set(members);
      const latest = new Map(); // 배심원별 최신 판정 (LWW)
      for (const e of verdictEntries) {
        if (e.data.opinionId !== opinionId) continue;
        if (!memberSet.has(e.author)) continue; // 배심원이 아닌 판정은 무시
        const cur = latest.get(e.author);
        if (!cur || e.seq > cur.seq) latest.set(e.author, e);
      }
      let approve = 0;
      let reject = 0;
      const verdicts = [];
      for (const e of latest.values()) {
        if (e.data.approve) approve += 1;
        else reject += 1;
        verdicts.push({ authorId: e.author, approve: e.data.approve, reason: e.data.reason ?? '' });
      }
      juryByOpinion.set(opinionId, { members, approve, reject, verdicts });
    }
  }

  // ── 지속 다수 (매디슨): 채택 조건이 언제부터 연속으로 성립했는가 ──
  // 서명된 타임스탬프 순으로 입장 변화를 재생하며, 각 의견의
  // (직접 지지/반대) 조건 성립 시점을 추적한다. 결정적 계산.
  const total = Math.max(node.registry.size, 1);
  const metSince = new Map(); // opinionId -> ts | null
  if (sustainMs > 0) {
    const chrono = entries
      .filter((e) => ['PROPOSE', 'AMEND', 'JOIN', 'OPPOSE', 'LEAVE'].includes(e.type))
      .sort((x, y) => x.ts - y.ts || (x.author < y.author ? -1 : 1) || x.seq - y.seq);
    const replay = new Map(); // family -> Map(author -> {opinionId, side, seq})
    const counts = new Map(); // opinionId -> { sup, opp }
    const cnt = (id) => {
      if (!counts.has(id)) counts.set(id, { sup: 0, opp: 0 });
      return counts.get(id);
    };
    const evalCond = (id, ts) => {
      const c = cnt(id);
      const ok = c.sup / total >= adopt && c.sup > c.opp;
      if (ok && metSince.get(id) == null) metSince.set(id, ts);
      if (!ok) metSince.set(id, null);
    };
    for (const e of chrono) {
      let family = null;
      let newPos = null;
      if (e.type === 'PROPOSE') {
        family = e.hash;
        newPos = { opinionId: e.hash, side: 'support', seq: e.seq };
      } else if (e.type === 'AMEND' && opinions.has(e.hash)) {
        family = opinions.get(e.hash).familyRoot;
        newPos = { opinionId: e.hash, side: 'support', seq: e.seq };
      } else if ((e.type === 'JOIN' || e.type === 'OPPOSE') && opinions.has(e.data.opinionId)) {
        family = opinions.get(e.data.opinionId).familyRoot;
        newPos = { opinionId: e.data.opinionId, side: e.type === 'OPPOSE' ? 'oppose' : 'support', seq: e.seq };
      } else if (e.type === 'LEAVE') {
        family = e.data.familyRoot;
        newPos = { opinionId: null, side: null, seq: e.seq };
      }
      if (!family) continue;
      let m = replay.get(family);
      if (!m) replay.set(family, (m = new Map()));
      const old = m.get(e.author);
      if (old && old.seq >= newPos.seq) continue; // 늦게 도착한 과거 행위
      if (old?.opinionId) {
        cnt(old.opinionId)[old.side === 'oppose' ? 'opp' : 'sup'] -= 1;
        evalCond(old.opinionId, e.ts);
      }
      m.set(e.author, newPos);
      if (newPos.opinionId) {
        cnt(newPos.opinionId)[newPos.side === 'oppose' ? 'opp' : 'sup'] += 1;
        evalCond(newPos.opinionId, e.ts);
      }
    }
  }

  // ── 지위 판정 ──────────────────────────────────────────────
  return {
    opinions: [...opinions.values()]
      .map((o) => {
        const standers = standersByOpinion.get(o.id) ?? [];
        const opposers = opposersByOpinion.get(o.id) ?? [];
        const d = delegated.get(o.id) ?? { support: 0, oppose: 0 };
        const weight = standers.length + d.support;
        const against = opposers.length + d.oppose;
        const ratio = weight / total;
        const jury = juryByOpinion.get(o.id) ?? null;

        let status;
        if (against > weight) status = '반대 우세';
        else if (ratio >= adopt && weight > against) {
          if (jury && jury.reject > jurySize / 2) status = '배심 기각';
          else if (jury && jury.approve <= jurySize / 2) status = '배심 심사 중';
          else if (sustainMs > 0) {
            const since = metSince.get(o.id);
            status = since != null && now - since >= sustainMs ? '채택' : '채택 대기';
          } else status = '채택';
        } else if (ratio >= leading && weight > against) status = '우세';
        else if (against > 0) status = '경합';
        else status = '제안됨';

        return {
          ...o,
          standers,
          opposers,
          weight,
          against,
          delegatedSupport: d.support,
          delegatedOppose: d.oppose,
          ratio,
          status,
          blind: blindMs > 0 && now - o.createdAt < blindMs, // 표시 계층: 집계 숨김 신호
          metSince: metSince.get(o.id) ?? null,
          jury,
          supportComments: supportComments.get(o.id) ?? [],
          opposeComments: opposeComments.get(o.id) ?? [],
        };
      })
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)),
    flagged: [...flagged],
  };
}
