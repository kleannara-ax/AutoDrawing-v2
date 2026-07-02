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
   * KS B 1336 축용 C형 멈춤링(스냅링) 규격 테이블
   *   d1 = 적용 축지름(호칭, mm)
   *   d2 = 홈 지름(스냅링 외경, 기준치수 mm)
   *   m  = 홈 폭(스냅링 두께, 기준치수 mm)
   *   (허용차 n 최소값은 이 앱에서 사용하지 않아 생략)
   *
   * 사용법: SNAP_RING_KS_TABLE[d1] → { d2, m } (없으면 undefined)
   * 유효 범위: d1 최소 10 ~ 최대 95 (규격에 존재하는 값만 매칭)
   */
  const SNAP_RING_KS_TABLE = {
    10: { d2: 9.6,  m: 1.15 },
    11: { d2: 10.5, m: 1.15 },
    12: { d2: 11.5, m: 1.15 },
    13: { d2: 12.4, m: 1.15 },
    14: { d2: 13.4, m: 1.15 },
    15: { d2: 14.3, m: 1.15 },
    16: { d2: 15.2, m: 1.35 },
    17: { d2: 16.2, m: 1.35 },
    18: { d2: 17.0, m: 1.35 },
    19: { d2: 18.0, m: 1.35 },
    20: { d2: 19.0, m: 1.35 },
    21: { d2: 20.0, m: 1.35 },
    22: { d2: 21.0, m: 1.35 },
    24: { d2: 22.9, m: 1.35 },
    25: { d2: 23.9, m: 1.35 },
    26: { d2: 24.9, m: 1.35 },
    28: { d2: 26.6, m: 1.75 },
    29: { d2: 27.6, m: 1.75 },
    30: { d2: 28.6, m: 1.75 },
    32: { d2: 30.3, m: 1.75 },
    34: { d2: 32.3, m: 1.75 },
    35: { d2: 33.0, m: 1.95 },
    36: { d2: 34.0, m: 1.95 },
    38: { d2: 36.0, m: 1.95 },
    40: { d2: 38.0, m: 1.95 },
    42: { d2: 39.5, m: 1.95 },
    45: { d2: 42.5, m: 1.95 },
    48: { d2: 45.5, m: 1.95 },
    50: { d2: 47.0, m: 2.2 },
    52: { d2: 49.0, m: 2.2 },
    55: { d2: 52.0, m: 2.2 },
    56: { d2: 53.0, m: 2.2 },
    58: { d2: 55.0, m: 2.2 },
    60: { d2: 57.0, m: 2.2 },
    62: { d2: 59.0, m: 2.2 },
    63: { d2: 60.0, m: 2.2 },
    65: { d2: 62.0, m: 2.7 },
    68: { d2: 65.0, m: 2.7 },
    70: { d2: 67.0, m: 2.7 },
    72: { d2: 69.0, m: 2.7 },
    75: { d2: 72.0, m: 2.7 },
    78: { d2: 75.0, m: 2.7 },
    80: { d2: 76.5, m: 2.7 },
    82: { d2: 78.5, m: 2.7 },
    85: { d2: 81.5, m: 3.2 },
    88: { d2: 84.5, m: 3.2 },
    90: { d2: 86.5, m: 3.2 },
    95: { d2: 91.5, m: 3.2 },
  };

  const SNAP_RING_D1_MIN = 10;
  const SNAP_RING_D1_MAX = 95;

  /**
   * 축지름(d1)으로 KS B 1336 스냅링 규격을 조회한다.
   * @param {number} shaftDiameter - 축지름 d1 (mm)
   * @returns {object} 결과
   *   - found=true:  { found:true, d1, d2, m }
   *   - found=false: { found:false, reason:'too_small'|'too_large'|'not_standard', d1, min, max }
   */
  function lookupSnapRingByShaft(shaftDiameter) {
    const d1 = Math.round(Number(shaftDiameter) * 100) / 100; // 소수 오차 정리
    const min = SNAP_RING_D1_MIN, max = SNAP_RING_D1_MAX;
    if (isNaN(d1)) {
      return { found: false, reason: 'not_standard', d1: shaftDiameter, min, max };
    }
    if (d1 < min) return { found: false, reason: 'too_small', d1, min, max };
    if (d1 > max) return { found: false, reason: 'too_large', d1, min, max };
    // 정확히 일치하는 규격만 허용 (23, 51, 93 등 기준 사이값은 실패)
    const key = Math.round(d1);
    const rec = (key === d1) ? SNAP_RING_KS_TABLE[key] : undefined;
    if (rec) {
      return { found: true, d1: key, d2: rec.d2, m: rec.m };
    }
    return { found: false, reason: 'not_standard', d1, min, max };
  }

  // ============================================================
  // 깊은 홈 볼베어링 규격 — KS B 2023 (60/62/63/64 계열)
  //   호칭번호(designation) → { d(안지름), D(바깥지름), B(폭), r(필렛 min) }
  //   PDF "깊은 홈 볼베어링 KS 규격" 표에서 추출.
  // ============================================================
  const DEEP_GROOVE_BEARING_TABLE = {
    // ── 60 계열 ──
    '601.5': { d: 1.5, D: 6,   B: 2.5, r: 0.15, series: 60 },
    '602':   { d: 2,   D: 7,   B: 2.8, r: 0.15, series: 60 },
    '60/2.5':{ d: 2.5, D: 8,   B: 2.8, r: 0.15, series: 60 },
    '603':   { d: 3,   D: 9,   B: 3,   r: 0.15, series: 60 },
    '604':   { d: 4,   D: 12,  B: 4,   r: 0.2,  series: 60 },
    '605':   { d: 5,   D: 14,  B: 5,   r: 0.2,  series: 60 },
    '606':   { d: 6,   D: 17,  B: 6,   r: 0.3,  series: 60 },
    '607':   { d: 7,   D: 19,  B: 6,   r: 0.3,  series: 60 },
    '608':   { d: 8,   D: 22,  B: 7,   r: 0.3,  series: 60 },
    '609':   { d: 9,   D: 24,  B: 7,   r: 0.3,  series: 60 },
    '6000':  { d: 10,  D: 26,  B: 8,   r: 0.3,  series: 60 },
    '6001':  { d: 12,  D: 28,  B: 8,   r: 0.3,  series: 60 },
    '6002':  { d: 15,  D: 32,  B: 9,   r: 0.3,  series: 60 },
    '6003':  { d: 17,  D: 35,  B: 10,  r: 0.3,  series: 60 },
    '6004':  { d: 20,  D: 42,  B: 12,  r: 0.6,  series: 60 },
    '60/22': { d: 22,  D: 44,  B: 12,  r: 0.6,  series: 60 },
    '6005':  { d: 25,  D: 47,  B: 12,  r: 0.6,  series: 60 },
    '60/28': { d: 28,  D: 52,  B: 12,  r: 0.6,  series: 60 },
    '6006':  { d: 30,  D: 55,  B: 13,  r: 1,    series: 60 },
    '60/32': { d: 32,  D: 58,  B: 13,  r: 1,    series: 60 },
    '6007':  { d: 35,  D: 62,  B: 14,  r: 1,    series: 60 },
    '6008':  { d: 40,  D: 68,  B: 15,  r: 1,    series: 60 },
    '6009':  { d: 45,  D: 75,  B: 16,  r: 1,    series: 60 },
    '6010':  { d: 50,  D: 80,  B: 16,  r: 1,    series: 60 },
    '6011':  { d: 55,  D: 90,  B: 18,  r: 1.1,  series: 60 },
    '6012':  { d: 60,  D: 95,  B: 18,  r: 1.1,  series: 60 },
    '6013':  { d: 65,  D: 100, B: 18,  r: 1.1,  series: 60 },
    '6014':  { d: 70,  D: 110, B: 20,  r: 1.1,  series: 60 },
    '6015':  { d: 75,  D: 115, B: 20,  r: 1.1,  series: 60 },
    '6016':  { d: 80,  D: 125, B: 22,  r: 1.1,  series: 60 },
    '6017':  { d: 85,  D: 130, B: 22,  r: 1.1,  series: 60 },
    '6018':  { d: 90,  D: 140, B: 24,  r: 1.5,  series: 60 },
    '6019':  { d: 95,  D: 145, B: 24,  r: 1.5,  series: 60 },
    '6020':  { d: 100, D: 150, B: 24,  r: 1.5,  series: 60 },
    '6021':  { d: 105, D: 160, B: 26,  r: 2,    series: 60 },
    '6022':  { d: 110, D: 170, B: 28,  r: 2,    series: 60 },
    // ── 62 계열 ──
    '623':   { d: 3,   D: 10,  B: 4,   r: 0.15, series: 62 },
    '624':   { d: 4,   D: 13,  B: 5,   r: 0.2,  series: 62 },
    '625':   { d: 5,   D: 16,  B: 5,   r: 0.3,  series: 62 },
    '626':   { d: 6,   D: 19,  B: 6,   r: 0.3,  series: 62 },
    '627':   { d: 7,   D: 22,  B: 7,   r: 0.3,  series: 62 },
    '628':   { d: 8,   D: 24,  B: 8,   r: 0.3,  series: 62 },
    '629':   { d: 9,   D: 26,  B: 8,   r: 0.3,  series: 62 },
    '6200':  { d: 10,  D: 30,  B: 9,   r: 0.6,  series: 62 },
    '6201':  { d: 12,  D: 32,  B: 10,  r: 0.6,  series: 62 },
    '6202':  { d: 15,  D: 35,  B: 11,  r: 0.6,  series: 62 },
    '6203':  { d: 17,  D: 40,  B: 12,  r: 0.6,  series: 62 },
    '6204':  { d: 20,  D: 47,  B: 14,  r: 1,    series: 62 },
    '62/22': { d: 22,  D: 50,  B: 14,  r: 1,    series: 62 },
    '6205':  { d: 25,  D: 52,  B: 15,  r: 1,    series: 62 },
    '62/28': { d: 28,  D: 58,  B: 16,  r: 1,    series: 62 },
    '6206':  { d: 30,  D: 62,  B: 16,  r: 1,    series: 62 },
    '62/32': { d: 32,  D: 65,  B: 17,  r: 1,    series: 62 },
    '6207':  { d: 35,  D: 72,  B: 17,  r: 1.1,  series: 62 },
    '6208':  { d: 40,  D: 80,  B: 18,  r: 1.1,  series: 62 },
    '6209':  { d: 45,  D: 85,  B: 19,  r: 1.1,  series: 62 },
    '6210':  { d: 50,  D: 90,  B: 20,  r: 1.1,  series: 62 },
    '6211':  { d: 55,  D: 100, B: 21,  r: 1.5,  series: 62 },
    '6212':  { d: 60,  D: 110, B: 22,  r: 1.5,  series: 62 },
    '6213':  { d: 65,  D: 120, B: 23,  r: 1.5,  series: 62 },
    '6214':  { d: 70,  D: 125, B: 24,  r: 1.5,  series: 62 },
    '6215':  { d: 75,  D: 130, B: 25,  r: 1.5,  series: 62 },
    '6216':  { d: 80,  D: 140, B: 26,  r: 2,    series: 62 },
    '6217':  { d: 85,  D: 150, B: 28,  r: 2,    series: 62 },
    '6218':  { d: 90,  D: 160, B: 30,  r: 2,    series: 62 },
    '6219':  { d: 95,  D: 170, B: 32,  r: 2.1,  series: 62 },
    '6220':  { d: 100, D: 180, B: 34,  r: 2.1,  series: 62 },
    '6221':  { d: 105, D: 190, B: 36,  r: 2.1,  series: 62 },
    '6222':  { d: 110, D: 200, B: 38,  r: 2.1,  series: 62 },
    '6224':  { d: 120, D: 215, B: 40,  r: 2.1,  series: 62 },
    '6226':  { d: 130, D: 230, B: 40,  r: 3,    series: 62 },
    '6228':  { d: 140, D: 250, B: 42,  r: 3,    series: 62 },
    // ── 63 계열 ──
    '633':   { d: 3,   D: 13,  B: 5,   r: 0.2,  series: 63 },
    '634':   { d: 4,   D: 16,  B: 5,   r: 0.3,  series: 63 },
    '635':   { d: 5,   D: 19,  B: 6,   r: 0.3,  series: 63 },
    '636':   { d: 6,   D: 22,  B: 7,   r: 0.3,  series: 63 },
    '637':   { d: 7,   D: 26,  B: 9,   r: 0.3,  series: 63 },
    '638':   { d: 8,   D: 28,  B: 9,   r: 0.3,  series: 63 },
    '639':   { d: 9,   D: 30,  B: 10,  r: 0.6,  series: 63 },
    '6300':  { d: 10,  D: 35,  B: 11,  r: 0.6,  series: 63 },
    '6301':  { d: 12,  D: 37,  B: 12,  r: 1,    series: 63 },
    '6302':  { d: 15,  D: 42,  B: 13,  r: 1,    series: 63 },
    '6303':  { d: 17,  D: 47,  B: 14,  r: 1,    series: 63 },
    '6304':  { d: 20,  D: 52,  B: 15,  r: 1.1,  series: 63 },
    '63/22': { d: 22,  D: 56,  B: 16,  r: 1.1,  series: 63 },
    '6305':  { d: 25,  D: 62,  B: 17,  r: 1.1,  series: 63 },
    '63/28': { d: 28,  D: 68,  B: 18,  r: 1.1,  series: 63 },
    '6306':  { d: 30,  D: 72,  B: 19,  r: 1.1,  series: 63 },
    '63/32': { d: 32,  D: 75,  B: 20,  r: 1.1,  series: 63 },
    '6307':  { d: 35,  D: 80,  B: 21,  r: 1.5,  series: 63 },
    '6308':  { d: 40,  D: 90,  B: 23,  r: 1.5,  series: 63 },
    '6309':  { d: 45,  D: 100, B: 25,  r: 1.5,  series: 63 },
    '6310':  { d: 50,  D: 110, B: 27,  r: 2,    series: 63 },
    '6311':  { d: 55,  D: 120, B: 29,  r: 2,    series: 63 },
    '6312':  { d: 60,  D: 130, B: 31,  r: 2.1,  series: 63 },
    '6313':  { d: 65,  D: 140, B: 33,  r: 2.1,  series: 63 },
    '6314':  { d: 70,  D: 150, B: 35,  r: 2.1,  series: 63 },
    '6315':  { d: 75,  D: 160, B: 37,  r: 2.1,  series: 63 },
    '6316':  { d: 80,  D: 170, B: 39,  r: 2.1,  series: 63 },
    '6317':  { d: 85,  D: 180, B: 41,  r: 3,    series: 63 },
    '6318':  { d: 90,  D: 190, B: 43,  r: 3,    series: 63 },
    '6319':  { d: 95,  D: 200, B: 45,  r: 3,    series: 63 },
    '6320':  { d: 100, D: 215, B: 47,  r: 3,    series: 63 },
    '6321':  { d: 105, D: 225, B: 49,  r: 3,    series: 63 },
    '6322':  { d: 110, D: 240, B: 50,  r: 3,    series: 63 },
    '6324':  { d: 120, D: 260, B: 55,  r: 3,    series: 63 },
    '6326':  { d: 130, D: 280, B: 58,  r: 4,    series: 63 },
    '6328':  { d: 140, D: 300, B: 62,  r: 4,    series: 63 },
    // ── 64 계열 ──
    '648':   { d: 8,   D: 30,  B: 10,  r: 0.6,  series: 64 },
    '649':   { d: 9,   D: 32,  B: 11,  r: 0.6,  series: 64 },
    '6400':  { d: 10,  D: 37,  B: 12,  r: 0.6,  series: 64 },
    '6401':  { d: 12,  D: 42,  B: 13,  r: 1,    series: 64 },
    '6402':  { d: 15,  D: 52,  B: 15,  r: 1.1,  series: 64 },
    '6403':  { d: 17,  D: 62,  B: 17,  r: 1.1,  series: 64 },
    '6404':  { d: 20,  D: 72,  B: 19,  r: 1.1,  series: 64 },
    '6405':  { d: 25,  D: 80,  B: 21,  r: 1.5,  series: 64 },
    '6406':  { d: 30,  D: 90,  B: 23,  r: 1.5,  series: 64 },
    '6407':  { d: 35,  D: 100, B: 25,  r: 1.5,  series: 64 },
    '6408':  { d: 40,  D: 110, B: 27,  r: 2,    series: 64 },
    '6409':  { d: 45,  D: 120, B: 29,  r: 2,    series: 64 },
    '6410':  { d: 50,  D: 130, B: 31,  r: 2.1,  series: 64 },
    '6411':  { d: 55,  D: 140, B: 33,  r: 2.1,  series: 64 },
    '6412':  { d: 60,  D: 150, B: 35,  r: 2.1,  series: 64 },
    '6413':  { d: 65,  D: 160, B: 37,  r: 2.1,  series: 64 },
    '6414':  { d: 70,  D: 180, B: 42,  r: 3,    series: 64 },
    '6415':  { d: 75,  D: 190, B: 45,  r: 3,    series: 64 },
    '6416':  { d: 80,  D: 200, B: 48,  r: 3,    series: 64 },
    '6417':  { d: 85,  D: 210, B: 52,  r: 4,    series: 64 },
    '6418':  { d: 90,  D: 225, B: 54,  r: 4,    series: 64 },
    '6419':  { d: 95,  D: 240, B: 55,  r: 4,    series: 64 },
    '6420':  { d: 100, D: 250, B: 58,  r: 4,    series: 64 },
    '6421':  { d: 105, D: 260, B: 60,  r: 4,    series: 64 },
    '6422':  { d: 110, D: 280, B: 65,  r: 4,    series: 64 },
    '6424':  { d: 120, D: 310, B: 72,  r: 5,    series: 64 },
    '6426':  { d: 130, D: 340, B: 78,  r: 5,    series: 64 },
  };

  /**
   * 베어링 호칭번호로 KS B 2023 깊은 홈 볼베어링 규격을 조회한다.
   * @param {string} designation - 호칭번호 (예: '6206', '60/22')
   * @returns {object}
   *   - found=true:  { found:true, designation, d, D, B, r, series }
   *   - found=false: { found:false, reason:'not_found', designation }
   */
  function lookupBearingByDesignation(designation) {
    if (designation == null) return { found: false, reason: 'not_found', designation };
    const key = String(designation).trim();
    const rec = DEEP_GROOVE_BEARING_TABLE[key];
    if (rec) {
      return { found: true, designation: key, d: rec.d, D: rec.D, B: rec.B, r: rec.r, series: rec.series };
    }
    return { found: false, reason: 'not_found', designation: key };
  }

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
    SNAP_RING_KS_TABLE,
    lookupSnapRingByShaft,
    DEEP_GROOVE_BEARING_TABLE,
    lookupBearingByDesignation,
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
