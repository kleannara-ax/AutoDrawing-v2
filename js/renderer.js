/* ============================================================
   renderer.js
   Structured JSON → SVG 렌더러 — 기계도면 전용

   지원 요소:
   - outline    (외형선 — 흰색 실선)
   - centerline (중심선 — 빨간색 1점쇄선)
   - hiddenline (숨은선 — 초록색 파선)
   - hole       (구멍/탭)
   - slot       (슬롯/장공)
   - hatch      (해칭 단면)
   - dimension  (치수 — 파란색)
   - text       (텍스트)

   v5 렌더링 정책:
   - geometry (outline, centerline, hatch)
       → confirmed: 정상 실선 100%
       → estimated: 점선 + 70% 불투명 (형상은 보존)
       → uncertain: 약한 점선 + 40%
   - annotation placeholder (_isPlaceholder = true)
       → 흐린 점선 + 밑줄 + "📝" 아이콘
       → 더블클릭 시 편집 가능 표시
   - null/미태깅 → 정상 렌더링 (하위 호환)
   ============================================================ */

const Renderer = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let svg, drawingLayer;
  let groups = {};

  function init(svgElement) {
    svg = svgElement;
    // svg.getElementById may not work in all contexts; fallback to querySelector
    drawingLayer = svg.getElementById('drawingLayer') 
                || svg.querySelector('#drawingLayer')
                || document.getElementById('drawingLayer');
    ensureDefs();
    ensureGroups();
  }

  /**
   * <defs> 및 필수 마커 보장
   */
  function ensureDefs() {
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = createSvgElement('defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    // Arrow markers for dimensions
    // ★ 화살머리 크기: 4px (기존 8px viewBox 대비 약 20% 축소)
    //   markerUnits="userSpaceOnUse" → 스트로크 두께 무관하게 절대 크기 적용
    //   작은 치수를 표현할 때 화살머리가 치수선을 덮지 않도록 축소
    //   기존 마커를 강제 제거하여 캐시/재사용 문제 방지
    const oldStart = defs.querySelector('#arrowStart');
    const oldEnd = defs.querySelector('#arrowEnd');
    if (oldStart) oldStart.remove();
    if (oldEnd) oldEnd.remove();

    // 화살 크기 상수 (px, 절대값)
    const AW = 4;   // arrow width
    const AH = 3;   // arrow height

    const mkStart = createSvgElement('marker');
    mkStart.id = 'arrowStart';
    mkStart.setAttribute('markerWidth', String(AW));
    mkStart.setAttribute('markerHeight', String(AH));
    mkStart.setAttribute('refX', '0');
    mkStart.setAttribute('refY', String(AH / 2));
    mkStart.setAttribute('orient', 'auto');
    mkStart.setAttribute('markerUnits', 'userSpaceOnUse');
    const pathStart = createSvgElement('path');
    pathStart.setAttribute('d', `M ${AW} 0 L 0 ${AH/2} L ${AW} ${AH}`);
    pathStart.setAttribute('fill', '#60a5fa');
    pathStart.setAttribute('stroke', 'none');
    mkStart.appendChild(pathStart);
    defs.appendChild(mkStart);

    const mkEnd = createSvgElement('marker');
    mkEnd.id = 'arrowEnd';
    mkEnd.setAttribute('markerWidth', String(AW));
    mkEnd.setAttribute('markerHeight', String(AH));
    mkEnd.setAttribute('refX', String(AW));
    mkEnd.setAttribute('refY', String(AH / 2));
    mkEnd.setAttribute('orient', 'auto');
    mkEnd.setAttribute('markerUnits', 'userSpaceOnUse');
    const pathEnd = createSvgElement('path');
    pathEnd.setAttribute('d', `M 0 0 L ${AW} ${AH/2} L 0 ${AH}`);
    pathEnd.setAttribute('fill', '#60a5fa');
    pathEnd.setAttribute('stroke', 'none');
    mkEnd.appendChild(pathEnd);
    defs.appendChild(mkEnd);
  }

  /**
   * drawingLayer 하위에 필요한 그룹 생성
   */
  function ensureGroups() {
    // v5.8 레이어 순서: 숨은선은 외형선 위에 그려져야 보임
    // SVG에서 뒤에 있는 요소가 앞(위)에 렌더링됨
    // hatching → outlines → hiddenlines (숨은선이 외형선 위에)
    const layerOrder = [
      'hatching', 'outlines', 'hiddenlines', 'centerlines',
      'holes', 'slots', 'dimensions', 'texts', 'titleblocks', 'selection'
    ];

    layerOrder.forEach(name => {
      let g = drawingLayer.querySelector(`#${name}Group`);
      if (!g) {
        g = document.createElementNS(NS, 'g');
        g.id = `${name}Group`;
      }
      // 항상 순서대로 appendChild → 이미 존재하는 그룹도 올바른 순서로 재배치
      drawingLayer.appendChild(g);
      groups[name] = g;
    });
  }

  // ========== Clear ==========
  function clearAll() {
    Object.values(groups).forEach(g => { if (g) g.innerHTML = ''; });
  }

  function clearSelection() {
    if (groups.selection) groups.selection.innerHTML = '';
  }

  // ========== Render Full Document ==========
  function render(doc) {
    clearAll();
    ensureGroups();
    if (!doc || !doc.elements) return;
    doc.elements.forEach(el => {
      if (doc.layers[el.layer] && !doc.layers[el.layer].visible) return;
      try {
        renderElement(el);
      } catch(e) {
        console.warn(`[Renderer] renderElement failed for ${el.type}/${el.id}: ${e.message}`);
      }
    });
    updateLayerCounts(doc);
  }

  // ========== Render Single Element ==========
  function renderElement(el) {
    const group = groups[el.layer];
    if (!group) return;

    const existing = group.querySelector(`[data-id="${el.id}"]`);
    if (existing) existing.remove();

    let svgEl;
    switch (el.type) {
      case 'outline':    svgEl = renderOutline(el); break;
      case 'centerline': svgEl = renderCenterline(el); break;
      case 'hiddenline': svgEl = renderHiddenLine(el); break;
      case 'hole':       svgEl = renderHole(el); break;
      case 'slot':       svgEl = renderSlot(el); break;
      case 'hatch':      svgEl = renderHatch(el); break;
      case 'dimension':  svgEl = renderDimension(el); break;
      case 'text':       svgEl = renderText(el); break;
      case 'titleblock': svgEl = renderTitleBlock(el); break;
      case 'noteblock':  svgEl = renderNoteBlock(el); break;
      case 'paperBg':    svgEl = renderPaperBg(el); break;
    }

    if (svgEl) {
      svgEl.setAttribute('data-id', el.id);
      svgEl.setAttribute('data-type', el.type);
      svgEl.classList.add('drawing-element');

      // ── v5: placeholder 우선, 그 다음 confidence ──
      if (el._isPlaceholder) {
        applyPlaceholderStyle(svgEl, el);
      } else {
        applyConfidenceStyle(svgEl, el);
      }

      group.appendChild(svgEl);
    }
  }

  // ========== Paper Background (용지 배경) ==========
  function renderPaperBg(el) {
    const g = createSvgElement('g');
    const rect = createSvgElement('rect');
    rect.setAttribute('x', el.x);
    rect.setAttribute('y', el.y);
    rect.setAttribute('width', el.width);
    rect.setAttribute('height', el.height);
    rect.setAttribute('fill', el.fill || '#ffffff');
    rect.setAttribute('stroke', el.stroke || '#000000');
    rect.setAttribute('stroke-width', el.strokeWidth || 0.5);
    g.appendChild(rect);
    return g;
  }

  // ========== Outline (외형선) ==========
  function renderOutline(el) {
    const g = createSvgElement('g');

    // ── _arc가 있으면 SVG arc path로 렌더링 (직선 대신 원호) ──
    if (el._arc && el._arc.r > 0) {
      const arc = el._arc;
      const path = createSvgElement('path');
      const r = arc.r;
      // sweep 방향: _arc.sweep가 명시되어 있으면 사용, 아니면 외적 부호로 자동 결정
      let sweep;
      if (arc.sweep !== undefined) {
        sweep = arc.sweep;
      } else {
        const dx1 = el.x1 - arc.cx, dy1 = el.y1 - arc.cy;
        const dx2 = el.x2 - arc.cx, dy2 = el.y2 - arc.cy;
        const cross = dx1 * dy2 - dy1 * dx2;
        sweep = cross > 0 ? 0 : 1;
      }
      const d = `M ${el.x1} ${el.y1} A ${r} ${r} 0 0 ${sweep} ${el.x2} ${el.y2}`;
      path.setAttribute('d', d);
      path.setAttribute('stroke', el.color || '#000000');
      path.setAttribute('stroke-width', el.thickness || 2);
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('fill', 'none');
      g.appendChild(path);

      // 히트 영역 (arc path)
      const hit = createSvgElement('path');
      hit.setAttribute('d', d);
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', Math.max((el.thickness || 2) + 8, 12));
      hit.setAttribute('fill', 'none');
      hit.style.cursor = 'pointer';
      g.appendChild(hit);

      return g;
    }

    const line = createSvgElement('line');
    line.setAttribute('x1', el.x1);
    line.setAttribute('y1', el.y1);
    line.setAttribute('x2', el.x2);
    line.setAttribute('y2', el.y2);
    line.setAttribute('stroke', el.color || '#000000');
    line.setAttribute('stroke-width', el.thickness || 2);
    line.setAttribute('stroke-linecap', 'round');

    // visible edge / shoulder edge 태깅 (data 속성)
    if (el._edgeType) {
      g.setAttribute('data-edge-type', el._edgeType);
      // visible edge: 동일한 실선이지만 미세하게 구분 가능하도록 색상 힌트
      if (el._edgeType === 'visible') {
        line.setAttribute('stroke', el.color || '#000000'); // visible edge도 검정색 실선
      }
    }

    // v5.9: leader line with arrow (지시선 — TAP 등 주석에 사용)
    if (el._leaderArrow) {
      line.setAttribute('marker-end', 'url(#arrowEnd)');
    }

    g.appendChild(line);

    // 히트 영역
    const hit = createSvgElement('line');
    hit.setAttribute('x1', el.x1);
    hit.setAttribute('y1', el.y1);
    hit.setAttribute('x2', el.x2);
    hit.setAttribute('y2', el.y2);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', Math.max((el.thickness || 2) + 8, 12));
    hit.style.cursor = 'pointer';
    g.appendChild(hit);

    return g;
  }

  // ========== Centerline (중심선 — 일점쇄선) ==========
  function renderCenterline(el) {
    const g = createSvgElement('g');
    const line = createSvgElement('line');
    line.setAttribute('x1', el.x1);
    line.setAttribute('y1', el.y1);
    line.setAttribute('x2', el.x2);
    line.setAttribute('y2', el.y2);
    line.setAttribute('stroke', el.color || '#f87171');
    line.setAttribute('stroke-width', el.thickness || 0.8);
    // 일점쇄선: 긴 대시 — 짧은 갭 — 점 — 짧은 갭
    line.setAttribute('stroke-dasharray', '12 3 2 3');
    line.setAttribute('stroke-linecap', 'round');
    g.appendChild(line);

    // 히트 영역
    const hit = createSvgElement('line');
    hit.setAttribute('x1', el.x1);
    hit.setAttribute('y1', el.y1);
    hit.setAttribute('x2', el.x2);
    hit.setAttribute('y2', el.y2);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', 12);
    hit.style.cursor = 'pointer';
    g.appendChild(hit);

    return g;
  }

  // ========== Hidden Line (숨은선 — 파선, 초록색) ==========
  function renderHiddenLine(el) {
    const g = createSvgElement('g');
    const line = createSvgElement('line');
    line.setAttribute('x1', el.x1);
    line.setAttribute('y1', el.y1);
    line.setAttribute('x2', el.x2);
    line.setAttribute('y2', el.y2);
    line.setAttribute('stroke', el.color || '#4ade80');
    line.setAttribute('stroke-width', (el.thickness || 1) * 0.49);
    // 파선 (점선): 짧은 대시-갭 패턴 (현재의 70% 추가 축소)
    line.setAttribute('stroke-dasharray', '3 1.5');
    line.setAttribute('stroke-linecap', 'round');
    g.appendChild(line);

    // 히트 영역
    const hit = createSvgElement('line');
    hit.setAttribute('x1', el.x1);
    hit.setAttribute('y1', el.y1);
    hit.setAttribute('x2', el.x2);
    hit.setAttribute('y2', el.y2);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', 12);
    hit.style.cursor = 'pointer';
    g.appendChild(hit);

    return g;
  }

  // ========== Hole/Tap (구멍) ==========
  function renderHole(el) {
    const g = createSvgElement('g');
    const r = el.diameter / 2;

    // 원
    const circle = createSvgElement('circle');
    circle.setAttribute('cx', el.cx);
    circle.setAttribute('cy', el.cy);
    circle.setAttribute('r', r);
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', el.color || '#a78bfa');
    circle.setAttribute('stroke-width', 1.5);

    if (el.holeType === 'tap') {
      circle.setAttribute('stroke-dasharray', '1.5 1.0');
    }
    g.appendChild(circle);

    // 십자 표시 (중심점)
    const cx = el.cx, cy = el.cy;
    const cm = r * 0.4;
    const crossH = createSvgElement('line');
    crossH.setAttribute('x1', cx - cm); crossH.setAttribute('y1', cy);
    crossH.setAttribute('x2', cx + cm); crossH.setAttribute('y2', cy);
    crossH.setAttribute('stroke', el.color || '#a78bfa');
    crossH.setAttribute('stroke-width', 0.5);
    g.appendChild(crossH);

    const crossV = createSvgElement('line');
    crossV.setAttribute('x1', cx); crossV.setAttribute('y1', cy - cm);
    crossV.setAttribute('x2', cx); crossV.setAttribute('y2', cy + cm);
    crossV.setAttribute('stroke', el.color || '#a78bfa');
    crossV.setAttribute('stroke-width', 0.5);
    g.appendChild(crossV);

    // 탭 표기 라벨
    if (el.tapSpec) {
      const label = createSvgElement('text');
      label.setAttribute('x', cx + r + 4);
      label.setAttribute('y', cy - r - 2);
      label.setAttribute('fill', el.color || '#a78bfa');
      label.setAttribute('font-size', 9);
      label.setAttribute('font-family', "'JetBrains Mono', monospace");
      label.textContent = el.tapSpec;
      g.appendChild(label);
    }

    // 히트 영역
    const hitCircle = createSvgElement('circle');
    hitCircle.setAttribute('cx', cx);
    hitCircle.setAttribute('cy', cy);
    hitCircle.setAttribute('r', Math.max(r + 4, 8));
    hitCircle.setAttribute('fill', 'transparent');
    hitCircle.style.cursor = 'pointer';
    g.appendChild(hitCircle);

    return g;
  }

  // ========== Slot (슬롯/장공) ==========
  function renderSlot(el) {
    const g = createSvgElement('g');
    const rx = el.height / 2;

    // 장공 외곽 (둥근 사각형)
    const rect = createSvgElement('rect');
    rect.setAttribute('x', el.x);
    rect.setAttribute('y', el.y);
    rect.setAttribute('width', el.width);
    rect.setAttribute('height', el.height);
    rect.setAttribute('rx', rx);
    rect.setAttribute('ry', rx);
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', el.color || '#fbbf24');
    rect.setAttribute('stroke-width', 1.5);
    g.appendChild(rect);

    // 중심선 (슬롯 내부)
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const clH = createSvgElement('line');
    clH.setAttribute('x1', el.x + 2);
    clH.setAttribute('y1', cy);
    clH.setAttribute('x2', el.x + el.width - 2);
    clH.setAttribute('y2', cy);
    clH.setAttribute('stroke', el.color || '#fbbf24');
    clH.setAttribute('stroke-width', 0.4);
    clH.setAttribute('stroke-dasharray', '4 2');
    g.appendChild(clH);

    // 히트 영역
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', el.x - 2);
    hitRect.setAttribute('y', el.y - 2);
    hitRect.setAttribute('width', el.width + 4);
    hitRect.setAttribute('height', el.height + 4);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Hatch (해칭 단면) ==========
  function renderHatch(el) {
    const g = createSvgElement('g');
    if (!el.points || el.points.length < 3) return g;

    const pointsStr = el.points.map(p => `${p.x},${p.y}`).join(' ');
    const polygon = createSvgElement('polygon');
    polygon.setAttribute('points', pointsStr);
    polygon.setAttribute('fill', 'none');
    polygon.setAttribute('stroke', el.color || '#475569');
    polygon.setAttribute('stroke-width', 0.5);
    g.appendChild(polygon);

    const bounds = DrawingModel.getElementBounds(el);
    const spacing = el.spacing || 4;
    const angle = (el.angle || 45) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const diag = Math.sqrt(bounds.width ** 2 + bounds.height ** 2);

    const clipId = `clip_${el.id}`;
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = createSvgElement('defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    const clip = createSvgElement('clipPath');
    clip.id = clipId;
    const clipPoly = createSvgElement('polygon');
    clipPoly.setAttribute('points', pointsStr);
    clip.appendChild(clipPoly);
    defs.appendChild(clip);

    const hatchG = createSvgElement('g');
    hatchG.setAttribute('clip-path', `url(#${clipId})`);

    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const numLines = Math.ceil(diag / spacing) + 2;

    for (let i = -numLines; i <= numLines; i++) {
      const offset = i * spacing;
      const x1 = cx + offset * cos - diag * sin;
      const y1 = cy + offset * sin + diag * cos;
      const x2 = cx + offset * cos + diag * sin;
      const y2 = cy + offset * sin - diag * cos;

      const line = createSvgElement('line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('stroke', el.color || '#475569');
      line.setAttribute('stroke-width', 0.4);
      hatchG.appendChild(line);
    }
    g.appendChild(hatchG);

    const hitPoly = createSvgElement('polygon');
    hitPoly.setAttribute('points', pointsStr);
    hitPoly.setAttribute('fill', 'transparent');
    hitPoly.style.cursor = 'pointer';
    g.appendChild(hitPoly);

    return g;
  }

  // ========== Dimension ==========
  //
  // v6.0 도면 규칙 — 치수선 화살표 스타일 (절대 규칙)
  //
  //   ★ 화살표는 항상 안쪽(측정점)을 향해야 함 — 세번째 사진 스타일
  //   ★ 두번째 사진처럼 바깥을 가리키는 반전 화살표 절대 금지
  //
  //   좁은 공간일 때:
  //     - 치수선은 양 끝점 사이에 화살표(안쪽 방향)로 그림
  //     - 텍스트(숫자)만 외부로 빼서 지시선(leader)으로 연결
  //     - 지시선 색상은 치수선과 동일 (#60a5fa)
  //
  //   넓은 공간일 때:
  //     - 치수선 양 끝에 화살표, 텍스트는 가운데
  //
  function renderDimension(el) {
    const g = createSvgElement('g');
    g.setAttribute('class', 'dimension-group');

    const isHorizontal = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
    const offsetDir = el.offset || 30;
    const color = el.color || '#60a5fa';
    const fontSize = el.fontSize || 12;

    let lx1, ly1, lx2, ly2;
    if (isHorizontal) {
      ly1 = ly2 = Math.min(el.y1, el.y2) - offsetDir;
      lx1 = el.x1; lx2 = el.x2;
    } else {
      lx1 = lx2 = Math.min(el.x1, el.x2) - offsetDir;
      ly1 = el.y1; ly2 = el.y2;
    }

    // 치수선 길이 (양 화살표 사이 거리)
    const dimSpan = Math.sqrt((lx2 - lx1) ** 2 + (ly2 - ly1) ** 2);
    // 텍스트 예상 폭
    const textStr = String(el.value || '');
    const textWidth = textStr.length * fontSize * 0.65;
    // 좁은 공간 판단: 화살표 마커(각 8px) + 여유
    const isNarrow = dimSpan < textWidth + 20;

    // Extension lines (항상 그린다)
    const ext1 = createSvgElement('line');
    ext1.setAttribute('x1', el.x1); ext1.setAttribute('y1', el.y1);
    ext1.setAttribute('x2', lx1); ext1.setAttribute('y2', ly1);
    ext1.setAttribute('stroke', color);
    ext1.setAttribute('stroke-width', 0.5);
    ext1.setAttribute('stroke-dasharray', '2 2');
    g.appendChild(ext1);

    const ext2 = createSvgElement('line');
    ext2.setAttribute('x1', el.x2); ext2.setAttribute('y1', el.y2);
    ext2.setAttribute('x2', lx2); ext2.setAttribute('y2', ly2);
    ext2.setAttribute('stroke', color);
    ext2.setAttribute('stroke-width', 0.5);
    ext2.setAttribute('stroke-dasharray', '2 2');
    g.appendChild(ext2);

    // ★ 치수선 — 화살표는 항상 안쪽(측정점)을 가리킴
    //   넓든 좁든 동일한 화살표 스타일 (세번째 사진)
    const dimLine = createSvgElement('line');
    dimLine.setAttribute('x1', lx1); dimLine.setAttribute('y1', ly1);
    dimLine.setAttribute('x2', lx2); dimLine.setAttribute('y2', ly2);
    dimLine.setAttribute('stroke', color);
    dimLine.setAttribute('stroke-width', 1);
    dimLine.setAttribute('marker-start', 'url(#arrowStart)');
    dimLine.setAttribute('marker-end', 'url(#arrowEnd)');
    g.appendChild(dimLine);

    // ── 텍스트 배치: 항상 치수선의 중앙에 표시 ──
    //
    // ★ 핵심 규칙: 수평·수직 모두 치수선 정중앙에 텍스트 배치
    //   수평 치수: 치수선 중앙 상단
    //   수직 치수(직경 등): 치수선 수직 중앙, 좌측
    //   좁은 공간: 텍스트만 외부 지시선으로 연장
    //
    const midX = (lx1 + lx2) / 2;
    const midY = (ly1 + ly2) / 2;
    const text = createSvgElement('text');
    text.setAttribute('fill', color);
    text.setAttribute('font-size', fontSize);
    text.setAttribute('font-family', "'JetBrains Mono', monospace");
    text.setAttribute('font-weight', '500');

    if (isHorizontal) {
      if (!isNarrow) {
        // 수평 일반: 치수선 중앙 위
        text.setAttribute('x', midX);
        text.setAttribute('y', midY - 4);
        text.setAttribute('text-anchor', 'middle');
      } else {
        // 수평 좁은: 오른쪽으로 지시선 연장
        text.setAttribute('x', lx2 + 4);
        text.setAttribute('y', midY - 3);
        text.setAttribute('text-anchor', 'start');

        const leaderLine = createSvgElement('line');
        leaderLine.setAttribute('x1', lx2); leaderLine.setAttribute('y1', ly2);
        leaderLine.setAttribute('x2', lx2 + textWidth + 10); leaderLine.setAttribute('y2', ly2);
        leaderLine.setAttribute('stroke', color);
        leaderLine.setAttribute('stroke-width', 0.5);
        g.appendChild(leaderLine);
      }
    } else {
      // ★ 수직 치수(직경 등): 치수선 수직 중앙, 오른쪽에 텍스트 배치
      //   공차(+/-)가 텍스트 오른쪽에 붙으므로, 치수선 왼쪽에 놓으면
      //   공차가 치수선(보조선)에 가려진다.
      //   → 텍스트를 치수선 오른쪽에 배치하여 공차가 충분히 보이게 함
      text.setAttribute('x', midX + 5);
      text.setAttribute('y', midY + fontSize * 0.35);
      text.setAttribute('text-anchor', 'start');
    }

    text.textContent = textStr;
    g.appendChild(text);

    // ── 치수공차 (tolerance) 표시 ──
    //   메인 치수 텍스트 오른쪽에 작은 글씨로 상한/하한 공차를 표시
    //   ★ 핵심: ±를 나누는 가운데 선 = 치수숫자의 세로 정중앙
    //   형식:  50 +0.01
    //             -0.01
    if (el.tolerance && (el.toleranceUpper || el.toleranceLower)) {
      const tolFontSize = fontSize * 0.42;   // 공차 글씨: 메인의 42% (기존 60%의 70%)
      const tolGap = 1.5;                    // 메인 텍스트와의 간격

      // ★ tolCenterY = 치수숫자 글자의 세로 정중앙 (± 구분선 위치)
      //   SVG text의 y = baseline
      //   글자 상단(ascent) ≈ baseline - fontSize * 0.7
      //   글자 하단(descent) ≈ baseline + fontSize * 0.1  (대략)
      //   → 글자 시각 중앙 ≈ baseline - fontSize * 0.3
      let tolBaseX, tolCenterY;
      if (isHorizontal) {
        if (!isNarrow) {
          // 수평 일반: baseline = midY - 4
          tolBaseX = midX + textWidth / 2 + tolGap;
          tolCenterY = (midY - 4) - fontSize * 0.3;
        } else {
          // 수평 좁은: baseline = midY - 3
          tolBaseX = lx2 + 4 + textWidth + tolGap;
          tolCenterY = (midY - 3) - fontSize * 0.3;
        }
      } else {
        // 수직: 텍스트가 치수선 오른쪽 (x = midX + 5, text-anchor: start)
        //   공차 시작 X = 텍스트 시작 + 텍스트폭 + 간격
        tolBaseX = midX + 5 + textWidth + tolGap;
        tolCenterY = (midY + fontSize * 0.35) - fontSize * 0.3;
      }

      // 상한 공차 (+) — 가운데선 바로 위, baseline = tolCenterY (글자가 위로 올라감)
      if (el.toleranceUpper) {
        const tolUpper = createSvgElement('text');
        tolUpper.setAttribute('x', tolBaseX);
        tolUpper.setAttribute('y', tolCenterY - 0.5);  // 가운데선 0.5px 위 = 상한 baseline
        tolUpper.setAttribute('fill', color);
        tolUpper.setAttribute('font-size', tolFontSize);
        tolUpper.setAttribute('font-family', "'JetBrains Mono', monospace");
        tolUpper.setAttribute('font-weight', '400');
        tolUpper.setAttribute('text-anchor', 'start');
        tolUpper.setAttribute('dominant-baseline', 'auto'); // baseline 위로 그려짐
        const upperVal = el.toleranceUpper.toString();
        tolUpper.textContent = upperVal.startsWith('+') || upperVal.startsWith('-') ? upperVal : `+${upperVal}`;
        g.appendChild(tolUpper);
      }

      // 하한 공차 (-) — 가운데선 바로 아래, 글자 상단이 가운데선에 붙음
      if (el.toleranceLower) {
        const tolLower = createSvgElement('text');
        tolLower.setAttribute('x', tolBaseX);
        tolLower.setAttribute('y', tolCenterY + tolFontSize * 0.85 + 0.5); // ascent만큼 내려서 글자 상단을 가운데선에 맞춤
        tolLower.setAttribute('fill', color);
        tolLower.setAttribute('font-size', tolFontSize);
        tolLower.setAttribute('font-family', "'JetBrains Mono', monospace");
        tolLower.setAttribute('font-weight', '400');
        tolLower.setAttribute('text-anchor', 'start');
        tolLower.setAttribute('dominant-baseline', 'auto');
        const lowerVal = el.toleranceLower.toString();
        tolLower.textContent = lowerVal.startsWith('+') || lowerVal.startsWith('-') ? lowerVal : `-${lowerVal}`;
        g.appendChild(tolLower);
      }
    }

    // ── Hit Area: 치수선 영역과 치수숫자 영역을 분리 ──
    //   사용자가 치수숫자를 클릭하여 치수공차를 입력할 수 있도록
    //   치수선과 치수숫자 각각 독립된 히트 영역 제공

    // 1) 치수선 히트 영역 (보조선 + 치수선)
    const lineHitPad = 6;
    if (isHorizontal) {
      // 수평: 치수선 주변 가로 긴 직사각형
      const lineHitRect = createSvgElement('rect');
      lineHitRect.setAttribute('x', Math.min(lx1, lx2) - 3);
      lineHitRect.setAttribute('y', ly1 - lineHitPad);
      lineHitRect.setAttribute('width', Math.abs(lx2 - lx1) + 6);
      lineHitRect.setAttribute('height', lineHitPad * 2);
      lineHitRect.setAttribute('fill', 'transparent');
      lineHitRect.style.cursor = 'pointer';
      g.appendChild(lineHitRect);
    } else {
      // 수직: 치수선 주변 세로 긴 직사각형
      const lineHitRect = createSvgElement('rect');
      lineHitRect.setAttribute('x', lx1 - lineHitPad);
      lineHitRect.setAttribute('y', Math.min(ly1, ly2) - 3);
      lineHitRect.setAttribute('width', lineHitPad * 2);
      lineHitRect.setAttribute('height', Math.abs(ly2 - ly1) + 6);
      lineHitRect.setAttribute('fill', 'transparent');
      lineHitRect.style.cursor = 'pointer';
      g.appendChild(lineHitRect);
    }

    // 2) 치수숫자 히트 영역 (텍스트 + 공차)
    const tolExtraW = (el.tolerance && (el.toleranceUpper || el.toleranceLower)) ? 25 : 0;
    let txtHitX, txtHitY, txtHitW, txtHitH;
    if (isHorizontal) {
      if (!isNarrow) {
        txtHitX = midX - textWidth / 2 - 3;
        txtHitY = midY - fontSize - 4;
        txtHitW = textWidth + 6 + tolExtraW;
        txtHitH = fontSize + 8;
      } else {
        txtHitX = lx2 + 1;
        txtHitY = midY - fontSize - 3;
        txtHitW = textWidth + 6 + tolExtraW;
        txtHitH = fontSize + 8;
      }
    } else {
      // 수직: 텍스트는 치수선 오른쪽 (x = midX + 5, text-anchor: start)
      txtHitX = midX + 5 - 2;
      txtHitY = midY - fontSize * 0.5;
      txtHitW = textWidth + 6 + tolExtraW;
      txtHitH = fontSize + 4;
    }
    const txtHitRect = createSvgElement('rect');
    txtHitRect.setAttribute('x', txtHitX);
    txtHitRect.setAttribute('y', txtHitY);
    txtHitRect.setAttribute('width', txtHitW);
    txtHitRect.setAttribute('height', txtHitH);
    txtHitRect.setAttribute('fill', 'transparent');
    txtHitRect.style.cursor = 'pointer';
    g.appendChild(txtHitRect);

    return g;
  }

  // ========== Text ==========
  function renderText(el) {
    const g = createSvgElement('g');

    const text = createSvgElement('text');
    text.setAttribute('x', el.x);
    text.setAttribute('y', el.y);
    text.setAttribute('fill', el.color || '#94a3b8');
    text.setAttribute('font-size', el.fontSize || 14);
    text.setAttribute('font-family', "'Inter', sans-serif");
    text.setAttribute('font-weight', el.fontWeight || 'normal');
    if (el.rotation) {
      text.setAttribute('transform', `rotate(${el.rotation}, ${el.x}, ${el.y})`);
    }
    text.textContent = el.content;
    g.appendChild(text);

    const w = el.content.length * (el.fontSize || 14) * 0.6;
    const h = (el.fontSize || 14) * 1.4;
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', el.x - 2);
    hitRect.setAttribute('y', el.y - h + 4);
    hitRect.setAttribute('width', w + 4);
    hitRect.setAttribute('height', h);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Title Block (표제란) — HAN KOOK MACHINERY CO. 표준 (50% 축소) ==========
  //
  //  회사 표준 레이아웃 (우하단 배치, 회사명 영역 제거):
  //
  //  ┌──────┬─────┬───────┬──────┬────┬────┬───────────┬─────────────────┐
  //  │SCALE │ 1:1 │DESIGN │CHECK │APPR│TTL │           │                 │
  //  │      │     │       │      │    │PRJ │           │  NAME           │
  //  ├──────┼─────┤ NAME  │      │    │    │  DWG NO   │  도면명         │
  //  │ UNIT │ mm  │ DATE  │      │    │    │           │                 │
  //  │      │     │ 날짜  │      │    │    │           ├────────┬────────┤
  //  │      │     │       │      │    │    │           │ REV    │ SH NO  │
  //  ├──────┴─────┴───────┴──────┴────┴────┴───────────┴────────┴────────┤
  //  │ SYM│ REVISION │DATE│SIGN│CHECK│APPR│   REFERENCE DRAWING         │
  //  ├────┼──────────┼────┼────┼─────┼────┼─────────────────────────────┤
  //  │    │          │    │    │     │    │                             │
  //  └────┴──────────┴────┴────┴─────┴────┴─────────────────────────────┘
  //
  function renderTitleBlock(el) {
    const g = createSvgElement('g');
    g.setAttribute('class', 'titleblock-group');

    const W = el.width || 200;
    const x = el.x;
    const y = el.y;
    const fs = el.fontSize || 4.5;
    const ff = "'Malgun Gothic', '맑은 고딕', 'Arial', sans-serif";
    const sc = '#000000';
    const tc = '#000000';

    // ── 헬퍼 함수 ──
    function line(x1, y1, x2, y2, sw) {
      const l = createSvgElement('line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('stroke', sc);
      l.setAttribute('stroke-width', String(sw || 0.25));
      g.appendChild(l);
    }
    function rect(rx, ry, rw, rh, sw) {
      const r = createSvgElement('rect');
      r.setAttribute('x', rx); r.setAttribute('y', ry);
      r.setAttribute('width', rw); r.setAttribute('height', rh);
      r.setAttribute('fill', 'none');
      r.setAttribute('stroke', sc);
      r.setAttribute('stroke-width', String(sw || 0.25));
      g.appendChild(r);
    }
    function txt(tx, ty, content, size, anchor, weight) {
      const t = createSvgElement('text');
      t.setAttribute('x', tx); t.setAttribute('y', ty);
      t.setAttribute('fill', tc);
      t.setAttribute('font-size', String(size || fs));
      t.setAttribute('font-family', ff);
      t.setAttribute('text-anchor', anchor || 'middle');
      t.setAttribute('dominant-baseline', 'central');
      if (weight) t.setAttribute('font-weight', weight);
      t.textContent = content;
      g.appendChild(t);
    }

    // ── 행 높이 (50% 축소) ──
    const ROW_MID1 = 8;       // SCALE/DESIGN 라벨행
    const ROW_MID2 = 8;       // UNIT/DATE/NAME행
    const ROW_MID3 = 6;       // REV/SH NO 작은 행
    const ROW_REV_HDR = 7;    // 리비전 헤더
    const ROW_REV_DATA = 8;   // 리비전 데이터
    const MAIN_H = ROW_MID1 + ROW_MID2 + ROW_MID3;
    const REV_H = ROW_REV_HDR + ROW_REV_DATA;
    const TOTAL_H = MAIN_H + REV_H;

    // ── 주요 열 분할 ──
    const LEFT_RATIO = 0.46;
    const LEFT_W = W * LEFT_RATIO;
    const RIGHT_W = W - LEFT_W;

    // 좌측 정보행 열 비율 (5열: SCALE라벨 | 값(넓게) | DESIGN | CHECK | APPR)
    const CL = LEFT_W;
    const C_SCALE_LBL = CL * 0.14;
    const C_SCALE_VAL = CL * 0.30;   // 기존 값+DESIGN 합친 넓은 칸
    const C_DESIGN = CL * 0.20;      // DESIGN(NAME/DATE 라벨)
    const C_CHECK = CL * 0.18;
    const C_APPR = CL - C_SCALE_LBL - C_SCALE_VAL - C_DESIGN - C_CHECK;
    const infoCols = [C_SCALE_LBL, C_SCALE_VAL, C_DESIGN, C_CHECK, C_APPR];

    // 우측 열 비율
    const CR_LABEL = RIGHT_W * 0.24;
    const CR_VALUE = RIGHT_W - CR_LABEL;
    const CR_REV = CR_VALUE * 0.40;
    const CR_SHNO = CR_VALUE - CR_REV;

    // 리비전 테이블 열
    const RC_SYM = W * 0.06;
    const RC_REVISION = W * 0.18;
    const RC_DATE = W * 0.08;
    const RC_SIGN = W * 0.07;
    const RC_CHECK = W * 0.08;
    const RC_APPR = W * 0.08;
    const RC_REF = W - RC_SYM - RC_REVISION - RC_DATE - RC_SIGN - RC_CHECK - RC_APPR;

    // ── Y 기준점 (회사명 행 제거, SCALE/UNIT부터 시작) ──
    const y0 = y;                                // 전체 상단 = 정보행1 상단
    const y1 = y0 + ROW_MID1;                   // 정보행1 하단
    const y2 = y1 + ROW_MID2;                   // 정보행2 하단
    const y3 = y2 + ROW_MID3;                   // REV/SH NO 하단 = 메인 하단
    const y4 = y3 + ROW_REV_HDR;                // 리비전 헤더 하단
    const y5 = y3 + REV_H;                      // 전체 하단

    // X 기준점
    const xR = x + LEFT_W;

    // ═══════════════════════════════════════════
    // 1. 외곽선 (굵은 테두리)
    // ═══════════════════════════════════════════
    rect(x, y0, W, TOTAL_H, 0.8);

    // ═══════════════════════════════════════════
    // 2. 좌우 분할선 (메인 블록 영역)
    // ═══════════════════════════════════════════
    line(xR, y0, xR, y3, 0.4);

    // ═══════════════════════════════════════════
    // 3. 좌측 정보행: SCALE/UNIT, DESIGN/CHECK/APPR (5열)
    // ═══════════════════════════════════════════
    // 세로 구분선
    let cx = x;
    for (let i = 0; i < infoCols.length; i++) {
      cx += infoCols[i];
      if (i < infoCols.length - 1) {
        if (i <= 1) {
          // SCALE라벨 | 값칸 구분선: y0~y3 전체 (3행 모두)
          line(cx, y0, cx, y3, 0.2);
        } else {
          // DESIGN/CHECK/APPR 구분선: y0~y3
          line(cx, y0, cx, y3, 0.2);
        }
      }
    }

    // 가로 구분선 (정보행1/2 사이)
    const scaleValEnd = x + C_SCALE_LBL + C_SCALE_VAL;
    // SCALE/UNIT 분할 (좌측 2열만)
    line(x, y1, scaleValEnd, y1, 0.2);
    // DESIGN/CHECK/APPR 영역도 y1에서 분할
    line(scaleValEnd, y1, xR, y1, 0.15);
    // y2 구분선 (SCALE/UNIT 하단 → DATE 영역 시작)
    line(x, y2, scaleValEnd, y2, 0.2);

    // ─── 정보행 1: SCALE | 값(넓게) | DESIGN | CHECK | APPR ───
    cx = x;
    txt(cx + C_SCALE_LBL / 2, y0 + ROW_MID1 / 2, 'SCALE', fs - 0.5, 'middle', '600');
    cx += C_SCALE_LBL;
    txt(cx + C_SCALE_VAL / 2, y0 + ROW_MID1 / 2, el.scale || '1:1', fs, 'middle', '400');
    cx += C_SCALE_VAL;
    txt(cx + C_DESIGN / 2, y0 + ROW_MID1 / 2, 'DESIGN', fs - 0.5, 'middle', '600');
    cx += C_DESIGN;
    txt(cx + C_CHECK / 2, y0 + ROW_MID1 / 2, 'CHECK', fs - 0.5, 'middle', '600');
    cx += C_CHECK;
    txt(cx + C_APPR / 2, y0 + ROW_MID1 / 2, 'APPR', fs - 0.5, 'middle', '600');

    // ─── 정보행 2: UNIT | 값(넓게) | (빈칸) | (빈칸) | (빈칸) ───
    cx = x;
    txt(cx + C_SCALE_LBL / 2, y1 + ROW_MID2 / 2, 'UNIT', fs - 0.5, 'middle', '600');
    cx += C_SCALE_LBL;
    txt(cx + C_SCALE_VAL / 2, y1 + ROW_MID2 / 2, el.unit || 'mm', fs, 'middle', '400');
    // DESIGN/CHECK/APPR 하단 행: NAME/DATE/값 모두 제거됨

    // ─── 정보행 3 (y2~y3): SCALE/UNIT 아래 빈 영역에 DATE 표시 ───
    txt(x + C_SCALE_LBL / 2, y2 + ROW_MID3 / 2, 'DATE', fs - 0.5, 'middle', '600');
    txt(x + C_SCALE_LBL + C_SCALE_VAL / 2, y2 + ROW_MID3 / 2, el.date || '', fs - 0.5, 'middle', '400');

    // ═══════════════════════════════════════════
    // 4. 우측: DWG NO 라벨 | NAME(도면명) + TTL.PRJ/값
    // ═══════════════════════════════════════════
    // 우측 세로 분할: 라벨 열 | 값 열
    line(xR + CR_LABEL, y0, xR + CR_LABEL, y3, 0.2);

    // 우측 라벨 영역: DWG NO만 (TTL.PRJ는 하단으로 이동)
    const rMidH = y2 - y0;
    txt(xR + CR_LABEL / 2, y0 + rMidH / 2, 'DWG NO', fs - 1, 'middle', '600');

    // NAME 라벨 (우상단 모서리)
    txt(xR + CR_LABEL + 2, y0 + 2.5, 'NAME', fs - 1, 'start', '600');

    // 도면명 (큰 글씨, 중앙 정렬)
    const nameAreaH = y2 - y0;
    txt(xR + CR_LABEL + CR_VALUE / 2, y0 + nameAreaH / 2,
      el.drawingName || '', fs + 2, 'middle', '700');

    // for 부제
    if (el.drawingNameSub) {
      txt(xR + CR_LABEL + CR_VALUE / 2, y0 + nameAreaH * 0.78,
        'for  ' + el.drawingNameSub, fs - 0.5, 'middle', '400');
    }

    // TTL.PRJ / 값 분할 (y2 ~ y3) — REV/SH NO 대신
    line(xR + CR_LABEL, y2, x + W, y2, 0.2);
    const ttlX = xR + CR_LABEL;
    const ttlLblW = CR_VALUE * 0.30;   // TTL.PRJ 라벨 폭
    const ttlValW = CR_VALUE - ttlLblW; // 값 폭
    line(ttlX + ttlLblW, y2, ttlX + ttlLblW, y3, 0.2);

    txt(ttlX + ttlLblW / 2, y2 + ROW_MID3 / 2, 'TTL.PRJ', fs - 1, 'middle', '600');
    txt(ttlX + ttlLblW + ttlValW / 2, y2 + ROW_MID3 / 2,
      el.titlePrj || '깨끗한나라(주) - 청주공장', fs - 1, 'middle', '400');

    // ═══════════════════════════════════════════
    // 5. 하단: 리비전 테이블 (전체 폭)
    // ═══════════════════════════════════════════
    line(x, y3, x + W, y3, 0.4);

    const revLabels = ['SYM', 'REVISION', 'DATE', 'SIGN', 'CHECK', 'APPR', 'REFERENCE DRAWING'];
    const revColWidths = [RC_SYM, RC_REVISION, RC_DATE, RC_SIGN, RC_CHECK, RC_APPR, RC_REF];

    cx = x;
    for (let i = 0; i < revLabels.length; i++) {
      const cw = revColWidths[i];
      txt(cx + cw / 2, y3 + ROW_REV_HDR / 2, revLabels[i], fs - 1, 'middle', '600');
      cx += cw;
      if (i < revLabels.length - 1) {
        line(cx, y3, cx, y5, 0.15);
      }
    }

    // 리비전 헤더/데이터 구분선
    line(x, y4, x + W, y4, 0.2);

    // 리비전 데이터 행
    const revRows = el.revisionRows || [];
    if (revRows.length > 0) {
      const rv = revRows[0];
      cx = x;
      const revFields = ['sym', 'revision', 'date', 'sign', 'check', 'appr', 'reference'];
      for (let i = 0; i < revFields.length; i++) {
        const cw = revColWidths[i];
        const val = rv[revFields[i]] || '';
        if (val) txt(cx + cw / 2, y4 + ROW_REV_DATA / 2, val, fs - 0.5, 'middle', '400');
        cx += cw;
      }
    }

    // ═══════════════════════════════════════════
    // 6. 용지 크기 표시 (우하단)
    // ═══════════════════════════════════════════
    const paperSizes = { A3: '420x297mm', A2: '594x420mm', A4: '297x210mm', A1: '841x594mm' };
    const ps = el.paperSize || 'A3';
    const psText = ps + '(' + (paperSizes[ps] || '420x297mm') + ')';
    txt(x + W - 2, y5 + 3, psText, fs - 1, 'end', '400');

    // ═══════════════════════════════════════════
    // 7. 전체 히트 영역 (선택용)
    // ═══════════════════════════════════════════
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', x - 1);
    hitRect.setAttribute('y', y0 - 1);
    hitRect.setAttribute('width', W + 2);
    hitRect.setAttribute('height', TOTAL_H + 6);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Note Block (주서란) ==========
  function renderNoteBlock(el) {
    const g = createSvgElement('g');
    g.setAttribute('class', 'noteblock-group');

    const lines = el.lines || [];
    if (lines.length === 0) return g;

    const x = el.x || 0;
    const y = el.y || 0;
    const fontSize = el.fontSize || 10;
    const lineH = fontSize * (el.lineHeight || 1.6);
    const fontFamily = el.fontFamily || "'Malgun Gothic', '맑은 고딕', sans-serif";
    const color = el.color || '#000000';
    const titleColor = el.titleColor || '#000000';

    // "NOTE" 타이틀
    const title = createSvgElement('text');
    title.setAttribute('x', x);
    title.setAttribute('y', y);
    title.setAttribute('fill', titleColor);
    title.setAttribute('font-size', String(fontSize + 2));
    title.setAttribute('font-family', fontFamily);
    title.setAttribute('font-weight', '700');
    title.setAttribute('text-anchor', 'start');
    title.setAttribute('dominant-baseline', 'auto');
    title.textContent = 'NOTE';
    g.appendChild(title);

    // 각 줄 렌더링: "1. 내용", "2. 내용", ...
    lines.forEach((line, idx) => {
      const lineY = y + (idx + 1) * lineH;
      const txt = createSvgElement('text');
      txt.setAttribute('x', x);
      txt.setAttribute('y', lineY);
      txt.setAttribute('fill', color);
      txt.setAttribute('font-size', String(fontSize));
      txt.setAttribute('font-family', fontFamily);
      txt.setAttribute('font-weight', '400');
      txt.setAttribute('text-anchor', 'start');
      txt.setAttribute('dominant-baseline', 'auto');
      txt.textContent = `${idx + 1}. ${line}`;
      g.appendChild(txt);
    });

    // 히트 영역 (선택용)
    const totalH = (lines.length + 1) * lineH + 4;
    const estimatedW = Math.max(200, ...lines.map(l => l.length * fontSize * 0.65));
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', x - 4);
    hitRect.setAttribute('y', y - fontSize - 4);
    hitRect.setAttribute('width', estimatedW + 8);
    hitRect.setAttribute('height', totalH + 8);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Selection Highlight ==========
  function showSelection(element) {
    clearSelection();
    if (!element) return;

    const bounds = DrawingModel.getElementBounds(element);
    const pad = 6;

    const rect = createSvgElement('rect');
    rect.setAttribute('x', bounds.x - pad);
    rect.setAttribute('y', bounds.y - pad);
    rect.setAttribute('width', bounds.width + pad * 2);
    rect.setAttribute('height', bounds.height + pad * 2);
    rect.setAttribute('class', 'selection-box');
    groups.selection.appendChild(rect);

    const handleSize = 6;
    const corners = [
      { x: bounds.x - pad, y: bounds.y - pad },
      { x: bounds.x + bounds.width + pad, y: bounds.y - pad },
      { x: bounds.x - pad, y: bounds.y + bounds.height + pad },
      { x: bounds.x + bounds.width + pad, y: bounds.y + bounds.height + pad },
    ];
    corners.forEach(c => {
      const handle = createSvgElement('rect');
      handle.setAttribute('x', c.x - handleSize / 2);
      handle.setAttribute('y', c.y - handleSize / 2);
      handle.setAttribute('width', handleSize);
      handle.setAttribute('height', handleSize);
      handle.setAttribute('class', 'selection-handle');
      handle.setAttribute('rx', '1');
      groups.selection.appendChild(handle);
    });
  }

  // ========== Dynamic Layer Counts ==========
  function updateLayerCounts(doc) {
    const counts = {};
    Object.keys(doc.layers).forEach(k => { counts[k] = 0; });
    doc.elements.forEach(el => {
      if (counts[el.layer] !== undefined) counts[el.layer]++;
    });

    Object.entries(counts).forEach(([layer, count]) => {
      const el = document.getElementById(`${layer}Count`);
      if (el) el.textContent = count;
    });

    const total = doc.elements.length;
    const countEl = document.getElementById('elementCount');
    if (countEl) countEl.textContent = `${total} 요소`;
  }

  // ========== v5: Placeholder 시각화 ==========
  /**
   * placeholder 요소: 흐린 점선 + 밑줄 효과 + 편집 힌트
   * 더블클릭으로 값을 직접 입력할 수 있음을 시각적으로 표현
   */
  function applyPlaceholderStyle(svgGroup, el) {
    svgGroup.setAttribute('data-placeholder', 'true');
    svgGroup.setAttribute('data-confidence', el.confidence || 'uncertain');
    svgGroup.style.opacity = '0.45';

    // 텍스트 요소: 밑줄 + 편집 힌트 색상
    svgGroup.querySelectorAll('text').forEach(text => {
      text.setAttribute('fill', '#6b7280');
      text.setAttribute('text-decoration', 'underline');
      text.setAttribute('font-style', 'italic');
    });

    // 선 요소: 흐린 점선
    svgGroup.querySelectorAll('line:not([stroke=transparent])').forEach(line => {
      if (!line.getAttribute('stroke-dasharray')) {
        line.setAttribute('stroke-dasharray', '3 5');
      }
      line.setAttribute('stroke', '#6b7280');
    });

    // 원 요소: 흐린 점선
    svgGroup.querySelectorAll('circle:not([fill=transparent])').forEach(circ => {
      if (!circ.getAttribute('stroke-dasharray')) {
        circ.setAttribute('stroke-dasharray', '3 5');
      }
      circ.setAttribute('stroke', '#6b7280');
    });

    // 사각형(치수 등): 흐린 점선
    svgGroup.querySelectorAll('rect:not([fill=transparent])').forEach(rect => {
      if (rect.getAttribute('fill') === 'none') {
        rect.setAttribute('stroke-dasharray', '3 5');
        rect.setAttribute('stroke', '#6b7280');
      }
    });

    // ── 📝 편집 힌트 아이콘 (작은 연필) ──
    const bounds = el.id ? DrawingModel.getElementBounds(el) : null;
    if (bounds && bounds.width > 0) {
      const editIcon = createSvgElement('text');
      editIcon.setAttribute('x', bounds.x + bounds.width + 4);
      editIcon.setAttribute('y', bounds.y + 10);
      editIcon.setAttribute('fill', '#f59e0b');
      editIcon.setAttribute('font-size', 10);
      editIcon.setAttribute('opacity', '0.7');
      editIcon.textContent = '✏️';
      svgGroup.appendChild(editIcon);
    }
  }

  // ========== v5: Confidence 시각화 (non-placeholder) ==========
  /**
   * confidence 수준에 따라 SVG 그룹에 스타일 적용
   *
   * confirmed  → 정상 (opacity 1.0)
   * estimated  → opacity 0.7, 점선 stroke
   * uncertain  → opacity 0.4, 주황 점선 외곽
   * null       → 정상 (하위 호환)
   */
  function applyConfidenceStyle(svgGroup, el) {
    const conf = el.confidence;
    if (!conf || conf === 'confirmed') return; // 정상

    svgGroup.setAttribute('data-confidence', conf);

    if (conf === 'estimated') {
      svgGroup.style.opacity = '0.7';
      svgGroup.querySelectorAll('line:not([stroke=transparent])').forEach(line => {
        if (!line.getAttribute('stroke-dasharray')) {
          line.setAttribute('stroke-dasharray', '3 1.5');
        }
      });
      svgGroup.querySelectorAll('rect:not([fill=transparent])').forEach(rect => {
        if (rect.getAttribute('fill') === 'none' && !rect.getAttribute('stroke-dasharray')) {
          rect.setAttribute('stroke-dasharray', '3 1.5');
        }
      });
      svgGroup.querySelectorAll('circle:not([fill=transparent])').forEach(circ => {
        if (!circ.getAttribute('stroke-dasharray')) {
          circ.setAttribute('stroke-dasharray', '2.8 1.4');
        }
      });
    }

    if (conf === 'uncertain') {
      svgGroup.style.opacity = '0.4';
      svgGroup.querySelectorAll('line:not([stroke=transparent])').forEach(line => {
        line.setAttribute('stroke-dasharray', '2 4');
        line.setAttribute('stroke', '#fbbf24');
      });
      svgGroup.querySelectorAll('text').forEach(text => {
        text.setAttribute('fill', '#fbbf24');
      });
      svgGroup.querySelectorAll('circle:not([fill=transparent])').forEach(circ => {
        circ.setAttribute('stroke-dasharray', '2 4');
        circ.setAttribute('stroke', '#fbbf24');
      });
      svgGroup.querySelectorAll('rect:not([fill=transparent])').forEach(rect => {
        if (rect.getAttribute('fill') === 'none') {
          rect.setAttribute('stroke-dasharray', '2 4');
          rect.setAttribute('stroke', '#fbbf24');
        }
      });
    }
  }

  // ========== Helpers ==========
  function createSvgElement(tag) {
    return document.createElementNS(NS, tag);
  }

  return {
    init, render, renderElement, clearAll, clearSelection,
    showSelection, updateLayerCounts, ensureGroups,
  };
})();
