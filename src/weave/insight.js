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
      const joins = [...node.byHash.values()].filter((e) => e.type === 'JOIN' && e.data.opinionId === op.id);

      // DAG 간선: 항목 해시 -> 그 뒤에 선 항목들
      // 분기 증명된 시민의 링크도 구조(연결)로는 유지하되, 집계에서만 제외한다.
      const children = new Map();
      for (const j of joins) {
        for (const h of j.data.behind) {
          if (!children.has(h)) children.set(h, []);
          children.get(h).push(j);
        }
      }

      // 시민별 최초 위치: 제안자는 줄의 머리, 참여자는 가장 이른 줄서기 항목
      const position = new Map();
      if (!flagged.has(root.author)) position.set(root.author, root);
      for (const j of joins) {
        if (flagged.has(j.author)) continue;
        const cur = position.get(j.author);
        if (!cur) position.set(j.author, j);
        else if (cur !== root && j.seq < cur.seq) position.set(j.author, j);
      }

      // 내 위치의 후손(뒤에 선 사람들)을 센다 — 특허의 "이후로 링크한 상위 노드"
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
        let m = perLine.get(author);
        if (!m) perLine.set(author, (m = new Map()));
        m.set(op.id, laterAuthors.size);
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
export function authorityIndex(node, topicId) {
  const { citizenHub } = computeInsight(node);
  return queueState(node, topicId).opinions.map((op) => {
    const authority = op.standers.reduce((sum, author) => sum + 1 + (citizenHub.get(author) ?? 0), 0);
    return { ...op, authority };
  });
}
