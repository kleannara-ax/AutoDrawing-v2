/* ============================================================
   app.js
   AutoDrawing 메인 애플리케이션 컨트롤러 — 기계도면 전용

   파이프라인:
   손도면 업로드 → AI 형상 복제 → 편집기 (형상 초안 + placeholder)
   데모 → generateMechDemo() → 편집기

   v5: 형상 초안 + 빈 정보칸 상태로 출력
       속성 패널에 재질/표면거칠기/나사 규격/메모 placeholder 표시
   ============================================================ */

const App = (() => {
  let _currentStep = 1;
  let _uploadedFile = null;
  let _document = null;
  let _currentDrawingType = 'shaft'; // 현재 선택된 도면 유형
  let _exportTargetDoc = null; // DB탭 내보내기 시 임시 저장용
  let _currentProjectId = null;       // DB에서 열린 프로젝트의 ID (null = 신규)
  let _previousStep = 1;              // DB 화면에서 돌아갈 때 사용

  // ========== LocalStorage Key ==========
  const DB_KEY = 'autodrawing_projects';

  // ========== Init ==========
  function init() {
    // ★ v43-fix: 테스트 더미 데이터 일회성 정리
    // localStorage에 테스트 ID(tp1~tp6)만 남아있으면 제거 후 서버에서 복구
    try {
      const _raw = localStorage.getItem(DB_KEY);
      if (_raw) {
        const _arr = JSON.parse(_raw);
        const _dummyIds = ['tp1','tp2','tp3','tp4','tp5','tp6'];
        const _hasDummy = _arr.some(p => _dummyIds.includes(p.id));
        if (_hasDummy) {
          // 더미가 아닌 진짜 프로젝트만 남기기
          const _real = _arr.filter(p => !_dummyIds.includes(p.id));
          if (_real.length > 0) {
            localStorage.setItem(DB_KEY, JSON.stringify(_real));
          } else {
            localStorage.removeItem(DB_KEY); // 전부 더미면 비워서 서버 복구 유도
          }
          console.log('[DB] 테스트 더미 데이터 정리 완료');
        }
      }
    } catch(e) { /* ignore */ }

    bindTabEvents();
    bindUploadEvents();
    bindHeaderEvents();
    bindExportEvents();
    bindDBEvents();
    bindSaveDraftEvents();
    bind3DPreviewEvents();  // v121: 3D 미리보기
    updateDBBadge();
    goToStep(1);
    showToast('AutoDrawing에 오신 것을 환영합니다! 도면 유형을 선택하세요.', 'info');

    // 서버에서 프로젝트 복구 시도 (localStorage가 비어있을 경우)
    restoreFromServer();
  }

  // ========== Drawing Type Tabs ==========
  function bindTabEvents() {
    const tabs = document.querySelectorAll('.drawing-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.classList.contains('disabled')) {
          showToast('이 도면 유형은 아직 준비중입니다', 'info');
          return;
        }
        const tabType = tab.dataset.tab;
        activateTab(tabType);
      });
    });
  }

  function activateTab(tabType) {
    _currentDrawingType = tabType;
    
    // Update tab buttons
    document.querySelectorAll('.drawing-tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`.drawing-tab[data-tab="${tabType}"]`);
    if (activeTab) activeTab.classList.add('active');

    // Update tab panels
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panelId = 'tabPanel' + tabType.charAt(0).toUpperCase() + tabType.slice(1);
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active');

    // Reset upload state when switching tabs
    resetUpload();
  }

  // ========== Step Navigation ==========
  function goToStep(step) {
    _currentStep = step;

    document.querySelectorAll('.screen').forEach(s => {
      s.classList.remove('active');
      s.style.removeProperty('display'); // ★ inline style 잔여물 제거
    });
    const screens = { 1: 'screenHome', 2: 'screenAI', 3: 'screenEditor' };
    const target = document.getElementById(screens[step]);
    if (target) target.classList.add('active');

    document.querySelectorAll('.step-item').forEach(item => {
      const s = parseInt(item.dataset.step);
      item.classList.remove('active', 'completed');
      if (s < step) item.classList.add('completed');
      if (s === step) item.classList.add('active');
    });

    document.querySelectorAll('.step-connector').forEach((conn, i) => {
      conn.classList.toggle('completed', i + 1 < step);
    });

    document.getElementById('btnExport').disabled = step !== 3;
    document.getElementById('btnSaveDraft').disabled = step !== 3;
  }

  // ========== Upload ==========
  function bindUploadEvents() {
    // Shaft-specific upload zone
    const zone = document.getElementById('shaftUploadZone');
    const fileInput = document.getElementById('fileInput');

    if (zone) {
      zone.addEventListener('click', () => fileInput.click());

      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
      });

      zone.addEventListener('dragleave', () => {
        zone.classList.remove('dragover');
      });

      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) handleFile(files[0]);
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
      });
    }

    document.getElementById('btnReUpload').addEventListener('click', () => resetUpload());
    document.getElementById('btnStartAI').addEventListener('click', () => startAIProcessing());

    // 데모 버튼
    const btnDemo = document.getElementById('btnDemoMech');
    if (btnDemo) btnDemo.addEventListener('click', () => startDemo());
  }

  function handleFile(file) {
    const validTypes = ['image/png', 'image/jpeg', 'image/bmp', 'image/webp', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
      showToast('지원하지 않는 파일 형식입니다', 'error');
      return;
    }

    _uploadedFile = file;

    const previewWrap = document.getElementById('uploadPreview');
    const previewImg = document.getElementById('previewImg');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => { previewImg.src = e.target.result; };
      reader.readAsDataURL(file);
    } else {
      previewImg.src = '';
      previewImg.alt = 'PDF 파일';
    }

    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    // Hide upload zone (shaft-specific)
    const shaftZone = document.getElementById('shaftUploadZone');
    if (shaftZone) shaftZone.style.display = 'none';
    previewWrap.classList.add('active');

    // 현재 탭 유형에 맞는 힌트 표시
    const typeLabels = {
      shaft: '🔧 Shaft 도면으로 분석합니다',
      flange: '⚙️ Flange 도면으로 분석합니다',
      bracket: '📐 Bracket 도면으로 분석합니다',
      gear: '🔩 Gear 도면으로 분석합니다',
    };
    showToast(`"${file.name}" — ${typeLabels[_currentDrawingType] || '도면을 분석합니다'}`, 'info');
  }

  function resetUpload() {
    _uploadedFile = null;
    // Shaft upload zone visibility
    const shaftZone = document.getElementById('shaftUploadZone');
    if (shaftZone) shaftZone.style.display = '';
    const preview = document.getElementById('uploadPreview');
    if (preview) preview.classList.remove('active');
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  }

  // ========== AI Processing ==========
  async function startAIProcessing() {
    if (!_uploadedFile) {
      showToast('파일을 먼저 업로드하세요', 'error');
      return;
    }

    goToStep(2);
    AIEngine.resetAISteps();

    try {
      _document = await AIEngine.analyzeImage(_uploadedFile);

      const typeLabels = {
        mechanical: '📐 형상 초안',
        unknown: '📐 도면 초안',
      };
      const typeLabel = typeLabels[_document.drawingType] || '도면';
      showToast(`${typeLabel} 생성이 완료되었습니다! ✨`, 'success');
      await new Promise(r => setTimeout(r, 400));

      enterEditor(_document);
    } catch (err) {
      if (err.message && err.message.includes('취소')) {
        showToast('분석이 취소되었습니다', 'info');
      } else {
        showToast('AI 처리 중 오류가 발생했습니다', 'error');
        console.error('[App:startAIProcessing]', err);
      }
      goToStep(1);
    }
  }

  // ========== Demo ==========
  async function startDemo() {
    goToStep(2);
    AIEngine.resetAISteps();

    try {
      // 데모용 애니메이션
      const steps = AIEngine.getAnalysisSteps();
      for (const s of steps) {
        AIEngine.updateAIStep(s.step, 'active');
        await AIEngine.delay(s.delay * 0.5);
        AIEngine.updateAIStep(s.step, 'done');
        const progress = (s.step / steps.length) * 100;
        const fillEl = document.getElementById('aiProgressFill');
        if (fillEl) fillEl.style.width = `${progress}%`;
      }

      _document = AIEngine.generateMechDemo();
      showToast('형상 초안이 생성되었습니다! 📐', 'success');

      await new Promise(r => setTimeout(r, 400));
      enterEditor(_document);
    } catch (err) {
      showToast('AI 처리 중 오류가 발생했습니다', 'error');
      console.error('[App:startDemo]', err);
      goToStep(1);
    }
  }

  // ========== Enter Editor ==========
  function enterEditor(doc) {
    goToStep(3);
    _document = doc;

    // 레이어 패널 동적 업데이트
    updateLayersPanel(doc);

    // 도면 유형 뱃지
    updateDrawingTypeBadge(doc.drawingType);

    // History 초기화
    History.init((restoredElements, action) => {
      _document.elements = restoredElements;
      Renderer.render(_document);
      Editor.deselectAll();
      showToast(action === 'undo' ? '실행취소됨' : '다시실행됨', 'info');
    });
    History.push(doc.elements, '초기 상태');

    // Editor 초기화
    Editor.init(doc);
    Renderer.render(doc);

    // v5: Confidence 범례 + annotation 패널 + self-check + note
    showConfidenceLegend(doc);
    showSelfCheckPanel(doc);
    showAnnotationPanel(doc);
    showNotePanel(doc);

    // 접기/펼치기 토글 초기화
    initCollapsibleHeaders();

    setTimeout(() => Editor.fitToView(), 100);
  }

  // ========== UI 동적 변경 ==========

  function updateLayersPanel(doc) {
    const listEl = document.getElementById('layersList');
    if (!listEl) return;

    listEl.innerHTML = '';
    const layerColors = {
      outlines: '#000000', centerlines: '#f87171', dimensions: '#60a5fa',
      texts: '#94a3b8', holes: '#a78bfa', slots: '#fbbf24', hatching: '#475569',
      hiddenlines: '#4ade80', surfacefinish: '#f472b6', annotations: '#f59e0b',
    };

    Object.entries(doc.layers).forEach(([key, layer]) => {
      const li = document.createElement('li');
      li.className = 'layer-item';
      li.dataset.layer = key;
      li.innerHTML = `
        <span class="layer-color" style="background:${layerColors[key] || layer.color}"></span>
        <span class="layer-name">${layer.label || key}</span>
        <span class="layer-count" id="${key}Count">0</span>
        <button class="layer-visibility" data-layer-toggle="${key}"><i class="fas fa-eye"></i></button>
      `;
      listEl.appendChild(li);

      const btn = li.querySelector('.layer-visibility');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        btn.innerHTML = layer.visible ?
          '<i class="fas fa-eye"></i>' :
          '<i class="fas fa-eye-slash"></i>';
        Renderer.render(doc);
      });
    });
  }

  function showConfidenceLegend(doc) {
    // 요소에 confidence 태그가 있는지 확인
    const hasConf = doc.elements.some(el => el.confidence);
    if (!hasConf) return;

    let legend = document.getElementById('confidenceLegend');
    if (!legend) {
      legend = document.createElement('div');
      legend.id = 'confidenceLegend';
      legend.style.cssText = `
        position:absolute; bottom:36px; right:12px; z-index:20;
        background:rgba(15,23,42,0.92); border:1px solid rgba(255,255,255,0.1);
        border-radius:8px; padding:8px 12px; font-size:11px;
        display:flex; gap:12px; align-items:center; color:#94a3b8;
      `;
      const canvasWrap = document.querySelector('.editor-canvas-area');
      if (canvasWrap) canvasWrap.appendChild(legend);
    }

    // v5: 통계 (placeholder 포함)
    const counts = { confirmed: 0, estimated: 0, uncertain: 0, placeholder: 0 };
    doc.elements.forEach(el => {
      if (el._isPlaceholder) { counts.placeholder++; return; }
      const c = el.confidence;
      if (c === 'confirmed') counts.confirmed++;
      else if (c === 'estimated') counts.estimated++;
      else if (c === 'uncertain') counts.uncertain++;
    });

    legend.innerHTML = `
      <span style="font-weight:600;color:#e2e8f0;">v5 형상초안</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#10b981;border-radius:50%;margin-right:3px;"></span>
        확정 (${counts.confirmed})</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#3b82f6;border-radius:50%;margin-right:3px;"></span>
        추정 (${counts.estimated})</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#fbbf24;border-radius:50%;margin-right:3px;"></span>
        불확실 (${counts.uncertain})</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#6b7280;border-radius:50%;margin-right:3px;"></span>
        ✉️ placeholder (${counts.placeholder})</span>
    `;
  }

  /**
   * v8: Self-check 결과를 좌측 하단 플로팅 패널로 표시
   * (이전: 도면 캔버스 위에 직접 표시 → 표제란 침범 문제)
   */
  function showSelfCheckPanel(doc) {
    const sc = doc._selfCheck;
    // 이전 패널 제거
    const existing = document.getElementById('selfCheckPanel');
    if (existing) existing.remove();

    if (!sc) return;

    const panel = document.createElement('div');
    panel.id = 'selfCheckPanel';
    panel.style.cssText = `
      position:absolute; bottom:36px; left:12px; z-index:20;
      background:rgba(15,23,42,0.95); border:1px solid rgba(255,255,255,0.12);
      border-radius:10px; padding:12px 16px; font-size:11px;
      color:#cbd5e1; max-width:380px; min-width:220px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      backdrop-filter: blur(8px);
    `;

    // 헤더: 형상 일치율
    const fidelityColor = sc.geometryFidelity >= 90 ? '#10b981'
      : sc.geometryFidelity >= 70 ? '#fbbf24' : '#ef4444';

    let html = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <span style="font-weight:700; font-size:12px; color:#e2e8f0;">
          Self-Check
        </span>
        <span style="font-weight:700; font-size:13px; color:${fidelityColor};">
          형상 일치율 ${sc.geometryFidelity}%
        </span>
        <button id="selfCheckClose" style="
          background:none; border:none; color:#64748b; cursor:pointer;
          font-size:14px; padding:0 0 0 8px; line-height:1;
        ">&times;</button>
      </div>
    `;

    // 통계 바
    const st = sc.stats || {};
    html += `
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px; font-size:10px; color:#94a3b8;">
        <span>구간 ${st.sectionCount || 0}</span>
        <span>|</span>
        <span>구멍 ${st.holeCount || 0}</span>
        <span>|</span>
        <span>숨은선 ${st.hiddenFeatureCount || 0}</span>
        <span>|</span>
        <span>보조투상 ${st.auxiliaryViewCount || 0}</span>
      </div>
    `;

    // 에러 목록
    if (sc.errors && sc.errors.length > 0) {
      html += `<div style="margin-top:6px;">`;
      sc.errors.forEach(e => {
        html += `<div style="color:#ef4444; padding:2px 0; font-size:11px;">❌ ${e}</div>`;
      });
      html += `</div>`;
    }

    // 경고 목록
    if (sc.warnings && sc.warnings.length > 0) {
      html += `<div style="margin-top:4px;">`;
      sc.warnings.forEach(w => {
        html += `<div style="color:#fbbf24; padding:2px 0; font-size:10px;">⚠️ ${w}</div>`;
      });
      html += `</div>`;
    }

    // 통과 표시
    if (sc.passed && (!sc.errors || sc.errors.length === 0)) {
      html += `<div style="margin-top:6px; color:#10b981; font-size:11px;">✅ 형상 검증 통과</div>`;
    }

    panel.innerHTML = html;

    const canvasWrap = document.querySelector('.editor-canvas-area');
    if (canvasWrap) canvasWrap.appendChild(panel);

    // 닫기 버튼
    const closeBtn = panel.querySelector('#selfCheckClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => panel.remove());
    }
  }

  /**
   * v5: 속성 패널에 재질/표면거칠기/나사 규격/메모 placeholder 표시
   */
  function showAnnotationPanel(doc) {
    let panel = document.getElementById('annotationPanel');
    if (!panel) {
      // fallback: 동적 생성 (index.html에 이미 정적으로 존재하지만 만약을 대비)
      panel = document.createElement('div');
      panel.id = 'annotationPanel';
      panel.className = 'panel-section';
      const propsPanel = document.getElementById('propertiesPanel');
      if (propsPanel) {
        const noteP = document.getElementById('notePanel');
        if (noteP) {
          propsPanel.insertBefore(panel, noteP);
        } else {
          const children = Array.from(propsPanel.children);
          const layerSection = children.filter(c => c.classList.contains('panel-section')).pop();
          if (layerSection && layerSection.parentNode === propsPanel) {
            propsPanel.insertBefore(panel, layerSection);
          } else {
            propsPanel.appendChild(panel);
          }
        }
      }
    }
    // 패널 표시
    panel.style.display = '';

    const meta = doc.meta || {};
    const mat = meta.material || '';
    const sf = meta.surfaceFinish || '';
    const pn = meta.partName || '';
    const pno = meta.partNo || '';

    const scaleVal = meta.scale || '1:1';
    const projVal = meta.projectionMethod || '3각법';
    const qtyVal = meta.quantity || '';
    const remVal = meta.remarks || '';

    panel.innerHTML = `
      <h4 class="collapsible-header" data-target="annotationBody">
        편집 정보 <span style="font-size:9px;color:#f59e0b;font-weight:normal;">v7 KS</span>
        <i class="fas fa-chevron-down collapsible-arrow"></i>
      </h4>
      ${doc._spec ? `
      <div style="margin-bottom:10px;">
        <button id="btnEditParams" style="
          width:100%; padding:8px 12px; background:linear-gradient(135deg,#f59e0b,#d97706);
          border:none; border-radius:6px; color:#1a1d27; cursor:pointer;
          font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:6px;
          transition: opacity 0.2s;
        " onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
          <i class="fas fa-sliders-h"></i> 파라미터 수정 후 다시 생성
        </button>
      </div>
      ` : ''}
      <div class="collapsible-body" id="annotationBody">
        <div class="form-row">
          <span class="form-label">품명</span>
          <input type="text" class="form-input annotation-input" id="annPartName"
            value="${pn === '직접입력' ? '' : escapeHtml(pn)}" placeholder="품명 입력">
        </div>
        <div class="form-row">
          <span class="form-label">재질</span>
          <input type="text" class="form-input annotation-input" id="annMaterial"
            value="${escapeHtml(mat)}" placeholder="예: S45C">
        </div>
        <div class="form-row">
          <span class="form-label">척도</span>
          <input type="text" class="form-input annotation-input" id="annScale"
            value="${escapeHtml(scaleVal)}" placeholder="1:1">
        </div>
        <div class="form-row">
          <span class="form-label">각법</span>
          <select class="form-input annotation-input" id="annProjection">
            <option value="3각법" ${projVal === '3각법' ? 'selected' : ''}>3각법</option>
            <option value="1각법" ${projVal === '1각법' ? 'selected' : ''}>1각법</option>
          </select>
        </div>
        <div class="form-row">
          <span class="form-label">수량</span>
          <input type="text" class="form-input annotation-input" id="annQuantity"
            value="${escapeHtml(qtyVal)}" placeholder="수량">
        </div>
        <div class="form-row">
          <span class="form-label">비고</span>
          <input type="text" class="form-input annotation-input" id="annRemarks"
            value="${escapeHtml(remVal)}" placeholder="비고">
        </div>
        <div class="form-row">
          <span class="form-label">표면거칠기</span>
          <input type="text" class="form-input annotation-input" id="annSurfaceFinish"
            value="${escapeHtml(sf)}" placeholder="예: Ra 1.6">
        </div>
      </div>
    `;

    // 파라미터 수정 버튼 이벤트
    const btnEditParams = document.getElementById('btnEditParams');
    if (btnEditParams) {
      btnEditParams.addEventListener('click', () => editCurrentParams());
    }

    // 변경 이벤트 바인딩
    ['annPartName', 'annMaterial', 'annScale', 'annProjection', 'annQuantity', 'annRemarks', 'annSurfaceFinish'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        if (id === 'annPartName') doc.meta.partName = el.value;
        if (id === 'annMaterial') doc.meta.material = el.value;
        if (id === 'annScale') doc.meta.scale = el.value;
        if (id === 'annProjection') doc.meta.projectionMethod = el.value;
        if (id === 'annQuantity') doc.meta.quantity = el.value;
        if (id === 'annRemarks') doc.meta.remarks = el.value;
        if (id === 'annSurfaceFinish') doc.meta.surfaceFinish = el.value;
        doc.meta.updatedAt = new Date().toISOString();
        showToast('속성이 업데이트되었습니다', 'success');
      });
    });
  }

  /**
   * 접기/펼치기 토글 초기화 — 레이어, 편집정보 패널 헤더 클릭 시 본문 숨김/표시
   */
  function initCollapsibleHeaders() {
    document.querySelectorAll('.collapsible-header').forEach(header => {
      // 이미 바인딩된 경우 중복 방지
      if (header._collapsibleBound) return;
      header._collapsibleBound = true;

      header.addEventListener('click', () => {
        const targetId = header.getAttribute('data-target');
        const body = document.getElementById(targetId);
        if (!body) return;

        const isCollapsed = body.classList.contains('collapsed');
        if (isCollapsed) {
          // 펼치기
          body.classList.remove('collapsed');
          header.classList.remove('collapsed');
        } else {
          // 접기
          body.classList.add('collapsed');
          header.classList.add('collapsed');
        }
      });
    });
  }

  /**
   * NOTE 패널 — 도면 하단 좌측에 주서(note) 기입
   * 속성 패널에서 줄 추가/삭제, 글자 크기 설정
   */
  function showNotePanel(doc) {
    let panel = document.getElementById('notePanel');
    if (!panel) {
      // fallback: 동적 생성 (index.html에 이미 정적으로 존재하지만 만약을 대비)
      panel = document.createElement('div');
      panel.id = 'notePanel';
      panel.className = 'panel-section';
      const propsPanel = document.getElementById('propertiesPanel');
      if (propsPanel) {
        const annPanel = document.getElementById('annotationPanel');
        if (annPanel && annPanel.nextSibling) {
          propsPanel.insertBefore(panel, annPanel.nextSibling);
        } else {
          const children = Array.from(propsPanel.children);
          const layerSection = children.filter(c => c.classList.contains('panel-section')).pop();
          if (layerSection && layerSection.parentNode === propsPanel) {
            propsPanel.insertBefore(panel, layerSection);
          } else {
            propsPanel.appendChild(panel);
          }
        }
      }
    }
    // 패널 표시 (정적 HTML에서 display:none으로 숨겨둔 것 해제)
    panel.style.display = '';

    // 기존 noteblock 요소 찾기 또는 meta에서 초기화
    if (!doc.meta.notes) {
      doc.meta.notes = { lines: [], fontSize: 10 };
    }
    const notes = doc.meta.notes;

    function renderNotePanel() {
      const lines = notes.lines || [];
      let linesHtml = '';
      lines.forEach((line, idx) => {
        linesHtml += `
          <div class="note-line-row" style="display:flex;align-items:center;gap:4px;margin-bottom:4px;">
            <span style="font-size:11px;color:var(--text-muted);min-width:18px;text-align:right;">${idx + 1}.</span>
            <input type="text" class="form-input note-line-input" data-note-idx="${idx}"
              value="${escapeHtml(line)}" placeholder="내용 입력"
              style="flex:1;font-size:11px;padding:4px 6px;">
            <button class="note-line-del" data-note-del="${idx}" title="삭제"
              style="background:none;border:none;color:var(--accent-red);cursor:pointer;font-size:12px;padding:2px 4px;">
              <i class="fas fa-times"></i>
            </button>
          </div>
        `;
      });

      panel.innerHTML = `
        <h4 style="color:#fbbf24;"><i class="fas fa-sticky-note" style="margin-right:4px;"></i> NOTE (주서)</h4>
        <div style="margin-bottom:8px;">
          <div class="form-row" style="margin-bottom:6px;">
            <span class="form-label">글자 크기</span>
            <input type="number" class="form-input form-input-sm" id="noteFontSize"
              value="${notes.fontSize || 10}" min="6" max="24" step="1" style="width:60px;">
          </div>
        </div>
        <div id="noteLinesContainer" style="max-height:200px;overflow-y:auto;margin-bottom:8px;">
          ${linesHtml || '<p style="font-size:11px;color:var(--text-muted);text-align:center;padding:8px 0;">줄을 추가하세요</p>'}
        </div>
        <button id="btnAddNoteLine" style="
          width:100%;padding:6px 10px;background:var(--surface-lighter);
          border:1px dashed var(--border-color);border-radius:4px;color:var(--text-secondary);
          cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;gap:4px;
          transition:background 0.2s;
        " onmouseover="this.style.background='var(--surface-hover)'" onmouseout="this.style.background='var(--surface-lighter)'">
          <i class="fas fa-plus"></i> 줄 추가
        </button>
      `;

      // 이벤트 바인딩
      // 글자 크기
      const fontSizeInput = document.getElementById('noteFontSize');
      if (fontSizeInput) {
        fontSizeInput.addEventListener('change', () => {
          notes.fontSize = parseInt(fontSizeInput.value) || 10;
          syncNoteToDrawing();
        });
      }

      // 줄 추가
      const btnAdd = document.getElementById('btnAddNoteLine');
      if (btnAdd) {
        btnAdd.addEventListener('click', () => {
          notes.lines.push('');
          renderNotePanel();
          syncNoteToDrawing();
          // 새로 추가된 줄에 포커스
          setTimeout(() => {
            const inputs = panel.querySelectorAll('.note-line-input');
            if (inputs.length > 0) inputs[inputs.length - 1].focus();
          }, 50);
        });
      }

      // 줄 내용 변경
      panel.querySelectorAll('.note-line-input').forEach(input => {
        input.addEventListener('input', () => {
          const idx = parseInt(input.dataset.noteIdx);
          notes.lines[idx] = input.value;
          syncNoteToDrawing();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            notes.lines.push('');
            renderNotePanel();
            syncNoteToDrawing();
            setTimeout(() => {
              const inputs = panel.querySelectorAll('.note-line-input');
              if (inputs.length > 0) inputs[inputs.length - 1].focus();
            }, 50);
          }
        });
      });

      // 줄 삭제
      panel.querySelectorAll('.note-line-del').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.noteDel);
          notes.lines.splice(idx, 1);
          renderNotePanel();
          syncNoteToDrawing();
        });
      });
    }

    function syncNoteToDrawing() {
      // 기존 noteblock 제거
      doc.elements = doc.elements.filter(el => el.type !== 'noteblock');

      // 줄이 있을 때만 noteblock 생성
      if (notes.lines.length > 0 && notes.lines.some(l => l.trim())) {
        // 위치: 윤곽선 좌측 하단 영역
        const paperSize = doc.meta.paperSize || 'A3';
        const SVG_PAPER_PX_PER_MM = 2.5;
        const PAPER_MM = { A3: { w: 420, h: 297 }, A4: { w: 297, h: 210 } };
        const paper = PAPER_MM[paperSize] || PAPER_MM.A3;
        const paperW = paper.w * SVG_PAPER_PX_PER_MM;
        const paperH = paper.h * SVG_PAPER_PX_PER_MM;
        const ML = 20 * SVG_PAPER_PX_PER_MM;  // 좌측 마진
        const MO = 10 * SVG_PAPER_PX_PER_MM;  // 기타 마진

        const innerX1 = ML;
        const innerY2 = paperH - MO;

        // 주서란 위치: 윤곽선 내부 좌측 하단
        const noteX = innerX1 + 15;
        const noteLines = notes.lines.filter(l => l.trim());
        const lineH = (notes.fontSize || 10) * 1.6;
        const noteBlockH = (noteLines.length + 1) * lineH + 10;
        const noteY = innerY2 - noteBlockH;

        const noteBlock = DrawingModel.createNoteBlock(noteX, noteY, {
          lines: noteLines,
          fontSize: notes.fontSize || 10,
        });
        doc.elements.push(noteBlock);
      }

      // 리렌더링
      Renderer.render(doc);
      doc.meta.updatedAt = new Date().toISOString();
    }

    renderNotePanel();
  }

  function updateDrawingTypeBadge(drawingType) {
    let badge = document.getElementById('drawingTypeBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'drawingTypeBadge';
      badge.style.cssText = 'font-size:11px;padding:3px 10px;border-radius:10px;font-weight:600;margin-left:8px;';
      const infoBar = document.querySelector('.canvas-info-bar');
      if (infoBar) infoBar.appendChild(badge);
    }

    const labels = {
      mechanical: { text: '🔧 기계도면', bg: '#1e3a5f', color: '#93c5fd' },
      unknown:    { text: '⚠ 유형 미확정', bg: '#3c2a1a', color: '#fbbf24' },
    };
    const cfg = labels[drawingType] || labels.unknown;
    badge.textContent = cfg.text;
    badge.style.background = cfg.bg;
    badge.style.color = cfg.color;
    badge.style.display = 'inline';
  }

  // ========== Header ==========
  function bindHeaderEvents() {
    // 로고 클릭 → 초기 화면으로
    document.querySelector('.app-logo').addEventListener('click', () => {
      if (_currentStep === 3) {
        if (!confirm('현재 편집 중인 도면이 있습니다. 초기 화면으로 돌아가시겠습니까?')) return;
      }
      // DB 화면이 열려있으면 닫기
      document.getElementById('screenDB').classList.remove('active');
      resetAll();
    });

    document.getElementById('btnNewProject').addEventListener('click', () => {
      if (_currentStep === 3) {
        if (!confirm('현재 편집 중인 도면이 있습니다. 새로 시작하시겠습니까?')) return;
      }
      resetAll();
    });

    // ── 속성 패널 접기/펼치기 ──
    const toggleBtn = document.getElementById('btnTogglePanel');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const panel = document.getElementById('propertiesPanel');
        if (!panel) return;
        panel.classList.toggle('collapsed');
        const isCollapsed = panel.classList.contains('collapsed');
        toggleBtn.title = isCollapsed ? '패널 펼치기' : '패널 접기';
      });
    }
  }

  function resetAll() {
    _uploadedFile = null;
    _document = null;
    _currentProjectId = null;
    resetUpload();
    const badge = document.getElementById('drawingTypeBadge');
    if (badge) badge.style.display = 'none';
    goToStep(1);
    showToast('새 프로젝트를 시작합니다', 'info');
  }

  // ========== Save Draft (임시저장) ==========
  function bindSaveDraftEvents() {
    const modal = document.getElementById('saveDraftModal');
    const nameInput = document.getElementById('saveDraftName');

    document.getElementById('btnSaveDraft').addEventListener('click', () => {
      if (!_document) return;
      // 기존 프로젝트면 이름을 미리 채워줌
      if (_currentProjectId) {
        const projects = loadProjects();
        const existing = projects.find(p => p.id === _currentProjectId);
        if (existing) nameInput.value = existing.name;
      } else {
        const partName = _document.meta?.partName;
        nameInput.value = (partName && partName !== '직접입력') ? partName : '';
      }
      modal.classList.add('active');
      setTimeout(() => nameInput.focus(), 100);
    });

    document.getElementById('btnCancelSaveDraft').addEventListener('click', () => {
      modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btnConfirmSaveDraft').click();
      if (e.key === 'Escape') modal.classList.remove('active');
    });

    document.getElementById('btnConfirmSaveDraft').addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) {
        showToast('프로젝트 이름을 입력하세요', 'error');
        nameInput.focus();
        return;
      }
      saveDraftProject(name);
      modal.classList.remove('active');
    });
  }

  function saveDraftProject(name) {
    const doc = Editor.getDocument ? Editor.getDocument() : _document;
    if (!doc) return;

    const projects = loadProjects();
    const now = new Date().toISOString();

    // SVG 미리보기 생성
    const svgPreview = generateSVGPreview(doc);

    if (_currentProjectId) {
      // 기존 프로젝트 덮어쓰기
      const idx = projects.findIndex(p => p.id === _currentProjectId);
      if (idx >= 0) {
        projects[idx].name = name;
        projects[idx].document = JSON.parse(JSON.stringify(doc));
        projects[idx].svgPreview = svgPreview;
        projects[idx].updatedAt = now;
        projects[idx].elementCount = doc.elements ? doc.elements.length : 0;
      }
    } else {
      // 신규 프로젝트
      const id = 'proj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      projects.push({
        id,
        name,
        document: JSON.parse(JSON.stringify(doc)),
        svgPreview,
        createdAt: now,
        updatedAt: now,
        elementCount: doc.elements ? doc.elements.length : 0,
      });
      _currentProjectId = id;
    }

    saveProjects(projects);
    updateDBBadge();
    showToast(`"${name}" 프로젝트가 저장되었습니다`, 'success');
  }

  function generateSVGPreview(doc) {
    try {
      const bounds = DrawingModel.getAllBounds(doc.elements);
      const padding = 20;
      const w = bounds.width + padding * 2;
      const h = bounds.height + padding * 2;
      const vx = bounds.x - padding;
      const vy = bounds.y - padding;

      let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${w} ${h}" style="background:#242836;">`;
      svg += `<defs>`;
      svg += `<marker id="pa" markerWidth="4" markerHeight="3" refX="0" refY="1.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M4 0L0 1.5L4 3" fill="#60a5fa" stroke="none"/></marker>`;
      svg += `<marker id="pb" markerWidth="4" markerHeight="3" refX="4" refY="1.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L4 1.5L0 3" fill="#60a5fa" stroke="none"/></marker>`;
      svg += `</defs>`;

      doc.elements.forEach(el => {
        if (el.type === 'outline')
          svg += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="#e2e8f0" stroke-width="${el.strokeWidth||2}"/>`;
        else if (el.type === 'centerline')
          svg += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="#f87171" stroke-width="0.5" stroke-dasharray="8 3 2 3"/>`;
        else if (el.type === 'hiddenline')
          svg += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="#4ade80" stroke-width="1" stroke-dasharray="4 3"/>`;
        else if (el.type === 'dimension') {
          const isH = Math.abs(el.y2-el.y1) < Math.abs(el.x2-el.x1);
          const off = el.offset||30;
          let lx1,ly1,lx2,ly2;
          if (isH) { ly1=ly2=Math.min(el.y1,el.y2)-off; lx1=el.x1; lx2=el.x2; }
          else { lx1=lx2=Math.min(el.x1,el.x2)-off; ly1=el.y1; ly2=el.y2; }
          svg += `<line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#60a5fa" stroke-width="0.8" marker-start="url(#pa)" marker-end="url(#pb)"/>`;
          const mx=(lx1+lx2)/2, my=(ly1+ly2)/2;
          if (isH)
            svg += `<text x="${mx}" y="${my-3}" fill="#60a5fa" font-size="9" text-anchor="middle" font-family="monospace">${el.value||''}</text>`;
          else
            svg += `<text x="${mx-4}" y="${my+3}" fill="#60a5fa" font-size="9" text-anchor="end" font-family="monospace">${el.value||''}</text>`;
        }
      });

      svg += `</svg>`;
      return svg;
    } catch(e) {
      return '';
    }
  }

  // ========== DB (프로젝트 열람) ==========

  // ── v43: 퍼지 검색 점수 함수 ──
  // query와 name을 비교하여 0~1 사이의 유사도 점수를 반환한다.
  // 높을수록 유사하며, 0이면 전혀 일치하지 않음.
  function _fuzzyScore(query, name) {
    if (!query) return 1; // 검색어 없으면 전부 표시
    const q = query.toLowerCase().trim();
    const n = name.toLowerCase();
    if (!q) return 1;

    // 1) 정확히 포함(contains) → 높은 점수
    if (n === q) return 1.0;
    if (n.startsWith(q)) return 0.9;
    if (n.includes(q)) return 0.8;

    // 2) 각 단어(공백 기준)가 포함되는지
    const qWords = q.split(/\s+/).filter(Boolean);
    if (qWords.length > 1) {
      const matchedWords = qWords.filter(w => n.includes(w));
      if (matchedWords.length === qWords.length) return 0.75;
      if (matchedWords.length > 0) return 0.4 + 0.3 * (matchedWords.length / qWords.length);
    }

    // 3) 부분 문자열 순서 매칭 (subsequence)
    let qi = 0;
    let consecutive = 0, maxConsecutive = 0;
    for (let ni = 0; ni < n.length && qi < q.length; ni++) {
      if (n[ni] === q[qi]) {
        qi++;
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
      } else {
        consecutive = 0;
      }
    }
    if (qi === q.length) {
      // 전부 순서 매칭됨 — 연속 매칭 비율로 점수
      return 0.3 + 0.3 * (maxConsecutive / q.length);
    }

    // 4) 매칭 실패
    return 0;
  }

  // ── v43: 검색어에 해당하는 텍스트를 <mark>로 강조 ──
  function _highlightMatch(name, query) {
    if (!query || !query.trim()) return escapeHtml(name);
    const escaped = escapeHtml(name);
    const q = query.trim();
    // 대소문자 무시하여 검색어를 찾아 <mark>로 감싸기
    const regex = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return escaped.replace(regex, '<mark>$1</mark>');
  }

  let _dbSearchTimer = null; // 디바운스 타이머

  function bindDBEvents() {
    document.getElementById('btnDBTab').addEventListener('click', () => {
      openDBScreen();
    });

    document.getElementById('btnDBBack').addEventListener('click', () => {
      closeDBScreen();
    });

    // ── v43: 검색 이벤트 ──
    const searchInput = document.getElementById('dbSearchInput');
    const searchClear = document.getElementById('dbSearchClear');

    searchInput.addEventListener('input', () => {
      clearTimeout(_dbSearchTimer);
      _dbSearchTimer = setTimeout(() => {
        renderDBGrid(searchInput.value);
      }, 200); // 200ms 디바운스
      // clear 버튼 표시/숨김
      searchClear.style.display = searchInput.value ? '' : 'none';
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      renderDBGrid();
      searchInput.focus();
    });

    // Enter 키로 즉시 검색
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchClear.style.display = 'none';
        renderDBGrid();
      }
    });
  }

  function openDBScreen() {
    _previousStep = _currentStep;
    // 모든 화면 숨기고 DB 화면만 표시
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.remove('active');
      s.style.removeProperty('display'); // ★ inline style 잔여물 제거
    });
    document.getElementById('screenDB').classList.add('active');

    // ★ v43: 검색 상태 초기화
    const searchInput = document.getElementById('dbSearchInput');
    const searchClear = document.getElementById('dbSearchClear');
    if (searchInput) { searchInput.value = ''; }
    if (searchClear) { searchClear.style.display = 'none'; }

    renderDBGrid();
  }

  function closeDBScreen() {
    document.getElementById('screenDB').classList.remove('active');
    goToStep(_previousStep);
  }

  function renderDBGrid(searchQuery) {
    const projects = loadProjects();
    const grid = document.getElementById('dbGrid');
    const empty = document.getElementById('dbEmpty');
    const noResults = document.getElementById('dbNoResults');
    const scrollWrapper = document.getElementById('dbScrollWrapper');
    const countEl = document.getElementById('dbCount');
    const query = (searchQuery || '').trim();

    countEl.textContent = projects.length + '개';

    if (projects.length === 0) {
      empty.style.display = '';
      if (noResults) noResults.style.display = 'none';
      grid.innerHTML = '';
      scrollWrapper.style.display = 'none';
      return;
    }

    // ── v43: 검색 점수 계산 + 필터 + 정렬 ──
    let scored = projects.map(proj => ({
      proj,
      score: _fuzzyScore(query, proj.name || '')
    }));

    // 검색어가 있으면 점수 0인 것은 제외
    if (query) {
      scored = scored.filter(s => s.score > 0);
    }

    // 검색 결과 없음 처리
    if (scored.length === 0) {
      empty.style.display = 'none';
      if (noResults) noResults.style.display = '';
      grid.innerHTML = '';
      scrollWrapper.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    if (noResults) noResults.style.display = 'none';
    scrollWrapper.style.display = '';

    // 정렬: 검색어가 있으면 점수 높은 순, 같으면 최신순
    //        검색어가 없으면 최신순
    if (query) {
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.proj.updatedAt) - new Date(a.proj.updatedAt);
      });
    } else {
      scored.sort((a, b) => new Date(b.proj.updatedAt) - new Date(a.proj.updatedAt));
    }

    // 최고 점수 (1등 강조용)
    const topScore = scored.length > 0 ? scored[0].score : 0;

    grid.innerHTML = scored.map((item, idx) => {
      const proj = item.proj;
      const date = new Date(proj.updatedAt);
      const dateStr = `${date.getFullYear()}.${String(date.getMonth()+1).padStart(2,'0')}.${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      const elCount = proj.elementCount || 0;

      // 검색어가 있을 때 이름에 하이라이트 + 1등 카드 강조
      const nameHtml = query ? _highlightMatch(proj.name, query) : escapeHtml(proj.name);
      const topClass = (query && idx === 0 && topScore > 0) ? ' search-top-match' : '';

      return `
        <div class="db-project-card${topClass}" data-project-id="${proj.id}">
          <div class="db-card-preview">
            ${proj.svgPreview ? proj.svgPreview : '<i class="fas fa-drafting-compass preview-placeholder"></i>'}
          </div>
          <div class="db-card-body">
            <div class="db-card-name" title="${escapeHtml(proj.name)}">${nameHtml}</div>
            <div class="db-card-meta">
              <span><i class="fas fa-clock"></i> ${dateStr}</span>
              <span><i class="fas fa-object-group"></i> ${elCount}개 요소</span>
            </div>
            <div class="db-card-actions">
              <button class="btn btn-card-edit" data-action="edit" data-id="${proj.id}">
                <i class="fas fa-pen"></i> 편집
              </button>
              <button class="btn btn-card-params" data-action="params" data-id="${proj.id}" title="파라미터 수정 후 다시 생성">
                <i class="fas fa-sliders-h"></i> 파라미터
              </button>
              <button class="btn btn-card-export" data-action="export" data-id="${proj.id}">
                <i class="fas fa-download"></i> 내보내기
              </button>
              <button class="btn btn-card-delete" data-action="delete" data-id="${proj.id}" title="삭제">
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // 이벤트 바인딩
    grid.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openProject(btn.dataset.id);
      });
    });

    grid.querySelectorAll('[data-action="params"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        editProjectParams(btn.dataset.id);
      });
    });

    grid.querySelectorAll('[data-action="export"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportProject(btn.dataset.id);
      });
    });

    grid.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteProject(btn.dataset.id);
      });
    });

    // 카드 클릭으로도 편집 열기
    grid.querySelectorAll('.db-project-card').forEach(card => {
      card.addEventListener('click', () => {
        openProject(card.dataset.projectId);
      });
    });

    // ★ v43: 검색 시 스크롤을 맨 왼쪽으로 리셋
    if (scrollWrapper) scrollWrapper.scrollLeft = 0;
  }

  function openProject(id) {
    const projects = loadProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj || !proj.document) {
      showToast('프로젝트를 열 수 없습니다', 'error');
      return;
    }

    _currentProjectId = id;
    _document = JSON.parse(JSON.stringify(proj.document));

    // DB 화면 닫고 편집기로
    // ★ classList만 사용 — inline style.display 설정 금지
    //   inline style은 CSS class보다 우선하므로, 한번 display:none을 설정하면
    //   이후 openDBScreen()에서 .active 클래스를 추가해도 표시되지 않음
    document.getElementById('screenDB').classList.remove('active');

    enterEditor(_document);
    showToast(`"${proj.name}" 프로젝트를 불러왔습니다`, 'success');
  }

  function exportProject(id) {
    const projects = loadProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj || !proj.document) {
      showToast('프로젝트를 찾을 수 없습니다', 'error');
      return;
    }
    // 내보내기 모달 열기 (기존 exportModal 재사용)
    _exportTargetDoc = proj.document;
    _exportTargetDoc._projectName = proj.name; // 파일명용
    const modal = document.getElementById('exportModal');
    if (modal) modal.classList.add('active');
  }

  /**
   * DB에서 프로젝트의 파라미터를 수정 후 도면 재생성
   * — DB 그리드 위에서 파라미터 입력 다이얼로그를 띄움 (편집기로 이동하지 않음)
   * — 재생성 후 기존 프로젝트를 자동 덮어쓰기
   */
  async function editProjectParams(id) {
    const projects = loadProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj || !proj.document) {
      showToast('프로젝트를 열 수 없습니다', 'error');
      return;
    }

    const doc = proj.document;
    const spec = doc._spec;
    if (!spec) {
      showToast('이 도면에는 파라미터 데이터가 없습니다.\n(이전 버전에서 생성된 도면)', 'error');
      return;
    }

    try {
      // DB 화면 위에서 파라미터 다이얼로그를 바로 띄움 (화면 전환 없음)
      const signals = await ImageAnalyzer.showEditParameterDialog(spec);

      // 재생성
      _currentProjectId = id;
      const newDoc = await regenerateFromSignals(signals);

      // ★ 자동 덮어쓰기: 기존 프로젝트에 새 도면을 즉시 저장
      autoOverwriteProject(id, proj.name, newDoc);

      // DB 화면 닫고 편집기로
      document.getElementById('screenDB').classList.remove('active');
      showToast(`"${proj.name}" 파라미터 수정 → 도면 재생성 + 자동 저장 완료!`, 'success');
    } catch (err) {
      if (err.message && err.message.includes('취소')) {
        showToast('파라미터 수정이 취소되었습니다', 'info');
      } else {
        showToast('도면 재생성 중 오류가 발생했습니다', 'error');
        console.error('[App:editProjectParams]', err);
      }
    }
  }

  /**
   * 현재 편집 중인 도면의 파라미터 수정
   */
  async function editCurrentParams() {
    const doc = Editor.getDocument ? Editor.getDocument() : _document;
    if (!doc) {
      showToast('편집 중인 도면이 없습니다', 'error');
      return;
    }
    const spec = doc._spec;
    if (!spec) {
      showToast('이 도면에는 파라미터 데이터가 없습니다', 'error');
      return;
    }

    try {
      const signals = await ImageAnalyzer.showEditParameterDialog(spec);
      const newDoc = await regenerateFromSignals(signals);

      // ★ 현재 프로젝트가 DB에 저장된 상태라면 자동 덮어쓰기
      if (_currentProjectId) {
        const projects = loadProjects();
        const proj = projects.find(p => p.id === _currentProjectId);
        if (proj) {
          autoOverwriteProject(_currentProjectId, proj.name, newDoc);
        }
      }
      showToast('파라미터 수정 → 도면 재생성 완료!', 'success');
    } catch (err) {
      if (err.message && err.message.includes('취소')) {
        showToast('파라미터 수정이 취소되었습니다', 'info');
      } else {
        showToast('도면 재생성 중 오류가 발생했습니다', 'error');
        console.error('[App:editCurrentParams]', err);
      }
    }
  }

  /**
   * signals → candidates → spec → doc 파이프라인으로 도면 재생성
   * @returns {object} 생성된 document (자동 저장용)
   */
  async function regenerateFromSignals(signals) {
    const candidates = AIEngine.buildShaftCandidates(signals);
    const spec = AIEngine.resolveSpecFromCandidates(candidates, signals);
    const newDoc = AIEngine.generateFromCustomSpec(spec);
    enterEditor(newDoc);
    return newDoc;
  }

  /**
   * 기존 프로젝트를 새 도면으로 자동 덮어쓰기
   * (파라미터 수정 후 재생성 시 사용)
   */
  function autoOverwriteProject(id, name, doc) {
    const projects = loadProjects();
    const idx = projects.findIndex(p => p.id === id);
    if (idx < 0) return;

    const now = new Date().toISOString();
    const svgPreview = generateSVGPreview(doc);

    projects[idx].name = name;
    projects[idx].document = JSON.parse(JSON.stringify(doc));
    projects[idx].svgPreview = svgPreview;
    projects[idx].updatedAt = now;
    projects[idx].elementCount = doc.elements ? doc.elements.length : 0;

    saveProjects(projects);
    updateDBBadge();
    console.log(`[DB] 프로젝트 "${name}" 자동 덮어쓰기 완료`);
  }

  function deleteProject(id) {
    const projects = loadProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj) return;

    if (!confirm(`"${proj.name}" 프로젝트를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;

    const updated = projects.filter(p => p.id !== id);
    saveProjects(updated);
    updateDBBadge();

    // 현재 열린 프로젝트가 삭제된 경우 초기화
    if (_currentProjectId === id) {
      _currentProjectId = null;
    }

    showToast(`"${proj.name}" 프로젝트가 삭제되었습니다`, 'info');
    renderDBGrid();
  }

  // ========== DB Badge ==========
  function updateDBBadge() {
    const projects = loadProjects();
    const btn = document.getElementById('btnDBTab');
    // 기존 배지 제거
    const oldBadge = btn.querySelector('.db-badge');
    if (oldBadge) oldBadge.remove();

    if (projects.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'db-badge';
      badge.textContent = projects.length;
      btn.appendChild(badge);
    }
  }

  // ========== LocalStorage + Server Sync Helpers ==========
  //
  // 전략:
  //   1. saveProjects() → localStorage + 서버 동시 저장 (서버는 비동기)
  //   2. loadProjects() → localStorage 우선, 비어있으면 서버에서 복구
  //   3. init() → 앱 시작 시 서버에서 복구 시도
  //

  function loadProjects() {
    try {
      return JSON.parse(localStorage.getItem(DB_KEY) || '[]');
    } catch(e) {
      return [];
    }
  }

  function saveProjects(projects) {
    // 1) localStorage에 저장
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(projects));
    } catch(e) {
      console.warn('[DB] localStorage full, trimming previews');
      projects.forEach(p => { p.svgPreview = ''; });
      try {
        localStorage.setItem(DB_KEY, JSON.stringify(projects));
      } catch(e2) {
        showToast('저장 공간이 부족합니다. 오래된 프로젝트를 삭제해주세요.', 'error');
      }
    }

    // 2) 서버에 비동기 백업 (svgPreview 제외하여 크기 절약)
    syncToServer(projects);
  }

  /**
   * 서버에 프로젝트 목록을 비동기로 백업
   * svgPreview는 크기가 크므로 제외하여 전송
   */
  function syncToServer(projects) {
    try {
      // svgPreview를 제외한 경량 버전 전송
      const lightweight = projects.map(p => {
        const copy = Object.assign({}, p);
        copy.svgPreview = ''; // 서버 저장 시 미리보기 제외 (용량 절약)
        return copy;
      });
      const sid = localStorage.getItem('ad_session') || '';
      fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sid },
        body: JSON.stringify({ projects: lightweight }),
      }).then(r => {
        if (!r.ok) console.warn('[DB] Server sync failed:', r.status);
        else console.log(`[DB] Server sync OK: ${projects.length}개 프로젝트`);
      }).catch(err => {
        console.warn('[DB] Server sync error:', err.message);
      });
    } catch(e) {
      console.warn('[DB] syncToServer error:', e.message);
    }
  }

  /**
   * 앱 시작 시 서버에서 프로젝트 복구 시도
   * localStorage가 비어있을 때만 서버에서 가져옴
   */
  async function restoreFromServer() {
    const local = loadProjects();

    // 항상 서버 데이터를 먼저 조회한다 (서버가 신뢰 기준 = source of truth)
    let serverProjects = [];
    try {
      const sid = localStorage.getItem('ad_session') || '';
      const res = await fetch('/api/projects', {
        headers: { 'X-Session-Id': sid },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.projects)) {
          serverProjects = data.projects;
        }
      }
    } catch(e) {
      console.warn('[DB] restoreFromServer fetch error:', e.message);
    }

    // ── 병합 전략: 서버 + 로컬을 id 기준으로 합치되, 서버를 우선 ──
    // 로컬에만 있는(아직 서버에 동기화 안 된) 프로젝트는 보존한다.
    const byId = new Map();
    serverProjects.forEach(p => { if (p && p.id) byId.set(p.id, p); });
    let localOnly = 0;
    local.forEach(p => {
      if (p && p.id && !byId.has(p.id)) {
        byId.set(p.id, p);   // 서버에 없는 로컬 전용 프로젝트만 추가
        localOnly++;
      }
    });
    const merged = Array.from(byId.values());

    console.log(`[DB] restore: 서버 ${serverProjects.length}개 + 로컬전용 ${localOnly}개 = ${merged.length}개`);

    // localStorage 갱신 (병합 결과로 덮어씀 → 오염된 1개짜리 상태 자동 교정)
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(merged));
    } catch(e) {
      // svgPreview 제거 후 재시도
      merged.forEach(p => { if (p) p.svgPreview = ''; });
      try { localStorage.setItem(DB_KEY, JSON.stringify(merged)); } catch(e2) {}
    }

    // 로컬에만 있던 새 프로젝트가 있으면 서버에도 백업 (서버보다 적지 않으므로 방어로직 통과)
    if (localOnly > 0 && merged.length >= serverProjects.length) {
      syncToServer(merged);
    }

    updateDBBadge();

    // 화면 갱신: DB 목록 화면이 열려있으면 다시 렌더
    try {
      const dbScreen = document.getElementById('screenDB');
      if (dbScreen && dbScreen.classList.contains('active') && typeof renderDBGrid === 'function') {
        renderDBGrid();
      }
    } catch(e) {}

    if (merged.length > local.length) {
      showToast(`서버에서 ${merged.length}개 프로젝트를 불러왔습니다.`, 'success');
    }
  }

  // ========== Export ==========
  function bindExportEvents() {
    const modal = document.getElementById('exportModal');

    document.getElementById('btnExport').addEventListener('click', () => {
      modal.classList.add('active');
    });

    document.getElementById('btnCloseExport').addEventListener('click', () => {
      _exportTargetDoc = null;
      modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        _exportTargetDoc = null;
        modal.classList.remove('active');
      }
    });

    document.querySelectorAll('.export-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const format = opt.dataset.export;
        // DB탭 내보내기 또는 편집기 내보내기
        const doc = _exportTargetDoc || Editor.getDocument();
        if (!doc) {
          showToast('내보낼 도면이 없습니다', 'error');
          return;
        }

        switch (format) {
          case 'svg': Exporter.exportSVG(doc); break;
          case 'dxf': Exporter.exportDXF(doc); break;
          case 'pdf': Exporter.exportPDF(doc); break;
          case 'json': Exporter.exportJSON(doc); break;
        }

        const name = _exportTargetDoc?._projectName || '';
        showToast(`${name ? '"' + name + '" ' : ''}${format.toUpperCase()} 형식으로 내보내기 완료!`, 'success');
        _exportTargetDoc = null;
        modal.classList.remove('active');
      });
    });
  }

  // ========== 3D 미리보기 (v121) ==========
  function bind3DPreviewEvents() {
    const btn = document.getElementById('btn3dPreview');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const doc = Editor.getDocument ? Editor.getDocument() : _document;
      if (!doc || !doc._spec) {
        showToast('3D 미리보기를 위한 도면 데이터가 없습니다', 'error');
        return;
      }
      Preview3D.open(doc._spec);
    });
  }

  // ========== Toast ==========
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${message}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ========== Helpers ==========
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { showToast, goToStep, openDBScreen, editCurrentParams };
})();
