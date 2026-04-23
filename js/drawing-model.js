/* ============================================================
   drawing-model.js
   도면 데이터 모델 (Structured JSON / DSL) — 기계도면 전용

   도면 유형:
   - 'mechanical' : 기계도면 (축, 원통, φ, TAP, 중심선 등)
   - 'unknown'    : 미분류 (기계도면 추정 최소 구조로 폴백)

   v5 — geometry-first 아키텍처
       모든 요소에 confidence 필드 + _isPlaceholder 필드 추가
       confidence: 'confirmed' | 'estimated' | 'uncertain' | null
       _isPlaceholder: true  → 사용자가 값을 직접 입력해야 하는 빈칸
                       false → 원본에서 읽힌 확정 값
   ============================================================ */

const DrawingModel = (() => {
  let _idCounter = 0;

  function generateId(prefix = 'el') {
    return `${prefix}_${++_idCounter}_${Date.now().toString(36)}`;
  }

  // ============================================================
  // Document Factories
  // ============================================================

  /**
   * 기계도면 문서 생성
   */
  function createMechanicalDocument() {
    return {
      version: '1.0',
      drawingType: 'mechanical',
      meta: {
        title: '새 기계도면',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        unit: 'mm',
        scale: '1:1',
        projectionMethod: '3각법',  // '1각법' | '3각법'
        material: '',
        surfaceFinish: '',
        tolerance: '',
        partName: '',
        partNo: '',
        quantity: '',
        remarks: '',
      },
      layers: {
        outlines:    { visible: true, locked: false, color: '#000000', label: '외형선' },
        centerlines: { visible: true, locked: false, color: '#f87171', label: '중심선' },
        dimensions:  { visible: true, locked: false, color: '#60a5fa', label: '치수' },
        texts:       { visible: true, locked: false, color: '#94a3b8', label: '텍스트' },
        holes:       { visible: true, locked: false, color: '#a78bfa', label: '구멍/탭' },
        slots:       { visible: true, locked: false, color: '#fbbf24', label: '슬롯/장공' },
        hatching:    { visible: true, locked: false, color: '#475569', label: '해칭' },
        hiddenlines: { visible: true, locked: false, color: '#4ade80', label: '숨은선' },
        titleblocks: { visible: true, locked: false, color: '#94a3b8', label: '표제란' },
      },
      elements: [],
      auxiliaryViews: [],  // v5.5: 보조 투상도 (메인 도면과 독립)
    };
  }

  /**
   * unknown → 기계도면 추정 최소 구조로 폴백
   */
  function createUnknownDocument() {
    const doc = createMechanicalDocument();
    doc.drawingType = 'unknown';
    doc.meta.title = '분류 미확정 — 형상 초안';
    doc.meta._reviewRequired = true;
    return doc;
  }

  /**
   * 범용 팩토리
   */
  function createDocument(drawingType) {
    switch (drawingType) {
      case 'mechanical': return createMechanicalDocument();
      case 'unknown':    return createUnknownDocument();
      default:           return createMechanicalDocument();
    }
  }

  // ============================================================
  // Element Factories — 기계도면 전용
  //
  // v5: 모든 요소에 confidence + _isPlaceholder 필드 추가
  // ============================================================

  /**
   * 외형선 (outline) — 실선, 부품 윤곽
   */
  /**
   * @param {string} _edgeType - 외형선 유형 (구분용)
   *   null        : 일반 외형선 (상/하단선, 좌/우면)
   *   'shoulder'  : 단차 견면 (큰직경→작은직경 경계)
   *   'visible'   : 보이는 내부 실선 (작은직경 뒤에 큰직경이 보이는 경계)
   */
  function createOutline(x1, y1, x2, y2, thickness = 2, _edgeType = null) {
    return {
      id: generateId('otl'),
      type: 'outline',
      layer: 'outlines',
      x1, y1, x2, y2,
      thickness,
      color: '#000000',
      locked: false,
      confidence: null,       // 'confirmed' | 'estimated' | 'uncertain' | null
      _isPlaceholder: false,  // 형상은 일반적으로 placeholder 아님
      _edgeType: _edgeType,   // null | 'shoulder' | 'visible'
    };
  }

  /**
   * 중심선 (centerline) — 1점쇄선 (빨간색)
   */
  function createCenterline(x1, y1, x2, y2) {
    return {
      id: generateId('cl'),
      type: 'centerline',
      layer: 'centerlines',
      x1, y1, x2, y2,
      thickness: 0.8,
      color: '#f87171',
      dashPattern: 'center',
      locked: false,
      confidence: null,
      _isPlaceholder: false,
    };
  }

  /**
   * 숨은선 (hidden line) — 파선/점선 (초록색)
   * 정면도에서 보이지 않는 뒤쪽 형상의 경계선
   */
  function createHiddenLine(x1, y1, x2, y2, thickness = 1) {
    return {
      id: generateId('hdn'),
      type: 'hiddenline',
      layer: 'hiddenlines',
      x1, y1, x2, y2,
      thickness,
      color: '#4ade80',
      dashPattern: 'hidden',
      locked: false,
      confidence: null,
      _isPlaceholder: false,
    };
  }

  /**
   * 구멍/탭 (hole)
   */
  function createHole(cx, cy, diameter, depth = null, holeType = 'through', tapSpec = null) {
    return {
      id: generateId('hole'),
      type: 'hole',
      layer: 'holes',
      cx, cy,
      diameter,
      depth,
      holeType,   // 'through' | 'blind' | 'tap' | 'countersink' | 'center'
      tapSpec,     // 예: 'M10x1.5' | null
      color: '#a78bfa',
      locked: false,
      confidence: null,
      _isPlaceholder: false,
    };
  }

  /**
   * 슬롯/장공 (slot)
   */
  function createSlot(x, y, width, height) {
    return {
      id: generateId('slot'),
      type: 'slot',
      layer: 'slots',
      x, y,
      width, height,
      color: '#fbbf24',
      locked: false,
      confidence: null,
      _isPlaceholder: false,
    };
  }

  /**
   * 해칭 (단면 표시)
   */
  function createHatch(points, angle = 45, spacing = 4) {
    return {
      id: generateId('htch'),
      type: 'hatch',
      layer: 'hatching',
      points, // [{x, y}, ...] 다각형 꼭짓점
      angle,
      spacing,
      color: '#475569',
      locked: false,
      confidence: null,
      _isPlaceholder: false,
    };
  }

  // ============================================================
  // Element Factories — 공용
  // ============================================================

  function createDimension(x1, y1, x2, y2, value, unit = 'mm', offset = 30) {
    return {
      id: generateId('dim'),
      type: 'dimension',
      layer: 'dimensions',
      x1, y1, x2, y2,
      value: String(value),
      unit,
      offset,
      color: '#60a5fa',
      fontSize: 6,
      locked: false,
      confidence: null,
      _isPlaceholder: false,
      // 치수공차 (tolerance)
      tolerance: false,        // 공차 활성화 여부
      toleranceUpper: '',      // 상한 공차 (예: '+0.001')
      toleranceLower: '',      // 하한 공차 (예: '-0.001')
    };
  }

  /**
   * 직경 치수 (φ 표기)
   */
  function createDiameterDimension(x1, y1, x2, y2, value, unit = 'mm', offset = 30) {
    return {
      id: generateId('ddim'),
      type: 'dimension',
      layer: 'dimensions',
      x1, y1, x2, y2,
      value: `⌀${value}`,
      unit,
      offset,
      color: '#60a5fa',
      fontSize: 6,
      dimStyle: 'diameter',
      locked: false,
      confidence: null,
      _isPlaceholder: false,
      // 치수공차 (tolerance)
      tolerance: false,
      toleranceUpper: '',
      toleranceLower: '',
    };
  }

  function createText(x, y, content, fontSize = 14) {
    return {
      id: generateId('txt'),
      type: 'text',
      layer: 'texts',
      x, y,
      content,
      fontSize,
      color: '#94a3b8',
      fontWeight: 'normal',
      rotation: 0,
      locked: false,
      confidence: null,
      _isPlaceholder: false,
    };
  }

  /**
   * 표제란 (Title Block) — KS 규격 스타일 v8
   *
   * 구조 (데이터 행이 위, 헤더가 아래):
   *   ┌────┬──────┬─────┬────┬─────┐
   *   │ 4  │      │     │    │     │  ← 공란 (역순: 4→1)
   *   ├────┼──────┼─────┼────┼─────┤
   *   │ 3  │      │     │    │     │
   *   ├────┼──────┼─────┼────┼─────┤
   *   │ 2  │      │     │    │     │
   *   ├────┼──────┼─────┼────┼─────┤
   *   │ 1  │      │     │    │     │
   *   ├────┼──────┼─────┼────┼─────┤
   *   │품번│ 품명 │ 재질│수량│ 비고│  ← 헤더 (아래!)
   *   ├────┴──────┤─────┼────┴─────┤
   *   │  작품명   │척도 │  1:1     │  ← 하단 블록
   *   │           ├─────┼──────────┤
   *   │           │각법 │  3각법   │
   *   └───────────┴─────┴──────────┘
   *
   * itemRows: [{ no, partName, material, quantity, remarks, editable }]
   * bottomInfo: { title, scale, projectionMethod }
   */
  function createTitleBlock(x, y, width, options) {
    const opt = options || {};
    return {
      id: generateId('tblk'),
      type: 'titleblock',
      layer: 'titleblocks',
      x, y,
      width,
      // ── 회사 표준 표제란 (HAN KOOK MACHINERY CO. 스타일) ──
      // 상단 메인 블록
      companyName: opt.companyName || 'HAN KOOK MACHINERY CO.',
      drawingName: opt.drawingName || '',           // NAME (도면명)
      drawingNameSub: opt.drawingNameSub || '',     // for (부제)
      // 정보 행
      scale: opt.scale || '1:1',
      unit: opt.unit || 'mm',
      design: opt.design || '',                     // DESIGN (설계자)
      check: opt.check || '',                       // CHECK (검도)
      appr: opt.appr || '',                         // APPR (승인)
      titlePrj: opt.titlePrj || '',                 // TTL.PRJ
      date: opt.date || '',                         // DATE (일자)
      // 우측 식별 블록
      companyKr: opt.companyKr || '\uae68\ub057\ud55c\ub098\ub77c(\uc8fc) - \uccad\uc8fc\uacf5\uc7a5',  // \ud55c\uae00 \ud68c\uc0ac\uba85
      dwgNo: opt.dwgNo || '',                       // DWG NO (도면번호)
      rev: opt.rev || '',                           // REV
      sheetNo: opt.sheetNo || '1',                  // SH NO
      paperSize: opt.paperSize || 'A3',             // 용지 크기
      // 좌측 하단 리비전 테이블
      revisionRows: opt.revisionRows || [],
      // 품번표 (기존 호환)
      itemRows: opt.itemRows || [],
      // 스타일
      color: '#000000',
      textColor: '#000000',
      labelColor: '#000000',
      fontSize: opt.fontSize || 4.5,
      locked: false,
      confidence: 'confirmed',
      _isPlaceholder: false,
    };
  }

  /**
   * 주서란 (Note Block) — 도면 하단 좌측 영역
   * 
   * 구조:
   *   NOTE
   *   1. 표현하지 않는 모따기는 전부 R=3으로 처리한다
   *   2. 풀림처리한다
   *   ...
   *
   * lines: ["표현하지 않는 모따기는 전부 R=3으로 처리한다", "풀림처리한다", ...]
   */
  function createNoteBlock(x, y, options = {}) {
    return {
      id: generateId('note'),
      type: 'noteblock',
      layer: 'texts',
      x, y,
      lines: (options.lines && options.lines.length > 0) ? options.lines : [],
      fontSize: options.fontSize || 10,
      lineHeight: options.lineHeight || 1.6,
      fontFamily: "'Malgun Gothic', '맑은 고딕', sans-serif",
      color: options.color || '#000000',
      titleColor: options.titleColor || '#000000',
      locked: false,
      confidence: 'confirmed',
      _isPlaceholder: false,
    };
  }

  // ============================================================
  // Utility
  // ============================================================

  /**
   * 보조 투상도 (auxiliary view) 생성
   * - 메인 도면과 분리된 독립 뷰
   * - AI는 형상의 의미(키홈/슬롯 등)를 판단하지 않음
   * - 원본에 따로 그려진 도형을 그대로 복제
   */
  function createAuxiliaryView(position, geometry, dimensions, label = '') {
    return {
      id: generateId('aux'),
      position,        // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
      geometry,        // [{type, ...}] — outline 배열
      dimensions,      // [{type: 'dimension', ...}] — 치수 배열
      label,           // 표시 라벨 (없으면 '')
      confidence: null,
      _isPlaceholder: false,
    };
  }

  function cloneElement(el) {
    const clone = JSON.parse(JSON.stringify(el));
    clone.id = generateId(el.type.substring(0, 4));
    return clone;
  }

  function getElementBounds(el) {
    switch (el.type) {
      case 'outline':
      case 'centerline':
        return {
          x: Math.min(el.x1, el.x2),
          y: Math.min(el.y1, el.y2),
          width: Math.abs(el.x2 - el.x1) || (el.thickness || 2),
          height: Math.abs(el.y2 - el.y1) || (el.thickness || 2),
        };
      case 'hiddenline':
        return {
          x: Math.min(el.x1, el.x2),
          y: Math.min(el.y1, el.y2),
          width: Math.abs(el.x2 - el.x1) || (el.thickness || 1),
          height: Math.abs(el.y2 - el.y1) || (el.thickness || 1),
        };
      case 'dimension':
        return {
          x: Math.min(el.x1, el.x2),
          y: Math.min(el.y1, el.y2) - Math.abs(el.offset),
          width: Math.abs(el.x2 - el.x1) || 10,
          height: Math.abs(el.y2 - el.y1) + Math.abs(el.offset) + 10,
        };
      case 'text':
        return {
          x: el.x,
          y: el.y - el.fontSize,
          width: el.content.length * el.fontSize * 0.6,
          height: el.fontSize * 1.4,
        };
      case 'hole':
        const r = el.diameter / 2;
        return { x: el.cx - r, y: el.cy - r, width: el.diameter, height: el.diameter };
      case 'slot':
        return { x: el.x, y: el.y, width: el.width, height: el.height };
      case 'hatch':
        if (!el.points || !el.points.length) return { x: 0, y: 0, width: 0, height: 0 };
        let hMinX = Infinity, hMinY = Infinity, hMaxX = -Infinity, hMaxY = -Infinity;
        el.points.forEach(p => {
          hMinX = Math.min(hMinX, p.x);
          hMinY = Math.min(hMinY, p.y);
          hMaxX = Math.max(hMaxX, p.x);
          hMaxY = Math.max(hMaxY, p.y);
        });
        return { x: hMinX, y: hMinY, width: hMaxX - hMinX, height: hMaxY - hMinY };
      case 'paperBg':
        return { x: el.x || 0, y: el.y || 0, width: el.width || 800, height: el.height || 600 };
      case 'titleblock': {
        const itemCount = (el.itemRows ? el.itemRows.length : 0);
        const hdrH = el.headerHeight || 20;
        const rH = el.rowHeight || 22;
        const btmRowH = el.bottomRowHeight || 18;
        const btmH = btmRowH * 2;  // 2행: 척도 + 각법
        const dataH = itemCount * rH;
        const tbH = dataH + hdrH + btmH;
        return { x: el.x, y: el.y, width: el.width || 250, height: tbH };
      }
      default:
        return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  function getAllBounds(elements) {
    if (!elements.length) return { x: 0, y: 0, width: 800, height: 600 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    elements.forEach(el => {
      const b = getElementBounds(el);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    });
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  return {
    // Document
    createDocument,
    createMechanicalDocument,
    createUnknownDocument,
    // Mechanical elements
    createOutline,
    createCenterline,
    createHiddenLine,
    createHole,
    createSlot,
    createHatch,
    createDiameterDimension,
    createAuxiliaryView,
    // Shared elements
    createDimension,
    createText,
    createTitleBlock,
    createNoteBlock,
    // Utility
    cloneElement,
    getElementBounds,
    getAllBounds,
    generateId,
  };
})();
