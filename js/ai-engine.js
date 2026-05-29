/* ============================================================
   ai-engine.js  v5 — 기계도면 AI 해석 엔진
   ============================================================

   ═══════════════════════════════════════════════════════════
   v5 핵심 변경: "형상 복제기" 아키텍처 전환
   ═══════════════════════════════════════════════════════════

   v4 → v5 변경 요약:
     v4: "형상 + 치수 + 재질 + 가공정보"를 모두 recall 우선으로 생성
     v5: "형상·외곽·중심선·배치 최우선 복제"
         메타정보(재질·표면거칠기·치수·탭·키홈 등)는
         원본에 명확히 있을 때만 유지, 나머지는 placeholder로 남김

   ───────────────────────────────────────────────────────────
   핵심 원칙:
     1. 형상 트레이싱 최우선 — 전체 외형 비율·좌우 단차·중심선 유지
     2. 메타정보 자동 확정 금지 — 불확실하면 null/"직접입력" placeholder
     3. 원본 숫자 보존 — 원본에 없는 숫자 생성 금지
     4. Spec 구조 분리 — geometrySpec (형상) / annotationSpec (메타)
     5. Self-check — 형상 일치율 우선, annotation 누락은 치명 오류 아님

   ───────────────────────────────────────────────────────────
   5단계 파이프라인:
     1. classifyDrawingType(file)
     2. extractConfirmedSignals(classification)
     3. buildShaftCandidates(signals)
     4. resolveSpecFromCandidates(candidates)
        → { geometrySpec, annotationSpec }
     5. selfCheckSpec(spec)
        → 형상 일치율 우선, annotation 누락은 warning만

   출력 정책:
     AI는 '완성 도면'이 아니라 '형상 초안 + 빈 정보칸' 상태로 출력
     사용자가 편집기에서 직접 메타정보를 채움
   ============================================================ */

const AIEngine = (() => {

  // ============================================================
  // CONFIDENCE / PLACEHOLDER 상수
  // ============================================================
  const CONF = Object.freeze({
    CONFIRMED: 'confirmed',   // 원본에서 명확히 읽힌 값
    ESTIMATED: 'estimated',   // 강한 후보 (구조적으로 거의 확실)
    UNCERTAIN: 'uncertain',   // 불확실 — 표기만
  });

  // placeholder 정책: 불확실한 annotation에 사용
  const PLACEHOLDER = Object.freeze({
    TEXT: '직접입력',
    EMPTY: null,              // JSON에서는 null
    LABEL: '미확정',
    VALUE_INPUT: '값입력',
  });


  // ============================================================
  // Stage 1: 도면 유형 분류 (Classifier)
  //
  // unknown이어도 전체를 버리지 않는다.
  // partial 신호가 있으면 shaft 후보로 진행.
  // ============================================================

  function classifyDrawingType(file) {
    if (!file) return { type: 'unknown', score: 0, hints: [] };
    const name = (file.name || '').toLowerCase();

    const mechKeywords = [
      'shaft', 'gear', 'bearing', 'bolt', 'nut', 'flange', 'coupling',
      'pin', 'bushing', 'piston', 'cylinder', 'spindle', 'pulley',
      'axle', 'housing', 'bracket', 'part', 'mech', 'machine',
      '축', '기계', '부품', '샤프트', '기어', '플랜지', '베어링',
      'φ', 'ø', 'tap', 'drill', 'bore',
    ];

    const hints = [];
    let score = 0;
    mechKeywords.forEach(k => {
      if (name.includes(k)) { score++; hints.push(k); }
    });

    const type = score > 0 ? 'mechanical' : 'unknown';
    return { type, score, hints };
  }


  // ============================================================
  // Stage 2: 확실 신호 추출 (extractConfirmedSignals)
  //
  // v5 변경: 형상 신호(외곽, 중심선, 단차 위치)는 최대한 추출
  //          메타 신호(재질, 표면거칠기, 탭 규격 등)는 원본에
  //          명확히 적혀 있을 때만 confirmed, 아니면 null
  //
  // 시뮬레이션: Vision AI가 손그림에서 추출한 신호들
  // ============================================================

  function extractConfirmedSignals(classification) {

    const signals = {
      // ─── 형상 신호 (geometrySpec 대상) ───
      // 이 부분은 "보이는 대로" 최대한 추출

      hasHorizontalCenterline: { value: true, confidence: CONF.CONFIRMED },
      shaftLikelihood: { value: 0.92, confidence: CONF.CONFIRMED },

      // 전체 길이
      totalLength: { value: 220, confidence: CONF.CONFIRMED },

      // 구간별 길이 (좌→우) — 원본 숫자 그대로
      segmentLengths: [
        { value: 50,  confidence: CONF.CONFIRMED, position: 'left' },
        { value: 111, confidence: CONF.CONFIRMED, position: 'center' },
        { value: 59,  confidence: CONF.CONFIRMED, position: 'right' },
      ],

      // 직경 (φ/Ø 표기에서 읽음) — 원본에 명확히 있는 것만
      diameters: [
        { value: 20, confidence: CONF.CONFIRMED, segments: ['left', 'right'] },
        { value: 35, confidence: CONF.CONFIRMED, segments: ['center'] },
      ],

      // v5.8: 구멍/탭은 hiddenFeatures로 이동
      holes: [],

      // v5.8: 슬롯은 보조투상도로 이동 (메인 도면에 슬롯 없음)
      slots: [],

      // ★ v5.8: 숨은선 (hiddenFeatures) — 원본 도면의 점선을 그대로 추출
      hiddenFeatures: [
        // 블록1: S1 M10 TAP (좌측 끝면→30mm 깊이)
        {
          id: 'HF1', section: 'S1', type: 'tap-bore',
          diameter: 10, depth: 30,
          side: 'left',
          confidence: CONF.CONFIRMED,
        },
        // 블록2: S1 키홈 (깊이3.5mm, 가로32mm, 세로6mm)
        {
          id: 'HF2', section: 'S1', type: 'keyway',
          keywayWidth: 32, keywayHeight: 6, keywayDepth: 3.5,
          side: 'left',
          confidence: CONF.CONFIRMED,
        },
        // 블록3: S3 M10 TAP (우측 끝면→30mm 깊이)
        {
          id: 'HF3', section: 'S3', type: 'tap-bore',
          diameter: 10, depth: 30,
          side: 'right',
          confidence: CONF.CONFIRMED,
        },
        // 블록4: S3 키홈 (깊이3.5mm, 가로40mm, 세로6mm)
        {
          id: 'HF4', section: 'S3', type: 'keyway',
          keywayWidth: 40, keywayHeight: 6, keywayDepth: 3.5,
          side: 'right',
          confidence: CONF.CONFIRMED,
        },
      ],

      // ★ v5.8: 보조 투상도 — 키홈을 위에서 본 모양
      auxiliaryViews: [
        {
          id: 'AUX1',
          position: 'top-left',
          label: '',
          shape: { type: 'obround', width: 32, height: 6, confidence: CONF.CONFIRMED },
          dimensions: [
            { axis: 'horizontal', value: 32, confidence: CONF.CONFIRMED },
            { axis: 'vertical',   value: 6,  confidence: CONF.CONFIRMED },
          ],
          relatedSection: 'S1',
          projectionLines: true,
        },
        {
          id: 'AUX2',
          position: 'top-right',
          label: '',
          shape: { type: 'obround', width: 40, height: 6, confidence: CONF.CONFIRMED },
          dimensions: [
            { axis: 'horizontal', value: 40, confidence: CONF.CONFIRMED },
            { axis: 'vertical',   value: 6,  confidence: CONF.CONFIRMED },
          ],
          relatedSection: 'S3',
          projectionLines: true,
        },
      ],

      // ─── 주석/메타 신호 (annotationSpec 대상) ───
      // v5: 원본에 명확히 적혀있지 않으면 null/placeholder

      // 면취 — 존재 자체는 보이지만 규격(C1 등)은 불확실
      chamfers: [
        { side: 'left',  spec: null, confidence: CONF.UNCERTAIN },
        { side: 'right', spec: null, confidence: CONF.UNCERTAIN },
      ],

      // v5.8: 키홈은 hiddenFeatures에서 관리 (keyways 시그널 비활성화)
      keyways: [],

      // 센터구멍 — 존재는 보이지만 직경은 불확실
      centerHoles: [
        { side: 'left',  diameter: null, confidence: CONF.UNCERTAIN },
        { side: 'right', diameter: null, confidence: CONF.UNCERTAIN },
      ],

      // 재질 — 원본에 텍스트로 적혀있지 않으면 null
      material: { value: null, confidence: CONF.UNCERTAIN },
      // 표면거칠기 — 원본에 없으면 null
      surfaceFinish: { value: null, confidence: CONF.UNCERTAIN },

      // 불확실 신호
      uncertainSignals: [],

      // ★ v5.8: 탭 규격 (annotation용 — hiddenFeatures와 연동)
      tapSpecs: [
        { holeId: 'HF1', section: 'S1', spec: 'M10 TAP 깊이30', specConf: CONF.CONFIRMED },
        { holeId: 'HF3', section: 'S3', spec: 'M10 TAP 깊이30', specConf: CONF.CONFIRMED },
      ],
    };

    console.log('[AIEngine:Stage2] Extracted signals:', JSON.stringify(signals, null, 2));
    return signals;
  }


  // ============================================================
  // Stage 3: shaft 후보 생성기 (buildShaftCandidates)
  //
  // v5 변경:
  //   - geometrySpec: 외곽, 중심선, 단차, 구멍/슬롯 위치
  //   - annotationSpec: 재질, 표면거칠기, 탭 규격, 면취 규격 등
  //   - 메타정보는 자동 확정하지 않고 placeholder로 남김
  // ============================================================

  function buildShaftCandidates(signals) {
    const candidates = {
      // ─── geometrySpec 영역 ───
      geometry: {
        sections: [],
        totalLength: null,
        totalLengthConf: CONF.UNCERTAIN,
        holes: [],
        slots: [],
        chamferPositions: [],     // 위치만 (spec은 annotation)
        centerHolePositions: [],  // 위치만 (직경은 annotation)
        hiddenFeatures: [],       // v5.8: 숨은선 feature
      },

      // ─── annotationSpec 영역 ───
      annotation: {
        partName: PLACEHOLDER.TEXT,       // 사용자 입력
        partNo: PLACEHOLDER.TEXT,         // 사용자 입력
        material: PLACEHOLDER.EMPTY,      // null
        materialConf: CONF.UNCERTAIN,
        surfaceFinish: PLACEHOLDER.EMPTY, // null
        surfaceFinishConf: CONF.UNCERTAIN,
        unit: 'mm',
        scale: '1:1',
        projectionMethod: '3각법',
        paperSize: 'A3',
        chamferSpecs: [],     // 면취 규격 (C1 등)
        keywaySpecs: [],      // 키홈 규격 (8x4 등)
        tapSpecs: [],         // 탭 규격 (M10x1.5 등)
        centerHoleDiameters: [],
        notes: [],
      },

      uncertainElements: [],
    };

    // ── 3-a) 전체 길이 ──
    if (signals.totalLength) {
      candidates.geometry.totalLength = signals.totalLength.value;
      candidates.geometry.totalLengthConf = signals.totalLength.confidence;
    }

    // ── 3-b) 구간 생성 ──
    const segLens = signals.segmentLengths || [];
    const diams = signals.diameters || [];

    // 직경 맵: position → diameter/confidence
    const diamMap = {};
    diams.forEach(d => {
      (d.segments || []).forEach(seg => {
        diamMap[seg] = { value: d.value, confidence: d.confidence };
      });
    });

    segLens.forEach((seg, i) => {
      const pos = seg.position || `seg_${i}`;
      const diam = diamMap[pos];

      // ★ v111: 구간별 모따기 데이터 매핑
      const secChamfer = (signals.sectionChamfers || []).find(sc => sc.section === `S${i + 1}`);
      // ★ v114: 구간별 프로파일 (CYLINDER/TAPER) 매핑
      const secProfile = (signals.sectionProfiles || []).find(sp => sp.section === `S${i + 1}`);
      candidates.geometry.sections.push({
        id: `S${i + 1}`,
        length: seg.value,
        lengthConf: seg.confidence,
        diameter: diam ? diam.value : null,
        diameterConf: diam ? diam.confidence : CONF.UNCERTAIN,
        note: diam ? null : '직경 미감지 — 원본 확인 필요',
        chamferLeft: secChamfer ? secChamfer.left : 0,    // v111: 좌측 모따기 (mm)
        chamferRight: secChamfer ? secChamfer.right : 0,  // v111: 우측 모따기 (mm)
        profile: secProfile ? secProfile.profile : 'CYLINDER',   // v114: 프로파일 타입
        diameterEnd: secProfile ? secProfile.diameterEnd : null, // v114: 테이퍼 끝직경 (우측)
      });
    });

    // ── 3-c) 직경 미감지 구간 uncertain 기록 ──
    candidates.geometry.sections.forEach(sec => {
      if (sec.diameter === null) {
        candidates.uncertainElements.push({
          id: `UE_diam_${sec.id}`,
          description: `구간 ${sec.id} 직경 미감지`,
          location: sec.id,
          severity: 'medium',
          confidence: CONF.UNCERTAIN,
        });
      }
    });

    // ── 3-d) 구멍/탭 — 위치만 geometry, 규격은 annotation ──
    (signals.holes || []).forEach((h, i) => {
      const secIdx = resolveLocationIndex(h.location, candidates.geometry.sections);
      if (secIdx === -1) return;

      const sec = candidates.geometry.sections[secIdx];
      candidates.geometry.holes.push({
        id: `H${i + 1}`,
        cx_section: sec.id,
        cx_offset: sec.length * (h.offsetRatio || 0.5),
        diameter: h.diameter,
        depth: h.depth,
        holeType: h.type || 'through',
        symmetry: h.symmetry !== false,
        confidence: h.confidence,
        note: null,
      });

      // 탭 규격은 annotation
      if (h.type === 'tap') {
        candidates.annotation.tapSpecs.push({
          holeId: `H${i + 1}`,
          section: sec.id,
          spec: h.tapSpec || null,                   // null = placeholder
          specConf: h.tapSpecConf || CONF.UNCERTAIN, // 불확실
        });
      }
    });

    // ── 3-d2) v5.8: hiddenFeatures 통과 ──
    if (signals.hiddenFeatures && signals.hiddenFeatures.length > 0) {
      candidates.geometry.hiddenFeatures = [...signals.hiddenFeatures];
    }

    // ── 3-d3) v5.8: tapSpecs (signal에서 직접 전달된 경우) ──
    if (signals.tapSpecs && signals.tapSpecs.length > 0) {
      signals.tapSpecs.forEach(ts => {
        // 중복 방지: holeId로 확인
        if (!candidates.annotation.tapSpecs.find(existing => existing.holeId === ts.holeId)) {
          candidates.annotation.tapSpecs.push(ts);
        }
      });
    }

    // ── 3-e) 슬롯 — 위치·크기만 ──
    (signals.slots || []).forEach((sl, i) => {
      const secIdx = resolveLocationIndex(sl.location, candidates.geometry.sections);
      if (secIdx === -1) return;

      const sec = candidates.geometry.sections[secIdx];
      candidates.geometry.slots.push({
        id: `SL${i + 1}`,
        cx_section: sec.id,
        cx_offset: sec.length * (sl.offsetRatio || 0.36),
        slotLength: sl.length,
        slotWidth: sl.width,
        position: sl.position || 'top',
        symmetry: sl.symmetry !== false,
        confidence: sl.confidence,
        note: null,
      });
    });

    // ── 3-f) 면취 위치 — 규격은 annotation ──
    (signals.chamfers || []).forEach(ch => {
      const secId = ch.side === 'left' ? candidates.geometry.sections[0]?.id
                  : ch.side === 'right' ? candidates.geometry.sections[candidates.geometry.sections.length - 1]?.id
                  : null;
      if (!secId) return;

      candidates.geometry.chamferPositions.push({
        section: secId,
        side: ch.side,
        confidence: ch.confidence,
      });

      candidates.annotation.chamferSpecs.push({
        section: secId,
        side: ch.side,
        spec: ch.spec || null,            // null = placeholder
        specConf: ch.confidence,
      });
    });

    // ── 3-g) 키홈 — 불확실하면 uncertain 기록만 ──
    (signals.keyways || []).forEach(kw => {
      if (kw.confidence === CONF.UNCERTAIN) {
        candidates.uncertainElements.push({
          id: `UE_keyway_${candidates.uncertainElements.length}`,
          description: '키홈 존재 불확실 — 원본 확인 필요',
          location: kw.location || 'unknown',
          severity: 'low',
          confidence: CONF.UNCERTAIN,
        });
        // 키홈 규격도 placeholder로 준비
        candidates.annotation.keywaySpecs.push({
          section: null,
          width: kw.width,      // null
          depth: kw.depth,      // null
          specConf: CONF.UNCERTAIN,
        });
        return;
      }
      // confirmed/estimated 키홈: geometry에 추가
      const secIdx = resolveLocationIndex(kw.location, candidates.geometry.sections);
      if (secIdx === -1) return;
      candidates.annotation.keywaySpecs.push({
        section: candidates.geometry.sections[secIdx].id,
        width: kw.width,
        depth: kw.depth,
        specConf: kw.confidence,
      });
    });

    // ── 3-h) 센터구멍 위치 — 직경은 annotation ──
    (signals.centerHoles || []).forEach(ch => {
      candidates.geometry.centerHolePositions.push({
        side: ch.side,
        confidence: ch.confidence,
      });
      candidates.annotation.centerHoleDiameters.push({
        side: ch.side,
        diameter: ch.diameter,  // null = placeholder
        diamConf: ch.confidence,
      });
    });

    // ── 3-i) 재질/표면거칠기 → annotation ──
    if (signals.material && signals.material.value != null) {
      candidates.annotation.material = signals.material.value;
      candidates.annotation.materialConf = signals.material.confidence;
    }
    if (signals.surfaceFinish && signals.surfaceFinish.value != null) {
      candidates.annotation.surfaceFinish = signals.surfaceFinish.value;
      candidates.annotation.surfaceFinishConf = signals.surfaceFinish.confidence;
    }

    // ── 3-i2) 품명/척도/각법 → annotation ──
    if (signals.partName && signals.partName.value != null) {
      candidates.annotation.partName = signals.partName.value;
    }
    if (signals.scale) {
      candidates.annotation.scale = signals.scale;
    }
    if (signals.projectionMethod) {
      candidates.annotation.projectionMethod = signals.projectionMethod;
    }
    if (signals.paperSize) {
      candidates.annotation.paperSize = signals.paperSize;
    }

    // ── 3-j) 불확실 신호 취합 ──
    (signals.uncertainSignals || []).forEach(us => {
      candidates.uncertainElements.push({
        id: `UE_sig_${candidates.uncertainElements.length}`,
        description: us.description,
        location: us.location || 'unknown',
        severity: us.severity || 'low',
        confidence: CONF.UNCERTAIN,
      });
    });

    console.log('[AIEngine:Stage3] Shaft candidates:', JSON.stringify(candidates, null, 2));
    // v5.8: pass auxiliaryViews through
    candidates._auxiliaryViews = signals.auxiliaryViews || [];
    // v8: 중공축 데이터 전달
    candidates._hollowShaftData = signals.hollowShaftData || null;
    candidates._shaftType = signals.shaftType || 'solid';
    // v26: 체인스프라켓 데이터 전달
    candidates._chainGears = signals.chainGears || [];
    return candidates;
  }

  /** 위치 문자열 → sections 인덱스 매핑 */
  function resolveLocationIndex(location, sections) {
    if (!location || !sections.length) return -1;
    const loc = location.toLowerCase();
    if (loc === 'left' || loc === 'start') return 0;
    if (loc === 'right' || loc === 'end') return sections.length - 1;
    if (loc === 'center' || loc === 'middle') return Math.floor(sections.length / 2);
    const match = loc.match(/s(\d+)/i);
    if (match) {
      const idx = parseInt(match[1]) - 1;
      if (idx >= 0 && idx < sections.length) return idx;
    }
    return Math.floor(sections.length / 2);
  }


  // ============================================================
  // Stage 4: 후보 → 최종 spec 정리 (resolveSpecFromCandidates)
  //
  // v5: geometrySpec / annotationSpec 분리 구조
  //
  // geometrySpec: 반드시 생성 (형상 복제)
  // annotationSpec: placeholder 상태로 포함
  //   - confirmed → 값 유지
  //   - estimated → 값 유지 (렌더링 시 흐리게)
  //   - uncertain → null/placeholder
  // ============================================================

  function resolveSpecFromCandidates(candidates) {
    const spec = {
      // ─── geometrySpec ───
      geometrySpec: {
        sections: [],
        totalLength: candidates.geometry.totalLength,
        totalLengthConf: candidates.geometry.totalLengthConf,
        holes: [],
        slots: [],
        chamferPositions: [...candidates.geometry.chamferPositions],
        centerHolePositions: [...candidates.geometry.centerHolePositions],
        hiddenFeatures: [...(candidates.geometry.hiddenFeatures || [])],
      },

      // ─── annotationSpec ───
      annotationSpec: {
        partName: candidates.annotation.partName,       // '직접입력'
        partNo: candidates.annotation.partNo,           // '직접입력'
        material: candidates.annotation.material,       // null
        materialConf: candidates.annotation.materialConf,
        surfaceFinish: candidates.annotation.surfaceFinish, // null
        surfaceFinishConf: candidates.annotation.surfaceFinishConf,
        unit: candidates.annotation.unit,
        scale: candidates.annotation.scale,
        projectionMethod: candidates.annotation.projectionMethod || '3각법',
        paperSize: candidates.annotation.paperSize || 'A3',
        chamferSpecs: [...candidates.annotation.chamferSpecs],
        keywaySpecs: [...candidates.annotation.keywaySpecs],
        tapSpecs: [...candidates.annotation.tapSpecs],
        centerHoleDiameters: [...candidates.annotation.centerHoleDiameters],
        notes: [...candidates.annotation.notes],
      },

      uncertainElements: [...candidates.uncertainElements],
      auxiliaryViews: [...(candidates._auxiliaryViews || [])],
      // v8: 중공축 데이터
      hollowShaftData: candidates._hollowShaftData || null,
      shaftType: candidates._shaftType || 'solid',
      // v26: 체인스프라켓 데이터
      chainGears: [...(candidates._chainGears || [])],
      _reviewRequired: true, // v5: 항상 review (형상 초안 상태)
    };

    // ── sections ──
    candidates.geometry.sections.forEach(sec => {
      spec.geometrySpec.sections.push({
        id: sec.id,
        length: sec.length,
        lengthConf: sec.lengthConf,
        diameter: sec.diameter,
        diameterConf: sec.diameterConf,
        note: sec.note,
        chamferLeft: sec.chamferLeft || 0,    // v111: 모따기
        chamferRight: sec.chamferRight || 0,  // v111: 모따기
        profile: sec.profile || 'CYLINDER',   // v114: 프로파일
        diameterEnd: sec.diameterEnd || null, // v114: 테이퍼 끝직경
      });
    });

    // ── holes: confirmed + estimated만 geometry 포함 ──
    candidates.geometry.holes.forEach(h => {
      if (h.confidence === CONF.UNCERTAIN) {
        spec.uncertainElements.push({
          id: `UE_hole_${h.id}`,
          description: `구멍 위치 불확실`,
          location: h.cx_section,
          severity: 'medium',
          confidence: CONF.UNCERTAIN,
        });
      } else {
        spec.geometrySpec.holes.push(h);
      }
    });

    // ── slots: confirmed + estimated만 geometry 포함 ──
    candidates.geometry.slots.forEach(sl => {
      if (sl.confidence === CONF.UNCERTAIN) {
        spec.uncertainElements.push({
          id: `UE_slot_${sl.id}`,
          description: `슬롯 위치/크기 불확실`,
          location: sl.cx_section,
          severity: 'medium',
          confidence: CONF.UNCERTAIN,
        });
      } else {
        spec.geometrySpec.slots.push(sl);
      }
    });

    console.log('[AIEngine:Stage4] Resolved spec:', JSON.stringify(spec, null, 2));
    return spec;
  }


  // ============================================================
  // Stage 5: Self-check (selfCheckSpec)
  //
  // v5 변경:
  //   - 형상 일치율을 우선 평가
  //   - annotation 누락은 치명 오류로 간주하지 않음
  //   - 원본에 없는 정보 생성 시 감점
  // ============================================================

  function selfCheckSpec(spec) {
    const errors = [];
    const warnings = [];
    const geometryScore = { total: 0, matched: 0 };

    const geo = spec.geometrySpec;
    const ann = spec.annotationSpec;

    // ── a) 구간 길이 합 = totalLength ──
    const validSections = geo.sections.filter(s => s.length != null);
    const sumLengths = validSections.reduce((sum, s) => sum + s.length, 0);
    if (geo.totalLength != null && sumLengths !== geo.totalLength) {
      const diff = Math.abs(sumLengths - geo.totalLength);
      // v6: 작은 차이는 warning, 큰 차이만 error (Vision AI 반올림 허용)
      const msg = `구간 길이 합(${sumLengths}) ≠ 전체 길이(${geo.totalLength}) 차이: ${diff}mm`;
      if (diff > geo.totalLength * 0.1) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
    geometryScore.total += 2;
    if (geo.totalLength != null && sumLengths === geo.totalLength) geometryScore.matched += 2;

    // ── b) 직경 미감지 구간 — warning (not error) ──
    geo.sections.forEach(s => {
      geometryScore.total++;
      if (s.diameter != null) {
        geometryScore.matched++;
      } else {
        warnings.push(`${s.id}: 직경 미감지 — placeholder 렌더링`);
      }
    });

    // ── c) 대칭 구조 참고 ──
    const secs = geo.sections;
    if (secs.length >= 3) {
      geometryScore.total++;
      const first = secs[0], last = secs[secs.length - 1];
      if (first.diameter != null && last.diameter != null) {
        if (first.diameter === last.diameter) {
          geometryScore.matched++;
        }
        if (first.diameter === last.diameter && first.length !== last.length) {
          warnings.push(
            `양단 길이 다름: ${first.id}=${first.length}mm, ` +
            `${last.id}=${last.length}mm — 원본 의도 확인`
          );
        }
      }
    }

    // ── d) symmetry 요소 소속 확인 ──
    geo.holes.filter(h => h.symmetry).forEach(h => {
      if (!geo.sections.find(s => s.id === h.cx_section)) {
        errors.push(`구멍 ${h.id}: 소속 구간 ${h.cx_section} 없음`);
      }
    });
    geo.slots.filter(sl => sl.symmetry).forEach(sl => {
      if (!geo.sections.find(s => s.id === sl.cx_section)) {
        errors.push(`슬롯 ${sl.id}: 소속 구간 ${sl.cx_section} 없음`);
      }
    });

    // ── e) 형상 필수 요소 체크 ──
    geometryScore.total++;
    if (geo.sections.length > 0) geometryScore.matched++; // 구간 존재
    geometryScore.total++;
    if (geo.totalLength != null) geometryScore.matched++;  // 전체 길이 존재

    // ── e-2) 직경 변화 경계 체크 ──
    // 인접 section 간 직경이 다르면 경계에서 각 section의 좌/우면이 그려져야 한다.
    // generateFromSpec()에서 모든 section의 4변을 그리므로, 경계의 면은 자동으로 포함됨.
    const stepBoundaries = [];
    for (let vi = 0; vi < secs.length - 1; vi++) {
      const curSec = secs[vi];
      const nextSec = secs[vi + 1];
      if (curSec.diameter == null || nextSec.diameter == null) continue;
      // v114: 테이퍼인 경우 경계 직경은 우측/좌측 각각
      const curRightDiam = (curSec.profile === 'TAPER' && curSec.diameterEnd) ? curSec.diameterEnd : curSec.diameter;
      const nextLeftDiam = nextSec.diameter; // 좌측 직경 (= diameter 필드)
      if (curRightDiam !== nextLeftDiam) {
        stepBoundaries.push({
          boundary: `${curSec.id}↔${nextSec.id}`,
          diam1: curRightDiam,
          diam2: nextLeftDiam,
        });
      }
    }

    // 경계 면 체크: 모든 section이 4변을 그리므로 항상 matched
    geometryScore.total += stepBoundaries.length;
    stepBoundaries.forEach(() => { geometryScore.matched++; });

    if (stepBoundaries.length > 0) {
      const boundaryList = stepBoundaries
        .map(sb => `${sb.boundary} (Ø${sb.diam1}↔Ø${sb.diam2})`)
        .join(', ');
      console.log(`[AIEngine:Stage5] 직경 변화 경계: ${boundaryList}`);
    }

    // ── f) annotation placeholder 상태 보고 (warning, not error) ──
    const placeholderItems = [];
    if (!ann.material) placeholderItems.push('재질');
    if (!ann.surfaceFinish) placeholderItems.push('표면거칠기');
    ann.tapSpecs.forEach(ts => {
      if (!ts.spec) placeholderItems.push(`탭 규격(${ts.holeId})`);
    });
    ann.chamferSpecs.forEach(cs => {
      if (!cs.spec) placeholderItems.push(`면취 규격(${cs.side})`);
    });
    ann.keywaySpecs.forEach(kw => {
      if (kw.width == null || kw.depth == null) placeholderItems.push('키홈 규격');
    });
    ann.centerHoleDiameters.forEach(ch => {
      if (ch.diameter == null) placeholderItems.push(`센터구멍 직경(${ch.side})`);
    });

    if (placeholderItems.length > 0) {
      warnings.push(`placeholder 상태 (사용자 입력 필요): ${placeholderItems.join(', ')}`);
    }

    // ── g) 불확실 요소 수 ──
    if (spec.uncertainElements.length > 0) {
      warnings.push(`불확실 요소 ${spec.uncertainElements.length}개 — review 필요`);
    }

    // ── g-2) 보조 투상도 검증 ──
    const auxViews = spec.auxiliaryViews || [];
    if (auxViews.length > 0) {
      geometryScore.total += auxViews.length;
      auxViews.forEach(aux => {
        if (aux.shape && aux.shape.width > 0 && aux.shape.height > 0) {
          geometryScore.matched++;
        }
      });
    }

    // ── g-3) 숨은선 검증 (v5.6: type별 검증) ──
    const hiddenFeatures = geo.hiddenFeatures || [];
    if (hiddenFeatures.length > 0) {
      geometryScore.total += hiddenFeatures.length;
      hiddenFeatures.forEach(hf => {
        const sec = geo.sections.find(s => s.id === hf.section);
        if (!sec) return;
        
        if (hf.type === 'keyway-floor') {
          // legacy
          if (hf.verticalOffset != null && hf.depthRatio != null) {
            geometryScore.matched++;
          } else {
            warnings.push(`숨은선 ${hf.id}: keyway-floor 파라미터 불완전`);
          }
        } else if (hf.type === 'keyway') {
          // v5.8: keyway — keywayWidth, keywayDepth 필수
          if (hf.keywayWidth != null && hf.keywayDepth != null) {
            geometryScore.matched++;
          } else {
            warnings.push(`숨은선 ${hf.id}: keyway 파라미터 불완전`);
          }
        } else if (hf.type === 'tap-bore') {
          // tap-bore: diameter, depth 존재 필수
          if (hf.diameter != null && hf.depth != null) {
            geometryScore.matched++;
          } else {
            warnings.push(`숨은선 ${hf.id}: tap-bore 파라미터 불완전`);
          }
        } else if (hf.type === 'snapring') {
          // snapring: snapRingDiam, snapRingThickness 필수
          if (hf.snapRingDiam != null && hf.snapRingThickness != null) {
            geometryScore.matched++;
          } else {
            warnings.push(`숨은선 ${hf.id}: snapring 파라미터 불완전`);
          }
        } else if (hf.type === 'through-hole') {
          // through-hole: diameter 필수
          if (hf.diameter != null && hf.diameter > 0) {
            geometryScore.matched++;
          } else {
            warnings.push(`숨은선 ${hf.id}: 관통 구멍 직경 불완전`);
          }
        } else {
          // 기타 type도 section 소속 확인만
          geometryScore.matched++;
        }
      });
    }

    // ── h) 원본에 없는 정보 생성 감점 ──
    // v5: 자동 생성된 "예시값" 체크
    const fabricatedValues = [];
    if (ann.material && ann.materialConf === CONF.UNCERTAIN) {
      fabricatedValues.push(`재질 "${ann.material}" — uncertain 상태에서 자동 생성 의심`);
    }
    if (fabricatedValues.length > 0) {
      errors.push(`원본에 없는 정보 생성 의심: ${fabricatedValues.join('; ')}`);
    }

    // ── i) 형상 일치율 ──
    const geoPercent = geometryScore.total > 0
      ? Math.round((geometryScore.matched / geometryScore.total) * 100)
      : 0;

    // ── confidence 통계 ──
    const confStats = { confirmed: 0, estimated: 0, uncertain: spec.uncertainElements.length };
    geo.sections.forEach(s => {
      if (s.lengthConf === CONF.CONFIRMED) confStats.confirmed++;
      else if (s.lengthConf === CONF.ESTIMATED) confStats.estimated++;
      if (s.diameterConf === CONF.CONFIRMED) confStats.confirmed++;
      else if (s.diameterConf === CONF.ESTIMATED) confStats.estimated++;
      else confStats.uncertain++;
    });
    geo.holes.forEach(h => {
      if (h.confidence === CONF.CONFIRMED) confStats.confirmed++;
      else confStats.estimated++;
    });
    geo.slots.forEach(sl => {
      if (sl.confidence === CONF.CONFIRMED) confStats.confirmed++;
      else confStats.estimated++;
    });

    const result = {
      passed: errors.length === 0,
      errors,
      warnings,
      geometryFidelity: geoPercent,
      stats: {
        sectionCount: secs.length,
        totalLength: geo.totalLength,
        sumLengths,
        holeCount: geo.holes.length,
        slotCount: geo.slots.length,
        chamferPositionCount: geo.chamferPositions.length,
        centerHolePositionCount: geo.centerHolePositions.length,
        stepBoundaryCount: stepBoundaries.length,
        hiddenFeatureCount: hiddenFeatures.length,
        auxiliaryViewCount: auxViews.length,
        uncertainCount: spec.uncertainElements.length,
        placeholderCount: placeholderItems.length,
        confidence: confStats,
      },
    };

    console.log('[AIEngine:Stage5] Self-check:', JSON.stringify(result, null, 2));
    return result;
  }


  // ============================================================
  // ★ Spec → Document 변환기 (generateFromSpec)
  //
  // v5 핵심:
  // - geometry → 일반 실선으로 정상 렌더링
  // - annotation placeholder → 흐리게 / "직접입력" 표시
  // - 메타정보 자동 채움 금지
  // - 출력 = '형상 초안 + 빈 정보칸'
  // ============================================================

  function generateFromSpec(spec) {
    const selfResult = selfCheckSpec(spec);

    const geo = spec.geometrySpec;
    const ann = spec.annotationSpec;

    const doc = DrawingModel.createMechanicalDocument();
    doc.meta.title = `AI 생성 — 형상 초안`;
    doc.meta.scale = ann.scale;
    doc.meta.projectionMethod = ann.projectionMethod || '3각법';
    // v5: 메타정보는 placeholder 상태
    doc.meta.material = ann.material || '';
    doc.meta.surfaceFinish = ann.surfaceFinish || '';
    doc.meta.partName = ann.partName || '';
    doc.meta.partNo = ann.partNo || '';
    doc.meta._reviewRequired = spec._reviewRequired;

    // v7: 척도 파싱 (A:B 형식) — 치수 표시값 적용용
    let scaleA = 1, scaleB = 1;
    const scaleParts = (ann.scale || '1:1').split(':');
    if (scaleParts.length === 2) {
      scaleA = parseFloat(scaleParts[0]) || 1;
      scaleB = parseFloat(scaleParts[1]) || 1;
    }
    const scaleRatio = scaleA / scaleB; // 도면크기/실물크기

    // 척도 적용 도우미: 실물 치수 → 표시 치수
    function applyScale(val) {
      if (scaleRatio === 1) return val;
      const n = parseFloat(val);
      if (isNaN(n)) return val;
      const scaled = n * scaleRatio;
      return Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(2).replace(/\.?0+$/, '');
    }

    // ★ v22: KS 규격 용지 — 윤곽선 기반 레이아웃
    // 용지 크기 (mm, 가로 방향)
    const paperSize = ann.paperSize || 'A3';
    const PAPER_MM = {
      A3: { w: 420, h: 297 },
      A4: { w: 297, h: 210 },
    };
    const paper = PAPER_MM[paperSize] || PAPER_MM.A3;

    // SVG px/mm 비율 — 용지를 SVG 캔버스에 맞춤
    const SVG_PAPER_PX_PER_MM = 2.5;
    const paperW = paper.w * SVG_PAPER_PX_PER_MM;  // 용지 전체 폭 px
    const paperH = paper.h * SVG_PAPER_PX_PER_MM;  // 용지 전체 높이 px

    // KS 규격 여백 (mm)
    const MARGIN_LEFT_MM = 20;   // 좌측 (철하기 여백)
    const MARGIN_OTHER_MM = 10;  // 우/상/하
    const ML = MARGIN_LEFT_MM * SVG_PAPER_PX_PER_MM;
    const MO = MARGIN_OTHER_MM * SVG_PAPER_PX_PER_MM;

    // 윤곽선(내곽) 좌표
    const innerX1 = ML;
    const innerY1 = MO;
    const innerX2 = paperW - MO;
    const innerY2 = paperH - MO;
    const innerW = innerX2 - innerX1;
    const innerH = innerY2 - innerY1;

    // 표제란 크기 (px) — HAN KOOK 표준 (50% 축소, 회사명 행 제거)
    const tbWidth = 200;
    const tbTotalH = 8 + 8 + 6 + 7 + 8;  // 37px (정보8x2 + REV6 + 리비전7+8)

    // ★ 도면 영역: 윤곽선 내부에서 표제란 영역 제외한 가용 공간
    const drawAreaX1 = innerX1 + 20;  // 좌측 여유
    const drawAreaY1 = innerY1 + 20;  // 상단 여유
    const drawAreaX2 = innerX2 - 20;  // 우측 여유
    const drawAreaY2 = innerY2 - 20;  // 하단 여유
    const drawAreaW = drawAreaX2 - drawAreaX1;
    const drawAreaH = drawAreaY2 - drawAreaY1;

    // ★ 동적 스케일 — 도면 콘텐츠를 가용 영역에 맞춤
    const rawTotalLength = geo.totalLength ||
      geo.sections.reduce((sum, s) => sum + (s.length || 0), 0) || 200;
    // v114: 테이퍼 구간의 큰 쪽 직경도 고려
    const maxDiam = Math.max(...geo.sections.map(s => {
      const d1 = s.diameter || 20;
      const d2 = (s.profile === 'TAPER' && s.diameterEnd) ? s.diameterEnd : d1;
      return Math.max(d1, d2);
    }));

    // ★ v102: 물결 생략선 적용 후 시각적 총 길이 (센터링·스케일 기준)
    //   > 1000mm 구간은 10%로 축소, 나머지는 그대로
    const BREAK_THRESHOLD_PRE = 1000;
    const BREAK_RATIO_PRE = 0.10;
    const visualTotalLength = geo.sections.reduce((sum, s) => {
      const len = s.length || 0;
      return sum + (len > BREAK_THRESHOLD_PRE ? len * BREAK_RATIO_PRE : len);
    }, 0) || 200;

    // 도면 콘텐츠 필요 크기 (치수선/텍스트 여백 포함, px 기준)
    //   수평: 중심선 좌우 마진(30) + 축 길이 + 우측 지시선 여백(80)
    //   수직: 상단 치수선(90) + 축 직경 + 하단 지시선/스냅링 텍스트(60)
    const marginCL = 30;   // 중심선 좌측 돌출
    const marginR = 80;    // 우측 여유 (지시선/텍스트)
    const marginTop = 90;  // 상단 여유 (보조투상도 + 치수선)
    const marginBot = 60;  // 하단 여유 (지시선 + 텍스트)

    // PX/mm — 가용 영역에 맞추되 최대 2 (원본 길이 기준 — 스케일 불변)
    const contentNeedW = rawTotalLength + (marginCL + marginR) / 2 + 40;
    const contentNeedH = maxDiam + (marginTop + marginBot) / 2 + 40;
    const PX = Math.min(2, drawAreaW / contentNeedW, drawAreaH / contentNeedH);

    // 실제 콘텐츠 크기 (px) — 센터링은 시각적 길이 기준, 높이는 원본
    const shaftVisualW = visualTotalLength * PX;  // 축 시각 폭 (생략선 반영, 센터링용)
    const shaftH = maxDiam * PX;                  // 축 도면 높이 (직경)
    const totalContentW = marginCL + shaftVisualW + marginR;
    const totalContentH = marginTop + shaftH + marginBot;

    // ★ 윤곽선 내부 중앙 배치
    const ox = drawAreaX1 + (drawAreaW - totalContentW) / 2 + marginCL;
    const oy = drawAreaY1 + (drawAreaH - totalContentH) / 2 + marginTop;

    // ★ v22: 윤곽선(도면 테두리) 렌더링 — KS 규격
    doc.meta.paperSize = paperSize;
    {
      // ── (0) 용지 배경 (백색) — 모든 요소 뒤에 배치 ──
      doc.elements.push({
        id: 'paper_bg',
        type: 'paperBg',
        layer: 'outlines',
        x: 0, y: 0,
        width: paperW, height: paperH,
        fill: '#ffffff',
        stroke: '#9ca3af',
        strokeWidth: 0.5,
        locked: true,
        confidence: CONF.CONFIRMED,
        _isPlaceholder: false,
      });

      // ── (a) 윤곽선(내곽선) — 굵은 실선 ──
      const borderLines = [
        [innerX1, innerY1, innerX2, innerY1], // 상
        [innerX2, innerY1, innerX2, innerY2], // 우
        [innerX2, innerY2, innerX1, innerY2], // 하
        [innerX1, innerY2, innerX1, innerY1], // 좌
      ];
      borderLines.forEach(([x1, y1, x2, y2]) => {
        const bl = DrawingModel.createOutline(x1, y1, x2, y2, 1);
        bl.confidence = CONF.CONFIRMED;
        bl.locked = true;
        doc.elements.push(bl);
      });

      // ── (b) 재단마크 (외곽 코너 L자 마크) ──
      const CM = 8; // 재단마크 길이 (px)
      const corners = [
        { x: 0, y: 0, dx: 1, dy: 1 },
        { x: paperW, y: 0, dx: -1, dy: 1 },
        { x: paperW, y: paperH, dx: -1, dy: -1 },
        { x: 0, y: paperH, dx: 1, dy: -1 },
      ];
      corners.forEach(c => {
        const h = DrawingModel.createOutline(c.x, c.y, c.x + CM * c.dx, c.y, 0.8);
        h.confidence = CONF.CONFIRMED; h.locked = true;
        doc.elements.push(h);
        const v = DrawingModel.createOutline(c.x, c.y, c.x, c.y + CM * c.dy, 0.8);
        v.confidence = CONF.CONFIRMED; v.locked = true;
        doc.elements.push(v);
      });

      // ── (c) 중심마크 — 용지 4변 중앙에 짧은 실선 ──
      const mkLen = 10;
      const centerMarks = [
        // 상변 중심
        [paperW / 2, 0, paperW / 2, MO * 0.5],
        // 하변 중심
        [paperW / 2, paperH, paperW / 2, paperH - MO * 0.5],
        // 좌변 중심
        [0, paperH / 2, ML * 0.4, paperH / 2],
        // 우변 중심
        [paperW, paperH / 2, paperW - MO * 0.5, paperH / 2],
      ];
      centerMarks.forEach(([x1, y1, x2, y2]) => {
        const mk = DrawingModel.createOutline(x1, y1, x2, y2, 0.8);
        mk.confidence = CONF.CONFIRMED; mk.locked = true;
        doc.elements.push(mk);
      });

      // ── (d) 구분선 + 구분기호 (윤곽선 외벽에 눈금) ──
      // 가로: 숫자 1-8 (A3) 또는 1-6 (A4)
      // 세로: 영문 A-F (A3) 또는 A-D (A4)
      const hDivs = paperSize === 'A3' ? 8 : 6;
      const vDivs = paperSize === 'A3' ? 6 : 4;
      const tickLen = 4;

      // 상하 구분선 (숫자)
      for (let i = 0; i <= hDivs; i++) {
        const fx = innerX1 + (innerW * i / hDivs);
        // 상단 눈금 (윤곽선 ↔ 용지 상변 사이)
        const tTop = DrawingModel.createOutline(fx, 0, fx, innerY1, 0.5);
        tTop.confidence = CONF.CONFIRMED; tTop.locked = true;
        doc.elements.push(tTop);
        // 하단 눈금
        const tBot = DrawingModel.createOutline(fx, innerY2, fx, paperH, 0.5);
        tBot.confidence = CONF.CONFIRMED; tBot.locked = true;
        doc.elements.push(tBot);

        // 숫자 기호 (칸 중앙)
        if (i < hDivs) {
          const cx = innerX1 + (innerW * (i + 0.5) / hDivs);
          const numT = DrawingModel.createText(cx, innerY1 * 0.6, String(i + 1), 8);
          numT.color = '#000000'; numT.confidence = CONF.CONFIRMED; numT.locked = true;
          doc.elements.push(numT);
          const numB = DrawingModel.createText(cx, innerY2 + (paperH - innerY2) * 0.6, String(i + 1), 8);
          numB.color = '#000000'; numB.confidence = CONF.CONFIRMED; numB.locked = true;
          doc.elements.push(numB);
        }
      }

      // 좌우 구분선 (영문)
      for (let j = 0; j <= vDivs; j++) {
        const fy = innerY1 + (innerH * j / vDivs);
        // 좌측 눈금
        const tLeft = DrawingModel.createOutline(0, fy, innerX1, fy, 0.5);
        tLeft.confidence = CONF.CONFIRMED; tLeft.locked = true;
        doc.elements.push(tLeft);
        // 우측 눈금
        const tRight = DrawingModel.createOutline(innerX2, fy, paperW, fy, 0.5);
        tRight.confidence = CONF.CONFIRMED; tRight.locked = true;
        doc.elements.push(tRight);

        // 영문 기호 (칸 중앙)
        if (j < vDivs) {
          const cy = innerY1 + (innerH * (j + 0.5) / vDivs);
          const letter = String.fromCharCode(65 + j); // A, B, C, ...
          const ltL = DrawingModel.createText(innerX1 * 0.4, cy, letter, 8);
          ltL.color = '#000000'; ltL.confidence = CONF.CONFIRMED; ltL.locked = true;
          doc.elements.push(ltL);
          const ltR = DrawingModel.createText(innerX2 + (paperW - innerX2) * 0.5, cy, letter, 8);
          ltR.color = '#000000'; ltR.confidence = CONF.CONFIRMED; ltR.locked = true;
          doc.elements.push(ltR);
        }
      }
    }

    // ──── 1. 구간 좌표 계산 ────
    // ★ between 모드 스프라켓이 있으면, 해당 구간 사이에 틈(gap)을 삽입하여
    //   S2 ─ [스프라켓] ─ S3 형태로 시각적 분리를 보장한다.
    const sections = [];
    let curX = ox;

    const resolvedSections = geo.sections.map((s, i) => {
      if (s.diameter != null) {
        // v114: 테이퍼인 경우 _renderDiam은 큰 쪽 기준 (maxR 계산용)
        const d1 = s.diameter;
        const d2 = (s.profile === 'TAPER' && s.diameterEnd) ? s.diameterEnd : d1;
        return { ...s, _renderDiam: Math.max(d1, d2), _renderDiamStart: d1, _renderDiamEnd: d2 };
      }
      // 직경 미감지: 인접 참고 (렌더링 크기만, 숫자 "생성" 아님)
      const prev = i > 0 ? geo.sections[i - 1] : null;
      const next = i < geo.sections.length - 1 ? geo.sections[i + 1] : null;
      const ref = prev?.diameter || next?.diameter || 20;
      const fallback = ref * 0.6;
      return { ...s, _renderDiam: fallback, _renderDiamStart: fallback, _renderDiamEnd: fallback };
    });

    const maxR = Math.max(...resolvedSections.map(s => (s._renderDiam || 20) / 2));

    // ★ between 모드 스프라켓용 gap 사전 계산
    // sectionLeftId → 해당 구간 뒤에 삽입할 gap 폭 (px)
    const betweenGaps = {}; // { sectionLeftId: gapWidthPx }
    const chainGears_pre = spec.chainGears || [];
    chainGears_pre.forEach(cg => {
      if (cg.placement !== 'between') return;
      const gearWidthPx_pre = (cg.gearWidth || 8) * PX;
      // per-boss 두께 합산
      let totalBossThick_pre = 0;
      if (cg.boss) {
        const bCount = cg.boss.count || 1;
        for (let b = 0; b < bCount; b++) {
          const bData = (cg.boss.bosses && cg.boss.bosses[b]) || cg.boss;
          const t = (bData && bData.thickness > 0) ? bData.thickness * PX : 0;
          totalBossThick_pre += t;
        }
      }
      const assemblyWidth = gearWidthPx_pre + totalBossThick_pre;
      const leftId = cg.sectionLeft;
      // 같은 경계에 여러 스프라켓이 있으면 최대값 사용
      betweenGaps[leftId] = Math.max(betweenGaps[leftId] || 0, assemblyWidth);
    });

    // ★ 물결 생략선 (break line) 기준: 실제 길이 > 1000mm인 구간은
    //   시각적 폭을 10%로 축소하고 중앙에 물결 기호를 그린다.
    //   치수값은 원래 길이(mm)를 표시한다.
    const BREAK_THRESHOLD_MM = 1000; // 생략선 적용 기준 (mm)
    const BREAK_RATIO = 0.10;        // 시각적 축소 비율 (10%)

    resolvedSections.forEach(s => {
      const isBreak = s.length > BREAK_THRESHOLD_MM;
      const w = isBreak ? (s.length * BREAK_RATIO * PX) : (s.length * PX);
      const r = ((s._renderDiam || 20) / 2) * PX;
      // ★ v114: 테이퍼 구간용 좌/우 반지름
      const rLeft = ((s._renderDiamStart || s._renderDiam || 20) / 2) * PX;
      const rRight = ((s._renderDiamEnd || s._renderDiam || 20) / 2) * PX;
      const isTaper = s.profile === 'TAPER' && Math.abs(rLeft - rRight) > 0.01;
      sections.push({
        ...s,
        x: curX, w, r,
        rLeft, rRight, isTaper,          // v114: 테이퍼 지원
        px_diameter: (s._renderDiam || 20) * PX,
        _breakLine: isBreak,            // 물결 생략선 여부
        _breakScale: isBreak ? BREAK_RATIO : 1, // px↔mm 변환 스케일
      });
      curX += w;
      // ★ 이 구간 뒤에 between 스프라켓 gap이 있으면 삽입
      if (betweenGaps[s.id]) {
        curX += betweenGaps[s.id];
      }
    });

    const rightEnd = curX;

    // ──── 2. 중심선 (항상 confirmed — shaft 필수) ────
    const clMargin = 30;
    const cl = DrawingModel.createCenterline(
      ox - clMargin, oy, rightEnd + clMargin, oy
    );
    cl.confidence = CONF.CONFIRMED;
    doc.elements.push(cl);

    // ──── 3. 외형선 — 정투상도 정면도 ────
    //
    // 핵심 원리: 정면도에서 각 section은 직사각형으로 보인다.
    // 모든 section의 4변(상단선, 하단선, 좌측면, 우측면)을 모두 그린다.
    //
    // 예시 (S1 Ø20 — S2 Ø35 — S3 Ø20):
    //
    //              ┌─────────────────┐
    //  ┌───────────┤                 ├───────────┐
    //  │    S1     │       S2        │    S3     │
    //──┼───────────┤                 ├───────────┼──
    //  │           │                 │           │
    //  └───────────┤                 ├───────────┘
    //              └─────────────────┘
    //
    // S2가 S1, S3보다 크므로 S2의 4변이 모두 보인다.
    // S1의 좌면, S3의 우면도 보인다 (전체 부품의 양끝).
    // 경계(x=180, x=402)에서는 큰 section과 작은 section의 면이 겹치므로,
    // 큰 section의 면이 작은 section의 면을 포함한다.
    //
    // ★ v112: 수직선(좌면/우면) 중복 제거 — 경계를 한 번만 그리기
    //
    //   기존 문제: 각 section이 독립적으로 4면을 그려서 공유 경계에서
    //   인접 section의 수직선이 모따기 영역을 덮어씀.
    //
    //   해결: 공유 경계(S[i].x2 == S[i+1].x1)에서는 두 section의 모따기를
    //   모두 반영한 수직선을 한 번만 그린다.
    //   전체 Y 범위(union)에서 모따기 제외 구간(exclusion zones)을 빼서
    //   최종 수직선 segment를 결정.
    //
    //   예) S1(Ø30, chamferRight=3) → S2(Ø50, no chamfer):
    //     전체 범위: [oy-r2, oy+r2]
    //     제외 구간: [oy-r1, oy-r1+c], [oy+r1-c, oy+r1]
    //     결과: 3 segments — 상단 단차, 중간(축소), 하단 단차
    //
    // ★ v113: 모따기 렌더링 — 직경 비례 + 최소 C1 보장
    //
    //   핵심: 모따기를 해당 구간 반지름에 대한 "비율"로 렌더링.
    //     ratio = max(C_mm, 1) / (diameter_mm / 2)
    //     chamfer_px = ratio * rPx
    //
    //   예) C5 on Ø55 → ratio=5/27.5=18.2% → 큰 구간이면 큰 모따기
    //   예) C1 on Ø20 → ratio=1/10=10%     → 작은 구간이면 작은 모따기
    //
    //   최소 시각: 비율 결과가 2px 미만이면 2px (수비레장치)
    //   최대 제한: 반지름의 40% 초과 불가 (비율 보호)
    //   치수 라벨(C0.3 등)은 원래 mm값 그대로 표시.
    //
    const MIN_C_MM = 1;           // 최소 모따기 mm값 (C1)
    const MIN_VIS_PX = 2;         // 최소 시각 크기 (px)
    const MAX_RATIO = 0.40;       // 반지름 대비 최대 비율 (40%)
    function chamferPx(mmVal, rPx) {
      if (mmVal <= 0) return 0;
      const effectiveMm = Math.max(mmVal, MIN_C_MM);
      const rMm = PX > 0 ? (rPx / PX) : 1;
      // mm 공간에서 비율 계산 → px 공간에 적용
      const ratio = rMm > 0 ? (effectiveMm / rMm) : 0.1;
      const capped = Math.min(ratio, MAX_RATIO);  // 최대 비율 제한
      const result = capped * rPx;
      return Math.max(result, MIN_VIS_PX);         // 최소 px 보장
    }

    const verticalDrawn = {};

    function drawVerticalSegments(x, secsAtBoundary, conf) {
      // 1) 전체 Y 범위 (모든 section의 union)
      let minY = Infinity, maxY = -Infinity;
      secsAtBoundary.forEach(function(info) {
        minY = Math.min(minY, oy - info.r);
        maxY = Math.max(maxY, oy + info.r);
      });

      // 2) 제외 구간 수집 — 모따기가 있는 꼭짓점 영역
      var exclusions = [];
      secsAtBoundary.forEach(function(info) {
        if (info.chamfer > 0) {
          // 상단 꼭짓점: [oy-r, oy-r+c]
          exclusions.push({ top: oy - info.r, bot: oy - info.r + info.chamfer });
          // 하단 꼭짓점: [oy+r-c, oy+r]
          exclusions.push({ top: oy + info.r - info.chamfer, bot: oy + info.r });
        }
      });

      if (exclusions.length === 0) {
        // 모따기 없음 — 단일 수직선
        var full = DrawingModel.createOutline(x, minY, x, maxY, 1);
        full.confidence = conf;
        doc.elements.push(full);
        return;
      }

      // 3) 제외 구간 정렬 → 수직선 segment 생성
      exclusions.sort(function(a, b) { return a.top - b.top; });
      var cursor = minY;
      exclusions.forEach(function(ex) {
        if (ex.top > cursor + 0.01) {
          var seg = DrawingModel.createOutline(x, cursor, x, ex.top, 1);
          seg.confidence = conf;
          doc.elements.push(seg);
        }
        if (ex.bot > cursor) cursor = ex.bot;
      });
      if (cursor + 0.01 < maxY) {
        var seg = DrawingModel.createOutline(x, cursor, x, maxY, 1);
        seg.confidence = conf;
        doc.elements.push(seg);
      }
    }

    sections.forEach((sec, i) => {
      const x1 = sec.x;
      const x2 = sec.x + sec.w;
      const r = sec.r;
      // ★ v114: 테이퍼 구간용 좌/우 반지름
      const rL = sec.rLeft || r;   // 좌측 반지름 (px)
      const rR = sec.rRight || r;  // 우측 반지름 (px)
      const conf = (sec.diameter != null) ? (sec.diameterConf || CONF.CONFIRMED) : CONF.ESTIMATED;

      // ★ v112: 모따기(chamfer) — mm→px 변환 + 최소 시각 크기 보장
      const cL = chamferPx(sec.chamferLeft || 0, rL);
      const cR = chamferPx(sec.chamferRight || 0, rR);

      // 인접 구간 참조
      const prevSec = i > 0 ? sections[i - 1] : null;
      const nextSec = i < sections.length - 1 ? sections[i + 1] : null;

      // ── 상/하단 외형선 ──
      // ★ v114: 테이퍼 구간은 경사선, 원통 구간은 수평선
      if (sec._breakLine) {
        // 물결 생략선 (테이퍼에서는 드물지만 안전 처리)
        const brkGapW = 6;
        const brkCx = (x1 + x2) / 2;
        const brkL = brkCx - brkGapW / 2;
        const brkR = brkCx + brkGapW / 2;
        // 생략선에서는 수평으로 처리
        const topL = DrawingModel.createOutline(x1 + cL, oy - rL, brkL, oy - rL, 1);
        topL.confidence = conf; doc.elements.push(topL);
        const topR = DrawingModel.createOutline(brkR, oy - rR, x2 - cR, oy - rR, 1);
        topR.confidence = conf; doc.elements.push(topR);
        const botL = DrawingModel.createOutline(x1 + cL, oy + rL, brkL, oy + rL, 1);
        botL.confidence = conf; doc.elements.push(botL);
        const botR = DrawingModel.createOutline(brkR, oy + rR, x2 - cR, oy + rR, 1);
        botR.confidence = conf; doc.elements.push(botR);
        const brk = DrawingModel.createBreakLine(brkCx, oy - Math.max(rL, rR), oy + Math.max(rL, rR), brkGapW);
        doc.elements.push(brk);
      } else if (sec.isTaper) {
        // ★ v114: 테이퍼 구간 — 경사 외형선
        //   좌측 (x1, rL) → 우측 (x2, rR)
        //   모따기가 있으면 모따기 끝점에서 시작/끝
        const topLine = DrawingModel.createOutline(x1 + cL, oy - rL, x2 - cR, oy - rR, 1);
        topLine.confidence = conf;
        doc.elements.push(topLine);
        const botLine = DrawingModel.createOutline(x1 + cL, oy + rL, x2 - cR, oy + rR, 1);
        botLine.confidence = conf;
        doc.elements.push(botLine);
      } else {
        // 원통 구간 — 수평 외형선
        const topLine = DrawingModel.createOutline(x1 + cL, oy - r, x2 - cR, oy - r, 1);
        topLine.confidence = conf;
        doc.elements.push(topLine);
        const botLine = DrawingModel.createOutline(x1 + cL, oy + r, x2 - cR, oy + r, 1);
        botLine.confidence = conf;
        doc.elements.push(botLine);
      }

      // ── 좌측 수직선 (x1) ──
      // 공유 경계: prevSec가 있고 prevSec.x2 ≈ x1 이면, prevSec 루프에서 이미 처리됨
      const x1Key = Math.round(x1 * 100);
      if (!verticalDrawn[x1Key]) {
        verticalDrawn[x1Key] = true;
        // 이 경계에 접하는 section 정보 수집 (v114: 테이퍼는 해당 면의 반지름)
        const secsAtX1 = [];
        secsAtX1.push({ r: rL, chamfer: cL });
        if (prevSec && Math.abs((prevSec.x + prevSec.w) - x1) < 0.01) {
          const prevRR = prevSec.rRight || prevSec.r;  // 이전 구간의 우측 반지름
          const prevCR = chamferPx(prevSec.chamferRight || 0, prevRR);
          secsAtX1.push({ r: prevRR, chamfer: prevCR });
        }
        drawVerticalSegments(x1, secsAtX1, conf);
      }

      // ── 우측 수직선 (x2) ──
      const x2Key = Math.round(x2 * 100);
      if (!verticalDrawn[x2Key]) {
        verticalDrawn[x2Key] = true;
        const secsAtX2 = [];
        secsAtX2.push({ r: rR, chamfer: cR });
        if (nextSec && Math.abs(nextSec.x - x2) < 0.01) {
          const nextRL = nextSec.rLeft || nextSec.r;  // 다음 구간의 좌측 반지름
          const nextCL = chamferPx(nextSec.chamferLeft || 0, nextRL);
          secsAtX2.push({ r: nextRL, chamfer: nextCL });
        }
        drawVerticalSegments(x2, secsAtX2, conf);
      }

      // ── 모따기 대각선 — 45° 선 ──
      if (cL > 0) {
        const chamLT = DrawingModel.createOutline(x1 + cL, oy - rL, x1, oy - rL + cL, 1);
        chamLT.confidence = conf; doc.elements.push(chamLT);
        const chamLB = DrawingModel.createOutline(x1 + cL, oy + rL, x1, oy + rL - cL, 1);
        chamLB.confidence = conf; doc.elements.push(chamLB);
      }
      if (cR > 0) {
        const chamRT = DrawingModel.createOutline(x2 - cR, oy - rR, x2, oy - rR + cR, 1);
        chamRT.confidence = conf; doc.elements.push(chamRT);
        const chamRB = DrawingModel.createOutline(x2 - cR, oy + rR, x2, oy + rR - cR, 1);
        chamRB.confidence = conf; doc.elements.push(chamRB);
      }
    });

    // ──── 3.3a. 모따기 치수 주석 (C값 텍스트 + 지시선) ────
    // ★ v111: 모따기가 있는 구간에 "C{값}" 텍스트를 대각선 위에 표시
    sections.forEach((sec, i) => {
      const x1 = sec.x;
      const x2 = sec.x + sec.w;
      const rL = sec.rLeft || sec.r;  // v114: 좌측 반지름
      const rR = sec.rRight || sec.r; // v114: 우측 반지름
      const cLmm = sec.chamferLeft || 0;
      const cRmm = sec.chamferRight || 0;
      // ★ v112: 라벨 위치는 시각적 chamfer 크기(chamferPx)에 맞춤
      const cLpx = chamferPx(cLmm, rL);
      const cRpx = chamferPx(cRmm, rR);

      if (cLpx > 0) {
        // 좌측 모따기 치수: 대각선 중점 위에 텍스트
        const midX = x1 + cLpx / 2;
        const midY = oy - rL + cLpx / 2;
        const chamLabel = `C${cLmm}`;
        const ct = DrawingModel.createText(midX, midY - 3, chamLabel, 4);
        ct.confidence = CONF.CONFIRMED;
        ct.color = '#000000';
        ct._chamferLabel = true;
        doc.elements.push(ct);
      }
      if (cRpx > 0) {
        // 우측 모따기 치수: 대각선 중점 위에 텍스트
        const midX = x2 - cRpx / 2;
        const midY = oy - rR + cRpx / 2;
        const chamLabel = `C${cRmm}`;
        const ct = DrawingModel.createText(midX, midY - 3, chamLabel, 4);
        ct.confidence = CONF.CONFIRMED;
        ct.color = '#000000';
        ct._chamferLabel = true;
        doc.elements.push(ct);
      }
    });

    // ──── 3.4. 물결 생략선 구간용 PX 헬퍼 ────
    // 구간 내부의 mm→px 변환 시, 생략선 구간은 축소 비율 반영 필요
    // secPX(sec) = PX * sec._breakScale  (일반 구간은 1, 생략 구간은 0.10)
    function secPX(sec) { return PX * (sec._breakScale || 1); }

    // ──── 3.5. 키홈 좌표 전처리 (누진치수 준비) ────
    // 키홈 hidden feature의 좌표를 미리 계산하여
    // 치수선에서 누진치수(progressive dimensioning)를 적용할 수 있도록 한다.
    //
    // ★ 누진치수 규칙 (사용자 지정):
    //   키홈 offset이 입력된 구간은 기존 구간 길이 치수를 표시하지 않고,
    //   그 자리(구간 상단, 기존 길이 치수와 동일 위치)에 누진치수 체인으로 교체한다.
    //   → 동일한 값을 중복 표시하면 치수가 과밀해지므로,
    //     가장 중요한 정보인 누진치수만 기입하여 기존 전체 길이 치수를 대신한다.
    //
    //   구간 시작점(0) 기준 누적 거리로 표시
    //   예: S1=70mm, leftOff=5, kwWidth=11 → 5─16─70
    //       (5=좌측이격, 16=5+11=키홈 끝, 70=구간 전체)
    //
    const keywayPreprocessed = {};  // sectionId → { kx1, kx2, actualLeftOff, actualRightOff, actualKwWidth, hasOffset }
    (geo.hiddenFeatures || []).forEach(hf => {
      if (hf.type !== 'keyway') return;
      const sec = sections.find(s => s.id === hf.section);
      if (!sec) return;

      const sectionLenMm = sec.length;
      let kx1, kx2;
      let actualLeftOff = null, actualRightOff = null;
      let actualKwWidth = hf.keywayWidth;

      const hasLeftOff = hf.keywayLeftOffset != null && !isNaN(hf.keywayLeftOffset);
      const hasRightOff = hf.keywayRightOffset != null && !isNaN(hf.keywayRightOffset);
      const hasOffset = hasLeftOff || hasRightOff;

      // ★ 구간 내부 mm→px: 생략선 구간은 축소 비율 반영
      const sPX = secPX(sec);

      if (hasLeftOff && hasRightOff) {
        actualLeftOff = hf.keywayLeftOffset;
        actualRightOff = hf.keywayRightOffset;
        actualKwWidth = sectionLenMm - actualLeftOff - actualRightOff;
        if (actualKwWidth <= 0) actualKwWidth = hf.keywayWidth;
        kx1 = sec.x + actualLeftOff * sPX;
        kx2 = kx1 + actualKwWidth * sPX;
      } else if (hasLeftOff) {
        actualLeftOff = hf.keywayLeftOffset;
        kx1 = sec.x + actualLeftOff * sPX;
        kx2 = kx1 + hf.keywayWidth * sPX;
        actualKwWidth = hf.keywayWidth;
        actualRightOff = sectionLenMm - actualLeftOff - actualKwWidth;
        if (actualRightOff < 0) actualRightOff = null;
      } else if (hasRightOff) {
        actualRightOff = hf.keywayRightOffset;
        kx2 = sec.x + sec.w - actualRightOff * sPX;
        kx1 = kx2 - hf.keywayWidth * sPX;
        actualKwWidth = hf.keywayWidth;
        actualLeftOff = sectionLenMm - actualKwWidth - actualRightOff;
        if (actualLeftOff < 0) actualLeftOff = null;
      } else {
        const kwWidth = hf.keywayWidth * sPX;
        const secCenterX = sec.x + sec.w / 2;
        kx1 = secCenterX - kwWidth / 2;
        kx2 = secCenterX + kwWidth / 2;
        actualKwWidth = hf.keywayWidth;
      }

      keywayPreprocessed[hf.id] = {
        sectionId: hf.section,
        kx1, kx2,
        actualLeftOff, actualRightOff, actualKwWidth,
        hasOffset,
      };
    });

    // 키홈이 있는 section → 체인 치수(chain dimension) 데이터 빌드
    // { sectionId → { segments: [{ startPx, endPx, mm }], ... } }
    //
    // ★ 누진치수 규칙 (사용자 확정):
    //   키홈 offset이 있는 구간은 기존 구간 길이 치수를 표시하지 않고,
    //   개별 구간별 치수(chain dimension)로 교체한다.
    //   예: S1=50mm, leftOff=2, kwWidth=32 → 2, 32, 16
    //       (좌측이격=2, 키홈폭=32, 우측 나머지=16)
    //   각 치수선은 해당 구간의 시작~끝만 표시 (누적값 아님)
    //
    // ★ v118: 키홈 오프셋 체인 치수 제거 — KEY 지시선 텍스트로 대체
    // 기존: 좌측이격 + 키홈폭 + 우측나머지 체인 치수를 표시
    // 변경: 체인 치수 생성하지 않음 → 기존 구간 길이 치수 유지
    const progressiveDimSections = {};
    // (비활성화 — 키홈 오프셋 치수를 도면에 표시하지 않음)

    // ★ v39: 스냅링 체인 치수 제거 — 두께는 지시선 텍스트에서 직경과 함께 표시
    // (스냅링 두께를 별도 치수선으로 표시하지 않음)

    // ──── 4. 치수선 ────
    // 4-a) 구간별 길이
    //
    // ★ 핵심 규칙: 모든 구간 길이 치수선은 동일한 Y 수평선 위에 정렬
    //
    //   렌더러 동작: renderer는 (el.y1 - el.offset) 위치에 치수선을 그린다.
    //   따라서 모든 치수의 (y1 - offset) 값이 동일해야 치수선이 같은 Y에 정렬됨.
    //
    //   구현 방식:
    //   - dimLineY = oy - maxR*PX - dimGap  (모든 치수선의 최종 렌더링 Y — 고정값)
    //   - 각 구간의 y1 = oy - sec.r        (해당 구간의 실제 상단 — 연장선 시작점)
    //   - offset = y1 - dimLineY            (구간마다 다른 offset → 같은 dimLineY)
    //
    //   결과: 연장선은 각 구간의 실제 외형선에서 시작하고,
    //         치수선은 모두 동일한 수평선(dimLineY)에 정렬됨.
    //
    //   예시 (S1 Ø20, S2 Ø35, S3 Ø20):
    //     dimLineY ─────|←2→|←32→|←16→|───|←──111──→|───|←16→|←40→|←3→|──
    //                   ╎    ╎    ╎         ╎         ╎    ╎    ╎    ╎
    //     S1 top ───────╎────╎────╎         ╎         ╎────╎────╎────╎── S3 top
    //                            S2 top ────╎─────────╎── S2 top
    //
    const dimGap = 28; // 가장 큰 구간 상단에서 치수선까지의 최소 간격
    const dimLineY = oy - maxR * PX - dimGap; // 모든 구간 치수선의 공통 렌더 Y

    sections.forEach((sec) => {
      const secTopY = oy - sec.r;              // 이 구간의 실제 상단 Y (연장선 시작점)
      const secOffset = secTopY - dimLineY;    // 이 구간의 offset (= secTopY - dimLineY)
      const progData = progressiveDimSections[sec.id];

      if (progData) {
        // ── 체인 치수 (기존 구간 길이 치수 대체) ──
        // 모든 체인 치수를 동일한 치수선 Y 위치에 배치
        // 예: S1=50mm, leftOff=2, kwWidth=32 → 2, 32, 16
        //   |←2→|←──────32──────→|←──16──→|  ← 같은 수평선
        //
        // ★ v40: 좁은 치수 엘보 지시선 레벨 할당
        //   renderer가 isNarrow 판단 시 사용하는 기준:
        //     dimSpan < textWidth + 20   (textWidth = label.length * fontSize * 0.65)
        //   여기서 동일 기준으로 미리 narrow 여부를 판단하고,
        //   인접 narrow 치수에 순차적 레벨(0,1,2...)을 할당하여
        //   엘보 높이를 점진적으로 다르게 한다.
        const DIM_FONT_SIZE = 6;  // createDimension 기본 fontSize
        let narrowLevel = 0;
        progData.segments.forEach((seg) => {
          const dim = DrawingModel.createDimension(
            seg.startPx, secTopY, seg.endPx, secTopY,
            applyScale(seg.mm), ann.unit, secOffset
          );
          dim.confidence = CONF.CONFIRMED;
          dim._progressiveDim = true;

          // narrow 판단 (renderer와 동일 로직)
          const segSpan = Math.abs(seg.endPx - seg.startPx);
          const labelStr = String(dim.value || '');
          const labelW = labelStr.length * DIM_FONT_SIZE * 0.65;
          const segIsNarrow = segSpan < labelW + 20;
          if (segIsNarrow) {
            dim._narrowLeaderLevel = narrowLevel++;
          }

          doc.elements.push(dim);
        });
      } else {
        // ── 기존 방식: 단일 구간 길이 치수 (동일 Y 정렬) ──
        const dim = DrawingModel.createDimension(
          sec.x, secTopY, sec.x + sec.w, secTopY,
          applyScale(sec.length), ann.unit, secOffset
        );
        dim.confidence = sec.lengthConf || CONF.CONFIRMED;
        doc.elements.push(dim);
      }
    });

    // 4-b) 전체 길이 — dimLineY 위로 추가 간격(25px)에 배치
    if (geo.totalLength != null) {
      const maxSecTopY = oy - maxR * PX;           // 가장 큰 구간의 상단
      const tlOffset = maxSecTopY - dimLineY + 25;  // 구간 치수선 위 25px
      const tlDim = DrawingModel.createDimension(
        ox, maxSecTopY, rightEnd, maxSecTopY,
        applyScale(geo.totalLength), ann.unit, tlOffset
      );
      tlDim.confidence = geo.totalLengthConf || CONF.CONFIRMED;
      doc.elements.push(tlDim);
    }

    // 4-c) 직경 치수 — 모든 구간에 표시 (같은 직경이라도 생략하지 않음)
    //   S1과 S3이 동일 직경(예: ⌀20)이어도 각각 표시해야 함
    //   중실축/중공축 관계없이 직경 치수를 구간 수평 중간에 표시
    //
    //   인접 구간이 동일 직경인 경우에만 중복 생략 (예: S1=⌀20, S2=⌀20 → S1만 표시)
    //   비인접 구간은 동일 직경이라도 각각 표시 (예: S1=⌀20, S3=⌀20 → 둘 다 표시)
    sections.forEach((sec, i) => {
      const diam = sec.diameter;
      const midX = sec.x + sec.w / 2;  // 구간 수평 중간점
      if (diam == null) {
        // 미감지 직경: placeholder '?' 치수
        const qDim = DrawingModel.createDiameterDimension(
          midX, oy - sec.r, midX, oy + sec.r,
          '?', ann.unit, 0
        );
        qDim.confidence = CONF.UNCERTAIN;
        qDim._isPlaceholder = true;
        doc.elements.push(qDim);
        return;
      }

      // ★ v114→v115: 테이퍼 구간 — 양쪽 직경을 치수보조선으로 구간 바깥에 표시
      //
      //   문제: 테이퍼 내부에 치수를 배치하면 인접 구간 치수와 겹침
      //   해결: createDimension (치수보조선 자동 생성) + 적절한 offset으로
      //         좌측 직경은 왼쪽으로, 우측 직경은 오른쪽으로 배치
      //
      //   렌더러 동작: 수직 치수에서 offset > 0 → 치수선이 왼쪽으로 이동
      //               offset < 0 → 치수선이 오른쪽으로 이동
      //               치수보조선: 외형점 → 치수선 위치까지 파선으로 자동 연결
      //
      if (sec.isTaper && sec.diameterEnd != null) {
        const rL = sec.rLeft || sec.r;
        const rR = sec.rRight || sec.r;
        const x1t = sec.x;
        const x2t = sec.x + sec.w;
        const taperDimOffset = 25;  // 구간 경계에서 치수선까지 거리 (px)

        // ── 좌측 직경 (x1 경계, 왼쪽으로 오프셋) ──
        const dDimL = DrawingModel.createDimension(
          x1t, oy - rL, x1t, oy + rL,
          `⌀${applyScale(diam)}`, ann.unit, taperDimOffset
        );
        dDimL.dimStyle = 'taperDiameter';  // 커스텀 스타일 태그
        dDimL.confidence = sec.diameterConf || CONF.CONFIRMED;
        doc.elements.push(dDimL);

        // ── 우측 직경 (x2 경계, 오른쪽으로 오프셋) ──
        const dDimR = DrawingModel.createDimension(
          x2t, oy - rR, x2t, oy + rR,
          `⌀${applyScale(sec.diameterEnd)}`, ann.unit, -taperDimOffset
        );
        dDimR.dimStyle = 'taperDiameter';
        dDimR.confidence = sec.diameterConf || CONF.CONFIRMED;
        doc.elements.push(dDimR);
        return;
      }

      // 원통 구간: 인접 이전 구간과 동일 직경이면 중복 생략 (연속된 같은 직경만)
      if (i > 0 && sections[i - 1].diameter === diam && !sections[i - 1].isTaper) return;
      const dDim = DrawingModel.createDiameterDimension(
        midX, oy - sec.r, midX, oy + sec.r,
        applyScale(diam), ann.unit, 0
      );
      dDim.confidence = sec.diameterConf || CONF.CONFIRMED;
      doc.elements.push(dDim);
    });

    // ──── 5. 숨은선(hidden line) — 원본 도면의 점선을 그대로 복제 ────
    //
    // v5.8 핵심 규칙:
    //   숨은선은 정확히 4개 블록 (사용자 지정):
    //     블록1: S1 M10 TAP (상/하 수평 파선 + 끝면 수직 파선)
    //     블록2: S1 키홈 (바닥면 수평 파선 + 양쪽 수직 파선)
    //     블록3: S3 M10 TAP (상/하 수평 파선 + 끝면 수직 파선)
    //     블록4: S3 키홈 (바닥면 수평 파선 + 양쪽 수직 파선)
    //
    //   type 정의:
    //     'tap-bore'  — 탭구멍: 나사 직사각형 + 드릴 직사각형 + 드릴 끝단 삼각형 (숨은선)
    //     'keyway'    — 키홈 → 바닥면 수평 파선 1개 + 양 끝 수직 파선 2개
    //                   바닥면 Y = centerline - (r - keywayDepth) = centerline - (10 - 3.5) = centerline - 6.5mm
    //                   키홈 가로 길이 = keywayWidth mm
    //
    const hiddenFeatures = geo.hiddenFeatures || [];
    console.log('[AI-Engine] hiddenFeatures count:', hiddenFeatures.length);
    console.log('[AI-Engine] hiddenFeatures:', JSON.stringify(hiddenFeatures.map(h => ({ id: h.id, type: h.type, section: h.section, srDiam: h.snapRingDiam, srThick: h.snapRingThickness }))));
    console.log('[AI-Engine] sections:', JSON.stringify(sections.map(s => ({ id: s.id, x: s.x?.toFixed(1), w: s.w?.toFixed(1), diam: s.diameter }))));
    hiddenFeatures.forEach(hf => {
      const sec = sections.find(s => s.id === hf.section);
      if (!sec) { console.warn('[AI-Engine] hiddenFeature section NOT FOUND:', hf.id, hf.section); return; }
      console.log(`[AI-Engine] Processing HF: ${hf.id}, type=${hf.type}, section=${hf.section}, found sec id=${sec.id}`);

      if (hf.type === 'tap-bore') {
        // ── 나사 피치 테이블 (KS B ISO 규격 보통 나사) ──
        const THREAD_PITCH = { 6: 1.0, 8: 1.25, 10: 1.5, 12: 1.75, 16: 2.0 };
        const tapDiam = hf.diameter;                        // 나사 호칭 직경 (mm)
        const pitch = THREAD_PITCH[tapDiam] || 1.5;        // 기본값 1.5mm
        const drillDiam = tapDiam - pitch;                  // 드릴 직경 (mm)
        const drillDepthMM = hf.depth + 2;                 // 드릴 깊이 = 탭깊이 + 2mm (여유)
        const drillTriH = 1;                                // 드릴 끝단 삼각형 높이 (mm)

        // ── 1) TAP 직사각형: 나사 직경 × 나사 깊이 (숨은선) ──
        const r = tapDiam / 2 * PX;
        const depth = hf.depth * PX;

        let hx1, hx2;
        if (hf.side === 'left') {
          hx1 = sec.x;
          hx2 = sec.x + depth;
        } else {
          hx1 = sec.x + sec.w - depth;
          hx2 = sec.x + sec.w;
        }

        // 탭 상부 수평
        const topH = DrawingModel.createHiddenLine(hx1, oy - r, hx2, oy - r, 1);
        topH.confidence = hf.confidence;
        doc.elements.push(topH);

        // 탭 하부 수평
        const botH = DrawingModel.createHiddenLine(hx1, oy + r, hx2, oy + r, 1);
        botH.confidence = hf.confidence;
        doc.elements.push(botH);

        // 탭 끝면 수직
        const endX = (hf.side === 'left') ? hx2 : hx1;
        const endV = DrawingModel.createHiddenLine(endX, oy - r, endX, oy + r, 1);
        endV.confidence = hf.confidence;
        doc.elements.push(endV);

        // ── 2) 드릴 구멍 직사각형: (직경-피치) × (깊이+2mm) (숨은선) ──
        const drillR = drillDiam / 2 * PX;                 // 드릴 반지름 (px)
        const drillDepthPx = drillDepthMM * PX;            // 드릴 깊이 (px)

        let dx1, dx2;
        if (hf.side === 'left') {
          dx1 = sec.x;
          dx2 = sec.x + drillDepthPx;
        } else {
          dx1 = sec.x + sec.w - drillDepthPx;
          dx2 = sec.x + sec.w;
        }

        // 드릴 상부 수평
        const drillTopH = DrawingModel.createHiddenLine(dx1, oy - drillR, dx2, oy - drillR, 1);
        drillTopH.confidence = hf.confidence;
        doc.elements.push(drillTopH);

        // 드릴 하부 수평
        const drillBotH = DrawingModel.createHiddenLine(dx1, oy + drillR, dx2, oy + drillR, 1);
        drillBotH.confidence = hf.confidence;
        doc.elements.push(drillBotH);

        // 드릴 끝면 수직 (탭보다 안쪽)
        const drillEndX = (hf.side === 'left') ? dx2 : dx1;
        const drillEndV = DrawingModel.createHiddenLine(drillEndX, oy - drillR, drillEndX, oy + drillR, 1);
        drillEndV.confidence = hf.confidence;
        doc.elements.push(drillEndV);

        // ── 3) 드릴 끝단 삼각형 (이등변삼각형, 밑변=드릴직경, 높이=1mm) ──
        //   삼각형은 드릴구멍 끝면을 밑변으로 하고, 높이 방향은 구멍 안쪽(deeper)
        //   left side → 삼각형 꼭짓점이 오른쪽 (+x)
        //   right side → 삼각형 꼭짓점이 왼쪽 (-x)
        const triH = drillTriH * PX;  // 삼각형 높이 (px)
        let triBaseX, triTipX;
        if (hf.side === 'left') {
          triBaseX = dx2;              // 밑변: 드릴 끝면
          triTipX = dx2 + triH;       // 꼭짓점: 안쪽으로
        } else {
          triBaseX = dx1;              // 밑변: 드릴 끝면
          triTipX = dx1 - triH;       // 꼭짓점: 안쪽으로
        }

        // 삼각형 상변 (밑변 상단 → 꼭짓점)
        const triTop = DrawingModel.createHiddenLine(triBaseX, oy - drillR, triTipX, oy, 1);
        triTop.confidence = hf.confidence;
        doc.elements.push(triTop);

        // 삼각형 하변 (밑변 하단 → 꼭짓점)
        const triBot = DrawingModel.createHiddenLine(triBaseX, oy + drillR, triTipX, oy, 1);
        triBot.confidence = hf.confidence;
        doc.elements.push(triBot);

        // ── 카운터보어 (C/B) — TAP 위에 넓은 단 ──
        if (hf.counterBore) {
          const cbR = hf.counterBore.diameter / 2 * PX;   // C/B 반지름 (px)
          const cbDepthPx = hf.counterBore.depth * PX;     // C/B 깊이 (px)

          let cbx1, cbx2;
          if (hf.side === 'left') {
            cbx1 = sec.x;
            cbx2 = sec.x + cbDepthPx;
          } else {
            cbx1 = sec.x + sec.w - cbDepthPx;
            cbx2 = sec.x + sec.w;
          }

          // C/B 상부 수평 숨은선
          const cbTopH = DrawingModel.createHiddenLine(cbx1, oy - cbR, cbx2, oy - cbR, 1);
          cbTopH.confidence = CONF.CONFIRMED;
          doc.elements.push(cbTopH);

          // C/B 하부 수평 숨은선
          const cbBotH = DrawingModel.createHiddenLine(cbx1, oy + cbR, cbx2, oy + cbR, 1);
          cbBotH.confidence = CONF.CONFIRMED;
          doc.elements.push(cbBotH);

          // C/B 끝면 수직 숨은선 (안쪽)
          const cbEndX = (hf.side === 'left') ? cbx2 : cbx1;
          const cbEndV = DrawingModel.createHiddenLine(cbEndX, oy - cbR, cbEndX, oy + cbR, 1);
          cbEndV.confidence = CONF.CONFIRMED;
          doc.elements.push(cbEndV);
        }

      } else if (hf.type === 'keyway') {
        // ── 키홈 렌더링 ──
        // v116: keywayDirection에 따라 측면(side) / 정면(front) 렌더링 분기
        const kwDirection = hf.keywayDirection || 'side';
        const preData = keywayPreprocessed[hf.id];
        let kx1, kx2;
        if (preData) {
          kx1 = preData.kx1;
          kx2 = preData.kx2;
        } else {
          const kwWidth = hf.keywayWidth * PX;
          const secCenterX = sec.x + sec.w / 2;
          kx1 = secCenterX - kwWidth / 2;
          kx2 = secCenterX + kwWidth / 2;
        }

        if (kwDirection === 'front') {
          // ── v116: 정면(front) — 키홈 단면도를 구간 중심에 직접 그림 ──
          // 보조투상도와 동일한 규칙이지만 메인 도면 위에 배치
          // 구간의 수평 중심 & 중심선(oy)에 키홈 중심 일치
          const kwCx = (kx1 + kx2) / 2;   // 키홈 수평 중심
          const kwCy = oy;                 // 구간 중심선 = 키홈 중심선
          const sw = kx2 - kx1;            // 키홈 폭 (px)
          const sh = (hf.keywayHeight || 6) * PX;  // 키홈 높이 (px)
          const kwShape = hf.keywayShape || 'obround';  // v117: 키 형상

          // ★ v119: 한쪽 둥근형 방향 결정 — 좌측 오프셋=0이면 오른쪽 둥글게, 우측 오프셋=0이면 왼쪽 둥글게
          let roundSide = 'right'; // 기본값
          if (kwShape === 'one-side-round') {
            const loVal = parseFloat(hf.keywayLeftOffset);
            const roVal = parseFloat(hf.keywayRightOffset);
            const hasLeftOff = !isNaN(loVal);
            const hasRightOff = !isNaN(roVal);
            if (hasRightOff && roVal === 0) roundSide = 'left';
            else if (hasLeftOff && loVal === 0) roundSide = 'right';
          }

          // 키홈 외형 (실선, 검정) — v117: 형상에 따라 obround/one-side-round/rect
          const slot = DrawingModel.createSlot(kwCx - sw / 2, kwCy - sh / 2, sw, sh);
          slot.confidence = hf.confidence;
          slot.color = '#000000';
          slot.slotShape = kwShape;  // v117: renderer에서 형상 분기
          slot.slotRoundSide = roundSide;  // v118: 한쪽 둥근형 방향
          slot._frontKeyway = true;
          doc.elements.push(slot);

          // 수평 중심선 (키홈 중심선 = 구간 중심선과 일치)
          const clH = DrawingModel.createCenterline(
            kwCx - sw / 2 - 8, kwCy, kwCx + sw / 2 + 8, kwCy
          );
          clH.confidence = hf.confidence;
          clH._frontKeyway = true;
          doc.elements.push(clH);

          // 수직 중심선
          const clV = DrawingModel.createCenterline(
            kwCx, kwCy - sh / 2 - 8, kwCx, kwCy + sh / 2 + 8
          );
          clV.confidence = hf.confidence;
          clV._frontKeyway = true;
          doc.elements.push(clV);

        } else {
          // ── 측면(side) — 기존 동작: 바닥면 수평 1개 + 양 끝 수직 2개 ──
          const keywayDepthPx = hf.keywayDepth * PX;
          const yFloor = oy - sec.r + keywayDepthPx;

          // 바닥면 수평 파선
          const floor = DrawingModel.createHiddenLine(kx1, yFloor, kx2, yFloor, 1);
          floor.confidence = hf.confidence;
          doc.elements.push(floor);

          // 좌측 수직 파선 (축 상단 → 바닥면)
          const leftV = DrawingModel.createHiddenLine(kx1, oy - sec.r, kx1, yFloor, 1);
          leftV.confidence = hf.confidence;
          doc.elements.push(leftV);

          // 우측 수직 파선 (축 상단 → 바닥면)
          const rightV = DrawingModel.createHiddenLine(kx2, oy - sec.r, kx2, yFloor, 1);
          rightV.confidence = hf.confidence;
          doc.elements.push(rightV);
        }

        // 보조투상도 연동용 좌표 저장
        hf._resolvedKx1 = kx1;
        hf._resolvedKx2 = kx2;

        // ── v118: KEY 지시선 주석 (모든 키홈 공통) ──
        // 형식: KEY {W}Bx{H}Hx{D}DPx{L}L (두번째 사진 참고)
        // W=폭, H=높이, D=깊이, L=키홈 실제 길이
        {
          const actualKwWidthMm = preData ? preData.actualKwWidth : hf.keywayWidth;
          const kwHMm = hf.keywayHeight || 6;
          const kwDMm = hf.keywayDepth || 3.5;
          const kwLMm = actualKwWidthMm;  // 키홈 길이 = 키홈 폭
          const keyLabel = `KEY ${applyScale(actualKwWidthMm)}Bx${applyScale(kwHMm)}Hx${applyScale(kwDMm)}DPx${applyScale(kwLMm)}L`;
          const kwMidX = (kx1 + kx2) / 2;
          const botY = oy + sec.r;

          // 지시선 꺾임점: 키홈 중심 아래쪽 + 우측
          const elbowX = kwMidX + 25;
          const elbowY = botY + 16;
          const kwGroupId = `grp_key_${hf.id}`;

          // 지시선 1: 꺾임점 → 키홈 중심(화살표 방향)
          const keyLeader1 = DrawingModel.createOutline(elbowX, elbowY, kwMidX, botY, 0.8);
          keyLeader1.confidence = CONF.CONFIRMED;
          keyLeader1.color = '#60a5fa';
          keyLeader1._leaderLine = true;
          keyLeader1._leaderArrow = true;
          keyLeader1._groupId = kwGroupId;
          doc.elements.push(keyLeader1);

          // 지시선 2: 꺾임점 → 수평선 (텍스트 밑줄)
          const keyTextW = keyLabel.length * 3.25;
          const keyLeader2 = DrawingModel.createOutline(elbowX, elbowY, elbowX + keyTextW + 3, elbowY, 0.8);
          keyLeader2.confidence = CONF.CONFIRMED;
          keyLeader2.color = '#60a5fa';
          keyLeader2._leaderLine = true;
          keyLeader2._groupId = kwGroupId;
          doc.elements.push(keyLeader2);

          // 텍스트: 수평선 위
          const keyText = DrawingModel.createText(elbowX + 2, elbowY - 2, keyLabel, 5);
          keyText.confidence = CONF.CONFIRMED;
          keyText._groupId = kwGroupId;
          doc.elements.push(keyText);
        }

      } else if (hf.type === 'snapring') {
        // ── 스냅링 홈: 구간 외경에서 안쪽으로 홈을 파는 굵은 실선 ──
        // 홈 깊이 = (구간 외경 − 스냅링 외경) / 2
        // 위치: 좌측/우측 offset 기반
        const srDiam = hf.snapRingDiam;
        const srThick = hf.snapRingThickness;
        const srLeftOff = hf.snapRingLeftOffset;
        const srRightOff = hf.snapRingRightOffset;
        const secDiam = sec.diameter || (sec.r * 2 / PX);
        console.log(`[AI-Engine] SNAPRING ${hf.id}: srDiam=${srDiam}, srThick=${srThick}, secDiam=${secDiam}, leftOff=${srLeftOff}, rightOff=${srRightOff}`);

        const grooveDepth = (secDiam - srDiam) / 2;  // mm
        console.log(`[AI-Engine] SNAPRING ${hf.id}: grooveDepth=${grooveDepth}, will render=${grooveDepth > 0 && srThick > 0}`);
        if (grooveDepth <= 0 || srThick <= 0) return; // forEach 내부이므로 return

        const grooveDepthPx = grooveDepth * PX;
        const srThickPx = srThick * PX;

        // 홈 X 좌표 계산 (좌측 offset 우선, 없으면 우측 offset)
        const sPX_sr = secPX(sec);
        let grooveX1;
        if (srLeftOff != null && !isNaN(srLeftOff)) {
          grooveX1 = sec.x + srLeftOff * sPX_sr;
        } else if (srRightOff != null && !isNaN(srRightOff)) {
          grooveX1 = sec.x + sec.w - srRightOff * sPX_sr - srThickPx;
        } else {
          grooveX1 = sec.x + sec.w / 2 - srThickPx / 2; // 중심 폴백
        }
        const grooveX2 = grooveX1 + srThickPx;

        // ★ v39: 스냅링 홈 + 실선 2줄 + 지시선(직경+두께)
        const SR_STROKE = 1;  // v39: 홈 두께 1로 통일

        // 상단 홈 (축 상면에서 안쪽으로) — U자 형태
        const topY = oy - sec.r;
        const topGrooveBottom = topY + grooveDepthPx;
        const tL = DrawingModel.createOutline(grooveX1, topY, grooveX1, topGrooveBottom, SR_STROKE);
        tL.confidence = hf.confidence; doc.elements.push(tL);
        const tB = DrawingModel.createOutline(grooveX1, topGrooveBottom, grooveX2, topGrooveBottom, SR_STROKE);
        tB.confidence = hf.confidence; doc.elements.push(tB);
        const tR = DrawingModel.createOutline(grooveX2, topGrooveBottom, grooveX2, topY, SR_STROKE);
        tR.confidence = hf.confidence; doc.elements.push(tR);

        // 하단 홈 (축 하면에서 안쪽으로 — 대칭) — ∩자 형태
        const botY = oy + sec.r;
        const botGrooveTop = botY - grooveDepthPx;
        const bL = DrawingModel.createOutline(grooveX1, botY, grooveX1, botGrooveTop, SR_STROKE);
        bL.confidence = hf.confidence; doc.elements.push(bL);
        const bB = DrawingModel.createOutline(grooveX1, botGrooveTop, grooveX2, botGrooveTop, SR_STROKE);
        bB.confidence = hf.confidence; doc.elements.push(bB);
        const bR = DrawingModel.createOutline(grooveX2, botGrooveTop, grooveX2, botY, SR_STROKE);
        bR.confidence = hf.confidence; doc.elements.push(bR);

        // ★ v39: 홈에서 홈까지 두께 1 실선 2줄 (좌측 수직선, 우측 수직선)
        //   상단 홈 바닥 → 하단 홈 바닥을 연결하는 수직 실선 2개
        const srLineL = DrawingModel.createOutline(grooveX1, topGrooveBottom, grooveX1, botGrooveTop, 1);
        srLineL.confidence = hf.confidence; doc.elements.push(srLineL);
        const srLineR = DrawingModel.createOutline(grooveX2, topGrooveBottom, grooveX2, botGrooveTop, 1);
        srLineR.confidence = hf.confidence; doc.elements.push(srLineR);

        // ★ v39: 지시선 텍스트에 직경 + 두께 함께 표시
        const grooveMidX = (grooveX1 + grooveX2) / 2;
        const arrowX = grooveMidX;
        const arrowY = botGrooveTop;
        const srElbowX = grooveMidX + 20;
        const srElbowY = botY + 18;
        // ★ v110: 스냅링 그룹 선택용 _groupId
        const srGroupId = `grp_snap_${hf.id}`;
        // 지시선 1: 꺾임점 → 화살표(홈)
        const srLeader1 = DrawingModel.createOutline(srElbowX, srElbowY, arrowX, arrowY, 0.8);
        srLeader1.confidence = CONF.CONFIRMED;
        srLeader1.color = '#60a5fa';
        srLeader1._leaderLine = true;
        srLeader1._leaderArrow = true;
        srLeader1._groupId = srGroupId;  // v110
        doc.elements.push(srLeader1);
        // 지시선 2: 꺾임점 → 수평선 (텍스트 밑줄)
        const srLabel = `스냅링 : ${srDiam}Ø × ${srThick}t`;
        const srTextW = srLabel.length * 3.25;
        const srLeader2 = DrawingModel.createOutline(srElbowX, srElbowY, srElbowX + srTextW + 3, srElbowY, 0.8);
        srLeader2.confidence = CONF.CONFIRMED;
        srLeader2.color = '#60a5fa';
        srLeader2._leaderLine = true;
        srLeader2._groupId = srGroupId;  // v110
        doc.elements.push(srLeader2);
        // 텍스트: 수평선 위
        const srText = DrawingModel.createText(srElbowX + 2, srElbowY - 2, srLabel, 5);
        srText.confidence = CONF.CONFIRMED;
        srText._groupId = srGroupId;  // v110
        doc.elements.push(srText);

      } else if (hf.type === 'through-hole') {
        // ── 관통 구멍: 수직 숨은선 2개 (중심 대칭) — 축을 관통 ──
        // 정면도에서: 구멍 직경만큼 떨어진 수직 파선 2개
        const thR = hf.diameter / 2 * PX;  // 구멍 반지름 (px)

        // X 위치: 좌측 이격이 있으면 사용, 없으면 구간 중심
        let thCenterX;
        if (hf.offsetFromLeft != null && !isNaN(hf.offsetFromLeft)) {
          thCenterX = sec.x + hf.offsetFromLeft * secPX(sec);
        } else {
          thCenterX = sec.x + sec.w / 2;
        }

        const thX1 = thCenterX - thR;  // 좌측 수직선
        const thX2 = thCenterX + thR;  // 우측 수직선
        const thYtop = oy - sec.r;     // 구간 상면
        const thYbot = oy + sec.r;     // 구간 하면

        // 좌측 수직 숨은선 (관통 전체)
        const thLeft = DrawingModel.createHiddenLine(thX1, thYtop, thX1, thYbot, 1);
        thLeft.confidence = hf.confidence;
        doc.elements.push(thLeft);

        // 우측 수직 숨은선 (관통 전체)
        const thRight = DrawingModel.createHiddenLine(thX2, thYtop, thX2, thYbot, 1);
        thRight.confidence = hf.confidence;
        doc.elements.push(thRight);

        // 지시선 + 치수 텍스트
        const thArrowX = thCenterX;
        const thArrowY = thYtop;
        const thElbowX = thCenterX + 20;
        const thElbowY = thYtop - 18;
        // ★ v110: 관통 구멍 그룹 선택용 _groupId
        const thGroupId = `grp_thru_${hf.id}`;
        // 지시선 1: 꺾임점 → 화살표
        const thLeader1 = DrawingModel.createOutline(thElbowX, thElbowY, thArrowX, thArrowY, 0.8);
        thLeader1.confidence = CONF.CONFIRMED;
        thLeader1.color = '#60a5fa';
        thLeader1._leaderLine = true;
        thLeader1._leaderArrow = true;
        thLeader1._groupId = thGroupId;  // v110
        doc.elements.push(thLeader1);
        // 지시선 2: 수평선
        const thLabel = `Ø${hf.diameter} DR 관통`;
        const thTextW = thLabel.length * 3.25;
        const thLeader2 = DrawingModel.createOutline(thElbowX, thElbowY, thElbowX + thTextW + 3, thElbowY, 0.8);
        thLeader2.confidence = CONF.CONFIRMED;
        thLeader2.color = '#60a5fa';
        thLeader2._leaderLine = true;
        thLeader2._groupId = thGroupId;  // v110
        doc.elements.push(thLeader2);
        // 텍스트
        const thText = DrawingModel.createText(thElbowX + 2, thElbowY - 2, thLabel, 5);
        thText.confidence = CONF.CONFIRMED;
        thText._groupId = thGroupId;  // v110
        doc.elements.push(thText);
      }
      // 미지의 type은 무시
    });

    // 모든 숨은선은 hiddenFeatures에 명시적으로 정의해야 함

    // ──── 6. 슬롯 (메인 도면에 직접 표시되는 경우) ────
    // v5.5: 대부분의 슬롯/키홈 형상은 보조 투상도로 이동
    // 메인 도면에 남은 슬롯만 표시 (있는 경우)
    geo.slots.forEach(sl => {
      const sec = sections.find(s => s.id === sl.cx_section);
      if (!sec) return;
      const slX = sec.x + sl.cx_offset * secPX(sec);
      const slW = sl.slotLength * PX;
      const slH = sl.slotWidth * PX;

      const topSlot = DrawingModel.createSlot(slX, oy - sec.r - slH / 2, slW, slH);
      topSlot.confidence = sl.confidence;
      doc.elements.push(topSlot);

      if (sl.symmetry) {
        const botSlot = DrawingModel.createSlot(slX, oy + sec.r - slH / 2, slW, slH);
        botSlot.confidence = sl.confidence;
        doc.elements.push(botSlot);
      }
    });

    // ──── 7. 센터구멍 위치 (직경은 placeholder) ────
    geo.centerHolePositions.forEach(ch => {
      const cx = ch.side === 'left' ? ox : rightEnd;
      // 직경은 annotation에서 참조 — null이면 placeholder 크기(3)
      const annDiam = ann.centerHoleDiameters.find(d => d.side === ch.side);
      const renderDiam = annDiam?.diameter || 3;
      const hole = DrawingModel.createHole(cx, oy, renderDiam, null, 'center', null);
      hole.confidence = ch.confidence || CONF.UNCERTAIN;
      hole._isPlaceholder = (annDiam?.diameter == null);
      doc.elements.push(hole);
    });

    // ──── 8. 해칭 ────
    for (let i = 1; i < sections.length; i++) {
      const cur = sections[i];
      const prev = sections[i - 1];
      if (Math.abs(cur.r - prev.r) < 0.1) continue;

      const x = cur.x;
      const bigR = Math.max(cur.r, prev.r);
      const smallR = Math.min(cur.r, prev.r);
      const hW = 3;
      const hConf = (cur.diameterConf === CONF.CONFIRMED && prev.diameterConf === CONF.CONFIRMED)
        ? CONF.CONFIRMED : CONF.ESTIMATED;

      const topH = DrawingModel.createHatch([
        { x, y: oy - bigR }, { x: x + hW, y: oy - bigR },
        { x: x + hW, y: oy - smallR }, { x, y: oy - smallR },
      ], 45, 3);
      topH.confidence = hConf;
      doc.elements.push(topH);

      const botH = DrawingModel.createHatch([
        { x, y: oy + smallR }, { x: x + hW, y: oy + smallR },
        { x: x + hW, y: oy + bigR }, { x, y: oy + bigR },
      ], 45, 3);
      botH.confidence = hConf;
      doc.elements.push(botH);
    }

    // ──── 9. 텍스트/주석 — v8: KS 규격 표제란(Title Block) ────
    //
    //   ┌────┬──────┬─────┬────┬─────┐
    //   │ 4  │      │     │    │     │  ← 공란 (역순: 4→1)
    //   ├────┼──────┼─────┼────┼─────┤
    //   │ 3  │      │     │    │     │
    //   ├────┼──────┼─────┼────┼─────┤
    //   │ 2  │      │     │    │     │
    //   ├────┼──────┼─────┼────┼─────┤
    //   │ 1  │(품명)│(재질)│   │     │  ← 1번 행에 값 할당
    //   ├────┼──────┼─────┼────┼─────┤
    //   │품번│ 품명 │ 재질│수량│ 비고│  ← 헤더 (아래!)
    //   ├────┴──────┤─────┼────┴─────┤
    //   │  작품명   │척도 │  1:1     │  ← 하단 블록
    //   │           ├─────┼──────────┤
    //   │           │각법 │  3각법   │
    //   └───────────┴─────┴──────────┘
    //
    // 위치: 도면 우측 외부
    //
    {
      // ★ v23: 표제란 — HAN KOOK MACHINERY CO. 표준 형식
      const tbX = innerX2 - tbWidth;     // 윤곽선 우측 내벽에 정렬
      const tbY = innerY2 - tbTotalH;    // 윤곽선 하단 내벽에 정렬

      // 품명 값
      const partNameVal = (ann.partName && ann.partName !== PLACEHOLDER.TEXT)
        ? ann.partName : '';

      const titleBlock = DrawingModel.createTitleBlock(tbX, tbY, tbWidth, {
        companyName: 'HAN KOOK MACHINERY CO.',
        drawingName: partNameVal,
        drawingNameSub: '',
        scale: ann.scale || '1:1',
        unit: 'mm',
        design: '',
        check: '',
        appr: '',
        titlePrj: '깨끗한나라(주) - 청주공장',
        date: new Date().toISOString().slice(2, 10).replace(/-/g, '.'),
        companyKr: '\uae68\ub057\ud55c\ub098\ub77c(\uc8fc) - \uccad\uc8fc\uacf5\uc7a5',
        dwgNo: '',
        rev: '',
        sheetNo: '1',
        paperSize: doc.meta.paperSize || 'A3',
        revisionRows: [],
      });
      titleBlock.confidence = CONF.CONFIRMED;
      doc.elements.push(titleBlock);
    }

    // 9-d) 탭 규격 — 지시선 (leader line with arrow) + 텍스트
    // v5.9: 도면 규칙에 맞는 지시선 — 화살표가 구멍을 가리키고, 텍스트는 외부에 배치
    //   지시선 구조: 구멍 중심 → 꺾임점 → 수평선 → 텍스트
    //   화살표는 치수선과 동일한 스타일 (arrowEnd 마커)
    ann.tapSpecs.forEach(ts => {
      // hiddenFeatures에서 해당 tap-bore 찾기
      const hf = hiddenFeatures.find(f => f.id === ts.holeId);
      const sec = sections.find(s => s.id === ts.section);
      if (!sec) return;

      // ★ v110: 그룹 선택용 — TAP 주석의 모든 요소에 동일 _groupId 부여
      const tapGroupId = `grp_tap_${ts.holeId || ts.section}`;

      // 지시선: 구멍 끝면 중심 → 꺾임점 → 수평 → 텍스트
      const tapR = hf ? (hf.diameter / 2 * PX) : 5;
      const tapDepth = hf ? (hf.depth * PX) : 30;
      let arrowX, arrowY, elbowX, elbowY, textX, textY;

      if (hf && hf.side === 'left') {
        // 화살표 시작: tap bore 끝면 중심 (좌측 section의 끝면 안쪽)
        arrowX = sec.x + tapDepth;
        arrowY = oy + tapR + 2; // 하부 숨은선 바로 아래
        // 꺾임점: 아래쪽 대각선으로
        elbowX = sec.x + tapDepth + 15;
        elbowY = oy + sec.r + 22;
        // 텍스트: 꺾임점에서 수평으로
        textX = elbowX + 3;
        textY = elbowY;
      } else if (hf && hf.side === 'right') {
        arrowX = sec.x + sec.w - tapDepth;
        arrowY = oy + tapR + 2;
        elbowX = sec.x + sec.w - tapDepth - 15;
        elbowY = oy + sec.r + 22;
        textX = elbowX + 3;
        textY = elbowY;
      } else {
        arrowX = sec.x + sec.w / 2;
        arrowY = oy;
        elbowX = arrowX + 20;
        elbowY = oy + sec.r + 22;
        textX = elbowX + 3;
        textY = elbowY;
      }

      // 지시선 1: 화살표 끝점(구멍) → 꺾임점 (대각선, 화살표 마커 포함)
      const leader1 = DrawingModel.createOutline(elbowX, elbowY, arrowX, arrowY, 0.8);
      leader1.confidence = CONF.CONFIRMED;
      leader1.color = '#60a5fa';
      leader1._leaderLine = true;
      leader1._leaderArrow = true; // 렌더러에서 화살표 마커 적용
      leader1._groupId = tapGroupId;  // v110
      doc.elements.push(leader1);

      // 지시선 2: 꺾임점 → 수평선 (텍스트 밑줄)
      const specText = ts.spec ? ts.spec : 'TAP 규격: ____';
      const textWidth = specText.length * 3.25; // 대략적 텍스트 폭
      const leader2 = DrawingModel.createOutline(elbowX, elbowY, elbowX + textWidth + 3, elbowY, 0.8);
      leader2.confidence = CONF.CONFIRMED;
      leader2.color = '#60a5fa';
      leader2._leaderLine = true;
      leader2._groupId = tapGroupId;  // v110
      doc.elements.push(leader2);

      // 텍스트: 수평선 위에
      const t = DrawingModel.createText(textX, textY - 2, specText, 5);
      t.confidence = ts.spec ? ts.specConf : CONF.UNCERTAIN;
      t._isPlaceholder = !ts.spec;
      t._groupId = tapGroupId;  // v110
      doc.elements.push(t);

      // ★ 드릴 규격 표기 — TAP 텍스트 아래에 "Ø'D' 드릴 DP'H'"
      if (hf) {
        const THREAD_PITCH_ANN = { 6: 1.0, 8: 1.25, 10: 1.5, 12: 1.75, 16: 2.0 };
        const pitchVal = THREAD_PITCH_ANN[hf.diameter] || 1.5;
        const drillD = hf.diameter - pitchVal;
        const drillDP = hf.depth + 2;
        const drillLabel = `Ø${drillD} 드릴 DP${drillDP}`;
        const drillTextW = drillLabel.length * 3.25;
        const drillLineY = elbowY + 8;
        const drillLine = DrawingModel.createOutline(elbowX, drillLineY, elbowX + drillTextW + 3, drillLineY, 0.8);
        drillLine.confidence = CONF.CONFIRMED;
        drillLine.color = '#60a5fa';
        drillLine._leaderLine = true;
        drillLine._groupId = tapGroupId;  // v110
        doc.elements.push(drillLine);
        const drillText = DrawingModel.createText(textX, drillLineY - 2, drillLabel, 5);
        drillText.confidence = CONF.CONFIRMED;
        drillText._groupId = tapGroupId;  // v110
        doc.elements.push(drillText);
      }

      // ★ 카운터보어(C/B) 치수 표기 — 드릴 텍스트 아래에 "Ø'D' C/B DP'H'"
      if (ts.counterBore && ts.counterBore.diameter > 0 && ts.counterBore.depth > 0) {
        const cbLabel = `Ø${ts.counterBore.diameter} C/B DP${ts.counterBore.depth}`;
        const cbTextW = cbLabel.length * 3.25;
        // 수평선 연장 (C/B 텍스트 밑줄) — 드릴 표기가 있으면 +16, 없으면 +8
        const cbLineY = elbowY + (hf ? 16 : 8);
        const cbLine = DrawingModel.createOutline(elbowX, cbLineY, elbowX + cbTextW + 3, cbLineY, 0.8);
        cbLine.confidence = CONF.CONFIRMED;
        cbLine.color = '#60a5fa';
        cbLine._leaderLine = true;
        cbLine._groupId = tapGroupId;  // v110
        doc.elements.push(cbLine);
        // C/B 텍스트
        const cbText = DrawingModel.createText(textX, cbLineY - 2, cbLabel, 5);
        cbText.confidence = CONF.CONFIRMED;
        cbText._groupId = tapGroupId;  // v110
        doc.elements.push(cbText);
      }
    });

    // 9-e) 슬롯 치수 (메인 도면에 남은 슬롯이 있을 경우만)
    geo.slots.forEach(sl => {
      const sec = sections.find(s => s.id === sl.cx_section);
      if (!sec) return;
      const slX = sec.x + sl.cx_offset * secPX(sec);
      const t = DrawingModel.createText(slX, oy - sec.r - 20,
        `슬롯 ${sl.slotLength}x${sl.slotWidth}`, 5);
      t.confidence = sl.confidence;
      doc.elements.push(t);
    });

    // 9-f) (v5.5: 키홈 의미 해석 제거 — AI는 키홈인지 판단하지 않음)

    // ★ 불확실 요소 주석
    if (spec.uncertainElements.length > 0) {
      let ueY = oy + maxR * PX + 40;
      spec.uncertainElements.forEach(ue => {
        const t = DrawingModel.createText(ox, ueY,
          `⚠ [${ue.severity}] ${ue.description}`, 11);
        t.confidence = CONF.UNCERTAIN;
        doc.elements.push(t);
        ueY += 16;
      });
    }

    // ──── 10. 보조 투상도 (Auxiliary Views) ────
    // v5.6: 손그림 기반 — 정확한 위치에 투영선 포함
    //
    // 규칙:
    //   1. 보조투상도는 관련 section의 바로 위에 배치
    //   2. 수직 투영선(가는 실선)으로 메인 도면과 연결
    //   3. 투영선은 보조도의 폭 양 끝에서 메인 도면의 해당 section 상단으로
    //   4. 보조도 내부에는 숨은선 없음 — 실선 geometry만
    //   5. 보조도 치수는 독립 (메인 치수와 분리)
    //
    const auxViews = spec.auxiliaryViews || [];
    if (auxViews.length > 0) {
      const auxViewElements = [];

      auxViews.forEach((aux, ai) => {
        const relatedSec = sections.find(s => s.id === aux.relatedSection);
        let auxCx, auxCy;

        // v8: aux.id 'AUX{N}' → hiddenFeature 'HF_KW{N}' 매칭 (같은 인덱스)
        const auxIdx = parseInt((aux.id || '').replace(/\D/g, '')) || (ai + 1);
        const matchHfId = `HF_KW${auxIdx}`;

        // 해당 키홈 hidden feature 찾기 (ID 매칭 우선, 없으면 section 매칭)
        const findRelatedHf = () => {
          // 1차: ID 매칭
          const byId = hiddenFeatures.find(
            hf => hf.type === 'keyway' && hf.id === matchHfId && hf._resolvedKx1 != null
          );
          if (byId) return byId;
          // 2차: section 매칭 (하위 호환)
          return hiddenFeatures.find(
            hf => hf.type === 'keyway' && hf.section === aux.relatedSection && hf._resolvedKx1 != null
          );
        };

        if (relatedSec) {
          const relatedHf = findRelatedHf();
          if (relatedHf) {
            // offset 기반 키홈의 수평 중심에 보조투상도 배치
            auxCx = (relatedHf._resolvedKx1 + relatedHf._resolvedKx2) / 2;
          } else {
            // 기존 방식: section 수평 중심
            auxCx = relatedSec.x + relatedSec.w / 2;
          }
        } else {
          auxCx = ox + (ai * 200);
        }
        // 메인 도면 상단에서 충분히 위에 배치 (투영선 공간 확보)
        // v8: 3번째 이후 보조투상도는 추가 간격으로 겹침 방지
        auxCy = oy - maxR * PX - 100 - (ai >= 2 ? (ai - 1) * 60 : 0);

        const shape = aux.shape;
        // v8: 키홈 offset으로 실제 폭이 재계산된 경우, 보조투상도도 동기화
        const relatedHf = findRelatedHf();
        const actualAuxWidth = relatedHf
          ? (relatedHf._resolvedKx2 - relatedHf._resolvedKx1) // resolved pixel width
          : shape.width * PX;
        const sw = actualAuxWidth;
        const sh = shape.height * PX;
        // 보조도 수평 치수에 표시할 실제 키홈폭 (mm)
        const auxWidthMm = relatedHf
          ? Math.round((relatedHf._resolvedKx2 - relatedHf._resolvedKx1) / PX * 100) / 100
          : shape.width;

        // v117: shape.type에 따라 키 형상 렌더링 — obround / one-side-round / rect 모두 createSlot 사용
        if (shape.type === 'obround' || shape.type === 'one-side-round' || shape.type === 'rect') {
          const slot = DrawingModel.createSlot(
            auxCx - sw / 2, auxCy - sh / 2, sw, sh
          );
          slot.confidence = shape.confidence;
          slot._auxViewId = aux.id;
          slot.slotShape = shape.type;  // v117: renderer에서 형상 분기
          // ★ v119: 한쪽 둥근형 방향 결정 (보조투상도)
          if (shape.type === 'one-side-round' && relatedHf) {
            const roVal = parseFloat(relatedHf.keywayRightOffset);
            if (!isNaN(roVal) && roVal === 0) slot.slotRoundSide = 'left';
            else slot.slotRoundSide = 'right';
          }
          // v6.0: 보조투상도 외형은 검정색 실선 (PDF 출력 대비)
          slot.color = '#000000';
          doc.elements.push(slot);
          auxViewElements.push(slot);

          // 중심선 (수평)
          const cl = DrawingModel.createCenterline(
            auxCx - sw / 2 - 8, auxCy, auxCx + sw / 2 + 8, auxCy
          );
          cl.confidence = shape.confidence;
          cl._auxViewId = aux.id;
          doc.elements.push(cl);
          auxViewElements.push(cl);
        } else {
          // 직사각형 폴백 (실선 — 숨은선 아님!)
          const topL = DrawingModel.createOutline(auxCx - sw/2, auxCy - sh/2, auxCx + sw/2, auxCy - sh/2, 1);
          topL.confidence = shape.confidence;
          topL._auxViewId = aux.id;
          doc.elements.push(topL);
          auxViewElements.push(topL);

          const botL = DrawingModel.createOutline(auxCx - sw/2, auxCy + sh/2, auxCx + sw/2, auxCy + sh/2, 1);
          botL.confidence = shape.confidence;
          botL._auxViewId = aux.id;
          doc.elements.push(botL);
          auxViewElements.push(botL);

          const leftL = DrawingModel.createOutline(auxCx - sw/2, auxCy - sh/2, auxCx - sw/2, auxCy + sh/2, 1);
          leftL.confidence = shape.confidence;
          leftL._auxViewId = aux.id;
          doc.elements.push(leftL);
          auxViewElements.push(leftL);

          const rightL = DrawingModel.createOutline(auxCx + sw/2, auxCy - sh/2, auxCx + sw/2, auxCy + sh/2, 1);
          rightL.confidence = shape.confidence;
          rightL._auxViewId = aux.id;
          doc.elements.push(rightL);
          auxViewElements.push(rightL);
        }

        // ── 투영선 (projection lines) ──
        // 손그림에서 보조도와 메인 도면을 수직 가는 실선으로 연결
        if (aux.projectionLines && relatedSec) {
          const projY1 = auxCy + sh / 2 + 3;  // 보조도 하단
          const projY2 = oy - relatedSec.r - 3; // 메인 도면 상단

          // 좌측 투영선
          const leftProj = DrawingModel.createOutline(
            auxCx - sw / 2, projY1,
            auxCx - sw / 2, projY2,
            0.5
          );
          leftProj.confidence = CONF.CONFIRMED;
          leftProj._auxViewId = aux.id;
          leftProj._projectionLine = true;
          doc.elements.push(leftProj);
          auxViewElements.push(leftProj);

          // 우측 투영선
          const rightProj = DrawingModel.createOutline(
            auxCx + sw / 2, projY1,
            auxCx + sw / 2, projY2,
            0.5
          );
          rightProj.confidence = CONF.CONFIRMED;
          rightProj._auxViewId = aux.id;
          rightProj._projectionLine = true;
          doc.elements.push(rightProj);
          auxViewElements.push(rightProj);
        }

        // 보조도 치수선 (독립 — 메인 치수와 분리)
        // v5.9: 세로 치수는 외부에 배치 (도면 규칙)
        //   수평 치수: 상단 offset 15 (obround 위)
        //   수직 치수: 우측 offset -20 (obround 오른쪽 바깥)
        aux.dimensions.forEach(dim => {
          if (dim.axis === 'horizontal') {
            const d = DrawingModel.createDimension(
              auxCx - sw / 2, auxCy - sh / 2,
              auxCx + sw / 2, auxCy - sh / 2,
              applyScale(auxWidthMm), ann.unit, 15
            );
            d.confidence = dim.confidence;
            d._auxViewId = aux.id;
            doc.elements.push(d);
            auxViewElements.push(d);
          } else {
            // 세로 치수: 오른쪽 외부에 배치
            // x1,y1 = 우측상단, x2,y2 = 우측하단 → offset을 음수로 하여 오른쪽으로 이동
            const d = DrawingModel.createDimension(
              auxCx + sw / 2, auxCy - sh / 2,
              auxCx + sw / 2, auxCy + sh / 2,
              applyScale(dim.value), ann.unit, -20
            );
            d.confidence = dim.confidence;
            d._auxViewId = aux.id;
            doc.elements.push(d);
            auxViewElements.push(d);
          }
        });
      });

      // document에 auxiliaryViews 메타데이터 저장
      doc.auxiliaryViews = auxViews.map((aux, i) => ({
        id: aux.id,
        position: aux.position,
        relatedSection: aux.relatedSection,
        elementIds: auxViewElements
          .filter(el => el._auxViewId === aux.id)
          .map(el => el.id),
      }));
    }

    // ──── 9.5. 중공축 보조투상도 (Hollow Shaft Cross-Section) ────
    //
    // 중공축(hollow shaft)인 경우, 마지막 구간의 우측 끝에
    // 동심원(외경 + 내경) 단면 보조투상도를 그린다.
    //
    // 구조: 외경 원 (실선) + 내경 원 (실선) + 십자 중심선
    //       + 직경 치수선 (⌀외경, ⌀내경)
    //
    const hollowData = spec.hollowShaftData;
    if (hollowData && hollowData.boreDiameter) {
      const lastSec = sections[sections.length - 1];
      if (lastSec) {
        // 보조투상도 위치: 마지막 구간 우측 끝에서 오른쪽으로 이격
        const auxCx = lastSec.x + lastSec.w + 80;  // 우측 끝에서 80px 오른쪽
        const auxCy = oy;  // 중심선과 같은 높이

        // 외경/내경 (mm → px)
        const outerDiam = hollowData.outerDiameter || lastSec._renderDiam || 20;
        const innerDiam = hollowData.boreDiameter;
        const outerR = (outerDiam / 2) * PX;
        const innerR = (innerDiam / 2) * PX;

        // ── 외경 원 (실선, 검정) ──
        const outerCircle = DrawingModel.createHole(auxCx, auxCy, outerR * 2);
        outerCircle.color = '#000000';
        outerCircle.holeType = 'through';  // 실선
        outerCircle.confidence = CONF.CONFIRMED;
        outerCircle._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(outerCircle);

        // ── 내경 원 (실선, 검정) ──
        const innerCircle = DrawingModel.createHole(auxCx, auxCy, innerR * 2);
        innerCircle.color = '#000000';
        innerCircle.holeType = 'through';  // 실선
        innerCircle.confidence = CONF.CONFIRMED;
        innerCircle._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(innerCircle);

        // ── 십자 중심선 ──
        const clMargin = outerR + 12;
        const clH = DrawingModel.createCenterline(
          auxCx - clMargin, auxCy, auxCx + clMargin, auxCy
        );
        clH.confidence = CONF.CONFIRMED;
        clH._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(clH);

        const clV = DrawingModel.createCenterline(
          auxCx, auxCy - clMargin, auxCx, auxCy + clMargin
        );
        clV.confidence = CONF.CONFIRMED;
        clV._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(clV);

        // ── 외경 치수선 (⌀외경) — 상단 ──
        const outerDimVal = `⌀${applyScale(outerDiam)}`;
        const outerDim = DrawingModel.createDimension(
          auxCx - outerR, auxCy - outerR,
          auxCx + outerR, auxCy - outerR,
          outerDimVal, ann.unit, 18
        );
        outerDim.confidence = CONF.CONFIRMED;
        outerDim._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(outerDim);

        // ── 내경 치수선 (⌀내경) — 하단 ──
        const innerDimVal = `⌀${applyScale(innerDiam)}`;
        const innerDim = DrawingModel.createDimension(
          auxCx - innerR, auxCy + innerR,
          auxCx + innerR, auxCy + innerR,
          innerDimVal, ann.unit, -18
        );
        innerDim.confidence = CONF.CONFIRMED;
        innerDim._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(innerDim);

        // ── 연결선 (마지막 구간 끝 → 보조투상도) ──
        // 가는 일점쇄선으로 연결
        const connLine = DrawingModel.createOutline(
          lastSec.x + lastSec.w, oy,
          auxCx - outerR - 5, oy,
          0.5
        );
        connLine.confidence = CONF.CONFIRMED;
        connLine._auxViewId = 'AUX_HOLLOW';
        connLine.color = '#666666';
        doc.elements.push(connLine);
      }
    }

    // ──── 9.6. 체인스프라켓(스프라켓) 렌더링 ────
    //
    // ★ 배치 모드 2가지:
    // A) 기존: placement='edge' (기본값) — 축의 끝(S1 좌측 또는 Sn 우측)에 그린다.
    //    - section: 기준 구간, side: 'left'/'right'
    //    - 보조투상도(end view) 생성
    //
    // B) 신규: placement='between' — 두 구간 사이에 그린다.
    //    - sectionLeft, sectionRight: 좌/우 인접 구간
    //    - bossDirection: 'left'(보스가 왼쪽 구간 방향) / 'right'(보스가 오른쪽 구간 방향)
    //    - 보조투상도 생성하지 않음
    //    - 구조 (bossDirection='left'):
    //        [좌측구간]─[boss]─[기어본체]─[우측구간]
    //        R값은 기어 반대쪽(우측)에 적용
    //    - 구조 (bossDirection='right'):
    //        [좌측구간]─[기어본체]─[boss]─[우측구간]
    //        R값은 기어 반대쪽(좌측)에 적용
    //
    // 정면도(side view): 기어 단면 + 보스(per-boss R값) + 보어 숨은선
    //   — 참고도면 구조: [보스1]─[기어본체]─[보스2] 형태의 단면
    //   — 기어본체는 외경 높이 직사각형, 보스는 기어와 단차를 이루는 작은 직경 직사각형
    //   — 각 보스의 4개 모서리(좌상, 좌하, 우상, 우하)에 대해 R값 적용 가능
    //   — R 적용위치: 'left' = 보스 정면도 좌측 상하, 'right' = 우측 상하, 'both' = 양쪽 모두
    // 보조투상도(end view): 이끝원 = 등분점만 표시(원 자체 삭제), 이뿌리원, 보어, 키홈, 톱니형상
    //   (placement='between'일 때는 생략)
    //
    const RS_PITCH_MAP = { RS25: 6.35, RS35: 9.525, RS40: 12.7, RS50: 15.875, RS60: 19.05, RS80: 25.4, RS100: 31.75, RS120: 38.1 };
    const chainGears = spec.chainGears || [];
    chainGears.forEach((cg, cgIdx) => {
      const isBetween = cg.placement === 'between';

      // ── 구간 참조 해석 ──
      let sec;        // 기준 구간 (edge: 단일, between: 좌측 구간)
      let secRight;   // between 전용: 우측 구간
      let side;       // edge 전용: 'left'/'right'
      let secR;       // 기준 구간 반지름 px

      if (isBetween) {
        sec = sections.find(s => s.id === cg.sectionLeft);
        secRight = sections.find(s => s.id === cg.sectionRight);
        if (!sec || !secRight) return;
        // between 모드에서 side는 bossDirection으로부터 매핑
        // bossDirection='left' → 보스가 좌측구간 쪽 → side='left' (기어본체가 우측)
        // bossDirection='right' → 보스가 우측구간 쪽 → side='right' (기어본체가 좌측)
        side = cg.bossDirection || 'left';
        secR = sec.r;
      } else {
        sec = sections.find(s => s.id === cg.section);
        if (!sec) return;
        side = cg.side; // 'left' or 'right'
        secR = sec.r; // 축(section) 반지름 px
      }

      const gearOuterR = (cg.outerDiam / 2) * PX;
      const gearBoreR = (cg.boreDiam / 2) * PX;
      const gearWidthPx = (cg.gearWidth || 8) * PX;

      // ── per-boss 데이터 가져오기 (하위호환 포함) ──
      const bossList = [];
      if (cg.boss) {
        const bCount = cg.boss.count || 1;
        if (cg.boss.bosses && cg.boss.bosses.length > 0) {
          // 새 형식: per-boss 배열
          for (let b = 0; b < bCount; b++) {
            bossList.push(cg.boss.bosses[b] || cg.boss.bosses[0]);
          }
        } else {
          // 이전 형식: 단일 보스 데이터
          for (let b = 0; b < bCount; b++) {
            bossList.push({
              outerDiam: cg.boss.outerDiam || 0,
              thickness: cg.boss.thickness || 0,
              fillet: cg.boss.fillet || null,
            });
          }
        }
      }

      // ── 1) 정면도: 전체 단면 프로필 ──
      // ★ 수정: 보스는 모두 기어 뒤(축쪽)에 위치
      // 보스 순서: boss1이 스프라켓에 가장 가까움, bossN이 축(또는 구간)에 가장 가까움
      // 구조 (edge):
      //   bossDirection=right (side=left): [기어본체]─[boss1]─[boss2]─...─[bossN]─[축] (좌→우)
      //   bossDirection=left  (side=right): [축]─[bossN]─...─[boss2]─[boss1]─[기어본체] (좌→우)
      // 구조 (between):
      //   bossDirection=left:  [좌측구간]─[bossN]─...─[boss1]─[기어본체]─[우측구간]
      //   bossDirection=right: [좌측구간]─[기어본체]─[boss1]─...─[bossN]─[우측구간]
      // 기어본체 위치 계산
      let gearX; // 기어 본체 좌측 X
      // 보스는 모두 기어와 축 사이 (기어 뒤쪽)
      // N개 보스 지원 (per-boss thickness 배열)
      const bossThickPx = bossList.map(b => (b && b.thickness > 0) ? b.thickness * PX : 0);
      const bossRadiusPx = bossList.map(b => (b && b.outerDiam > 0) ? (b.outerDiam / 2) * PX : 0);
      const totalBossThick = bossThickPx.reduce((sum, t) => sum + t, 0);
      // 하위호환: boss1/boss2 참조 유지
      const boss1 = bossList.length > 0 ? bossList[0] : null;
      const boss2 = bossList.length > 1 ? bossList[1] : null;
      const b1Thick = bossThickPx[0] || 0;
      const b2Thick = bossThickPx[1] || 0;

      if (isBetween) {
        // ── between 모드: 구간 사이 gap에 배치 ──
        // ★ 구간 좌표 계산 단계에서 sec 뒤에 gap이 삽입되었으므로,
        //   sec.x+sec.w 와 secRight.x 사이에 실제 gap이 존재한다.
        //   이 gap 안에 조립체를 중앙 배치한다.
        //   결과: S2 ─ [스프라켓] ─ S3 (스프라켓이 양쪽 구간 사이에 시각적으로 분리)
        const gapLeft = sec.x + sec.w;       // 좌측구간 우측 끝
        const gapRight = secRight.x;          // 우측구간 좌측 끝 (gap 삽입으로 gapLeft < gapRight)
        const gapCenter = (gapLeft + gapRight) / 2;
        const assemblyWidth = gearWidthPx + totalBossThick;
        // 조립체를 gap 중앙에 배치
        // bossDirection='left' → [bossN]─...─[boss1]─[기어본체]
        // bossDirection='right' → [기어본체]─[boss1]─...─[bossN]
        if (side === 'left') {
          const assemblyLeft = gapCenter - assemblyWidth / 2;
          gearX = assemblyLeft + totalBossThick;
        } else {
          const assemblyLeft = gapCenter - assemblyWidth / 2;
          gearX = assemblyLeft;
        }
      } else if (side === 'left') {
        // edge 모드: [기어]─[boss1]─[boss2]─[축S1]
        gearX = sec.x - gearWidthPx - totalBossThick;
      } else {
        // edge 모드: [축SN]─[boss2]─[boss1]─[기어]
        gearX = sec.x + sec.w + totalBossThick;
      }

      const gTopY = oy - gearOuterR;
      const gBotY = oy + gearOuterR;
      const gLeft = gearX;
      const gRight = gearX + gearWidthPx;

      // ── 기어본체 정면도: 간략화된 사다리꼴 톱니 표현 ──
      // ★ 규칙: 기어를 옆에서 보면 이빨 방향에 따라 선 위치가 매번 변하므로,
      //   간략화하여 상/하단에 사다리꼴 1개씩만 표현한다.
      //
      // ★ 정면도 구조 (사다리꼴은 본체 폭의 중앙 ~50%만 차지):
      //
      //     gLeft                                    gRight
      //       │                                        │
      //       ├──rootTopY─┬─── tipL──tipR ───┬─rootTopY─┤    ← rootTopY
      //       │  (수평선)  ╱    (이끝수평선)    ╲  (수평선)  │
      //       │         ╱                      ╲         │
      //       │       tipL                    tipR        │    ← gTopY (이끝)
      //       │           (사다리꼴 영역)                   │
      //       ├──rootBotY─┬─── tipL──tipR ───┬─rootBotY─┤    ← rootBotY
      //       │  (수평선)  ╲                  ╱  (수평선)  │
      //       │                                          │
      //
      //   사다리꼴 양쪽에는 이뿌리 수평선(rootL까지, rootR부터), 양끝에 수직선(외형선)
      // ★ 사다리꼴 규칙:
      //   밑변(넓은쪽) = 체인스프라켓 두께 (gLeft ~ gRight, 즉 gearWidthPx 전체)
      //   높이 = 피치값 기반
      //   윗변(좁은쪽) = 밑변보다 좁게 (tipInset 만큼 안쪽)
      //
      //   정면도 구조:
      //        tipL────tipR            ← gTopY (이끝, 좁은쪽)
      //       ╱              ╲
      //   gLeft──────────────gRight    ← rootTopY (이뿌리 = 본체 상단)
      //   │      (본체 영역)       │
      //   gLeft──────────────gRight    ← rootBotY (이뿌리 = 본체 하단)
      //       ╲              ╱
      //        tipL────tipR            ← gBotY (이끝, 좁은쪽)
      //
      const gPitch = RS_PITCH_MAP[cg.chainSpec] || 9.525;
      const gToothH = gPitch * 0.3 * PX; // 톱니 높이 (px) — 피치의 30%

      // Y 기준: gTopY/gBotY = 외경(이끝) 경계 (사다리꼴 팁, 바깥)
      //         rootTopY/rootBotY = 이뿌리 (본체 상·하단, 안쪽)
      const rootTopY = gTopY + gToothH;   // 본체 상단
      const rootBotY = gBotY - gToothH;   // 본체 하단

      // 사다리꼴 밑변 = 스프라켓 두께 전체 (gLeft ~ gRight)
      // 사다리꼴 윗변 = 밑변에서 20% 안쪽
      const tipInset = gearWidthPx * 0.20;
      const tipLeft = gLeft + tipInset;
      const tipRight = gRight - tipInset;

      // ── 상단 사다리꼴 ──
      // 좌측 경사: gLeft,rootTopY → tipLeft,gTopY
      const tl1 = DrawingModel.createOutline(gLeft, rootTopY, tipLeft, gTopY, 1);
      tl1.confidence = cg.confidence; doc.elements.push(tl1);
      // 윗변 수평: tipLeft,gTopY → tipRight,gTopY
      const tl2 = DrawingModel.createOutline(tipLeft, gTopY, tipRight, gTopY, 1);
      tl2.confidence = cg.confidence; doc.elements.push(tl2);
      // 우측 경사: tipRight,gTopY → gRight,rootTopY
      const tl3 = DrawingModel.createOutline(tipRight, gTopY, gRight, rootTopY, 1);
      tl3.confidence = cg.confidence; doc.elements.push(tl3);

      // ── 하단 사다리꼴 (대칭) ──
      const bl1 = DrawingModel.createOutline(gLeft, rootBotY, tipLeft, gBotY, 1);
      bl1.confidence = cg.confidence; doc.elements.push(bl1);
      const bl2 = DrawingModel.createOutline(tipLeft, gBotY, tipRight, gBotY, 1);
      bl2.confidence = cg.confidence; doc.elements.push(bl2);
      const bl3 = DrawingModel.createOutline(tipRight, gBotY, gRight, rootBotY, 1);
      bl3.confidence = cg.confidence; doc.elements.push(bl3);

      // ── 본체 상·하단 수평선 (본체와 기어이빨 경계) ──
      const rootTopLine = DrawingModel.createOutline(gLeft, rootTopY, gRight, rootTopY, 1);
      rootTopLine.confidence = cg.confidence; doc.elements.push(rootTopLine);
      const rootBotLine = DrawingModel.createOutline(gLeft, rootBotY, gRight, rootBotY, 1);
      rootBotLine.confidence = cg.confidence; doc.elements.push(rootBotLine);

      // ── 좌측·우측 수직선 (기어 본체 외형선) ──
      const vL = DrawingModel.createOutline(gLeft, rootTopY, gLeft, rootBotY, 1);
      vL.confidence = cg.confidence; doc.elements.push(vL);
      const vR = DrawingModel.createOutline(gRight, rootTopY, gRight, rootBotY, 1);
      vR.confidence = cg.confidence; doc.elements.push(vR);

      // ── 보어 내경 숨은선 ──
      if (cg.boreDiam > 0) {
        const boreTopY = oy - gearBoreR;
        const boreBotY = oy + gearBoreR;
        // ★ 보스가 모두 축쪽이므로 전체 범위 재계산
        let hLeft, hRight;
        if (isBetween) {
          // between: 보스가 bossDirection 쪽에 위치
          if (side === 'left') {
            // bossDirection='left': [boss]─[기어] → 보어는 전체 범위
            hLeft = gLeft - totalBossThick;
            hRight = gRight;
          } else {
            // bossDirection='right': [기어]─[boss] → 보어는 전체 범위
            hLeft = gLeft;
            hRight = gRight + totalBossThick;
          }
        } else {
          hLeft = (side === 'left') ? gLeft : gLeft - totalBossThick;
          hRight = (side === 'left') ? gRight + totalBossThick : gRight;
        }
        const boreTop = DrawingModel.createHiddenLine(hLeft, boreTopY, hRight, boreTopY, 0.8);
        boreTop.confidence = cg.confidence; doc.elements.push(boreTop);
        const boreBot = DrawingModel.createHiddenLine(hLeft, boreBotY, hRight, boreBotY, 0.8);
        boreBot.confidence = cg.confidence; doc.elements.push(boreBot);
      }

      // ── 보스 렌더링 (per-boss) ──
      // ★ R값 규칙 완전 재작성 v2:
      //   R값은 보스 사각형 모서리가 아니라 "단차(step) 전이부"에 적용한다.
      //   단차 = 인접 요소(기어/boss2/축)와 보스 사이의 직경 차이로 생기는 계단 형상.
      //   필렛 원호는 단차의 안쪽 오목 코너(inside concave corner)에 배치되어
      //   응력집중을 줄이는 역할을 한다.
      //
      //   정면도 단면 프로필(상반부, side=left):
      //     adjTopY ────┐
      //                 │ step (수직선)
      //     bTopY  ─────┤───── ← R값 필렛은 여기 (단차 코너)
      //
      //   R값 필렛 위치:
      //     좌측단차-상단: 단차수직선과 보스상단수평선이 만나는 안쪽 코너
      //     좌측단차-하단: 보스하단수평선과 단차수직선이 만나는 안쪽 코너
      //     우측단차-상단: 보스상단수평선과 단차수직선이 만나는 안쪽 코너
      //     우측단차-하단: 단차수직선과 보스하단수평선이 만나는 안쪽 코너
      //
      //   SVG arc: M sx sy A r r 0 0 0 ex ey  (항상 sweep=0으로 오목(concave) 방향)
      //
      // bx: 보스 좌측 X, bw: 보스 폭px
      // adjacentRLeft/Right: 인접 요소의 반지름(px) — 보스보다 큰 값이면 단차 존재
      function renderBoss(bossData, bx, bw, adjacentRLeft, adjacentRRight, conf, skipStepLeft, skipStepRight, adjTypeL, adjTypeR) {
        if (!bossData || bossData.outerDiam <= 0 || bossData.thickness <= 0) return;
        const bR = (bossData.outerDiam / 2) * PX;
        const bTopY = oy - bR;
        const bBotY = oy + bR;
        const bLeft = bx;
        const bRight = bx + bw;

        // per-boss R값 (필렛)
        const fil = bossData.fillet;
        const hasR = fil && fil.value > 0;
        const rPx = hasR ? fil.value * PX : 0;
        const rSide = hasR ? fil.side : 'none';
        const applyRL = hasR && (rSide === 'both' || rSide === 'left');
        const applyRR = hasR && (rSide === 'both' || rSide === 'right');

        // 인접 요소와의 단차 존재 여부 (반지름 차이 > 0.5px)
        const hasStepL = adjacentRLeft > 0 && Math.abs(bR - adjacentRLeft) > 0.5;
        const hasStepR = adjacentRRight > 0 && Math.abs(bR - adjacentRRight) > 0.5;
        // 인접 요소가 보스보다 큰지 여부 (보통 기어→보스, 보스→축 방향으로 작아짐)
        const adjLargerL = adjacentRLeft > bR;
        const adjLargerR = adjacentRRight > bR;

        // ── 상단 수평선 ──
        // adjLarger인 경우에만 보스 수평선을 R만큼 단축 (접점이 보스 수평선 위에 있으므로)
        // bossLarger인 경우 접점은 인접요소 수평선 위에 있으므로 보스 수평선은 단축하지 않음
        const topL = (applyRL && hasStepL && adjLargerL) ? bLeft + rPx : bLeft;
        const topR = (applyRR && hasStepR && adjLargerR) ? bRight - rPx : bRight;
        if (topR > topL) {
          const tl = DrawingModel.createOutline(topL, bTopY, topR, bTopY, 1);
          tl.confidence = conf; doc.elements.push(tl);
        }

        // ── 하단 수평선 ──
        const botL = (applyRL && hasStepL && adjLargerL) ? bLeft + rPx : bLeft;
        const botR = (applyRR && hasStepR && adjLargerR) ? bRight - rPx : bRight;
        if (botR > botL) {
          const bl = DrawingModel.createOutline(botL, bBotY, botR, bBotY, 1);
          bl.confidence = conf; doc.elements.push(bl);
        }

        // ── 좌측·우측 단차 수직선 + R값 필렛 원호 ──
        //
        // ★★★ R값 필렛 핵심 원리 ★★★
        // 두 직선이 90°로 만나는 꼭짓점(corner)에 반지름 R인 원을 내접시킴.
        // - 원의 중심은 꼭짓점이 아닌, 빈 공간(노치) 쪽에 위치
        // - 원은 두 직선에 각각 접함 (접점 = 꼭짓점에서 R만큼 떨어진 점)
        // - 꼭짓점은 원 바깥에 위치 (dist = R√2 > R)
        // - 원호가 코너를 "오목하게" 깎아냄
        // - 모든 경우에 SVG sweep=1 (CW) 사용, start/end 순서로 방향 제어
        //
        // 좌측 단차 (bLeft에서의 수직선)
        // skipStepLeft: 인접 요소가 이미 이 쪽 단차를 처리함 (중복 방지)
        if (hasStepL && !skipStepLeft) {
          const adjTopY = oy - adjacentRLeft;
          const adjBotY = oy + adjacentRLeft;

          if (applyRL) {
            if (adjLargerL) {
              // ── adjLargerL: 인접요소(기어)가 보스보다 큼 ──
              // 프로파일:
              //   adjTopY ──────┐
              //                 │ x=bLeft (단차 수직선)
              //   bTopY   ─────┘ corner=(bLeft, bTopY)  ← 90° 내부 코너
              //           boss →
              //   bBotY   ─────┐ corner=(bLeft, bBotY)  ← 90° 내부 코너
              //                 │
              //   adjBotY ──────┘
              //
              // 상단(Left-Top): corner=(bLeft, bTopY)
              //   노치 방향: 오른쪽 위 (boss 안쪽)
              //   center=(bLeft+R, bTopY-R)
              //   start=(bLeft, bTopY-R) [수직선 접점] → end=(bLeft+R, bTopY) [수평선 접점]
              //   sweep=0 (CCW) → 오목(concave) 필렛

              // 상단 단차 수직선: adjTopY → (bTopY - R) 로 단축
              // ★ 인접요소가 기어인 경우 사다리꼴 경사선이 높이 차이를 처리하므로
              //   단차 수직선 생략 (사다리꼴 옆의 불필요한 수직선 방지)
              const stepTopEnd = bTopY - rPx;
              if (stepTopEnd > adjTopY && adjTypeL !== 'gear') {
                const st = DrawingModel.createOutline(bLeft, adjTopY, bLeft, stepTopEnd, 1);
                st.confidence = conf; doc.elements.push(st);
              }
              // 상단 필렛 원호
              const cx1 = bLeft + rPx, cy1 = bTopY - rPx;
              const a1 = DrawingModel.createOutline(bLeft, bTopY - rPx, bLeft + rPx, bTopY, 1);
              a1.confidence = conf;
              a1._arc = { r: rPx, cx: cx1, cy: cy1, sweep: 0 };
              doc.elements.push(a1);

              // 하단(Left-Bottom): corner=(bLeft, bBotY)
              //   노치 방향: 오른쪽 아래
              //   center=(bLeft+R, bBotY+R)
              //   start=(bLeft+R, bBotY) [수평선 접점] → end=(bLeft, bBotY+R) [수직선 접점]
              //   sweep=0 (CCW) → 오목(concave) 필렛

              // 하단 단차 수직선: (bBotY + R) → adjBotY 로 단축
              const stepBotStart = bBotY + rPx;
              if (adjBotY > stepBotStart && adjTypeL !== 'gear') {
                const sb = DrawingModel.createOutline(bLeft, stepBotStart, bLeft, adjBotY, 1);
                sb.confidence = conf; doc.elements.push(sb);
              }
              // 하단 필렛 원호
              const cx2 = bLeft + rPx, cy2 = bBotY + rPx;
              const a2 = DrawingModel.createOutline(bLeft + rPx, bBotY, bLeft, bBotY + rPx, 1);
              a2.confidence = conf;
              a2._arc = { r: rPx, cx: cx2, cy: cy2, sweep: 0 };
              doc.elements.push(a2);
            } else {
              // ── bossLargerL: 보스가 인접요소보다 큼 ──
              // 프로파일:
              //   bTopY   ┌──────────  boss top (보스가 더 높이 올라감)
              //            │ x=bLeft (단차 수직선)
              //   adjTopY ─┘            corner=(bLeft, adjTopY)  ← 90° 내부 코너
              //           ← adj
              //   adjBotY ─┐            corner=(bLeft, adjBotY)  ← 90° 내부 코너
              //            │
              //   bBotY   └──────────
              //
              // 상단(Left-Top): corner=(bLeft, adjTopY)
              //   노치 방향: 왼쪽 위 (adj쪽 빈 공간)
              //   center=(bLeft-R, adjTopY-R)
              //   start=(bLeft-R, adjTopY) [수평선 접점] → end=(bLeft, adjTopY-R) [수직선 접점]
              //   sweep=1 (CW) → 오목(concave) 필렛 (bossLarger는 코너 방향이 반대이므로 sweep=1)

              // 상단 단차 수직선: bTopY → (adjTopY - R) 로 단축
              const stepTopEnd = adjTopY - rPx;
              if (stepTopEnd > bTopY) {
                const st = DrawingModel.createOutline(bLeft, bTopY, bLeft, stepTopEnd, 1);
                st.confidence = conf; doc.elements.push(st);
              }
              // 상단 필렛 원호
              const cx1 = bLeft - rPx, cy1 = adjTopY - rPx;
              const a1 = DrawingModel.createOutline(bLeft - rPx, adjTopY, bLeft, adjTopY - rPx, 1);
              a1.confidence = conf;
              a1._arc = { r: rPx, cx: cx1, cy: cy1, sweep: 1 };
              doc.elements.push(a1);

              // 하단(Left-Bottom): corner=(bLeft, adjBotY)
              //   노치 방향: 왼쪽 아래
              //   center=(bLeft-R, adjBotY+R)
              //   start=(bLeft, adjBotY+R) [수직선 접점] → end=(bLeft-R, adjBotY) [수평선 접점]
              //   sweep=1 (CW) → 오목(concave) 필렛 (bossLarger는 코너 방향이 반대이므로 sweep=1)

              // 하단 단차 수직선: (adjBotY + R) → bBotY 로 단축
              const stepBotStart = adjBotY + rPx;
              if (bBotY > stepBotStart) {
                const sb = DrawingModel.createOutline(bLeft, stepBotStart, bLeft, bBotY, 1);
                sb.confidence = conf; doc.elements.push(sb);
              }
              // 하단 필렛 원호
              const cx2 = bLeft - rPx, cy2 = adjBotY + rPx;
              const a2 = DrawingModel.createOutline(bLeft, adjBotY + rPx, bLeft - rPx, adjBotY, 1);
              a2.confidence = conf;
              a2._arc = { r: rPx, cx: cx2, cy: cy2, sweep: 1 };
              doc.elements.push(a2);
            }
          } else {
            // R값 미적용: 단차 수직선
            // ★ 단차 수직선 — 직경 차이가 작을 때(≤4mm) 단축하여 간략 표현
            //   bossLarger + adjLarger 모두에 적용 (사용자 피드백: "과도한 직선 조금 지움")
            const stepH_L = Math.abs(bTopY - adjTopY);
            // ★ 트림은 보스↔보스 접합에만 적용 (보스↔축 접합은 구조적 경계이므로 트림 안함)
            const isBossJuncL = adjTypeL === 'boss' || adjTypeL === 'gear';
            const smallStep_L = isBossJuncL && stepH_L <= 4 * PX && stepH_L > 0.5;
            const trimL = smallStep_L ? stepH_L * 0.70 : 0;
            if (adjLargerL) {
              const st = DrawingModel.createOutline(bLeft, adjTopY + trimL, bLeft, bTopY, 1);
              st.confidence = conf; doc.elements.push(st);
              const sb = DrawingModel.createOutline(bLeft, bBotY, bLeft, adjBotY - trimL, 1);
              sb.confidence = conf; doc.elements.push(sb);
            } else {
              const st = DrawingModel.createOutline(bLeft, bTopY + trimL, bLeft, adjTopY, 1);
              st.confidence = conf; doc.elements.push(st);
              const sb = DrawingModel.createOutline(bLeft, adjBotY, bLeft, bBotY - trimL, 1);
              sb.confidence = conf; doc.elements.push(sb);
            }
          }
        }

        // 우측 단차 (bRight에서의 수직선)
        // skipStepRight: 인접 요소가 이미 이 쪽 단차를 처리함 (중복 방지)
        if (hasStepR && !skipStepRight) {
          const adjTopY = oy - adjacentRRight;
          const adjBotY = oy + adjacentRRight;

          if (applyRR) {
            if (adjLargerR) {
              // ── adjLargerR: 인접요소가 보스보다 큼 ──
              // 프로파일 (우측은 좌우 반전):
              //                ┌────── adjTopY
              //  x=bRight 단차 │
              //  corner ───────┘ bTopY     ← 90° 내부 코너
              //         ← boss
              //  corner ───────┐ bBotY     ← 90° 내부 코너
              //                │
              //                └────── adjBotY
              //
              // 상단(Right-Top): corner=(bRight, bTopY)
              //   노치 방향: 왼쪽 위
              //   center=(bRight-R, bTopY-R)
              //   start=(bRight-R, bTopY) [수평선 접점] → end=(bRight, bTopY-R) [수직선 접점]
              //   sweep=0 (CCW) → 오목(concave) 필렛

              // 상단 단차 수직선: adjTopY → (bTopY - R)
              const stepTopEnd = bTopY - rPx;
              if (stepTopEnd > adjTopY) {
                const st = DrawingModel.createOutline(bRight, adjTopY, bRight, stepTopEnd, 1);
                st.confidence = conf; doc.elements.push(st);
              }
              // 상단 필렛 원호
              const cx1 = bRight - rPx, cy1 = bTopY - rPx;
              const a1 = DrawingModel.createOutline(bRight - rPx, bTopY, bRight, bTopY - rPx, 1);
              a1.confidence = conf;
              a1._arc = { r: rPx, cx: cx1, cy: cy1, sweep: 0 };
              doc.elements.push(a1);

              // 하단(Right-Bottom): corner=(bRight, bBotY)
              //   노치 방향: 왼쪽 아래
              //   center=(bRight-R, bBotY+R)
              //   start=(bRight, bBotY+R) [수직선 접점] → end=(bRight-R, bBotY) [수평선 접점]
              //   sweep=0 (CCW) → 오목(concave) 필렛

              // 하단 단차 수직선: (bBotY + R) → adjBotY
              const stepBotStart = bBotY + rPx;
              if (adjBotY > stepBotStart) {
                const sb = DrawingModel.createOutline(bRight, stepBotStart, bRight, adjBotY, 1);
                sb.confidence = conf; doc.elements.push(sb);
              }
              // 하단 필렛 원호
              const cx2 = bRight - rPx, cy2 = bBotY + rPx;
              const a2 = DrawingModel.createOutline(bRight, bBotY + rPx, bRight - rPx, bBotY, 1);
              a2.confidence = conf;
              a2._arc = { r: rPx, cx: cx2, cy: cy2, sweep: 0 };
              doc.elements.push(a2);
            } else {
              // ── bossLargerR: 보스가 인접요소보다 큼 ──
              // 프로파일:
              //  boss top ──────────┐ bTopY
              //   x=bRight 단차      │
              //                ─────┘ adjTopY   corner=(bRight, adjTopY)
              //                 adj →
              //                ─────┐ adjBotY   corner=(bRight, adjBotY)
              //                      │
              //  boss bot ──────────┘ bBotY
              //
              // 상단(Right-Top): corner=(bRight, adjTopY)
              //   노치 방향: 오른쪽 위 (adj 쪽 빈 공간)
              //   center=(bRight+R, adjTopY-R)
              //   start=(bRight, adjTopY-R) [수직선 접점] → end=(bRight+R, adjTopY) [수평선 접점]
              //   sweep=1 (CW) → 오목(concave) 필렛 (bossLarger는 코너 방향이 반대이므로 sweep=1)

              // 상단 단차 수직선: bTopY → (adjTopY - R)
              const stepTopEnd = adjTopY - rPx;
              if (stepTopEnd > bTopY) {
                const st = DrawingModel.createOutline(bRight, bTopY, bRight, stepTopEnd, 1);
                st.confidence = conf; doc.elements.push(st);
              }
              // 상단 필렛 원호
              const cx1 = bRight + rPx, cy1 = adjTopY - rPx;
              const a1 = DrawingModel.createOutline(bRight, adjTopY - rPx, bRight + rPx, adjTopY, 1);
              a1.confidence = conf;
              a1._arc = { r: rPx, cx: cx1, cy: cy1, sweep: 1 };
              doc.elements.push(a1);

              // 하단(Right-Bottom): corner=(bRight, adjBotY)
              //   노치 방향: 오른쪽 아래
              //   center=(bRight+R, adjBotY+R)
              //   start=(bRight+R, adjBotY) [수평선 접점] → end=(bRight, adjBotY+R) [수직선 접점]
              //   sweep=1 (CW) → 오목(concave) 필렛 (bossLarger는 코너 방향이 반대이므로 sweep=1)

              // 하단 단차 수직선: (adjBotY + R) → bBotY
              const stepBotStart = adjBotY + rPx;
              if (bBotY > stepBotStart) {
                const sb = DrawingModel.createOutline(bRight, stepBotStart, bRight, bBotY, 1);
                sb.confidence = conf; doc.elements.push(sb);
              }
              // 하단 필렛 원호
              const cx2 = bRight + rPx, cy2 = adjBotY + rPx;
              const a2 = DrawingModel.createOutline(bRight + rPx, adjBotY, bRight, adjBotY + rPx, 1);
              a2.confidence = conf;
              a2._arc = { r: rPx, cx: cx2, cy: cy2, sweep: 1 };
              doc.elements.push(a2);
            }
          } else {
            // R값 미적용: 단차 수직선
            // ★ 단차 수직선 — 직경 차이가 작을 때(≤4mm) 단축하여 간략 표현
            const stepH_R = Math.abs(bTopY - adjTopY);
            // ★ 트림은 보스↔보스 접합에만 적용 (보스↔축 접합은 구조적 경계이므로 트림 안함)
            const isBossJuncR = adjTypeR === 'boss' || adjTypeR === 'gear';
            const smallStep_R = isBossJuncR && stepH_R <= 4 * PX && stepH_R > 0.5;
            const trimR = smallStep_R ? stepH_R * 0.70 : 0;
            if (adjLargerR) {
              const st = DrawingModel.createOutline(bRight, adjTopY + trimR, bRight, bTopY, 1);
              st.confidence = conf; doc.elements.push(st);
              const sb = DrawingModel.createOutline(bRight, bBotY, bRight, adjBotY - trimR, 1);
              sb.confidence = conf; doc.elements.push(sb);
            } else {
              const st = DrawingModel.createOutline(bRight, bTopY + trimR, bRight, adjTopY, 1);
              st.confidence = conf; doc.elements.push(st);
              const sb = DrawingModel.createOutline(bRight, adjBotY, bRight, bBotY - trimR, 1);
              sb.confidence = conf; doc.elements.push(sb);
            }
          }
        }

        // ── 보스 자체의 좌·우 수직선 ──
        // 1) 단차가 없는 경우: 보스 수직선 = 보스 사각형의 좌/우 변 (bTopY~bBotY)
        // 2) 단차가 있고 이 보스가 처리하는 경우: 단차 수직선이 에지 역할 → 별도 불필요
        // 3) 단차가 있지만 skipStep인 경우: 인접 보스가 단차(계단)를 처리하지만,
        //    이 보스 자체의 외곽선(bTopY~bBotY)은 여전히 필요 → 그려야 함
        if (!hasStepL || skipStepLeft) {
          const vlL = DrawingModel.createOutline(bLeft, bTopY, bLeft, bBotY, 1);
          vlL.confidence = conf; doc.elements.push(vlL);
        }
        if (!hasStepR || skipStepRight) {
          const vlR = DrawingModel.createOutline(bRight, bTopY, bRight, bBotY, 1);
          vlR.confidence = conf; doc.elements.push(vlR);
        }
      }

      // ★ N개 보스 렌더링 — 일반화된 루프
      // 보스 순서: boss[0](=boss1)이 스프라켓에 가장 가까움, boss[N-1]이 축/구간에 가장 가까움
      // 배치 방향:
      //   bossesGoRight=true  → [기어]─[boss1]─[boss2]─...─[bossN]─[축/구간] (좌→우)
      //   bossesGoRight=false → [축/구간]─[bossN]─...─[boss2]─[boss1]─[기어] (좌→우)
      const secLeftR = sec.r;
      const secRightR = isBetween ? secRight.r : secR;

      // 보스가 기어 오른쪽에 놓이는가?
      let bossesGoRight;
      if (isBetween) {
        bossesGoRight = (side === 'right'); // bossDirection='right' → 기어 오른쪽에 보스
      } else {
        bossesGoRight = (side === 'left');  // edge left → [기어]─[boss]─[축] (보스가 오른쪽)
      }

      // 축/구간 끝 반지름 (보스 체인의 끝에 인접하는 요소)
      const endSecR = bossesGoRight
        ? (isBetween ? secRightR : secR)
        : (isBetween ? secLeftR : secR);

      // 각 보스를 순서대로 렌더 (boss[0]=기어 인접, boss[N-1]=축 인접)
      if (bossList.length > 0) {
        const N = bossList.length;
        for (let bi = 0; bi < N; bi++) {
          const bd = bossList[bi];
          if (!bd || bd.outerDiam <= 0 || bd.thickness <= 0) continue;
          const thisPx = bossThickPx[bi];
          const thisR = bossRadiusPx[bi];

          // 인접 요소 반지름 결정
          // 기어쪽 인접 (bi=0이면 기어 본체=이뿌리 반지름, 아니면 이전 보스)
          // ★ 기어 본체 반지름 = gearOuterR - gToothH (이뿌리까지)
          //   외경(gearOuterR)이 아닌 본체(rootY)까지만 보스 단차를 그려야
          //   사다리꼴 영역에 불필요한 직선이 생기지 않음
          const gearBodyR = gearOuterR - gToothH;
          const adjGearSide = (bi === 0) ? gearBodyR : (bossRadiusPx[bi - 1] || gearBodyR);
          // 축쪽 인접 (bi=N-1이면 축/구간, 아니면 다음 보스)
          const adjSecSide = (bi === N - 1) ? endSecR : (bossRadiusPx[bi + 1] || endSecR);

          // 인접 요소 타입
          const adjTypeGear = (bi === 0) ? 'gear' : 'boss';
          const adjTypeSec = (bi === N - 1) ? 'section' : 'boss';

          // X 위치 계산 (누적 offset)
          let bx;
          if (bossesGoRight) {
            // [기어]─[boss0]─[boss1]─...  보스가 기어 오른쪽
            let offset = 0;
            for (let j = 0; j < bi; j++) offset += bossThickPx[j];
            bx = gRight + offset;
          } else {
            // ...─[boss1]─[boss0]─[기어]  보스가 기어 왼쪽
            let offset = 0;
            for (let j = 0; j <= bi; j++) offset += bossThickPx[j];
            bx = gLeft - offset;
          }

          // R값 skip 판정 — 인접 보스 간 중복 단차 방지
          // ★ v134 수정: skip은 인접 보스가 해당 경계의 R필렛을 이미 렌더링할 때만 적용
          //   이전 코드는 자기 자신의 R(hasRLeft/hasRRight)도 skip 조건에 포함시켜서
          //   자기가 그려야 할 R값 필렛까지 건너뛰는 버그 발생
          let skipL = false, skipR = false;
          if (bossesGoRight) {
            // adjL = 기어쪽, adjR = 축쪽
            // 보스↔보스 경계: 이전 보스의 오른쪽 R이 이 경계를 처리하면 이 보스 왼쪽 skip
            if (bi > 0) {
              const prevBd = bossList[bi - 1];
              const prevHasR = prevBd?.fillet?.value > 0 && (prevBd.fillet.side === 'both' || prevBd.fillet.side === 'right');
              if (prevHasR) skipL = true;
            }
            // 다음 보스의 왼쪽 R이 이 경계를 처리하면 이 보스 오른쪽 skip
            if (bi < N - 1) {
              const nextBd = bossList[bi + 1];
              const nextHasR = nextBd?.fillet?.value > 0 && (nextBd.fillet.side === 'both' || nextBd.fillet.side === 'left');
              if (nextHasR) skipR = true;
            }
            renderBoss(bd, bx, thisPx, adjGearSide, adjSecSide, cg.confidence, skipL, skipR, adjTypeGear, adjTypeSec);
          } else {
            // adjL = 축쪽, adjR = 기어쪽 (왼쪽 방향이므로 좌우 반전)
            if (bi > 0) {
              const prevBd = bossList[bi - 1];
              const prevHasR = prevBd?.fillet?.value > 0 && (prevBd.fillet.side === 'both' || prevBd.fillet.side === 'left');
              if (prevHasR) skipR = true;
            }
            if (bi < N - 1) {
              const nextBd = bossList[bi + 1];
              const nextHasR = nextBd?.fillet?.value > 0 && (nextBd.fillet.side === 'both' || nextBd.fillet.side === 'right');
              if (nextHasR) skipL = true;
            }
            renderBoss(bd, bx, thisPx, adjSecSide, adjGearSide, cg.confidence, skipL, skipR, adjTypeSec, adjTypeGear);
          }
        }
      }

      // ── 기어 치수 지시선 ──
      // ★ 보스가 모두 축쪽에 있으므로 fullLeft/Right 재계산
      let fullLeftX, fullRightX;
      if (isBetween) {
        if (side === 'left') {
          // bossDirection='left': [boss]─[기어]
          fullLeftX = gLeft - totalBossThick;
          fullRightX = gRight;
        } else {
          // bossDirection='right': [기어]─[boss]
          fullLeftX = gLeft;
          fullRightX = gRight + totalBossThick;
        }
      } else {
        fullLeftX = (side === 'left') ? gLeft : gLeft - totalBossThick;
        fullRightX = (side === 'left') ? gRight + totalBossThick : gRight;
      }
      const cgMidX = (fullLeftX + fullRightX) / 2;
      const cgElbowX = cgMidX + (isBetween ? 0 : (side === 'left' ? -30 : 30));
      const cgElbowY = gBotY + 15;
      const cgArrowX = cgMidX;
      const cgArrowY = gBotY;
      const cgLeader1 = DrawingModel.createOutline(cgElbowX, cgElbowY, cgArrowX, cgArrowY, 0.8);
      cgLeader1.confidence = CONF.CONFIRMED;
      cgLeader1.color = '#60a5fa';
      cgLeader1._leaderLine = true;
      cgLeader1._leaderArrow = true;
      doc.elements.push(cgLeader1);

      const cgLabel = `${cg.chainSpec} × PT${cg.teeth}`;
      const cgTextW = cgLabel.length * 3.25;
      const cgLeaderEnd = (side === 'left') ? cgElbowX - cgTextW - 3 : cgElbowX + cgTextW + 3;
      const cgLeader2 = DrawingModel.createOutline(cgElbowX, cgElbowY, cgLeaderEnd, cgElbowY, 0.8);
      cgLeader2.confidence = CONF.CONFIRMED;
      cgLeader2.color = '#60a5fa';
      cgLeader2._leaderLine = true;
      doc.elements.push(cgLeader2);

      const cgTextX = (side === 'left') ? cgLeaderEnd + 2 : cgElbowX + 2;
      const cgText = DrawingModel.createText(cgTextX, cgElbowY - 2, cgLabel, 5);
      cgText.confidence = CONF.CONFIRMED;
      doc.elements.push(cgText);

      // ── 2) 보조투상도: 톱니 형상 ──
      // ★ auxView 플래그로 보조투상도 생성 여부 결정 (기본값: edge이면 true, between이면 false)
      const drawAuxView = (cg.auxView !== undefined) ? cg.auxView : !isBetween;
      if (drawAuxView) {
      // 규칙: 외경(이끝원) = 등분점(dot)만 표시, 원 자체 삭제
      //        이뿌리원 = 실선 원, 보어원 = 실선 원
      const pitch = RS_PITCH_MAP[cg.chainSpec] || 9.525;
      const toothHeight = pitch * 0.2;
      const auxOuterR = (cg.outerDiam / 2) * PX;
      const auxRootR = auxOuterR - toothHeight * PX;

      let auxCx;
      if (side === 'left') {
        auxCx = fullLeftX - 50 - auxOuterR;
      } else {
        auxCx = fullRightX + 50 + auxOuterR;
      }
      const auxCy = oy;

      // ★ 이뿌리원(root circle)은 별도로 그리지 않음
      // → 톱니 사이의 root arc가 이뿌리원 경계를 형성

      // ★ 이끝원(외경, addendum circle) — 풀 원이 아닌 톱니 사이 등분점 arc만 표시
      //   외경원은 오로지 기어 이빨 갯수만큼 등분점을 표시하기 위해 존재
      //   → 톱니 tip 사이 구간(이빨이 없는 구간)에만 arc로 그림
      //   (풀 원 제거, 톱니 tip이 외경에 닿는 점 사이의 arc만 표시)

      // 보어 원
      if (cg.boreDiam > 0) {
        const auxBoreR = (cg.boreDiam / 2) * PX;
        const boreCircle = DrawingModel.createHole(auxCx, auxCy, auxBoreR * 2);
        boreCircle.color = '#000000';
        boreCircle.holeType = 'through';
        boreCircle.confidence = CONF.CONFIRMED;
        boreCircle._auxViewId = `AUX_CG${cgIdx}`;
        doc.elements.push(boreCircle);
      }

      // ★ 톱니 형상: 사다리꼴(trapezoid) 윤곽선으로 표현 (내부 채우기 없음)
      // 규칙: 각 톱니는 4변의 사다리꼴 — 이뿌리(root)쪽이 넓고 이끝(tip)쪽이 좁음
      //        이끝원(외경)은 별도로 그리지 않음 → 톱니 tip이 곧 외경 경계
      const nTeeth = cg.teeth || 9;
      const angleStep = (2 * Math.PI) / nTeeth;
      for (let t = 0; t < nTeeth; t++) {
        const angle = angleStep * t - Math.PI / 2; // 12시부터

        // 사다리꼴 톱니: tip(좁은쪽)은 외경, root(넓은쪽)은 이뿌리원
        // tip 폭 = 0.25 * step (각도), root 폭 = 0.45 * step (각도)
        const tipHalf = angleStep * 0.125;  // tip 중심에서 좌우 각각
        const rootHalf = angleStep * 0.225; // root 중심에서 좌우 각각

        // 4개 꼭짓점 (시계 방향: root좌 → tip좌 → tip우 → root우)
        const rootAngleL = angle - rootHalf;
        const rootAngleR = angle + rootHalf;
        const tipAngleL = angle - tipHalf;
        const tipAngleR = angle + tipHalf;

        const rx1 = auxCx + auxRootR * Math.cos(rootAngleL);
        const ry1 = auxCy + auxRootR * Math.sin(rootAngleL);
        const tx1 = auxCx + auxOuterR * Math.cos(tipAngleL);
        const ty1 = auxCy + auxOuterR * Math.sin(tipAngleL);
        const tx2 = auxCx + auxOuterR * Math.cos(tipAngleR);
        const ty2 = auxCy + auxOuterR * Math.sin(tipAngleR);
        const rx2 = auxCx + auxRootR * Math.cos(rootAngleR);
        const ry2 = auxCy + auxRootR * Math.sin(rootAngleR);

        // 사다리꼴 4변
        // 1) 좌측 측면: root좌 → tip좌
        const l1 = DrawingModel.createOutline(rx1, ry1, tx1, ty1, 0.8);
        l1.confidence = CONF.CONFIRMED; l1._auxViewId = `AUX_CG${cgIdx}`; doc.elements.push(l1);
        // 2) 상단(tip): tip좌 → tip우 — 외경 원호로 표현
        //    ★ 톱니 tip은 외경원 위에 있으므로 arc로 연결 (등분점 역할)
        const tipArc = DrawingModel.createOutline(tx1, ty1, tx2, ty2, 0.8);
        tipArc.confidence = CONF.CONFIRMED; tipArc._auxViewId = `AUX_CG${cgIdx}`;
        tipArc._arc = { r: auxOuterR, cx: auxCx, cy: auxCy };
        doc.elements.push(tipArc);
        // 3) 우측 측면: tip우 → root우
        const l3 = DrawingModel.createOutline(tx2, ty2, rx2, ry2, 0.8);
        l3.confidence = CONF.CONFIRMED; l3._auxViewId = `AUX_CG${cgIdx}`; doc.elements.push(l3);
        // 4) 하단(root): root우 → 다음 톱니 root좌 (이뿌리 원호)
        const nextAngle = angleStep * (t + 1) - Math.PI / 2;
        const nextRootAngleL = nextAngle - rootHalf;
        const nrx1 = auxCx + auxRootR * Math.cos(nextRootAngleL);
        const nry1 = auxCy + auxRootR * Math.sin(nextRootAngleL);
        const rootArc = DrawingModel.createOutline(rx2, ry2, nrx1, nry1, 0.6);
        rootArc.confidence = CONF.CONFIRMED; rootArc._auxViewId = `AUX_CG${cgIdx}`;
        rootArc._arc = { r: auxRootR, cx: auxCx, cy: auxCy };
        doc.elements.push(rootArc);
        // 5) 이빨 사이 외경 arc: 삭제
        //    ★ 사용자 요청: 외경원(Ø31)은 등분점 표시용이므로
        //      이빨 사이의 외경 원호(gapArc)는 그리지 않음.
        //      이빨 tip 원호(tipArc)만 유지하여 등분점 역할을 함.
      }

      // 십자 중심선
      const clM = auxOuterR + 10;
      const clH = DrawingModel.createCenterline(auxCx - clM, auxCy, auxCx + clM, auxCy);
      clH.confidence = CONF.CONFIRMED; clH._auxViewId = `AUX_CG${cgIdx}`; doc.elements.push(clH);
      const clV = DrawingModel.createCenterline(auxCx, auxCy - clM, auxCx, auxCy + clM);
      clV.confidence = CONF.CONFIRMED; clV._auxViewId = `AUX_CG${cgIdx}`; doc.elements.push(clV);

      // 키홈 표시 (보조투상도 내)
      if (cg.key && cg.key.width > 0) {
        const keyW = cg.key.width * PX;
        const keyD = (cg.key.depth || 3) * PX;
        const auxBoreR2 = (cg.boreDiam / 2) * PX;
        const keyLeft2 = auxCx - keyW / 2;
        const keyRight2 = auxCx + keyW / 2;
        const keyTop2 = auxCy - auxBoreR2 - keyD;
        const keyBot2 = auxCy - auxBoreR2;
        const keyL1 = DrawingModel.createOutline(keyLeft2, keyTop2, keyLeft2, keyBot2, 0.8);
        keyL1.confidence = CONF.CONFIRMED; keyL1._auxViewId = `AUX_CG${cgIdx}`; doc.elements.push(keyL1);
        const keyL2 = DrawingModel.createOutline(keyLeft2, keyTop2, keyRight2, keyTop2, 0.8);
        keyL2.confidence = CONF.CONFIRMED; keyL2._auxViewId = `AUX_CG${cgIdx}`; doc.elements.push(keyL2);
        const keyL3 = DrawingModel.createOutline(keyRight2, keyTop2, keyRight2, keyBot2, 0.8);
        keyL3.confidence = CONF.CONFIRMED; keyL3._auxViewId = `AUX_CG${cgIdx}`; doc.elements.push(keyL3);
      }

      // 연결선 (정면도 → 보조투상도)
      const connStartX = (side === 'left') ? fullLeftX : fullRightX;
      const connEndX = (side === 'left') ? auxCx + auxOuterR + 5 : auxCx - auxOuterR - 5;
      const connLine = DrawingModel.createOutline(connStartX, oy, connEndX, oy, 0.5);
      connLine.confidence = CONF.CONFIRMED;
      connLine._auxViewId = `AUX_CG${cgIdx}`;
      connLine.color = '#666666';
      doc.elements.push(connLine);

      // 보조투상도 라벨
      const auxLabel = `${cg.chainSpec} PT${cg.teeth} Ø${cg.outerDiam}`;
      const auxLabelX = auxCx - auxLabel.length * 1.5;
      const auxLabelY = auxCy + auxOuterR + 15;
      const auxText = DrawingModel.createText(auxLabelX, auxLabelY, auxLabel, 5);
      auxText.confidence = CONF.CONFIRMED;
      auxText._auxViewId = `AUX_CG${cgIdx}`;
      doc.elements.push(auxText);

      } // end if (drawAuxView) — 보조투상도 체크박스에 의한 조건

      console.log(`[AI-Engine] CHAIN GEAR ${cg.id}: ${cg.chainSpec} PT${cg.teeth}, outerDiam=${cg.outerDiam}, placement=${isBetween ? 'between' : 'edge'}, side=${side}, bosses=${bossList.length}, rendered at gearX=${gearX.toFixed(1)}`);
    });

    // ──── 9.5. 기하공차 + 데이텀 (GD&T) — 데모용 자동 생성 ────
    //
    // spec에 geometricTolerances / datums 배열이 있으면 렌더링
    // 없으면 생략 (사용자가 편집기에서 직접 추가 가능)
    //
    if (spec.geometricTolerances && spec.geometricTolerances.length > 0) {
      spec.geometricTolerances.forEach(gt => {
        // 부착 대상 section 찾기
        const targetSec = sections.find(s => s.id === gt.section);
        if (!targetSec) return;

        let gdtX, gdtY, leaderX, leaderY, leaderSide;
        const secMidX = targetSec.x + targetSec.w / 2;

        // ★ v32: 치수선에 수평으로 지시선을 연결해서 공차값을 표시
        //   모든 면에서 공차 박스를 우측에 배치하고 수평 지시선으로 연결
        if (gt.face === 'top') {
          // 상단면 → 면의 우측 끝에서 수평으로 공차 박스 연결
          const faceY = oy - targetSec.r;
          gdtX = targetSec.x + targetSec.w + 12;
          gdtY = faceY - 4;
          leaderX = targetSec.x + targetSec.w;
          leaderY = faceY;
          leaderSide = 'left';  // 박스 좌측에서 수평 연결
        } else if (gt.face === 'left') {
          // 좌측면 → 좌측으로 수평 연결
          gdtX = targetSec.x - 48;
          gdtY = oy - 4;
          leaderX = targetSec.x;
          leaderY = oy;
          leaderSide = 'right';
        } else if (gt.face === 'right') {
          // 우측면 → 우측으로 수평 연결
          gdtX = targetSec.x + targetSec.w + 12;
          gdtY = oy - 4;
          leaderX = targetSec.x + targetSec.w;
          leaderY = oy;
          leaderSide = 'left';
        } else {
          // 하단면 → 면의 우측 끝에서 수평으로 공차 박스 연결
          const faceY = oy + targetSec.r;
          gdtX = targetSec.x + targetSec.w + 12;
          gdtY = faceY - 4;
          leaderX = targetSec.x + targetSec.w;
          leaderY = faceY;
          leaderSide = 'left';  // 박스 좌측에서 수평 연결
        }

        const gdt = DrawingModel.createGeometricTolerance(
          gdtX, gdtY,
          gt.symbolType || 'perpendicularity',
          gt.value || '0.01',
          gt.datum || null,
          null, // attachTo — 생성 시 자동 연결하지 않음 (좌표 기반)
          {
            leaderSide,
            stacked: gt.stacked || [],
            confidence: CONF.CONFIRMED,
          }
        );
        gdt._leaderX = leaderX;
        gdt._leaderY = leaderY;
        gdt.confidence = CONF.CONFIRMED;
        doc.elements.push(gdt);
      });
    }

    // ★ v41-fix: 데이텀 기호를 부품 외형선(조립체 포함) 바깥으로 표시
    //
    //   원칙: 삼각형 밑변은 해당 면에 닿고, 기호(꼭짓점→줄기→글자상자)는
    //         부품 본체 반대쪽(바깥)으로 뻗어야 한다.
    //
    //   renderer.js side 의미:
    //     side='left'  → dir=-1 → 기호가 왼쪽으로 연장
    //     side='right' → dir=+1 → 기호가 오른쪽으로 연장
    //     side='top'   → dir=-1 → 기호가 위로 연장
    //     side='bottom'→ dir=+1 → 기호가 아래로 연장
    //
    //   face='left'  → 기호를 왼쪽(left)으로: 본체 반대쪽
    //   face='right' → 기호를 오른쪽(right)으로: 본체 반대쪽
    //   face='top'   → 기호를 위(top)로: 본체 반대쪽
    //   face='bottom'→ 기호를 아래(bottom)로: 본체 반대쪽
    //
    //   ★ 핵심 수정: face='left'/'right'일 때 datX를 section 경계가 아니라
    //     체인스프라켓/보스 등 부속물을 포함한 전체 조립체의 최외곽 X로 설정.
    //     이렇게 해야 삼각형 밑변이 조립체 외형선에 닿고
    //     기호가 외형선 바깥으로 뻗는다.
    //
    if (spec.datums && spec.datums.length > 0) {
      // ── 체인스프라켓 정보로 각 section의 최외곽 X 범위 계산 ──
      const cgExtents = {};  // sectionId → { leftmost, rightmost }
      (spec.chainGears || []).forEach(cg => {
        const isBetween = cg.placement === 'between';
        let sec, cgSide;
        if (isBetween) {
          // between 체인스프라켓는 section 양쪽 끝을 넘지 않으므로 무시
          return;
        }
        sec = sections.find(s => s.id === cg.section);
        if (!sec) return;
        cgSide = cg.side; // 'left' or 'right'

        const cgGearWidthPx = (cg.gearWidth || 8) * PX;
        const cgBossList = [];
        if (cg.boss) {
          const bCount = cg.boss.count || 1;
          if (cg.boss.bosses && cg.boss.bosses.length > 0) {
            for (let b = 0; b < bCount; b++) cgBossList.push(cg.boss.bosses[b] || cg.boss.bosses[0]);
          } else {
            for (let b = 0; b < bCount; b++) cgBossList.push({ thickness: cg.boss.thickness || 0 });
          }
        }
        const cgTotalBoss = cgBossList.reduce((s, b) => s + (b.thickness > 0 ? b.thickness * PX : 0), 0);

        if (cgSide === 'left') {
          // [기어]─[boss]─[축S1] → 최좌단 = sec.x - gearWidth - totalBoss
          const leftmost = sec.x - cgGearWidthPx - cgTotalBoss;
          if (!cgExtents[sec.id]) cgExtents[sec.id] = { leftmost: sec.x, rightmost: sec.x + sec.w };
          cgExtents[sec.id].leftmost = Math.min(cgExtents[sec.id].leftmost, leftmost);
        } else {
          // [축SN]─[boss]─[기어] → 최우단 = sec.x + sec.w + totalBoss + gearWidth
          const rightmost = sec.x + sec.w + cgTotalBoss + cgGearWidthPx;
          if (!cgExtents[sec.id]) cgExtents[sec.id] = { leftmost: sec.x, rightmost: sec.x + sec.w };
          cgExtents[sec.id].rightmost = Math.max(cgExtents[sec.id].rightmost, rightmost);
        }
      });

      spec.datums.forEach(dt => {
        const targetSec = sections.find(s => s.id === dt.section);
        if (!targetSec) return;

        const ext = cgExtents[targetSec.id] || null;
        let datX, datY, datSide;

        if (dt.face === 'left') {
          // 기호를 왼쪽으로 (부품 바깥)
          // datX = 조립체 최좌단 (체인스프라켓 포함)
          datX = ext ? ext.leftmost : targetSec.x;
          datY = oy;
          datSide = 'left';
        } else if (dt.face === 'right') {
          // 기호를 오른쪽으로 (부품 바깥)
          // datX = 조립체 최우단 (체인스프라켓 포함)
          datX = ext ? ext.rightmost : (targetSec.x + targetSec.w);
          datY = oy;
          datSide = 'right';
        } else if (dt.face === 'top') {
          datX = targetSec.x + targetSec.w / 2;
          datY = oy - targetSec.r;
          datSide = 'top';    // 기호를 위로 (부품 바깥)
        } else {
          datX = targetSec.x + targetSec.w / 2;
          datY = oy + targetSec.r;
          datSide = 'bottom'; // 기호를 아래로 (부품 바깥)
        }

        const dat = DrawingModel.createDatum(datX, datY, dt.letter || 'A', null, datSide);
        dat.confidence = CONF.CONFIRMED;
        doc.elements.push(dat);
      });
    }

    // ──── 10. Self-check 결과 — v8: 캔버스에 텍스트 대신 doc._selfCheck에 저장 ────
    // (이전: SVG 텍스트로 도면 위에 직접 표시 → 표제란 침범 문제)
    // (현재: app.js에서 좌측 하단 플로팅 패널로 표시)

    // ── 메타데이터 저장 ──
    doc._selfCheck = selfResult;
    doc._spec = spec;

    // ── 디버그: confidence + placeholder 통계 ──
    const confCount = { confirmed: 0, estimated: 0, uncertain: 0, placeholder: 0 };
    doc.elements.forEach(el => {
      const c = el.confidence;
      if (c === CONF.CONFIRMED) confCount.confirmed++;
      else if (c === CONF.ESTIMATED) confCount.estimated++;
      else if (c === CONF.UNCERTAIN) confCount.uncertain++;
      if (el._isPlaceholder) confCount.placeholder++;
    });
    console.log('[AIEngine] ═══ v5 Output Summary ═══');
    console.log(`  confirmed   : ${confCount.confirmed}`);
    console.log(`  estimated   : ${confCount.estimated}`);
    console.log(`  uncertain   : ${confCount.uncertain}`);
    console.log(`  placeholder : ${confCount.placeholder}`);
    console.log(`  total       : ${doc.elements.length}`);
    console.log(`  geometry fidelity: ${selfResult.geometryFidelity}%`);
    console.log('[AIEngine] Self-check:', selfResult);

    return doc;
  }


  // ============================================================
  // ★ Stage 2-B: Vision AI 기반 실제 이미지 분석
  //
  // 업로드된 손도면 이미지를 서버의 /api/analyze 엔드포인트로
  // 전송하여 GPT Vision API로 형상을 추출한다.
  //
  // 반환값은 extractConfirmedSignals()와 동일한 signals 형식
  // ============================================================

  async function extractSignalsFromImage(file) {
    console.log('[AIEngine:Stage2-Vision] Sending image to Vision API...');

    const formData = new FormData();
    formData.append('image', file);

    const _sid = localStorage.getItem('ad_session') || '';
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'X-Session-Id': _sid },
      body: formData,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`Vision API error: ${response.status} — ${errData.error || 'Unknown'}`);
    }

    const data = await response.json();
    if (!data.success || !data.signals) {
      throw new Error('Vision API returned invalid data');
    }

    console.log('[AIEngine:Stage2-Vision] Received signals:', JSON.stringify(data.signals, null, 2));
    console.log(`[AIEngine:Stage2-Vision] ${data.sectionCount} sections, totalLength=${data.totalLength}`);

    return data.signals;
  }


  // ============================================================
  // AI 분석 메인 (5단계 파이프라인)
  //
  // v6: 실제 이미지 분석 지원
  //   - 업로드된 이미지 → Vision API → 실제 형상 추출
  //   - Demo 모드는 기존 hardcoded signals 사용
  // ============================================================

  async function analyzeImage(file) {
    // Stage 1
    const classification = classifyDrawingType(file);
    console.log(`[AIEngine:Stage1] Classification:`, classification);

    // ── UI 진행 표시: Stage 1 (이미지 전처리) ──
    updateAIStep(1, 'active');
    await delay(500);
    updateAIStep(1, 'done');
    const fillEl = document.getElementById('aiProgressFill');
    if (fillEl) fillEl.style.width = '20%';

    // ── Stage 2: 이미지 분석 + 사용자 입력 ──
    updateAIStep(2, 'active');
    let signals;
    try {
      // v6: ImageAnalyzer 사용 — 이미지 기본 분석 + 사용자 파라미터 입력
      signals = await ImageAnalyzer.analyze(file);
      console.log('[AIEngine] ImageAnalyzer succeeded:', JSON.stringify(signals, null, 2));
    } catch (analyzerError) {
      // 사용자가 취소한 경우 — 상위로 전파 (app.js에서 step 1으로 돌아감)
      if (analyzerError.message.includes('취소')) {
        throw analyzerError;
      }
      console.warn('[AIEngine] ImageAnalyzer failed:', analyzerError.message);
      // 기타 오류: 기존 hardcoded signals (데모용 fallback)
      signals = extractConfirmedSignals(classification);
    }
    updateAIStep(2, 'done');
    if (fillEl) fillEl.style.width = '40%';

    // ── Stage 3: 후보 생성 ──
    updateAIStep(3, 'active');
    await delay(300);
    updateAIStep(3, 'done');
    if (fillEl) fillEl.style.width = '60%';

    // ── Stage 4: Spec 정리 ──
    updateAIStep(4, 'active');
    await delay(300);
    updateAIStep(4, 'done');
    if (fillEl) fillEl.style.width = '80%';

    // ── Stage 5: Self-check ──
    updateAIStep(5, 'active');
    await delay(200);
    updateAIStep(5, 'done');
    if (fillEl) fillEl.style.width = '100%';

    // shaft 여부: > 0.3이면 shaft 파이프라인
    if (signals.shaftLikelihood && signals.shaftLikelihood.value > 0.3) {
      // Stage 3
      const srInSignals = (signals.hiddenFeatures || []).filter(h => h.type === 'snapring');
      console.log(`[AIEngine] ★ signals.hiddenFeatures snapring count: ${srInSignals.length}`, srInSignals);
      const candidates = buildShaftCandidates(signals);
      const srInCandidates = (candidates.geometry.hiddenFeatures || []).filter(h => h.type === 'snapring');
      console.log(`[AIEngine] ★ candidates.hiddenFeatures snapring count: ${srInCandidates.length}`, srInCandidates);
      // Stage 4
      const spec = resolveSpecFromCandidates(candidates);
      const srInSpec = (spec.geometrySpec.hiddenFeatures || []).filter(h => h.type === 'snapring');
      console.log(`[AIEngine] ★ spec.hiddenFeatures snapring count: ${srInSpec.length}`, srInSpec);
      // Stage 5 + 렌더링
      return generateFromSpec(spec);
    }

    // shaft가 아닌 경우에도 최소한 읽힌 정보는 활용
    return generatePartialFallback(signals);
  }

  function getAnalysisSteps() {
    return [
      { step: 1, delay: 700,  label: '이미지 전처리 및 노이즈 제거' },
      { step: 2, delay: 1000, label: 'Vision AI 형상 분석 (서버 전송)' },
      { step: 3, delay: 1100, label: '형상 배치 분석 + 단차/구멍 위치' },
      { step: 4, delay: 900,  label: '형상 초안 생성 + placeholder 배치' },
      { step: 5, delay: 600,  label: 'self-check (형상 일치율 검증)' },
    ];
  }


  // ============================================================
  // Partial fallback (shaft가 아닌 unknown — 형상 초안)
  // ============================================================

  function generatePartialFallback(signals) {
    const doc = DrawingModel.createUnknownDocument();
    doc.meta.title = 'AI 분석 — 형상 초안';
    doc.meta._reviewRequired = true;

    const ox = 100, oy = 250;

    const cl = DrawingModel.createCenterline(ox - 20, oy, ox + 400, oy);
    cl.confidence = CONF.ESTIMATED;
    doc.elements.push(cl);

    const totalLen = signals.totalLength?.value;
    const PX = 2;
    const w = totalLen ? totalLen * PX : 300;

    const h = 60;
    [
      DrawingModel.createOutline(ox, oy - h/2, ox + w, oy - h/2, 1),
      DrawingModel.createOutline(ox, oy + h/2, ox + w, oy + h/2, 1),
      DrawingModel.createOutline(ox, oy - h/2, ox, oy + h/2, 1),
      DrawingModel.createOutline(ox + w, oy - h/2, ox + w, oy + h/2, 1),
    ].forEach(el => {
      el.confidence = CONF.ESTIMATED;
      doc.elements.push(el);
    });

    if (totalLen) {
      const dim = DrawingModel.createDimension(ox, oy - h/2, ox + w, oy - h/2,
        String(totalLen), 'mm', 25);
      dim.confidence = signals.totalLength.confidence;
      doc.elements.push(dim);
    } else {
      const dim = DrawingModel.createDimension(ox, oy - h/2, ox + w, oy - h/2, '?', 'mm', 25);
      dim.confidence = CONF.UNCERTAIN;
      dim._isPlaceholder = true;
      doc.elements.push(dim);
    }

    const dDim = DrawingModel.createDiameterDimension(ox + w, oy - h/2, ox + w, oy + h/2, '?', 'mm', -35);
    dDim.confidence = CONF.UNCERTAIN;
    dDim._isPlaceholder = true;
    doc.elements.push(dDim);

    const texts = [
      { txt: '📐 형상 초안 — 메타정보는 직접 입력하세요', fs: 12 },
      { txt: '점선 요소는 추정(estimated) — 더블클릭으로 수정', fs: 11 },
      { txt: '_______ 표시는 placeholder — 더블클릭하여 값 입력', fs: 11 },
    ];
    texts.forEach((t, i) => {
      const el = DrawingModel.createText(ox, oy - h/2 - 55 + i * 16, t.txt, t.fs);
      el.confidence = CONF.CONFIRMED;
      doc.elements.push(el);
    });

    return doc;
  }


  // ============================================================
  // 데모 전용 — v5: geometry-first, annotation은 placeholder
  // ============================================================

  // ============================================================
  // ★ DEMO_SHAFT_SPEC — v5.8 손그림 원본 완전 재설정
  //
  // 숨은선 4개 블록 (사용자 지정):
  //   1. S1 M10 TAP 깊이30  → 수평 파선 2개 (중심선 상/하 대칭) + 수직 마감 1개
  //   2. S1 키홈 (깊이3.5, 가로32, 세로6) → 수평 파선 1개 (키홈 바닥) + 수직 2개
  //   3. S3 M10 TAP 깊이30  → 수평 파선 2개 (중심선 상/하 대칭) + 수직 마감 1개
  //   4. S3 키홈 (깊이3.5, 가로40, 세로6) → 수평 파선 1개 (키홈 바닥) + 수직 2개
  //
  // 보조투상도:
  //   - S1 위: 32×6 오브라운드 (키홈을 위에서 본 모양)
  //   - S3 위: 40×6 오브라운드 (키홈을 위에서 본 모양)
  // ============================================================
  const DEMO_SHAFT_SPEC = {
    geometrySpec: {
      sections: [
        { id: 'S1', length: 50,  lengthConf: CONF.CONFIRMED, diameter: 20, diameterConf: CONF.CONFIRMED, note: null },
        { id: 'S2', length: 80,  lengthConf: CONF.CONFIRMED, diameter: 35, diameterConf: CONF.CONFIRMED, note: null },
        // ── CG2: S2~S3 사이 (between, bossDirection=left) ──
        { id: 'S3', length: 60,  lengthConf: CONF.CONFIRMED, diameter: 40, diameterConf: CONF.CONFIRMED, note: null },
        // ── CG3: S3~S4 사이 (between, bossDirection=right) ──
        { id: 'S4', length: 80,  lengthConf: CONF.CONFIRMED, diameter: 35, diameterConf: CONF.CONFIRMED, note: null },
        { id: 'S5', length: 50,  lengthConf: CONF.CONFIRMED, diameter: 20, diameterConf: CONF.CONFIRMED, note: null },
      ],
      totalLength: 320,
      totalLengthConf: CONF.CONFIRMED,
      holes: [],
      slots: [],
      chamferPositions: [
        { section: 'S1', side: 'left',  confidence: CONF.ESTIMATED },
        { section: 'S5', side: 'right', confidence: CONF.ESTIMATED },
      ],
      centerHolePositions: [
        { side: 'left',  confidence: CONF.UNCERTAIN },
        { side: 'right', confidence: CONF.UNCERTAIN },
      ],
      // ★ v5.8 숨은선 — 정확히 4개 블록
      // 각 블록은 "하나의 내부 feature"를 의미하며,
      // 정면도에서 보이지 않는 형상을 파선으로 표현
      hiddenFeatures: [
        // 블록1: S1 M10 TAP (좌측 끝면→30mm 깊이)
        // Ø10 원형 구멍이므로 정면도에서 상/하 수평 파선 + 끝면 수직 파선
        {
          id: 'HF1', section: 'S1', type: 'tap-bore',
          diameter: 10, depth: 30,
          side: 'left',
          confidence: CONF.CONFIRMED,
        },
        // 블록2: S1 키홈 (깊이3.5mm, 가로32mm, 세로6mm)
        // 정면도에서: 바닥선 수평 파선 1개 (중심선 위쪽) + 양쪽 수직 파선 2개
        // 바닥면 위치 = 축 상단에서 3.5mm 아래 = 중심선 위로 (r - depth) = (10 - 3.5) = 6.5mm
        {
          id: 'HF2', section: 'S1', type: 'keyway',
          keywayWidth: 32,    // mm — 키홈 가로 길이
          keywayHeight: 6,    // mm — 키홈 세로 (원주 방향)
          keywayDepth: 3.5,   // mm — 키홈 깊이 (반경 방향)
          side: 'left',       // 좌측 끝면에서 시작
          confidence: CONF.CONFIRMED,
        },
        // 블록3: S5 M10 TAP (우측 끝면→30mm 깊이)
        {
          id: 'HF3', section: 'S5', type: 'tap-bore',
          diameter: 10, depth: 30,
          side: 'right',
          confidence: CONF.CONFIRMED,
        },
        // 블록4: S5 키홈 (깊이3.5mm, 가로40mm, 세로6mm)
        {
          id: 'HF4', section: 'S5', type: 'keyway',
          keywayWidth: 40,
          keywayHeight: 6,
          keywayDepth: 3.5,
          side: 'right',
          confidence: CONF.CONFIRMED,
        },
      ],
    },
    annotationSpec: {
      partName: PLACEHOLDER.TEXT,
      partNo: PLACEHOLDER.TEXT,
      material: PLACEHOLDER.EMPTY,
      materialConf: CONF.UNCERTAIN,
      surfaceFinish: PLACEHOLDER.EMPTY,
      surfaceFinishConf: CONF.UNCERTAIN,
      unit: 'mm',
      scale: '1:1',
      projectionMethod: '3각법',
      paperSize: 'A3',
      chamferSpecs: [
        { section: 'S1', side: 'left',  spec: null, specConf: CONF.UNCERTAIN },
        { section: 'S5', side: 'right', spec: null, specConf: CONF.UNCERTAIN },
      ],
      keywaySpecs: [],
      tapSpecs: [
        { holeId: 'HF1', section: 'S1', spec: 'M10 TAP 깊이30', specConf: CONF.CONFIRMED },
        { holeId: 'HF3', section: 'S5', spec: 'M10 TAP 깊이30', specConf: CONF.CONFIRMED },
      ],
      centerHoleDiameters: [
        { side: 'left',  diameter: null, diamConf: CONF.UNCERTAIN },
        { side: 'right', diameter: null, diamConf: CONF.UNCERTAIN },
      ],
      notes: [],
    },
    // 보조 투상도 — 키홈을 위에서 본 모양
    auxiliaryViews: [
      {
        id: 'AUX1',
        position: 'top-left',
        label: '',
        shape: { type: 'obround', width: 32, height: 6, confidence: CONF.CONFIRMED },
        dimensions: [
          { axis: 'horizontal', value: 32, confidence: CONF.CONFIRMED },
          { axis: 'vertical',   value: 6,  confidence: CONF.CONFIRMED },
        ],
        relatedSection: 'S1',
        projectionLines: true,
      },
      {
        id: 'AUX2',
        position: 'top-right',
        label: '',
        shape: { type: 'obround', width: 40, height: 6, confidence: CONF.CONFIRMED },
        dimensions: [
          { axis: 'horizontal', value: 40, confidence: CONF.CONFIRMED },
          { axis: 'vertical',   value: 6,  confidence: CONF.CONFIRMED },
        ],
        relatedSection: 'S5',
        projectionLines: true,
      },
    ],
    // v32: 기하공차 — 공차값 1개만 표시 (사용자 요청)
    geometricTolerances: [
      // S2 상단면에 직각도 공차 (데이텀 A 기준) — 1개만
      { section: 'S2', face: 'top', symbolType: 'perpendicularity', value: '0.003', datum: 'A' },
    ],
    datums: [
      // S1 좌측면에 데이텀 A
      { section: 'S1', face: 'left', letter: 'A' },
      // S5 우측면에 데이텀 B
      { section: 'S5', face: 'right', letter: 'B' },
    ],
    uncertainElements: [],
    _reviewRequired: true,
    // v26: 체인스프라켓 — S1 좌측에 RS35 PT9 체인스프라켓 (edge 배치)
    // v27: placement='between' 추가 — 구간 사이 배치 (보조투상도 없음)
    // v28: CG3 추가 — S3~S4 사이, bossDirection='right' (보스가 우측, R값 좌측)
    chainGears: [
      // ── edge 배치: 축 끝(S1 좌측)에 체인스프라켓 ──
      {
        id: 'CG1',
        placement: 'edge',   // 'edge' = 축 끝 배치 (기본값, 생략 가능)
        section: 'S1',
        side: 'left',
        chainSpec: 'RS35',
        teeth: 9,
        outerDiam: 31,
        boreDiam: 20,
        gearWidth: 8,
        key: { width: 6, depth: 3 },
        boss: {
          count: 2,
          bosses: [
            { outerDiam: 26, thickness: 15, fillet: { value: 2, side: 'both' } },
            { outerDiam: 22, thickness: 5,  fillet: null },
          ],
        },
        confidence: CONF.CONFIRMED,
      },
      // ── between 배치 1: S2~S3 사이에 체인스프라켓 (보스 왼쪽) ──
      // 사용자 도면: 구간2~3 사이, 왼쪽으로 보스(오른쪽으로 R값 적용)
      {
        id: 'CG2',
        placement: 'between',       // 구간 사이 배치
        sectionLeft: 'S2',          // 좌측 인접 구간
        sectionRight: 'S3',         // 우측 인접 구간
        bossDirection: 'left',      // 보스가 왼쪽(S2 쪽)으로 돌출, R값은 오른쪽
        chainSpec: 'RS40',
        teeth: 12,
        outerDiam: 60,
        boreDiam: 30,
        gearWidth: 10,
        key: { width: 8, depth: 4 },
        boss: {
          count: 1,
          bosses: [
            { outerDiam: 45, thickness: 25, fillet: { value: 3, side: 'right' } },
          ],
        },
        confidence: CONF.CONFIRMED,
      },
      // ── between 배치 2: S3~S4 사이에 체인스프라켓 (보스 오른쪽) ──
      // 사용자 도면: 구간3~4 사이, 오른쪽으로 보스(왼쪽으로 R값 적용)
      {
        id: 'CG3',
        placement: 'between',       // 구간 사이 배치
        sectionLeft: 'S3',          // 좌측 인접 구간
        sectionRight: 'S4',         // 우측 인접 구간
        bossDirection: 'right',     // 보스가 오른쪽(S4 쪽)으로 돌출, R값은 왼쪽
        chainSpec: 'RS40',
        teeth: 12,
        outerDiam: 55,
        boreDiam: 28,
        gearWidth: 10,
        key: { width: 8, depth: 4 },
        boss: {
          count: 1,
          bosses: [
            { outerDiam: 40, thickness: 20, fillet: { value: 3, side: 'left' } },
          ],
        },
        confidence: CONF.CONFIRMED,
      },
    ],
  };


  function generateMechDemo() {
    return generateFromSpec(DEMO_SHAFT_SPEC);
  }

  function generateFromCustomSpec(spec) {
    return generateFromSpec(spec);
  }


  // ============================================================
  // UI 업데이트
  // ============================================================

  function updateAIStep(step, status) {
    const list = document.getElementById('aiStepsList');
    if (!list) return;
    list.querySelectorAll('li').forEach(li => {
      const s = parseInt(li.dataset.aiStep);
      const icon = li.querySelector('i');
      if (s < step || (s === step && status === 'done')) {
        li.className = 'done';
        icon.className = 'fas fa-check-circle';
      } else if (s === step && status === 'active') {
        li.className = 'active';
        icon.className = 'fas fa-spinner fa-spin';
      } else {
        li.className = '';
        icon.className = 'far fa-circle';
      }
    });
  }

  function resetAISteps() {
    const list = document.getElementById('aiStepsList');
    if (!list) return;
    list.querySelectorAll('li').forEach(li => {
      li.className = '';
      li.querySelector('i').className = 'far fa-circle';
    });
    const first = list.querySelector('li');
    if (first) {
      first.className = 'active';
      first.querySelector('i').className = 'fas fa-spinner fa-spin';
    }
    const fillEl = document.getElementById('aiProgressFill');
    if (fillEl) fillEl.style.width = '0%';
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    analyzeImage,
    classifyDrawingType,
    generateMechDemo,
    generateFromCustomSpec,
    selfCheckSpec,
    extractConfirmedSignals,
    buildShaftCandidates,
    resolveSpecFromCandidates,
    resetAISteps,
    getAnalysisSteps,
    delay,
    updateAIStep,
    DEMO_SHAFT_SPEC,
    CONF,
    PLACEHOLDER,
  };
})();
