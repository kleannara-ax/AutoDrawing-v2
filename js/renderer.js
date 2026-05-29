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

  // ★ v41-fix: 데이텀 렌더링 시 부품 외형선 바운딩박스 중심 (render() 에서 미리 계산)
  let _partCenter = null;   // { cx, cy } or null

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
      'holes', 'slots', 'dimensions', 'surfacefinish', 'annotations', 'texts', 'titleblocks', 'selection'
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

    // ★ v34: 기하공차 중복 제거 — attachTo 기반 + 좌표 기반 이중 필터
    //   (1) 같은 attachTo에 대해 마지막 것만 렌더링
    //   (2) attachTo=null이어도 같은 좌표+기호+값이면 마지막 것만 렌더링
    const gdtByAttach = {};
    const gdtByCoord = {};
    doc.elements.forEach(el => {
      if (el.type === 'geotolerance') {
        if (el.attachTo) {
          gdtByAttach[el.attachTo] = el.id;
        }
        // 좌표+기호+값 기반 키 (소수점 반올림하여 근접 좌표도 동일 취급)
        const coordKey = `${Math.round(el.x)}_${Math.round(el.y)}_${el.symbolType}_${el.value}`;
        gdtByCoord[coordKey] = el.id;  // 마지막 것이 승리
      }
    });
    const skipGdtIds = new Set();
    doc.elements.forEach(el => {
      if (el.type === 'geotolerance') {
        // attachTo 기반 중복
        if (el.attachTo && gdtByAttach[el.attachTo] !== el.id) {
          skipGdtIds.add(el.id);
        }
        // 좌표 기반 중복
        const coordKey = `${Math.round(el.x)}_${Math.round(el.y)}_${el.symbolType}_${el.value}`;
        if (gdtByCoord[coordKey] !== el.id) {
          skipGdtIds.add(el.id);
        }
      }
    });

    // ★ v41-fix: 데이텀 방향 자동 보정용 — 부품 외형선 바운딩박스 중심 미리 계산
    _partCenter = null;
    const _outlines = doc.elements.filter(e => e.type === 'outline');
    if (_outlines.length > 0) {
      let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
      _outlines.forEach(o => {
        mnX = Math.min(mnX, o.x1, o.x2);
        mnY = Math.min(mnY, o.y1, o.y2);
        mxX = Math.max(mxX, o.x1, o.x2);
        mxY = Math.max(mxY, o.y1, o.y2);
      });
      _partCenter = { cx: (mnX + mxX) / 2, cy: (mnY + mxY) / 2 };
    }

    doc.elements.forEach(el => {
      if (doc.layers[el.layer] && !doc.layers[el.layer].visible) return;
      if (skipGdtIds.has(el.id)) return;  // 중복 GDT 건너뛰기
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
      case 'noteblock':     svgEl = renderNoteBlock(el); break;
      case 'surfacefinish':  svgEl = renderSurfaceFinish(el); break;
      case 'geotolerance':   svgEl = renderGeoTolerance(el); break;
      case 'datum':          svgEl = renderDatum(el); break;
      case 'breakLine':      svgEl = renderBreakLine(el); break;
      case 'paperBg':        svgEl = renderPaperBg(el); break;
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
      // ★ v38: 도면 윤곽선 두께 1로 통일
      path.setAttribute('stroke-width', 1);
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('fill', 'none');
      g.appendChild(path);

      // 히트 영역 (arc path)
      const hit = createSvgElement('path');
      hit.setAttribute('d', d);
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', 12);
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
    // ★ v38: 도면 윤곽선 두께 1로 통일
    line.setAttribute('stroke-width', 1);
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
    hit.setAttribute('stroke-width', 12);
    hit.style.cursor = 'pointer';
    g.appendChild(hit);

    return g;
  }

  // ========== Break Line (물결 생략선) ==========
  // 구간 길이 > 1000mm 일 때 중앙에 그리는 S-curve 물결표시
  // 정면도에서 긴 구간을 시각적으로 축소했음을 나타내는 기호
  //
  //   구조:  좌측 흰색 마스크 │ S-curve 물결 │ 우측 흰색 마스크
  //
  //   물결선 형태 (상단→하단):
  //     시작점(topY) → 우측으로 S곡선 → 좌측으로 S곡선 → 끝점(botY)
  //     (손그림 스케치의 물결표시와 동일한 형태)
  //
  function renderBreakLine(el) {
    const g = createSvgElement('g');
    const cx = el.x;          // 물결선 중심 X
    const topY = el.topY;     // 상단 (외형선 위쪽)
    const botY = el.botY;     // 하단 (외형선 아래쪽)
    const halfW = (el.gapW || 6) / 2; // 물결 진폭 (좌우)
    const totalH = botY - topY;

    // ── 1) 흰색 마스크: 물결 영역의 기존 외형선을 지움 ──
    const mask = createSvgElement('rect');
    mask.setAttribute('x', cx - halfW - 1);
    mask.setAttribute('y', topY - 0.5);
    mask.setAttribute('width', halfW * 2 + 2);
    mask.setAttribute('height', totalH + 1);
    mask.setAttribute('fill', '#ffffff');
    mask.setAttribute('stroke', 'none');
    g.appendChild(mask);

    // ── 2) S-curve 물결선 (2개 — 약간 좌우 오프셋) ──
    // 물결선 형태: 상단에서 하단까지 2~3개의 S-곡선이 연결된 형태
    // SVG cubic bezier를 사용하여 자연스러운 S-curve 구현
    const waveCount = 3; // S-curve 반복 수
    const segH = totalH / (waveCount * 2); // 각 반곡선 높이

    for (let offset = -0.8; offset <= 0.8; offset += 1.6) {
      let d = `M ${cx + offset} ${topY}`;
      for (let i = 0; i < waveCount * 2; i++) {
        const y0 = topY + i * segH;
        const y1 = y0 + segH;
        const dir = (i % 2 === 0) ? 1 : -1;
        const cpx = cx + offset + dir * halfW;
        d += ` Q ${cpx} ${(y0 + y1) / 2} ${cx + offset} ${y1}`;
      }
      const path = createSvgElement('path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', el.color || '#000000');
      path.setAttribute('stroke-width', el.thickness || 1);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      g.appendChild(path);
    }

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
    const slotShape = el.slotShape || 'obround';  // v117: 키 형상 ('obround' | 'one-side-round' | 'rect')
    const stroke = el.color || '#fbbf24';

    // v118: 외형선 두께를 다른 outline과 동일하게 (1.5 → 1.0)
    const sw = el.strokeWidth || 1;

    if (slotShape === 'one-side-round') {
      // ★ v117+v118: 한쪽 둥근형 — slotRoundSide에 따라 둥근 쪽 결정
      const roundSide = el.slotRoundSide || 'right';
      const x = el.x, y = el.y, w = el.width, h = el.height;
      const r = h / 2;
      let d;
      if (roundSide === 'left') {
        // 왼쪽 반원 + 오른쪽 직각
        const arcEndX = x + r;
        d = [
          `M ${x + w} ${y}`,           // 오른쪽 상단
          `L ${arcEndX} ${y}`,          // → 왼쪽 상단 (반원 시작)
          `A ${r} ${r} 0 0 0 ${arcEndX} ${y + h}`,  // 왼쪽 반원 (반시계방향)
          `L ${x + w} ${y + h}`,        // → 오른쪽 하단
          `Z`
        ].join(' ');
      } else {
        // 왼쪽 직각 + 오른쪽 반원 (기존)
        const arcStartX = x + w - r;
        d = [
          `M ${x} ${y}`,
          `L ${arcStartX} ${y}`,
          `A ${r} ${r} 0 0 1 ${arcStartX} ${y + h}`,
          `L ${x} ${y + h}`,
          `Z`
        ].join(' ');
      }
      const path = createSvgElement('path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', stroke);
      path.setAttribute('stroke-width', sw);
      g.appendChild(path);
    } else if (slotShape === 'rect') {
      // ★ v117: 양쪽 네모형 — 직각 사각형
      const rect = createSvgElement('rect');
      rect.setAttribute('x', el.x);
      rect.setAttribute('y', el.y);
      rect.setAttribute('width', el.width);
      rect.setAttribute('height', el.height);
      rect.setAttribute('rx', 0);
      rect.setAttribute('ry', 0);
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', stroke);
      rect.setAttribute('stroke-width', sw);
      g.appendChild(rect);
    } else {
      // 양쪽 둥근형 (obround) — 기존 동작
      const rect = createSvgElement('rect');
      rect.setAttribute('x', el.x);
      rect.setAttribute('y', el.y);
      rect.setAttribute('width', el.width);
      rect.setAttribute('height', el.height);
      rect.setAttribute('rx', rx);
      rect.setAttribute('ry', rx);
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', stroke);
      rect.setAttribute('stroke-width', sw);
      g.appendChild(rect);
    }

    // 중심선 (슬롯 내부)
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const clH = createSvgElement('line');
    clH.setAttribute('x1', el.x + 2);
    clH.setAttribute('y1', cy);
    clH.setAttribute('x2', el.x + el.width - 2);
    clH.setAttribute('y2', cy);
    clH.setAttribute('stroke', stroke);
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
    const offsetDir = (el.offset != null) ? el.offset : 30;
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

    // Extension lines — 지름 치수(dimStyle=diameter)에서는 보조선 생략
    // ★ v119: 보조선을 실선으로 변경 + 화살표 위로 3mm(≈6px) 연장
    const isDiamDim = el.dimStyle === 'diameter';
    if (!isDiamDim) {
      const EXT_OVERSHOOT = 6; // 화살표 너머 연장 (≈3mm)
      let ex1x = lx1, ex1y = ly1, ex2x = lx2, ex2y = ly2;
      if (isHorizontal) {
        // 수평 치수: 보조선은 수직으로 올라감 → Y방향 추가 연장
        const dir = (ly1 < el.y1) ? -1 : 1; // 치수선이 위에 있으면 더 위로
        ex1y = ly1 + dir * EXT_OVERSHOOT;
        ex2y = ly2 + dir * EXT_OVERSHOOT;
      } else {
        // 수직 치수: 보조선은 수평으로 나감 → X방향 추가 연장
        const dir = (lx1 < el.x1) ? -1 : 1; // 치수선이 왼쪽이면 더 왼쪽으로
        ex1x = lx1 + dir * EXT_OVERSHOOT;
        ex2x = lx2 + dir * EXT_OVERSHOOT;
      }

      const ext1 = createSvgElement('line');
      ext1.setAttribute('x1', el.x1); ext1.setAttribute('y1', el.y1);
      ext1.setAttribute('x2', ex1x); ext1.setAttribute('y2', ex1y);
      ext1.setAttribute('stroke', color);
      ext1.setAttribute('stroke-width', 0.5);
      g.appendChild(ext1);

      const ext2 = createSvgElement('line');
      ext2.setAttribute('x1', el.x2); ext2.setAttribute('y1', el.y2);
      ext2.setAttribute('x2', ex2x); ext2.setAttribute('y2', ex2y);
      ext2.setAttribute('stroke', color);
      ext2.setAttribute('stroke-width', 0.5);
      g.appendChild(ext2);
    }

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

    // ── v40: 좁은 치수 엘보 지시선 (elbow leader) ──
    //
    // 치수선 사이에 텍스트가 들어갈 공간이 부족한 경우:
    //   1. 치수선 중앙에서 위로 수직선 (elbowRise)
    //   2. 수직선 끝에서 오른쪽으로 수평선 (shoulder)
    //   3. 수평선 위에 치수 텍스트 표시
    //
    // _narrowLeaderLevel: AI엔진이 인접 좁은 치수에 0,1,2... 레벨 할당
    //   → 레벨이 높을수록 더 위로 올라가서 텍스트 겹침 방지
    //
    //   레벨0:  ─┐ 8.5
    //   레벨1:  ─┐ 5
    //            │
    //   레벨2:  ─┐ 3
    //            │
    //            │
    //   dimLine: ←→←→←→
    //
    const ELBOW_BASE_RISE = 10;      // 기본 수직 상승 (px)
    const ELBOW_LEVEL_STEP = 12;     // 레벨당 추가 상승 (px) — 텍스트 높이 + 여유
    const ELBOW_SHOULDER = 6;        // 수평 어깨 길이 (px)

    if (isHorizontal) {
      if (!isNarrow) {
        // 수평 일반: 치수선 중앙 위
        text.setAttribute('x', midX);
        text.setAttribute('y', midY - 4);
        text.setAttribute('text-anchor', 'middle');
      } else {
        // ★ v40: 수평 좁은 → 엘보 지시선
        //   치수선 중앙 → 위로 수직 → 오른쪽 수평 어깨 → 텍스트
        const level = el._narrowLeaderLevel || 0;
        const elbowRise = ELBOW_BASE_RISE + level * ELBOW_LEVEL_STEP;

        // 엘보 꼭짓점 좌표
        const elbowBottomX = midX;
        const elbowBottomY = midY;     // 치수선 위 (수평이므로 ly1 = ly2 = midY)
        const elbowTopX = midX;
        const elbowTopY = midY - elbowRise;
        const shoulderEndX = midX + ELBOW_SHOULDER + textWidth + 4;
        const shoulderEndY = elbowTopY;

        // 수직선: 치수선 중앙 → 위
        const vLine = createSvgElement('line');
        vLine.setAttribute('x1', elbowBottomX); vLine.setAttribute('y1', elbowBottomY);
        vLine.setAttribute('x2', elbowTopX);    vLine.setAttribute('y2', elbowTopY);
        vLine.setAttribute('stroke', color);
        vLine.setAttribute('stroke-width', 0.5);
        g.appendChild(vLine);

        // 수평 어깨선: 꼭짓점 → 오른쪽
        const hLine = createSvgElement('line');
        hLine.setAttribute('x1', elbowTopX);    hLine.setAttribute('y1', elbowTopY);
        hLine.setAttribute('x2', shoulderEndX); hLine.setAttribute('y2', shoulderEndY);
        hLine.setAttribute('stroke', color);
        hLine.setAttribute('stroke-width', 0.5);
        g.appendChild(hLine);

        // 텍스트: 어깨선 위
        text.setAttribute('x', elbowTopX + ELBOW_SHOULDER);
        text.setAttribute('y', elbowTopY - 2);
        text.setAttribute('text-anchor', 'start');
      }
    } else {
      // ★ v106: 수직 치수(직경 등): 텍스트를 90° 회전하여 치수선에 평행 배치
      //   치수선 왼쪽에 텍스트를 놓고, bottom→top 방향으로 읽히도록 -90° 회전
      //   (KS 도면 표준: 수직 치수 텍스트는 치수선에 평행, 왼쪽 배치)
      text.setAttribute('x', midX);
      text.setAttribute('y', midY);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('transform', `rotate(-90, ${midX}, ${midY})`);
      // 회전 후 시각적으로 치수선 왼쪽에 오도록 dx 조정
      text.setAttribute('dx', 0);
      text.setAttribute('dy', -4);
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
          // ★ v40: 수평 좁은 엘보 — baseline = elbowTopY - 2
          const lvl = el._narrowLeaderLevel || 0;
          const eRise = ELBOW_BASE_RISE + lvl * ELBOW_LEVEL_STEP;
          const eTopY = midY - eRise;
          tolBaseX = midX + ELBOW_SHOULDER + textWidth + tolGap;
          tolCenterY = (eTopY - 2) - fontSize * 0.3;
        }
      } else {
        // ★ v106: 수직 치수 — 텍스트가 -90° 회전됨
        //   회전 좌표계 기준으로 공차 배치: 텍스트 우측(시각적 상측) = 회전 전 Y-
        //   rotate(-90)에서: 원래 +X → 화면 -Y(위), 원래 +Y → 화면 +X(오른쪽)
        //   tolBaseX: 회전 전 좌표계에서 텍스트 끝 + 간격 (text-anchor=middle이므로 중앙 + 텍스트폭/2)
        tolBaseX = midX + textWidth / 2 + tolGap;
        tolCenterY = midY - 4 - fontSize * 0.3;
      }

      // 공차 회전 플래그 — 수직 치수이면 공차도 -90° 회전 필요
      const tolRotate = !isHorizontal;

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
        if (tolRotate) tolUpper.setAttribute('transform', `rotate(-90, ${midX}, ${midY})`);
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
        if (tolRotate) tolLower.setAttribute('transform', `rotate(-90, ${midX}, ${midY})`);
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
        // ★ v40: 엘보 지시선 텍스트 히트 영역
        const lvl2 = el._narrowLeaderLevel || 0;
        const eRise2 = ELBOW_BASE_RISE + lvl2 * ELBOW_LEVEL_STEP;
        const eTopY2 = midY - eRise2;
        txtHitX = midX + ELBOW_SHOULDER - 2;
        txtHitY = eTopY2 - fontSize - 2;
        txtHitW = textWidth + 6 + tolExtraW;
        txtHitH = fontSize + 8;
      }
    } else {
      // ★ v108: 수직 치수 — 텍스트가 -90° 회전됨 (치수선 왼쪽, 세로 배치)
      //   회전된 텍스트의 실제 시각적 영역: 치수선 왼쪽에 세로로 긴 직사각형
      //   텍스트 중심 = (midX, midY), 회전 후:
      //     시각적 폭 = fontSize (글자 높이가 가로 폭이 됨)
      //     시각적 높이 = textWidth (글자 폭이 세로 높이가 됨)
      txtHitX = midX - fontSize - 4;   // 치수선 왼쪽
      txtHitY = midY - textWidth / 2 - 3;  // 텍스트 세로 중앙 기준
      txtHitW = fontSize + 8;
      txtHitH = textWidth + 6 + tolExtraW;
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

    // ★ v38: 도면명 — 글자크기 절반 축소 + 칸 초과 시 2줄 표시
    const nameAreaH = y2 - y0;
    const nameFS = (fs + 2) / 2;               // 기존 fs+2 → 절반 (≈3.25)
    const nameStr = el.drawingName || '';
    const nameCenterX = xR + CR_LABEL + CR_VALUE / 2;
    const namePadding = 4;                      // 좌우 여백
    const nameAvailW = CR_VALUE - namePadding;  // 실제 사용 가능 폭
    // 글자폭 추정: 한글≈fontSize*0.85, 영문/숫자≈fontSize*0.55
    const nameTextW = Array.from(nameStr).reduce(function(sum, ch) {
      return sum + (/[\u3131-\uD79D]/.test(ch) ? nameFS * 0.85 : nameFS * 0.55);
    }, 0);

    if (nameTextW <= nameAvailW || nameStr.length === 0) {
      // 한 줄에 표시
      const hasSub = !!(el.drawingNameSub);
      const nameY = hasSub ? y0 + nameAreaH * 0.42 : y0 + nameAreaH / 2;
      txt(nameCenterX, nameY, nameStr, nameFS, 'middle', '700');
    } else {
      // 2줄로 분할: 중간 공백 기준 또는 절반 위치에서 자름
      var splitIdx = -1;
      var halfLen = Math.ceil(nameStr.length / 2);
      // 중간 근처 공백 찾기
      for (var si = halfLen; si >= halfLen - 5 && si >= 0; si--) {
        if (nameStr[si] === ' ') { splitIdx = si; break; }
      }
      if (splitIdx < 0) {
        for (var sj = halfLen; sj <= halfLen + 5 && sj < nameStr.length; sj++) {
          if (nameStr[sj] === ' ') { splitIdx = sj; break; }
        }
      }
      if (splitIdx < 0) splitIdx = halfLen; // 공백 없으면 절반에서 자름

      var line1 = nameStr.substring(0, splitIdx).trim();
      var line2 = nameStr.substring(splitIdx).trim();
      var hasSub2 = !!(el.drawingNameSub);
      var lineGap = nameFS * 1.4;
      var baseY = hasSub2
        ? y0 + nameAreaH * 0.32
        : y0 + nameAreaH / 2 - lineGap / 2;
      txt(nameCenterX, baseY, line1, nameFS, 'middle', '700');
      txt(nameCenterX, baseY + lineGap, line2, nameFS, 'middle', '700');
    }

    // for 부제
    if (el.drawingNameSub) {
      txt(nameCenterX, y0 + nameAreaH * 0.82,
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

  // ========== Surface Finish Symbol (다듬질 기호 — KS 규격) ==========
  //
  //  KS 규격 다듬질 기호:
  //   독립적인 ▽ (역삼각형) 마크를 **간격을 두고 나란히** 배열
  //   각 ▽는 독립적으로 분리되어야 함 (W/지그재그처럼 연결되면 안 됨!)
  //   V의 꼭짓점(tip)이 아래(표면)를 가리키고 열린 쪽이 위
  //
  //   ▽ ▽ ▽ ▽  연마 다듬질 (grinding)   — 4개 분리 배열
  //   ▽ ▽ ▽    정밀 다듬질 (precision)  — 3개 분리 배열
  //   ▽ ▽      보통 다듬질 (normal)     — 2개 분리 배열
  //   ▽        거친 다듬질 (rough)      — 1개
  //   〰       다듬질 안함 (none)       — 물결선
  //
  //  크기: V 높이 ≈ 2 SVG 단위 (치수 텍스트(6)의 ~33%)
  //  핵심: 각 ▽ 사이에 충분한 간격(≥ V 폭의 50%)을 두어
  //       인접 V가 연결되어 W처럼 보이지 않도록 함
  //
  function renderSurfaceFinish(el) {
    const g = createSvgElement('g');
    const color = el.color || '#000000';
    const rot = el.rotation || 0;
    if (rot !== 0) {
      g.setAttribute('transform', `rotate(${rot}, ${el.x}, ${el.y})`);
    }

    const baseX = el.x;
    const baseY = el.y;

    if (el.grade === 'none') {
      // 다듬질 안함: KS 규격 물결선(~) 기호
      const stemH = 2;
      const stemLine = createSvgElement('line');
      stemLine.setAttribute('x1', baseX);
      stemLine.setAttribute('y1', baseY);
      stemLine.setAttribute('x2', baseX);
      stemLine.setAttribute('y2', baseY - stemH);
      stemLine.setAttribute('stroke', color);
      stemLine.setAttribute('stroke-width', 0.15);
      g.appendChild(stemLine);

      // 물결선 (wavy line) — 줄기 상단에 수평 물결
      const wavePath = createSvgElement('path');
      const waveY = baseY - stemH;
      const waveW = 1.5;
      const waveH = 0.4;
      const d = `M ${baseX - waveW} ${waveY} ` +
                `c ${waveW * 0.33} ${-waveH} ${waveW * 0.66} ${waveH} ${waveW} 0 ` +
                `c ${waveW * 0.33} ${-waveH} ${waveW * 0.66} ${waveH} ${waveW} 0`;
      wavePath.setAttribute('d', d);
      wavePath.setAttribute('fill', 'none');
      wavePath.setAttribute('stroke', color);
      wavePath.setAttribute('stroke-width', 0.15);
      wavePath.setAttribute('stroke-linecap', 'round');
      g.appendChild(wavePath);

      // 히트 영역
      const hitRect = createSvgElement('rect');
      hitRect.setAttribute('x', baseX - waveW - 2);
      hitRect.setAttribute('y', baseY - stemH - waveH - 2);
      hitRect.setAttribute('width', waveW * 2 + 4);
      hitRect.setAttribute('height', stemH + waveH + 4);
      hitRect.setAttribute('fill', 'transparent');
      hitRect.style.cursor = 'pointer';
      g.appendChild(hitRect);

      return g;
    }

    const triCount = el.triangles || 1;

    // ── 다듬질 기호: 정삼각형을 뒤집은 역삼각형(▽) ──
    //  다이얼로그 기호와 동일하게:
    //  - 정삼각형 비율 (폭 ≈ 높이, 정확히는 높이 = 밑변 × √3/2)
    //  - 삼각형끼리 서로 붙어있음 (간격 0)
    //  - 닫힌 삼각형 (상단 수평선 있음)
    //
    //  ▽▽  ← 두 역삼각형이 빈틈없이 붙어있는 모양
    //
    const TRI_W = 3;                    // 역삼각형 밑변(상단) 전체 폭
    const TRI_H = TRI_W * 0.866;       // 정삼각형 높이 = 밑변 × √3/2 ≈ 2.6
    const TRI_GAP = 0;                  // 간격 없음! 삼각형끼리 붙어있음
    const SW = 0.3;                     // 선 굵기

    const totalW = triCount * TRI_W;    // 간격 0이므로 단순 곱셈

    // baseX 중심 정렬
    const startX = baseX - totalW / 2;

    // ── 역삼각형 ▽ 나란히 붙여서 배열 ──
    for (let i = 0; i < triCount; i++) {
      const lx = startX + i * TRI_W;           // 이 삼각형의 왼쪽 상단 X
      const rx = lx + TRI_W;                    // 오른쪽 상단 X
      const cx = lx + TRI_W / 2;               // 중심(꼭짓점) X
      const topY = baseY - TRI_H;              // 상단 Y
      const tipY = baseY;                       // 꼭짓점 Y (표면)

      const triPath = createSvgElement('path');
      // 닫힌 역삼각형: 왼쪽위 → 꼭짓점(아래) → 오른쪽위 → Z(상단선 닫기)
      const d = `M ${lx} ${topY} L ${cx} ${tipY} L ${rx} ${topY} Z`;
      triPath.setAttribute('d', d);
      triPath.setAttribute('fill', 'none');
      triPath.setAttribute('stroke', color);
      triPath.setAttribute('stroke-width', SW);
      triPath.setAttribute('stroke-linejoin', 'miter');
      g.appendChild(triPath);
    }

    // 숫자 텍스트 표시하지 않음 (사용자 요청)

    // 히트 영역 (선택용)
    const hitPad = 2;
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', startX - hitPad);
    hitRect.setAttribute('y', baseY - TRI_H - hitPad);
    hitRect.setAttribute('width', totalW + hitPad * 2);
    hitRect.setAttribute('height', TRI_H + hitPad * 2);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Geometric Tolerance (기하공차 기입틀) ==========
  //
  // KS B 0608 규격 — 개선판 v33:
  //
  //  수정사항 (v33):
  //  1. 공차값은 1개만 표시 (stacked 제거)
  //  2. 반드시 치수선에 수평으로 지시선을 연결해서 공차값을 표시
  //     면/치수선 ─────── ┌───────┬─────────┬───────┐
  //                       │ 기호  │  수치   │데이텀 │
  //                       └───────┴─────────┴───────┘
  //     → 지시선은 순수 수평선만 허용 (수직/대각선 절대 불가)
  //  3. 화살표는 면(또는 치수선)의 연결점을 가리킴
  //  4. leaderSide: 'left' = 지시선이 박스 좌측, 'right' = 박스 우측
  //
  function renderGeoTolerance(el) {
    const g = createSvgElement('g');
    g.setAttribute('data-id', el.id);
    const color = el.color || '#000000';
    const SW = 0.4;
    const CELL_H = 8;
    const SYM_W = 8;
    const VAL_W = 20;
    const DAT_W = 8;
    const FS = 3.5;

    // ★ v33: 공차값은 1개만 표시
    const row = { symbolType: el.symbolType, value: el.value, datum: el.datum };

    const baseX = el.x;
    const baseY = el.y;
    const leaderSide = (el.leaderSide === 'right') ? 'right' : 'left';

    const hasDatum = row.datum && row.datum.length > 0;
    const showDatumCell = hasDatum || (el._datumEnabled && !hasDatum);
    const totalW = SYM_W + VAL_W + (showDatumCell ? DAT_W : 0);

    // ★ v37: 지시선 — 수평 직선 또는 직각 꺾임(엘보)
    //   수직 치수선의 경우 _leaderElbow = true → 수평 후 수직으로 꺾어서 박스 상단에 연결
    //   수평 치수선/외형선의 경우 기존처럼 순수 수평 지시선
    if (el._leaderX != null && el._leaderY != null) {
      const lx = el._leaderX;
      const ly = el._leaderY;
      const ARROW_L = 2.0;
      const ARROW_W = 0.8;

      if (el._leaderElbow) {
        // ── 직각 꺾임 (엘보) 지시선 ──
        // 치수선 끝점(lx, ly)에서 수평으로 나간 뒤 직각으로 꺾어 박스 상단 중앙에 연결
        const boxTopCenterX = baseX + totalW / 2;
        const boxTopY = baseY;
        const elbowX = boxTopCenterX;  // 꺾이는 지점 X = 박스 상단 중심 X
        const elbowY = ly;             // 꺾이는 지점 Y = 치수선 끝점 Y (수평 구간)

        // 수평 구간: 치수선 끝점 → 꺾이는 지점
        const hSeg = createSvgElement('line');
        hSeg.setAttribute('x1', lx);
        hSeg.setAttribute('y1', ly);
        hSeg.setAttribute('x2', elbowX);
        hSeg.setAttribute('y2', elbowY);
        hSeg.setAttribute('stroke', color);
        hSeg.setAttribute('stroke-width', SW);
        g.appendChild(hSeg);

        // 수직 구간: 꺾이는 지점 → 박스 상단 중앙
        const vSeg = createSvgElement('line');
        vSeg.setAttribute('x1', elbowX);
        vSeg.setAttribute('y1', elbowY);
        vSeg.setAttribute('x2', boxTopCenterX);
        vSeg.setAttribute('y2', boxTopY);
        vSeg.setAttribute('stroke', color);
        vSeg.setAttribute('stroke-width', SW);
        g.appendChild(vSeg);

        // 화살표: 치수선 끝점을 가리킴 (수평 방향)
        const arrowDirX = elbowX > lx ? -1 : 1;  // 화살촉은 치수선 방향
        const ax = lx;
        const ay = ly;
        const arrowPath = `M ${ax} ${ay} L ${ax - arrowDirX * ARROW_L} ${ay - ARROW_W} L ${ax - arrowDirX * ARROW_L} ${ay + ARROW_W} Z`;
        const arrow = createSvgElement('path');
        arrow.setAttribute('d', arrowPath);
        arrow.setAttribute('fill', color);
        arrow.setAttribute('stroke', 'none');
        g.appendChild(arrow);
      } else {
        // ── 순수 수평 지시선 (기존 v33 로직) ──
        let connX;
        const connY = baseY + CELL_H / 2;  // 박스 수직 중심
        if (leaderSide === 'left') {
          connX = baseX;
        } else {
          connX = baseX + totalW;
        }

        const hLine = createSvgElement('line');
        hLine.setAttribute('x1', lx);
        hLine.setAttribute('y1', connY);
        hLine.setAttribute('x2', connX);
        hLine.setAttribute('y2', connY);
        hLine.setAttribute('stroke', color);
        hLine.setAttribute('stroke-width', SW);
        g.appendChild(hLine);

        // 화살표 (면 쪽 끝에 삼각형 화살촉)
        const arrowTipX = lx;
        const arrowTipY = connY;
        const arrowDirX = connX > lx ? 1 : -1;
        const ax = arrowTipX;
        const ay = arrowTipY;
        const arrowPath = `M ${ax} ${ay} L ${ax + arrowDirX * ARROW_L} ${ay - ARROW_W} L ${ax + arrowDirX * ARROW_L} ${ay + ARROW_W} Z`;
        const arrow = createSvgElement('path');
        arrow.setAttribute('d', arrowPath);
        arrow.setAttribute('fill', color);
        arrow.setAttribute('stroke', 'none');
        g.appendChild(arrow);
      }
    }

    // ★ v33: 1행만 렌더링
    {
      const ry = baseY;

      // 외곽 사각형
      const rect = createSvgElement('rect');
      rect.setAttribute('x', baseX);
      rect.setAttribute('y', ry);
      rect.setAttribute('width', totalW);
      rect.setAttribute('height', CELL_H);
      rect.setAttribute('fill', 'white');
      rect.setAttribute('stroke', color);
      rect.setAttribute('stroke-width', SW);
      g.appendChild(rect);

      // 기호 칸 | 수치 칸 구분선
      const sep1 = createSvgElement('line');
      sep1.setAttribute('x1', baseX + SYM_W);
      sep1.setAttribute('y1', ry);
      sep1.setAttribute('x2', baseX + SYM_W);
      sep1.setAttribute('y2', ry + CELL_H);
      sep1.setAttribute('stroke', color);
      sep1.setAttribute('stroke-width', SW);
      g.appendChild(sep1);

      // 수치 칸 | 데이텀 칸 구분선
      if (showDatumCell) {
        const sep2 = createSvgElement('line');
        sep2.setAttribute('x1', baseX + SYM_W + VAL_W);
        sep2.setAttribute('y1', ry);
        sep2.setAttribute('x2', baseX + SYM_W + VAL_W);
        sep2.setAttribute('y2', ry + CELL_H);
        sep2.setAttribute('stroke', color);
        sep2.setAttribute('stroke-width', SW);
        g.appendChild(sep2);
      }

      // 기호 텍스트
      const symInfo = (typeof DrawingModel !== 'undefined' && DrawingModel.GDT_SYMBOLS)
        ? DrawingModel.GDT_SYMBOLS[row.symbolType] : null;
      const symChar = symInfo ? symInfo.symbol : '?';
      const symText = createSvgElement('text');
      symText.setAttribute('x', baseX + SYM_W / 2);
      symText.setAttribute('y', ry + CELL_H / 2 + FS * 0.35);
      symText.setAttribute('text-anchor', 'middle');
      symText.setAttribute('font-size', FS + 0.5);
      symText.setAttribute('fill', color);
      symText.setAttribute('font-family', "'Noto Sans', 'Arial', sans-serif");
      symText.textContent = symChar;
      g.appendChild(symText);

      // 수치 텍스트
      const valText = createSvgElement('text');
      valText.setAttribute('x', baseX + SYM_W + VAL_W / 2);
      valText.setAttribute('y', ry + CELL_H / 2 + FS * 0.35);
      valText.setAttribute('text-anchor', 'middle');
      valText.setAttribute('font-size', FS);
      valText.setAttribute('fill', color);
      valText.setAttribute('font-family', "'JetBrains Mono', monospace");
      valText.textContent = row.value || '';
      g.appendChild(valText);

      // 데이텀 텍스트
      if (showDatumCell) {
        const datText = createSvgElement('text');
        datText.setAttribute('x', baseX + SYM_W + VAL_W + DAT_W / 2);
        datText.setAttribute('y', ry + CELL_H / 2 + FS * 0.35);
        datText.setAttribute('text-anchor', 'middle');
        datText.setAttribute('font-size', FS);
        datText.setAttribute('fill', hasDatum ? color : '#999999');
        datText.setAttribute('font-weight', '600');
        datText.setAttribute('font-family', "'JetBrains Mono', monospace");
        datText.textContent = hasDatum ? row.datum : '—';
        g.appendChild(datText);
      }
    }

    // 히트 영역
    const maxW = SYM_W + VAL_W + DAT_W;
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', baseX - 2);
    hitRect.setAttribute('y', baseY - 2);
    hitRect.setAttribute('width', maxW + 4);
    hitRect.setAttribute('height', CELL_H + 4);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  /**
   * 인라인 데이텀 기호 — v33 사용하지 않음
   */
  function _renderInlineDatum(g, cx, topY, letter, color, sw, position) {
    // no-op
  }

  // ========== Datum Feature Symbol (데이텀 기호) ==========
  //
  // KS B 0608 규격 — 개선판 v33:
  //
  //  ★ 수정사항 (v33):
  //    1. 역삼각형의 윗부분(밑변 = 평평한 면)이 반드시 지시한 면에 닿아야 한다
  //    2. 수치입력박스(글자 상자)는 면에서 수직 방향으로 배치 (면에서 멀어지는 쪽)
  //
  //    (bx,by) = 삼각형 밑변 중심 = 면 위 접촉점
  //
  //    side='bottom' (면이 위, 기호가 아래로):
  //      ════════════  ← 면 (datum face)
  //         ▽         ← 역삼각형: 밑변(━)이 면에 닿음, 꼭짓점이 아래
  //         │         ← 줄기
  //       ┌───┐
  //       │ A │       ← 글자 상자
  //       └───┘
  //
  //    side='top' (면이 아래, 기호가 위로):
  //       ┌───┐
  //       │ A │
  //       └───┘
  //         │
  //         △         ← 역삼각형: 밑변이 아래(면에 닿음), 꼭짓점이 위
  //      ════════════  ← 면
  //
  function renderDatum(el) {
    const g = createSvgElement('g');
    g.setAttribute('data-id', el.id);
    const color = el.color || '#000000';
    const SW = 0.4;
    const TRI_SIZE = 4;
    const STEM_H = 3;
    const BOX_SIZE = 6;
    const FS = 4;

    let bx = el.x;   // 삼각형 밑변 중심 X (면 위 접촉점)
    let by = el.y;    // 삼각형 밑변 중심 Y (면 위 접촉점)
    // ★ v41-fix: 데이텀 방향 자동 보정 — 저장된 side 값이 잘못되어도 렌더링 시 올바르게 교정
    //   부품 외형선 바운딩박스 중심 기준으로:
    //   좌변(el.x < cx) → 'left'(왼쪽으로 확장), 우변(el.x >= cx) → 'right'(오른쪽으로 확장)
    //   윗변(el.y < cy) → 'top'(위쪽으로 확장),  아랫변(el.y >= cy) → 'bottom'(아래쪽으로 확장)
    let side = el.side || 'bottom';
    if (_partCenter) {
      const rawSide = el.side || 'bottom';
      if (rawSide === 'left' || rawSide === 'right') {
        // 수직면 — X 좌표로 좌/우 판정
        side = el.x < _partCenter.cx ? 'left' : 'right';
      } else {
        // 수평면 — Y 좌표로 상/하 판정
        side = el.y < _partCenter.cy ? 'top' : 'bottom';
      }
    }

    // 좁은 면 처리
    if (el._narrowFace) {
      const extOffset = 14;
      const EXT_DASH = '4 1 0.5 1';
      if ((side === 'bottom' || side === 'top') && el._extLineEndX != null) {
        bx = el._extLineEndX + extOffset;
        const extLine = createSvgElement('line');
        extLine.setAttribute('x1', el._extLineEndX);
        extLine.setAttribute('y1', by);
        extLine.setAttribute('x2', bx);
        extLine.setAttribute('y2', by);
        extLine.setAttribute('stroke', color);
        extLine.setAttribute('stroke-width', SW * 0.7);
        extLine.setAttribute('stroke-dasharray', EXT_DASH);
        g.appendChild(extLine);
      } else if ((side === 'left' || side === 'right') && el._extLineEndY != null) {
        by = el._extLineEndY + extOffset;
        const extLine = createSvgElement('line');
        extLine.setAttribute('x1', bx);
        extLine.setAttribute('y1', el._extLineEndY);
        extLine.setAttribute('x2', bx);
        extLine.setAttribute('y2', by);
        extLine.setAttribute('stroke', color);
        extLine.setAttribute('stroke-width', SW * 0.7);
        extLine.setAttribute('stroke-dasharray', EXT_DASH);
        g.appendChild(extLine);
      }
    }

    // ★ v33: 역삼각형 — 밑변(평평한 면)이 면에 닿고, 꼭짓점이 면에서 멀어짐
    //   (bx,by) = 면 위의 삼각형 밑변 중심
    //   dir = 면에서 멀어지는 방향 (+1=아래, -1=위)
    let triPath, stemX1, stemY1, stemX2, stemY2, boxCx, boxCy;
    const triH = TRI_SIZE * 0.866;

    if (side === 'bottom' || side === 'top') {
      // bottom: 면이 위에 있고, 기호가 아래로 뻗음 (dir=+1)
      // top:    면이 아래에 있고, 기호가 위로 뻗음 (dir=-1)
      const dir = side === 'bottom' ? 1 : -1;

      // 역삼각형: 밑변 좌(-TRI/2), 밑변 우(+TRI/2) → 꼭짓점(면에서 멀어짐)
      triPath = `M ${bx - TRI_SIZE/2} ${by} L ${bx + TRI_SIZE/2} ${by} L ${bx} ${by + dir * triH} Z`;

      stemX1 = bx; stemY1 = by + dir * triH;
      stemX2 = bx; stemY2 = by + dir * (triH + STEM_H);
      boxCx = bx;  boxCy = by + dir * (triH + STEM_H + BOX_SIZE / 2);
    } else {
      // left:  면이 오른쪽, 기호가 왼쪽으로 뻗음 (dir=-1)
      // right: 면이 왼쪽, 기호가 오른쪽으로 뻗음 (dir=+1)
      const dir = side === 'left' ? -1 : 1;

      triPath = `M ${bx} ${by - TRI_SIZE/2} L ${bx} ${by + TRI_SIZE/2} L ${bx + dir * triH} ${by} Z`;

      stemX1 = bx + dir * triH; stemY1 = by;
      stemX2 = bx + dir * (triH + STEM_H); stemY2 = by;
      boxCx = bx + dir * (triH + STEM_H + BOX_SIZE / 2); boxCy = by;
    }

    // 속 채움 역삼각형 (밑변이 면에 닿음)
    const tri = createSvgElement('path');
    tri.setAttribute('d', triPath);
    tri.setAttribute('fill', color);
    tri.setAttribute('stroke', color);
    tri.setAttribute('stroke-width', SW);
    g.appendChild(tri);

    // 줄기
    const stem = createSvgElement('line');
    stem.setAttribute('x1', stemX1);
    stem.setAttribute('y1', stemY1);
    stem.setAttribute('x2', stemX2);
    stem.setAttribute('y2', stemY2);
    stem.setAttribute('stroke', color);
    stem.setAttribute('stroke-width', SW);
    g.appendChild(stem);

    // 글자 상자
    const box = createSvgElement('rect');
    box.setAttribute('x', boxCx - BOX_SIZE / 2);
    box.setAttribute('y', boxCy - BOX_SIZE / 2);
    box.setAttribute('width', BOX_SIZE);
    box.setAttribute('height', BOX_SIZE);
    box.setAttribute('fill', 'white');
    box.setAttribute('stroke', color);
    box.setAttribute('stroke-width', SW);
    g.appendChild(box);

    // 문자
    const letter = createSvgElement('text');
    letter.setAttribute('x', boxCx);
    letter.setAttribute('y', boxCy + FS * 0.35);
    letter.setAttribute('text-anchor', 'middle');
    letter.setAttribute('font-size', FS);
    letter.setAttribute('fill', color);
    letter.setAttribute('font-weight', '600');
    letter.setAttribute('font-family', "'JetBrains Mono', monospace");
    letter.textContent = el.letter || 'A';
    g.appendChild(letter);

    // 히트 영역
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', Math.min(bx, boxCx) - BOX_SIZE);
    hitRect.setAttribute('y', Math.min(by, boxCy) - BOX_SIZE);
    hitRect.setAttribute('width', Math.abs(boxCx - bx) + BOX_SIZE * 2);
    hitRect.setAttribute('height', Math.abs(boxCy - by) + BOX_SIZE * 2);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Selection Highlight ==========
  // ★ v35: 선택 박스 — 회색 점선, 꼭짓점 핸들 제거, 점선 크기 30%, 5mm 오프셋
  //   1. 회색 점선 (파란색 → 회색), 꼭짓점 네모 핸들 없음
  //   2. 점선 패턴 30% 축소 (dash 1.2, gap 0.9)
  //   3. 면 선택 → 면이 박스 중앙, 치수 선택 → 치수선이 박스 중앙
  //   4. 박스 크기 = 선택 요소 바운드 + 오프셋 5mm (≈5px)
  // ★ v110: groupElements 인자 추가 — 그룹 요소 배열이 전달되면 union 바운드 계산
  function showSelection(element, groupElements) {
    clearSelection();
    if (!element) return;

    const OFFSET = 5;  // 5mm offset

    // ── v110: 단일 요소 바운드 계산 헬퍼 ──
    function _calcElementBounds(el) {
      let ex, ey, ew, eh;
      if (el.type === 'outline' || el.type === 'hiddenline' || el.type === 'centerline') {
        const x1 = Math.min(el.x1, el.x2);
        const y1 = Math.min(el.y1, el.y2);
        const x2 = Math.max(el.x1, el.x2);
        const y2 = Math.max(el.y1, el.y2);
        ew = (x2 - x1) || 1;
        eh = (y2 - y1) || 1;
        ex = x1;
        ey = y1;
      } else if (el.type === 'dimension') {
        const x1 = Math.min(el.x1, el.x2);
        const y1 = Math.min(el.y1, el.y2);
        const x2 = Math.max(el.x1, el.x2);
        const y2 = Math.max(el.y1, el.y2);
        const isH = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
        if (isH) {
          const dimLineY = y1 - ((el.offset != null) ? el.offset : 30);
          ex = x1; ey = dimLineY;
          ew = (x2 - x1) || 10; eh = 1;
        } else {
          const dimLineX = x1 - ((el.offset != null) ? el.offset : 30);
          ex = dimLineX; ey = y1;
          ew = 1; eh = (y2 - y1) || 10;
        }
      } else if (el.type === 'text') {
        // 텍스트: x,y 기준 + fontSize로 추정 바운드
        const fs = el.fontSize || 5;
        const textStr = el.text || '';
        const approxW = textStr.length * fs * 0.6;
        ex = el.x;
        ey = el.y - fs;
        ew = approxW || 10;
        eh = fs * 1.2;
      } else {
        const bounds = DrawingModel.getElementBounds(el);
        ex = bounds.x; ey = bounds.y;
        ew = bounds.width; eh = bounds.height;
      }
      return { x: ex, y: ey, w: ew, h: eh };
    }

    let bx, by, bw, bh;

    // ── v110: 그룹 선택 — 모든 그룹 요소의 union 바운드 계산 ──
    if (groupElements && groupElements.length > 1) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      groupElements.forEach(function(gel) {
        const b = _calcElementBounds(gel);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      });
      bx = minX;
      by = minY;
      bw = (maxX - minX) || 1;
      bh = (maxY - minY) || 1;
    } else {
      // 단일 요소 선택 (기존 로직)
      const sb = _calcElementBounds(element);
      bx = sb.x; by = sb.y; bw = sb.w; bh = sb.h;
    }

    // ── 선택 박스: 바운드 + 5mm 오프셋 ──
    const rect = createSvgElement('rect');
    rect.setAttribute('x', bx - OFFSET);
    rect.setAttribute('y', by - OFFSET);
    rect.setAttribute('width', bw + OFFSET * 2);
    rect.setAttribute('height', bh + OFFSET * 2);
    rect.setAttribute('class', 'selection-box');
    groups.selection.appendChild(rect);
    // ★ v35: 꼭짓점 핸들 제거 — 점선 네모만 표시
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

    // ★ v36: 연필 아이콘 제거 — 클릭 영역 방해 및 시각적 노이즈 제거
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
