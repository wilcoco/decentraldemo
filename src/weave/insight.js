// 안목 지수(Insight/Hub Index) — 링크 순서 기반 실시간 평가 계층
//
// 근거 특허 (발명자 홍정수, 2005-04-14 출원):
//  - 등록특허 10-0913256: 다중 링크를 형성하는 정보 네트워크에서 링크 관계에
//    따른 대상 평가 방법. 상위 노드(평가자)의 허브 지수는 같은 하위 노드에
//    "이후로 링크한" 다른 상위 노드에 따라 결정되고(청구항 1·2), 하위 노드의
//    권위 지수는 링크한 상위 노드들의 허브 지수 합이며(수학식 10), 복수 대상에
//    대한 허브 지수는 평균으로 산출한다(청구항 8). 반복 수렴 연산이 필요 없어
//    실시간 갱신이 가능하다.
//  - 등록특허 10-0952391: 위 방법의 시스템 구현(평가 순서에 따른 허브/권위
//    지수 산출, 권위 지수에 따른 노출 조정, 허브 지수에 따른 편집 영향력).
//
// 줄서기 구조와의 결합:
//  특허의 "링크 순서"는 서버 타임스탬프에 의존했지만, 줄서기 DAG에서는 순서가
//  서명 사슬 자체로 증명된다 — 뒤에 선 사람의 서명이 앞사람 항목의 해시를
//  덮으므로, "내가 먼저 섰다"는 주장은 위조할 수 없는 사실이 된다.
//  즉 특허의 허브 지수가 암호학적으로 검증 가능한 형태로 구현된다.
//
//  - 안목 지수(줄별)  = 내 뒤에 선 사람 수 (DAG에서 내 항목의 후손 작성자 수)
//  - 시민 안목 지수   = 참여한 줄들의 안목 지수 평균 (특허 청구항 8)
//    → 아무도 따라 서지 않는 줄에 무분별하게 서면 평균이 깎인다 (자기 조절)
//  - 의견 권위 지수   = 현재 서 있는 시민들의 (1 + 안목 지수) 합
//    특허 수학식 10(권위 = 허브 합)의 민주주의 적용: 모든 시민의 목소리는
//    기본 1이고, 안목이 검증된 시민의 지지가 가중을 더한다.
import { queueState } from './queue.js';

// 주제들의 모든 줄에서 시민별 안목 지수를 계산한다.
// 결정적 계산 — 같은 항목 집합이면 어느 노드가 계산해도 동일하다.
export function computeInsight(node, topicIds) {
  const topics = topicIds ?? [...node.interests];
  const flagged = new Set(node.forkProofs.keys());
  const perLine = new Map(); // author -> Map(opinionId -> 뒤에 선 사람 수)

  for (const topicId of topics) {
    for (const op of queueState(node, topicId).opinions) {
      const root = node.byHash.get(op.id);
      if (!root) continue;
      // 지지 줄과 반대 줄은 별도의 DAG — 안목은 양쪽 모두에서 쌓인다.
      // (나중에 반대가 몰릴 의견을 일찍 반대한 것도 안목이다)
      //
      // 헛발질 감점: 내가 선 쪽이 반대쪽보다 열세면 그 격차만큼 줄 점수에서
      // 깎인다 (진 쪽에 서 있는 동안만). 지위와 마찬가지로 저장되지 않고 매번
      // 재계산되므로, 여론이 회복되면 감점도 사라진다 — 레그 없음 원칙.
      // 단순 경합(비등한 찬반)은 벌점이 아니다: "명백히 진 쪽"의 격차만 깎는다.
      const losingMargin = {
        support: Math.max(0, op.against - op.weight),
        oppose: Math.max(0, op.weight - op.against),
      };
      for (const [side, type] of [['support', 'JOIN'], ['oppose', 'OPPOSE']]) {
        const joins = [...node.byHash.values()].filter((e) => e.type === type && e.data.opinionId === op.id);
        if (side === 'oppose' && joins.length === 0) continue;
        const lineKey = side === 'support' ? op.id : `${op.id}#반대`;

        // DAG 간선: 항목 해시 -> 그 뒤에 선 항목들
        // 분기 증명된 시민의 링크도 구조(연결)로는 유지하되, 집계에서만 제외한다.
        const children = new Map();
        for (const j of joins) {
          for (const h of j.data.behind) {
            if (!children.has(h)) children.set(h, []);
            children.get(h).push(j);
          }
        }

        // 시민별 최초 위치: 제안자는 지지 줄의 머리, 참여자는 가장 이른 줄서기 항목
        const position = new Map();
        if (side === 'support' && !flagged.has(root.author)) position.set(root.author, root);
        for (const j of joins) {
          if (flagged.has(j.author)) continue;
          const cur = position.get(j.author);
          if (!cur) position.set(j.author, j);
          else if (cur !== root && j.seq < cur.seq) position.set(j.author, j);
        }

        // 내 위치의 후손(뒤에 선 사람들)을 센다 — 특허의 "이후로 링크한 상위 노드"
        const currentSide = new Set(side === 'support' ? op.standers : op.opposers);
        for (const [author, entry] of position) {
          const seen = new Set([entry.hash]);
          const stack = [entry.hash];
          const laterAuthors = new Set();
          while (stack.length) {
            const h = stack.pop();
            for (const child of children.get(h) ?? []) {
              if (seen.has(child.hash)) continue;
              seen.add(child.hash);
              stack.push(child.hash);
              if (child.author !== author && !flagged.has(child.author)) laterAuthors.add(child.author);
            }
          }
          // 감점은 "지금도 진 쪽에 서 있는" 시민에게만 적용된다.
          // 판단을 철회하고 줄을 떠나면(LEAVE) 감점도 사라진다 — 획득한
          // 후손 점수(역사)는 남는다.
          const penalty = currentSide.has(author) ? losingMargin[side] : 0;
          let m = perLine.get(author);
          if (!m) perLine.set(author, (m = new Map()));
          m.set(lineKey, laterAuthors.size - penalty);
        }
      }
    }
  }

  // 시민 안목 지수 = 참여한 줄들의 평균 (특허 청구항 8, 수학식 11)
  const citizenHub = new Map();
  for (const [author, m] of perLine) {
    const scores = [...m.values()];
    citizenHub.set(author, scores.reduce((a, b) => a + b, 0) / scores.length);
  }
  return { perLine, citizenHub };
}

// 의견 권위 지수: 현재 줄에 서 있는 시민들의 (1 + 안목 지수) 합.
// 같은 길이의 줄이라도 안목이 검증된 시민들이 선 줄의 권위가 높다.
// 반대 줄에도 같은 계산을 적용한다(authorityAgainst) — 몇 명이 반대하는가만이
// 아니라 "어떤 안목의 시민들이 반대하는가"가 함께 보인다.
export function authorityIndex(node, topicId) {
  const { citizenHub } = computeInsight(node);
  // 기본 1표는 불가침(1인 1목소리) — 안목이 음수여도 목소리가 1 아래로
  // 깎이지는 않는다. 음수 안목은 가중 보너스가 없다는 뜻일 뿐이다.
  const sum = (authors) => authors.reduce((acc, author) => acc + 1 + Math.max(0, citizenHub.get(author) ?? 0), 0);
  return queueState(node, topicId).opinions.map((op) => ({
    ...op,
    authority: sum(op.standers),
    authorityAgainst: sum(op.opposers),
  }));
}
