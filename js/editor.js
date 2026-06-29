/* ============================================================
   editor.js
   도면 편집기 코어 — 기계도면 전용

   지원 요소: outline, centerline, hiddenline, hole, slot, hatch, dimension, text
   도구: select, move, outline(선 그리기), text, eraser

   v5: placeholder 요소 더블클릭 편집 지원
       _isPlaceholder=true 요소를 더블클릭하면 인라인 편집기 열림
       편집 후 _isPlaceholder=false로 전환 + confidence=confirmed
   ============================================================ */

const Editor = (() => {
  let _doc = null;
  let _tool = 'select';
  let _selectedId = null;
  let _dragging = false;
  let _dragStart = { x: 0, y: 0 };
  let _dragOriginal = null;
  let _dragGroupOriginals = null;  // v120: 그룹 드래그용 — [{id, ...origProps}]
  let _panOffset = { x: 0, y: 0 };
  let _zoom = 1;
  let _isPanning = false;
  let _panStart = { x: 0, y: 0 };
  let _panOffsetStart = { x: 0, y: 0 };

  // 선 그리기 상태
  let _lineDrawing = false;
  let _lineStart = null;
  let _tempLineEl = null;

  let _svg, _container, _drawingLayer;

  // ========== Init ==========
  function init(doc) {
    _doc = doc;
    _svg = document.getElementById('drawingSvg');
    _container = document.getElementById('canvasContainer');
    _drawingLayer = document.getElementById('drawingLayer');

    bindEvents();
    Renderer.init(_svg);
    setTool('select');
    fitToView();
  }

  // ========== Tool ==========
  function setTool(tool) {
    _tool = tool;
    _lineDrawing = false;
    _lineStart = null;
    if (_tempLineEl) { _tempLineEl.remove(); _tempLineEl = null; }

    document.querySelectorAll('.toolbar-btn[data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    _container.className = `canvas-container tool-${tool}`;

    if (tool !== 'select') deselectAll();
  }

  function getTool() { return _tool; }

  // ========== Selection ==========
  // ★ v120: _groupId가 있는 요소 클릭 시 같은 그룹 전체를 하나의 객체로 선택/이동/삭제

  /** 주어진 요소의 그룹 멤버 전체를 반환 (그룹이 없으면 단일 요소 배열) */
  function _getGroupElements(el) {
    if (el && el._groupId) {
      return _doc.elements.filter(e => e._groupId === el._groupId);
    }
    return el ? [el] : [];
  }

  // ★ v143: 지시선 주석 그룹인지 판별 (KEY / TAP / 스냅링 / 관통구멍 등)
  //   — _leaderArrow=true 인 리더선이 포함된 그룹.
  //     이 그룹을 끌면 "화살머리(가리키는 점)는 고정"하고 텍스트·지시선만 이동시킨다.
  function _isLeaderAnnotationGroup(groupEls) {
    if (!groupEls || groupEls.length < 2) return false;
    return groupEls.some(e => e._leaderArrow === true);
  }

  // ★ v143: 지시선 주석 그룹 드래그 전용 처리.
  //   화살촉이 가리키는 점(=리더1의 (x2,y2))은 고정하고,
  //   꺾임점·밑줄선·텍스트만 dx/dy 만큼 평행이동시켜 "연결을 유지한 채"
  //   주석 위치만 옮긴다. → 어떤 형상을 가리키는지 정보가 보존됨.
  function _applyLeaderGroupDelta(el, orig, dx, dy) {
    if (el._leaderArrow === true && el.type !== 'text') {
      // 화살표 리더선: 화살머리 끝점(x2,y2)은 고정, 꺾임점(x1,y1)만 이동
      el.x1 = orig.x1 + dx; el.y1 = orig.y1 + dy;
      el.x2 = orig.x2;      el.y2 = orig.y2;   // 화살머리 고정 (가리키는 점 유지)
      return;
    }
    // 그 외(밑줄선 outline, 텍스트 등): 전부 평행이동
    _applyDragDelta(el, orig, dx, dy, true);
  }

  function selectElement(id) {
    _selectedId = id;
    const el = _doc.elements.find(e => e.id === id);
    if (!el) return;

    // v120: 그룹 선택 — _groupId가 있으면 동일 그룹의 모든 요소를 찾아 전달
    const groupEls = _getGroupElements(el);
    if (groupEls.length > 1) {
      Renderer.showSelection(el, groupEls);
    } else {
      Renderer.showSelection(el);
    }
    showProperties(el);

    document.getElementById('selectedInfo').style.display = 'inline';
    // v120: 그룹이면 "그룹 (N개)" 표시
    if (groupEls.length > 1) {
      document.getElementById('selectedText').textContent =
        `${_getGroupLabel(el._groupId)} 그룹 선택됨 (${groupEls.length}개)`;
    } else {
      document.getElementById('selectedText').textContent =
        `${getTypeLabel(el.type)} 선택됨`;
    }
  }

  /** 그룹 ID에서 사람이 읽을 수 있는 라벨 생성 */
  function _getGroupLabel(groupId) {
    if (!groupId) return '';
    if (groupId.startsWith('grp_tap_')) return 'TAP 주석';
    if (groupId.startsWith('grp_key_')) return 'KEY 주석';
    if (groupId.startsWith('grp_snap_')) return '스냅링 주석';
    if (groupId.startsWith('grp_thru_')) return '관통구멍 주석';
    return '주석';
  }

  function deselectAll() {
    _selectedId = null;
    Renderer.clearSelection();
    hideProperties();
    document.getElementById('selectedInfo').style.display = 'none';
  }

  function getSelected() {
    if (!_selectedId) return null;
    return _doc.elements.find(e => e.id === _selectedId);
  }

  // ========== Hit Test ==========
  //
  // ★ 치수(dimension) 요소는 치수선 영역과 치수숫자 영역을 분리 판정
  //   — 치수숫자를 클릭하면 해당 치수가 선택되어 공차를 입력할 수 있음
  //   — 치수선(보조선 포함) 클릭도 동일 치수 선택
  //   — 겹치는 치수가 있을 때 정확한 영역만 반응
  //
  function _dimTextHitRect(el) {
    // 렌더러(renderDimension)와 동일한 좌표 계산으로 텍스트 히트 영역 반환
    const isHorizontal = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
    const offsetDir = el.offset || 30;
    const fontSize = el.fontSize || 12;
    let lx1, ly1, lx2, ly2;
    if (isHorizontal) {
      ly1 = ly2 = Math.min(el.y1, el.y2) - offsetDir;
      lx1 = el.x1; lx2 = el.x2;
    } else {
      lx1 = lx2 = Math.min(el.x1, el.x2) - offsetDir;
      ly1 = el.y1; ly2 = el.y2;
    }
    const dimSpan = Math.sqrt((lx2 - lx1) ** 2 + (ly2 - ly1) ** 2);
    const textStr = String(el.value || '');
    const textWidth = textStr.length * fontSize * 0.65;
    const isNarrow = dimSpan < textWidth + 20;
    const midX = (lx1 + lx2) / 2;
    const midY = (ly1 + ly2) / 2;
    const tolExtraW = (el.tolerance && (el.toleranceUpper || el.toleranceLower)) ? 25 : 0;

    let tx, ty, tw, th;
    if (isHorizontal) {
      if (!isNarrow) {
        tx = midX - textWidth / 2 - 4;
        ty = midY - fontSize - 5;
        tw = textWidth + 8 + tolExtraW;
        th = fontSize + 10;
      } else {
        tx = lx2 + 1;
        ty = midY - fontSize - 4;
        tw = textWidth + 8 + tolExtraW;
        th = fontSize + 10;
      }
    } else {
      // 수직: 텍스트가 치수선 오른쪽 (x = midX + 5, text-anchor: start)
      tx = midX + 5 - 2;
      ty = midY - fontSize * 0.7;
      tw = textWidth + 8 + tolExtraW;
      th = fontSize + 6;
    }
    return { x: tx, y: ty, width: tw, height: th };
  }

  function _dimLineHitRect(el) {
    // 치수선(보조선 + 화살표 선) 영역
    const isHorizontal = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
    const offsetDir = el.offset || 30;
    let lx1, ly1, lx2, ly2;
    if (isHorizontal) {
      ly1 = ly2 = Math.min(el.y1, el.y2) - offsetDir;
      lx1 = el.x1; lx2 = el.x2;
    } else {
      lx1 = lx2 = Math.min(el.x1, el.x2) - offsetDir;
      ly1 = el.y1; ly2 = el.y2;
    }
    const pad = 6;
    if (isHorizontal) {
      return {
        x: Math.min(lx1, lx2) - 3,
        y: ly1 - pad,
        width: Math.abs(lx2 - lx1) + 6,
        height: pad * 2,
      };
    } else {
      return {
        x: lx1 - pad,
        y: Math.min(ly1, ly2) - 3,
        width: pad * 2,
        height: Math.abs(ly2 - ly1) + 6,
      };
    }
  }

  function _inRect(pt, r, pad) {
    return pt.x >= r.x - pad && pt.x <= r.x + r.width + pad &&
           pt.y >= r.y - pad && pt.y <= r.y + r.height + pad;
  }

  // ★ v120: 요소에 dx/dy 이동 적용 (그룹 드래그 + 단일 드래그 공용)
  //   isGroup=true (그룹 드래그)면 치수도 측정점째로 평행이동(형상과 함께 이동),
  //   isGroup=false (단일 드래그)면 치수는 화살머리 고정 + offset만 변경.
  function _applyDragDelta(el, orig, dx, dy, isGroup) {
    switch (el.type) {
      case 'outline': case 'centerline': case 'hiddenline':
        el.x1 = orig.x1 + dx; el.y1 = orig.y1 + dy;
        el.x2 = orig.x2 + dx; el.y2 = orig.y2 + dy;
        break;
      case 'dimension': {
        if (isGroup) {
          // 그룹(형상 전체) 이동: 측정점도 함께 이동 (기존 동작 유지)
          el.x1 = orig.x1 + dx; el.y1 = orig.y1 + dy;
          el.x2 = orig.x2 + dx; el.y2 = orig.y2 + dy;
          break;
        }
        // ★ v141: 단일 치수 드래그 = 화살머리(측정점 x1,y1,x2,y2)는 고정,
        //          치수선·텍스트만 측정 대상으로부터 떨어진 거리(offset)만 변경.
        //   - 수평 치수: 마우스 세로 이동(dy)이 offset에 반영 (위/아래로 치수선 이동)
        //   - 수직 치수: 마우스 가로 이동(dx)이 offset에 반영 (좌/우로 치수선 이동)
        //   measurement point는 그대로 두므로 "이 치수가 무엇을 가리키는지"가 유지됨
        const isHorizontal = Math.abs(orig.y2 - orig.y1) < Math.abs(orig.x2 - orig.x1);
        const origOffset = (orig.offset != null) ? orig.offset : 30;
        // 측정점은 원본 그대로 유지 (화살머리 고정)
        el.x1 = orig.x1; el.y1 = orig.y1;
        el.x2 = orig.x2; el.y2 = orig.y2;
        if (isHorizontal) {
          // 렌더: ly = min(y1,y2) - offset → 위로 가려면 offset↑.
          //   마우스를 위로(dy<0) 끌면 치수선도 위로 → offset 증가
          el.offset = origOffset - dy;
        } else {
          // 렌더: lx = min(x1,x2) - offset → 왼쪽으로 가려면 offset↑.
          //   마우스를 왼쪽으로(dx<0) 끌면 치수선도 왼쪽 → offset 증가
          el.offset = origOffset - dx;
        }
        break;
      }
      case 'text': case 'surfacefinish':
        el.x = orig.x + dx; el.y = orig.y + dy;
        break;
      case 'geotolerance':
        el.x = orig.x + dx; el.y = orig.y + dy;
        if (orig._leaderX != null) el._leaderX = orig._leaderX + dx;
        if (orig._leaderY != null) el._leaderY = orig._leaderY + dy;
        break;
      case 'datum':
        el.x = orig.x + dx; el.y = orig.y + dy;
        if (orig._extLineEndX != null) el._extLineEndX = orig._extLineEndX + dx;
        if (orig._extLineEndY != null) el._extLineEndY = orig._extLineEndY + dy;
        break;
      case 'hole':
        el.cx = orig.cx + dx; el.cy = orig.cy + dy;
        break;
      case 'slot':
        el.x = orig.x + dx; el.y = orig.y + dy;
        break;
      case 'hatch':
        if (el.points && orig.points) {
          el.points.forEach((p, i) => {
            p.x = orig.points[i].x + dx;
            p.y = orig.points[i].y + dy;
          });
        }
        break;
    }
  }

  function hitTest(clientX, clientY) {
    const pt = clientToSvg(clientX, clientY);

    // ★ 1차: 치수숫자 텍스트 영역 우선 판정 (공차 입력 목적)
    //   — 숫자 영역이 가장 작으므로 정밀하게 판별
    for (let i = _doc.elements.length - 1; i >= 0; i--) {
      const el = _doc.elements[i];
      if (el.type !== 'dimension') continue;
      if (!_doc.layers[el.layer] || !_doc.layers[el.layer].visible) continue;
      const txtR = _dimTextHitRect(el);
      if (_inRect(pt, txtR, 4)) return el;
    }

    // ★ 2차: 치수선 영역 판정
    for (let i = _doc.elements.length - 1; i >= 0; i--) {
      const el = _doc.elements[i];
      if (el.type !== 'dimension') continue;
      if (!_doc.layers[el.layer] || !_doc.layers[el.layer].visible) continue;
      const lineR = _dimLineHitRect(el);
      if (_inRect(pt, lineR, 4)) return el;
    }

    // ★ 3차: 모든 요소 — 기존 getElementBounds 방식 (치수 포함 fallback)
    //   1·2차에서 잡히지 않은 치수도 여기서 넓은 바운딩 박스로 catch
    for (let i = _doc.elements.length - 1; i >= 0; i--) {
      const el = _doc.elements[i];
      if (!_doc.layers[el.layer] || !_doc.layers[el.layer].visible) continue;

      const bounds = DrawingModel.getElementBounds(el);
      const pad = 8;
      if (pt.x >= bounds.x - pad && pt.x <= bounds.x + bounds.width + pad &&
          pt.y >= bounds.y - pad && pt.y <= bounds.y + bounds.height + pad) {
        return el;
      }
    }
    return null;
  }

  // ========== Properties Panel ==========
  function showProperties(el) {
    document.getElementById('panelNoSelection').style.display = 'none';
    document.getElementById('panelSelection').style.display = 'block';

    document.getElementById('propType').textContent = getTypeLabel(el.type);
    document.getElementById('propId').textContent = el.id;

    const bounds = DrawingModel.getElementBounds(el);
    document.getElementById('propX').value = Math.round(bounds.x);
    document.getElementById('propY').value = Math.round(bounds.y);

    const sizeRow = document.getElementById('propSizeRow');
    const lineTypes = ['outline', 'centerline', 'hiddenline', 'dimension'];
    if (lineTypes.includes(el.type)) {
      sizeRow.style.display = 'none';
    } else {
      sizeRow.style.display = 'flex';
      document.getElementById('propW').value = Math.round(bounds.width);
      document.getElementById('propH').value = Math.round(bounds.height);
    }

    // 치수 섹션
    const dimSection = document.getElementById('propDimensionSection');
    dimSection.style.display = el.type === 'dimension' ? 'block' : 'none';
    if (el.type === 'dimension') {
      document.getElementById('propDimValue').value = el.value;
      document.getElementById('propDimUnit').value = el.unit || 'mm';

      // 치수공차 (tolerance)
      const tolCheckbox = document.getElementById('propTolerance');
      const tolFields = document.getElementById('propToleranceFields');
      if (tolCheckbox && tolFields) {
        tolCheckbox.checked = !!el.tolerance;
        tolFields.style.display = el.tolerance ? 'block' : 'none';
        document.getElementById('propTolUpper').value = el.toleranceUpper || '';
        document.getElementById('propTolLower').value = el.toleranceLower || '';
      }

      // ★ v141: 치수선 위치(offset) — 슬라이더 + 숫자 동기화
      const offsetVal = (el.offset != null) ? Math.round(el.offset) : 30;
      const offRange = document.getElementById('propDimOffset');
      const offNum = document.getElementById('propDimOffsetNum');
      if (offRange) offRange.value = offsetVal;
      if (offNum) offNum.value = offsetVal;
    }

    // 텍스트 섹션
    const textSection = document.getElementById('propTextSection');
    textSection.style.display = el.type === 'text' ? 'block' : 'none';
    if (el.type === 'text') {
      document.getElementById('propTextContent').value = el.content;
      document.getElementById('propFontSize').value = el.fontSize;
    }

    // ── 다듬질 기호 섹션 ──
    const sfSection = document.getElementById('propSurfaceFinishSection');
    if (sfSection) {
      const canAttachSF = ['outline', 'dimension'].includes(el.type);
      const isSF = el.type === 'surfacefinish';
      sfSection.style.display = (canAttachSF || isSF) ? 'block' : 'none';

      if (canAttachSF) {
        // 외형선/치수선 선택 시: "다듬질 기호 추가" 버튼
        const btnAddSF = document.getElementById('btnAddSurfaceFinish');
        const sfEditArea = document.getElementById('sfEditArea');
        if (btnAddSF) btnAddSF.style.display = '';
        if (sfEditArea) sfEditArea.style.display = 'none';

        // 이 요소에 이미 부착된 다듬질 기호가 있는지 확인
        const existingSF = _doc.elements.find(e => e.type === 'surfacefinish' && e.attachTo === el.id);
        if (existingSF) {
          if (btnAddSF) btnAddSF.textContent = '다듬질 기호 수정';
        } else {
          if (btnAddSF) btnAddSF.innerHTML = '<i class="fas fa-wave-square"></i> 다듬질 기호 추가';
        }
      } else if (isSF) {
        // 다듬질 기호 자체를 선택 시: 편집 UI
        const btnAddSF = document.getElementById('btnAddSurfaceFinish');
        const sfEditArea = document.getElementById('sfEditArea');
        if (btnAddSF) btnAddSF.style.display = 'none';
        if (sfEditArea) {
          sfEditArea.style.display = 'block';
          const gradeSelect = document.getElementById('sfGradeSelect');
          const typeSelect = document.getElementById('sfValueTypeSelect');
          const valueDisplay = document.getElementById('sfValueDisplay');
          if (gradeSelect) gradeSelect.value = el.grade || 'normal';
          if (typeSelect) typeSelect.value = el.valueType || 'Ra';
          if (valueDisplay) {
            const info = DrawingModel.SURFACE_FINISH_TABLE[el.grade] || {};
            valueDisplay.textContent = info[el.valueType] || el.value || '';
          }
        }
      }
    }

    // ── 기하공차 섹션 ──
    const gdtSection = document.getElementById('propGDTSection');
    if (gdtSection) {
      const canAttachGDT = ['outline', 'dimension'].includes(el.type);
      const isGDT = el.type === 'geotolerance';
      const isDatum = el.type === 'datum';
      gdtSection.style.display = (canAttachGDT || isGDT || isDatum) ? 'block' : 'none';

      const gdtActionButtons = document.getElementById('gdtActionButtons');
      const gdtAttachedSummary = document.getElementById('gdtAttachedSummary');
      const gdtEditArea = document.getElementById('gdtEditArea');
      const datumEditArea = document.getElementById('datumEditArea');
      const gdtInfoArea = document.getElementById('gdtInfoArea');
      const datumInfoArea = document.getElementById('datumInfoArea');
      const btnAddGDT = document.getElementById('btnAddGDT');
      const btnAddDatum = document.getElementById('btnAddDatum');

      // 모두 숨김 초기화
      if (gdtActionButtons) gdtActionButtons.style.display = 'none';
      if (gdtAttachedSummary) gdtAttachedSummary.style.display = 'none';
      if (gdtEditArea) gdtEditArea.style.display = 'none';
      if (datumEditArea) datumEditArea.style.display = 'none';
      if (gdtInfoArea) gdtInfoArea.style.display = 'none';
      if (datumInfoArea) datumInfoArea.style.display = 'none';

      if (canAttachGDT) {
        // 외형선/치수선 선택 시: 버튼 표시
        if (gdtActionButtons) gdtActionButtons.style.display = '';
        // 이미 부착된 기하공차/데이텀 확인
        const existGDTs = _doc.elements.filter(e => e.type === 'geotolerance' && e.attachTo === el.id);
        const existDat = _doc.elements.find(e => e.type === 'datum' && e.attachTo === el.id);
        if (existGDTs.length > 0 && btnAddGDT) btnAddGDT.innerHTML = '<i class="fas fa-ruler-combined"></i> 기하공차 수정';
        else if (btnAddGDT) btnAddGDT.innerHTML = '<i class="fas fa-ruler-combined"></i> 기하공차 추가';
        if (existDat && btnAddDatum) btnAddDatum.innerHTML = '<i class="fas fa-map-marker-alt"></i> 데이텀 수정';
        else if (btnAddDatum) btnAddDatum.innerHTML = '<i class="fas fa-map-marker-alt"></i> 데이텀 지정';

        // 부착된 항목 요약 표시
        if ((existGDTs.length > 0 || existDat) && gdtAttachedSummary) {
          gdtAttachedSummary.style.display = 'block';
          const listEl = document.getElementById('gdtAttachedList');
          if (listEl) {
            listEl.innerHTML = '';
            existGDTs.forEach(gdt => {
              const symInfo = DrawingModel.GDT_SYMBOLS[gdt.symbolType] || {};
              const tag = document.createElement('div');
              tag.className = 'gdt-attached-tag gdt-attached-tag-gdt';
              tag.innerHTML = `<span class="tag-symbol">${symInfo.symbol || '?'}</span> <span class="tag-value">${gdt.value || ''}</span>${gdt.datum ? ` <span style="color:#8b5cf6;font-weight:600;">${gdt.datum}</span>` : ''}`;
              tag.addEventListener('click', () => selectElement(gdt.id));
              listEl.appendChild(tag);
            });
            if (existDat) {
              const tag = document.createElement('div');
              tag.className = 'gdt-attached-tag gdt-attached-tag-datum';
              tag.innerHTML = `<span class="tag-symbol">▼</span> 데이텀 ${existDat.letter}`;
              tag.addEventListener('click', () => selectElement(existDat.id));
              listEl.appendChild(tag);
            }
          }
        }
      } else if (isGDT) {
        // 기하공차 자체 선택 시
        if (gdtInfoArea) {
          gdtInfoArea.style.display = 'block';
          const symInfo = DrawingModel.GDT_SYMBOLS[el.symbolType] || {};
          document.getElementById('gdtInfoSymbol').textContent = `${symInfo.symbol || '?'} ${symInfo.label || el.symbolType}`;
          document.getElementById('gdtInfoValue').textContent = el.value || '—';
          document.getElementById('gdtInfoDatum').textContent = el.datum || '없음';
          // 적층 공차 정보 표시
          const stackedInfoEl = document.getElementById('gdtInfoStacked');
          const stackedListEl = document.getElementById('gdtInfoStackedList');
          if (stackedInfoEl && stackedListEl) {
            if (el.stacked && el.stacked.length > 0) {
              stackedInfoEl.style.display = 'block';
              stackedListEl.innerHTML = el.stacked.map(s => {
                const si = DrawingModel.GDT_SYMBOLS[s.symbolType] || {};
                return `<div style="padding:2px 0;font-size:11px;">${si.symbol || '?'} ${si.label || s.symbolType} — <span style="font-family:'JetBrains Mono',monospace;">${s.value}</span>${s.datum ? ` <span style="color:#8b5cf6;font-weight:600;">${s.datum}</span>` : ''}</div>`;
              }).join('');
            } else {
              stackedInfoEl.style.display = 'none';
            }
          }
        }
      } else if (isDatum) {
        // 데이텀 자체 선택 시
        if (datumInfoArea) {
          datumInfoArea.style.display = 'block';
          document.getElementById('datumInfoLetter').textContent = el.letter || '—';
        }
      }

      // 데이텀 드롭다운 갱신
      _updateDatumDropdowns();
    }

    // 스타일
    document.getElementById('propStrokeWidth').value =
      el.thickness || el.fontSize || el.diameter || 2;
    document.getElementById('propColor').value = el.color || '#000000';
    document.getElementById('propColorHex').textContent = el.color || '#000000';
  }

  /** 데이텀 드롭다운 목록을 현재 문서의 datum 요소로부터 갱신 */
  function _updateDatumDropdowns() {
    if (!_doc) return;
    const datums = _doc.elements.filter(e => e.type === 'datum');
    const selects = ['gdtDatumSelect', 'gdtStackDatum'];
    selects.forEach(selId => {
      const sel = document.getElementById(selId);
      if (!sel) return;
      const curVal = sel.value;
      sel.innerHTML = '<option value="">— 데이텀 없음 —</option>';
      datums.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.letter;
        opt.textContent = `데이텀 ${d.letter}`;
        sel.appendChild(opt);
      });
      sel.value = curVal || '';
    });
  }

  function hideProperties() {
    document.getElementById('panelNoSelection').style.display = 'block';
    document.getElementById('panelSelection').style.display = 'none';
    // 다듬질 기호 섹션 숨김
    const sfSection = document.getElementById('propSurfaceFinishSection');
    if (sfSection) sfSection.style.display = 'none';
    // 기하공차 섹션 숨김
    const gdtSection = document.getElementById('propGDTSection');
    if (gdtSection) gdtSection.style.display = 'none';
  }

  // ========== Coordinate Transform ==========
  function clientToSvg(clientX, clientY) {
    const rect = _svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - _panOffset.x) / _zoom,
      y: (clientY - rect.top - _panOffset.y) / _zoom,
    };
  }

  function applyTransform() {
    _drawingLayer.setAttribute('transform',
      `translate(${_panOffset.x}, ${_panOffset.y}) scale(${_zoom})`);

    const gridSmall = _svg.getElementById('gridSmall');
    const gridLarge = _svg.getElementById('gridLarge');
    if (gridSmall) {
      const gs = 10 * _zoom;
      gridSmall.setAttribute('width', gs);
      gridSmall.setAttribute('height', gs);
    }
    if (gridLarge) {
      const gl = 100 * _zoom;
      gridLarge.setAttribute('width', gl);
      gridLarge.setAttribute('height', gl);
    }

    const pct = Math.round(_zoom * 100);
    const zoomEl = document.getElementById('zoomLevel');
    const zoomFloat = document.getElementById('zoomLabelFloat');
    if (zoomEl) zoomEl.textContent = `${pct}%`;
    if (zoomFloat) zoomFloat.textContent = `${pct}%`;
  }

  // ========== Zoom / Pan ==========
  function zoomIn() { _zoom = Math.min(_zoom * 1.2, 5); applyTransform(); }
  function zoomOut() { _zoom = Math.max(_zoom / 1.2, 0.1); applyTransform(); }

  function fitToView() {
    const bounds = DrawingModel.getAllBounds(_doc.elements);
    const svgRect = _svg.getBoundingClientRect();
    const padding = 80;

    const scaleX = (svgRect.width - padding * 2) / (bounds.width || 1);
    const scaleY = (svgRect.height - padding * 2) / (bounds.height || 1);
    _zoom = Math.min(scaleX, scaleY, 2);
    _zoom = Math.max(_zoom, 0.1);

    _panOffset.x = (svgRect.width - bounds.width * _zoom) / 2 - bounds.x * _zoom;
    _panOffset.y = (svgRect.height - bounds.height * _zoom) / 2 - bounds.y * _zoom;

    applyTransform();
  }

  // ========== Inline Edit ==========
  function startInlineEdit(el, clientX, clientY) {
    const existing = document.querySelector('.inline-edit-input');
    if (existing) existing.remove();

    const input = document.createElement('input');
    input.className = 'inline-edit-input';
    input.type = 'text';

    if (el.type === 'dimension') input.value = el.value;
    else if (el.type === 'text') input.value = el.content;
    else return;

    input.style.left = `${clientX - 40}px`;
    input.style.top = `${clientY - 15}px`;
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value.trim();
      if (newVal && newVal !== (el.type === 'dimension' ? el.value : el.content)) {
        if (el.type === 'dimension') el.value = newVal;
        else el.content = newVal;
        _doc.meta.updatedAt = new Date().toISOString();
        History.push(_doc.elements, `${getTypeLabel(el.type)} 수정`);
        Renderer.render(_doc);
        selectElement(el.id);
        App.showToast(`${getTypeLabel(el.type)} 값이 수정되었습니다`, 'success');
      }
      input.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', commit);
  }

  // ========== Modify Element from Properties ==========
  function updateElementFromProps(el) {
    const x = parseInt(document.getElementById('propX').value) || 0;
    const y = parseInt(document.getElementById('propY').value) || 0;
    const bounds = DrawingModel.getElementBounds(el);
    const dx = x - bounds.x;
    const dy = y - bounds.y;

    moveElement(el, dx, dy);

    if (el.type === 'dimension') {
      el.value = document.getElementById('propDimValue').value;
      el.unit = document.getElementById('propDimUnit').value;

      // 치수공차 (tolerance) 업데이트
      const tolCheckbox = document.getElementById('propTolerance');
      if (tolCheckbox) {
        el.tolerance = tolCheckbox.checked;
        el.toleranceUpper = document.getElementById('propTolUpper').value || '';
        el.toleranceLower = document.getElementById('propTolLower').value || '';
      }
    }

    if (el.type === 'text') {
      el.content = document.getElementById('propTextContent').value;
      el.fontSize = parseInt(document.getElementById('propFontSize').value) || 14;
    }

    el.color = document.getElementById('propColor').value;
    document.getElementById('propColorHex').textContent = el.color;

    if (el.type === 'outline' || el.type === 'centerline' || el.type === 'hiddenline') {
      el.thickness = parseFloat(document.getElementById('propStrokeWidth').value) || 2;
    }

    _doc.meta.updatedAt = new Date().toISOString();
    Renderer.render(_doc);
    selectElement(el.id);
  }

  // ========== Element Operations ==========
  function moveElement(el, dx, dy) {
    switch (el.type) {
      case 'outline':
      case 'centerline':
      case 'hiddenline':
      case 'dimension':
        el.x1 += dx; el.y1 += dy;
        el.x2 += dx; el.y2 += dy;
        break;
      case 'text':
      case 'surfacefinish':
        el.x += dx; el.y += dy;
        break;
      case 'geotolerance':
        el.x += dx; el.y += dy;
        if (el._leaderX != null) el._leaderX += dx;
        if (el._leaderY != null) el._leaderY += dy;
        break;
      case 'datum':
        el.x += dx; el.y += dy;
        if (el._extLineEndX != null) el._extLineEndX += dx;
        if (el._extLineEndY != null) el._extLineEndY += dy;
        break;
      case 'hole':
        el.cx += dx; el.cy += dy;
        break;
      case 'slot':
        el.x += dx; el.y += dy;
        break;
      case 'hatch':
        if (el.points) el.points.forEach(p => { p.x += dx; p.y += dy; });
        break;
    }
  }

  function deleteElement(id) {
    const idx = _doc.elements.findIndex(e => e.id === id);
    if (idx === -1) return;
    const el = _doc.elements[idx];

    // ★ v120: 그룹 삭제 — _groupId가 있으면 동일 그룹의 모든 요소를 한꺼번에 삭제
    if (el._groupId) {
      const gid = el._groupId;
      const count = _doc.elements.filter(e => e._groupId === gid).length;
      _doc.elements = _doc.elements.filter(e => e._groupId !== gid);
      deselectAll();
      History.push(_doc.elements, `${_getGroupLabel(gid)} 그룹 삭제 (${count}개)`);
      Renderer.render(_doc);
      App.showToast(`그룹이 삭제되었습니다 (${count}개 요소)`, 'info');
    } else {
      _doc.elements.splice(idx, 1);
      deselectAll();
      History.push(_doc.elements, `${getTypeLabel(el.type)} 삭제`);
      Renderer.render(_doc);
      App.showToast('요소가 삭제되었습니다', 'info');
    }
  }

  // ========== Event Binding ==========
  function bindEvents() {
    _svg.addEventListener('mousedown', onMouseDown);
    _svg.addEventListener('mousemove', onMouseMove);
    _svg.addEventListener('mouseup', onMouseUp);
    _svg.addEventListener('dblclick', onDoubleClick);
    _svg.addEventListener('wheel', onWheel, { passive: false });

    document.addEventListener('keydown', onKeyDown);

    document.querySelectorAll('.toolbar-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    document.getElementById('btnZoomIn').addEventListener('click', zoomIn);
    document.getElementById('btnZoomOut').addEventListener('click', zoomOut);
    document.getElementById('btnZoomFit').addEventListener('click', fitToView);

    document.getElementById('btnUndo').addEventListener('click', () => History.undo());
    document.getElementById('btnRedo').addEventListener('click', () => History.redo());

    bindPropertyInputs();

    document.getElementById('btnDeleteElement').addEventListener('click', () => {
      if (_selectedId) deleteElement(_selectedId);
    });
  }

  function bindPropertyInputs() {
    const fields = ['propX', 'propY', 'propW', 'propH', 'propDimValue',
      'propDimUnit', 'propTextContent', 'propFontSize', 'propStrokeWidth', 'propColor',
      'propTolUpper', 'propTolLower'];

    fields.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const selected = getSelected();
        if (selected) {
          updateElementFromProps(selected);
          History.push(_doc.elements, '속성 변경');
        }
      });
    });

    // ★ v141: 치수선 위치(offset) 슬라이더 + 숫자 입력 — 실시간 반영
    const offRange = document.getElementById('propDimOffset');
    const offNum = document.getElementById('propDimOffsetNum');
    function applyDimOffset(val, pushHistory) {
      const selected = getSelected();
      if (!selected || selected.type !== 'dimension') return;
      const v = Math.round(Number(val));
      if (isNaN(v)) return;
      selected.offset = v;
      if (offRange) offRange.value = v;
      if (offNum) offNum.value = v;
      _doc.meta.updatedAt = new Date().toISOString();
      Renderer.render(_doc);
      selectElement(selected.id); // 선택 하이라이트 갱신
      if (pushHistory) History.push(_doc.elements, '치수선 위치 변경');
    }
    if (offRange) {
      offRange.addEventListener('input', () => applyDimOffset(offRange.value, false));
      offRange.addEventListener('change', () => applyDimOffset(offRange.value, true));
    }
    if (offNum) {
      offNum.addEventListener('input', () => applyDimOffset(offNum.value, false));
      offNum.addEventListener('change', () => applyDimOffset(offNum.value, true));
    }

    // ── 다듬질 기호 추가 버튼 ──
    const btnAddSF = document.getElementById('btnAddSurfaceFinish');
    if (btnAddSF) {
      btnAddSF.addEventListener('click', () => {
        const selected = getSelected();
        if (!selected) return;
        // 이미 부착된 다듬질 기호가 있으면 편집 모드
        const existingSF = _doc.elements.find(e => e.type === 'surfacefinish' && e.attachTo === selected.id);
        if (existingSF) {
          // 기존 기호 선택 → 편집 UI로 전환
          selectElement(existingSF.id);
          return;
        }
        // 다듬질 기호 추가 다이얼로그
        showSurfaceFinishDialog(selected);
      });
    }

    // ── 다듬질 기호 편집 (grade/valueType 변경) ──
    const sfGradeSelect = document.getElementById('sfGradeSelect');
    const sfValueTypeSelect = document.getElementById('sfValueTypeSelect');
    if (sfGradeSelect) {
      sfGradeSelect.addEventListener('change', () => {
        const sel = getSelected();
        if (!sel || sel.type !== 'surfacefinish') return;
        const newGrade = sfGradeSelect.value;
        const vt = sel.valueType || 'Ra';
        const info = DrawingModel.SURFACE_FINISH_TABLE[newGrade];
        if (!info) return;
        sel.grade = newGrade;
        sel.triangles = info.triangles;
        sel.value = info[vt] || '';
        const valueDisplay = document.getElementById('sfValueDisplay');
        if (valueDisplay) valueDisplay.textContent = sel.value;
        _doc.meta.updatedAt = new Date().toISOString();
        Renderer.render(_doc);
        selectElement(sel.id);
        History.push(_doc.elements, `다듬질 등급 변경: ${info.label}`);
        App.showToast(`다듬질 등급: ${info.label}`, 'success');
      });
    }
    if (sfValueTypeSelect) {
      sfValueTypeSelect.addEventListener('change', () => {
        const sel = getSelected();
        if (!sel || sel.type !== 'surfacefinish') return;
        const vt = sfValueTypeSelect.value;
        const info = DrawingModel.SURFACE_FINISH_TABLE[sel.grade];
        if (!info) return;
        sel.valueType = vt;
        sel.value = info[vt] || '';
        const valueDisplay = document.getElementById('sfValueDisplay');
        if (valueDisplay) valueDisplay.textContent = sel.value;
        _doc.meta.updatedAt = new Date().toISOString();
        Renderer.render(_doc);
        selectElement(sel.id);
        History.push(_doc.elements, `표준값 유형 변경: ${vt}`);
        App.showToast(`표준값: ${vt} = ${sel.value}`, 'success');
      });
    }

    // 치수공차 체크박스 — 토글 시 즉시 반영
    const tolCheckbox = document.getElementById('propTolerance');
    if (tolCheckbox) {
      tolCheckbox.addEventListener('change', () => {
        const tolFields = document.getElementById('propToleranceFields');
        if (tolFields) tolFields.style.display = tolCheckbox.checked ? 'block' : 'none';

        const selected = getSelected();
        if (selected && selected.type === 'dimension') {
          selected.tolerance = tolCheckbox.checked;
          if (!tolCheckbox.checked) {
            // 체크 해제 시 공차 값 초기화
            selected.toleranceUpper = '';
            selected.toleranceLower = '';
            document.getElementById('propTolUpper').value = '';
            document.getElementById('propTolLower').value = '';
          }
          _doc.meta.updatedAt = new Date().toISOString();
          Renderer.render(_doc);
          selectElement(selected.id);
          History.push(_doc.elements, tolCheckbox.checked ? '치수공차 활성화' : '치수공차 비활성화');
          App.showToast(tolCheckbox.checked ? '치수공차가 활성화되었습니다' : '치수공차가 비활성화되었습니다', 'success');
        }
      });
    }

    // ── 기하공차 (GD&T) 추가 버튼 ──
    // 입력 순서: 면 선택 → 기하공차 버튼 클릭 → 공차 종류 선택 → 수치 입력 → 데이텀 체크(선택)
    const btnAddGDT = document.getElementById('btnAddGDT');
    if (btnAddGDT) {
      btnAddGDT.addEventListener('click', () => {
        const selected = getSelected();
        if (!selected) return;
        // 이미 부착된 기하공차가 있으면 편집 모드
        const existGDT = _doc.elements.find(e => e.type === 'geotolerance' && e.attachTo === selected.id);
        if (existGDT) {
          selectElement(existGDT.id);
          return;
        }
        // 편집 UI 표시
        const gdtEditArea = document.getElementById('gdtEditArea');
        const gdtActionButtons = document.getElementById('gdtActionButtons');
        if (gdtEditArea) gdtEditArea.style.display = 'block';
        if (gdtActionButtons) gdtActionButtons.style.display = 'none';
        // 기본값 설정
        const symSelect = document.getElementById('gdtSymbolSelect');
        const valInput = document.getElementById('gdtValueInput');
        const datumCheck = document.getElementById('gdtDatumCheck');
        const datumArea = document.getElementById('gdtDatumSelectArea');
        const stackCheck = document.getElementById('gdtStackCheck');
        const stackArea = document.getElementById('gdtStackArea');
        if (symSelect) symSelect.value = 'perpendicularity';
        if (valInput) { valInput.value = ''; valInput.disabled = true; }
        if (datumCheck) { datumCheck.checked = false; datumCheck.disabled = true; }
        if (datumArea) datumArea.style.display = 'none';
        if (stackCheck) { stackCheck.checked = false; }
        if (stackArea) stackArea.style.display = 'none';
        // Initialize step states: Step 1 active, Step 2 & 3 inactive
        _resetGdtSteps();
        const step1 = document.getElementById('gdtStep1');
        if (step1) step1.classList.add('gdt-step-active');
        // Highlight default symbol in scrollable list
        _setGdtSymbolSelection('perpendicularity');
        _updateDatumDropdowns();
        _updateGDTPreview();
      });
    }

    // ── 데이텀 추가 버튼 ──
    const btnAddDatum = document.getElementById('btnAddDatum');
    if (btnAddDatum) {
      btnAddDatum.addEventListener('click', () => {
        const selected = getSelected();
        if (!selected) return;
        // 이미 부착된 데이텀이 있으면 편집 모드
        const existDat = _doc.elements.find(e => e.type === 'datum' && e.attachTo === selected.id);
        if (existDat) {
          selectElement(existDat.id);
          return;
        }
        // 데이텀 편집 UI 표시
        const datumEditArea = document.getElementById('datumEditArea');
        const gdtActionButtons = document.getElementById('gdtActionButtons');
        if (datumEditArea) datumEditArea.style.display = 'block';
        if (gdtActionButtons) gdtActionButtons.style.display = 'none';
        // 다음 사용 가능한 데이텀 문자 자동 선택 (A → B → C → ...)
        const usedLetters = _doc.elements.filter(e => e.type === 'datum').map(e => e.letter);
        const allLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
        const nextLetter = allLetters.find(l => !usedLetters.includes(l)) || 'A';
        const letterSelect = document.getElementById('datumLetterSelect');
        if (letterSelect) {
          letterSelect.value = nextLetter;
          // Update datum preview letter
          const previewLetter = document.getElementById('datumPreviewLetter');
          if (previewLetter) previewLetter.textContent = nextLetter;
        }
      });
    }

    // ── 기하공차 적용 버튼 ──
    const btnGDTApply = document.getElementById('btnGDTApply');
    if (btnGDTApply) {
      btnGDTApply.addEventListener('click', () => {
        const selected = getSelected();
        if (!selected) return;

        // Step 1: 공차 종류 (스크롤 목록에서 선택됨)
        const symbolType = document.getElementById('gdtSymbolSelect').value;
        if (!symbolType) {
          App.showToast('공차 종류를 선택하세요', 'error');
          return;
        }

        // Step 2: 공차 수치 (필수)
        const value = document.getElementById('gdtValueInput').value.trim();
        if (!value) {
          App.showToast('공차 수치를 입력하세요', 'error');
          document.getElementById('gdtValueInput').focus();
          return;
        }

        // Step 3: 데이텀 참조 (선택 사항)
        // "Datum" 체크박스 ON 상태에서 데이텀 미선택 → "no datum" 표시
        const datumCheck = document.getElementById('gdtDatumCheck');
        const datumEnabled = !!(datumCheck && datumCheck.checked);
        let datum = null;
        if (datumEnabled) {
          const datumSel = document.getElementById('gdtDatumSelect');
          datum = datumSel ? datumSel.value : null;
          if (!datum) datum = null; // 데이텀 미선택 → null → '—' 표시
        }

        // 스택 (추가 공차) — 복수 공차 수직 적층
        const stacked = [];
        const stackCheck = document.getElementById('gdtStackCheck');
        if (stackCheck && stackCheck.checked) {
          const stackSym = document.getElementById('gdtStackSymbol').value;
          const stackVal = document.getElementById('gdtStackValue').value.trim();
          const stackDat = document.getElementById('gdtStackDatum').value || null;
          if (stackVal) {
            stacked.push({ symbolType: stackSym, value: stackVal, datum: stackDat || null });
          }
        }

        // ★ v33: 기존에 같은 요소에 부착된 기하공차 모두 제거 (중복 방지)
        for (let i = _doc.elements.length - 1; i >= 0; i--) {
          if (_doc.elements[i].type === 'geotolerance' && _doc.elements[i].attachTo === selected.id) {
            _doc.elements.splice(i, 1);
          }
        }

        // 부착 위치 계산 — 치수선에 수평으로 지시선을 연결
        let gdtX, gdtY, leaderX, leaderY, leaderSide = 'left';
        let useElbow = false;  // ★ v37: 수직 치수용 직각 꺾임 플래그
        const bounds = DrawingModel.getElementBounds(selected);

        // 좁은 면(narrow face) 판별: 면 길이 < 20px
        let isNarrowFace = false;

        // ★ v32: 치수선에 수평으로 지시선을 연결해서 공차값을 표시
        //   치수선 끝점에서 수평으로 공차 박스까지 연결
        //   화살표는 치수선(면)을 가리킴
        if (selected.type === 'outline') {
          const isH = Math.abs(selected.y2 - selected.y1) < Math.abs(selected.x2 - selected.x1);
          const faceLen = isH
            ? Math.abs(selected.x2 - selected.x1)
            : Math.abs(selected.y2 - selected.y1);
          isNarrowFace = faceLen < 20;

          // ★ v32: 공차 박스의 수직 중심이 치수선/면과 같은 Y에 위치하도록
          //        gdtY = leaderY - CELL_H/2 (CELL_H=8, 따라서 -4)
          //        이렇게 하면 connY = gdtY + 4 = leaderY → 완전 수평 지시선
          if (isH) {
            // 수평 외형선 → 우측에 수평 지시선으로 연결
            const rightX = Math.max(selected.x1, selected.x2);
            const midY = (selected.y1 + selected.y2) / 2;
            gdtX = rightX + 12;
            gdtY = midY - 4; // 박스 중심 = midY
            leaderX = rightX;
            leaderY = midY;
            leaderSide = 'left';
          } else {
            // 수직 외형선 → 우측에 수평 지시선으로 연결
            const midY = (selected.y1 + selected.y2) / 2;
            const faceX = Math.max(selected.x1, selected.x2);
            gdtX = faceX + 12;
            gdtY = midY - 4;
            leaderX = faceX;
            leaderY = midY;
            leaderSide = 'left';
          }
        } else if (selected.type === 'dimension') {
          const isH = Math.abs(selected.y2 - selected.y1) < Math.abs(selected.x2 - selected.x1);
          const offset = selected.offset || 30;
          const dimLen = isH
            ? Math.abs(selected.x2 - selected.x1)
            : Math.abs(selected.y2 - selected.y1);
          isNarrowFace = dimLen < 20;

          if (isH) {
            // 수평 치수 → 치수선 우측 끝점에서 수평으로 공차 박스 연결
            const dimLineY = Math.min(selected.y1, selected.y2) - offset;
            const rightX = Math.max(selected.x1, selected.x2);
            gdtX = rightX + 12;
            gdtY = dimLineY - 4; // 박스 중심 = dimLineY → 수평
            leaderX = rightX;
            leaderY = dimLineY;
            leaderSide = 'left';
          } else {
            // ★ v37: 수직 치수 → 직각 꺾임(엘보) 지시선
            //   치수선 하단 끝점에서 수평으로 나간 뒤 수직으로 꺾어 박스 상단에 연결
            const dimLineX = Math.min(selected.x1, selected.x2) - offset;
            const bottomY = Math.max(selected.y1, selected.y2);
            // 박스는 치수선 좌측 아래에 배치 (수평 구간이 보이도록 충분히 오프셋)
            gdtX = dimLineX - 48;   // 박스 좌측 X (치수선에서 좌측으로)
            gdtY = bottomY + 12;    // 박스 상단 Y = 끝점 아래 12px
            leaderX = dimLineX;
            leaderY = bottomY;      // 화살촉이 치수선 하단 끝점을 가리킴
            leaderSide = 'left';
            useElbow = true;        // ★ v37: 직각 꺾임 활성화
          }
        } else {
          gdtX = bounds.x + bounds.width + 12;
          gdtY = bounds.y + bounds.height / 2 - 4;
          leaderX = bounds.x + bounds.width;
          leaderY = bounds.y + bounds.height / 2;
          leaderSide = 'left';
        }

        const gdt = DrawingModel.createGeometricTolerance(
          gdtX, gdtY, symbolType, value, datum, selected.id,
          { leaderSide, stacked, confidence: 'confirmed' }
        );
        gdt._leaderX = leaderX;
        gdt._leaderY = leaderY;
        gdt._leaderElbow = useElbow;  // ★ v37: 수직 치수용 직각 꺾임
        // 데이텀 체크 ON이지만 실제 데이텀 미선택 시 '—' 표시를 위한 플래그
        gdt._datumEnabled = datumEnabled;

        // 데이텀+공차 동시 표시:
        // 같은 면에 이미 데이텀이 부착되어 있으면 → 공차 박스 아래에 데이텀 기호 배치
        const existDatum = _doc.elements.find(e => e.type === 'datum' && e.attachTo === selected.id);
        if (existDatum) {
          gdt._attachedDatumLetter = existDatum.letter;
        }

        _doc.elements.push(gdt);
        _doc.meta.updatedAt = new Date().toISOString();

        // 편집 UI 숨기기 — 적용 후 편집 영역을 닫고 결과를 보여줌
        const gdtEditAreaEl = document.getElementById('gdtEditArea');
        if (gdtEditAreaEl) gdtEditAreaEl.style.display = 'none';
        _resetGdtSteps();

        const symInfo = DrawingModel.GDT_SYMBOLS[symbolType] || {};
        History.push(_doc.elements, `기하공차 추가: ${symInfo.label || symbolType}`);
        Renderer.render(_doc);
        selectElement(gdt.id);
        App.showToast(`기하공차가 추가되었습니다: ${symInfo.symbol || ''} ${symInfo.label || symbolType}`, 'success');
      });
    }

    // ── 기하공차 취소 버튼 ──
    const btnGDTCancel = document.getElementById('btnGDTCancel');
    if (btnGDTCancel) {
      btnGDTCancel.addEventListener('click', () => {
        const gdtEditArea = document.getElementById('gdtEditArea');
        if (gdtEditArea) gdtEditArea.style.display = 'none';
        _resetGdtSteps();
        const selected = getSelected();
        if (selected) showProperties(selected);
      });
    }

    // ── 데이텀 적용 버튼 ──
    const btnDatumApply = document.getElementById('btnDatumApply');
    if (btnDatumApply) {
      btnDatumApply.addEventListener('click', () => {
        const selected = getSelected();
        if (!selected) return;

        const letter = document.getElementById('datumLetterSelect').value;

        // 같은 문자의 데이텀이 이미 있는지 확인
        const existSameLetter = _doc.elements.find(e => e.type === 'datum' && e.letter === letter);
        if (existSameLetter) {
          App.showToast(`데이텀 ${letter}는 이미 사용 중입니다`, 'error');
          return;
        }

        // 좁은 면(narrow face) 판별: 면 길이 < 20px → 치수보조선 바깥에 배치
        let isNarrowFace = false;
        let extLineEndX = null, extLineEndY = null;

        // ★ v41-fix: 부착 위치 계산 — 데이텀은 반드시 부품 외형선 바깥으로 표시
        //   원칙: 좌변→좌측, 우변→우측, 윗변→위쪽, 아랫변→아래쪽
        //   부품 바운딩박스 중심을 기준으로 외형선이 어느 쪽에 있는지 판별

        // ── 부품 외형선 전체의 바운딩박스 중심 계산 ──
        const _outlines = _doc.elements.filter(e => e.type === 'outline');
        let _partCx = 0, _partCy = 0;
        if (_outlines.length > 0) {
          let _mnX = Infinity, _mnY = Infinity, _mxX = -Infinity, _mxY = -Infinity;
          _outlines.forEach(o => {
            _mnX = Math.min(_mnX, o.x1, o.x2);
            _mnY = Math.min(_mnY, o.y1, o.y2);
            _mxX = Math.max(_mxX, o.x1, o.x2);
            _mxY = Math.max(_mxY, o.y1, o.y2);
          });
          _partCx = (_mnX + _mxX) / 2;
          _partCy = (_mnY + _mxY) / 2;
        }

        let datX, datY, datSide = 'bottom';
        if (selected.type === 'outline') {
          const isH = Math.abs(selected.y2 - selected.y1) < Math.abs(selected.x2 - selected.x1);
          const faceLen = isH
            ? Math.abs(selected.x2 - selected.x1)
            : Math.abs(selected.y2 - selected.y1);
          isNarrowFace = faceLen < 20;

          if (isH) {
            // 수평 외형선
            datX = (selected.x1 + selected.x2) / 2;
            const lineY = (selected.y1 + selected.y2) / 2;
            if (lineY < _partCy) {
              // 윗변 → 데이텀을 위쪽(top)으로
              datY = Math.min(selected.y1, selected.y2);
              datSide = 'top';
            } else {
              // 아랫변 → 데이텀을 아래쪽(bottom)으로
              datY = Math.max(selected.y1, selected.y2);
              datSide = 'bottom';
            }
            if (isNarrowFace) {
              extLineEndX = Math.max(selected.x1, selected.x2);
            }
          } else {
            // 수직 외형선
            datY = (selected.y1 + selected.y2) / 2;
            const lineX = (selected.x1 + selected.x2) / 2;
            if (lineX < _partCx) {
              // 좌변 → 데이텀을 왼쪽(left)으로
              datX = Math.min(selected.x1, selected.x2);
              datSide = 'left';
            } else {
              // 우변 → 데이텀을 오른쪽(right)으로
              datX = Math.max(selected.x1, selected.x2);
              datSide = 'right';
            }
            if (isNarrowFace) {
              extLineEndY = Math.min(selected.y1, selected.y2);
            }
          }
        } else if (selected.type === 'dimension') {
          const isH = Math.abs(selected.y2 - selected.y1) < Math.abs(selected.x2 - selected.x1);
          const offset = selected.offset || 30;
          const dimLen = isH
            ? Math.abs(selected.x2 - selected.x1)
            : Math.abs(selected.y2 - selected.y1);
          isNarrowFace = dimLen < 20;

          if (isH) {
            // 수평 치수선
            datX = (selected.x1 + selected.x2) / 2;
            const lineY = (selected.y1 + selected.y2) / 2;
            if (lineY < _partCy) {
              datY = Math.min(selected.y1, selected.y2);
              datSide = 'top';
            } else {
              datY = Math.max(selected.y1, selected.y2);
              datSide = 'bottom';
            }
            if (isNarrowFace) {
              extLineEndX = Math.max(selected.x1, selected.x2);
            }
          } else {
            // 수직 치수선
            datY = (selected.y1 + selected.y2) / 2;
            const lineX = (selected.x1 + selected.x2) / 2;
            if (lineX < _partCx) {
              datX = Math.min(selected.x1, selected.x2);
              datSide = 'left';
            } else {
              datX = Math.max(selected.x1, selected.x2);
              datSide = 'right';
            }
            if (isNarrowFace) {
              extLineEndY = Math.max(selected.y1, selected.y2);
            }
          }
        } else {
          // 기타 요소 → 바운딩 박스 중심 기준 판별
          const bounds2 = DrawingModel.getElementBounds(selected);
          datX = bounds2.x + bounds2.width / 2;
          datY = bounds2.y + bounds2.height / 2;
          datSide = 'bottom';
        }

        const dat = DrawingModel.createDatum(datX, datY, letter, selected.id, datSide);
        // 좁은 면일 때 보조선 바깥 배치를 위한 메타 정보
        if (isNarrowFace) {
          dat._narrowFace = true;
          if (extLineEndX != null) dat._extLineEndX = extLineEndX;
          if (extLineEndY != null) dat._extLineEndY = extLineEndY;
        }

        _doc.elements.push(dat);
        _doc.meta.updatedAt = new Date().toISOString();

        // 데이텀+공차 동시 표시:
        // 같은 면에 이미 공차가 있으면 → 공차 박스 아래에 데이텀 표시 연결
        const existGDT = _doc.elements.find(e => e.type === 'geotolerance' && e.attachTo === selected.id);
        if (existGDT) {
          existGDT._attachedDatumLetter = letter;
        }

        // 편집 UI 숨기기 — 적용 후 편집 영역을 닫고 결과를 보여줌
        const datumEditAreaEl = document.getElementById('datumEditArea');
        if (datumEditAreaEl) datumEditAreaEl.style.display = 'none';

        History.push(_doc.elements, `데이텀 추가: ${letter}`);
        Renderer.render(_doc);
        selectElement(dat.id);
        App.showToast(`데이텀 ${letter}가 추가되었습니다`, 'success');
      });
    }

    // ── 데이텀 취소 버튼 ──
    const btnDatumCancel = document.getElementById('btnDatumCancel');
    if (btnDatumCancel) {
      btnDatumCancel.addEventListener('click', () => {
        const datumEditArea = document.getElementById('datumEditArea');
        if (datumEditArea) datumEditArea.style.display = 'none';
        const selected = getSelected();
        if (selected) showProperties(selected);
      });
    }

    // ── 기하공차 데이텀 체크박스 토글 ──
    // 체크 ON: 데이텀 선택 드롭다운 표시
    // 체크 OFF: 데이텀 없이 공차만 표시
    // 데이텀이 아직 없으면 "no datum" 안내 표시
    const gdtDatumCheck = document.getElementById('gdtDatumCheck');
    if (gdtDatumCheck) {
      gdtDatumCheck.addEventListener('change', () => {
        const datumArea = document.getElementById('gdtDatumSelectArea');
        const noDatumHint = document.getElementById('gdtNoDatumHint');
        if (datumArea) datumArea.style.display = gdtDatumCheck.checked ? 'block' : 'none';
        // 데이텀 없음 안내: 체크 ON인데 데이텀이 하나도 없으면 "no datum" 표시
        if (noDatumHint) {
          const datumSel = document.getElementById('gdtDatumSelect');
          const hasDatums = datumSel && datumSel.options.length > 1;
          noDatumHint.style.display = (gdtDatumCheck.checked && !hasDatums) ? 'block' : 'none';
        }
      });
    }

    // ── 기하공차 스택(적층) 체크박스 토글 ──
    // 복수 공차를 같은 feature에 수직 적층
    const gdtStackCheck = document.getElementById('gdtStackCheck');
    if (gdtStackCheck) {
      gdtStackCheck.addEventListener('change', () => {
        const stackArea = document.getElementById('gdtStackArea');
        if (stackArea) stackArea.style.display = gdtStackCheck.checked ? 'block' : 'none';
      });
    }

    // ── 기하공차 입력 순서 강제 ──
    // 순서: 면 선택(이미 완료) → 공차 종류 선택(Step 1) → 수치 입력(Step 2) → 데이텀 체크(Step 3)

    // Step 1: 카드형 스크롤 목록 클릭 핸들러
    const gdtSymbolScrollList = document.getElementById('gdtSymbolScrollList');
    const gdtSymbolSelect = document.getElementById('gdtSymbolSelect');
    if (gdtSymbolScrollList) {
      gdtSymbolScrollList.addEventListener('click', (e) => {
        const card = e.target.closest('.gdt-symbol-item');
        if (!card) return;
        const sym = card.dataset.symbol;
        if (!sym) return;
        // 선택 상태 업데이트
        gdtSymbolScrollList.querySelectorAll('.gdt-symbol-item').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        // hidden select 동기화
        if (gdtSymbolSelect) gdtSymbolSelect.value = sym;
        // Step 2 활성화
        const valInput = document.getElementById('gdtValueInput');
        const step2 = document.getElementById('gdtStep2');
        if (valInput) { valInput.disabled = false; valInput.focus(); }
        if (step2) step2.classList.add('gdt-step-active');
        // 미리보기 업데이트
        _updateGDTPreview();
      });
    }
    // hidden select change 호환 (fallback)
    if (gdtSymbolSelect) {
      gdtSymbolSelect.addEventListener('change', () => {
        const valInput = document.getElementById('gdtValueInput');
        const step2 = document.getElementById('gdtStep2');
        if (gdtSymbolSelect.value) {
          if (valInput) { valInput.disabled = false; valInput.focus(); }
          if (step2) step2.classList.add('gdt-step-active');
        }
        // 카드 목록 동기화
        if (gdtSymbolScrollList) {
          gdtSymbolScrollList.querySelectorAll('.gdt-symbol-item').forEach(c => {
            c.classList.toggle('selected', c.dataset.symbol === gdtSymbolSelect.value);
          });
        }
        _updateGDTPreview();
      });
    }

    // Step 2: 수치 입력 → Step 3 활성화
    const gdtValueInput = document.getElementById('gdtValueInput');
    if (gdtValueInput) {
      gdtValueInput.addEventListener('input', () => {
        const step3 = document.getElementById('gdtStep3');
        const datumCheckEl = document.getElementById('gdtDatumCheck');
        if (gdtValueInput.value.trim()) {
          if (step3) step3.classList.add('gdt-step-active');
          if (datumCheckEl) datumCheckEl.disabled = false;
        } else {
          if (step3) step3.classList.remove('gdt-step-active');
          if (datumCheckEl) datumCheckEl.disabled = true;
        }
        _updateGDTPreview();
      });
    }

    // ── 기하공차 편집 닫기 버튼 (X) ──
    const btnGDTEditClose = document.getElementById('btnGDTEditClose');
    if (btnGDTEditClose) {
      btnGDTEditClose.addEventListener('click', () => {
        const gdtEditArea = document.getElementById('gdtEditArea');
        if (gdtEditArea) gdtEditArea.style.display = 'none';
        _resetGdtSteps();
        const selected = getSelected();
        if (selected) showProperties(selected);
      });
    }

    // ── 데이텀 편집 닫기 버튼 (X) ──
    const btnDatumEditClose = document.getElementById('btnDatumEditClose');
    if (btnDatumEditClose) {
      btnDatumEditClose.addEventListener('click', () => {
        const datumEditArea = document.getElementById('datumEditArea');
        if (datumEditArea) datumEditArea.style.display = 'none';
        const selected = getSelected();
        if (selected) showProperties(selected);
      });
    }

    // ── 데이텀 문자 선택 → 미리보기 업데이트 ──
    const datumLetterSelect = document.getElementById('datumLetterSelect');
    if (datumLetterSelect) {
      datumLetterSelect.addEventListener('change', () => {
        const previewLetter = document.getElementById('datumPreviewLetter');
        if (previewLetter) previewLetter.textContent = datumLetterSelect.value;
      });
    }

    // ── 데이텀 체크 변경 시 미리보기 업데이트 ──
    if (gdtDatumCheck) {
      const origHandler = gdtDatumCheck.onchange;
      gdtDatumCheck.addEventListener('change', () => { _updateGDTPreview(); });
    }
    const gdtDatumSelectEl = document.getElementById('gdtDatumSelect');
    if (gdtDatumSelectEl) {
      gdtDatumSelectEl.addEventListener('change', () => { _updateGDTPreview(); });
    }
  }

  /**
   * GDT 스텝 초기화 — 모든 스텝에서 활성 클래스 제거
   */
  function _resetGdtSteps() {
    ['gdtStep1', 'gdtStep2', 'gdtStep3'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('gdt-step-active');
    });
    // Also reset the stack step if present
    const stackStep = document.querySelector('.gdt-step-stack');
    if (stackStep) stackStep.classList.remove('gdt-step-active');
  }

  /**
   * 스크롤 가능 기호 목록에서 선택 상태 설정
   */
  function _setGdtSymbolSelection(symbolKey) {
    const scrollList = document.getElementById('gdtSymbolScrollList');
    if (!scrollList) return;
    scrollList.querySelectorAll('.gdt-symbol-item').forEach(item => {
      item.classList.toggle('selected', item.getAttribute('data-symbol') === symbolKey);
    });
    // Sync hidden select
    const symSelect = document.getElementById('gdtSymbolSelect');
    if (symSelect) symSelect.value = symbolKey;
  }

  /**
   * GD&T 미리보기 SVG 업데이트
   */
  function _updateGDTPreview() {
    const svg = document.getElementById('gdtPreviewSvg');
    if (!svg) return;
    const symSelect = document.getElementById('gdtSymbolSelect');
    const valInput = document.getElementById('gdtValueInput');
    const datumCheck = document.getElementById('gdtDatumCheck');
    const datumSelect = document.getElementById('gdtDatumSelect');

    const symType = symSelect ? symSelect.value : 'perpendicularity';
    const symInfo = (typeof DrawingModel !== 'undefined' && DrawingModel.GDT_SYMBOLS)
      ? DrawingModel.GDT_SYMBOLS[symType] : null;
    const symChar = symInfo ? symInfo.symbol : '?';
    const val = valInput ? valInput.value.trim() || '0.003' : '0.003';
    const hasDatum = datumCheck && datumCheck.checked;
    const datumLetter = (hasDatum && datumSelect && datumSelect.value) ? datumSelect.value : '';

    const SYM_W = 38, VAL_W = 42, DAT_W = datumLetter ? 24 : (hasDatum ? 24 : 0);
    const totalW = SYM_W + VAL_W + DAT_W;
    const H = 24, Y = 8;
    const cx = 100; // center of viewbox
    const x0 = cx - totalW / 2;

    let svgContent = '';
    // outer box
    svgContent += `<rect x="${x0}" y="${Y}" width="${totalW}" height="${H}" fill="none" stroke="#f59e0b" stroke-width="0.8"/>`;
    // symbol | value separator
    svgContent += `<line x1="${x0 + SYM_W}" y1="${Y}" x2="${x0 + SYM_W}" y2="${Y + H}" stroke="#f59e0b" stroke-width="0.5"/>`;
    // symbol text
    svgContent += `<text x="${x0 + SYM_W / 2}" y="${Y + H / 2 + 4}" text-anchor="middle" font-size="12" fill="#f59e0b" font-family="'Noto Sans', Arial, sans-serif">${symChar}</text>`;
    // value text
    svgContent += `<text x="${x0 + SYM_W + VAL_W / 2}" y="${Y + H / 2 + 3}" text-anchor="middle" font-size="9" fill="#e2e8f0" font-family="JetBrains Mono, monospace">${val}</text>`;
    // datum cell
    if (DAT_W > 0) {
      svgContent += `<line x1="${x0 + SYM_W + VAL_W}" y1="${Y}" x2="${x0 + SYM_W + VAL_W}" y2="${Y + H}" stroke="#f59e0b" stroke-width="0.5"/>`;
      const datDisplay = datumLetter || '—';
      const datColor = datumLetter ? '#8b5cf6' : '#666';
      svgContent += `<text x="${x0 + SYM_W + VAL_W + DAT_W / 2}" y="${Y + H / 2 + 3}" text-anchor="middle" font-size="9" fill="${datColor}" font-weight="600">${datDisplay}</text>`;
    }
    svg.innerHTML = svgContent;
  }

  /**
   * 부착된 GDT/Datum 요약 표시 업데이트
   */
  function _updateAttachedSummary(targetId) {
    const summaryDiv = document.getElementById('gdtAttachedSummary');
    const listDiv = document.getElementById('gdtAttachedList');
    if (!summaryDiv || !listDiv || !_doc) return;

    const attached = _doc.elements.filter(e =>
      (e.type === 'geotolerance' || e.type === 'datum') && e.attachTo === targetId
    );

    if (attached.length === 0) {
      summaryDiv.style.display = 'none';
      return;
    }

    summaryDiv.style.display = 'block';
    listDiv.innerHTML = '';
    attached.forEach(el => {
      const tag = document.createElement('div');
      if (el.type === 'geotolerance') {
        const symInfo = DrawingModel.GDT_SYMBOLS[el.symbolType] || {};
        tag.className = 'gdt-attached-tag gdt-attached-tag-gdt';
        tag.innerHTML = `<span class="tag-symbol">${symInfo.symbol || '?'}</span>` +
          `<span class="tag-value">${el.value || ''}</span>` +
          (el.datum ? `<span style="color:#8b5cf6;font-weight:600;">${el.datum}</span>` : '') +
          (el.stacked && el.stacked.length > 0 ? `<span style="color:var(--text-muted);font-size:9px;">+${el.stacked.length}</span>` : '');
      } else {
        tag.className = 'gdt-attached-tag gdt-attached-tag-datum';
        tag.innerHTML = `<span class="tag-symbol">▲</span><span>데이텀 ${el.letter}</span>`;
      }
      tag.addEventListener('click', () => selectElement(el.id));
      listDiv.appendChild(tag);
    });
  }

  // ========== Mouse Handlers ==========
  function onMouseDown(e) {
    const { clientX, clientY } = e;

    if (e.button === 1 || _tool === 'move') {
      _isPanning = true;
      _panStart = { x: clientX, y: clientY };
      _panOffsetStart = { ..._panOffset };
      e.preventDefault();
      return;
    }

    if (_tool === 'select') {
      const hit = hitTest(clientX, clientY);
      if (hit) {
        selectElement(hit.id);
        _dragging = true;
        _dragStart = clientToSvg(clientX, clientY);
        _dragOriginal = JSON.parse(JSON.stringify(hit));
        // ★ v120: 그룹 드래그 — 그룹 내 모든 요소의 원본 좌표 저장
        const groupEls = _getGroupElements(hit);
        if (groupEls.length > 1) {
          _dragGroupOriginals = groupEls.map(ge => JSON.parse(JSON.stringify(ge)));
        } else {
          _dragGroupOriginals = null;
        }
      } else {
        deselectAll();
      }
    }

    // outline 도구 — 외형선 그리기
    if (_tool === 'outline') {
      const pt = clientToSvg(clientX, clientY);
      const snapped = snapToGrid(pt);
      if (!_lineDrawing) {
        _lineDrawing = true;
        _lineStart = snapped;
      } else {
        const newEl = DrawingModel.createOutline(_lineStart.x, _lineStart.y, snapped.x, snapped.y, 2);
        _doc.elements.push(newEl);
        History.push(_doc.elements, '외형선 추가');
        Renderer.render(_doc);
        App.showToast('외형선이 추가되었습니다', 'success');
        _lineDrawing = false;
        _lineStart = null;
        if (_tempLineEl) { _tempLineEl.remove(); _tempLineEl = null; }
      }
    }

    if (_tool === 'text') {
      const pt = clientToSvg(clientX, clientY);
      const snapped = snapToGrid(pt);
      const text = DrawingModel.createText(snapped.x, snapped.y, '텍스트', 14);
      _doc.elements.push(text);
      History.push(_doc.elements, '텍스트 추가');
      Renderer.render(_doc);
      selectElement(text.id);
      setTimeout(() => startInlineEdit(text, clientX, clientY), 100);
    }

    if (_tool === 'eraser') {
      const hit = hitTest(clientX, clientY);
      if (hit) deleteElement(hit.id);
    }
  }

  function onMouseMove(e) {
    const { clientX, clientY } = e;

    const pt = clientToSvg(clientX, clientY);
    const posEl = document.getElementById('cursorPos');
    if (posEl) posEl.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;

    if (_isPanning) {
      _panOffset.x = _panOffsetStart.x + (clientX - _panStart.x);
      _panOffset.y = _panOffsetStart.y + (clientY - _panStart.y);
      applyTransform();
      return;
    }

    if (_dragging && _selectedId) {
      const current = clientToSvg(clientX, clientY);
      const dx = current.x - _dragStart.x;
      const dy = current.y - _dragStart.y;

      // ★ v120: 그룹 드래그 — 그룹 내 모든 요소를 동시에 이동
      if (_dragGroupOriginals && _dragGroupOriginals.length > 1) {
        // ★ v143: 지시선 주석 그룹(KEY/TAP 등)은 "화살머리 고정 + 나머지 이동"
        const isLeaderGroup = _isLeaderAnnotationGroup(_dragGroupOriginals);
        _dragGroupOriginals.forEach(orig => {
          const liveEl = _doc.elements.find(e => e.id === orig.id);
          if (!liveEl) return;
          if (isLeaderGroup) {
            _applyLeaderGroupDelta(liveEl, orig, dx, dy);
          } else {
            _applyDragDelta(liveEl, orig, dx, dy, true); // 형상 그룹: 평행이동
          }
        });
        Renderer.render(_doc);
        const el = _doc.elements.find(e => e.id === _selectedId);
        if (el) {
          const groupEls = _getGroupElements(el);
          Renderer.showSelection(el, groupEls);
        }
      } else {
        // 단일 요소 드래그 (기존 로직)
        const el = _doc.elements.find(e => e.id === _selectedId);
        if (el && _dragOriginal) {
          _applyDragDelta(el, _dragOriginal, dx, dy);
          Renderer.render(_doc);
          Renderer.showSelection(el);
        }
      }
    }

    if (_tool === 'outline' && _lineDrawing && _lineStart) {
      const current = clientToSvg(clientX, clientY);
      const snapped = snapToGrid(current);
      drawTempLine(_lineStart, snapped);
    }
  }

  function onMouseUp(e) {
    if (_isPanning) { _isPanning = false; return; }

    if (_dragging && _selectedId) {
      _dragging = false;
      const el = _doc.elements.find(e => e.id === _selectedId);
      if (el) {
        // ★ v120: 그룹 이동 완료 시 그룹 라벨로 히스토리 기록
        if (_dragGroupOriginals && _dragGroupOriginals.length > 1 && el._groupId) {
          History.push(_doc.elements, `${_getGroupLabel(el._groupId)} 그룹 이동`);
        } else {
          History.push(_doc.elements, `${getTypeLabel(el.type)} 이동`);
        }
        showProperties(el);
      }
      _dragOriginal = null;
      _dragGroupOriginals = null;
    }
  }

  function onDoubleClick(e) {
    if (_tool !== 'select') return;

    // v7: 표제란(titleblock) 셀/하단 더블클릭 편집 — SVG 요소에서 직접 확인
    const svgTarget = e.target;
    if (svgTarget && svgTarget.getAttribute && svgTarget.getAttribute('data-editable') === 'true') {
      const tbGroup = svgTarget.closest('[data-type="titleblock"]');
      if (tbGroup) {
        const tbId = tbGroup.getAttribute('data-id');
        const tbEl = _doc.elements.find(el => el.id === tbId);
        if (!tbEl || tbEl.type !== 'titleblock') { /* skip */ }
        else {
          // 하단 정보 블록 편집
          const btmField = svgTarget.getAttribute('data-bottom-field');
          if (btmField) {
            startTitleBlockBottomEdit(tbEl, btmField, e.clientX, e.clientY);
            return;
          }
          // itemRow 셀 편집
          const rowIdx = parseInt(svgTarget.getAttribute('data-row-index'));
          const field = svgTarget.getAttribute('data-field');
          if (!isNaN(rowIdx) && field) {
            startTitleBlockCellEdit(tbEl, rowIdx, field, e.clientX, e.clientY);
            return;
          }
        }
      }
    }

    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;

    // v7: titleblock 전체 더블클릭 → 첫 번째 편집 가능 itemRow의 partName 편집
    if (hit.type === 'titleblock') {
      const firstEditable = (hit.itemRows || []).findIndex(r => r.editable);
      if (firstEditable >= 0) {
        startTitleBlockCellEdit(hit, firstEditable, 'partName', e.clientX, e.clientY);
      }
      return;
    }

    // v5: placeholder 요소 더블클릭 → 편집
    if (hit._isPlaceholder && (hit.type === 'dimension' || hit.type === 'text')) {
      startPlaceholderEdit(hit, e.clientX, e.clientY);
      return;
    }

    if (hit.type === 'dimension' || hit.type === 'text') {
      startInlineEdit(hit, e.clientX, e.clientY);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(5, _zoom * delta));

    const rect = _svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    _panOffset.x = mx - (mx - _panOffset.x) * (newZoom / _zoom);
    _panOffset.y = my - (my - _panOffset.y) * (newZoom / _zoom);
    _zoom = newZoom;

    applyTransform();
  }

  function onKeyDown(e) {
    if (document.querySelector('.inline-edit-input')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); History.undo(); return; }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); History.redo(); return; }

    if ((e.key === 'Delete' || e.key === 'Backspace') && _selectedId) {
      e.preventDefault(); deleteElement(_selectedId); return;
    }

    if (e.key === 'Escape') { deselectAll(); setTool('select'); return; }

    const toolKeys = { v: 'select', h: 'move', w: 'outline', t: 'text', e: 'eraser' };
    if (toolKeys[e.key.toLowerCase()] && !e.ctrlKey) {
      setTool(toolKeys[e.key.toLowerCase()]);
    }
  }

  // ========== Helpers ==========
  function snapToGrid(pt, gridSize = 10) {
    return {
      x: Math.round(pt.x / gridSize) * gridSize,
      y: Math.round(pt.y / gridSize) * gridSize,
    };
  }

  function drawTempLine(start, end) {
    if (_tempLineEl) _tempLineEl.remove();
    const NS = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', start.x);
    line.setAttribute('y1', start.y);
    line.setAttribute('x2', end.x);
    line.setAttribute('y2', end.y);
    line.setAttribute('stroke', '#60a5fa');
    line.setAttribute('stroke-width', 2 / _zoom);
    line.setAttribute('stroke-dasharray', `${5 / _zoom} ${3 / _zoom}`);
    const group = document.getElementById('outlinesGroup');
    if (group) group.appendChild(line);
    _tempLineEl = line;
  }

  /**
   * v5: placeholder 요소 전용 편집기
   * 편집 완료 시 _isPlaceholder = false, confidence = confirmed
   */
  function startPlaceholderEdit(el, clientX, clientY) {
    const existing = document.querySelector('.inline-edit-input');
    if (existing) existing.remove();

    const input = document.createElement('input');
    input.className = 'inline-edit-input placeholder-edit';
    input.type = 'text';
    input.placeholder = '값을 입력하세요';

    // 기존 placeholder 텍스트는 지우고 빈 값으로 시작
    if (el.type === 'dimension') {
      input.value = (el.value === '?' || el.value === '⌀?') ? '' : el.value;
      input.placeholder = el.dimStyle === 'diameter' ? 'φ 직경값 입력' : '치수값 입력';
    } else if (el.type === 'text') {
      const isPholder = el.content.includes('____') || el.content.includes('직접입력')
        || el.content.includes('📝') || el.content.includes('미확정');
      input.value = isPholder ? '' : el.content;
      input.placeholder = '텍스트 입력';
    }

    input.style.left = `${clientX - 60}px`;
    input.style.top = `${clientY - 15}px`;
    input.style.minWidth = '120px';
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value.trim();
      if (newVal) {
        if (el.type === 'dimension') {
          el.value = el.dimStyle === 'diameter' ? `⌀${newVal}` : newVal;
        } else {
          el.content = newVal;
        }
        // ★ placeholder → confirmed 전환
        el._isPlaceholder = false;
        el.confidence = 'confirmed';
        _doc.meta.updatedAt = new Date().toISOString();
        History.push(_doc.elements, `placeholder 입력: ${newVal}`);
        Renderer.render(_doc);
        selectElement(el.id);
        App.showToast(`값이 입력되었습니다: ${newVal}`, 'success');
      }
      input.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', commit);
  }

  // ========== Title Block Inline Edit — KS 규격 스타일 ==========

  /**
   * 표제란 itemRow 셀 편집
   */
  function startTitleBlockCellEdit(tbEl, rowIndex, field, clientX, clientY) {
    const existing = document.querySelector('.inline-edit-input');
    if (existing) existing.remove();

    const rows = tbEl.itemRows || [];
    const row = rows[rowIndex];
    if (!row || !row.editable) return;

    const input = document.createElement('input');
    input.className = 'inline-edit-input titleblock-edit';
    input.type = 'text';
    input.value = row[field] || '';

    const placeholders = {
      partName: '품명 입력',
      material: '재질 입력 (예: S45C)',
      quantity: '수량',
      remarks: '비고',
    };
    input.placeholder = placeholders[field] || '입력';
    input.style.left = `${clientX - 60}px`;
    input.style.top = `${clientY - 15}px`;
    input.style.minWidth = '100px';
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value.trim();
      if (newVal !== (row[field] || '')) {
        row[field] = newVal;

        // 메타데이터 동기화
        if (field === 'partName') {
          _doc.meta.partName = newVal;
        } else if (field === 'material') {
          _doc.meta.material = newVal;
        } else if (field === 'quantity') {
          _doc.meta.quantity = newVal;
        } else if (field === 'remarks') {
          _doc.meta.remarks = newVal;
        }

        _doc.meta.updatedAt = new Date().toISOString();
        History.push(_doc.elements, `표제란 수정: ${field} = ${newVal}`);
        Renderer.render(_doc);
        selectElement(tbEl.id);
        App.showToast(`표제란 값이 수정되었습니다: ${newVal}`, 'success');
      }
      input.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', commit);
  }

  /**
   * 표제란 하단 정보 블록(작품명/척도/각법) 편집
   */
  function startTitleBlockBottomEdit(tbEl, bottomField, clientX, clientY) {
    const existing = document.querySelector('.inline-edit-input');
    if (existing) existing.remove();

    const btm = tbEl.bottomInfo || {};

    // 각법은 select로 처리
    if (bottomField === 'projectionMethod') {
      const sel = document.createElement('select');
      sel.className = 'inline-edit-input titleblock-edit';
      sel.innerHTML = `
        <option value="3각법" ${btm.projectionMethod === '3각법' ? 'selected' : ''}>3각법</option>
        <option value="1각법" ${btm.projectionMethod === '1각법' ? 'selected' : ''}>1각법</option>
      `;
      sel.style.left = `${clientX - 40}px`;
      sel.style.top = `${clientY - 15}px`;
      sel.style.minWidth = '80px';
      document.body.appendChild(sel);
      sel.focus();

      const commit = () => {
        const newVal = sel.value;
        if (newVal !== (btm.projectionMethod || '3각법')) {
          btm.projectionMethod = newVal;
          _doc.meta.projectionMethod = newVal;
          _doc.meta.updatedAt = new Date().toISOString();
          History.push(_doc.elements, `각법 변경: ${newVal}`);
          Renderer.render(_doc);
          selectElement(tbEl.id);
          App.showToast(`각법이 변경되었습니다: ${newVal}`, 'success');
        }
        sel.remove();
      };

      sel.addEventListener('change', commit);
      sel.addEventListener('blur', () => sel.remove());
      return;
    }

    const input = document.createElement('input');
    input.className = 'inline-edit-input titleblock-edit';
    input.type = 'text';
    input.value = btm[bottomField] || '';

    const placeholders = { title: '작품명 입력', scale: '척도 (예: 1:2)' };
    input.placeholder = placeholders[bottomField] || '입력';
    input.style.left = `${clientX - 60}px`;
    input.style.top = `${clientY - 15}px`;
    input.style.minWidth = '100px';
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value.trim();
      if (newVal !== (btm[bottomField] || '')) {
        btm[bottomField] = newVal;

        if (bottomField === 'title') {
          _doc.meta.partName = newVal;
        } else if (bottomField === 'scale') {
          _doc.meta.scale = newVal;
        }

        _doc.meta.updatedAt = new Date().toISOString();
        History.push(_doc.elements, `표제란 하단 수정: ${bottomField} = ${newVal}`);
        Renderer.render(_doc);
        selectElement(tbEl.id);
        App.showToast(`표제란 값이 수정되었습니다: ${newVal}`, 'success');
      }
      input.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', commit);
  }

  // ========== Surface Finish Dialog (다듬질 기호 추가 모달) ==========
  /**
   * 외형선/치수선 클릭 후 "다듬질 기호 추가" 버튼을 누르면 호출
   * 다듬질 등급(grade), 표준값 유형(Ra/Rmax/Rz) 선택 → 기호 생성
   */
  function showSurfaceFinishDialog(targetEl) {
    // 기존 모달 제거
    const old = document.getElementById('sfModal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'sfModal';
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
      <div class="modal sf-modal">
        <h3><i class="fas fa-wave-square" style="color:var(--accent-purple);margin-right:8px;"></i>다듬질 기호 추가</h3>
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;">
          KS 규격 다듬질 기호를 선택하세요. 표면 거칠기 표준값이 자동으로 설정됩니다.
        </p>

        <div class="form-row" style="margin-bottom:12px;">
          <span class="form-label" style="width:80px;">표준값 유형</span>
          <select class="form-select" id="sfModalValueType" style="flex:1;">
            <option value="Ra" selected>Ra (산술평균 거칠기)</option>
            <option value="Rmax">Rmax (최대 높이)</option>
            <option value="Rz">Rz (10점 평균 거칠기)</option>
          </select>
        </div>

        <div class="sf-grade-options" id="sfGradeOptions">
          <div class="sf-grade-card" data-grade="grinding">
            <div class="sf-grade-symbol">▽▽▽▽</div>
            <div class="sf-grade-info">
              <span class="sf-grade-name">연마 다듬질</span>
              <span class="sf-grade-value" data-vt="Ra">Ra 0.2a</span>
            </div>
          </div>
          <div class="sf-grade-card" data-grade="precision">
            <div class="sf-grade-symbol">▽▽▽</div>
            <div class="sf-grade-info">
              <span class="sf-grade-name">정밀 다듬질</span>
              <span class="sf-grade-value" data-vt="Ra">Ra 1.6a</span>
            </div>
          </div>
          <div class="sf-grade-card active" data-grade="normal">
            <div class="sf-grade-symbol">▽▽</div>
            <div class="sf-grade-info">
              <span class="sf-grade-name">보통 다듬질</span>
              <span class="sf-grade-value" data-vt="Ra">Ra 6.3a</span>
            </div>
          </div>
          <div class="sf-grade-card" data-grade="rough">
            <div class="sf-grade-symbol">▽</div>
            <div class="sf-grade-info">
              <span class="sf-grade-name">거친 다듬질</span>
              <span class="sf-grade-value" data-vt="Ra">Ra 25a</span>
            </div>
          </div>
          <div class="sf-grade-card" data-grade="none">
            <div class="sf-grade-symbol" style="font-size:20px;">〰</div>
            <div class="sf-grade-info">
              <span class="sf-grade-name">다듬질 안함</span>
              <span class="sf-grade-value" style="color:var(--text-muted);">기호만 표시 (값 없음)</span>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-ghost" id="sfModalCancel">취소</button>
          <button class="btn btn-primary" id="sfModalConfirm"><i class="fas fa-check"></i> 추가</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    let selectedGrade = 'normal';
    let selectedVT = 'Ra';

    // 등급 카드 클릭
    modal.querySelectorAll('.sf-grade-card').forEach(card => {
      card.addEventListener('click', () => {
        modal.querySelectorAll('.sf-grade-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        selectedGrade = card.dataset.grade;
      });
    });

    // 표준값 유형 변경 시 카드의 값 텍스트 업데이트
    const vtSelect = modal.querySelector('#sfModalValueType');
    vtSelect.addEventListener('change', () => {
      selectedVT = vtSelect.value;
      const table = DrawingModel.SURFACE_FINISH_TABLE;
      modal.querySelectorAll('.sf-grade-card').forEach(card => {
        const grade = card.dataset.grade;
        if (grade === 'none') return; // 다듬질 안함은 값 표시 불필요
        const info = table[grade];
        if (!info) return;
        const valSpan = card.querySelector('.sf-grade-value');
        if (valSpan) valSpan.textContent = `${selectedVT} ${info[selectedVT]}`;
      });
    });

    // 취소
    modal.querySelector('#sfModalCancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // 확인 → 다듬질 기호 생성
    modal.querySelector('#sfModalConfirm').addEventListener('click', () => {

      // 부착 위치 계산: KS 규격 — 선의 오른쪽 끝(모서리)에 배치
      // 참고 이미지 (a) O: 표면선의 우측 끝 모서리에 기호 배치
      //       이미지 (b) X: 중앙에 배치하면 안 됨!
      let sfX, sfY, sfRotation = 0;

      if (targetEl.type === 'outline') {
        const isH = Math.abs(targetEl.y2 - targetEl.y1) < Math.abs(targetEl.x2 - targetEl.x1);

        if (isH) {
          // 수평 외형선: 선의 오른쪽 끝 위에 배치 (KS 규격)
          sfX = Math.max(targetEl.x1, targetEl.x2);
          sfY = Math.min(targetEl.y1, targetEl.y2);
          sfRotation = 0;
        } else {
          // 수직 외형선: 선의 위쪽 끝 왼쪽에 배치 (90도 회전)
          sfX = Math.min(targetEl.x1, targetEl.x2);
          sfY = Math.min(targetEl.y1, targetEl.y2);
          sfRotation = 90;
        }
      } else if (targetEl.type === 'dimension') {
        // 치수선: 우측 끝점에 배치
        const isH = Math.abs(targetEl.y2 - targetEl.y1) < Math.abs(targetEl.x2 - targetEl.x1);
        const offsetDir = targetEl.offset || 30;
        if (isH) {
          sfX = Math.max(targetEl.x1, targetEl.x2);
          sfY = Math.min(targetEl.y1, targetEl.y2) - offsetDir;
        } else {
          sfX = Math.min(targetEl.x1, targetEl.x2) - offsetDir;
          sfY = Math.min(targetEl.y1, targetEl.y2);
        }
        sfRotation = 0;
      } else {
        sfX = targetEl.x || 0;
        sfY = targetEl.y || 0;
      }

      const sf = DrawingModel.createSurfaceFinish(sfX, sfY, selectedGrade, selectedVT, targetEl.id, sfRotation);
      _doc.elements.push(sf);
      _doc.meta.updatedAt = new Date().toISOString();
      History.push(_doc.elements, `다듬질 기호 추가: ${DrawingModel.SURFACE_FINISH_TABLE[selectedGrade].label}`);
      Renderer.render(_doc);
      selectElement(sf.id);

      const info = DrawingModel.SURFACE_FINISH_TABLE[selectedGrade];
      if (selectedGrade === 'none') {
        App.showToast(`다듬질 기호가 추가되었습니다: ${info.label}`, 'success');
      } else {
        App.showToast(`다듬질 기호가 추가되었습니다: ${info.label} (${selectedVT} ${info[selectedVT]})`, 'success');
      }
      modal.remove();
    });
  }

  function getTypeLabel(type) {
    const labels = {
      outline: '외형선', centerline: '중심선', hole: '구멍/탭',
      slot: '슬롯', hatch: '해칭', dimension: '치수', text: '텍스트',
      titleblock: '표제란', hiddenline: '숨은선', surfacefinish: '다듬질 기호',
      geotolerance: '기하공차', datum: '데이텀',
    };
    return labels[type] || type;
  }

  function getDocument() { return _doc; }

  function setDocument(doc) {
    _doc = doc;
    deselectAll();
    Renderer.render(_doc);
    fitToView();
  }

  return {
    init, setTool, getTool, selectElement, deselectAll, getSelected,
    getDocument, setDocument, zoomIn, zoomOut, fitToView,
    deleteElement, moveElement,
  };
})();

// 콘솔/검증용 전역 노출 (IIFE const는 기본적으로 window에 안 붙음)
if (typeof window !== 'undefined') window.Editor = Editor;
