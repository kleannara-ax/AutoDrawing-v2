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
        outlines:       { visible: true, locked: false, color: '#000000', label: '외형선' },
        centerlines:    { visible: true, locked: false, color: '#f87171', label: '중심선' },
        dimensions:     { visible: true, locked: false, color: '#60a5fa', label: '치수' },
        texts:          { visible: true, locked: false, color: '#94a3b8', label: '텍스트' },
        holes:          { visible: true, locked: false, color: '#a78bfa', label: '구멍/탭' },
        slots:          { visible: true, locked: false, color: '#fbbf24', label: '슬롯/장공' },
        hatching:       { visible: true, locked: false, color: '#475569', label: '해칭' },
        hiddenlines:    { visible: true, locked: false, color: '#4ade80', label: '숨은선' },
        surfacefinish:  { visible: true, locked: false, color: '#f472b6', label: '다듬질 기호' },
        annotations:    { visible: true, locked: false, color: '#f59e0b', label: '기하공차/데이텀' },
        titleblocks:    { visible: true, locked: false, color: '#94a3b8', label: '표제란' },
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
  function createOutline(x1, y1, x2, y2, thickness = 1, _edgeType = null) {
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
  // Surface Finish Symbol (다듬질 기호) — KS 규격
  //
  // 다듬질 등급:
  //   'grinding'   (연마 다듬질) — ▽▽▽▽  Ra 0.2a,  Rmax 0.8S,  Rz 0.8Z
  //   'precision'  (정밀 다듬질) — ▽▽▽   Ra 1.6a,  Rmax 6.3S,  Rz 6.3Z
  //   'normal'     (보통 다듬질) — ▽▽    Ra 6.3a,  Rmax 25S,   Rz 25Z
  //   'rough'      (거친 다듬질) — ▽     Ra 25a,   Rmax 100S,  Rz 100Z
  //   'none'       (다듬질 안함) — 기호 표시 안 함
  //
  // valueType: 'Ra' | 'Rmax' | 'Rz'
  // attachTo: 부착 대상 요소 ID (outline 또는 dimension)
  // ============================================================

  /**
   * 다듬질 기호 표준값 테이블
   */
  const SURFACE_FINISH_TABLE = {
    grinding:  { Ra: '0.2a',  Rmax: '0.8S',  Rz: '0.8Z',  triangles: 4, label: '연마 다듬질' },
    precision: { Ra: '1.6a',  Rmax: '6.3S',  Rz: '6.3Z',  triangles: 3, label: '정밀 다듬질' },
    normal:    { Ra: '6.3a',  Rmax: '25S',   Rz: '25Z',   triangles: 2, label: '보통 다듬질' },
    rough:     { Ra: '25a',   Rmax: '100S',  Rz: '100Z',  triangles: 1, label: '거친 다듬질' },
    none:      { Ra: '~',     Rmax: '~',     Rz: '~',     triangles: 0, label: '다듬질 안함' },
  };

  /**
   * 다듬질 기호 (Surface Finish Symbol)
   *
   * @param {number} x - 기호 위치 X (부착 면의 중간점)
   * @param {number} y - 기호 위치 Y (부착 면의 상단)
   * @param {string} grade - 다듬질 등급: 'grinding'|'precision'|'normal'|'rough'|'none'
   * @param {string} valueType - 표준값 유형: 'Ra'|'Rmax'|'Rz'
   * @param {string|null} attachTo - 부착 대상 요소 ID
   * @param {number} rotation - 회전 각도 (도, 기본 0 = 위쪽)
   */
  function createSurfaceFinish(x, y, grade = 'normal', valueType = 'Ra', attachTo = null, rotation = 0) {
    const info = SURFACE_FINISH_TABLE[grade] || SURFACE_FINISH_TABLE.normal;
    return {
      id: generateId('sf'),
      type: 'surfacefinish',
      layer: 'surfacefinish',
      x, y,
      grade,           // 'grinding' | 'precision' | 'normal' | 'rough' | 'none'
      valueType,       // 'Ra' | 'Rmax' | 'Rz'
      value: info[valueType] || '',  // 실제 표준값 문자열
      triangles: info.triangles,
      attachTo,        // 부착 대상 요소 ID (outline or dimension)
      rotation,        // 회전 각도 (도)
      color: '#000000',
      fontSize: 5,
      locked: false,
      confidence: null,
      _isPlaceholder: false,
    };
  }

  // ============================================================
  // Geometric Tolerance (기하공차) — KS B 0608
  //
  // 구조: [기호 | 공차값 | 데이텀] 형태의 공차 기입틀
  // - symbol: 기하공차 기호 종류
  // - value: 공차 수치 (예: 0.003)
  // - datum: 데이텀 문자 (예: 'A', 'B') — 없으면 null
  // - attachTo: 부착 대상 요소 ID (outline 또는 dimension)
  // - 지시선: 부착면의 치수보조선에서 수직으로 연결
  // - 복수 공차: stacked 배열로 아래에 추가 기입틀 연결
  // ============================================================

  const GDT_SYMBOLS = {
    straightness:    { label: '진직도',       symbol: '⏤',  category: 'form',        needsDatum: false },
    flatness:        { label: '평면도',       symbol: '⏥',  category: 'form',        needsDatum: false },
    roundness:       { label: '진원도',       symbol: '○',  category: 'form',        needsDatum: false },
    cylindricity:    { label: '원통도',       symbol: '⌭',  category: 'form',        needsDatum: false },
    lineProfile:     { label: '선의 윤곽도',  symbol: '⌒',  category: 'profile',     needsDatum: false },
    surfaceProfile:  { label: '면의 윤곽도',  symbol: '⌓',  category: 'profile',     needsDatum: false },
    parallelism:     { label: '평행도',       symbol: '∥',  category: 'orientation', needsDatum: true },
    perpendicularity:{ label: '직각도',       symbol: '⊥',  category: 'orientation', needsDatum: true },
    angularity:      { label: '경사도',       symbol: '∠',  category: 'orientation', needsDatum: true },
    position:        { label: '위치도',       symbol: '⌖',  category: 'location',    needsDatum: true },
    concentricity:   { label: '동축도',       symbol: '◎',  category: 'location',    needsDatum: true },
    symmetry:        { label: '대칭도',       symbol: '⌯',  category: 'location',    needsDatum: true },
    runout:          { label: '원주 흔들림',  symbol: '↗',  category: 'runout',      needsDatum: true },
    totalRunout:     { label: '온 흔들림',    symbol: '⇗',  category: 'runout',      needsDatum: true },
  };

  /**
   * 기하공차 (Geometric Tolerance) 생성
   *
   * @param {number} x - 공차 기입틀 위치 X
   * @param {number} y - 공차 기입틀 위치 Y
   * @param {string} symbolType - GDT_SYMBOLS 키 (예: 'perpendicularity')
   * @param {string} value - 공차 수치 문자열 (예: '0.003')
   * @param {string|null} datum - 데이텀 문자 (예: 'A') — 없으면 null
   * @param {string|null} attachTo - 부착 대상 요소 ID
   * @param {object} options - 추가 옵션
   */
  function createGeometricTolerance(x, y, symbolType = 'perpendicularity', value = '0.01', datum = null, attachTo = null, options = {}) {
    return {
      id: generateId('gdt'),
      type: 'geotolerance',
      layer: 'annotations',
      x, y,
      symbolType,       // GDT_SYMBOLS 키
      value,            // 공차 수치 문자열
      datum,            // 데이텀 문자 (null이면 없음)
      attachTo,         // 부착 대상 요소 ID
      leaderSide: options.leaderSide || 'top',  // 지시선 방향: 'top'|'bottom'|'left'|'right'
      stacked: options.stacked || [],            // 추가 공차 [{symbolType, value, datum}]
      color: '#000000',
      fontSize: 4,
      locked: false,
      confidence: options.confidence || null,
      _isPlaceholder: false,
    };
  }

  /**
   * 데이텀 기호 (Datum Feature Symbol) 생성
   *
   * @param {number} x - 데이텀 삼각형 꼭짓점 X (면 위 위치)
   * @param {number} y - 데이텀 삼각형 꼭짓점 Y (면 위 위치)
   * @param {string} letter - 데이텀 문자 (A, B, C...)
   * @param {string|null} attachTo - 부착 대상 요소 ID
   * @param {string} side - 삼각형 방향: 'top'|'bottom'|'left'|'right'
   */
  function createDatum(x, y, letter = 'A', attachTo = null, side = 'bottom') {
    return {
      id: generateId('dat'),
      type: 'datum',
      layer: 'annotations',
      x, y,
      letter,           // 데이텀 문자
      attachTo,         // 부착 대상 요소 ID
      side,             // 삼각형 방향
      color: '#000000',
      fontSize: 4,
      locked: false,
      confidence: null,
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
      case 'surfacefinish': {
        if (el.grade === 'none') {
          // 물결선 기호 영역 (wavy line + stem) — 50% 축소
          // renderer: stemH=2, waveW=1.5, waveH=0.4
          const stemH = 2;
          const waveW = 1.5;
          const waveH = 0.4;
          return {
            x: el.x - waveW - 1,
            y: el.y - stemH - waveH - 1,
            width: waveW * 2 + 2,
            height: stemH + waveH + 2
          };
        }
        // 정삼각형 역삼각형 ▽ — 간격 0, 서로 붙어있음
        // renderer 기준: TRI_W=3, TRI_H=2.6, TRI_GAP=0
        const triCount = el.triangles || 1;
        const triW = 3;
        const totalW = triCount * triW;  // 간격 0
        const triH = 3 * 0.866;         // ≈ 2.6
        return {
          x: el.x - totalW / 2 - 0.5,
          y: el.y - triH - 0.5,
          width: totalW + 1,
          height: triH + 1
        };
      }
      case 'geotolerance': {
        // 공차 기입틀: 각 칸 높이 8px, 폭 = 기호(12) + 수치(20) + 데이텀(12) ≈ 44
        const frameH = 8;
        const stackCount = 1 + (el.stacked ? el.stacked.length : 0);
        const totalH = frameH * stackCount;
        const frameW = 12 + 20 + (el.datum ? 12 : 0);
        return { x: el.x, y: el.y, width: frameW, height: totalH + 15 };
      }
      case 'datum': {
        // 데이텀 기호: 삼각형(6x6) + 줄기(3) + 사각형(8x8)
        return { x: el.x - 4, y: el.y - 20, width: 8, height: 22 };
      }
      case 'breakLine': {
        // 물결표시(생략선): x 중심, topY~botY 수직 범위, gapW 폭
        const bHalfW = (el.gapW || 6) / 2;
        return { x: el.x - bHalfW, y: el.topY, width: el.gapW || 6, height: (el.botY - el.topY) };
      }
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

  /**
   * 물결 생략선 (break line) — 구간 길이 > 1000mm 일 때 중앙에 표시
   * 정면도에서 긴 구간을 시각적으로 축소했음을 나타내는 물결 기호
   *
   * @param {number} x       물결선 중심 X (구간 중앙)
   * @param {number} topY    물결선 상단 Y (구간 상단 외형선)
   * @param {number} botY    물결선 하단 Y (구간 하단 외형선)
   * @param {number} gapW    물결 기호가 차지하는 수평 폭 (px)
   */
  function createBreakLine(x, topY, botY, gapW = 6) {
    return {
      id: generateId('brk'),
      type: 'breakLine',
      layer: 'outlines',
      x, topY, botY,
      gapW,
      thickness: 1,
      color: '#000000',
      locked: true,
      confidence: 'confirmed',
      _isPlaceholder: false,
    };
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
    createSurfaceFinish,
    SURFACE_FINISH_TABLE,
    createGeometricTolerance,
    createDatum,
    createBreakLine,
    GDT_SYMBOLS,
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
