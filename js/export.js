/* ============================================================
   export.js
   도면 내보내기 (SVG / DXF / PDF / JSON) — 기계도면 전용

   지원 요소: outline, centerline, hiddenline, hole, slot, hatch,
             dimension, text, paperBg,
             titleblock, noteblock, surfacefinish, geotolerance, datum

   v5: placeholder 요소 내보내기 지원
   v42: ★ 인쇄/내보내기 품질 대폭 개선
       1. 화살표 크기를 시스템 뷰와 동일하게 축소 (4×3 filled, userSpaceOnUse)
       2. 표제란·주서란·기하공차·다듬질기호·데이텀 내보내기 추가
       3. 치수 텍스트 배치를 renderer.js와 동일하게 통일
          (수평 중앙, 수직 중앙+오른쪽, 엘보 지시선, 치수공차)
   ============================================================ */

const Exporter = (() => {

  // ========== SVG Export ==========
  function exportSVG(doc) {
    const svgStr = buildSVGString(doc, true);
    download(svgStr, `${doc.meta.title || 'drawing'}.svg`, 'image/svg+xml');
    return svgStr;
  }

  /**
   * SVG 문자열 생성 (exportSVG, exportPDF 공용)
   */
  function buildSVGString(doc, withXmlDecl = false) {
    const bounds = DrawingModel.getAllBounds(doc.elements);
    const padding = 60;
    const w = bounds.width + padding * 2;
    const h = bounds.height + padding * 2;
    const vx = bounds.x - padding;
    const vy = bounds.y - padding;

    let svg = '';
    if (withXmlDecl) {
      svg += `<?xml version="1.0" encoding="UTF-8"?>\n`;
    }
    svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vx} ${vy} ${w} ${h}">\n`;

    // ★ v42: 화살표 마커 — renderer.js와 동일 크기 (AW=4, AH=3, filled, userSpaceOnUse)
    const AW = 4, AH = 3;
    svg += `<defs>
  <marker id="dimArrowStart" markerWidth="${AW}" markerHeight="${AH}" refX="0" refY="${AH/2}" orient="auto" markerUnits="userSpaceOnUse">
    <path d="M ${AW} 0 L 0 ${AH/2} L ${AW} ${AH}" fill="#60a5fa" stroke="none"/>
  </marker>
  <marker id="dimArrowEnd" markerWidth="${AW}" markerHeight="${AH}" refX="${AW}" refY="${AH/2}" orient="auto" markerUnits="userSpaceOnUse">
    <path d="M 0 0 L ${AW} ${AH/2} L 0 ${AH}" fill="#60a5fa" stroke="none"/>
  </marker>
</defs>\n`;
    svg += `<style>
  text { font-family: 'Arial', 'Helvetica', sans-serif; }
  .outline { stroke-linecap: round; }
</style>\n`;

    svg += `<rect x="${vx}" y="${vy}" width="${w}" height="${h}" fill="#f0e68c"/>\n`;

    // ★ v42: 데이텀 렌더링용 부품 외형선 바운딩박스 중심 계산
    let _partCenter = null;
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

    // 클립 정의 (해칭용)
    let defsContent = '';
    let hatchIndex = 0;

    doc.elements.forEach(el => {
      if (doc.layers[el.layer] && !doc.layers[el.layer].visible) return;

      // v5: confidence + placeholder 태그
      const confTag = el.confidence ? ` data-confidence="${el.confidence}"` : '';
      const phTag = el._isPlaceholder ? ' data-placeholder="true"' : '';

      switch (el.type) {
        case 'outline': {
          const edgeTag = el._edgeType ? ` data-edge-type="${el._edgeType}"` : '';
          svg += `<line class="outline"${confTag}${phTag}${edgeTag} x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.color || '#333'}" stroke-width="${el.thickness || 1}" stroke-linecap="round"${el.confidence === 'estimated' ? ' stroke-dasharray="6 3" opacity="0.7"' : ''}${el.confidence === 'uncertain' ? ' stroke-dasharray="2 4" opacity="0.4" stroke="#fbbf24"' : ''}${el._isPlaceholder ? ' stroke-dasharray="3 5" opacity="0.45" stroke="#6b7280"' : ''}/>\n`;
          break;
        }

        case 'centerline':
          svg += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.color || '#f87171'}" stroke-width="${el.thickness || 0.8}" stroke-dasharray="12 3 2 3" stroke-linecap="round"/>\n`;
          break;

        case 'hiddenline':
          svg += `<line class="hiddenline"${confTag}${phTag} x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.color || '#4ade80'}" stroke-width="${el.thickness || 1}" stroke-dasharray="6 3" stroke-linecap="round"/>\n`;
          break;

        case 'hole':
          svg += renderHoleSVG(el);
          break;

        case 'slot':
          svg += renderSlotSVG(el);
          break;

        case 'hatch': {
          const hId = `hatch_clip_${hatchIndex++}`;
          const hResult = renderHatchSVG(el, hId);
          defsContent += hResult.defs;
          svg += hResult.content;
          break;
        }

        case 'dimension':
          svg += renderDimensionSVG(el);
          break;

        case 'text': {
          const textFill = el._isPlaceholder ? '#6b7280' : (el.color || '#333');
          const textStyle = el._isPlaceholder ? ' font-style="italic" text-decoration="underline"' : '';
          svg += `<text${confTag}${phTag} x="${el.x}" y="${el.y}" fill="${textFill}" font-size="${el.fontSize || 14}" font-weight="${el.fontWeight || 'normal'}"${textStyle}${el._isPlaceholder ? ' opacity="0.45"' : ''}>${escapeXml(el.content)}</text>\n`;
          break;
        }

        case 'paperBg':
          svg += `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="${el.fill || '#ffffff'}" stroke="${el.stroke || '#000'}" stroke-width="${el.strokeWidth || 0.5}"/>\n`;
          break;

        // ★ v42: 새로 추가된 요소 타입들
        case 'titleblock':
          svg += renderTitleBlockSVG(el);
          break;

        case 'noteblock':
          svg += renderNoteBlockSVG(el);
          break;

        case 'surfacefinish':
          svg += renderSurfaceFinishSVG(el);
          break;

        case 'geotolerance':
          svg += renderGeoToleranceSVG(el);
          break;

        case 'datum':
          svg += renderDatumSVG(el, _partCenter);
          break;
      }
    });

    if (defsContent) {
      svg = svg.replace('</defs>\n', `${defsContent}</defs>\n`);
    }

    svg += '</svg>';
    return svg;
  }

  // ================================================================
  //  SVG Sub-renderers
  // ================================================================

  // ---------- Dimension (치수) — renderer.js 동일 로직 ----------
  function renderDimensionSVG(el) {
    const isH = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
    const off = (el.offset != null) ? el.offset : 30;
    const c = el.color || '#60a5fa';
    const fs = el.fontSize || 12;
    const ff = "'JetBrains Mono', 'Arial', monospace";
    const textStr = String(el.value || '');
    const textWidth = textStr.length * fs * 0.65;

    let lx1, ly1, lx2, ly2;
    if (isH) {
      ly1 = ly2 = Math.min(el.y1, el.y2) - off;
      lx1 = el.x1; lx2 = el.x2;
    } else {
      lx1 = lx2 = Math.min(el.x1, el.x2) - off;
      ly1 = el.y1; ly2 = el.y2;
    }

    const dimSpan = Math.sqrt((lx2 - lx1) ** 2 + (ly2 - ly1) ** 2);
    const isNarrow = dimSpan < textWidth + 20;

    const midX = (lx1 + lx2) / 2;
    const midY = (ly1 + ly2) / 2;

    // 엘보 상수 (renderer.js와 동일)
    const ELBOW_BASE_RISE = 10;
    const ELBOW_LEVEL_STEP = 12;
    const ELBOW_SHOULDER = 6;

    let s = `<g class="dimension">\n`;

    // Extension lines — 지름 치수(dimStyle=diameter)에서는 보조선 생략
    // ★ v119: 보조선을 실선으로 변경 + 화살표 위로 3mm(≈6px) 연장
    const isDiamDim = el.dimStyle === 'diameter';
    if (!isDiamDim) {
      const EXT_OVERSHOOT = 6;
      let ex1x = lx1, ex1y = ly1, ex2x = lx2, ex2y = ly2;
      if (isH) {
        const dir = (ly1 < el.y1) ? -1 : 1;
        ex1y = ly1 + dir * EXT_OVERSHOOT;
        ex2y = ly2 + dir * EXT_OVERSHOOT;
      } else {
        const dir = (lx1 < el.x1) ? -1 : 1;
        ex1x = lx1 + dir * EXT_OVERSHOOT;
        ex2x = lx2 + dir * EXT_OVERSHOOT;
      }
      s += `  <line x1="${el.x1}" y1="${el.y1}" x2="${ex1x}" y2="${ex1y}" stroke="${c}" stroke-width="0.5"/>\n`;
      s += `  <line x1="${el.x2}" y1="${el.y2}" x2="${ex2x}" y2="${ex2y}" stroke="${c}" stroke-width="0.5"/>\n`;
    }

    // Dimension line with arrows
    s += `  <line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="${c}" stroke-width="1" marker-start="url(#dimArrowStart)" marker-end="url(#dimArrowEnd)"/>\n`;

    // Text placement — renderer.js와 동일 로직
    let textX, textY, anchor;
    // 공차 기준점 (tolBaseX, tolCenterY)
    let tolBaseX, tolCenterY;

    if (isH) {
      if (!isNarrow) {
        // 수평 일반: 치수선 중앙 위
        textX = midX; textY = midY - 4; anchor = 'middle';
        tolBaseX = midX + textWidth / 2 + 1.5;
        tolCenterY = (midY - 4) - fs * 0.3;
      } else {
        // ★ v40/v42: 수평 좁은 → 엘보 지시선
        const level = el._narrowLeaderLevel || 0;
        const elbowRise = ELBOW_BASE_RISE + level * ELBOW_LEVEL_STEP;
        const elbowTopY = midY - elbowRise;
        const shoulderEndX = midX + ELBOW_SHOULDER + textWidth + 4;

        // 수직선
        s += `  <line x1="${midX}" y1="${midY}" x2="${midX}" y2="${elbowTopY}" stroke="${c}" stroke-width="0.5"/>\n`;
        // 수평 어깨선
        s += `  <line x1="${midX}" y1="${elbowTopY}" x2="${shoulderEndX}" y2="${elbowTopY}" stroke="${c}" stroke-width="0.5"/>\n`;

        textX = midX + ELBOW_SHOULDER; textY = elbowTopY - 2; anchor = 'start';
        tolBaseX = midX + ELBOW_SHOULDER + textWidth + 1.5;
        tolCenterY = (elbowTopY - 2) - fs * 0.3;
      }
    } else {
      // ★ v106: 수직 치수 — 텍스트를 -90° 회전하여 치수선에 평행, 왼쪽 배치
      textX = midX; textY = midY; anchor = 'middle';
      tolBaseX = midX + textWidth / 2 + 1.5;
      tolCenterY = midY - 4 - fs * 0.3;
    }

    if (isH) {
      s += `  <text x="${textX}" y="${textY}" text-anchor="${anchor}" fill="${c}" font-size="${fs}" font-family="${ff}" font-weight="500">${escapeXml(textStr)}</text>\n`;
    } else {
      // 수직: -90° 회전 + dy로 치수선 왼쪽에 배치
      s += `  <text x="${textX}" y="${textY}" text-anchor="${anchor}" fill="${c}" font-size="${fs}" font-family="${ff}" font-weight="500" dy="-4" transform="rotate(-90, ${midX}, ${midY})">${escapeXml(textStr)}</text>\n`;
    }

    // ── 치수공차 표시 (renderer.js와 동일) ──
    if (el.tolerance && (el.toleranceUpper || el.toleranceLower)) {
      const tolFS = fs * 0.42;
      const tolRot = !isH ? ` transform="rotate(-90, ${midX}, ${midY})"` : '';

      if (el.toleranceUpper) {
        const uVal = el.toleranceUpper.toString();
        const uStr = uVal.startsWith('+') || uVal.startsWith('-') ? uVal : `+${uVal}`;
        s += `  <text x="${tolBaseX}" y="${tolCenterY - 0.5}" text-anchor="start" fill="${c}" font-size="${tolFS}" font-family="${ff}" dominant-baseline="auto"${tolRot}>${escapeXml(uStr)}</text>\n`;
      }
      if (el.toleranceLower) {
        const lVal = el.toleranceLower.toString();
        const lStr = lVal.startsWith('+') || lVal.startsWith('-') ? lVal : `-${lVal}`;
        s += `  <text x="${tolBaseX}" y="${tolCenterY + tolFS * 0.85 + 0.5}" text-anchor="start" fill="${c}" font-size="${tolFS}" font-family="${ff}" dominant-baseline="auto"${tolRot}>${escapeXml(lStr)}</text>\n`;
      }
    }

    s += `</g>\n`;
    return s;
  }

  // ---------- Hole ----------
  function renderHoleSVG(el) {
    const r = el.diameter / 2;
    const c = el.color || '#a78bfa';
    let s = `<g class="hole">`;
    s += `<circle cx="${el.cx}" cy="${el.cy}" r="${r}" fill="none" stroke="${c}" stroke-width="1.5"`;
    if (el.holeType === 'tap') s += ` stroke-dasharray="3 2"`;
    s += `/>\n`;

    const cm = r * 0.4;
    s += `<line x1="${el.cx - cm}" y1="${el.cy}" x2="${el.cx + cm}" y2="${el.cy}" stroke="${c}" stroke-width="0.5"/>`;
    s += `<line x1="${el.cx}" y1="${el.cy - cm}" x2="${el.cx}" y2="${el.cy + cm}" stroke="${c}" stroke-width="0.5"/>`;

    if (el.tapSpec) {
      s += `<text x="${el.cx + r + 4}" y="${el.cy - r - 2}" fill="${c}" font-size="9" font-family="Arial">${escapeXml(el.tapSpec)}</text>`;
    }
    s += `</g>\n`;
    return s;
  }

  // ---------- Slot ----------
  function renderSlotSVG(el) {
    const c = el.color || '#fbbf24';
    const rx = el.height / 2;
    const slotShape = el.slotShape || 'obround';  // v117: 키 형상
    let s = `<g class="slot">`;

    // v118: 외형선 두께 통일
    const sw = el.strokeWidth || 1;

    if (slotShape === 'one-side-round') {
      // ★ v117+v118: 한쪽 둥근형 — slotRoundSide에 따라 둥근 쪽 결정
      const roundSide = el.slotRoundSide || 'right';
      const x = el.x, y = el.y, w = el.width, h = el.height;
      const r = h / 2;
      let d;
      if (roundSide === 'left') {
        const arcEndX = x + r;
        d = `M ${x + w} ${y} L ${arcEndX} ${y} A ${r} ${r} 0 0 0 ${arcEndX} ${y + h} L ${x + w} ${y + h} Z`;
      } else {
        const arcStartX = x + w - r;
        d = `M ${x} ${y} L ${arcStartX} ${y} A ${r} ${r} 0 0 1 ${arcStartX} ${y + h} L ${x} ${y + h} Z`;
      }
      s += `<path d="${d}" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
    } else if (slotShape === 'rect') {
      // ★ v117: 양쪽 네모형
      s += `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="0" ry="0" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
    } else {
      // 양쪽 둥근형 (obround) — 기존
      s += `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${rx}" ry="${rx}" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
    }

    const cy = el.y + el.height / 2;
    s += `<line x1="${el.x + 2}" y1="${cy}" x2="${el.x + el.width - 2}" y2="${cy}" stroke="${c}" stroke-width="0.4" stroke-dasharray="4 2"/>`;
    s += `</g>\n`;
    return s;
  }

  // ---------- Hatch ----------
  function renderHatchSVG(el, clipId) {
    if (!el.points || el.points.length < 3) return { defs: '', content: '' };
    const pointsStr = el.points.map(p => `${p.x},${p.y}`).join(' ');
    const c = el.color || '#475569';
    let defs = `<clipPath id="${clipId}"><polygon points="${pointsStr}"/></clipPath>\n`;
    let content = `<g class="hatch">`;
    content += `<polygon points="${pointsStr}" fill="none" stroke="${c}" stroke-width="0.5"/>`;
    const b = DrawingModel.getElementBounds(el);
    const spacing = el.spacing || 4;
    const angle = (el.angle || 45) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const diag = Math.sqrt(b.width ** 2 + b.height ** 2);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const n = Math.ceil(diag / spacing) + 2;
    content += `<g clip-path="url(#${clipId})">`;
    for (let i = -n; i <= n; i++) {
      const o = i * spacing;
      const x1 = cx + o * cos - diag * sin;
      const y1 = cy + o * sin + diag * cos;
      const x2 = cx + o * cos + diag * sin;
      const y2 = cy + o * sin - diag * cos;
      content += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="0.4"/>`;
    }
    content += `</g></g>\n`;
    return { defs, content };
  }


  // ================================================================
  //  ★ v42 신규: Title Block (표제란)
  // ================================================================
  function renderTitleBlockSVG(el) {
    const W = el.width || 200;
    const x = el.x;
    const y = el.y;
    const fs = el.fontSize || 4.5;
    const ff = "'Malgun Gothic', 'Arial', sans-serif";
    const sc = '#000000';

    // 헬퍼
    function ln(x1, y1, x2, y2, sw) {
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${sc}" stroke-width="${sw || 0.25}"/>\n`;
    }
    function rc(rx, ry, rw, rh, sw) {
      return `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="${sc}" stroke-width="${sw || 0.25}"/>\n`;
    }
    function tx(tx, ty, content, size, anchor, weight) {
      return `<text x="${tx}" y="${ty}" fill="${sc}" font-size="${size || fs}" font-family="${ff}" text-anchor="${anchor || 'middle'}" dominant-baseline="central"${weight ? ` font-weight="${weight}"` : ''}>${escapeXml(content)}</text>\n`;
    }

    let s = `<g class="titleblock">\n`;

    // 행 높이
    const ROW_MID1 = 8, ROW_MID2 = 8, ROW_MID3 = 6;
    const ROW_REV_HDR = 7, ROW_REV_DATA = 8;
    const MAIN_H = ROW_MID1 + ROW_MID2 + ROW_MID3;
    const REV_H = ROW_REV_HDR + ROW_REV_DATA;
    const TOTAL_H = MAIN_H + REV_H;

    // 열 분할
    const LEFT_W = W * 0.46;
    const RIGHT_W = W - LEFT_W;
    const CL = LEFT_W;
    const C_SCALE_LBL = CL * 0.14;
    const C_SCALE_VAL = CL * 0.30;
    const C_DESIGN = CL * 0.20;
    const C_CHECK = CL * 0.18;
    const C_APPR = CL - C_SCALE_LBL - C_SCALE_VAL - C_DESIGN - C_CHECK;
    const infoCols = [C_SCALE_LBL, C_SCALE_VAL, C_DESIGN, C_CHECK, C_APPR];

    const CR_LABEL = RIGHT_W * 0.24;
    const CR_VALUE = RIGHT_W - CR_LABEL;

    // 리비전 열
    const RC_SYM = W * 0.06;
    const RC_REVISION = W * 0.18;
    const RC_DATE = W * 0.08;
    const RC_SIGN = W * 0.07;
    const RC_CHECK = W * 0.08;
    const RC_APPR = W * 0.08;
    const RC_REF = W - RC_SYM - RC_REVISION - RC_DATE - RC_SIGN - RC_CHECK - RC_APPR;

    // Y 기준
    const y0 = y;
    const y1 = y0 + ROW_MID1;
    const y2 = y1 + ROW_MID2;
    const y3 = y2 + ROW_MID3;
    const y4 = y3 + ROW_REV_HDR;
    const y5 = y3 + REV_H;
    const xR = x + LEFT_W;

    // 1. 외곽선
    s += rc(x, y0, W, TOTAL_H, 0.8);

    // 2. 좌우 분할선
    s += ln(xR, y0, xR, y3, 0.4);

    // 3. 좌측 정보행 세로 구분선
    let cx = x;
    for (let i = 0; i < infoCols.length; i++) {
      cx += infoCols[i];
      if (i < infoCols.length - 1) s += ln(cx, y0, cx, y3, 0.2);
    }

    // 가로 구분선
    const scaleValEnd = x + C_SCALE_LBL + C_SCALE_VAL;
    s += ln(x, y1, scaleValEnd, y1, 0.2);
    s += ln(scaleValEnd, y1, xR, y1, 0.15);
    s += ln(x, y2, scaleValEnd, y2, 0.2);

    // 정보행 1: SCALE | 값 | DESIGN | CHECK | APPR
    cx = x;
    s += tx(cx + C_SCALE_LBL / 2, y0 + ROW_MID1 / 2, 'SCALE', fs - 0.5, 'middle', '600');
    cx += C_SCALE_LBL;
    s += tx(cx + C_SCALE_VAL / 2, y0 + ROW_MID1 / 2, el.scale || '1:1', fs);
    cx += C_SCALE_VAL;
    s += tx(cx + C_DESIGN / 2, y0 + ROW_MID1 / 2, 'DESIGN', fs - 0.5, 'middle', '600');
    cx += C_DESIGN;
    s += tx(cx + C_CHECK / 2, y0 + ROW_MID1 / 2, 'CHECK', fs - 0.5, 'middle', '600');
    cx += C_CHECK;
    s += tx(cx + C_APPR / 2, y0 + ROW_MID1 / 2, 'APPR', fs - 0.5, 'middle', '600');

    // 정보행 2: UNIT | 값
    s += tx(x + C_SCALE_LBL / 2, y1 + ROW_MID2 / 2, 'UNIT', fs - 0.5, 'middle', '600');
    s += tx(x + C_SCALE_LBL + C_SCALE_VAL / 2, y1 + ROW_MID2 / 2, el.unit || 'mm', fs);

    // 정보행 3: DATE | 값
    s += tx(x + C_SCALE_LBL / 2, y2 + ROW_MID3 / 2, 'DATE', fs - 0.5, 'middle', '600');
    s += tx(x + C_SCALE_LBL + C_SCALE_VAL / 2, y2 + ROW_MID3 / 2, el.date || '', fs - 0.5);

    // 4. 우측: DWG NO | NAME
    s += ln(xR + CR_LABEL, y0, xR + CR_LABEL, y3, 0.2);
    const rMidH = y2 - y0;
    s += tx(xR + CR_LABEL / 2, y0 + rMidH / 2, 'DWG NO', fs - 1, 'middle', '600');
    s += tx(xR + CR_LABEL + 2, y0 + 2.5, 'NAME', fs - 1, 'start', '600');

    // 도면명
    const nameAreaH = y2 - y0;
    const nameFS = (fs + 2) / 2;
    const nameStr = el.drawingName || '';
    const nameCenterX = xR + CR_LABEL + CR_VALUE / 2;
    const namePadding = 4;
    const nameAvailW = CR_VALUE - namePadding;
    const nameTextW = Array.from(nameStr).reduce((sum, ch) =>
      sum + (/[\u3131-\uD79D]/.test(ch) ? nameFS * 0.85 : nameFS * 0.55), 0);

    if (nameTextW <= nameAvailW || nameStr.length === 0) {
      const hasSub = !!(el.drawingNameSub);
      const nameY = hasSub ? y0 + nameAreaH * 0.42 : y0 + nameAreaH / 2;
      s += tx(nameCenterX, nameY, nameStr, nameFS, 'middle', '700');
    } else {
      let splitIdx = -1;
      const halfLen = Math.ceil(nameStr.length / 2);
      for (let si = halfLen; si >= halfLen - 5 && si >= 0; si--) {
        if (nameStr[si] === ' ') { splitIdx = si; break; }
      }
      if (splitIdx < 0) {
        for (let sj = halfLen; sj <= halfLen + 5 && sj < nameStr.length; sj++) {
          if (nameStr[sj] === ' ') { splitIdx = sj; break; }
        }
      }
      if (splitIdx < 0) splitIdx = halfLen;
      const line1 = nameStr.substring(0, splitIdx).trim();
      const line2 = nameStr.substring(splitIdx).trim();
      const hasSub2 = !!(el.drawingNameSub);
      const lineGap = nameFS * 1.4;
      const baseY = hasSub2 ? y0 + nameAreaH * 0.32 : y0 + nameAreaH / 2 - lineGap / 2;
      s += tx(nameCenterX, baseY, line1, nameFS, 'middle', '700');
      s += tx(nameCenterX, baseY + lineGap, line2, nameFS, 'middle', '700');
    }

    if (el.drawingNameSub) {
      s += tx(nameCenterX, y0 + nameAreaH * 0.82, 'for  ' + el.drawingNameSub, fs - 0.5, 'middle');
    }

    // TTL.PRJ
    s += ln(xR + CR_LABEL, y2, x + W, y2, 0.2);
    const ttlX = xR + CR_LABEL;
    const ttlLblW = CR_VALUE * 0.30;
    const ttlValW = CR_VALUE - ttlLblW;
    s += ln(ttlX + ttlLblW, y2, ttlX + ttlLblW, y3, 0.2);
    s += tx(ttlX + ttlLblW / 2, y2 + ROW_MID3 / 2, 'TTL.PRJ', fs - 1, 'middle', '600');
    s += tx(ttlX + ttlLblW + ttlValW / 2, y2 + ROW_MID3 / 2, el.titlePrj || '', fs - 1);

    // 5. 리비전 테이블
    s += ln(x, y3, x + W, y3, 0.4);
    const revLabels = ['SYM', 'REVISION', 'DATE', 'SIGN', 'CHECK', 'APPR', 'REFERENCE DRAWING'];
    const revColWidths = [RC_SYM, RC_REVISION, RC_DATE, RC_SIGN, RC_CHECK, RC_APPR, RC_REF];
    cx = x;
    for (let i = 0; i < revLabels.length; i++) {
      const cw = revColWidths[i];
      s += tx(cx + cw / 2, y3 + ROW_REV_HDR / 2, revLabels[i], fs - 1, 'middle', '600');
      cx += cw;
      if (i < revLabels.length - 1) s += ln(cx, y3, cx, y5, 0.15);
    }
    s += ln(x, y4, x + W, y4, 0.2);

    // 리비전 데이터
    const revRows = el.revisionRows || [];
    if (revRows.length > 0) {
      const rv = revRows[0];
      cx = x;
      const revFields = ['sym', 'revision', 'date', 'sign', 'check', 'appr', 'reference'];
      for (let i = 0; i < revFields.length; i++) {
        const cw = revColWidths[i];
        const val = rv[revFields[i]] || '';
        if (val) s += tx(cx + cw / 2, y4 + ROW_REV_DATA / 2, val, fs - 0.5);
        cx += cw;
      }
    }

    // 6. 용지 크기
    const paperSizes = { A3: '420x297mm', A2: '594x420mm', A4: '297x210mm', A1: '841x594mm' };
    const ps = el.paperSize || 'A3';
    const psText = ps + '(' + (paperSizes[ps] || '420x297mm') + ')';
    s += tx(x + W - 2, y5 + 3, psText, fs - 1, 'end');

    s += `</g>\n`;
    return s;
  }


  // ================================================================
  //  ★ v42 신규: Note Block (주서란)
  // ================================================================
  function renderNoteBlockSVG(el) {
    const lines = el.lines || [];
    if (lines.length === 0) return '';
    const x = el.x || 0;
    const y = el.y || 0;
    const fontSize = el.fontSize || 10;
    const lineH = fontSize * (el.lineHeight || 1.6);
    const ff = el.fontFamily || "'Malgun Gothic', 'Arial', sans-serif";
    const color = el.color || '#000000';
    const titleColor = el.titleColor || '#000000';

    let s = `<g class="noteblock">\n`;
    // NOTE 타이틀
    s += `  <text x="${x}" y="${y}" fill="${titleColor}" font-size="${fontSize + 2}" font-family="${ff}" font-weight="700" text-anchor="start">NOTE</text>\n`;
    // 각 줄
    lines.forEach((line, idx) => {
      const lineY = y + (idx + 1) * lineH;
      s += `  <text x="${x}" y="${lineY}" fill="${color}" font-size="${fontSize}" font-family="${ff}" text-anchor="start">${escapeXml(`${idx + 1}. ${line}`)}</text>\n`;
    });
    s += `</g>\n`;
    return s;
  }


  // ================================================================
  //  ★ v42 신규: Surface Finish (다듬질 기호)
  // ================================================================
  function renderSurfaceFinishSVG(el) {
    const color = el.color || '#000000';
    const rot = el.rotation || 0;
    const baseX = el.x;
    const baseY = el.y;
    let s = `<g class="surfacefinish"`;
    if (rot !== 0) s += ` transform="rotate(${rot}, ${baseX}, ${baseY})"`;
    s += `>\n`;

    if (el.grade === 'none') {
      // 다듬질 안함: 줄기 + 물결선
      const stemH = 2;
      s += `  <line x1="${baseX}" y1="${baseY}" x2="${baseX}" y2="${baseY - stemH}" stroke="${color}" stroke-width="0.15"/>\n`;
      const waveY = baseY - stemH;
      const waveW = 1.5;
      const waveH = 0.4;
      const d = `M ${baseX - waveW} ${waveY} c ${waveW * 0.33} ${-waveH} ${waveW * 0.66} ${waveH} ${waveW} 0 c ${waveW * 0.33} ${-waveH} ${waveW * 0.66} ${waveH} ${waveW} 0`;
      s += `  <path d="${d}" fill="none" stroke="${color}" stroke-width="0.15" stroke-linecap="round"/>\n`;
      s += `</g>\n`;
      return s;
    }

    const triCount = el.triangles || 1;
    const TRI_W = 3;
    const TRI_H = TRI_W * 0.866;
    const SW = 0.3;
    const totalW = triCount * TRI_W;
    const startX = baseX - totalW / 2;

    for (let i = 0; i < triCount; i++) {
      const lx = startX + i * TRI_W;
      const rx = lx + TRI_W;
      const cx = lx + TRI_W / 2;
      const topY = baseY - TRI_H;
      const tipY = baseY;
      const d = `M ${lx} ${topY} L ${cx} ${tipY} L ${rx} ${topY} Z`;
      s += `  <path d="${d}" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linejoin="miter"/>\n`;
    }

    s += `</g>\n`;
    return s;
  }


  // ================================================================
  //  ★ v42 신규: Geometric Tolerance (기하공차)
  // ================================================================
  function renderGeoToleranceSVG(el) {
    const color = el.color || '#000000';
    const SW = 0.4;
    const CELL_H = 8;
    const SYM_W = 8;
    const VAL_W = 20;
    const DAT_W = 8;
    const FS = 3.5;

    const row = { symbolType: el.symbolType, value: el.value, datum: el.datum };
    const baseX = el.x;
    const baseY = el.y;
    const leaderSide = (el.leaderSide === 'right') ? 'right' : 'left';

    const hasDatum = row.datum && row.datum.length > 0;
    const showDatumCell = hasDatum || (el._datumEnabled && !hasDatum);
    const totalW = SYM_W + VAL_W + (showDatumCell ? DAT_W : 0);

    let s = `<g class="geotolerance">\n`;

    // 지시선
    if (el._leaderX != null && el._leaderY != null) {
      const lx = el._leaderX;
      const ly = el._leaderY;
      const ARROW_L = 2.0;
      const ARROW_W = 0.8;

      if (el._leaderElbow) {
        // 직각 꺾임 지시선
        const boxTopCenterX = baseX + totalW / 2;
        const boxTopY = baseY;
        const elbowX = boxTopCenterX;
        const elbowY = ly;

        s += `  <line x1="${lx}" y1="${ly}" x2="${elbowX}" y2="${elbowY}" stroke="${color}" stroke-width="${SW}"/>\n`;
        s += `  <line x1="${elbowX}" y1="${elbowY}" x2="${boxTopCenterX}" y2="${boxTopY}" stroke="${color}" stroke-width="${SW}"/>\n`;

        const arrowDirX = elbowX > lx ? -1 : 1;
        const arrowPath = `M ${lx} ${ly} L ${lx - arrowDirX * ARROW_L} ${ly - ARROW_W} L ${lx - arrowDirX * ARROW_L} ${ly + ARROW_W} Z`;
        s += `  <path d="${arrowPath}" fill="${color}" stroke="none"/>\n`;
      } else {
        // 순수 수평 지시선
        const connX = leaderSide === 'left' ? baseX : baseX + totalW;
        const connY = baseY + CELL_H / 2;

        s += `  <line x1="${lx}" y1="${connY}" x2="${connX}" y2="${connY}" stroke="${color}" stroke-width="${SW}"/>\n`;

        const arrowDirX = connX > lx ? 1 : -1;
        const arrowPath = `M ${lx} ${connY} L ${lx + arrowDirX * ARROW_L} ${connY - ARROW_W} L ${lx + arrowDirX * ARROW_L} ${connY + ARROW_W} Z`;
        s += `  <path d="${arrowPath}" fill="${color}" stroke="none"/>\n`;
      }
    }

    // 기입틀 박스
    s += `  <rect x="${baseX}" y="${baseY}" width="${totalW}" height="${CELL_H}" fill="white" stroke="${color}" stroke-width="${SW}"/>\n`;
    // 기호/수치 구분선
    s += `  <line x1="${baseX + SYM_W}" y1="${baseY}" x2="${baseX + SYM_W}" y2="${baseY + CELL_H}" stroke="${color}" stroke-width="${SW}"/>\n`;
    // 수치/데이텀 구분선
    if (showDatumCell) {
      s += `  <line x1="${baseX + SYM_W + VAL_W}" y1="${baseY}" x2="${baseX + SYM_W + VAL_W}" y2="${baseY + CELL_H}" stroke="${color}" stroke-width="${SW}"/>\n`;
    }

    // 기호
    const symInfo = (typeof DrawingModel !== 'undefined' && DrawingModel.GDT_SYMBOLS)
      ? DrawingModel.GDT_SYMBOLS[row.symbolType] : null;
    const symChar = symInfo ? symInfo.symbol : '?';
    s += `  <text x="${baseX + SYM_W / 2}" y="${baseY + CELL_H / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS + 0.5}" fill="${color}" font-family="'Noto Sans', 'Arial', sans-serif">${escapeXml(symChar)}</text>\n`;

    // 수치
    s += `  <text x="${baseX + SYM_W + VAL_W / 2}" y="${baseY + CELL_H / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" fill="${color}" font-family="'JetBrains Mono', monospace">${escapeXml(row.value || '')}</text>\n`;

    // 데이텀
    if (showDatumCell) {
      const datColor = hasDatum ? color : '#999999';
      const datStr = hasDatum ? row.datum : '—';
      s += `  <text x="${baseX + SYM_W + VAL_W + DAT_W / 2}" y="${baseY + CELL_H / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" fill="${datColor}" font-weight="600" font-family="'JetBrains Mono', monospace">${escapeXml(datStr)}</text>\n`;
    }

    s += `</g>\n`;
    return s;
  }


  // ================================================================
  //  ★ v42 신규: Datum Feature Symbol (데이텀 기호)
  // ================================================================
  function renderDatumSVG(el, _partCenter) {
    const color = el.color || '#000000';
    const SW = 0.4;
    const TRI_SIZE = 4;
    const STEM_H = 3;
    const BOX_SIZE = 6;
    const FS = 4;

    let bx = el.x;
    let by = el.y;

    // ★ v41-fix: 데이텀 방향 자동 보정 (renderer.js와 동일)
    let side = el.side || 'bottom';
    if (_partCenter) {
      const rawSide = el.side || 'bottom';
      if (rawSide === 'left' || rawSide === 'right') {
        side = el.x < _partCenter.cx ? 'left' : 'right';
      } else {
        side = el.y < _partCenter.cy ? 'top' : 'bottom';
      }
    }

    let s = `<g class="datum">\n`;

    // 좁은 면 처리
    if (el._narrowFace) {
      const extOffset = 14;
      const EXT_DASH = '4 1 0.5 1';
      if ((side === 'bottom' || side === 'top') && el._extLineEndX != null) {
        bx = el._extLineEndX + extOffset;
        s += `  <line x1="${el._extLineEndX}" y1="${by}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="${SW * 0.7}" stroke-dasharray="${EXT_DASH}"/>\n`;
      } else if ((side === 'left' || side === 'right') && el._extLineEndY != null) {
        by = el._extLineEndY + extOffset;
        s += `  <line x1="${bx}" y1="${el._extLineEndY}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="${SW * 0.7}" stroke-dasharray="${EXT_DASH}"/>\n`;
      }
    }

    // 삼각형 + 줄기 + 글자 상자
    const triH = TRI_SIZE * 0.866;
    let triPath, stemX1, stemY1, stemX2, stemY2, boxCx, boxCy;

    if (side === 'bottom' || side === 'top') {
      const dir = side === 'bottom' ? 1 : -1;
      triPath = `M ${bx - TRI_SIZE/2} ${by} L ${bx + TRI_SIZE/2} ${by} L ${bx} ${by + dir * triH} Z`;
      stemX1 = bx; stemY1 = by + dir * triH;
      stemX2 = bx; stemY2 = by + dir * (triH + STEM_H);
      boxCx = bx;  boxCy = by + dir * (triH + STEM_H + BOX_SIZE / 2);
    } else {
      const dir = side === 'left' ? -1 : 1;
      triPath = `M ${bx} ${by - TRI_SIZE/2} L ${bx} ${by + TRI_SIZE/2} L ${bx + dir * triH} ${by} Z`;
      stemX1 = bx + dir * triH; stemY1 = by;
      stemX2 = bx + dir * (triH + STEM_H); stemY2 = by;
      boxCx = bx + dir * (triH + STEM_H + BOX_SIZE / 2); boxCy = by;
    }

    // 삼각형
    s += `  <path d="${triPath}" fill="${color}" stroke="${color}" stroke-width="${SW}"/>\n`;
    // 줄기
    s += `  <line x1="${stemX1}" y1="${stemY1}" x2="${stemX2}" y2="${stemY2}" stroke="${color}" stroke-width="${SW}"/>\n`;
    // 글자 상자
    s += `  <rect x="${boxCx - BOX_SIZE/2}" y="${boxCy - BOX_SIZE/2}" width="${BOX_SIZE}" height="${BOX_SIZE}" fill="white" stroke="${color}" stroke-width="${SW}"/>\n`;
    // 문자
    s += `  <text x="${boxCx}" y="${boxCy + FS * 0.35}" text-anchor="middle" font-size="${FS}" fill="${color}" font-weight="600" font-family="'JetBrains Mono', monospace">${escapeXml(el.letter || 'A')}</text>\n`;

    s += `</g>\n`;
    return s;
  }


  // ========== DXF Export ==========
  function exportDXF(doc) {
    let dxf = `0\nSECTION\n2\nHEADER\n0\nENDSEC\n`;
    dxf += `0\nSECTION\n2\nTABLES\n0\nENDSEC\n`;
    dxf += `0\nSECTION\n2\nENTITIES\n`;

    doc.elements.forEach(el => {
      if (doc.layers[el.layer] && !doc.layers[el.layer].visible) return;

      switch (el.type) {
        case 'outline':
          dxf += dxfLine(el.x1, el.y1, el.x2, el.y2, 'OUTLINES');
          break;

        case 'centerline':
          dxf += dxfLine(el.x1, el.y1, el.x2, el.y2, 'CENTERLINES');
          break;

        case 'hiddenline':
          dxf += dxfLine(el.x1, el.y1, el.x2, el.y2, 'HIDDENLINES');
          break;

        case 'hole':
          dxf += dxfCircle(el.cx, el.cy, el.diameter / 2, 'HOLES');
          if (el.tapSpec) {
            dxf += dxfText(el.cx + el.diameter / 2 + 4, el.cy, el.tapSpec, 9, 'HOLES');
          }
          break;

        case 'slot':
          dxf += dxfLine(el.x, el.y, el.x + el.width, el.y, 'SLOTS');
          dxf += dxfLine(el.x + el.width, el.y, el.x + el.width, el.y + el.height, 'SLOTS');
          dxf += dxfLine(el.x + el.width, el.y + el.height, el.x, el.y + el.height, 'SLOTS');
          dxf += dxfLine(el.x, el.y + el.height, el.x, el.y, 'SLOTS');
          break;

        case 'hatch':
          if (el.points && el.points.length >= 2) {
            for (let i = 0; i < el.points.length; i++) {
              const p1 = el.points[i];
              const p2 = el.points[(i + 1) % el.points.length];
              dxf += dxfLine(p1.x, p1.y, p2.x, p2.y, 'HATCHING');
            }
          }
          break;

        case 'dimension': {
          const isH = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
          const off = (el.offset != null) ? el.offset : 30;
          let lx1, ly1, lx2, ly2;
          if (isH) { ly1 = ly2 = Math.min(el.y1, el.y2) - off; lx1 = el.x1; lx2 = el.x2; }
          else { lx1 = lx2 = Math.min(el.x1, el.x2) - off; ly1 = el.y1; ly2 = el.y2; }
          dxf += dxfLine(lx1, ly1, lx2, ly2, 'DIMENSIONS');
          dxf += dxfText((lx1 + lx2) / 2, (ly1 + ly2) / 2, el.value, el.fontSize || 12, 'DIMENSIONS');
          break;
        }

        case 'text':
          dxf += dxfText(el.x, el.y, el.content, el.fontSize || 14, 'TEXT');
          break;

        case 'paperBg':
          dxf += dxfLine(el.x, el.y, el.x + el.width, el.y, 'OUTLINES');
          dxf += dxfLine(el.x + el.width, el.y, el.x + el.width, el.y + el.height, 'OUTLINES');
          dxf += dxfLine(el.x + el.width, el.y + el.height, el.x, el.y + el.height, 'OUTLINES');
          dxf += dxfLine(el.x, el.y + el.height, el.x, el.y, 'OUTLINES');
          break;
      }
    });

    dxf += `0\nENDSEC\n0\nEOF\n`;
    download(dxf, `${doc.meta.title || 'drawing'}.dxf`, 'application/dxf');
    return dxf;
  }

  function dxfLine(x1, y1, x2, y2, layer = '0') {
    return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${-y1}\n30\n0\n11\n${x2}\n21\n${-y2}\n31\n0\n`;
  }

  function dxfText(x, y, text, size, layer = '0') {
    return `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${-y}\n30\n0\n40\n${size}\n1\n${text}\n`;
  }

  function dxfCircle(cx, cy, radius, layer = '0') {
    return `0\nCIRCLE\n8\n${layer}\n10\n${cx}\n20\n${-cy}\n30\n0\n40\n${radius}\n`;
  }


  // ========== PDF Export ==========
  function exportPDF(doc) {
    const svgContent = buildSVGString(doc, false);
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head><title>${escapeXml(doc.meta.title || 'Drawing')} - 인쇄</title>
      <style>
        body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: white; }
        img { max-width: 100%; max-height: 100vh; }
        @media print { body { margin: 0; } img { max-width: 100%; } }
      </style></head>
      <body>
        <img src="${url}" alt="Drawing">
        <script>setTimeout(() => window.print(), 500);<\/script>
      </body></html>
    `);
    printWindow.document.close();
  }


  // ========== JSON Export ==========
  function exportJSON(doc) {
    const json = JSON.stringify(doc, null, 2);
    download(json, `${doc.meta.title || 'drawing'}.json`, 'application/json');
    return json;
  }


  // ========== Helpers ==========
  function download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { exportSVG, exportDXF, exportPDF, exportJSON };
})();
